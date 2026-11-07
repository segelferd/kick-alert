/**
 * KickAlert - Background Service Worker
 * Monitors followed Kick channels, sends notifications, auto-launches streams.
 * Uses chrome.alarms API for guaranteed wake-up (MV3 service workers sleep after ~30s).
 * © 2025 Segelferd. All rights reserved.
 */

// Chrome uses service_worker (needs importScripts), Firefox uses background.scripts (auto-loaded)
if (typeof importScripts === 'function') {
  importScripts('./storage.js', './kickapi.js', './utils.js', './textfold.js', './pusher-config.js', './pusher.js', './ad-diag.js', './specialday.js');
}

// v2.5.65: Firefox tespiti. Chrome 148'den beri eklentilerde `browser` ad alanı
// da tanımlı; eski `typeof browser !== 'undefined'` kontrolü Chrome'u Firefox
// sanıyordu. Sonuç: Chrome'da bildirimlere `silent` ve butonlar eklenmiyor,
// "Eklenti sesi" modunda bile Windows bildirim sesi çalıyordu. getBrowserInfo
// sadece Firefox'ta var.
const IS_FIREFOX = typeof browser !== 'undefined' && !!browser.runtime && typeof browser.runtime.getBrowserInfo === 'function';

const BADGE_ACTIVE = '#53FC18';
const BADGE_SUSPENDED = '#606060';
const BADGE_DND = '#eb0400';
const ALARM_NAME = 'kickalert-check';
const SESSION_REFRESH_ALARM = 'kickalert-session-refresh'; // v2.3.1: __cf_bm cookie tazeleme
const MIN_ALARM_PERIOD = 0.5;
const NOTIFIED_LIVES_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

// v2.3.1 Plan E: Production log temizliği.
// v2.3.5+: KLog merkezi sistemine geçildi (utils.js içinde).
// Geliştirme sırasında devTools console'undan açılabilir:
//   chrome.storage.local.set({ _debugMode: true })   // DEBUG seviyesi
//   chrome.storage.local.set({ _traceMode: true })   // TRACE seviyesi (en detaylı)
// Veya kapatmak için:
//   chrome.storage.local.set({ _debugMode: false, _traceMode: false })
// Ayar SW yeniden uyandığında veya storage onChanged ile anında okunur.
// NOT: ERROR/WARN/INFO seviyeleri prod'da bile her zaman görünür (kritik olaylar).
let DEBUG_MODE = false;
chrome.storage.local.get(['_debugMode']).then(r => { DEBUG_MODE = !!r._debugMode; }).catch(() => {});
chrome.storage.onChanged.addListener((changes) => {
  if (changes._debugMode) DEBUG_MODE = !!changes._debugMode.newValue;
});
// Eski dbg() çağrıları KLog'un legacy köprüsüne yönlendirilir.
// Yeni kod KLog.info/debug/warn/error/trace kullanmalı (kategori + STEP-ID ile).
function dbg(...args) { KLog.legacy(...args); }

let cachedChannels = [];
const avatarCache = {}; // slug → dataUrl
const AVATAR_CACHE_MAX = 50;

// v2.3.1 Plan F (#C/#D/#E fix): Pusher'ın "şu an canlı" bildiği slug'lar.
// Polling (checkChannels) liveSlugs ve cachedChannels'ı KOMPLE yeniden yazıyor
// (REPLACE). Bu, Pusher'ın incremental eklediği canlı kanalları eziyordu
// (özellikle API 403 + fallback cache eski veri durumunda → çift/kayıp bildirim).
// Bu Set, polling merge ederken Pusher'ın canlı kanallarını KORUMAK için kullanılır.
// RAM'de tutulur: SW uyanınca Pusher reconnect edip taze event'ler gönderir,
// kalıcı duplicate koruması zaten persisted liveSlugs'ta.
const _pusherLiveSlugs = new Set();
// Risk#1 fix yardımcısı: slug → Pusher live event'inin geldiği timestamp.
// "Taze API offline diyor ama Pusher az önce canlı dedi" durumunda, çok yeni
// (GRACE süresi içinde) event'leri hayalet-temizliğinden korur. Backend
// senkronizasyon gecikmesi penceresi için güvenlik payı.
const _pusherLiveSince = new Map();
const PUSHER_LIVE_GRACE_MS = 2 * 60 * 1000; // 2 dk: API'nin Pusher'a yetişme payı

// Risk#1 fix: _pusherLiveSlugs (Set) ile _pusherLiveSince (Map) HER ZAMAN
// senkron kalmalı. Doğrudan .add/.delete yerine bu helper'ları kullan ki
// timestamp da güncellensin (ikisinin ayrışması hayalet temizliğini bozar).
function _markPusherLive(slug) {
  _pusherLiveSlugs.add(slug);
  _pusherLiveSince.set(slug, Date.now());
}
function _unmarkPusherLive(slug) {
  _pusherLiveSlugs.delete(slug);
  _pusherLiveSince.delete(slug);
}

// ─── Avatar Helper ───

async function getAvatarDataUrl(ch) {
  const slug = ch.channelSlug;
  if (!ch.profilePic) {
    KLog.warn('AVA-01', `${slug} → profilePic verisi boş geldi, varsayılan ikon kullanılacak`);
    return chrome.runtime.getURL('icons/icon128.png');
  }
  if (avatarCache[slug]) return avatarCache[slug];

  const _fetchAvatarOnce = async () => {
    const resp = await fetch(ch.profilePic);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  };

  const _storeInCache = (dataUrl) => {
    // Evict oldest entries if cache is full
    const keys = Object.keys(avatarCache);
    if (keys.length >= AVATAR_CACHE_MAX) {
      delete avatarCache[keys[0]];
    }
    avatarCache[slug] = dataUrl;
  };

  try {
    const dataUrl = await _fetchAvatarOnce();
    _storeInCache(dataUrl);
    return dataUrl;
  } catch (err1) {
    KLog.warn('AVA-02', `${slug} → ilk avatar indirme denemesi başarısız (${err1.message}), 300ms sonra tekrar denenecek`);
    await new Promise((r) => setTimeout(r, 300));
    try {
      const dataUrl = await _fetchAvatarOnce();
      _storeInCache(dataUrl);
      KLog.info('AVA-03', `${slug} → ikinci denemede avatar başarıyla alındı`);
      return dataUrl;
    } catch (err2) {
      KLog.warn('AVA-04', `${slug} → ikinci deneme de başarısız (${err2.message}), varsayılan ikona düşülüyor`);
      return chrome.runtime.getURL('icons/icon128.png');
    }
  }
}

// ─── Init ───

// Sensitivity → eşik mapping
const SPIKE_THRESHOLDS = {
  min: { warn: 25,  alert: 75  },
  avg: { warn: 50,  alert: 150 },
  max: { warn: 75,  alert: 250 },
};
const DROP_THRESHOLDS = {
  min: { warn: 10, alert: 20 },
  avg: { warn: 20, alert: 35 },
  max: { warn: 30, alert: 50 },
};
let _spikeEnabled     = true;
let _spikeSensitivity = 'avg';
let _dropSensitivity  = 'avg';
let _initRunning = false;

// v2.5.45 FIX: initialize() eskiden HER çağrıldığında (yani her alarm sonrası
// service worker uyanışında, ~1 dakikada bir) Storage.pullFromSync() çalıştırıyordu.
// pullFromSync() buluttaki veriyi hiçbir birleştirme yapmadan doğrudan yerel depoya
// yazıyor - ve chatSettings o zamana kadar buluta hiç yansımadığı için (yukarıdaki
// _mirrorChatSettingsToSync fix'inden önce), bu bayat/boş bulut kopyası kullanıcının
// gerçek chat ayarlarını sessizce eziyordu. Artık pull sadece GERÇEK bir oturum
// başlangıcında (tarayıcı açılışı / eklenti kurulumu-güncellemesi) çalışıyor;
// alarm kaynaklı rutin uyanışlarda çalışmıyor.
async function initialize(isFreshSession = false) {
  if (_initRunning) return;
  _initRunning = true;

  // Storage-based lock: prevent duplicate init within 10s across SW restarts
  try {
    const lockData = await chrome.storage.local.get('_initLock');
    const lock = lockData._initLock || 0;
    if (Date.now() - lock < 10000) {
      dbg('[KickAlert] Init skipped - lock active');
      _initRunning = false;
      return;
    }
    await chrome.storage.local.set({ _initLock: Date.now() });
  } catch {}

  dbg('[KickAlert] Initializing...');

  try {
    await Utils.initI18n();
    await Storage.initSyncState();
    if (isFreshSession) {
      // v2.5.88 (b042): v2.5.87 ve öncesinde popup'tan yapılan ayar değişiklikleri
      // buluta yazılmıyordu; buluttaki kopya eski. Bu sürüme güncellemeden sonraki
      // ilk oturum başlangıcında buluttan ÇEKMEK yerine bu cihazdaki ayarlar buluta
      // yazılır (yerel kazanır). Sonraki oturumlarda normal çekme devam eder.
      let lw = {};
      try { lw = await chrome.storage.local.get('_syncLocalWins'); } catch (e) {}
      if (lw._syncLocalWins) {
        try {
          if (await Storage.getCloudSyncEnabled()) {
            const r = await Storage._pushAllToSync();
            KLog.info('SYNC-02', `Güncelleme sonrası bu cihazdaki ayarlar buluta yazıldı (${(r && r.ok && r.ok.length) || 0} ayar)`);
          }
          await chrome.storage.local.set({ _syncLocalWins: false, _syncLocalWinsDone88: true });
        } catch (e) { console.warn('[KickAlert] SYNC-02 başarısız:', e && e.message); }
      } else {
        await Storage.pullFromSync();
      }
    }
    else Storage.flushSyncPending().catch(() => {}); // v2.5.66: buluta yazılamamış ayarları tekrar dene

    const resetOnRestart = await Storage.getResetSuspendOnRestart();
    if (resetOnRestart) await Storage.remove(StorageKeys.SUSPEND_FROM_DATE);

    await updateBadgeColor();
    await migrateAutoOpenChannels();
    await startOffscreen();

    // v2.3.18: AdBlock DNR ruleset'ini kullanıcı ayarıyla senkronize et - SW
    // yeniden başladığında ya da ilk kurulumda tutarlı olsun diye.
    try {
      const adBlockEnabled = await Storage.get(StorageKeys.AD_BLOCK_ENABLED);
      await syncAdBlockRuleset(adBlockEnabled === true);
    } catch (e) {
      console.warn('[KickAlert] AdBlock init senkronizasyonu başarısız:', e.message);
    }

    // v2.3.1: Init'te aktif backoff varsa, ilk checkSafe başarısız olmadan
    // önce bir session refresh dene. Bu sayede SW restart'tan sonra
    // 21 dk beklemek yerine hemen kurtulma şansı yakalarız.
    //
    // v2.3.1 fix: Plan C tab varsa backoff'u doğrudan sıfırla, refresh için bekleme!
    // Proxy zaten Cloudflare-safe, panic loop riski yok. Bu sayede eklenti açılışı
    // 10-15 saniyeden 0 saniyeye iniyor - popup anında veri görür.
    try {
      await KickAPI._loadBackoffFromStorage();
      if (Date.now() < KickAPI._lastBackoffUntil) {
        const remainingMin = Math.ceil((KickAPI._lastBackoffUntil - Date.now()) / 60000);
        // Plan C tab var mı? (fast-path)
        const proxyAvail = await KickAPI._findKickTab() !== null;
        if (proxyAvail) {
          dbg(`[KickAlert] Init: aktif backoff (${remainingMin}dk) bulundu ama Plan C aktif → backoff sıfırlandı, anında temiz başlama`);
          KickAPI._lastBackoffUntil = 0;
          KickAPI._lastBackoffDuration = 0;
          KickAPI._saveBackoffToStorage(0);
        } else {
          dbg(`[KickAlert] Init: aktif backoff bulundu (${remainingMin} dk kaldı), session refresh deneniyor...`);
          await KickAPI.refreshKickSession('init_recovery');
        }
      }
    } catch (e) {
      dbg('[KickAlert] Init backoff check failed:', e.message);
    }

    await checkSafe();
    await scheduleAlarm();
    await scheduleSessionRefreshAlarm(); // v2.3.1: Cloudflare cookie tazeleme

    // v2.3.1 Plan F: Pusher WebSocket - gerçek zamanlı StreamerIsLive event'leri.
    // İlk checkSafe'de cachedChannels dolduğu için channel_id'leri kullanabiliriz.
    startPusherIfPossible();
  } catch (e) {
    console.warn('[KickAlert] Init error:', e.message);
  }
  _initRunning = false;
}

// ─── v2.5.78: Pusher anahtarı Kick'ten alınır ───
// Kick Ekim 2026'da eski Pusher uygulamasını kapattı (4001 "App key not in
// this cluster"). Kick'in kendi sayfası bağlanacağı uygulamayı her açılışta
// web.kick.com/api/v1/realtime/connection adresine soruyor; biz de aynısını
// yapıyoruz. Sorgu başarısızsa son başarılı anahtar, o da yoksa
// pusher-config.js'teki yedek anahtar kullanılır. Kanal ve olay adları aynı.
const PUSHER_CFG_KEY = '_pusherCfg';
const PUSHER_CFG_TTL_MS = 12 * 60 * 60 * 1000;      // başarılı sorgu 12 saat geçerli
const PUSHER_CFG_FAIL_TTL_MS = 30 * 60 * 1000;      // başarısız sorgudan sonra 30 dk bekle
const PUSHER_FORCE_MIN_MS = 10 * 60 * 1000;         // kalıcı hata sonrası zorunlu sorgular arası
const CF_STICKY_MS = 6 * 60 * 60 * 1000;            // v2.5.90: Centrifugo'ya geçince en az 6 saat orada kal
const KICK_REALTIME_URL = 'https://web.kick.com/api/v1/realtime/connection';
let _pusherCfgPromise = null;
let _pusherLastForce = 0;

function pusherCfgPayload() {
  return { key: KAPusherCfg.key, cluster: KAPusherCfg.cluster, provider: KAPusherCfg.provider, cfUrl: KAPusherCfg.cfUrl };
}

// ─── v2.5.90 (b034): Centrifugo yedeği ───
// İsteğe bağlı site izni (rules.json kural 2'nin Centrifugo websocket isteğinde
// Origin'i kick.com yapabilmesi için gerekli). Verilmemişse yedek kullanılamaz;
// popup bandı ve Ayarlar > Eklenti izinleri izni ister (_rtFallbackNeeded).
const KA_RT_ORIGINS = ['*://*.kick.com/*', 'wss://*.kick.com/*'];
async function rtFallbackPermitted() {
  try { return await chrome.permissions.contains({ origins: KA_RT_ORIGINS }); } catch (e) { return false; }
}
async function fetchCentrifugoUrlFromKick() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const body = { client: { id: crypto.randomUUID(), type: 'web' }, capabilities: { accepted_providers: [{ provider: 'centrifugo' }] } };
    const r = await fetch(KICK_REALTIME_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const list = j && j.data && Array.isArray(j.data.connections) ? j.data.connections : [];
    for (const c of list) {
      const url = c && c.provider === 'centrifugo' && c.credentials && c.credentials.url;
      if (url && KA_CF_URL_RE.test(url)) return url;
    }
    throw new Error('yanıtta Centrifugo adresi yok');
  } finally { clearTimeout(timer); }
}
// Centrifugo'ya geç. İzin yoksa izni istemek için bayrak bırakır.
let _cfLastTry = 0;
async function switchToCentrifugo(why, { now = false } = {}) {
  if (!(await rtFallbackPermitted())) {
    let already = false;
    try { already = (await chrome.storage.local.get('_rtFallbackNeeded'))._rtFallbackNeeded === true; } catch (e) {}
    if (!already) {
      try { await chrome.storage.local.set({ _rtFallbackNeeded: true }); } catch (e) {}
      KLog.warn('PSH-24', `Centrifugo yedeği gerekiyor (${why}) ama *.kick.com izni verilmemiş; popup izni isteyecek`);
    }
    return false;
  }
  // Başarısız denemeler arasında en az 5 dakika (izin verildiğinde hemen)
  if (!now && Date.now() - _cfLastTry < 5 * 60 * 1000) return false;
  _cfLastTry = Date.now();
  try {
    const cfUrl = await fetchCentrifugoUrlFromKick();
    const cfg = { key: KAPusherCfg.key, cluster: KAPusherCfg.cluster, provider: 'centrifugo', cfUrl };
    KAPusherCfg.set(cfg);
    try { await chrome.storage.local.set({ [PUSHER_CFG_KEY]: { ...cfg, at: Date.now(), ok: true, cfSince: Date.now() }, _rtFallbackNeeded: false }); } catch (e) {}
    KLog.warn('PSH-23', `Gerçek zamanlı bağlantı Centrifugo yedeğine geçti (${why}): ${cfUrl}`);
    return true;
  } catch (e) {
    KLog.warn('PSH-25', `Centrifugo yedeğine geçilemedi (${why}): ${e && e.message}`);
    return false;
  }
}

// Yanıt: { data: { connections: [{ provider: 'pusher', credentials: { app_key, cluster } }] } }
function parseKickRealtimeResponse(j) {
  const list = j && j.data && Array.isArray(j.data.connections) ? j.data.connections : [];
  for (const c of list) {
    if (c && c.provider === 'pusher' && c.credentials) {
      const cfg = { key: c.credentials.app_key, cluster: c.credentials.cluster || 'us2' };
      if (KAPusherCfg.valid(cfg)) return cfg;
    }
  }
  return null;
}

async function fetchPusherConfigFromKick() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    // Kick web istemcisiyle aynı gövde. id her istekte rastgele (kalıcı kimlik yok),
    // çerez gönderilmez.
    const body = { client: { id: crypto.randomUUID(), type: 'web' }, capabilities: { accepted_providers: [{ provider: 'pusher' }] } };
    const r = await fetch(KICK_REALTIME_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const cfg = parseKickRealtimeResponse(j);
    if (!cfg) {
      // v2.5.82: Kick Pusher'ı sunmayı bırakırsa açıkça görünsün. Centrifugo
      // sunucusu tarayıcı eklentisi kaynaklı bağlantıları reddediyor (14.10.2026
      // testi), bu yüzden yedek anahtarla devam edilir; bildirimler yoklamayla gelir.
      const provs = (j && j.data && Array.isArray(j.data.connections) ? j.data.connections : []).map(c => c && c.provider).filter(Boolean);
      KLog.warn('PSH-13', `Kick gerçek zamanlı bağlantı için Pusher sunmadı (sağlayıcılar: ${provs.join(', ') || 'yok'})`);
      const e = new Error('yanıtta Pusher bağlantısı yok'); e.noPusher = true;
      throw e;
    }
    return cfg;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geçerli Pusher ayarını hazırlar. force: kalıcı Pusher hatasından sonra
 * süreye bakmadan Kick'e yeniden sor (10 dk'da en fazla bir kez).
 */
async function ensurePusherConfig({ force = false, reason = '' } = {}) {
  if (_pusherCfgPromise) return _pusherCfgPromise;
  _pusherCfgPromise = (async () => {
    const now = Date.now();
    let stored = null;
    try { stored = (await chrome.storage.local.get(PUSHER_CFG_KEY))[PUSHER_CFG_KEY] || null; } catch {}
    if (stored && KAPusherCfg.valid(stored)) KAPusherCfg.set(stored);
    const age = stored ? now - (stored.at || 0) : Infinity;
    const fresh = !!stored && (stored.ok ? age < PUSHER_CFG_TTL_MS : age < PUSHER_CFG_FAIL_TTL_MS);
    if (!force && fresh) return pusherCfgPayload();
    if (force && now - _pusherLastForce < PUSHER_FORCE_MIN_MS) return pusherCfgPayload();
    if (force) _pusherLastForce = now;
    // v2.5.90: Centrifugo yedeğindeyken olağan yenilemede 6 saat Pusher'a dönme
    // (Pusher sessizken geri dönüp yeniden 10 dk beklememek için). Zorunlu
    // sorgu (sessizlik ya da kalıcı hata) Pusher'ı yeniden dener.
    if (!force && KAPusherCfg.provider === 'centrifugo' && stored && stored.cfSince && now - stored.cfSince < CF_STICKY_MS) {
      try { await chrome.storage.local.set({ [PUSHER_CFG_KEY]: { ...stored, at: now } }); } catch {}
      return pusherCfgPayload();
    }
    try {
      const cfg = await fetchPusherConfigFromKick();
      const before = KAPusherCfg.key;
      const changed = KAPusherCfg.set(cfg);
      try { await chrome.storage.local.set({ [PUSHER_CFG_KEY]: { key: cfg.key, cluster: cfg.cluster, provider: 'pusher', cfUrl: '', at: now, ok: true } }); } catch {}
      if (before && KAPusherCfg.provider === 'pusher') { try { await chrome.storage.local.set({ _rtFallbackNeeded: false }); } catch {} }
      KLog.info('PSH-10', `Pusher anahtarı Kick'ten alındı: ${cfg.key} (${cfg.cluster})${changed ? ` · önceki ${before}` : ' · değişmedi'}${reason ? ' · ' + reason : ''}`);
    } catch (e) {
      try { await chrome.storage.local.set({ [PUSHER_CFG_KEY]: { key: KAPusherCfg.key, cluster: KAPusherCfg.cluster, provider: KAPusherCfg.provider, cfUrl: KAPusherCfg.cfUrl, cfSince: (stored && stored.cfSince) || 0, at: now, ok: false, err: String(e.message || e).slice(0, 80) } }); } catch {}
      KLog.warn('PSH-11', `Pusher anahtarı Kick'ten alınamadı (${e.message}); ${KAPusherCfg.key} kullanılıyor`);
      // v2.5.90: Kick Pusher'ı hiç sunmuyorsa Centrifugo yedeğine geç
      if (e && e.noPusher) { try { await switchToCentrifugo('Kick Pusher sunmuyor'); } catch (e2) {} }
    }
    return pusherCfgPayload();
  })();
  try { return await _pusherCfgPromise; } finally { _pusherCfgPromise = null; }
}

// Anahtar değişince bağlantıları yenile. Chrome: offscreen'e ilet (orada
// LiveTracker + BotTracker yeniden bağlanır). Firefox: aynı bağlamdaki
// Pusher ve BotTracker'ı yeniden başlat.
KAPusherCfg.onChange(() => {
  if (chrome.offscreen) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'PUSHER_CONFIG', pusherCfg: pusherCfgPayload() }).catch(() => {});
  } else {
    try { if (typeof Pusher !== 'undefined' && Pusher.restart) Pusher.restart(); } catch (e) {}
    try { if (typeof BotTracker !== 'undefined' && BotTracker.restart) BotTracker.restart(); } catch (e) {}
  }
});
// v2.5.81: Sihirbazdan (ya da tarayıcı ayarlarından) site izni verilince hemen kullan
try {
  chrome.permissions.onAdded.addListener((p) => {
    const origins = (p && p.origins) || [];
    if (origins.some(o => o.includes('web.kick.com'))) {
      _pusherLastForce = 0;
      ensurePusherConfig({ force: true, reason: 'web.kick.com izni verildi' }).catch(() => {});
    }
    if (origins.some(o => o.includes('pusher.com')) && !chrome.offscreen) {
      try { if (typeof Pusher !== 'undefined' && Pusher._onLiveCallback && Pusher.restart) Pusher.restart(); } catch (e) {}
    }
    if (origins.length) KLog.info('PRM-01', `Site izni verildi: ${origins.join(', ')}`);
    // v2.5.90: Centrifugo yedeği izni verildi ve yedek bekleniyorsa hemen geç
    if (origins.some(o => o.includes('*.kick.com'))) {
      chrome.storage.local.get('_rtFallbackNeeded').then((d) => { if (d._rtFallbackNeeded) switchToCentrifugo('izin verildi', { now: true }).catch(() => {}); }).catch(() => {});
    }
  });
} catch (e) {}

// Firefox: kalıcı hata aynı bağlamda bildirilir (Chrome'da offscreen mesajla)
KAPusherCfg.onInvalid = (d) => {
  KLog.info('PSH-12', `Pusher kalıcı hata (${d.code}, ${d.source}) · anahtar Kick'ten yeniden isteniyor`);
  ensurePusherConfig({ force: true, reason: `kalıcı hata ${d.code}` }).catch(() => {});
};

/**
 * v2.3.1 Plan F: Pusher WebSocket başlat ve takip edilen kanallara subscribe et.
 *
 * İKİ MOD:
 *   - Chrome (offscreen API var): WebSocket offscreen document'ta çalışır
 *     (hiç uyumaz → event kaçmaz). SW sadece sync mesajı atar + event dinler.
 *   - Firefox (offscreen yok): pusher.js doğrudan SW'de çalışır (fallback).
 *
 * Çalışmazsa sessizce başarısız olur - checkChannels polling devam eder.
 */
function startPusherIfPossible() {
  // v2.5.78: önce güncel anahtarı hazırla (başarısız olsa da devam)
  ensurePusherConfig({ reason: 'açılış' }).catch(() => {}).finally(_startPusherNow);
}

function _startPusherNow() {
  try {
    const hasOffscreen = !!chrome.offscreen;

    if (hasOffscreen) {
      // Chrome: offscreen modülü WebSocket'i yönetir. SW sadece köprü.
      // Offscreen'i hazırla (zaten ses için açılıyor olabilir).
      startOffscreen().then(() => {
        refreshPusherSubscriptions();
      });
      dbg('[KickAlert] Plan F: offscreen modu (WebSocket offscreen\'de)');
    } else {
      // Firefox: SW içinde pusher.js çalışır
      if (typeof Pusher === 'undefined' || !Pusher.start) {
        dbg('[KickAlert] Pusher modülü yok, atlanıyor');
        return;
      }
      Pusher.start(
        async (slug, livestreamData) => {
          try { await handlePusherLiveEvent(slug, livestreamData); }
          catch (e) { console.warn('[KickAlert] Pusher live handler error:', e.message); }
        },
        async (slug) => {
          try { await handlePusherOfflineEvent(slug); }
          catch (e) { console.warn('[KickAlert] Pusher offline handler error:', e.message); }
        }
      );
      refreshPusherSubscriptions();
      dbg('[KickAlert] Plan F: SW modu (Firefox - WebSocket SW\'de)');
    }
  } catch (e) {
    console.warn('[KickAlert] Pusher start hatası:', e.message);
  }
}

/**
 * v2.3.1 Plan F: Subscribed kanal listesini güncelle.
 * cachedChannels değişince (yeni takip / unfollow) çağrılır.
 * Storage'dan channel_id'leri okur (yapısı /api/v2/channels/followed dönmez,
 * sadece /api/v2/channels/{slug} verir - bot_tracker zaten bunları cache'liyor)
 */
async function refreshPusherSubscriptions() {
  if (!chrome.offscreen && typeof Pusher === 'undefined') return;
  // v2.5.78: 12 saatte bir anahtarı tazele (taze ise sadece depodan okur)
  try { await ensurePusherConfig(); } catch {}

  // Storage'daki tüm channel_id cache'ini al
  let channelIdCache = {};
  try {
    channelIdCache = await Storage.getChannelIdCache();
  } catch (e) {
    dbg('[KickAlert] Pusher: channelIdCache okuma hatası:', e.message);
    return;
  }

  // Takip edilen kanalların hangileri için channel_id cache'imiz var?
  const subscribableItems = [];
  for (const ch of cachedChannels || []) {
    const id = channelIdCache[ch.channelSlug];
    if (typeof id === 'number' && id > 0) {
      subscribableItems.push({ channelId: id, slug: ch.channelSlug });
    }
  }

  if (subscribableItems.length > 0) {
    if (chrome.offscreen) {
      // Risk#5 FIX: Offscreen ölmüş olabilir (bellek baskısı, Chrome reload).
      // Mesaj göndermeden önce açık olduğundan emin ol - startOffscreen
      // idempotent (zaten açıksa no-op). Bu, offscreen ölürse her checkChannels
      // (~1dk) tekrar açıp Plan F'in sessizce durmasını önler.
      try { await startOffscreen(); } catch (e) { /* sonraki retry halleder */ }
      // Chrome: offscreen'e gönder.
      // BUG#8 FIX: Offscreen document açılmış ama script'leri (offscreen.js)
      // henüz yüklenmemiş olabilir → mesaj listener'a ulaşmaz. Yanıtta
      // success kontrolü + kısa retry ile bunu telafi ediyoruz.
      await sendToOffscreenWithRetry({
        target: 'offscreen',
        type: 'LIVE_TRACK_SYNC',
        pusherCfg: pusherCfgPayload(),
        channels: subscribableItems,
        authoritative: true, // Bulgu#6: tam liste - offscreen unfollow edilenleri temizlesin
      });
    } else if (typeof Pusher !== 'undefined') {
      // Firefox: SW içi Pusher
      Pusher.subscribeAll(subscribableItems);
    }
    KLog.debug('PSH-01', `${subscribableItems.length}/${cachedChannels.length} kanala subscribe`);
  } else {
    dbg(`[KickAlert] Pusher: subscribe edilecek kanal yok (channel_id cache boş - harvest başlatılacak)`);
  }

  // Eksik channel_id'leri arka planda topla (yavaş tempo, sadece ilk kurulumda)
  const missingCount = (cachedChannels || []).filter(c =>
    c.channelSlug && !channelIdCache[c.channelSlug]
  ).length;
  if (missingCount > 0) {
    harvestMissingChannelIds(); // await YOK - arka planda çalışsın, init'i bloklamasın
  }
}

/**
 * v2.3.1 Plan F (BUG#8): Offscreen'e mesaj gönder, yanıt success gelene kadar
 * kısa aralıklarla yeniden dene. Offscreen document açıldıktan sonra script'leri
 * yüklenene dek (birkaç yüz ms) listener hazır olmayabilir.
 * @returns {Promise<object|null>} offscreen yanıtı veya null
 */
async function sendToOffscreenWithRetry(message, maxAttempts = 4) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const resp = await chrome.runtime.sendMessage(message);
      if (resp && resp.success) return resp;
      // Yanıt geldi ama success değil - yine de "ulaştı" sayılır, döndür
      if (resp) return resp;
    } catch (e) {
      // "Could not establish connection" - listener henüz yok, retry
    }
    // Son denemede bekleme
    if (attempt < maxAttempts) {
      await new Promise(r => setTimeout(r, 400 * attempt)); // 400, 800, 1200ms
    }
  }
  dbg('[KickAlert] Pusher: offscreen mesajı ulaşmadı (sonraki checkChannels tekrar dener)');
  return null;
}

/**
 * v2.3.1 Plan F: Eksik channel_id'leri topla (Pusher subscribe için).
 * channel_id sabittir (asla değişmez) → bir kez topla, kalıcı cache'le.
 * Cloudflare baskısını minimize etmek için yavaş tempoda (kanal başına 2sn) toplar.
 * Bu sadece İLK kurulumda çalışır; cache dolduktan sonra hiç çağrılmaz.
 */
let _channelIdHarvestRunning = false;
async function harvestMissingChannelIds() {
  if (_channelIdHarvestRunning) return;
  _channelIdHarvestRunning = true;
  try {
    const cache = await Storage.getChannelIdCache();
    const missing = (cachedChannels || [])
      .map(c => c.channelSlug)
      .filter(slug => slug && !cache[slug]);

    if (missing.length === 0) {
      _channelIdHarvestRunning = false;
      return;
    }

    dbg(`[KickAlert] Pusher: ${missing.length} kanal için channel_id toplanıyor (yavaş tempo, kanal başına 2sn)`);

    for (const slug of missing) {
      // getChatroomId zaten channel_id'yi de cache'liyor (Plan F bonus).
      // Bu çağrı Cloudflare'e gidebilir AMA sadece İLK KEZ - sonra kalıcı cache.
      try {
        await KickAPI.getChatroomId(slug);
        const channelId = await Storage.getChannelId(slug);
        if (channelId) {
          if (chrome.offscreen) {
            // Chrome: offscreen'e tek kanal ekle (retry helper ile)
            await sendToOffscreenWithRetry({
              target: 'offscreen',
              type: 'LIVE_TRACK_SYNC',
              pusherCfg: pusherCfgPayload(),
              channels: [{ channelId, slug }],
            });
          } else if (typeof Pusher !== 'undefined') {
            // Firefox: SW içi Pusher
            Pusher.subscribeChannel(channelId, slug);
          }
        }
      } catch (e) { /* sessiz - sonraki harvest'e kalır */ }

      // Yavaş tempo: Cloudflare baskısını önle
      await new Promise(r => setTimeout(r, 2000));
    }
    dbg('[KickAlert] Pusher: channel_id toplama tamamlandı');
  } catch (e) {
    console.warn('[KickAlert] channel_id harvest error:', e.message);
  }
  _channelIdHarvestRunning = false;
}

/**
 * v2.3.1 Plan F: Pusher live event geldiğinde devreye girer.
 *
 * KRİTİK TASARIM: Bu fonksiyon API'den TAMAMEN BAĞIMSIZ çalışır.
 * Plan F'in tüm amacı bu: API 403 yağmuru olsa bile, Pusher'dan gelen
 * StreamerIsLive event'i ile ANLIK bildirim üretebilmek.
 *
 * Akış:
 *   1. Duplicate kontrolü (zaten bildirildiyse skip)
 *   2. Yayın yaşı kontrolü (created_at - eski yayını bildirme)
 *   3. cachedChannels'ta varsa state güncelle (yoksa minimal kanal objesi kur)
 *   4. DND / sound / showNotif ayarlarını uygula
 *   5. sendNotification + playSound + autoOpen
 *   6. Persisted state güncelle (liveSlugs, notifiedLives)
 *
 * API'ye HİÇ gitmez - checkChannels akışını TETİKLEMEZ.
 */
async function handlePusherLiveEvent(slug, livestreamData) {
  if (!slug) return;
  const _t0 = KLog.timer(); // toplam akış süresi

  KLog.info('PUSH-10', `${slug} → Pusher StreamerIsLive event alındı`);

  const ls = livestreamData?.livestream || {};

  // ── PUSH-11: Bulgu#6 - Kanal hâlâ takip ediliyor mu? ──
  // Offscreen LiveTracker unfollow edilen kanalları unsubscribe eder, ama o
  // mesaj gecikebilir/kaçabilir. cachedChannels takip listesinin kaynağıysa
  // ve kanal orada YOKSA + cache taze ise → unfollow edilmiş, bildirme.
  // (cachedChannels boşsa SW yeni başlamış olabilir → bu kontrolü atla, riske girme.)
  if (cachedChannels && cachedChannels.length > 0) {
    const stillFollowed = cachedChannels.some(c => c.channelSlug === slug);
    if (!stillFollowed) {
      KLog.warn('PUSH-11', `${slug} takip edilmiyor (unfollow?), bildirim atlandı + unsubscribe sync`);
      refreshPusherSubscriptions();
      return;
    }
    KLog.debug('PUSH-11', `${slug} takip listesinde ✓`);
  }

  // ── PUSH-12: Duplicate kontrolü ──
  const state = await getPersistedState();
  if (state.liveSlugs.has(slug)) {
    KLog.debug('PUSH-12', `${slug} zaten live listesinde, SKIP (çift event/polling yarışı önlendi)`);
    return;
  }

  // ── PUSH-13: "İşliyorum" kilidi (delay/await öncesi) ──
  // Aksi halde notifDelay penceresinde polling aynı kanalı yakalayıp
  // ÇİFT BİLDİRİM gönderebilir. Erken işaretleme bu yarışı kapatır.
  // Ayrıca aynı kanaldan arka arkaya gelen 2. event'i de bloklar.
  state.liveSlugs.add(slug);
  await setPersistedLiveSlugs(state.liveSlugs);
  KLog.debug('PUSH-13', `${slug} liveSlugs kilidi atıldı (çift bildirim koruması aktif)`);

  // ── PUSH-14: Yayın yaşı kontrolü ──
  // StreamerIsLive event'i yayın TAM BAŞLARKEN gelir → created_at = şimdi.
  // Ama SW yeni uyandıysa veya geç event aldıysak, eski yayını bildirmeyelim.
  if (ls.created_at) {
    const ageMs = Date.now() - new Date(ls.created_at).getTime();
    const ageMin = Math.round(ageMs / 60000);
    if (ageMs > 10 * 60 * 1000) {
      KLog.warn('PUSH-14', `${slug} yayını ${ageMin}dk önce başlamış, eski sayılıp bildirilmiyor`);
      _markPusherLive(slug);
      return;
    }
    KLog.debug('PUSH-14', `${slug} yayın yaşı: ${ageMin}dk (10dk limitinin altında) ✓`);
  }

  // ── PUSH-15: Baseline guard'ı ──
  // İlk kurulum: lastCheckDone yoksa baseline kurulmadı - sessizce kaydet,
  // badge'e dokunma (polling baseline kurunca tutarlı sayı yazacak).
  if (!state.lastCheckDone) {
    KLog.warn('PUSH-15', `${slug} - baseline kurulmadan geldi, sessizce kaydedildi (polling badge düzeltecek)`);
    _markPusherLive(slug);
    return;
  }

  KLog.info('PUSH-15', `${slug} → tüm guard'lar geçti, YENİ YAYIN bildirim akışı başlıyor`);

  // ── PUSH-16: WS → tab açma yarış güvenliği (kullanıcı ayarlı 3/5/7/9 sn) ──
  // Pusher 'StreamerIsLive' event'i yayın başlama saniyesinde gelir, ama Kick'in
  // video playback pipeline'ı (AWS IVS) birkaç saniye sonra hazır olur. Eskiden
  // 30sn polling tampon görevi görüyordu; WS gerçek zamanlı olduğu için o tampon
  // kayboldu → sekme yayın daha hazır değilken açılıyor. Sabit küçük bir gecikme
  // bu yarışı kapatır. Bildirim+ses+tab hepsi bu gecikmeden SONRA gider,
  // dolayısıyla davranış v2.3.3 polling akışına yakınsar.
  // NOT: liveSlugs.add() yukarıda yapıldı (PUSH-13) - bu gecikme boyunca polling
  // veya 2. WS event'i ÇİFT BİLDİRİM üretemez ("zaten live listesinde, skip").
  // v2.3.5: süre artık kullanıcı ayarı (Storage.AUTO_OPEN_DELAY: 3/5/7/9 sn).
  const autoOpenDelaySec = await Storage.getAutoOpenDelay();
  const _delayTimer = KLog.timer();
  KLog.info('PUSH-16', `${slug} → ${autoOpenDelaySec}sn güvenlik gecikmesi BAŞLADI (playback pipeline için)`);
  await Utils.delay(autoOpenDelaySec * 1000);
  KLog.info('PUSH-16', `${slug} → gecikme BİTTİ (${_delayTimer.ms()}ms), kanal objesi kuruluyor`);

  // ── PUSH-17: Kanal objesi (cache'te yoksa minimal kur) ──
  let ch = cachedChannels.find(c => c.channelSlug === slug);
  if (!ch) {
    KLog.debug('PUSH-17', `${slug} cachedChannels'ta yok (API 403 olmuş olabilir) → minimal obje kuruluyor`);
    ch = {
      channelSlug: slug,
      userUsername: slug,
      isLive: true,
      sessionTitle: ls.session_title || '',
      categoryName: ls.category?.name || '',
      viewerCount: ls.viewer_count || 0,
      startedAt: ls.created_at || new Date().toISOString(),
      profilePic: '',
    };
    cachedChannels.push(ch);
  } else {
    ch.isLive = true;
    ch.sessionTitle = ls.session_title || ch.sessionTitle;
    ch.startedAt = ls.created_at || ch.startedAt;
    if (ls.category?.name) ch.categoryName = ls.category.name;
    KLog.debug('PUSH-17', `${slug} cachedChannels'ta bulundu, isLive=true güncellendi`);
  }

  // ── PUSH-18: Badge & cache güncelle ──
  const liveCount = cachedChannels.filter(c => c.isLive).length;
  await chrome.action.setBadgeText({ text: liveCount > 0 ? String(liveCount) : '' });
  await updateBadgeColor();
  try { await chrome.storage.local.set({ _cachedChannels: cachedChannels }); } catch {}
  KLog.debug('PUSH-18', `Badge güncellendi: ${liveCount} canlı kanal`);

  // ── NOTIF-50: Bildirim ayarları ──
  const showNotif = await Storage.getShowNotification();
  const suspended = !!(await Storage.getSuspendFromDate());
  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const dndMuteSound = dndActive && await Storage.getDndMuteSound();
  const dndMuteAutolaunch = dndActive && await Storage.getDndMuteAutolaunch();
  const soundMode = await Storage.getSoundMode();
  const chModeInfo = await Storage.getChannelSoundModeInfo(slug);
  const chSoundPref = chModeInfo.mode;
  KLog.debug('NOTIF-50', `${slug} ayarlar: showNotif=${showNotif} suspended=${suspended} dnd=${dndActive} chSoundPref=${chSoundPref}`);

  // ── NOTIF-51: Bildirim gecikmesi (kullanıcı ayarı, opsiyonel) ──
  const notifDelay = await Storage.getNotifDelay();
  if (notifDelay > 0) {
    KLog.info('NOTIF-51', `${slug} → notifDelay ayarı: ${notifDelay} dakika ek bekleme`);
    await Utils.delay(notifDelay * 1000);
  }

  // ── FLT-20 (v2.5.50): Kanal filtresi. Filtre tanımlıysa ve kategori olayda
  // gelmediyse, sadece bu kanal için /livestream'den tamamlanır.
  const pusherPref = await Storage.getChannelAlertPref(slug);
  if ((pusherPref.cats?.length && !ch.categoryName) || (pusherPref.words?.length && !ch.sessionTitle)) {
    try {
      const det = await KickAPI.getChannelLiveDetails(slug);
      if (det?.categoryName && !ch.categoryName) ch.categoryName = det.categoryName;
      if (det?.sessionTitle && !ch.sessionTitle) ch.sessionTitle = det.sessionTitle;
    } catch {}
  }
  const pusherFilter = matchChannelFilter(pusherPref, ch.categoryName, ch.sessionTitle);
  if (!pusherFilter.pass) KLog.info('FLT-20', `${slug} → filtreye takıldı (${pusherFilter.reason}), bildirim/ses/sekme atlanacak`);
  const pusherSup = await alertSuppressedFor(slug); // v2.5.98
  if (pusherSup && pusherFilter.pass) KLog.info('PAU-10', `${slug} → bildirimler ${pusherSup === 'snooze' ? 'bu kanal için 1 saat susturulmuş' : 'duraklatılmış'}; bildirim/ses/sekme atlanacak, geçmişe yazılıyor`);

  // ── NOTIF-52: History ──
  Storage.addNotificationHistory({
    username: ch.userUsername,
    channelSlug: ch.channelSlug,
    profilePic: ch.profilePic || '',
    title: ch.sessionTitle || '-',
    category: ch.categoryName || '-',
    timestamp: new Date().toISOString(),
    ...(pusherFilter.pass ? {} : { filtered: pusherFilter.reason }),
    ...(pusherFilter.pass && pusherSup ? { paused: pusherSup } : {}),
  });
  KLog.debug('NOTIF-52', `${slug} history'ye eklendi`);

  // ── NOTIF-53: notifiedLives'ı taze oku (lost-update koruması) ──
  const freshState = await getPersistedState();
  const notifiedLives = freshState.notifiedLives;

  // ── Bildirim bloğu (try/catch ile sarılı) ──
  // liveSlugs.add EN BAŞTA yapıldı (PUSH-13). AMA bildirim burada throw ederse
  // slug liveSlugs'ta kilitli kalır → bildirim GİTMEDİ → kalıcı kayıp.
  // Hata olursa rollback yapıp sonraki event'in tekrar denemesine izin veriyoruz.
  try {
    // v2.5.74: varsayılan (açıkça seçilmemiş) 'Bildirim yok' sadece bildirim ve sesi susturur;
    // kullanıcının bu kanal için açtığı otomatik açma çalışmaya devam eder.
    const chMuteDefault = chSoundPref === 'muted' && !chModeInfo.explicit;
    if (pusherSup) {
      KLog.debug('NOTIF-54', `${slug} → duraklatma/susturma: sadece geçmiş`);
    } else if (chMuteDefault && pusherFilter.pass) {
      if (!suspended && !dndMuteAutolaunch && await shouldAutoOpen(ch)) {
        const tab = await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: true });
        KLog.info('TAB-70', `${slug} → SEKME AÇILDI (varsayılan bildirim kapalı, otomatik açma açık, tabId=${tab.id})`);
        registerAutoTab(tab.id, ch.channelSlug);
      } else {
        KLog.debug('NOTIF-54', `${slug} → bildirim yok (kanal varsayılanı), sadece geçmiş`);
      }
    } else if (chSoundPref !== 'muted' && pusherFilter.pass) {
      // NOTIF-54: Bildirim
      if (showNotif && !dndMuteNotif) {
        const isSilentNotif = soundMode === 'extension' || chSoundPref === 'silent';
        await sendNotification(ch, notifiedLives, isSilentNotif);
        KLog.info('NOTIF-54', `${slug} → bildirim GÖNDERİLDİ (silentSystem=${isSilentNotif})`);
      } else {
        KLog.debug('NOTIF-54', `${slug} → bildirim atlandı (showNotif=${showNotif} dndMute=${dndMuteNotif})`);
      }

      // NOTIF-55: Ses
      if (!dndMuteSound && chSoundPref !== 'silent') {
        const soundType = chSoundPref === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB';
        await playSound(soundType);
        KLog.info('NOTIF-55', `${slug} → ses çalındı (${soundType})`);
      } else {
        KLog.debug('NOTIF-55', `${slug} → ses atlandı (dndMute=${dndMuteSound} pref=${chSoundPref})`);
      }

      // TAB-70: Auto-open kontrolü ve sekme açma
      if (!suspended && !dndMuteAutolaunch) {
        const shouldOpen = await shouldAutoOpen(ch);
        if (shouldOpen) {
          const tab = await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: true });
          KLog.info('TAB-70', `${slug} → SEKME AÇILDI (tabId=${tab.id}) - toplam akış ${_t0.ms()}ms`);
        registerAutoTab(tab.id, ch.channelSlug);
        } else {
          KLog.debug('TAB-70', `${slug} → shouldAutoOpen=false (kanal/global ayar) → sekme açılmadı`);
        }
      } else {
        KLog.debug('TAB-70', `${slug} → sekme atlandı (suspended=${suspended} dndMuteAutolaunch=${dndMuteAutolaunch})`);
      }
    } else {
      KLog.debug('NOTIF-54', `${slug} → tamamen sessiz (chSoundPref=muted, sadece history)`);
    }

    // notifiedLives persist (liveSlugs zaten EN BAŞTA yazıldı)
    await setPersistedNotifiedLives(notifiedLives);

    // PUSH-19: Pusher'ın canlı bildiği kanalı işaretle (polling ezmesin)
    _markPusherLive(slug);

    KLog.info('PUSH-19', `${slug} → bildirim akışı TAMAMLANDI (toplam ${_t0.ms()}ms, API kullanılmadı) ⚡`);
  } catch (e) {
    // Bildirim başarısız → rollback. Slug'ı liveSlugs'tan çıkar ki sonraki
    // StreamerIsLive event'i tekrar deneyebilsin (kayıp bildirim olmaz).
    KLog.error('PUSH-99', `${slug} bildirim hatası, rollback yapılıyor`, e);
    try {
      const rb = await getPersistedState();
      rb.liveSlugs.delete(slug);
      await setPersistedLiveSlugs(rb.liveSlugs);
    } catch {}
    _unmarkPusherLive(slug);
  }
}

/**
 * v2.3.1 Plan F: StopStreamBroadcast - yayın bitti.
 * Live listesinden çıkar ki yeniden yayın açınca tekrar bildirilsin.
 */
async function handlePusherOfflineEvent(slug) {
  if (!slug) return;
  // #E FIX: Pusher artık bu kanalı canlı bilmiyor → korumalı listeden çıkar.
  // Bu, liveSlugs.has guard'ından ÖNCE olmalı (polling liveSlugs'ı ezmiş olsa
  // bile _pusherLiveSlugs temizlenmeli, yoksa kanal kalıcı "Pusher-live" kalır).
  _unmarkPusherLive(slug);

  // BUG#2 (ikiz) FIX: taze oku, sadece ilgili slug'ı sil, hemen yaz.
  // get→modify→set arası kısa olduğu için lost-update penceresi minimal.
  const state = await getPersistedState();
  if (!state.liveSlugs.has(slug)) return;

  // v2.5.53: "Yayın bitti" adayı (sadece kullanıcı bu kanal için açtıysa).
  // Bildirim burada DEĞİL, sonraki kontrollerde taze API ile doğrulanınca gider.
  try { await addStreamEndCandidate(slug, 'pusher'); } catch {}

  state.liveSlugs.delete(slug);
  await setPersistedLiveSlugs(state.liveSlugs);

  const ch = cachedChannels.find(c => c.channelSlug === slug);
  if (ch) {
    ch.isLive = false;
    const liveCount = cachedChannels.filter(c => c.isLive).length;
    await chrome.action.setBadgeText({ text: liveCount > 0 ? String(liveCount) : '' });
    try { await chrome.storage.local.set({ _cachedChannels: cachedChannels }); } catch {}
  }
  dbg(`[KickAlert] Pusher: ${slug} offline (live listesinden çıkarıldı)`);
}

// ─── v2.5.98: Bildirimleri duraklatma ve kanalı geçici susturma ───
// _notifPause: { until, favs }  popup üstündeki "Duraklat" (1 saat / 08:00'e kadar).
//   favs true ise favori kanallar yine bildirir. Bildirim, ses, otomatik açma,
//   kanal olayı ve chat bildirimleri durur; canlı yayınlar geçmişe yazılır.
// _chSnooze: { slug: until }  Chrome bildirimindeki "1 saat sustur" düğmesi.
// İkisi de bu cihaza özel (_ önekli, buluta gitmez) ve süresi geçince kendiliğinden biter.
const PAUSE_KEY = '_notifPause';
const SNOOZE_KEY = '_chSnooze';
const PAUSE_ALARM = 'kickalert-pause-end';

// ─── v2.6.0: Özel gün simgeleri ───
// Araç çubuğu ikonu birkaç kutlama gününde temalı rozetle, 10 Kasım'da
// (Türkiye) siyah beyaz gösterilir. Bölge saat diliminden tahmin edilir,
// hiçbir yere gönderilmez. Ayarlar'dan kapatılabilir.
const SPECIAL_DAY_ALARM = 'kickalert-special-day';
async function applySpecialDayIcon(force) {
  try {
    if (typeof KASpecialDay === 'undefined') return;
    const ev = await KASpecialDay.resolve(); // ayar anahtarı + test paneli önizlemesi dahil
    const d = new Date();
    const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}|${ev ? ev.id : '-'}${ev && ev.preview ? '|pv' : ''}`;
    let prev = null;
    try { prev = (await chrome.storage.session.get('_specialDayKey'))._specialDayKey; } catch (e) {}
    if (!force && prev === key) return;
    await chrome.action.setIcon(await KASpecialDay.iconDetails(ev, p => chrome.runtime.getURL(p)));
    try { await chrome.storage.session.set({ _specialDayKey: key }); } catch (e) {}
    if (ev) KLog.info('SPD-01', `Özel gün simgesi: ${ev.id}`);
  } catch (e) { KLog.warn('SPD-02', 'Özel gün simgesi uygulanamadı: ' + (e && e.message)); }
}
async function ensureSpecialDayAlarm() {
  try { if (!(await chrome.alarms.get(SPECIAL_DAY_ALARM))) chrome.alarms.create(SPECIAL_DAY_ALARM, { periodInMinutes: 30 }); } catch (e) {}
}
ensureSpecialDayAlarm();
applySpecialDayIcon();
async function getNotifPause() {
  try {
    const p = (await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY];
    return p && p.until > Date.now() ? p : null;
  } catch (e) { return null; }
}
// slug için bildirim susturulmuş mu: 'snooze' | 'pause' | null
async function alertSuppressedFor(slug) {
  const now = Date.now();
  if (slug) {
    try {
      const sn = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY] || {};
      if (sn[slug] > now) return 'snooze';
    } catch (e) {}
  }
  const p = await getNotifPause();
  if (!p) return null;
  if (p.favs && slug) {
    try { if ((await Storage.getFavoriteChannels())[slug]) return null; } catch (e) {}
  }
  return 'pause';
}
async function snoozeChannel(slug, ms) {
  const now = Date.now();
  const sn = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY] || {};
  for (const k of Object.keys(sn)) if (!(sn[k] > now)) delete sn[k];
  sn[slug] = now + ms;
  await chrome.storage.local.set({ [SNOOZE_KEY]: sn });
}
async function schedulePauseAlarm() {
  const p = await getNotifPause();
  try {
    if (p) chrome.alarms.create(PAUSE_ALARM, { when: p.until + 1000 });
    else await chrome.alarms.clear(PAUSE_ALARM);
  } catch (e) {}
}

async function updateBadgeColor() {
  const dndActive = await Storage.isDndActive();
  if (dndActive || await getNotifPause()) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_DND });
    return;
  }
  const suspended = !!(await Storage.getSuspendFromDate());
  await chrome.action.setBadgeBackgroundColor({ color: suspended ? BADGE_SUSPENDED : BADGE_ACTIVE });
}

async function migrateAutoOpenChannels() {
  try {
    const raw = await Storage.get(StorageKeys.AUTO_OPEN_CHANNELS);
    if (Array.isArray(raw)) {
      const migrated = {};
      raw.forEach(entry => {
        if (entry && entry.slug) migrated[entry.slug] = true;
      });
      await Storage.set(StorageKeys.AUTO_OPEN_CHANNELS, migrated);
      dbg('[KickAlert] Migrated autoOpenChannels:', migrated);
    }
  } catch (e) {
    console.warn('[KickAlert] Migration error:', e);
  }
}

// ─── Persisted State ───

async function getPersistedState() {
  const result = await chrome.storage.local.get(['_liveSlugs', '_notifiedLives', '_lastCheckDone']);
  return {
    liveSlugs: new Set(result._liveSlugs || []),
    notifiedLives: result._notifiedLives || {},
    lastCheckDone: result._lastCheckDone || false,
  };
}

async function setPersistedLiveSlugs(slugsSet) {
  await chrome.storage.local.set({ _liveSlugs: [...slugsSet] });
}

async function setPersistedNotifiedLives(map) {
  await chrome.storage.local.set({ _notifiedLives: map });
}

async function setLastCheckDone() {
  await chrome.storage.local.set({ _lastCheckDone: true });
}

// BUG 14 FIX: Reset persisted state on install/update
async function resetPersistedState() {
  await chrome.storage.local.remove(['_liveSlugs', '_notifiedLives', '_lastCheckDone', '_initLock']);
}

// BUG 15 FIX: Clean up old notifiedLives entries (>24h)
async function cleanupNotifiedLives() {
  const state = await getPersistedState();
  const now = Date.now();
  const cleaned = {};
  for (const [id, url] of Object.entries(state.notifiedLives)) {
    // Extract timestamp from id: "kickalert-slug-1234567890"
    const parts = id.split('-');
    const ts = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(ts) && (now - ts) < NOTIFIED_LIVES_MAX_AGE) {
      cleaned[id] = url;
    }
  }
  if (Object.keys(cleaned).length !== Object.keys(state.notifiedLives).length) {
    await setPersistedNotifiedLives(cleaned);
  }
}

// ─── Alarm-based Check Loop ───

// v2.3.1 (Plan B/M4): Şu anda alarm'ın hangi saniyede çalıştığını kayıtta tut.
// scheduleAlarm her tetiklendiğinde gerek var mı/yok mu hızlıca anlayalım - fazladan
// chrome.alarms.create çağrısı yapmayalım (Chrome internal cooldown'ı vardır).
let _currentEffectiveSecs = 0;
let _slowModeActive = false; // M4: yavaşlatma modunda mıyız?
let _peakModeActive = false; // M5: peak saat (akşam) yavaşlatması aktif mi?

const SLOWMODE_FAILURE_THRESHOLD = 2; // v2.3.1 fix B: 3 → 2 (son 10 dk'da 2+ hata → yavaşlat)
                                        // Daha proaktif: ilk 2 hata'da yavaşlatma kararı verilir.
const SLOWMODE_MULTIPLIER = 2;        // baz aralığı 2x'e çıkar (M4)

// M5 - Peak saat yavaşlatması (kanıt: 8h konsol → 18-22 arası tüm 403'lerin %100'ü)
// 18:00-22:00 lokal saat aralığında baz aralığı 1.5x yavaşlat. Cloudflare baskısı
// başlamadan önce proaktif yavaşlatma. Tüm gün kapsayıcı yavaşlatma değil - sadece
// risk penceresi.
const PEAK_HOUR_START = 18; // dahil
const PEAK_HOUR_END = 22;   // dahil değil (yani 18,19,20,21)
const PEAK_MULTIPLIER = 1.5;

function isPeakHour() {
  const h = new Date().getHours();
  return h >= PEAK_HOUR_START && h < PEAK_HOUR_END;
}

async function scheduleAlarm() {
  const baseSecs = Math.max(await Storage.getCheckInterval(), 30);

  // M5: Saat bazlı yavaşlatma - 18-22 arası baz aralığı 1.5x
  const wantPeak = isPeakHour();
  const peakAdjustedSecs = wantPeak ? Math.round(baseSecs * PEAK_MULTIPLIER) : baseSecs;

  // M4: Dinamik yavaşlatma - son 10 dk'da 3+ failure varsa 2x yavaşlat (peak üstüne uygulanır)
  const failures = (typeof KickAPI !== 'undefined' && KickAPI.getRecentFailureCount)
    ? KickAPI.getRecentFailureCount()
    : 0;
  const wantSlow = failures >= SLOWMODE_FAILURE_THRESHOLD;
  const effectiveSecs = wantSlow
    ? Math.max(peakAdjustedSecs * SLOWMODE_MULTIPLIER, 60)
    : peakAdjustedSecs;

  // Aynı aralık zaten kuruluysa gereksiz yere yeniden kurma
  if (effectiveSecs === _currentEffectiveSecs &&
      _slowModeActive === wantSlow &&
      _peakModeActive === wantPeak) {
    return;
  }

  await chrome.alarms.clear(ALARM_NAME);
  const periodMinutes = Math.max(effectiveSecs / 60, MIN_ALARM_PERIOD);
  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: periodMinutes,
    periodInMinutes: periodMinutes
  });

  _currentEffectiveSecs = effectiveSecs;
  const wasSlow = _slowModeActive;
  const wasPeak = _peakModeActive;
  _slowModeActive = wantSlow;
  _peakModeActive = wantPeak;

  // Mod geçişlerini logla - gereksiz tekrarlamayı önle
  if (wantSlow && !wasSlow) {
    console.warn(`[KickAlert] M4: Yavaşlatma aktif - baz ${baseSecs}s → ${effectiveSecs}s (${failures} hata/10dk)`);
  } else if (!wantSlow && wasSlow) {
    dbg(`[KickAlert] M4: Yavaşlatma kalktı - ${effectiveSecs}s'ye döndü`);
  } else if (wantPeak && !wasPeak) {
    console.warn(`[KickAlert] M5: Peak saat (${PEAK_HOUR_START}-${PEAK_HOUR_END}) yavaşlatması - ${baseSecs}s → ${effectiveSecs}s`);
  } else if (!wantPeak && wasPeak) {
    dbg(`[KickAlert] M5: Peak saat sona erdi - ${effectiveSecs}s'ye döndü`);
  } else {
    dbg(`[KickAlert] Alarm scheduled - every ${effectiveSecs}s (${periodMinutes.toFixed(2)} min)`);
  }

  // v2.3.1 fix D: Peak/normal geçişinde session refresh alarm'ı da yeniden kursun
  // (peak'te 15dk, normalde 25dk)
  if (wantPeak !== wasPeak) {
    try {
      await scheduleSessionRefreshAlarm();
    } catch (e) {
      dbg('[KickAlert] Refresh alarm reschedule error (ignored):', e.message);
    }
  }
}

// v2.3.1: Cloudflare bot management cookie'leri (__cf_bm) ~30 dk'da expire olur.
// Normal saatlerde 25 dakikada bir, peak saatlerde 15 dakikada bir kick.com'a
// proaktif GET atarak cookie'yi taze tut. Peak'te daha sık → CF baskısı altında
// session daha uzun sağlam kalır.
let _currentRefreshPeriod = 0; // dk cinsinden - gereksiz yeniden zamanlamayı önle

async function scheduleSessionRefreshAlarm() {
  // Peak saatlerinde daha sık tazele
  const desiredPeriod = isPeakHour() ? 15 : 25;
  if (desiredPeriod === _currentRefreshPeriod) return;

  await chrome.alarms.clear(SESSION_REFRESH_ALARM);
  chrome.alarms.create(SESSION_REFRESH_ALARM, {
    delayInMinutes: 5,                   // İlk refresh 5 dk sonra
    periodInMinutes: desiredPeriod,
  });
  _currentRefreshPeriod = desiredPeriod;
  dbg(`[KickAlert] Session refresh alarm scheduled - every ${desiredPeriod} min ${isPeakHour() ? '(peak)' : ''}`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // M3 (jitter): 0-5 sn rastgele bekle - fingerprint riskini azalt.
    // SW context'lerde tüm uzantı kullanıcılarının saat başında aynı anda istek atması
    // Cloudflare için bot davranışı sinyali; jitter bunu kırar.
    const jitterMs = Math.floor(Math.random() * 5000);
    if (jitterMs > 0) {
      await new Promise(r => setTimeout(r, jitterMs));
    }
    // M4: Diagnostic panel için jitter ölçümünü kaydet
    if (typeof KickAPI !== 'undefined' && KickAPI.recordJitter) {
      KickAPI.recordJitter(jitterMs);
    }

    KLog.debug('ALM-01', `Alarm tetiklendi: ${new Date().toLocaleTimeString()} (+${jitterMs}ms jitter)`);
    await Utils.ensureI18n();
    await cleanupNotifiedLives(); // BUG 15 FIX
    await checkSafe();

    // M4: Bu tick sonrası failure penceresini değerlendir, gerekirse alarm aralığını ayarla
    try {
      await scheduleAlarm();
    } catch (e) {
      dbg('[KickAlert] M4 reschedule error (ignored):', e.message);
    }
  } else if (alarm.name === PAUSE_ALARM) {
    // v2.5.98: duraklatma süresi doldu
    try { const p = (await chrome.storage.local.get(PAUSE_KEY))[PAUSE_KEY]; if (p && !(p.until > Date.now())) await chrome.storage.local.remove(PAUSE_KEY); } catch (e) {}
    await updateBadgeColor();
    KLog.info('PAU-02', 'Bildirim duraklatması sona erdi');
  } else if (alarm.name === SPECIAL_DAY_ALARM || alarm.name === SPECIAL_DAY_ALARM + '-pv') {
    await applySpecialDayIcon(alarm.name !== SPECIAL_DAY_ALARM); // v2.6.0
  } else if (alarm.name === SESSION_REFRESH_ALARM) {
    // v2.3.1: Proaktif Cloudflare cookie yenileme
    dbg(`[KickAlert] Session refresh alarm fired at ${new Date().toLocaleTimeString()}`);
    await KickAPI.refreshKickSession('proactive_25min');
  }
});

// BUG 16 FIX: Only react to user-facing storage key changes
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  // Skip internal keys
  const internalKeys = ['_liveSlugs', '_notifiedLives', '_lastCheckDone', '_adDiag']; // v2.5.74: teşhis deposu
  const changedKeys = Object.keys(changes);
  if (changedKeys.every(k => internalKeys.includes(k))) return;

  if (changes[StorageKeys.CHECK_INTERVAL]) {
    dbg(`[KickAlert] Check interval changed - rescheduling alarm`);
    await scheduleAlarm();
  }
  if (changes[StorageKeys.DND_ENABLED] || changes[StorageKeys.DND_START] ||
      changes[StorageKeys.DND_END] || changes[StorageKeys.SUSPEND_FROM_DATE]) {
    await updateBadgeColor();
  }
  if (changes[StorageKeys.SPECIAL_DAY_ICONS]) applySpecialDayIcon(true); // v2.6.0
  if (changes._specialDayPreview) { // v2.6.0: test paneli önizlemesi; süresi dolunca normale dön
    applySpecialDayIcon(true);
    const pv = changes._specialDayPreview.newValue;
    try {
      if (pv && pv.until > Date.now()) chrome.alarms.create(SPECIAL_DAY_ALARM + '-pv', { when: pv.until + 500 });
      else await chrome.alarms.clear(SPECIAL_DAY_ALARM + '-pv');
    } catch (e) {}
  }
  if (changes[PAUSE_KEY]) { // v2.5.98
    await updateBadgeColor();
    await schedulePauseAlarm();
    const p = changes[PAUSE_KEY].newValue;
    if (p && p.until > Date.now()) KLog.info('PAU-01', `Bildirimler ${new Date(p.until).toLocaleString()} saatine kadar duraklatıldı${p.favs ? ' (favoriler hariç)' : ''}`);
    else KLog.info('PAU-02', 'Bildirim duraklatması kaldırıldı');
  }
  if (changes[StorageKeys.USER_LANGUAGE] || changes[StorageKeys.USE_BROWSER_LANGUAGE]) {
    // Either manual language choice or "use browser language" toggle changed.
    // Re-detect and reload locale. detectLanguage() reads both flags.
    try {
      const newLang = await Utils.detectLanguage();
      dbg(`[KickAlert] Language preference changed - reloading locale: ${newLang}`);
      await Utils.loadLocale(newLang);
    } catch (e) {
      console.warn('[KickAlert] Language reload failed:', e);
    }
  }
  if (changes[StorageKeys.AD_BLOCK_ENABLED]) {
    await syncAdBlockRuleset(changes[StorageKeys.AD_BLOCK_ENABLED].newValue === true);
  }
});

/**
 * v2.3.18: Reklam Engelleme (DENEYSEL) DNR ruleset'ini kullanıcı ayarına göre
 * açar/kapatır. content.js/adblock-worker-hook.js tarafı ayrı olarak kendi
 * localStorage bayraklarını okuyor - bu fonksiyon SADECE ağ seviyesi (DNR)
 * kısmından sorumlu (Google reklam domain'lerini bloklayan 10 kural).
 */
async function syncAdBlockRuleset(enabled) {
  try {
    if (enabled) {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ['ruleset_ads'] });
      console.log('[KickAlert] AdBlock DNR ruleset açıldı');
    } else {
      await chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ['ruleset_ads'] });
      console.log('[KickAlert] AdBlock DNR ruleset kapatıldı');
    }
  } catch (e) {
    console.warn('[KickAlert] AdBlock ruleset güncellenemedi:', e.message);
  }
}

// ─── Channel Check ───

async function checkSafe() {
  try {
    await checkChannels();
  } catch (e) {
    // v2.1.0: AUTH_REQUIRED zaten kickapi.js'te warn'la loglandı - burada tekrar etme
    if (e && e.message && e.message.startsWith('AUTH_REQUIRED:')) {
      return; // sessizce devam, kullanıcı login olunca recover olur
    }
    // Beklenmeyen hatalar - console.warn (error değil, eklenti çalışmaya devam ediyor)
    console.warn('[KickAlert] Check failed:', e?.message || e);
  }
}

// ─── Viewer Anomaly Detection ───
// ─── Viewer Anomaly Sabitleri ───
// Artış eşikleri storage'dan okunur - sabit değerler kaldırıldı
// NEW_STREAM_WINDOW kaldırıldı - STREAM_SETTLE_MS getViewerAnomaly içinde tek eşik olarak tanımlı
// v2.1.0: PAST_AVG_MULTIPLIER_WARN/ALERT silindi (kullanılmayan dead code)
const HISTORY_CURRENT_MAX = 60;  // 30 sn aralıklı × 60 = 30 dk pencere
const HISTORY_PAST_MAX    = 10;
const ANOMALY_COOLDOWN_MS = 15 * 60 * 1000; // 15 dk cooldown
const ANOMALY_RESET_MS    = 15 * 60 * 1000; // cooldown sonrası peak/valley sıfırla
const ANOMALY_MIN_VIEWERS = 500;             // v2.2.0: 100→500, ciddi kanalları kapsa

// v2.2.1: Plato detection (C imzası - bot tutulan yayında sabit izleyici)
const PLATEAU_WINDOW_ENTRIES = 60;            // Son 60 entry (~30 dk)
const PLATEAU_MIN_ENTRIES    = 50;            // En az 50 entry gerekli (~25 dk veri)
const PLATEAU_THRESHOLD      = 0.02;          // (max-min)/avg < %2 = plato
const PLATEAU_MIN_VIEWERS    = 1000;          // 1K altında dalgalanma doğal, yanlış pozitif

// v2.2.1: Smoothness detection (B imzası - kademeli bot tırmanışı)
const SMOOTHNESS_WINDOW_ENTRIES = 60;         // Son 60 entry (~30 dk)
const SMOOTHNESS_MIN_ENTRIES    = 50;
const SMOOTHNESS_MIN_GROWTH_PCT = 30;         // Toplam artış %30+ olmalı
const SMOOTHNESS_VOLATILITY_MAX = 0.05;       // Delta CV (std/mean) < 0.05 = doğrusal
const SMOOTHNESS_CROSS_COOLDOWN_MS = 30 * 60 * 1000; // Smoothness sonrası 30 dk plato susturulur

async function updateViewerHistory(channels) {
  try {
    const history = await Storage.getViewerHistory();
    const now = Date.now();
    const liveSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));

    // Yayın biten kanallar: current -> past avg'e çevir
    for (const slug of Object.keys(history)) {
      if (!liveSlugs.has(slug)) {
        const rec = history[slug];
        if (rec && rec.current && rec.current.length >= 2) {
          const avg = Math.round(
            rec.current.reduce((s, e) => s + e.v, 0) / rec.current.length
          );
          const pastAvgs = rec.pastAvgs || [];
          pastAvgs.push(avg);
          if (pastAvgs.length > HISTORY_PAST_MAX) pastAvgs.shift();
          // Sadece pastAvgs'i koru, current + peak/valley sıfırla
          history[slug] = { current: [], pastAvgs, streamPeak: null, streamValley: null };
        } else if (rec) {
          // Yeterli veri birikmeden yayın bitti - current'ı temizle
          history[slug] = { current: [], pastAvgs: rec.pastAvgs || [], streamPeak: null, streamValley: null };
        }
      }
    }

    // Canlı kanallar: current'a yeni kayıt ekle
    for (const ch of channels) {
      if (!ch.isLive) continue;
      const slug = ch.channelSlug;
      const rec = history[slug] || { current: [], pastAvgs: [] };
      rec.current = rec.current || [];
      rec.current.push({ v: ch.viewerCount, t: now });
      if (rec.current.length > HISTORY_CURRENT_MAX) rec.current.shift();

      // Cooldown sona erdikten sonra peak/valley sıfırla - her "bölüm" kendi referansıyla değerlendirilir
      const lastRiseAlert = rec._lastRiseAlert || 0;
      const lastDropAlert = rec._lastDropAlert || 0;
      const lastAlertTime = Math.max(lastRiseAlert, lastDropAlert);
      if (lastAlertTime > 0 && now - lastAlertTime >= ANOMALY_RESET_MS) {
        // Cooldown bitti: peak ve valley bu anki değere sıfırla
        rec.streamPeak = ch.viewerCount;
        rec.streamValley = ch.viewerCount;
        rec._lastRiseAlert = 0;
        rec._lastDropAlert = 0;
      } else {
        // Yayın boyunca peak/valley güncelle
        rec.streamPeak = rec.streamPeak ? Math.max(rec.streamPeak, ch.viewerCount) : ch.viewerCount;
        rec.streamValley = rec.streamValley ? Math.min(rec.streamValley, ch.viewerCount) : ch.viewerCount;
      }
      history[slug] = rec;
    }

    await Storage.setViewerHistory(history);

    // Her check sonrası anomali tespiti - popup kapalıyken de çalışır
    await checkViewerAnomalies(channels, history);
  } catch (e) {
    console.warn('[KickAlert] viewerHistory error:', e.message);
  }
}

async function checkViewerAnomalies(channels, history) {
  try {
    const anomalySettings = await Storage.getAnomalySettings();
    if (!anomalySettings.enabled) return;

    const now = Date.now();
    let historyDirty = false;

    for (const ch of channels) {
      if (!ch.isLive || !ch.viewerCount) continue;
      if (ch.viewerCount < ANOMALY_MIN_VIEWERS) continue; // 500 altı - sus

      const chSoundPref = await Storage.getChannelSoundMode(ch.channelSlug);
      if (chSoundPref === 'muted') continue;

      const rec = history[ch.channelSlug];
      if (!rec) continue;

      // v2.1.1: Diagnostic - her kanal için anomaly check özetini console.debug'a yaz
      // (Chrome DevTools'ta "Verbose" filtresi açılınca görünür, default gizli)
      try {
        const cur = rec.current || [];
        if (cur.length >= ROC_MIN_ENTRIES) {
          const roc = getRateOfChange(cur);
          const streamAgeMin = Math.round((ch.startedAt
            ? now - new Date(ch.startedAt).getTime()
            : now - cur[0].t) / 60000);
          if (roc) {
            KLog.debug('ANM-01', `${ch.channelSlug}: v=${ch.viewerCount} roc=${roc.pct}% age=${streamAgeMin}m valley=${rec.streamValley ?? '-'} peak=${rec.streamPeak ?? '-'} hasStartedAt=${!!ch.startedAt}`);
          }
        }
      } catch {}

      // ── Artış tespiti ──
      const anomaly = _spikeEnabled ? getViewerAnomalySync(rec, ch.viewerCount, ch.startedAt, now) : null;
      if (anomaly) {
        const lastRise = rec._lastRiseAlert || 0;
        if (now - lastRise >= ANOMALY_COOLDOWN_MS) {
          dbg(`[KickAlert] Spike: ${ch.channelSlug} - ${anomaly.label}`);
          const mode = anomalySettings.notifyMode || 'both';
          if ((mode === 'notif' || mode === 'both') && !(await alertSuppressedFor(ch.channelSlug))) { // v2.5.98: duraklatma
            const icon = await getAvatarDataUrl(ch);
            const spikeTitle = Utils.i18n('anomalySpikeTitle') || 'Viewer spike';
            // v2.2.1: F format - title'a yüzde eklendi: "Spike (+67%)"
            const titleSuffix = ` (+${anomaly.pct}%)`;
            chrome.notifications.create('ka-anomaly-' + ch.channelSlug + '-' + now, {
              type: 'basic', iconUrl: icon,
              title: ch.userUsername + ' - ' + spikeTitle + titleSuffix,
              message: anomaly.label,
            });
          }
          rec._lastRiseAlert = now;
          historyDirty = true;
        }
      }

      // ── Düşüş tespiti ──
      if (anomalySettings.dropEnabled) {
        const drop = getViewerDropSync(rec, ch.viewerCount, ch.startedAt, now, anomalySettings);
        if (drop) {
          const lastDrop = rec._lastDropAlert || 0;
          if (now - lastDrop >= ANOMALY_COOLDOWN_MS) {
            dbg(`[KickAlert] Drop: ${ch.channelSlug} - ${drop.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if ((mode === 'notif' || mode === 'both') && !(await alertSuppressedFor(ch.channelSlug))) { // v2.5.98: duraklatma
              const icon = await getAvatarDataUrl(ch);
              const dropTitle = Utils.i18n('anomalyDropTitle') || 'Viewer drop';
              // v2.2.1: F format - title'a yüzde eklendi: "Drop (-21%)"
              const titleSuffix = ` (-${drop.pct}%)`;
              chrome.notifications.create('ka-drop-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' - ' + dropTitle + titleSuffix,
                message: drop.label,
              });
            }
            rec._lastDropAlert = now;
            historyDirty = true;
          }
        }
      }

      // ── v2.2.1: Smoothness detection (B imzası - kademeli bot tırmanışı) ──
      // Plato'dan ÖNCE çalışıyor çünkü smoothness tetiklenirse plato 30 dk susturulur (cross-cooldown)
      if (_spikeEnabled) {
        const smooth = getViewerSmoothness(rec, ch.viewerCount, ch.startedAt, now);
        if (smooth) {
          const lastSmooth = rec._lastSmoothAlert || 0;
          if (now - lastSmooth >= ANOMALY_COOLDOWN_MS) {
            dbg(`[KickAlert] Smoothness: ${ch.channelSlug} - ${smooth.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if ((mode === 'notif' || mode === 'both') && !(await alertSuppressedFor(ch.channelSlug))) { // v2.5.98: duraklatma
              const icon = await getAvatarDataUrl(ch);
              const smoothTitle = Utils.i18n('anomalySmoothTitle') || 'Suspicious Linear Growth';
              chrome.notifications.create('ka-smooth-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' - ' + smoothTitle,
                message: smooth.label,
              });
            }
            rec._lastSmoothAlert = now;
            // Cross-cooldown: plato bu kanalda 30 dk susturulsun
            rec._lastPlateauAlert = now + SMOOTHNESS_CROSS_COOLDOWN_MS - ANOMALY_COOLDOWN_MS;
            historyDirty = true;
          }
        }
      }

      // ── v2.2.1: Plato detection (C imzası - bot tutulan sabit izleyici) ──
      if (_spikeEnabled) {
        const plateau = getViewerPlateauSync(rec, ch.viewerCount, ch.startedAt, now);
        if (plateau) {
          const lastPlateau = rec._lastPlateauAlert || 0;
          if (now - lastPlateau >= ANOMALY_COOLDOWN_MS) {
            dbg(`[KickAlert] Plateau: ${ch.channelSlug} - ${plateau.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if ((mode === 'notif' || mode === 'both') && !(await alertSuppressedFor(ch.channelSlug))) { // v2.5.98: duraklatma
              const icon = await getAvatarDataUrl(ch);
              const plateauTitle = Utils.i18n('anomalyPlateauTitle') || 'Suspicious Steady Viewers';
              chrome.notifications.create('ka-plateau-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' - ' + plateauTitle,
                message: plateau.label,
              });
            }
            rec._lastPlateauAlert = now;
            historyDirty = true;
          }
        }
      }
    }

    if (historyDirty) await Storage.setViewerHistory(history);
  } catch (e) {
    console.warn('[KickAlert] anomaly check error:', e.message);
  }
}

const STREAM_SETTLE_MS = 10 * 60 * 1000; // v2.2.0: yayın başı 10dk anomali koruması (getViewerAnomaly'de eşik)
const ROC_WINDOW = 4; // Rate of change: son 4 entry vs önceki 4 entry (her biri ~2 dk)
const ROC_MIN_ENTRIES = 8; // En az 8 entry gerekli (~4 dk veri)

// Ani sıçrama tespiti - sliding window rate of change
// Son ROC_WINDOW entry ortalaması vs önceki ROC_WINDOW entry ortalaması
// v2.2.0: Spike'ta 10 dk yayın başı grace, drop'ta grace yok. ROC sliding window
// her iki yönde de tek tetikleme yolu (geniş pencere yolu yapısal hatasıyla kaldırıldı).
function getRateOfChange(current) {
  if (!current || current.length < ROC_MIN_ENTRIES) return null;
  const recent = current.slice(-ROC_WINDOW);
  const prev   = current.slice(-ROC_WINDOW * 2, -ROC_WINDOW);
  const avgRecent = recent.reduce((s, e) => s + e.v, 0) / recent.length;
  const avgPrev   = prev.reduce((s, e) => s + e.v, 0) / prev.length;
  if (!avgPrev) return null; // v2.1.1: <1000 iç kapısı kaldırıldı (dış ANOMALY_MIN_VIEWERS yeterli)
  const pct = Math.round(((avgRecent - avgPrev) / avgPrev) * 100);
  // v2.3.0 Fix: Eğer entry'ler arasında uzun gap varsa (403 nedeniyle veri kaybı),
  // raw windowMin gerçeği yansıtmaz. Gap detection: en uzun ardışık gap > 5 dk ise,
  // ROC tetiklenmeli ama bildirim "son N dk" sınırlandırılmalı (kullanıcıyı kafa
  // karıştırmasın, yanlış veri penceresi sunulmasın).
  let maxGapMs = 0;
  for (let i = 1; i < ROC_WINDOW * 2; i++) {
    const cur = current[current.length - 1 - (ROC_WINDOW * 2 - 1) + i];
    const prv = current[current.length - 1 - (ROC_WINDOW * 2 - 1) + i - 1];
    if (cur && prv) maxGapMs = Math.max(maxGapMs, cur.t - prv.t);
  }
  const rawWindowMin = Math.round((recent[recent.length-1].t - prev[0].t) / 60000);
  // Eğer büyük gap varsa (>3 dk arasında entry yok), windowMin'i sınırla
  // Normal interval ~30s; 8 entry sürede ~3.5 dk olmalı. >10 dk = anormal gap.
  const windowMin = (maxGapMs > 3 * 60 * 1000)
    ? Math.min(rawWindowMin, 10)  // gap'li veri → max 10 dk göster
    : rawWindowMin;
  return { pct, avgRecent: Math.round(avgRecent), avgPrev: Math.round(avgPrev), windowMin };
}

// v2.3.0: Bildirim mesajındaki etiket "son N dk'da" formatına çevrildi.
// Eski "X dk'dır yayında/takipte" → "son N dk" (değişikliğin yaşandığı pencere)
// Bu kullanıcıya "şu an ne oldu" sorusunun cevabını net verir.
// Format: "{from} → {to} · {windowLabel}" → "2.1K → 3.5K · son 4 dk"
function buildAnomalyLabel(windowMin, fromVal, toVal) {
  const fallbackEn = `last ${windowMin} min`;
  const windowLabel = Utils.i18n('anomalyWindowLabel', [String(windowMin)]) || fallbackEn;
  return `${formatK(fromVal)} → ${formatK(toVal)} · ${windowLabel}`;
}

// Sync versiyon - checkViewerAnomalies'de history zaten yüklü
function getViewerAnomalySync(rec, currentCount, streamStartedAt, now) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null; // yeterli veri yok - sus

    const streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;

    // v2.2.0: Yayın başı 10 dk grace - bu süre içinde organik patlama
    // (notification push + discovery + raid kombinasyonu) gerçek spike'tan
    // ayırt edilemez. 10 dk sonrası ROC algoritması güvenilir çalışır.
    if (streamAge < STREAM_SETTLE_MS) return null;

    const { warn: warnThreshold, alert: alertThreshold } = SPIKE_THRESHOLDS[_spikeSensitivity] || SPIKE_THRESHOLDS.avg;

    // ── Rate of change - ani sıçrama tespiti ──
    // v2.2.0: Geniş pencere yolu (streamValley referans) kaldırıldı.
    // Yapısal hatalıydı - yayın boyunca biriken sabit referans, dalgalanan
    // yayınlarda her aşağı-yukarıda yanlış pozitif üretiyordu (RoseHeus 98→1.0K
    // tipi vakalar). ROC sliding window yeterli kapsama sağlıyor.
    const roc = getRateOfChange(current);
    if (roc && roc.pct >= warnThreshold) {
      const level = roc.pct >= alertThreshold ? 'alert' : 'warn';
      const label = buildAnomalyLabel(roc.windowMin, roc.avgPrev, roc.avgRecent);
      return { pct: roc.pct, level, label };
    }

    return null;
  } catch { return null; }
}

// Async wrapper - popup mesaj handler için
async function getViewerAnomaly(slug, currentCount, streamStartedAt) {
  try {
    const history = await Storage.getViewerHistory();
    return getViewerAnomalySync(history[slug], currentCount, streamStartedAt, Date.now());
  } catch { return null; }
}

function formatK(n) {
  if (n >= 10000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';  // 3.6K - hassas gösterim
  return String(n);
}

function getViewerDropSync(rec, currentCount, streamStartedAt, now, anomalySettings) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null;

    const { warn: warnThreshold, alert: alertThreshold } = DROP_THRESHOLDS[_dropSensitivity] || DROP_THRESHOLDS.avg;

    // ── Rate of change - ani düşüş tespiti ──
    // v2.2.0: Grace period kaldırıldı (mantıken gereksizdi - yayın başında
    // peak yokken düşüş hesaplanamaz, ROC için ROC_MIN_ENTRIES (~4 dk veri)
    // zaten yeterli koruma sağlıyor).
    // v2.2.0: Geniş pencere yolu (streamPeak referans) kaldırıldı -
    // spike'taki streamValley'in simetriği aynı yapısal hatayı taşıyordu.
    const roc = getRateOfChange(current);
    if (roc && roc.pct <= -warnThreshold) {
      // v2.3.0: Yayın kapanışı tespiti - kapanan yayında viewer count dramatik düşer.
      // Eğer mevcut count, son 30 dk'daki peak'in %20'sinden az ise "yayın bitiyor"
      // varsayıp drop bildirimini atla. Aksi halde her yayın kapanışında bildirim gider.
      const recentPeak = Math.max(...current.map(e => e.v));
      if (recentPeak > 0 && currentCount < recentPeak * 0.20) {
        return null;
      }

      const absPct = Math.abs(roc.pct);
      const level = absPct >= alertThreshold ? 'alert' : 'warn';
      const label = buildAnomalyLabel(roc.windowMin, roc.avgPrev, roc.avgRecent);
      return { pct: absPct, level, label };
    }

    return null;
  } catch { return null; }
}

async function getViewerDrop(slug, currentCount, streamStartedAt, anomalySettings) {
  try {
    const history = await Storage.getViewerHistory();
    return getViewerDropSync(history[slug], currentCount, streamStartedAt, Date.now(), anomalySettings);
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// v2.2.1: Plato detection (C imzası)
// Bot tutulan yayında izleyici sayısı uzun süre dar bir aralıkta sabit kalır.
// Organik yayında 30 dk boyunca ±%2 dalgalanma neredeyse imkansız.
// ═══════════════════════════════════════════════════════════════════
function getViewerPlateauSync(rec, currentCount, streamStartedAt, now) {
  try {
    if (!rec) return null;
    const current = rec.current || [];
    if (current.length < PLATEAU_MIN_ENTRIES) return null;
    if (currentCount < PLATEAU_MIN_VIEWERS) return null;

    // Yayın başı 10 dk grace (spike ile aynı - yayın yeni başlamış olabilir)
    const streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;
    if (streamAge < STREAM_SETTLE_MS) return null;

    // Son 60 entry'yi al (en son veri)
    const window = current.slice(-PLATEAU_WINDOW_ENTRIES);
    const values = window.map(e => e.v);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = sum / values.length;

    if (avg <= 0) return null;
    const range = (max - min) / avg;
    if (range >= PLATEAU_THRESHOLD) return null; // Yeterince düz değil

    // Plato tespit edildi
    const plateauMin = Math.round((window[window.length - 1].t - window[0].t) / 60000);
    const streamAgeMin = Math.round(streamAge / 60000);
    const i18nKey = streamStartedAt ? 'anomalyAgeLabel' : 'anomalyObsLabel';
    const fallbackEn = streamStartedAt ? `live for ${streamAgeMin} min` : `${streamAgeMin} min tracked`;
    const ageLabel = Utils.i18n(i18nKey, [String(streamAgeMin)]) || fallbackEn;
    const plateauLabel = Utils.i18n('anomalyPlateauBody', [String(plateauMin), formatK(Math.round(avg))])
                      || `${plateauMin} min steady · ~${formatK(Math.round(avg))} viewers`;

    return {
      level: 'warn',
      label: `${plateauLabel} · ${ageLabel}`,
      avg: Math.round(avg),
      plateauMin,
    };
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════
// v2.2.1: Smoothness detection (B imzası)
// Kademeli bot tırmanışı: 30 dk içinde %30+ artış var ama
// delta'lar arası varyans çok düşük (volatility coefficient < 0.05).
// Organik tırmanış zigzaglıdır, bot tırmanışı doğrusaldır.
// ═══════════════════════════════════════════════════════════════════
function getViewerSmoothness(rec, currentCount, streamStartedAt, now) {
  try {
    if (!rec) return null;
    const current = rec.current || [];
    if (current.length < SMOOTHNESS_MIN_ENTRIES) return null;
    if (currentCount < ANOMALY_MIN_VIEWERS) return null;

    // Yayın başı 10 dk grace
    const streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;
    if (streamAge < STREAM_SETTLE_MS) return null;

    const window = current.slice(-SMOOTHNESS_WINDOW_ENTRIES);
    const first = window[0].v;
    const last = window[window.length - 1].v;

    if (first <= 0) return null;
    const growthPct = ((last - first) / first) * 100;
    if (growthPct < SMOOTHNESS_MIN_GROWTH_PCT) return null; // Yeterli artış yok

    // Ardışık delta'lar
    const deltas = [];
    for (let i = 1; i < window.length; i++) {
      deltas.push(window[i].v - window[i - 1].v);
    }
    if (deltas.length < 10) return null;

    // Volatility coefficient = std(deltas) / mean(deltas)
    const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (meanDelta <= 0) return null; // Net artış yok (negatif veya sıfır ortalama)

    const variance = deltas.reduce((s, d) => s + Math.pow(d - meanDelta, 2), 0) / deltas.length;
    const std = Math.sqrt(variance);
    const volatility = std / meanDelta;

    if (volatility >= SMOOTHNESS_VOLATILITY_MAX) return null; // Yeterince düzgün değil (organik)

    // Smoothness tespit edildi
    const windowMin = Math.round((window[window.length - 1].t - window[0].t) / 60000);
    const streamAgeMin = Math.round(streamAge / 60000);
    const i18nKey = streamStartedAt ? 'anomalyAgeLabel' : 'anomalyObsLabel';
    const fallbackEn = streamStartedAt ? `live for ${streamAgeMin} min` : `${streamAgeMin} min tracked`;
    const ageLabel = Utils.i18n(i18nKey, [String(streamAgeMin)]) || fallbackEn;
    const smoothLabel = Utils.i18n('anomalySmoothBody', [
      String(Math.round(growthPct)), String(windowMin),
      formatK(first), formatK(last)
    ]) || `+${Math.round(growthPct)}% in ${windowMin} min · ${formatK(first)} → ${formatK(last)}`;

    return {
      level: 'warn',
      label: `${smoothLabel} · ${ageLabel}`,
      growthPct: Math.round(growthPct),
      volatility,
    };
  } catch { return null; }
}

let _autoLaunchTabOpened = false; // Her check döngüsünde sıfırlanır
let _checkRunning = false; // Bulgu#4: paralel checkChannels'ı önler (isStale race koruması)

async function checkChannels() {
  // Bulgu#4 FIX: Paralel checkChannels çalışmasını engelle. Alarm + FORCE_RECHECK
  // aynı anda tetiklenirse, getAllFollowingChannels'ın global _lastFetchWasStale
  // bayrağı yanlış okunabilir (biri taze yazar, diğeri okur). Kilit bunu kapatır;
  // ayrıca cachedChannels'a iki ayrı yazma yarışını da önler. Bir check zaten
  // çalışıyorsa yenisini sessizce atla (bir sonraki alarm zaten tekrar tetikler).
  if (_checkRunning) {
    dbg('[KickAlert] checkChannels zaten çalışıyor, paralel çağrı atlandı');
    return;
  }
  _checkRunning = true;
  try {
    await _checkChannelsInner();
  } finally {
    _checkRunning = false;
  }
}

async function _checkChannelsInner() {
  _autoLaunchTabOpened = false; // Her check başında sıfırla - ilk sekme öne gelsin
  const channels = await KickAPI.getAllFollowingChannels();
  const isStale = KickAPI._lastFetchWasStale; // Risk#2: bu veri taze mi fallback mi?

  // Risk#1 FIX: "Hayalet canlı kanal" temizliği.
  // _pusherLiveSlugs sadece StopStreamBroadcast event'iyle temizleniyordu.
  // Ama o event kaçabilir (unfollow → unsubscribe, ya da WebSocket kopması).
  // Çözüm: API TAZE veri döndürdüyse (403 değil) ve bir kanalı offline
  // diyorsa, Pusher offline event'ini kaçırmış olabiliriz → API'ye güvenip
  // _pusherLiveSlugs'tan çıkar. API fallback (stale) ise Pusher'a güven, dokunma.
  if (!isStale && _pusherLiveSlugs.size > 0) {
    const liveApiSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    const now = Date.now();
    for (const pSlug of [..._pusherLiveSlugs]) {
      if (!liveApiSlugs.has(pSlug)) {
        // Çok-yeni event koruması: Pusher bu kanalı GRACE süresi içinde canlı
        // bildirdiyse, API henüz güncellenememiş olabilir (backend gecikmesi).
        // Bu durumda temizleme - gerçek offline ise bir sonraki check yakalar.
        const liveSince = _pusherLiveSince.get(pSlug) || 0;
        if (now - liveSince < PUSHER_LIVE_GRACE_MS) {
          continue; // henüz taze, koru
        }
        // Taze API bu kanalı canlı görmüyor + grace geçti → Pusher offline kaçmış.
        _unmarkPusherLive(pSlug);
        dbg(`[KickAlert] Risk#1: ${pSlug} taze API'de offline → _pusherLiveSlugs'tan temizlendi (hayalet önleme)`);
      }
    }
  }

  // #D FIX: API'den gelen channels Pusher'ın canlı bildiği kanalları
  // ezmemeli. API 403 + fallback cache (eski veri) durumunda kanal API'de
  // offline görünebilir ama Pusher'dan canlı event geldi. Pusher'ın live
  // state'ini koruyalım - aksi halde badge/popup tutarsız olur.
  // (Risk#1 temizliğinden SONRA çalışır: hayaletler zaten ayıklandı.)
  if (_pusherLiveSlugs.size > 0) {
    for (const ch of channels) {
      if (_pusherLiveSlugs.has(ch.channelSlug) && !ch.isLive) {
        ch.isLive = true; // Pusher canlı diyor → API offline'ını ez
      }
    }
    // API listesinde HİÇ olmayan ama Pusher'da canlı kanal var mı?
    // (örn. followed endpoint 403 → fallback cache'te o kanal yok)
    const apiSlugs = new Set(channels.map(c => c.channelSlug));
    for (const pSlug of _pusherLiveSlugs) {
      if (!apiSlugs.has(pSlug)) {
        // Önceki cachedChannels'tan bu kanalın objesini bulup taşı (varsa)
        const prev = (cachedChannels || []).find(c => c.channelSlug === pSlug);
        if (prev) {
          prev.isLive = true;
          channels.push(prev);
        }
      }
    }
  }

  cachedChannels = channels;
  // Persist channel data so popup can load instantly even if SW sleeps
  try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
  const liveCount = channels.filter(c => c.isLive).length;
  await chrome.action.setBadgeText({ text: liveCount > 0 ? String(liveCount) : '' });
  await updateBadgeColor();
  await updateDynamicTooltip(channels);

  const state = await getPersistedState();
  const liveChannelSlugs = state.liveSlugs;
  let notifiedLives = state.notifiedLives;

  // First run OR fresh startup with empty state - record current live, don't notify
  // Prevents duplicate notifications when browser starts with streams already live
  if (!state.lastCheckDone || state.liveSlugs.size === 0) {
    const currentLive = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    await setPersistedLiveSlugs(currentLive);
    if (!state.lastCheckDone) await setLastCheckDone();
    dbg(`[KickAlert] Startup check - ${liveCount} live channels recorded, no notifications`);
    return;
  }

  const showNotif = await Storage.getShowNotification();
  const suspended = !!(await Storage.getSuspendFromDate());

  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const dndMuteSound = dndActive && await Storage.getDndMuteSound();
  const dndMuteAutolaunch = dndActive && await Storage.getDndMuteAutolaunch();
  const soundMode = await Storage.getSoundMode();

  if (dndActive) dbg('[KickAlert] DND active - muting:', { notif: dndMuteNotif, sound: dndMuteSound, autolaunch: dndMuteAutolaunch });

  let notified = false;

  // Bildirim gecikmesi - loop dışında tek seferde oku
  const notifDelay = await Storage.getNotifDelay();

  // startedAt null olan kanallar için viewerHistory tek seferlik yüklenir
  const vhData = await chrome.storage.local.get('viewerHistory');
  const vh = vhData.viewerHistory || {};

  for (const ch of channels) {
    if (liveChannelSlugs.has(ch.channelSlug) || !ch.isLive) continue;
    // #D/#E FIX: Pusher bu kanalı zaten canlı bildirdiyse polling tekrar
    // bildirmesin (dar yarış penceresinde getPersistedState snapshot'ı
    // Pusher'ın persist'inden eski olabilir - bu RAM Set'i o boşluğu kapatır).
    if (_pusherLiveSlugs.has(ch.channelSlug)) {
      liveChannelSlugs.add(ch.channelSlug);
      continue;
    }
    if (ch.startedAt) {
      // startedAt varsa: yayın 10 dk+ önce başlamışsa atla - zaten yayındaydı
      const streamStart = new Date(ch.startedAt).getTime();
      const streamAgeMs = Date.now() - streamStart;
      if (streamAgeMs > 10 * 60 * 1000) {
        dbg(`[KickAlert] Skipping long-running live (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
        liveChannelSlugs.add(ch.channelSlug);
        continue;
      }
    } else {
      // startedAt null - yayın ne zaman başladı bilinmiyor.
      // API'den yayın başlangıcını sorgula - viewerHistory eski oturumdan kalmış olabilir
      const apiStartTime = await KickAPI.getChannelStartTime(ch.channelSlug);
      if (apiStartTime) {
        const streamStart = new Date(apiStartTime).getTime();
        const streamAgeMs = Date.now() - streamStart;
        if (streamAgeMs > 10 * 60 * 1000) {
          // Yayın 10 dk+ önce başlamış - zaten yayındaydı, atla
          dbg(`[KickAlert] Skipping long-running live API (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        // Yayın 10 dk içinde başlamış - yeni yayın, devam et
        dbg(`[KickAlert] New live confirmed via API startTime (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
      } else {
        // v2.3.0: API'den de bilgi gelmedi (Cloudflare 403 olabilir).
        // viewerHistory ile fallback: yüksek viewer'lı kanal = uzun yayın varsayımı.
        // Sadece geçmişi olmayan kanallarda "yeni varsay" mantığı çalışsın.
        const histRec = vh[ch.channelSlug];
        const hasHistory = histRec?.current?.length > 0;
        const lastViewerCount = ch.viewerCount || 0;

        if (hasHistory) {
          // Geçmişi var demek = bu yayın bir süredir izleniyor → eski yayın, atla
          dbg(`[KickAlert] No API time but has history - skipping (likely long-running): ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        if (lastViewerCount > 1000) {
          // Geçmiş yok ama 1000+ viewer = büyük olasılıkla zaten saatlerdir yayında, organik trafik birikmiş
          dbg(`[KickAlert] No API time, no history, but ${lastViewerCount} viewers - likely long-running, skipping: ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        // Geçmiş yok ve viewer sayısı düşük → büyük ihtimalle gerçekten yeni başlamış
        dbg(`[KickAlert] No API time, no history, low viewers - treating as new live: ${ch.channelSlug}`);
      }
    }

    // Bildirim gecikmesi kontrolü
    if (notifDelay > 0) {
      let streamAgeMin = null;
      if (ch.startedAt) {
        streamAgeMin = (Date.now() - new Date(ch.startedAt).getTime()) / 60000;
      } else {
        // startedAt null - API'den alınan startTime ile hesapla
        const apiTime = await KickAPI.getChannelStartTime(ch.channelSlug);
        if (apiTime) streamAgeMin = (Date.now() - new Date(apiTime).getTime()) / 60000;
      }
      if (streamAgeMin !== null && streamAgeMin < notifDelay) {
        dbg(`[KickAlert] Delay pending: ${ch.channelSlug} (${Math.round(streamAgeMin)}/${notifDelay}min)`);
        continue;
      }
    }

    dbg(`[KickAlert] New live: ${ch.userUsername} (${ch.channelSlug})`);

    // v2.5.50: kanal filtresi (kategori / anahtar kelime)
    const pollFilter = matchChannelFilter(await Storage.getChannelAlertPref(ch.channelSlug), ch.categoryName, ch.sessionTitle);
    const pollSup = pollFilter.pass ? await alertSuppressedFor(ch.channelSlug) : null; // v2.5.98

    // Always log to history
    Storage.addNotificationHistory({
      username: ch.userUsername,
      channelSlug: ch.channelSlug,
      profilePic: ch.profilePic || '',
      title: ch.sessionTitle || '-',
      category: ch.categoryName || '-',
      timestamp: new Date().toISOString(),
      ...(pollFilter.pass ? {} : { filtered: pollFilter.reason }),
      ...(pollSup ? { paused: pollSup } : {}),
    });

    if (pollSup) {
      KLog.info('PAU-11', `${ch.channelSlug} → bildirimler ${pollSup === 'snooze' ? 'bu kanal için susturulmuş' : 'duraklatılmış'}; sadece geçmiş`);
      continue;
    }

    if (!pollFilter.pass) {
      KLog.info('FLT-10', `${ch.channelSlug} → filtreye takıldı (${pollFilter.reason}), bildirim/ses/sekme atlandı`);
      continue;
    }

    // Channel-level sound preference: main / sub / silent / muted
    const chModeInfo = await Storage.getChannelSoundModeInfo(ch.channelSlug);
    const chSoundPref = chModeInfo.mode;

    // Muted = no notification, no sound, only history
    // v2.5.74: varsayılandan gelen 'Bildirim yok' kanalda açıkça açılmış otomatik açmayı engellemez
    if (chSoundPref === 'muted') {
      if (!chModeInfo.explicit && !suspended && !dndMuteAutolaunch && await shouldAutoOpen(ch)) {
        const tab = await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: !_autoLaunchTabOpened });
        KLog.info('TAB-71', `${ch.channelSlug} → polling SEKME AÇILDI (varsayılan bildirim kapalı, otomatik açma açık, tabId=${tab.id})`);
        registerAutoTab(tab.id, ch.channelSlug);
        _autoLaunchTabOpened = true;
      }
      continue;
    }

    // POLL-40: Send notification (if enabled and not DND-muted)
    if (showNotif && !dndMuteNotif) {
      if (notified) await Utils.delay(5000);
      const isSilentNotif = soundMode === 'extension' || chSoundPref === 'silent';
      await sendNotification(ch, notifiedLives, isSilentNotif);
      KLog.info('POLL-40', `${ch.channelSlug} → polling bildirim GÖNDERİLDİ (silentSystem=${isSilentNotif})`);
      notified = true;
    } else {
      KLog.debug('POLL-40', `${ch.channelSlug} → polling bildirim atlandı (showNotif=${showNotif} dndMute=${dndMuteNotif})`);
    }

    // POLL-41: Play sound based on channel preference
    if (!dndMuteSound && chSoundPref !== 'silent') {
      const soundType = chSoundPref === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB';
      await playSound(soundType);
      KLog.info('POLL-41', `${ch.channelSlug} → polling ses çalındı (${soundType})`);
    }

    // POLL-42 / TAB-71: Auto-open tab (independent of sound)
    // NOT: Polling yolunda 3-9sn güvenlik gecikmesi YOK çünkü polling zaten
    // 30sn cycle ile çalışır - yayın yakalandığında zaten birkaç saniye geçmiştir.
    if (!suspended && !dndMuteAutolaunch) {
      if (await shouldAutoOpen(ch)) {
        const tab = await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: !_autoLaunchTabOpened });
        KLog.info('TAB-71', `${ch.channelSlug} → polling SEKME AÇILDI (tabId=${tab.id}, gecikme yok)`);
        registerAutoTab(tab.id, ch.channelSlug);
        _autoLaunchTabOpened = true;
      } else {
        KLog.debug('TAB-71', `${ch.channelSlug} → polling shouldAutoOpen=false → sekme açılmadı`);
      }
    }
  }

  // v2.5.49: Kategori / başlık değişim bildirimleri (kanal bazlı, varsayılan kapalı)
  try {
    await checkChannelMetaChanges(channels, notifiedLives, {
      isStale, showNotif, dndMuteNotif, soundMode,
    });
  } catch (e) {
    KLog.warn('CHG-99', 'Değişim kontrolü hatası', e);
  }

  // v2.5.53: Yayın bitti bildirimi (kanal bazlı, varsayılan kapalı)
  try {
    const nowLive = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    for (const p of _pusherLiveSlugs) nowLive.add(p);
    if (!isStale) {
      for (const prevSlug of liveChannelSlugs) {
        if (!nowLive.has(prevSlug)) await addStreamEndCandidate(prevSlug, 'poll');
      }
    }
    await processStreamEndCandidates(channels, nowLive, notifiedLives, {
      isStale, showNotif, dndMuteNotif, soundMode,
    });
  } catch (e) {
    KLog.warn('END-99', 'Yayın bitti kontrolü hatası', e);
  }

  // #E FIX: Polling liveSlugs'u REPLACE ediyor (API snapshot'ına göre).
  // AMA Pusher'ın canlı bildiği kanalları EZMEMELI - özellikle API 403 +
  // fallback cache (eski veri) durumunda polling kanalı offline sanabilir.
  // Çözüm: polling_live ∪ _pusherLiveSlugs. Pusher offline event'i gelince
  // _pusherLiveSlugs'tan zaten çıkar, o yüzden bu union güvenli.
  const newLiveSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
  for (const pSlug of _pusherLiveSlugs) newLiveSlugs.add(pSlug);
  await setPersistedLiveSlugs(newLiveSlugs);
  await setPersistedNotifiedLives(notifiedLives);

  // viewerHistory'yi bildirim kararından SONRA güncelle
  // Önceden güncellenirse startedAt=null olan yeni kanallar skip edilir
  await updateViewerHistory(channels);

  // ─── v2.3.0: Bot Tracker - sync live channels to offscreen ───
  await syncBotTracker(channels);

  // ─── v2.3.1 Plan F: Pusher subscription sync ───
  // Kanal listesi değişmiş olabilir (yeni takip / unfollow) → yeni ID'lere subscribe et
  refreshPusherSubscriptions();
}

// v2.3.0: Bot tracker lifecycle management
// Live kanallar için chatroom_id alır, offscreen'e BOT_TRACK_SYNC gönderir.
// Hiç canlı kanal yoksa offscreen'i durdurur (Strateji B - kanal varsa açık).
//
// v2.3.0 Firefox desteği - Dual-mode:
//   Chrome:  BotTracker offscreen.html içinde çalışır → mesajlaşma ile
//   Firefox: BotTracker bu script'le aynı bağlamda yüklenir → doğrudan çağrı
// BotTrackerHost helper iki yolu transparent yapar.
const BotTrackerHost = {
  // Firefox'ta BotTracker bu scripte global olarak yüklü mü? (manifest:scripts üzerinden)
  // Chrome'da typeof BotTracker === 'undefined' olur (sadece offscreen'de var)
  get isLocal() {
    return typeof BotTracker !== 'undefined' && BotTracker !== null;
  },

  // Chrome offscreen mevcut mu (Firefox'ta yok)
  get hasOffscreen() {
    return !!chrome.offscreen;
  },

  // Bot tracker özelliği bu platformda destekleniyor mu (her iki yolda da)
  get isSupported() {
    return this.isLocal || this.hasOffscreen;
  },

  // Offscreen "var" mı kontrol et - Firefox'ta her zaman true (BotTracker yüklü)
  async isAlive() {
    if (this.isLocal) return true; // Firefox: BotTracker zaten bu bağlamda yüklü
    if (!this.hasOffscreen) return false;
    try { return await chrome.offscreen.hasDocument(); } catch { return false; }
  },

  // BOT_TRACK_SYNC - tracker'ı bu kanal listesi için sync et
  async sync(channels) {
    if (this.isLocal) {
      // Firefox: doğrudan çağrı
      try {
        await BotTracker.syncChannels(channels);
        return { success: true, trackedCount: BotTracker.channels.size };
      } catch (e) {
        return { success: false, error: e.message };
      }
    }
    // Chrome: offscreen'e mesaj
    return chrome.runtime.sendMessage({
      target: 'offscreen', type: 'BOT_TRACK_SYNC', channels, pusherCfg: pusherCfgPayload(),
    });
  },

  // v2.5.103: sohbet radarı ayarını tracker'a ver (null = kapalı)
  async setRadar(radar) {
    if (this.isLocal) {
      try { BotTracker.setRadar(radar); return { success: true, on: !!BotTracker.radar }; } catch (e) { return { success: false, error: e.message }; }
    }
    if (!this.hasOffscreen) return { success: false };
    try { if (!(await chrome.offscreen.hasDocument())) return { success: false, reason: 'no-offscreen' }; } catch (e) { return { success: false }; }
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'BOT_SET_RADAR', radar }).catch(() => ({ success: false }));
  },

  // BOT_TRACK_STOP - tracker'ı durdur
  async stop() {
    if (this.isLocal) {
      try {
        BotTracker.shutdown();
        BotTracker.channels.clear();
      } catch {}
      return { success: true };
    }
    if (!this.hasOffscreen) return { success: false };
    if (!await this.isAlive()) return { success: false };
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', type: 'BOT_TRACK_STOP' });
    } catch { return { success: false }; }
  },

  // BOT_GET_STATS - istatistikleri al
  async getStats() {
    if (this.isLocal) {
      try { return { success: true, stats: BotTracker.getStats() }; }
      catch (e) { return { success: false, error: e.message }; }
    }
    if (!this.hasOffscreen) return { success: false, error: 'unsupported' };
    if (!await this.isAlive()) return { success: false, error: 'no_offscreen' };
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'BOT_GET_STATS' });
  },

  // BOT_COMPUTE_SCORES - skorları hesapla
  async computeScores(viewerMap, kickChatters) {
    if (this.isLocal) {
      try { return { success: true, scores: BotTracker.computeScores(viewerMap, kickChatters || {}) }; }
      catch (e) { return { success: false, error: e.message }; }
    }
    if (!this.hasOffscreen) return { success: false, error: 'unsupported' };
    return chrome.runtime.sendMessage({
      target: 'offscreen', type: 'BOT_COMPUTE_SCORES', viewerMap, kickChatters: kickChatters || {},
    });
  },
};

async function syncBotTracker(channels) {
  // Firefox veya Chrome - BotTrackerHost ikisini de hallediyor
  if (!BotTrackerHost.isSupported) return;

  // Master toggle
  // v2.5.54: Bot tespiti kapalı olsa bile, raid bildirimi açılmış canlı
  // kanalların chatroom'u dinlenir (sadece onlar; skor hesabı yapılmaz).
  const enabled = await Storage.getBotTrackerEnabled();
  const alertPrefs = await Storage.getChannelAlertPrefs();
  // v2.5.81: Firefox'ta da skor hesaplanır (önceden Firefox'ta BotTracker sadece
  // raid için çalışıyordu, bot skoru hiç yoktu). Firefox'ta BotTracker arka plan
  // sayfasında, Chrome'da offscreen'de; BotTrackerHost iki yolu da yönetiyor.
  const raidOnly = !enabled;
  // v2.5.103: sohbet radarındaki canlı kanallar bot tespiti kapalıyken de dinlenir
  const radarCfg = await getChatRadarConfig();
  const radarSet = new Set(radarCfg ? radarCfg.slugs : []);
  const listenOnly = c => alertPrefs[c.channelSlug]?.raid || radarSet.has(String(c.channelSlug).toLowerCase());
  if (raidOnly && !channels.some(c => c.isLive && listenOnly(c))) {
    // Disabled olsa da çalışıyor olabilir - durdur
    await BotTrackerHost.stop();
    return;
  }

  const liveChannels = channels.filter(c => c.isLive && (!raidOnly || listenOnly(c)));
  if (liveChannels.length === 0) {
    // Canlı kanal yok - tracker'ı durdur
    await BotTrackerHost.stop();
    return;
  }

  // Chrome: Offscreen document'i başlat (audio olmasa bile bot tracker için lazım)
  // Firefox: Pas geç (BotTracker zaten bu bağlamda yüklü)
  if (BotTrackerHost.hasOffscreen) {
    await startOffscreen();
  }

  // Her live kanal için chatroom_id topla (cache-first, eksikse fetch et)
  const trackList = [];
  for (const ch of liveChannels) {
    try {
      const chatroomId = await KickAPI.getChatroomId(ch.channelSlug);
      if (chatroomId) {
        // v2.5.82: skor hesabı açıksa sohbet modlarını başlangıçta oku (30 dk önbellek)
        let modes = null;
        if (!raidOnly) { try { modes = await KickAPI.getChatroomModes(ch.channelSlug); } catch (e) { modes = null; } }
        trackList.push({
          slug: ch.channelSlug,
          chatroomId,
          userId: 0, // Pusher chat subscribe için chatroomId yeterli
          modes,
        });
      }
    } catch (e) {
      dbg(`[KickAlert] BotTracker chatroom lookup skip ${ch.channelSlug}:`, e.message);
    }
  }

  if (trackList.length === 0) return;

  // Sync et - chrome offscreen'e mesaj veya firefox direct call
  try {
    const response = await BotTrackerHost.sync(trackList);
    // v2.5.103: radar ayarı her senkronda yeniden verilir (offscreen yeniden açılmış olabilir)
    try { await BotTrackerHost.setRadar(radarCfg); } catch (e) {}
    if (response?.success) {
      KLog.debug('BSC-01', `BotTracker ${response.trackedCount} kanal takip ediyor`);
    }
  } catch (e) {
    console.warn('[KickAlert] BotTracker sync error:', e.message);
  }

  // v2.3.0 Aşama 2: Skor hesabı (1 dakikada bir) - sadece bot tespiti açıksa
  if (!raidOnly) await recomputeBotScores(liveChannels);

  // v2.5.89 (b034): Pusher sessizlik bekçisi
  try { await checkRealtimeSilence(liveChannels); } catch (e) { console.warn('[KickAlert] PSH-20 kontrol hatası:', e && e.message); }
}

// ─── v2.5.89 (b034): Pusher sessizlik bekçisi ───
// Kick sitesi sohbeti Centrifugo'dan alıyor, Pusher'a aynı olayları paralel
// yayınlıyor (16.10.2026 ölçüldü). Kick bir gün Pusher'a yayını keserse bağlantı
// açık kalır (pong gelir) ama hiçbir olay gelmez; PSH-13 bunu yakalamaz.
// Kalabalık ve takibi birkaç dakikadır süren canlı kanallarda hiç sohbet mesajı
// gelmiyorsa bunu fark ederiz. Abone moduna geçmiş kanallar sayılmaz.
const RT_SILENCE_MIN_VIEWERS = 500;
const RT_SILENCE_MS = 5 * 60 * 1000;
const RT_SILENCE_CHECK_MS = 60 * 1000;
let _rtSilenceLastCheck = 0;
async function checkRealtimeSilence(liveChannels, force = false) {
  const now = Date.now();
  if (!force && now - _rtSilenceLastCheck < RT_SILENCE_CHECK_MS) return null;
  _rtSilenceLastCheck = now;
  const res = await BotTrackerHost.getStats();
  if (!res || !res.success || !res.stats) return null;
  const viewers = {};
  for (const ch of liveChannels || []) viewers[ch.channelSlug] = ch.viewerCount || 0;
  const eligible = [], silent = [];
  for (const [slug, st] of Object.entries(res.stats)) {
    if (!st || !st.connected) continue;
    if ((viewers[slug] || 0) < RT_SILENCE_MIN_VIEWERS) continue;
    if (st.modes && (st.modes.subOnly || st.modes.emotesOnly)) continue;
    const since = Math.max(st.addedAt || 0, st.connectedAt || 0);
    if (!since || now - since < RT_SILENCE_MS) continue;
    eligible.push(slug);
    if (now - Math.max(st.lastMsgAt || 0, since) >= RT_SILENCE_MS) silent.push(slug);
  }
  const state = !eligible.length ? 'unknown' : silent.length === eligible.length ? 'silent' : silent.length ? 'partial' : 'ok';
  let prev = {};
  try { prev = (await chrome.storage.local.get('_rtHealth'))._rtHealth || {}; } catch (e) {}
  const health = { state, checkedAt: now, eligible: eligible.length, silent, since: (state === prev.state && prev.since) ? prev.since : now };
  try { await chrome.storage.local.set({ _rtHealth: health }); } catch (e) {}
  // v2.5.90: Pusher 10 dakikadır sessizse (yeniden sorma sonrası da) Centrifugo'ya geç
  if (state === 'silent' && KAPusherCfg.provider === 'pusher' && now - health.since >= 2 * RT_SILENCE_MS) {
    try { await switchToCentrifugo('Pusher 10 dakikadır sessiz'); } catch (e) {}
  }
  // Pusher yeniden sağlıklıysa izin hatırlatmasını kaldır
  if (state === 'ok' && KAPusherCfg.provider === 'pusher') {
    try { const d = await chrome.storage.local.get('_rtFallbackNeeded'); if (d._rtFallbackNeeded) await chrome.storage.local.set({ _rtFallbackNeeded: false }); } catch (e) {}
  }
  const prov = KAPusherCfg.provider === 'centrifugo' ? 'Centrifugo' : 'Pusher';
  if (state !== prev.state) {
    if (state === 'silent') {
      KLog.warn('PSH-20', `${prov} bağlı ama ${eligible.length} kalabalık canlı kanalda 5 dakikadır hiç sohbet olayı yok. Kick ${prov} yayınını kesmiş olabilir; bağlantı ayarı yeniden soruluyor.`);
      try { await ensurePusherConfig({ force: true, reason: 'PSH-20 sessizlik' }); } catch (e) {}
    } else if (state === 'partial') {
      KLog.info('PSH-21', `${prov} sessiz kanal(lar): ${silent.join(', ')} (diğer ${eligible.length - silent.length} kanalda olay geliyor; kanal bazlı taşınma olabilir)`);
    } else if (state === 'ok' && (prev.state === 'silent' || prev.state === 'partial')) {
      KLog.info('PSH-22', `${prov} olayları yeniden geliyor`);
    }
  }
  return health;
}

// v2.3.0 Aşama 2: MoKick skor hesabı - her dakika tetiklenir
// 1. Offscreen'den her live kanal için skor al
// 2. Storage'a yaz (popup açıldığında anında okunur)
// 3. Canlıdan çıkan kanalların skorunu temizle
const _BOT_SCORE_INTERVAL_MS = 60 * 1000; // 1 dakika
let _lastBotScoreCompute = 0;

// ─── v2.5.91 (b035): Kick'in kendi aktif sohbetçi sayısı ───
// web.kick.com/api/v1/channels/{id}/chat/active-chatters (girişsiz, 60 sn
// önbellek). WebSocket'e bağlı değil, ilk dakikadan itibaren skor verir.
// Dakikada en fazla KICK_CHATTERS_PER_MIN kanal (sırayla), kanal başına 60 sn.
const KICK_CHATTERS_PER_MIN = 12;
const KICK_CHATTERS_MAX_AGE = 5 * 60 * 1000;
const _kickChatters = new Map(); // slug -> { count, at }
async function refreshKickActiveChatters(liveChannels) {
  let idCache = {};
  try { idCache = await Storage.getChannelIdCache(); } catch (e) { return; }
  const now = Date.now();
  const due = liveChannels
    .filter(ch => ch.viewerCount > 0 && idCache[ch.channelSlug] > 0)
    .map(ch => ({ slug: ch.channelSlug, id: idCache[ch.channelSlug], at: (_kickChatters.get(ch.channelSlug) || {}).at || 0 }))
    .filter(x => now - x.at >= 60 * 1000)
    .sort((a, b) => a.at - b.at)
    .slice(0, KICK_CHATTERS_PER_MIN);
  for (const x of due) {
    const j = await KickAPI.fetchWebPublic(`https://web.kick.com/api/v1/channels/${x.id}/chat/active-chatters`);
    if (!j) break; // uç kapalıysa (10 dk) diğerlerini deneme
    const n = Number(j && j.data && j.data.total_count);
    if (Number.isFinite(n) && n >= 0) _kickChatters.set(x.slug, { count: n, at: Date.now() });
  }
  const live = new Set(liveChannels.map(c => c.channelSlug));
  for (const k of [..._kickChatters.keys()]) if (!live.has(k)) _kickChatters.delete(k);
}
function kickChattersPayload() {
  const out = {}; const now = Date.now();
  for (const [slug, v] of _kickChatters) if (now - v.at <= KICK_CHATTERS_MAX_AGE) out[slug] = v.count;
  return out;
}

async function recomputeBotScores(liveChannels) {
  if (!BotTrackerHost.isSupported) {
    dbg('[KickAlert][BotScore] BotTracker desteklenmiyor (Firefox script eksik?), çıkıyor');
    return;
  }
  const now = Date.now();
  const elapsed = now - _lastBotScoreCompute;
  if (elapsed < _BOT_SCORE_INTERVAL_MS) {
    KLog.debug('BSC-02', `Throttle: ${Math.round(elapsed/1000)}s geçti, ${_BOT_SCORE_INTERVAL_MS/1000}s gerekiyor - atlanıyor`);
    return;
  }
  _lastBotScoreCompute = now;
  KLog.debug('BSC-03', `recomputeBotScores başladı - ${liveChannels.length} canlı kanal (${BotTrackerHost.isLocal ? 'local/firefox' : 'offscreen/chrome'})`);

  // viewerMap: { slug: viewerCount }
  const viewerMap = {};
  const liveSlugs = new Set();
  for (const ch of liveChannels) {
    if (ch.viewerCount > 0) viewerMap[ch.channelSlug] = ch.viewerCount;
    liveSlugs.add(ch.channelSlug);
  }
  KLog.debug('BSC-04', `viewerMap oluşturuldu: ${Object.keys(viewerMap).length} kanal`);

  // BotTracker'dan skorları iste (chrome → offscreen, firefox → local)
  let scores = null;
  try {
    try { await refreshKickActiveChatters(liveChannels); } catch (e) {}
    const res = await BotTrackerHost.computeScores(viewerMap, kickChattersPayload());
    KLog.debug('BSC-05', `BotTracker yanıtı: success=${res?.success}, scoreCount=${Object.keys(res?.scores || {}).length}`);
    if (res?.success) scores = res.scores;
  } catch (e) {
    console.warn('[KickAlert] BotTracker compute error:', e.message);
    return;
  }
  if (!scores) {
    dbg('[KickAlert][BotScore] No scores returned, skipping storage write');
    return;
  }

  // Storage'a yaz - sadece anlamlı (insufficient olmayan) skorları
  let written = 0, skipped = 0;
  for (const [slug, data] of Object.entries(scores)) {
    if (data.insufficient || data.score === null) {
      skipped++;
      continue;
    }
    try {
      await Storage.setBotScore(slug, {
        score: data.score,
        ratio: data.ratio,
        msgPerMin: data.msgPerMin,
        activeChatters: data.activeChatters,
        expected: data.expected,
        source: data.source || 'ws',
        kickChatters: data.kickChatters ?? null,
        computedAt: now,
      });
      written++;
    } catch (e) {
      console.warn(`[KickAlert] setBotScore failed for ${slug}:`, e.message);
    }
  }
  KLog.debug('BSC-06', `Storage: ${written} yazıldı, ${skipped} atlandı (insufficient)`);

  // Cleanup: canlıdan çıkan kanalların skorunu sil
  try {
    const allScores = await Storage.getBotScores();
    let cleaned = 0;
    for (const slug of Object.keys(allScores)) {
      if (!liveSlugs.has(slug)) {
        await Storage.removeBotScore(slug);
        cleaned++;
      }
    }
    if (cleaned > 0) dbg(`[KickAlert][BotScore] Cleanup: ${cleaned} eski skor silindi`);
  } catch (e) {
    console.warn('[KickAlert] Cleanup error:', e.message);
  }
}

// ─── Dynamic Tooltip ───

async function updateDynamicTooltip(channels) {
  // v2.5.109: Chrome artık simgenin üzerine gelince kendi bilgi kartını gösteriyor
  // (eklenti adı + bu metnin ilk birkaç satırı + site erişimi). Kartta ad zaten
  // yazdığı için Chrome'da "KickAlert" öneki ve boş satır kaldırıldı; kanallar
  // virgülle tek paragrafta, böylece kartın gösterdiği ilk satırlar kanal adlarıyla
  // dolar. Tam liste, kartın metninin üzerine gelince açılan ipucunda görünür.
  // Firefox kendi ipucunu tam gösterdiği için alt alta liste olarak kalır.
  const liveChannels = channels.filter(c => c.isLive);
  const noLive = (Utils.i18n('tooltipNoLive') || 'KickAlert - No live streams').replace(/\u2014/g, '-');
  let tooltip;
  if (liveChannels.length === 0) {
    tooltip = IS_FIREFOX ? noLive : (noLive.replace(/^KickAlert\s*[-\u2013\u2014:]\s*/, '') || noLive);
  } else {
    const count = Utils.i18n('tooltipLiveCount', [String(liveChannels.length)])
      || `${liveChannels.length} live`;
    const names = liveChannels.slice(0, 10).map(c => c.userUsername || c.channelSlug);
    const more = liveChannels.length > 10
      ? (Utils.i18n('tooltipMore', [String(liveChannels.length - 10)]) || `+${liveChannels.length - 10} more`)
      : '';
    if (IS_FIREFOX) {
      const lines = names.map(n => `\u2022 ${n}`);
      if (more) lines.push(more);
      tooltip = `KickAlert - ${count}\n\n${lines.join('\n')}`;
    } else {
      tooltip = `${count}: ${names.join(', ')}${more ? ' ' + more : ''}`;
    }
  }
  try { await chrome.action.setTitle({ title: tooltip }); } catch {}
}

// ─── Notification ───
// BUG 13 FIX: No longer writes to history (handled in checkChannels)
// Windows notification sound fix: silent: true - our own sound plays via offscreen

async function sendNotification(ch, notifiedLives, isSilent) {
  await Utils.ensureI18n();
  const id = `kickalert-${ch.channelSlug}-${Date.now()}`;
  const title = Utils.i18n('notifStartedStreaming', [ch.userUsername])
    || `${ch.userUsername} started streaming`;
  const iconUrl = await getAvatarDataUrl(ch);

  const isFirefox = IS_FIREFOX;
  const notifOptions = {
    type: 'basic',
    iconUrl: iconUrl,
    title: title,
    message: ch.sessionTitle || '-',
  };

  // Firefox doesn't support buttons or silent in notifications.create
  if (!isFirefox) {
    const btnOpen = Utils.i18n('notifButtonOpen') || 'Open';
    const btnMute = Utils.i18n('notifButtonSnooze') || 'Mute for 1 hour'; // v2.5.98
    notifOptions.silent = isSilent;
    notifOptions.buttons = [
      { title: btnOpen },
      { title: btnMute },
    ];
  }

  chrome.notifications.create(id, notifOptions);
  notifiedLives[id] = { url: `https://kick.com/${ch.channelSlug}`, slug: ch.channelSlug };
}

// ─── v2.5.97: "Bildirim neden gelmedi?" teşhisi ───
// Canlı bildirim akışındaki (handlePusherLiveEvent / checkChannels) her
// engeli bu kanal için tek tek kontrol eder. level: 'block' bildirim gelmez,
// 'warn' gelir ama eksik/gecikmeli, 'info' bilgi, 'ok' sorun yok.
// Metinler popup'ta i18n anahtarıyla (key) ve parametrelerle (p) kurulur.
async function diagChannelNotif(slug) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug)) return { success: false, error: 'slug' };
  const items = [];
  const add = (level, key, p) => items.push({ level, key, p: p || [] });
  const ch = (cachedChannels || []).find(c => c.channelSlug === slug) || null;
  // Genel bildirim anahtarı ve tarayıcı izni
  const showNotif = await Storage.getShowNotification();
  if (showNotif === false) add('block', 'diagNotifOff');
  try {
    if (chrome.notifications.getPermissionLevel) {
      const lvl = await new Promise(r => chrome.notifications.getPermissionLevel(r));
      if (lvl === 'denied') add('block', 'diagPermDenied');
    }
  } catch (e) {}
  try { if (!(await chrome.permissions.contains({ origins: ['https://kick.com/*'] }))) add('block', 'diagNoKickPerm'); } catch (e) {}
  // Kanal modu
  const mi = await Storage.getChannelSoundModeInfo(slug);
  if (mi.mode === 'muted') add('block', mi.explicit ? 'diagChMuted' : 'diagChMutedDefault');
  else if (mi.mode === 'silent') add('warn', 'diagChSilent');
  // v2.5.98: duraklatma ve kanal susturma
  {
    const sup = await alertSuppressedFor(slug);
    const pz = await getNotifPause();
    if (sup === 'snooze') {
      const sn = (await chrome.storage.local.get(SNOOZE_KEY))[SNOOZE_KEY] || {};
      add('block', 'diagSnoozed', [String(sn[slug] || 0)]);
    } else if (sup === 'pause' && pz) add('block', 'diagPaused', [String(pz.until)]);
    else if (pz && pz.favs) add('info', 'diagPausedFavExempt', [String(pz.until)]);
  }
  // Sessiz saatler
  if (await Storage.getDndEnabled()) {
    const st = await Storage.getDndStart(), en = await Storage.getDndEnd();
    const muteN = await Storage.getDndMuteNotif();
    if (await Storage.isDndActive()) { if (muteN) add('block', 'diagDndNow', [st, en]); else add('info', 'diagDndSchedule', [st, en]); }
    else if (muteN) add('info', 'diagDndSchedule', [st, en]);
  }
  // Kanal filtresi
  const pref = await Storage.getChannelAlertPref(slug);
  const cats = pref.cats || [], words = pref.words || [];
  if (cats.length || words.length) {
    const desc = [cats.length ? cats.join(', ') : '', words.length ? words.map(w => '"' + w + '"').join(', ') : ''].filter(Boolean).join(' · ');
    if (ch && ch.isLive) {
      const f = matchChannelFilter(pref, ch.categoryName, ch.sessionTitle);
      if (!f.pass) add('block', 'diagFilterBlocksNow', [desc]);
      else add('info', 'diagFilterSet', [desc]);
    } else add('info', 'diagFilterSet', [desc]);
  }
  // Anlık bağlantı: kanal kimliği biliniyor mu ve bağlantı açık mı
  let rtOk = null;
  try {
    let st = null;
    if (chrome.offscreen) {
      if (await chrome.offscreen.hasDocument()) st = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'LIVE_GET_STATE' }))?.state || null;
    } else if (typeof Pusher !== 'undefined' && Pusher.getState) st = Pusher.getState();
    // Bağlı değil ama izlenecek kanal da yoksa (henüz kurulmamış) "kopuk" sayma
    if (st) rtOk = st.connected ? true : ((st.trackedCount || st.subscribedCount || st.pendingCount) ? false : null);
  } catch (e) {}
  let idKnown = false;
  try { idKnown = (await Storage.getChannelIdCache())[slug] > 0; } catch (e) {}
  if (rtOk === false) add('warn', 'diagRealtimeOff');
  else if (!idKnown) add('warn', 'diagNoRealtimeChannel');
  // Kick istek yavaşlatması
  try {
    await KickAPI._loadBackoffFromStorage();
    if (Date.now() < KickAPI._lastBackoffUntil) add('warn', 'diagBackoff', [String(Math.ceil((KickAPI._lastBackoffUntil - Date.now()) / 60000))]);
  } catch (e) {}
  // Son yayın kaydı (geçmiş)
  try {
    const hist = (await Storage.getNotificationHistory()) || [];
    const last = hist.find(h => h && h.channelSlug === slug && !h.kind);
    if (!last) add('info', 'diagLastNone');
    else {
      const at = new Date(last.timestamp).getTime();
      if (last.filtered) add('info', 'diagLastFiltered', [String(at), last.filtered === 'category' ? 'category' : 'keyword']);
      else add('info', 'diagLastSeen', [String(at)]);
    }
  } catch (e) {}
  const blocked = items.some(i => i.level === 'block');
  return { success: true, slug, blocked, live: !!(ch && ch.isLive), items };
}

// ─── v2.5.50: Kanal bazlı kategori / anahtar kelime filtresi ───
// Kategori listesi doluysa kanal bu kategorilerden birinde olmalı (parça
// eşleşmesi: "Counter" → "Counter-Strike 2"). Kelime listesi doluysa başlıkta
// kelimelerden biri geçmeli. İkisi de doluysa ikisi de sağlanmalı.
// Kategori bilinmiyorsa (veri gelmediyse) bildirim engellenmez.
function matchChannelFilter(pref, category, title) {
  const cats = (pref && pref.cats) || [];
  const words = (pref && pref.words) || [];
  if (!cats.length && !words.length) return { pass: true };
  // Büyük/küçük harf ve aksan duyarsız: "İSTANBUL" ≈ "istanbul", "ı" ≈ "i", "é" ≈ "e"
  const lc = (x) => String(x || '').toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i');
  const c = lc(category), t = lc(title);
  if (cats.length && c && !cats.some(x => c.includes(lc(x)))) return { pass: false, reason: 'category' };
  if (words.length && !words.some(w => t.includes(lc(w)))) return { pass: false, reason: 'keyword' };
  return { pass: true, unknownCategory: cats.length > 0 && !c };
}

// ─── v2.5.49: Kategori / başlık değişim bildirimi ───
// StreamPulse'un korumaları uyarlandı:
//  - sadece taze API verisi (403 sonrası yedek veri değil),
//  - aynı yayın oturumu (startedAt aynı), kanal hâlâ yayında,
//  - eski ve yeni değer ikisi de dolu,
//  - son gözlem çok eskiyse (SW uzun uyuduysa) karşılaştırma yapılmaz,
//  - kanal başına 5 dk'da en fazla bir değişim bildirimi.
const CHANGE_META_KEY = '_channelMeta';
// v2.5.58: 15 dk → 60 dk. Cloudflare 403 sonrası birkaç kontrol boyunca taze
// veri gelmezse değişim sessizce atlanıyordu. Aynı oturum (startedAt) kontrolü
// zaten eski yayınla karıştırmayı engelliyor.
const CHANGE_MAX_GAP_MS = 60 * 60 * 1000;
// v2.5.58: Yayından düşen kanalın son bilgisi (başlangıç, başlık, kategori)
// bu süre boyunca saklanır; "yayın bitti" bildirimi süreyi ve başlığı buradan alır.
const CHANGE_META_KEEP_OFFLINE_MS = 3 * 60 * 60 * 1000;
const CHANGE_COOLDOWN_MS = 5 * 60 * 1000;
// v2.5.77: yeni kategori/başlık art arda bu kadar kontrolde görülmeden bildirilmez
const CHANGE_CONFIRM_POLLS = 2;
// v2.5.77: İki okuma arasında en az bu kadar süre olmalı (popup açılışı gibi
// art arda gelen yenilemeler aynı tutarsız yanıtı iki kez sayamasın)
const CHANGE_CONFIRM_MIN_MS = 20 * 1000;

function _sameSession(a, b) {
  if (!a || !b) return false;
  const ta = new Date(a).getTime(), tb = new Date(b).getTime();
  if (!isFinite(ta) || !isFinite(tb)) return a === b;
  return Math.abs(ta - tb) < 90 * 1000;
}

async function checkChannelMetaChanges(channels, notifiedLives, ctx) {
  if (ctx.isStale) return; // yedek veride başlık/kategori güvenilmez
  const prefs = await Storage.getChannelAlertPrefs();
  const stored = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {};
  const now = Date.now();
  const next = {};
  for (const ch of channels) {
    // v2.5.60: startedAt şartı kaldırıldı. Takip listesi uç noktası (followed)
    // canlı kanallarda start_time döndürmüyor; bu yüzden hiçbir kanal kaydedilmiyor,
    // değişim bildirimi hiç gitmiyor, "yayın bitti" süresiz geliyordu.
    if (!ch.isLive) continue;
    const slug = ch.channelSlug;
    const prev = stored[slug];
    const prevOn = !!(prev && !prev.off);
    const cur = { t: (ch.sessionTitle || '').trim(), c: (ch.categoryName || '').trim(), s: ch.startedAt || null, at: now };
    // Aynı oturum: iki tarafta da başlangıç varsa onunla; yoksa kanal kesintisiz
    // canlı görülüyorsa (önceki kayıt kapalı değil ve çok eski değil) aynı yayın.
    let same;
    if (!prevOn) same = false;
    else if (prev.s && cur.s) same = _sameSession(prev.s, cur.s);
    else same = now - (prev.at || 0) <= CHANGE_MAX_GAP_MS;
    if (same && !cur.s && prev.s) cur.s = prev.s;
    cur.f = same && prev.f ? prev.f : now; // bu oturumda ilk görülme
    const pref = prefs[slug] || {};
    if (!cur.s && (pref.change || pref.end)) {
      // Yayın süresi için başlangıcı bir kez tamamla (başarısızlıkta 30 dk negatif cache)
      try { cur.s = await KickAPI.getChannelStartTime(slug); } catch { cur.s = null; }
      if (cur.s) KLog.debug('CHG-03', `${slug} başlangıç API'den tamamlandı: ${cur.s}`);
      else KLog.debug('CHG-04', `${slug} başlangıç bilinmiyor, kesintisiz canlı gözlemle takip`);
    }
    cur.n = same ? (prev.n || 0) : 0; // son bildirim zamanı
    // v2.5.77: kullanıcıya en son bildirilen (ya da oturumun ilk) kategori/başlık
    // ve doğrulama bekleyen aday. Karşılaştırma artık son GÖZLEMLE değil,
    // kullanıcının BİLDİĞİ değerle yapılıyor; böylece bekleme süresinde yutulan
    // değişim kaybolmuyor, tek seferlik tutarsız API okuması bildirim üretmiyor.
    if (same && prevOn) {
      cur.nc = prev.nc !== undefined ? prev.nc : prev.c; // eski kayıtlardan geçiş
      cur.nt = prev.nt !== undefined ? prev.nt : prev.t;
      cur.pc = prev.pc || ''; cur.pcn = prev.pcn || 0; cur.pca = prev.pca || 0;
      cur.pt = prev.pt || ''; cur.ptn = prev.ptn || 0; cur.pta = prev.pta || 0;
    } else {
      cur.nc = cur.c; cur.nt = cur.t; cur.pc = ''; cur.pcn = 0; cur.pca = 0; cur.pt = ''; cur.ptn = 0; cur.pta = 0;
    }
    next[slug] = cur;
    // Takip kapalıyken, ilk gözlemde, yeni oturumda veya uzun boşlukta referans
    // güncel değere çekilir; takip sonradan açılınca eski değerle kıyas yapılmaz.
    const absorb = () => { cur.nc = cur.c; cur.nt = cur.t; cur.pc = ''; cur.pcn = 0; cur.pca = 0; cur.pt = ''; cur.ptn = 0; cur.pta = 0; };
    if (!pref.change) { absorb(); continue; }
    if (!prevOn) { KLog.debug('CHG-05', `${slug} ilk gözlem: kategori="${cur.c}" başlık="${cur.t.slice(0, 60)}"`); continue; }
    if (!same) { KLog.debug('CHG-06', `${slug} yeni yayın oturumu, karşılaştırma yok`); continue; }
    if (now - (prev.at || 0) > CHANGE_MAX_GAP_MS) { KLog.info('CHG-07', `${ch.channelSlug} son taze gözlem ${Math.round((now - prev.at) / 60000)} dk önce, karşılaştırma atlandı`); absorb(); continue; }
    // v2.5.77: Aday doğrulama. Yeni değer art arda CHANGE_CONFIRM_POLLS kez
    // görülmeden bildirilmez (Kick'in takip listesi uç noktası zaman zaman bir
    // önceki kategoriyi tek seferlik geri döndürebiliyor). Değer bildirilen
    // değere geri dönerse aday silinir, bildirim gitmez.
    const track = (val, base, pKey, nKey, aKey) => {
      if (!val || !base || val === base) { cur[pKey] = ''; cur[nKey] = 0; cur[aKey] = 0; return false; }
      if (cur[pKey] === val) cur[nKey] = (cur[nKey] || 0) + 1; else { cur[pKey] = val; cur[nKey] = 1; cur[aKey] = now; }
      return cur[nKey] >= CHANGE_CONFIRM_POLLS && now - (cur[aKey] || 0) >= CHANGE_CONFIRM_MIN_MS;
    };
    const catReady = track(cur.c, cur.nc, 'pc', 'pcn', 'pca');
    const titleReady = track(cur.t, cur.nt, 'pt', 'ptn', 'pta');
    KLog.debug('CHG-08', `${ch.channelSlug} kontrol: bildirilen "${cur.nc}" · önceki "${prev.c}" · şimdi "${cur.c}"${cur.pcn ? ` (aday ${cur.pcn}/${CHANGE_CONFIRM_POLLS})` : ''} · başlık ${cur.ptn ? `aday ${cur.ptn}/${CHANGE_CONFIRM_POLLS}` : 'aynı'}`);
    if (!catReady && !titleReady) continue;
    if (now - (cur.n || 0) < CHANGE_COOLDOWN_MS) {
      KLog.debug('CHG-10', `${ch.channelSlug} değişim doğrulandı ama bekleme süresinde, süre dolunca bildirilecek`);
      continue;
    }
    const catChanged = catReady;
    const titleChanged = !catReady && titleReady;
    // v2.5.74: kanal olayları kanal bazlı açıkça açılır; sadece kanal zilinden seçilen 'Bildirim yok' susturur
    const soundInfo = await Storage.getChannelSoundModeInfo(ch.channelSlug);
    if ((soundInfo.mode === 'muted' && soundInfo.explicit) || !ctx.showNotif || ctx.dndMuteNotif) {
      // Kullanıcı bu anda bildirim istemiyor: değişim yutulur, sonradan eski haber olarak gelmez
      absorb(); continue;
    }
    await Utils.ensureI18n();
    const title = catChanged
      ? (Utils.i18n('notifCategoryChanged', [ch.userUsername]) || `${ch.userUsername} switched category`)
      : (Utils.i18n('notifTitleChanged', [ch.userUsername]) || `${ch.userUsername} changed the stream title`);
    const message = catChanged ? `${cur.nc} → ${cur.c}` : cur.t;
    await sendChannelEventNotification(ch, title, message, notifiedLives, null, 'change');
    cur.n = now;
    // Bildirilen değerler kullanıcının artık bildiği değerler olur
    // (kategori bildirimi başlığı da kapsar; eskisi gibi ayrıca başlık bildirimi gitmez)
    if (catChanged) absorb();
    else { cur.nt = cur.t; cur.pt = ''; cur.ptn = 0; cur.pta = 0; }
    KLog.info('CHG-20', `${ch.channelSlug} → ${catChanged ? 'kategori' : 'başlık'} değişim bildirimi gönderildi`);
  }
  // v2.5.58: Canlı olmayan kanalların son kaydını hemen silme (bkz. CHANGE_META_KEEP_OFFLINE_MS).
  // Önceden burada silindiği için aynı döngüde çalışan "yayın bitti" kontrolü
  // başlangıç saatini ve başlığı bulamıyor, bildirim süresiz ve "-" gidiyordu.
  for (const [slug, prev] of Object.entries(stored)) {
    if (next[slug]) continue;
    if (now - (prev.at || 0) < CHANGE_META_KEEP_OFFLINE_MS) next[slug] = { ...prev, off: true };
  }
  try { await chrome.storage.local.set({ [CHANGE_META_KEY]: next }); } catch {}
}

// ─── v2.5.53: Yayın bitti bildirimi ───
// Geçmişte yayın bitişini anlamak zordu (Pusher bitiş olayı kaçabiliyor,
// Cloudflare 403 sonrası yedek veri kanalı yanlışlıkla kapalı gösterebiliyor,
// yayıncı kopup hemen geri dönebiliyor). Bu yüzden iki aşamalı:
//  1) Aday: Pusher StopStreamBroadcast VEYA taze API'de kanal kapalı.
//  2) Doğrulama: aday oluştuktan en az END_CONFIRM_MS sonra taze (yedek
//     olmayan) API hâlâ kapalı diyor ve Pusher yeniden canlı demiyorsa bildir.
//  Kanal bu arada geri gelirse aday silinir. Yedek veri hiçbir aşamada
//  bitiş sayılmaz. END_PENDING_MAX_MS içinde doğrulanamayan aday düşer.
//  Tarayıcı başlangıcında canlı listesi sıfırlandığı için geriye dönük
//  "bitti" bildirimi oluşmaz.
const END_PENDING_KEY = '_endPending';
const END_CONFIRM_MS = 150 * 1000;
const END_PENDING_MAX_MS = 30 * 60 * 1000;

function formatStreamLength(ms) {
  if (!ms || ms < 60000) return '';
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function addStreamEndCandidate(slug, source) {
  const pref = await Storage.getChannelAlertPref(slug);
  if (!pref.end) return;
  const store = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
  if (store[slug]) return; // zaten aday
  const ch = (cachedChannels || []).find(c => c.channelSlug === slug) || {};
  const meta = ((await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {})[slug] || {};
  store[slug] = {
    since: Date.now(),
    source,
    startedAt: ch.startedAt || meta.s || null,
    title: ch.sessionTitle || meta.t || '',
    category: ch.categoryName || meta.c || '',
    username: ch.userUsername || slug,
    profilePic: ch.profilePic || '',
  };
  await chrome.storage.local.set({ [END_PENDING_KEY]: store });
  KLog.info('END-10', `${slug} → yayın bitti ADAYI (${source}), doğrulama bekleniyor`);
}

async function processStreamEndCandidates(channels, nowLive, notifiedLives, ctx) {
  const store = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
  const slugs = Object.keys(store);
  if (!slugs.length) return;
  const now = Date.now();
  let changed = false;
  for (const slug of slugs) {
    const c = store[slug];
    if (nowLive.has(slug)) { delete store[slug]; changed = true; KLog.info('END-11', `${slug} → geri döndü, aday iptal`); continue; }
    if (now - c.since > END_PENDING_MAX_MS) { delete store[slug]; changed = true; KLog.info('END-12', `${slug} → doğrulanamadı, aday düştü`); continue; }
    if (ctx.isStale || now - c.since < END_CONFIRM_MS) continue;
    const pref = await Storage.getChannelAlertPref(slug);
    delete store[slug]; changed = true;
    if (!pref.end) continue;
    const ch = channels.find(x => x.channelSlug === slug) || {};
    const lengthMs = c.startedAt ? (c.since - new Date(c.startedAt).getTime()) : 0;
    const lengthText = formatStreamLength(lengthMs);
    Storage.addNotificationHistory({
      kind: 'end',
      username: ch.userUsername || c.username || slug,
      channelSlug: slug,
      profilePic: ch.profilePic || c.profilePic || '',
      title: c.title || '-',
      category: c.category || '-',
      timestamp: new Date().toISOString(),
      ...(lengthText ? { length: lengthText } : {}),
    });
    // v2.5.74: bkz. checkChannelMetaChanges, sadece açık 'Bildirim yok' susturur
    const soundInfo = await Storage.getChannelSoundModeInfo(slug);
    if ((soundInfo.mode === 'muted' && soundInfo.explicit) || !ctx.showNotif || ctx.dndMuteNotif) continue;
    await Utils.ensureI18n();
    const name = ch.userUsername || c.username || slug;
    const title = Utils.i18n('notifStreamEnded', [name]) || `${name} ended the stream`;
    const message = lengthText
      ? (Utils.i18n('notifStreamEndedLength', [lengthText]) || `Streamed for ${lengthText}`) + (c.title ? ` · ${c.title}` : '')
      : (c.title || c.category || 'Kick.com');
    await sendChannelEventNotification({ ...ch, channelSlug: slug, userUsername: name, profilePic: ch.profilePic || c.profilePic || '' },
      title, message, notifiedLives, null, 'end');
    KLog.info('END-20', `${slug} → yayın bitti bildirimi gönderildi (${lengthText || 'süre bilinmiyor'})`);
  }
  if (changed) await chrome.storage.local.set({ [END_PENDING_KEY]: store });
}

// ─── v2.5.55: İzleme süresi ───
// _watchTime = { days: { 'YYYY-MM-DD': { slug: saniye } } } - sadece bu cihaz.
// Aynı kanal iki sekmede oynuyorsa çift sayılmasın diye kanal başına 20 sn
// içinde gelen ikinci tik yok sayılır. 35 günden eski günler silinir.
const WATCH_KEY = '_watchTime';
const WATCH_KEEP_DAYS = 35;
const _watchLastTick = new Map();
let _watchChain = Promise.resolve();

function localDayKey(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addWatchTime(slug, sec) {
  if (typeof slug !== 'string' || !/^[a-z0-9_-]{2,40}$/.test(slug)) return;
  const add = Math.min(Math.max(Number(sec) || 0, 0), 60);
  if (!add) return;
  const now = Date.now();
  if (now - (_watchLastTick.get(slug) || 0) < 20000) return;
  _watchLastTick.set(slug, now);
  _watchChain = _watchChain.then(async () => {
    const data = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY] || { days: {} };
    const days = data.days || (data.days = {});
    const key = localDayKey();
    days[key] = days[key] || {};
    days[key][slug] = (days[key][slug] || 0) + add;
    const cutoff = localDayKey(new Date(now - WATCH_KEEP_DAYS * 86400000));
    for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
    await chrome.storage.local.set({ [WATCH_KEY]: data });
  }).catch(() => {});
}

// ─── v2.5.54: Raid bildirimi ───
// Kaynak: BotTracker'ın chatroom bağlantısında gelen StreamHostEvent /
// StreamHostedEvent. İki olay aynı raid için gelebilir; kanal başına
// RAID_DEDUP_MS içinde tek bildirim (StreamPulse'un tekrar önleme penceresi).
const RAID_SEEN_KEY = '_raidSeen';
const RAID_DEDUP_MS = 10 * 60 * 1000;

// v2.5.58: Kick aynı raid için iki olay gönderiyor ve biri izleyici sayısını
// içermeyebiliyor (kullanıcı ekranı: "? izleyiciyle"). İlk olaydan sonra
// RAID_MERGE_MS beklenip iki olayın bilgisi birleştiriliyor.
const RAID_MERGE_MS = 4000;
const _raidBuffer = new Map();
function handleRaidEvent(d) {
  const slug = d && d.slug;
  if (!slug) return Promise.resolve();
  const b = _raidBuffer.get(slug);
  if (b) {
    if (!b.d.raider && d.raider) b.d.raider = d.raider;
    if (b.d.viewers == null && d.viewers != null) b.d.viewers = d.viewers;
    if (!b.d.message && d.message) b.d.message = d.message;
    return b.p;
  }
  const entry = { d: { ...d } };
  entry.p = new Promise(res => setTimeout(() => {
    _raidBuffer.delete(slug);
    processRaidEvent(entry.d).catch(e => KLog.warn('RAID-99', 'Raid işleme hatası', e)).finally(res);
  }, RAID_MERGE_MS));
  _raidBuffer.set(slug, entry);
  return entry.p;
}

async function processRaidEvent(d) {
  const slug = d && d.slug;
  if (!slug) return;
  const pref = await Storage.getChannelAlertPref(slug);
  if (!pref.raid) return;
  if (!d.raider && d.viewers == null) { KLog.warn('RAID-02', `${slug} raid olayı tanınmayan biçimde geldi, bildirim atlandı`); return; }
  const now = Date.now();
  const seen = (await chrome.storage.local.get(RAID_SEEN_KEY))[RAID_SEEN_KEY] || {};
  if (now - (seen[slug] || 0) < RAID_DEDUP_MS) { KLog.debug('RAID-03', `${slug} raid zaten bildirildi (10 dk)`); return; }
  seen[slug] = now;
  for (const k of Object.keys(seen)) if (now - seen[k] > RAID_DEDUP_MS) delete seen[k];
  await chrome.storage.local.set({ [RAID_SEEN_KEY]: seen });

  const ch = (cachedChannels || []).find(c => c.channelSlug === slug) || { channelSlug: slug, userUsername: slug, profilePic: '' };
  const raider = d.raider || '?';
  const viewers = d.viewers == null ? '?' : String(d.viewers);
  Storage.addNotificationHistory({
    kind: 'raid',
    username: ch.userUsername || slug,
    channelSlug: slug,
    profilePic: ch.profilePic || '',
    title: ch.sessionTitle || '-',
    category: ch.categoryName || '-',
    timestamp: new Date().toISOString(),
    raider, viewers: d.viewers == null ? null : d.viewers,
  });

  const showNotif = await Storage.getShowNotification();
  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  // v2.5.74: sadece kanal zilinden açıkça seçilen 'Bildirim yok' raid bildirimini susturur
  const soundInfo = await Storage.getChannelSoundModeInfo(slug);
  if (!showNotif || dndMuteNotif || (soundInfo.mode === 'muted' && soundInfo.explicit)) return;
  const soundMode = await Storage.getSoundMode();
  await Utils.ensureI18n();
  const name = ch.userUsername || slug;
  const title = Utils.i18n('notifRaidTitle', [raider, name]) || `${raider} raided ${name}`;
  let message = Utils.i18n('notifRaidViewers', [viewers]) || `with ${viewers} viewers`;
  if (d.message) message += ` · ${String(d.message).slice(0, 120)}`;
  const state = await getPersistedState();
  await sendChannelEventNotification(ch, title, message, state.notifiedLives, null, 'raid');
  await setPersistedNotifiedLives(state.notifiedLives);
  KLog.info('RAID-10', `${slug} ← ${raider} raid (${viewers} izleyici) bildirimi gönderildi`);
}

// ─── v2.5.103: arka plan sohbet radarı ───
// Seçilen en fazla 5 kanalın sohbeti (kanal canlıyken, Kick sekmesi kapalı olsa
// da) BotTracker bağlantısından okunur. Kullanıcı adın (Etiket bildirimi alanı)
// ya da radar kelimelerinden biri geçince bildirim gelir. O kanalın sekmesi
// açıksa radar susar (sekmedeki sohbet entegrasyonu zaten bildiriyor).
const RADAR_THROTTLE_MS = 60 * 1000;
const _radarLast = new Map();
async function getChatRadarConfig() {
  try {
    if (!(await Storage.getChatIntegrationEnabled())) return null;
    const s = await Storage.getChatSettings();
    if (!s.radarEnabled) return null;
    const slugs = (s.radarChannels || []).map(x => String(x).trim().toLowerCase()).filter(x => /^[a-z0-9_-]{1,64}$/.test(x)).slice(0, 5);
    const words = (s.radarWords || []).map(x => String(x).trim()).filter(Boolean).slice(0, 50);
    const me = String(s.tagUsername || '').trim().replace(/^@/, '');
    if (!slugs.length || (!me && !words.length)) return null;
    return { slugs, words, me };
  } catch (e) { return null; }
}
async function radarChannelTabOpen(slug) {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://kick.com/*', 'https://www.kick.com/*'] });
    return tabs.some(t => kaSlugFromUrl(t.url || t.pendingUrl || '') === slug);
  } catch (e) { return false; }
}
async function handleRadarHit(d) {
  const slug = String(d && d.slug || '').toLowerCase();
  const kind = d && d.kind;
  if (!slug || !['mention', 'reply', 'keyword'].includes(kind)) return;
  const cfg = await getChatRadarConfig();
  if (!cfg || !cfg.slugs.includes(slug)) { KLog.debug('RDR-02', `${slug} → radar kapalı ya da kanal listede değil`); return; }
  if (await radarChannelTabOpen(slug)) { KLog.debug('RDR-03', `${slug} → kanal sekmesi açık, radar bildirimi atlandı`); return; }
  const sup = await alertSuppressedFor(slug);
  if (sup) { KLog.debug('PAU-14', `${slug} → radar bildirimi atlandı (${sup})`); return; }
  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const dndMuteSound = dndActive && await Storage.getDndMuteSound();
  if (dndMuteNotif && dndMuteSound) { KLog.debug('RDR-04', `${slug} → rahatsız etme, radar bildirimi atlandı`); return; }
  const tkey = slug + ':' + (kind === 'keyword' ? 'kw' : 'me');
  const now = Date.now();
  if (now - (_radarLast.get(tkey) || 0) < RADAR_THROTTLE_MS) { KLog.debug('RDR-05', `${slug} → radar 1 dk sınırı (${kind})`); return; }
  _radarLast.set(tkey, now);

  await Utils.ensureI18n();
  const ch = (cachedChannels || []).find(c => String(c.channelSlug).toLowerCase() === slug) || { channelSlug: slug, userUsername: slug };
  const chName = ch.userUsername || slug;
  const from = String(d.from || '').slice(0, 64) || 'Someone';
  const msgText = String(d.message || '').slice(0, 200);
  let title;
  if (kind === 'reply') title = Utils.i18n('chatReplyNotifTitle', [from]) || `${from} replied to you`;
  else if (kind === 'mention') title = Utils.i18n('chatTagNotifTitle', [from]) || `@${from} mentioned you`;
  else title = Utils.i18n('radarKeywordNotifTitle', [String(d.word || '').slice(0, 40), chName]) || `"${d.word}" in ${chName}'s chat`;
  const body = (kind === 'keyword' ? `${from}: ` : `[${chName}] `) + msgText;

  const chatS = await Storage.getChatSettings();
  const showPopup = chatS?.showPopupNotification !== false && !dndMuteNotif;
  const soundEnabled = chatS?.mentionSoundEnabled !== false && !dndMuteSound;
  const soundMode = await Storage.getSoundMode();
  const id = `kickalert-radar-${now}`;
  if (showPopup) {
    const opts = { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message: body.substring(0, 200) };
    if (!IS_FIREFOX) {
      opts.silent = !soundEnabled || soundMode === 'extension';
      opts.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
    }
    chrome.notifications.create(id, opts);
    const state = await getPersistedState();
    state.notifiedLives[id] = { url: `https://kick.com/${slug}`, slug, isTag: true };
    await setPersistedNotifiedLives(state.notifiedLives);
  }
  // Sekme kapalı olduğu için "akıllı mod"da da izlenmiyor sayılır: ses çalar
  if (soundEnabled) playSound('CHAT_MENTION');
  KLog.info('RDR-10', `${slug} → radar bildirimi (${kind}${kind === 'keyword' ? ': ' + d.word : ''}, ${from})`);
}
try { if (typeof BotTracker !== 'undefined' && BotTracker) BotTracker.onRadar = (d) => { handleRadarHit(d).catch(() => {}); }; } catch (e) {}
// Radar ayarı değişince hemen uygula (bir sonraki kontrolü beklemeden)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.chatSettings || changes.chatIntegrationEnabled)) return;
  const o = changes.chatSettings && changes.chatSettings.oldValue || {}, n = changes.chatSettings && changes.chatSettings.newValue || {};
  const radarKeys = ['radarEnabled', 'radarChannels', 'radarWords', 'tagUsername'];
  if (changes.chatSettings && !changes.chatIntegrationEnabled && !radarKeys.some(k => JSON.stringify(o[k]) !== JSON.stringify(n[k]))) return;
  clearTimeout(handleRadarHit._t);
  handleRadarHit._t = setTimeout(() => {
    if (cachedChannels && cachedChannels.length) syncBotTracker(cachedChannels).catch(() => {});
    else getChatRadarConfig().then(c => BotTrackerHost.setRadar(c)).catch(() => {});
  }, 800);
});

// ─── v2.5.100: raid / yayın taşıma yönlendirme koruması ───
// KickAlert'in otomatik açtığı sekmeler takip edilir. Takip edilen kanal yayını
// başka kanala taşıdığında (ChatMoveToSupportedChannelEvent, handleHostMoveEvent)
// Kick sekmeyi hedef kanala götürür. Ayar açıksa sekme kapatılır. Sadece olayla
// doğrulanan yönlendirmede kapatılır; kullanıcı sekmede başka kanala geçerse
// sekmeye dokunulmaz ve takip bırakılır. Elle açılan sekmeler hiç takip edilmez.
const AUTO_TABS_KEY = '_autoTabs';
const RAID_MOVES_KEY = '_raidMoves';
const RAID_GUARD_WINDOW_MS = 5 * 60 * 1000;
const RAID_GUARD_RECHECK_MS = 20 * 1000;
function kaSlugFromUrl(u) {
  try {
    const x = new URL(u);
    if (x.hostname !== 'kick.com' && x.hostname !== 'www.kick.com') return '';
    const seg = x.pathname.replace(/^\/+/, '').split('/')[0].toLowerCase();
    return /^[a-z0-9_-]{1,64}$/.test(seg) ? seg : '';
  } catch (e) { return ''; }
}
async function registerAutoTab(tabId, slug) {
  if (typeof tabId !== 'number' || !slug) return;
  try {
    const now = Date.now();
    const m = (await chrome.storage.local.get(AUTO_TABS_KEY))[AUTO_TABS_KEY] || {};
    for (const k of Object.keys(m)) if (now - (m[k].at || 0) > 12 * 3600e3) delete m[k];
    m[tabId] = { slug: String(slug).toLowerCase(), at: now };
    await chrome.storage.local.set({ [AUTO_TABS_KEY]: m });
    KLog.debug('RGD-01', `${slug} → otomatik sekme takibe alındı (tabId=${tabId})`);
  } catch (e) {}
}
async function forgetAutoTab(tabId) {
  try {
    const m = (await chrome.storage.local.get(AUTO_TABS_KEY))[AUTO_TABS_KEY] || {};
    if (!m[tabId]) return;
    delete m[tabId];
    await chrome.storage.local.set({ [AUTO_TABS_KEY]: m });
  } catch (e) {}
}
async function recordRaidMove(slug, target) {
  try {
    const now = Date.now();
    const m = (await chrome.storage.local.get(RAID_MOVES_KEY))[RAID_MOVES_KEY] || {};
    for (const k of Object.keys(m)) if (now - (m[k].at || 0) > RAID_GUARD_WINDOW_MS) delete m[k];
    m[String(slug).toLowerCase()] = { target: String(target).toLowerCase(), at: now };
    await chrome.storage.local.set({ [RAID_MOVES_KEY]: m });
  } catch (e) {}
  // Olay sekmenin yönlenmesinden sonra geldiyse: zaten hedefte duran takipli sekmeleri kontrol et
  try { await raidGuardSweep(); } catch (e) {}
}
// Takipli sekme, kaynağı yakın zamanda taşınan bir kanalın hedefinde mi?
async function raidGuardDecide(tabId, url) {
  const m = (await chrome.storage.local.get(AUTO_TABS_KEY))[AUTO_TABS_KEY] || {};
  const rec = m[tabId];
  if (!rec) return 'untracked';
  const now = kaSlugFromUrl(url);
  if (!now || now === rec.slug) return 'same';
  const moves = (await chrome.storage.local.get(RAID_MOVES_KEY))[RAID_MOVES_KEY] || {};
  const mv = moves[rec.slug];
  if (mv && mv.target === now && Date.now() - mv.at <= RAID_GUARD_WINDOW_MS) return 'raid';
  return 'other';
}
async function raidGuardClose(tabId, why) {
  const m = (await chrome.storage.local.get(AUTO_TABS_KEY))[AUTO_TABS_KEY] || {};
  const rec = m[tabId];
  await forgetAutoTab(tabId);
  try { await chrome.tabs.remove(tabId); KLog.info('RGD-10', `${rec ? rec.slug : '?'} → yayın taşındı, otomatik açılan sekme kapatıldı (${why}, tabId=${tabId})`); }
  catch (e) { KLog.debug('RGD-11', `sekme kapatılamadı (tabId=${tabId}): ${e.message}`); }
}
async function raidGuardSweep() {
  if (!(await Storage.getRaidGuardClose())) return;
  const m = (await chrome.storage.local.get(AUTO_TABS_KEY))[AUTO_TABS_KEY] || {};
  for (const id of Object.keys(m)) {
    const tabId = Number(id);
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { await forgetAutoTab(tabId); continue; }
    if (tab && tab.url && (await raidGuardDecide(tabId, tab.url)) === 'raid') await raidGuardClose(tabId, 'sweep');
  }
}
const _raidGuardTimers = new Map();
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || !changeInfo.url) return;
  (async () => {
    const verdict = await raidGuardDecide(tabId, changeInfo.url);
    if (verdict === 'untracked' || verdict === 'same') return;
    if (!(await Storage.getRaidGuardClose())) {
      // Koruma kapalı: başka kanala geçen sekmeyi takipten çıkar (eski davranış aynen)
      await forgetAutoTab(tabId);
      return;
    }
    if (verdict === 'raid') { await raidGuardClose(tabId, 'url'); return; }
    // Henüz olay gelmemiş olabilir: kısa süre sonra bir kez daha bak, olay yoksa sekme kullanıcının
    clearTimeout(_raidGuardTimers.get(tabId));
    _raidGuardTimers.set(tabId, setTimeout(async () => {
      _raidGuardTimers.delete(tabId);
      try {
        const tab = await chrome.tabs.get(tabId);
        const v2 = await raidGuardDecide(tabId, tab.url || changeInfo.url);
        if (v2 === 'raid') await raidGuardClose(tabId, 'recheck');
        else if (v2 === 'other') { await forgetAutoTab(tabId); KLog.debug('RGD-02', `tabId=${tabId} başka kanala geçti, taşıma olayı yok: sekmeye dokunulmadı`); }
      } catch (e) { await forgetAutoTab(tabId); }
    }, RAID_GUARD_RECHECK_MS));
  })().catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => { clearTimeout(_raidGuardTimers.get(tabId)); _raidGuardTimers.delete(tabId); forgetAutoTab(tabId); });

// ─── v2.5.92 (b038): yayın başka kanala taşındı ───
// Kick "Join host": yayıncı izleyicilerini başka bir kanala yönlendirince
// channel.{id} üzerinde ChatMoveToSupportedChannelEvent gelir. Kanal bazlı
// "Yayın başka kanala taşınınca" tercihi (host) açıksa bildirilir.
const HOST_SEEN_KEY = '_hostSeen';
async function handleHostMoveEvent(d) {
  const slug = d && d.slug;
  const hosted = d && d.hosted;
  const target = hosted && typeof hosted.slug === 'string' ? hosted.slug : '';
  if (!slug || !target || target === slug || !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return;
  // v2.5.100: bildirim tercihinden bağımsız, yönlendirme koruması için kaydet
  recordRaidMove(slug, target).catch(() => {});
  const pref = await Storage.getChannelAlertPref(slug);
  if (!pref.host) return;
  const now = Date.now();
  const seen = (await chrome.storage.local.get(HOST_SEEN_KEY))[HOST_SEEN_KEY] || {};
  const key = slug + '>' + target;
  if (now - (seen[key] || 0) < RAID_DEDUP_MS) { KLog.debug('HST-03', `${slug} → ${target} zaten bildirildi (10 dk)`); return; }
  seen[key] = now;
  for (const k of Object.keys(seen)) if (now - seen[k] > RAID_DEDUP_MS) delete seen[k];
  await chrome.storage.local.set({ [HOST_SEEN_KEY]: seen });

  const ch = (cachedChannels || []).find(c => c.channelSlug === slug) || { channelSlug: slug, userUsername: slug, profilePic: '' };
  const name = ch.userUsername || slug;
  const targetName = String(hosted.username || target).slice(0, 64);
  Storage.addNotificationHistory({
    kind: 'host',
    username: name,
    channelSlug: slug,
    profilePic: ch.profilePic || '',
    title: ch.sessionTitle || '-',
    category: ch.categoryName || '-',
    timestamp: new Date().toISOString(),
    target, targetName,
  });

  const showNotif = await Storage.getShowNotification();
  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const soundInfo = await Storage.getChannelSoundModeInfo(slug);
  if (!showNotif || dndMuteNotif || (soundInfo.mode === 'muted' && soundInfo.explicit)) return;
  await Utils.ensureI18n();
  const title = Utils.i18n('notifHostTitle', [name, targetName]) || `${name} moved the stream to ${targetName}`;
  const vc = Number(hosted.viewers_count);
  const parts = [];
  if (hosted.category && typeof hosted.category === 'object' && hosted.category.name) parts.push(String(hosted.category.name).slice(0, 60));
  else if (typeof hosted.category === 'string' && hosted.category) parts.push(hosted.category.slice(0, 60));
  if (Number.isFinite(vc) && vc >= 0) parts.push(Utils.i18n('notifRaidViewers', [String(vc)]) || `with ${vc} viewers`);
  const state = await getPersistedState();
  // Bildirime tıklayınca hedef kanal açılır
  const targetCh = { channelSlug: target, userUsername: targetName, profilePic: (typeof hosted.profile_pic === 'string' && /^https:\/\/[a-z0-9.-]*kick\.com\//.test(hosted.profile_pic)) ? hosted.profile_pic : (ch.profilePic || '') };
  await sendChannelEventNotification(targetCh, title, parts.join(' · '), state.notifiedLives, slug, 'host');
  await setPersistedNotifiedLives(state.notifiedLives);
  KLog.info('HST-10', `${slug} → ${target} yayın taşıma bildirimi gönderildi`);
}
try { if (typeof Pusher !== 'undefined' && Pusher) Pusher.onHostMove = (d) => { handleHostMoveEvent(d).catch(e => KLog.warn('HST-99', 'Yayın taşıma işleme hatası', e)); }; } catch (e) {}

// Firefox: BotTracker bu bağlamda yüklü, raid callback'i doğrudan bağla
try { if (typeof BotTracker !== 'undefined' && BotTracker) BotTracker.onRaid = (d) => { handleRaidEvent(d).catch(() => {}); }; } catch (e) {}

// Canlı yayın bildirimi dışındaki kanal olayları (değişim, yayın bitti, raid)
// için ortak bildirim: tek "Aç" butonu; tıklanınca kanal açılır.
let _evSeq = 0;
async function sendChannelEventNotification(ch, title, message, notifiedLives, soundSlug, evType) {
  // v2.5.98: duraklatma / kanal susturma kanal olaylarını da kapsar
  const sup = await alertSuppressedFor(soundSlug || ch.channelSlug);
  if (sup) { KLog.info('PAU-12', `${soundSlug || ch.channelSlug} → kanal olayı bildirimi atlandı (${sup})`); return; }
  // son parça zaman damgası olmalı (cleanupNotifiedLives); aynı milisaniyede
  // iki olay çakışmasın diye küçük bir sayaç ekleniyor.
  const id = `kickalert-ev-${ch.channelSlug}-${Date.now() + (_evSeq++ % 1000)}`;
  const snd = await resolveEventSound(soundSlug || ch.channelSlug, evType);
  const notifOptions = {
    type: 'basic',
    iconUrl: await getAvatarDataUrl(ch),
    title,
    message: message || '-',
  };
  if (!IS_FIREFOX) {
    // v2.5.64: sistem (Windows) sesi SADECE "Windows bildirim sesi" seçiliyse;
    // eklenti sesi veya sessiz seçiliyse bildirim sessiz istenir.
    notifOptions.silent = !snd.system;
    notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
  }
  chrome.notifications.create(id, notifOptions);
  notifiedLives[id] = { url: `https://kick.com/${ch.channelSlug}`, slug: ch.channelSlug, event: true };
  if (snd.type) await playEventSoundFile(snd.choice, snd.volume);
}

// ─── v2.5.63 / v2.5.64: Kanal olayı sesi ───
// Değişim / yayın bitti / raid bildirimleri canlı bildirimden daha naif.
// Seçenekler: soft / chime / tick (eklentinin kısık sesi, sistem sesi kapalı),
// windows (sadece işletim sisteminin bildirim sesi, eklenti sesi yok),
// silent (hiç ses yok). Ana ses modundan (Eklenti/Windows) bağımsızdır.
// Sessiz saatlerde "sesleri sustur" açıksa veya kanalın ses tercihi "sessiz"
// ise hiçbir ses çalınmaz ve bildirim sessiz istenir.
// v2.5.107: ses listesi storage.js'teki EVENT_SOUND_CHOICES'tan (dosya: sounds/event_<ad>.mp3)
const EVENT_SOUND_TYPES = Object.fromEntries(EVENT_SOUND_CHOICES.map(c => [c, 'EVENT_' + c.toUpperCase()]));
async function resolveEventSound(slug, evType) {
  const none = { system: false, type: null };
  try {
    let choice = await Storage.getEventSound();
    // v2.5.99: olay türüne özel ses seçildiyse o
    if (evType) { const per = (await Storage.getEventSoundByType())[evType]; if (per && per !== 'default') choice = per; }
    if (choice === 'silent') return none;
    if (slug && (await Storage.getChannelSoundMode(slug)) === 'silent') return none;
    if ((await Storage.isDndActive()) && (await Storage.getDndMuteSound())) return none;
    if (choice === 'windows') return { system: true, type: null };
    const type = EVENT_SOUND_TYPES[choice];
    const volume = await Storage.getEventSoundVolume();
    if (!type || volume <= 0) return none;
    return { system: false, type, choice, volume };
  } catch (e) {
    KLog.warn('SND-31', 'Olay sesi ayarı okunamadı: ' + e.message);
    return none;
  }
}
async function playEventSoundFile(choice, volumePct) {
  const type = EVENT_SOUND_TYPES[choice];
  if (!type) return;
  const volume = Math.max(0, Math.min(100, Number(volumePct) || 0)) / 100;
  if (volume <= 0) return;
  try {
    if (chrome.offscreen) {
      await startOffscreen();
      // v2.5.107: dosya adresi doğrudan verilir (offscreen'in sabit listesine yeni ses eklemek gerekmez)
      await chrome.runtime.sendMessage({ messageType: 'PLAY_SOUND', options: { sound: type, volume, customSoundFile: chrome.runtime.getURL(`sounds/event_${choice}.mp3`) } }).catch(() => {});
    } else {
      const audio = new Audio(chrome.runtime.getURL(`sounds/event_${choice}.mp3`));
      audio.volume = volume;
      await audio.play();
    }
  } catch (e) {
    KLog.warn('SND-30', 'Olay sesi çalınamadı: ' + e.message);
  }
}

// ─── Auto Open ───

async function shouldAutoOpen(ch) {
  const isAuto = await Storage.isAutoOpenChannel(ch.channelSlug);
  if (!isAuto) return false;
  const dupGuard = await Storage.isDuplicateTabGuard();
  if (!dupGuard) return true;

  try {
    const tabs = await chrome.tabs.query({});
    const openSlugs = tabs.map(t => {
      const m = (t.url || '').match(/^https:\/\/kick\.com\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    }).filter(Boolean);
    return !openSlugs.includes(ch.channelSlug.toLowerCase());
  } catch { return true; }
}

// ─── Sound via Offscreen ───

async function startOffscreen() {
  // Firefox doesn't support offscreen API - skip silently
  if (!chrome.offscreen) return;
  try {
    // hasDocument may throw "No SW" if service worker isn't fully ready
    let hasDoc = false;
    try { hasDoc = await chrome.offscreen.hasDocument(); } catch { return; }
    if (hasDoc) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('html/offscreen.html'),
      // v2.3.0: AUDIO_PLAYBACK (sounds) + BLOBS (Pusher WebSocket for bot tracker)
      reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
      justification: 'Notification sounds, service worker keep-alive, and chat tracking via Pusher WebSocket',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" is harmless - already exists
    if (!e.message?.includes('single offscreen')) {
      console.warn('[KickAlert] Offscreen create error:', e.message);
    }
  }
}

async function playSound(type) {
  const soundMode = await Storage.getSoundMode();
  if (soundMode === 'windows') return;

  const volume = (await Storage.getSoundVolume()) / 100;
  // v2.5.22: CHAT_MENTION (Mo'Kick'ten ödünç alınan bahsedilme sesi) sabit
  // bir dosya kullanıyor - main/sub'ın kullanıcı tarafından yüklenmiş özel
  // dosyasını YANLIŞLIKLA burada kullanmayalım diye customFile aramasını
  // sadece main/sub tipleri için yapıyoruz.
  const customFile = (type === 'CHAT_MENTION')
    ? null
    : await Storage.getCustomSoundFile(type === 'NEW_LIVE_MAIN' ? 'main' : 'sub');

  if (chrome.offscreen) {
    // Chrome: use offscreen document for audio
    await startOffscreen();
    try {
      await chrome.runtime.sendMessage({
        messageType: 'PLAY_SOUND',
        options: { sound: type, volume, customSoundFile: customFile?.dataUrl || null },
      });
    } catch (e) {
      console.warn('[KickAlert] Sound send error:', e.message);
    }
  } else {
    // Firefox: play audio directly in background script
    try {
      const SoundPaths = {
        NEW_LIVE_MAIN: chrome.runtime.getURL('sounds/new_live_main.mp3'),
        NEW_LIVE_SUB: chrome.runtime.getURL('sounds/new_live_sub.mp3'),
        CHAT_MENTION: chrome.runtime.getURL('sounds/chat_mention.mp3'),
      };
      const src = customFile?.dataUrl || SoundPaths[type] || SoundPaths.NEW_LIVE_SUB;
      const audio = new Audio(src);
      audio.volume = volume;
      await audio.play();
    } catch (e) {
      console.warn('[KickAlert] Firefox audio error:', e.message);
    }
  }
}

// ─── Events ───

// v2.5.111: Değerlendirme isteği için "olumlu an": kullanıcı bir bildirimden
// yayını açtı. Popup bu zamanı okuyup bandı o an gösterebilir (sadece bu cihaz).
function markRateGoodMoment() {
  try { chrome.storage.local.set({ _rateGoodMoment: Date.now() }); } catch (e) {}
}

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('kickalert-')) return;
  dbg(`[KickAlert] Notification body clicked: ${id}`);
  const state = await getPersistedState();
  const entry = state.notifiedLives[id];
  if (entry) {
    const url = typeof entry === 'string' ? entry : entry.url;
    await chrome.tabs.create({ url });
    markRateGoodMoment(); // v2.5.111
    chrome.notifications.clear(id);
    delete state.notifiedLives[id];
    await setPersistedNotifiedLives(state.notifiedLives);
  }
});

chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  if (!id.startsWith('kickalert-')) return;
  dbg(`[KickAlert] Notification BUTTON ${buttonIndex} clicked: ${id}`);
  const state = await getPersistedState();
  const entry = state.notifiedLives[id];

  if (!entry) {
    console.warn(`[KickAlert] No entry found for ${id} - already cleared?`);
    return;
  }

  const url = typeof entry === 'string' ? entry : entry.url;
  const slug = typeof entry === 'string'
    ? id.replace('kickalert-', '').replace(/-\d+$/, '')
    : entry.slug;

  dbg(`[KickAlert] Button action - slug: "${slug}", index: ${buttonIndex}`);

  if (buttonIndex === 0) {
    await chrome.tabs.create({ url });
    markRateGoodMoment(); // v2.5.111
    dbg(`[KickAlert] Opened: ${slug}`);
  } else if (buttonIndex === 1) {
    // v2.5.98: "1 saat sustur": sadece bu kanal, 1 saat (önceden kanalı kalıcı
    // olarak "Bildirim yok" moduna alıyordu; kalıcı seçim kanal zilinde duruyor)
    if (slug && /^[A-Za-z0-9_-]{1,64}$/.test(slug)) {
      await snoozeChannel(slug, 60 * 60 * 1000);
      KLog.info('PAU-20', `${slug} → bildirimden 1 saat susturuldu`);
    }
  }

  chrome.notifications.clear(id);
  delete state.notifiedLives[id];
  await setPersistedNotifiedLives(state.notifiedLives);
});

// BUG 14 FIX: Reset persisted state on install/update to avoid stale data
// v2.3.1 Plan C: Eklenti yüklendiğinde/güncellendiğinde mevcut kick.com
// tab'larına content script'i programatik inject et. Chrome manifest sadece
// YENİ navigasyonlara content script yükler; eklenti reload sonrası açık olan
// tab'lara dokunmaz. Bu fonksiyon o boşluğu kapatıyor.
async function injectContentScriptToOpenKickTabs() {
  try {
    if (!chrome.scripting || !chrome.scripting.executeScript) {
      dbg('[KickAlert] chrome.scripting yok - Plan C otomatik inject atlandı');
      return;
    }
    const tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
    if (!tabs || tabs.length === 0) {
      dbg('[KickAlert] Plan C inject: açık kick.com tab yok');
      return;
    }
    let ok = 0, fail = 0;
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content.js'],
        });
        ok++;
      } catch (e) {
        // Tab kapanmış, izin yok, veya zaten yüklü - sessiz fail
        fail++;
      }
    }
    dbg(`[KickAlert] Plan C inject: ${ok}/${tabs.length} kick.com tab'ı tazelendi (${fail} fail)`);
  } catch (e) {
    dbg('[KickAlert] Plan C inject hatası:', e.message);
  }
}

// v2.5.108: olay sesleri olaya göre başlasın (Patron onayı 30.10.2026). Yeni
// kurulumda ve olay sesini hiç değiştirmemiş kullanıcıda (genel ses varsayılan
// 'soft', türe özel sesler boş ya da hepsi 'Genel ses') bir kez uygulanır.
// Sesi değiştirmiş kullanıcıya dokunulmaz. Bayrak: _evThemed108.
const EVENT_SOUND_THEMED = { change: 'change_blip', end: 'end_goodnight', raid: 'raid_fanfare', host: 'host_whoosh' };
async function applyThemedEventSounds(reason) {
  try {
    const cur = await chrome.storage.local.get(['_evThemed108', 'eventSound', 'eventSoundByType']);
    if (cur._evThemed108) return;
    const generalUntouched = cur.eventSound === undefined || cur.eventSound === 'soft';
    const per = cur.eventSoundByType;
    const perUntouched = !per || Object.values(per).every(v => !v || v === 'default');
    const upd = { _evThemed108: true };
    if (generalUntouched && perUntouched) upd.eventSoundByType = Object.assign({}, EVENT_SOUND_THEMED);
    await chrome.storage.local.set(upd);
    KLog.info('SND-40', upd.eventSoundByType ? `Olay sesleri olaya göre ayarlandı (${reason})` : `Olay sesleri değiştirilmiş, dokunulmadı (${reason})`);
  } catch (e) { KLog.warn('SND-41', 'Olay sesi varsayılanı yazılamadı: ' + (e && e.message)); }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.local.set({ _sessionStart: Date.now() });
  if (details.reason === 'install' || details.reason === 'update') await applyThemedEventSounds(details.reason);
  // v2.5.74: varsayılan kanal bildirim modu. YENİ kurulumda kanallar
  // bildirim göndermez (kullanıcı istediğini açar). GÜNCELLEMEDE mevcut
  // davranış korunur ('sessiz bildirim'); daha önce ayarlanmışsa dokunulmaz.
  try {
    const cur = await chrome.storage.local.get(['defaultChannelMode', '_installDefaultMode']);
    if (details.reason === 'install') {
      const upd = {};
      if (!cur.defaultChannelMode) upd.defaultChannelMode = 'muted';
      if (!cur._installDefaultMode) upd._installDefaultMode = 'muted';
      upd._welcomePending = true; // v2.5.86: popup ilk açılışta karşılamayı gösterir
      if (Object.keys(upd).length) await chrome.storage.local.set(upd);
      KLog.info('INST-01', 'Yeni kurulum: kanal bildirimleri varsayılan kapalı');
    } else if (details.reason === 'update') {
      const upd = {};
      if (!cur.defaultChannelMode) upd.defaultChannelMode = 'silent';
      if (!cur._installDefaultMode) upd._installDefaultMode = 'silent';
      if (Object.keys(upd).length) await chrome.storage.local.set(upd);
      // v2.5.81: güncellemeden sonra popup kapalı site izni varsa izin sihirbazını gösterir
      await chrome.storage.local.set({ _permWizardPending: true, _permWizardStarted: false });
      // v2.5.88 (b042): bir kerelik "yerel kazanır" senkronu (bkz. initialize)
      const lwd = await chrome.storage.local.get('_syncLocalWinsDone88');
      if (!lwd._syncLocalWinsDone88) await chrome.storage.local.set({ _syncLocalWins: true });
    }
  } catch (e) { console.warn('[KickAlert] varsayılan kanal modu yazılamadı:', e && e.message); }
  // Reset state only on fresh install or extension update, not on every browser start
  if (details.reason === 'install' || details.reason === 'update') {
    await resetPersistedState();
  }
  // Plan C: Mevcut kick.com tab'larına content script'i tazele
  await injectContentScriptToOpenKickTabs();
  await initialize(true); // fresh session: cloud'dan pull yapılabilir
});

chrome.runtime.onStartup.addListener(async () => {
  // Tarayıcı yeniden açıldı - liveSlugs sıfırla
  const now = Date.now();
  await chrome.storage.local.remove(['_liveSlugs', '_lastCheckDone', '_initLock']);
  await chrome.storage.local.set({ _sessionStart: now });

  // viewerHistory current dizilerini temizle - anomali sistemi temiz başlasın
  // PC kapat/aç sonrası eski current verisi kalıyor → sahte anomali gösterimi
  try {
    const vhData = await chrome.storage.local.get('viewerHistory');
    const vh = vhData.viewerHistory || {};
    let changed = false;
    for (const slug of Object.keys(vh)) {
      if (vh[slug].current && vh[slug].current.length > 0) {
        vh[slug].current = [];
        vh[slug].streamPeak = null;
        vh[slug].streamValley = null;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ viewerHistory: vh });
  } catch (e) {
    console.warn('[KickAlert] Failed to clear viewerHistory on startup:', e);
  }

  // Plan C: Tarayıcı açılışında da inject yap (browser session restore senaryosu)
  await injectContentScriptToOpenKickTabs();

  initialize(true); // fresh session: cloud'dan pull yapılabilir
});

// Fallback: SW woke from alarm. Only run if alarm already exists (was previously set up).
// Delay 200ms so onInstalled/onStartup can run first if they are also firing.
// v2.5.45: isFreshSession=false - bu rutin bir uyanış, gerçek bir oturum başlangıcı
// değil. pullFromSync() burada ÇALIŞTIRILMAMALI (bkz. initialize() üstündeki not).
chrome.alarms.get(ALARM_NAME).then(alarm => {
  if (alarm) {
    setTimeout(() => {
      if (!_initRunning) initialize(false);
    }, 200);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // v2.3.0: Offscreen-targeted mesajları görmezden gel (loop'u önle)
  // chrome.runtime.sendMessage broadcast'tir - hem background hem offscreen alır.
  // target: 'offscreen' field'ı bizim convention'ımız, offscreen tarafında filtreliyoruz.
  if (msg.target === 'offscreen') return false;

  // ─── v2.3.1 Plan F: Offscreen'den gelen Pusher event'leri ───
  // Offscreen document WebSocket'i tutuyor; StreamerIsLive gelince SW'ye iletir.
  // Bu mesaj SW uykuda olsa bile onu uyandırır → bildirim API'siz gönderilir.
  if (msg.type === 'PUSHER_LIVE_EVENT') {
    handlePusherLiveEvent(msg.slug, { livestream: msg.livestream })
      .catch(e => console.warn('[KickAlert] Pusher live handler error:', e.message));
    return false;
  }
  if (msg.type === 'PUSHER_OFFLINE_EVENT') {
    handlePusherOfflineEvent(msg.slug)
      .catch(e => console.warn('[KickAlert] Pusher offline handler error:', e.message));
    return false;
  }

  // ─── v2.3.19: Reklam Engelleme (DENEYSEL) log köprüsü ───
  // adblock-worker-hook.js (MAIN dünya + IVS worker thread'i) kendi konsoluna
  // yazan logları content.js üzerinden buraya iletiyor. Tek amaç: test
  // panelindeki Aktivite Logu'nda TÜM eklenti aktivitesini tek yerde görmek.
  // v2.5.74: reklam teşhisleri (biriktirme + isteğe bağlı gönderim) - src/ad-diag.js
  if (msg.type === 'AD_DIAG') {
    if (typeof AdDiag !== 'undefined') AdDiag.record(msg);
    return false;
  }
  if (msg.type === 'GET_AD_DIAG' || msg.type === 'CLEAR_AD_DIAG' || msg.type === 'SEND_AD_DIAG_NOW' || msg.type === 'SET_AD_DIAG_ENDPOINT') {
    if (typeof AdDiag === 'undefined') { respond({ ok: false, reason: 'unavailable' }); return false; }
    const job = msg.type === 'GET_AD_DIAG' ? AdDiag.status()
      : msg.type === 'CLEAR_AD_DIAG' ? AdDiag.clear()
      : msg.type === 'SEND_AD_DIAG_NOW' ? AdDiag.send('manual')
      : AdDiag.setEndpoint(msg.url);
    job.then(r => respond(r)).catch(e => respond({ ok: false, reason: String(e && e.message || e) }));
    return true;
  }
  if (msg.type === 'AD_BLOCK_LOG') {
    const level = msg.level === 'warn' ? 'warn' : 'info';
    KLog[level](msg.code || 'ADB-00', msg.text || '');
    return false;
  }

  // ─── v2.3.20: offscreen.html (LiveTracker/BotTracker) log köprüsü ───
  // offscreen.js/bot_tracker.js ayrı DevTools context'inde çalışıyor -
  // önemli olaylarını buraya (KLog'a) iletiyorlar, tek konsol için.
  // v2.5.55: içerik betiğinden izleme süresi tiki
  if (msg.type === 'WATCH_TICK') {
    addWatchTime(msg.slug, msg.sec);
    return false;
  }

  // v2.5.92: offscreen LiveTracker'dan yayın taşıma olayı (Chrome)
  if (msg.type === 'HOST_MOVE_EVENT') {
    handleHostMoveEvent(msg).catch(e => KLog.warn('HST-99', 'Yayın taşıma işleme hatası', e));
    return false;
  }

  // v2.5.103: offscreen BotTracker'dan gelen sohbet radarı eşleşmesi (Chrome)
  if (msg.type === 'RADAR_HIT') {
    handleRadarHit(msg).catch(e => KLog.warn('RDR-99', 'Radar işleme hatası', e));
    return false;
  }

  // v2.5.54: offscreen BotTracker'dan gelen raid olayı (Chrome)
  if (msg.type === 'RAID_EVENT') {
    handleRaidEvent(msg).catch(e => KLog.warn('RAID-99', 'Raid işleme hatası', e));
    return false;
  }

  // v2.5.78: offscreen'de Pusher kalıcı hata verdi (ör. 4001): anahtarı Kick'e yeniden sor
  if (msg.type === 'PUSHER_KEY_INVALID') {
    KLog.info('PSH-12', `Pusher kalıcı hata (${msg.code}, ${msg.source}) · anahtar Kick'ten yeniden isteniyor`);
    ensurePusherConfig({ force: true, reason: `kalıcı hata ${msg.code}` }).then((cfg) => {
      // Offscreen eski anahtarla kaldıysa (arka planda anahtar zaten güncel olabilir) gönder
      if (cfg && msg.key !== cfg.key) {
        chrome.runtime.sendMessage({ target: 'offscreen', type: 'PUSHER_CONFIG', pusherCfg: cfg }).catch(() => {});
      }
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'OFFSCREEN_LOG') {
    const level = msg.level === 'warn' ? 'warn' : 'info';
    KLog[level](msg.code || 'OFF-00', msg.text || '');
    return false;
  }

  // ─── v2.3.1 Plan F (BUG#9): Content script'ten channel_id geldi ───
  // Kullanıcı bir kanal sayfası açtığında content script o kanalın channel_id'sini
  // SAYFA context'inde (cf_clearance korumalı, 403 riski YOK) çekip gönderir.
  // SW olarak kalıcı cache'leyip Pusher'a subscribe ediyoruz - sıfır SW-API baskısı.
  if (msg.type === 'CHANNEL_ID_HARVESTED') {
    (async () => {
      try {
        if (!msg.slug || !msg.channelId) return;
        const existing = await Storage.getChannelId(msg.slug);
        if (existing !== msg.channelId) {
          await Storage.setChannelId(msg.slug, msg.channelId);
          dbg(`[KickAlert] Plan F: channel_id sayfadan toplandı → ${msg.slug}=${msg.channelId} (SW-API kullanılmadı)`);
        }
        // BUG#11 FIX: content script bu slug'ı sayfa context'inde başarıyla çekti.
        // SW'nin negatif cache'inde 403 yüzünden işaretliyse temizle ki ileride
        // SW de (gerekirse) tekrar deneyebilsin.
        if (typeof KickAPI !== 'undefined' && KickAPI._clearNegative) {
          KickAPI._clearNegative(msg.slug);
        }
        // chatroom_id de geldiyse onu da cache'le (bot tracker'a faydası olur)
        if (msg.chatroomId) {
          const exCr = await Storage.getChatroomId(msg.slug);
          if (!exCr) await Storage.setChatroomId(msg.slug, msg.chatroomId);
        }
        // Bu kanal takip ediliyorsa Pusher'a hemen subscribe et
        const isFollowed = (cachedChannels || []).some(c => c.channelSlug === msg.slug);
        if (isFollowed) {
          if (chrome.offscreen) {
            await sendToOffscreenWithRetry({
              target: 'offscreen',
              type: 'LIVE_TRACK_SYNC',
              pusherCfg: pusherCfgPayload(),
              channels: [{ channelId: msg.channelId, slug: msg.slug }],
            });
          } else if (typeof Pusher !== 'undefined') {
            Pusher.subscribeChannel(msg.channelId, msg.slug);
          }
        }
      } catch (e) {
        console.warn('[KickAlert] CHANNEL_ID_HARVESTED error:', e.message);
      }
    })();
    return false;
  }

  if (msg.type === 'GET_CHANNELS') {
    // v2.3.0 DEBUG: popup boş bug'ını teşhis için log
    dbg(`[KickAlert] GET_CHANNELS received - RAM cache size: ${cachedChannels.length}`);
    if (cachedChannels.length > 0) {
      const liveInRam = cachedChannels.filter(c => c.isLive).length;
      dbg(`[KickAlert] Responding from RAM: ${cachedChannels.length} total, ${liveInRam} live`);
      respond({ success: true, channels: cachedChannels });
      return false;
    }
    // RAM cache empty (SW slept) - try storage cache first, then fetch fresh
    chrome.storage.local.get(['_cachedChannels']).then(async (result) => {
      const stored = result._cachedChannels;
      dbg(`[KickAlert] RAM empty, storage cache: ${stored?.length || 0} channels`);
      if (stored?.length) {
        cachedChannels = stored;
        respond({ success: true, channels: stored, fromCache: true });
      } else {
        try {
          dbg(`[KickAlert] Storage empty, fetching fresh from API`);
          const channels = await KickAPI.getAllFollowingChannels();
          cachedChannels = channels;
          try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
          dbg(`[KickAlert] Fresh fetch OK: ${channels.length} channels`);
          respond({ success: true, channels });
        } catch (err) {
          console.warn(`[KickAlert] Fresh fetch FAILED: ${err.message}`);
          // v2.3.1 fix: Fresh fetch fail olunca KickAPI'nin kendi fallback cache'ini dene
          // (getAllFollowingChannels'in iç fallback cache: _followedFallback)
          try {
            if (KickAPI._followedFallback && KickAPI._followedFallback.channels?.length > 0) {
              const ageMin = Math.round((Date.now() - KickAPI._followedFallback.cachedAt) / 60000);
              dbg(`[KickAlert] Using KickAPI fallback cache: ${KickAPI._followedFallback.channels.length} channels (${ageMin}dk eski)`);
              respond({
                success: true,
                channels: KickAPI._followedFallback.channels,
                fromCache: true,
                staleReason: err.message,
              });
              return;
            }
          } catch (_) {}
          respond({ success: false, error: err.message });
        }
      }
    });
    return true;
  }
  if (msg.type === 'GET_CHANNELS_FRESH') {
    // Always fetch from API, update cache (v2.3.0: forceFresh=true ile cache bypass)
    KickAPI.getAllFollowingChannels(true)
      .then(async (channels) => {
        cachedChannels = channels;
        try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
        respond({ success: true, channels });
      })
      .catch(err => respond({ success: false, error: err.message }));
    return true;
  }
  // v2.2.1: Manuel refresh için backoff'u sıfırla (popup refresh butonu çağrır)
  if (msg.type === 'RESET_BACKOFF') {
    KickAPI.resetBackoff()
      .then(() => respond({ success: true }))
      .catch(err => respond({ success: false, error: err.message }));
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v2.3.1: Diagnostic Panel Message Handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // Backoff durumu - kalan süre, son backoff bilgisi
  // v2.5.97: "Bildirim neden gelmedi?" kanal teşhisi
  if (msg.type === 'DIAG_CHANNEL_NOTIF') {
    diagChannelNotif(String(msg.slug || '')).then(respond).catch(e => respond({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'GET_BACKOFF_STATUS') {
    (async () => {
      try {
        await KickAPI._loadBackoffFromStorage();
        const now = Date.now();
        const active = now < KickAPI._lastBackoffUntil;
        respond({
          success: true,
          active,
          remainingMs: active ? (KickAPI._lastBackoffUntil - now) : 0,
          lastBackoffDuration: KickAPI._lastBackoffDuration || 0,
          lastBackoffEndTime: KickAPI._lastBackoffEndTime || 0,
          lastSessionRefreshAt: KickAPI._lastSessionRefreshAt || 0,
          lastAuthWarnAt: KickAPI._lastAuthWarnAt || 0,
        });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Tek API çağrısı - anlık 200/403 testi
  if (msg.type === 'RUN_API_TEST') {
    (async () => {
      try {
        const cookies = await chrome.cookies.getAll({ domain: 'kick.com', name: 'session_token' });
        if (!cookies[0]) {
          respond({ success: false, error: 'session_token cookie yok - Kick.com\'a giriş yap' });
          return;
        }
        const token = decodeURIComponent(cookies[0].value);
        const start = Date.now();
        const r = await fetch('https://kick.com/api/v2/channels/followed', {
          method: 'GET',
          credentials: 'include',
          headers: {
            'Accept': 'application/json',
            'Authorization': 'Bearer ' + token,
            'X-App-Platform': 'web',
          }
        });
        const elapsed = Date.now() - start;
        let channelCount = 0;
        if (r.ok) {
          try {
            const data = await r.json();
            channelCount = data?.channels?.length ?? (Array.isArray(data) ? data.length : 0);
          } catch {}
        }
        respond({ success: true, status: r.status, elapsedMs: elapsed, channelCount });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Rate test - N istek arka arkaya, gecikme ile
  if (msg.type === 'RUN_RATE_TEST') {
    const count = Math.min(Math.max(parseInt(msg.count) || 5, 1), 10);
    const delayMs = Math.max(parseInt(msg.delayMs) || 5000, 1000);
    (async () => {
      try {
        const cookies = await chrome.cookies.getAll({ domain: 'kick.com', name: 'session_token' });
        if (!cookies[0]) {
          respond({ success: false, error: 'session_token cookie yok' });
          return;
        }
        const token = decodeURIComponent(cookies[0].value);
        const headers = {
          'Accept': 'application/json',
          'Authorization': 'Bearer ' + token,
          'X-App-Platform': 'web',
        };
        const results = [];
        for (let i = 1; i <= count; i++) {
          const start = Date.now();
          try {
            const r = await fetch('https://kick.com/api/v2/channels/followed', {
              method: 'GET', credentials: 'include', headers
            });
            results.push({ i, status: r.status, elapsedMs: Date.now() - start });
          } catch (e) {
            results.push({ i, status: 0, error: e.message, elapsedMs: Date.now() - start });
          }
          if (i < count) await new Promise(r => setTimeout(r, delayMs));
        }
        const okCount = results.filter(r => r.status === 200).length;
        respond({ success: true, total: count, okCount, failCount: count - okCount, results });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Cookie tablosu
  if (msg.type === 'GET_COOKIES') {
    (async () => {
      try {
        const cookies = await chrome.cookies.getAll({ domain: 'kick.com' });
        const list = cookies.map(c => ({
          name: c.name,
          length: c.value.length,
          expires: c.expirationDate ? c.expirationDate * 1000 : null,
          domain: c.domain,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
        })).sort((a, b) => a.name.localeCompare(b.name));
        respond({ success: true, cookies: list });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // DNR rules durumu
  if (msg.type === 'GET_DNR_RULES') {
    (async () => {
      try {
        const enabledRulesets = await chrome.declarativeNetRequest.getEnabledRulesets();
        let staticRulesCount = 0;
        try {
          const rules = await chrome.declarativeNetRequest.getDynamicRules();
          staticRulesCount = rules.length;
        } catch {}
        // Manifest'ten okunabilir static rules sayısı için ruleset_1 sayalım
        respond({
          success: true,
          enabledRulesets,
          dynamicRulesCount: staticRulesCount,
          staticRulesetActive: enabledRulesets.includes('ruleset_1'),
        });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Manuel session refresh
  if (msg.type === 'MANUAL_SESSION_REFRESH') {
    (async () => {
      try {
        // Cooldown'ı bypass etmek için son zamanı sıfırla
        const oldStamp = KickAPI._lastSessionRefreshAt;
        KickAPI._lastSessionRefreshAt = 0;
        const start = Date.now();
        const ok = await KickAPI.refreshKickSession('panel_manual');
        const elapsed = Date.now() - start;
        respond({ success: true, refreshed: ok, elapsedMs: elapsed });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // İstatistikler - alarm sayısı, son alarm, vb.
  if (msg.type === 'GET_DIAG_STATS') {
    (async () => {
      try {
        const alarm = await chrome.alarms.get(ALARM_NAME);
        const refreshAlarm = await chrome.alarms.get(SESSION_REFRESH_ALARM);
        const checkInterval = await Storage.getCheckInterval();
        const storageBytes = await new Promise(r => {
          try {
            chrome.storage.local.getBytesInUse(null, b => r(b || 0));
          } catch { r(0); }
        });
        respond({
          success: true,
          alarm: alarm ? { name: alarm.name, scheduledTime: alarm.scheduledTime, periodInMinutes: alarm.periodInMinutes } : null,
          sessionRefreshAlarm: refreshAlarm ? { name: refreshAlarm.name, scheduledTime: refreshAlarm.scheduledTime, periodInMinutes: refreshAlarm.periodInMinutes } : null,
          checkInterval,
          storageBytes,
          ramCacheSize: cachedChannels.length,
          ramLiveCount: cachedChannels.filter(c => c.isLive).length,
        });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Force re-fetch - backoff atla, hemen API çağır
  if (msg.type === 'FORCE_RECHECK') {
    (async () => {
      try {
        await KickAPI.resetBackoff();
        await checkSafe();
        respond({ success: true });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // v2.3.1 (Plan B/M4): Son 5 dk API istatistiği - test paneli "Son 5dk" panosu
  if (msg.type === 'GET_RECENT_API_STATS') {
    (async () => {
      try {
        const windowMs = (msg.windowMin || 5) * 60 * 1000;
        const stats = KickAPI.getRecentApiStats(windowMs);
        // Plan C ek bilgi: proxy hazır mı + sayım
        const proxyStats = KickAPI.getProxyStats ? KickAPI.getProxyStats() : null;
        const proxyAvailable = KickAPI.hasProxyTab ? await KickAPI.hasProxyTab() : false;
        respond({
          success: true,
          ...stats,
          slowModeActive: _slowModeActive,
          peakModeActive: _peakModeActive,
          effectiveSecs: _currentEffectiveSecs,
          proxyAvailable,
          proxyStats,
        });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Plan C - sadece proxy durumu sorgusu (light-weight, frequent polling için)
  if (msg.type === 'GET_PROXY_STATUS') {
    (async () => {
      try {
        const available = KickAPI.hasProxyTab ? await KickAPI.hasProxyTab() : false;
        const stats = KickAPI.getProxyStats ? KickAPI.getProxyStats() : null;
        respond({ success: true, available, stats });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // Anomaly listesi - popup'ın anomaly check'lerinin son halini ver
  if (msg.type === 'GET_ANOMALY_TABLE') {
    (async () => {
      try {
        const live = cachedChannels.filter(c => c.isLive);
        const result = [];
        for (const ch of live) {
          const vh = await Storage.getViewerHistory(ch.channelSlug);
          const points = vh?.points || [];
          if (points.length === 0) {
            result.push({
              slug: ch.channelSlug,
              user: ch.user, viewers: ch.viewerCount, valley: null, peak: null,
              roc: null, ageMin: null,
            });
            continue;
          }
          const viewers = ch.viewerCount;
          const valley = Math.min(...points.map(p => p.v));
          const peak = Math.max(...points.map(p => p.v));
          const oldest = points[0];
          const ageMs = oldest ? Date.now() - oldest.t : 0;
          const ageMin = Math.round(ageMs / 60000);
          // ROC: Last vs N samples ago
          const roc = points.length >= 2
            ? Math.round(((viewers - points[0].v) / Math.max(points[0].v, 1)) * 100)
            : 0;
          result.push({
            slug: ch.channelSlug,
            user: ch.user,
            viewers,
            valley,
            peak,
            roc,
            ageMin,
          });
        }
        result.sort((a, b) => (b.viewers || 0) - (a.viewers || 0));
        respond({ success: true, channels: result });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v2.3.0: Popup chat istatistiklerini ister - Chrome offscreen'e veya Firefox local'e
  if (msg.type === 'GET_BOT_STATS') {
    if (!BotTrackerHost.isSupported) {
      respond({ success: false, error: 'BotTracker not supported on this platform' });
      return false;
    }
    (async () => {
      try {
        // Chrome'da offscreen yoksa ve canlı kanal yoksa hata
        if (!BotTrackerHost.isLocal && !await BotTrackerHost.isAlive()) {
          respond({ success: false, error: 'Offscreen document not running (no live channels?)' });
          return;
        }
        const res = await BotTrackerHost.getStats();
        respond(res || { success: false, error: 'No response from BotTracker' });
      } catch (err) {
        respond({ success: false, error: err.message });
      }
    })();
    return true;
  }

  // v2.3.0: Diagnostic - bot tracker durumunu öğren
  if (msg.type === 'GET_BOT_TRACKER_STATUS') {
    if (!BotTrackerHost.isSupported) {
      respond({ success: false, available: false, reason: 'BotTracker not supported on this platform' });
      return false;
    }
    (async () => {
      try {
        const isAlive = await BotTrackerHost.isAlive();
        const enabled = await Storage.getBotTrackerEnabled();
        const cachedChannelsArr = cachedChannels || [];
        const liveCount = cachedChannelsArr.filter(c => c.isLive).length;
        const platform = BotTrackerHost.isLocal ? 'firefox-local' : 'chrome-offscreen';
        respond({
          success: true,
          available: true,
          platform,
          offscreenRunning: isAlive,
          masterToggleEnabled: enabled,
          liveChannelCount: liveCount,
          hint: !isAlive
            ? 'BotTracker kapalı. Canlı kanal beklenir, ya da test için extension reload edip ~30sn bekle.'
            : `BotTracker çalışıyor (${platform}). GET_BOT_STATS ile istatistik alabilirsin.`,
        });
      } catch (err) {
        respond({ success: false, error: err.message });
      }
    })();
    return true;
  }
  // v2.3.0 Aşama 2: Popup için skor okuma (Storage'tan, hızlı)
  if (msg.type === 'GET_BOT_SCORES') {
    Storage.getBotScores()
      .then(scores => respond({ success: true, scores: scores || {} }))
      .catch(err => respond({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'PLAY_TEST_SOUND') {
    startOffscreen().then(() => {
      playSound(msg.soundType || 'NEW_LIVE_MAIN');
    });
    respond({ success: true });
    return false;
  }
  // ─── v2.4.0 SNIFFER: Event keşif modunu başlat ───
  // Takip edilen canlı kanalların chatroom_id'lerini toplar, offscreen'e iletir.
  // Offscreen hem channel.{id} hem chatrooms.{id}.v2 event'lerini ham loglar.
  // Konsoldan: chrome.runtime.sendMessage({type:'START_SNIFFER'})
  if (msg.type === 'START_SNIFFER') {
    (async () => {
      try {
        if (!chrome.offscreen) {
          respond({ success: false, error: 'Sniffer sadece Chrome (offscreen) modunda' });
          return;
        }
        await startOffscreen();
        // Canlı kanalların chatroom_id'lerini topla (cache'ten + gerekiyorsa)
        const chatroomIds = [];
        const liveChannels = (cachedChannels || []).filter(c => c.isLive);
        for (const ch of liveChannels) {
          // KickAPI.getChatroomId cache-first; eksikse çeker (sniffer için tek seferlik)
          const crid = await KickAPI.getChatroomId(ch.channelSlug);
          if (crid) chatroomIds.push(crid);
        }
        // Hiç canlı kanal yoksa, en azından channel.{id} event'leri için sniffer açık
        await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'LIVE_SNIFFER_START',
          chatroomIds,
        });
        respond({
          success: true,
          message: `Sniffer açıldı. ${liveChannels.length} canlı kanal, ${chatroomIds.length} chatroom dinleniyor. Offscreen konsolunu (chrome://inspect → offscreen.html) izle.`,
          liveChannels: liveChannels.map(c => c.channelSlug),
          chatroomCount: chatroomIds.length,
        });
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }
  // ─── v2.3.1 Plan F: Pusher WebSocket durumu (teşhis) ───
  if (msg.type === 'GET_PUSHER_STATE') {
    (async () => {
      try {
        // SW-tarafı Plan F durumu (offscreen/Firefox fark etmez) - test/teşhis için
        const swState = {
          pusherLiveSlugs: [..._pusherLiveSlugs],
          pusherLiveCount: _pusherLiveSlugs.size,
        };
        if (chrome.offscreen) {
          // Chrome: offscreen'den state iste
          await startOffscreen();
          const resp = await chrome.runtime.sendMessage({
            target: 'offscreen',
            type: 'LIVE_GET_STATE',
          });
          respond({ success: true, mode: 'offscreen', state: resp?.state || null, swState });
        } else if (typeof Pusher !== 'undefined') {
          // Firefox: SW içi Pusher
          respond({ success: true, mode: 'sw', state: Pusher.getState(), swState });
        } else {
          respond({ success: false, error: 'Pusher mevcut değil' });
        }
      } catch (e) {
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }
  if (msg.type === 'GET_CHANNEL_START_TIME') {
    KickAPI.getChannelStartTime(msg.slug)
      .then(startTime => respond({ success: true, startTime }))
      .catch(() => respond({ success: false }));
    return true;
  }
  if (msg.type === 'GET_CHANNEL_LIVE_DETAILS') {
    KickAPI.getChannelLiveDetails(msg.slug)
      .then(details => respond({ success: true, details }))
      .catch(() => respond({ success: false }));
    return true;
  }
  if (msg.type === 'SET_ANOMALY_SETTINGS') {
    _spikeEnabled     = msg.settings?.spikeEnabled !== false;
    _spikeSensitivity = msg.settings?.spikeSensitivity || 'avg';
    _dropSensitivity  = msg.settings?.dropSensitivity  || 'avg';
    respond({ success: true });
    return false;
  }

  if (msg.type === 'GET_VIEWER_HISTORY') {
    Storage.getViewerHistory()
      .then(history => respond({ success: true, history: history[msg.slug] || null }))
      .catch(() => respond({ success: true, history: null }));
    return true;
  }

  if (msg.type === 'GET_VIEWER_ANOMALY') {
    getViewerAnomaly(msg.slug, msg.viewerCount, msg.startedAt)
      .then(anomaly => respond({ success: true, anomaly }))
      .catch(() => respond({ success: true, anomaly: null }));
    return true;
  }

  if (msg.type === 'GET_VIEWER_DROP') {
    Storage.getAnomalySettings()
      .then(settings => getViewerDrop(msg.slug, msg.viewerCount, msg.startedAt, settings))
      .then(drop => respond({ success: true, drop }))
      .catch(() => respond({ success: true, drop: null }));
    return true;
  }

  if (msg.type === 'CHAT_TAG_NOTIFICATION') {
    (async () => {
      try {
        await Utils.ensureI18n();
        // v2.5.98: duraklatma / kanal susturma chat bildirimlerini de kapsar
        const supC = await alertSuppressedFor(msg.channel || null);
        if (supC) { KLog.debug('PAU-13', `chat bildirimi atlandı (${supC})`); respond({ success: true, suppressed: supC }); return; }
        const isFirefox = IS_FIREFOX;
        const fromUser = msg.fromUser || 'Someone';
        const channel = msg.channel || '';
        const message = msg.message || '';
        const isReply = msg.isReply === true;

        // v2.5.23: Birine yanıt olarak gelen mesajlar, düz @etiketlemeden
        // ayrı bir başlıkla gösteriliyor - kullanıcı hangisi olduğunu
        // hemen anlasın (Mo'Kick'te de bu ayrım var).
        const title = isReply
          ? (Utils.i18n('chatReplyNotifTitle', [fromUser]) || `${fromUser} replied to you`)
          : (Utils.i18n('chatTagNotifTitle', [fromUser]) || `@${fromUser} mentioned you`);
        const body = (channel ? `[${channel}] ` : '') + message;

        const id = `kickalert-tag-${Date.now()}`;
        // v2.5.25: KRİTİK DÜZELTME. Ana "canlı yayın" bildirimleri
        // soundMode==='extension' iken silent:true kullanıyor (kendi sesimiz
        // çalacağı için Windows'un kendi bildirim sesi susturuluyor) - ama bu
        // TAG bildiriminde unutulmuş, hep silent:false kalmıştı.
        // v2.5.27: chatSettings'i (mentionSoundEnabled dahil) SİLENT
        // hesaplamasından ÖNCE okuyoruz - kullanıcı "sadece popup" seçtiyse,
        // sistem bildirimi de sessiz olmalı (yoksa bizim sesimiz çalmasa
        // bile Windows'un kendi varsayılan sesi çalıp "sessiz" isteğini
        // ihlal ederdi).
        // v2.5.30: Mo'Kick'in "Push Bildirimleri" / "Bildirim Sesi" ayrımından
        // esinlenerek, showPopupNotification (popup göster) ve
        // mentionSoundEnabled (ses çal) artık TAMAMEN BAĞIMSIZ iki eksen.
        const soundModeForTag = await Storage.getSoundMode();
        const chatSettingsForSound = await Storage.getChatSettings();
        const showPopup = chatSettingsForSound?.showPopupNotification !== false;
        const soundEnabled = chatSettingsForSound?.mentionSoundEnabled !== false;
        const smartMode = chatSettingsForSound?.mentionSoundSmart === true;
        // v2.5.30: Akıllı mod artık ÜÇ sinyali birlikte değerlendiriyor -
        // sekme arka planda, sohbet kaydırılmış, YA DA Kick'in kendi sohbet
        // paneli (theater/tam ekran modunda) kapalı - Mo'Kick'teki
        // "play_when_closed/scrolled" ayarlarının ikisini birden, TEK bir
        // "akıllı mod" checkbox'ı altında (özet kalması için) topluyoruz.
        const notWatching = msg.tabHidden === true || msg.chatScrolledUp === true || msg.chatHidden === true;

        if (showPopup) {
          const notifOptions = {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: title,
            message: body.substring(0, 200),
          };
          if (!isFirefox) {
            notifOptions.silent = !soundEnabled || soundModeForTag === 'extension';
            if (channel) {
              notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
            }
          }
          chrome.notifications.create(id, notifOptions);
        }
        // v2.5.22: Mo'Kick'ten ödünç alınan bahsedilme sesi - popup
        // gösterilsin ya da gösterilmesin, ses BAĞIMSIZ olarak çalabilir
        // (Mo'Kick'te de bu iki ayar birbirinden ayrı).
        if (soundEnabled && (!smartMode || notWatching)) {
          playSound('CHAT_MENTION');
        }

        // Track for click handling - reuse notifiedLives structure
        if (channel) {
          const state = await getPersistedState();
          state.notifiedLives[id] = {
            url: `https://kick.com/${channel}`,
            slug: channel,
            isTag: true,
          };
          await setPersistedNotifiedLives(state.notifiedLives);
        }

        respond({ success: true });
      } catch (e) {
        console.warn('[KickAlert] CHAT_TAG_NOTIFICATION error:', e);
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CHAT_BROADCASTER_NOTIFICATION') {
    (async () => {
      try {
        await Utils.ensureI18n();
        // v2.5.98: duraklatma / kanal susturma chat bildirimlerini de kapsar
        const supC = await alertSuppressedFor(msg.channel || null);
        if (supC) { KLog.debug('PAU-13', `chat bildirimi atlandı (${supC})`); respond({ success: true, suppressed: supC }); return; }
        const isFirefox = IS_FIREFOX;
        const fromUser = msg.fromUser || '';
        const channel = msg.channel || '';
        const message = msg.message || '';

        const title = Utils.i18n('chatBroadcasterNotifTitle', [fromUser || channel])
                      || `${fromUser || channel} wrote`;
        const body = message;

        const id = `kickalert-broadcaster-${Date.now()}`;
        // v2.5.25: Aynı düzeltme - kendi sesimizin Windows'un kendi bildirim
        // sesiyle çakışmaması için.
        // v2.5.27: chatSettings'i silent hesaplamasından ÖNCE oku - "sadece
        // popup" seçiliyse sistem bildirimi de sessiz olmalı.
        // v2.5.30: showPopupNotification ve chatHidden desteği (bkz. TAG handler).
        const soundModeForBroadcaster = await Storage.getSoundMode();
        const chatSettingsForSound2 = await Storage.getChatSettings();
        const showPopup2 = chatSettingsForSound2?.showPopupNotification !== false;
        const soundEnabled2 = chatSettingsForSound2?.mentionSoundEnabled !== false;
        const smartMode2 = chatSettingsForSound2?.mentionSoundSmart === true;
        const notWatching2 = msg.tabHidden === true || msg.chatScrolledUp === true || msg.chatHidden === true;

        if (showPopup2) {
          const notifOptions = {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/icon128.png'),
            title: title,
            message: body.substring(0, 200),
          };
          if (!isFirefox) {
            notifOptions.silent = !soundEnabled2 || soundModeForBroadcaster === 'extension';
            if (channel) {
              notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
            }
          }
          chrome.notifications.create(id, notifOptions);
        }
        // v2.5.22: Aynı bahsedilme sesi, yayıncı mesajı bildirimi için de.
        // v2.5.24: Akıllı mod kontrolü burada da aynı şekilde uygulanıyor.
        // v2.5.27: mentionSoundEnabled === false ise hiç ses çalınmıyor.
        if (soundEnabled2 && (!smartMode2 || notWatching2)) {
          playSound('CHAT_MENTION');
        }

        if (channel) {
          const state = await getPersistedState();
          state.notifiedLives[id] = {
            url: `https://kick.com/${channel}`,
            slug: channel,
            isBroadcaster: true,
          };
          await setPersistedNotifiedLives(state.notifiedLives);
        }

        respond({ success: true });
      } catch (e) {
        console.warn('[KickAlert] CHAT_BROADCASTER_NOTIFICATION error:', e);
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'TEST_NOTIFICATION') {
    // Test notification with buttons - uses first live channel or a fake one
    const testCh = cachedChannels.find(c => c.isLive) || {
      channelSlug: 'test-channel',
      userUsername: 'TestChannel',
      sessionTitle: 'Test notification - try Open & Mute buttons',
      profilePic: '',
    };
    const testNotifiedLives = {};
    sendNotification(testCh, testNotifiedLives, true);
    // Merge test entries into persisted state
    getPersistedState().then(async (state) => {
      Object.assign(state.notifiedLives, testNotifiedLives);
      await setPersistedNotifiedLives(state.notifiedLives);
    });
    respond({ success: true, channel: testCh.userUsername });
    return false;
  }

  // ─── Plan F E2E Test: Sahte StreamerIsLive event ile bildirim akışını test et ───
  // Gerçek bir kanalı yayın açmış gibi simüle eder - handlePusherLiveEvent'i
  // doğrudan çağırır. Bildirimin gidip gitmediğini, state'in doğru güncellenip
  // güncellenmediğini adım adım raporlar. Offscreen WebSocket'e DOKUNMAZ; sadece
  // SW-tarafı event işleme mantığını (handlePusherLiveEvent) test eder.
  if (msg.type === 'PUSHER_E2E_TEST') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      // Test slug'ı: gerçek kanallarla çakışmaması için belirgin bir test adı
      const testSlug = msg.slug || '__kickalert_test_channel__';
      try {
        // 1. Başlangıç state'i
        const before = await getPersistedState();
        const wasInLive = before.liveSlugs.has(testSlug);
        const wasPusherLive = _pusherLiveSlugs.has(testSlug);
        log('Başlangıç', 'ok', `liveSlugs'ta: ${wasInLive}, _pusherLiveSlugs'ta: ${wasPusherLive}`);

        // 2. baseline guard kontrolü - lastCheckDone yoksa bildirim gitmez
        if (!before.lastCheckDone) {
          log('Baseline', 'warn', 'lastCheckDone=false - gerçek bildirim için önce bir check çalışmalı (test yine de akışı dener)');
        } else {
          log('Baseline', 'ok', 'lastCheckDone=true - bildirim akışı aktif');
        }

        // 3. Sahte StreamerIsLive event'i kur (gerçek event formatı)
        const fakeLivestream = {
          livestream: {
            id: 999999999,
            channel_id: 999999999,
            session_title: msg.title || '[TEST] Plan F E2E bildirim testi',
            created_at: new Date().toISOString(), // şimdi → yaş guard'ına takılmaz
            viewer_count: 1,
            category: { name: 'Test' },
          },
        };
        log('Event Kur', 'ok', `Sahte StreamerIsLive: ${testSlug} (created_at=şimdi)`);

        // 4. handlePusherLiveEvent'i çağır (gerçek akış)
        const notifyMode = msg.dryRun ? '(dryRun - gerçek bildirim gönderilmeyecek)' : '(gerçek bildirim gönderilecek)';
        log('Akış', 'ok', `handlePusherLiveEvent çağrılıyor ${notifyMode}`);

        if (msg.dryRun) {
          // dryRun: state'i kirletmeden sadece guard mantığını kontrol et
          const dupCheck = before.liveSlugs.has(testSlug);
          log('DryRun Sonuç', 'ok', dupCheck ? 'Kanal zaten live → bildirim atlanırdı' : 'Kanal yeni → bildirim giderdi');
        } else {
          // Gerçek test: handlePusherLiveEvent, takip edilmeyen kanalları
          // (Bulgu#6 koruması) reddeder. Test kanalını GEÇİCİ olarak
          // cachedChannels'a ekleyip korumayı geçir, test sonunda tam temizle.
          const _testChInjected = !cachedChannels.some(c => c.channelSlug === testSlug);
          if (_testChInjected) {
            cachedChannels.push({
              channelSlug: testSlug,
              userUsername: testSlug,
              isLive: false,
              sessionTitle: '',
              profilePic: '',
            });
          }

          try {
            await handlePusherLiveEvent(testSlug, fakeLivestream);
            // 5. Sonuç state'i
            const after = await getPersistedState();
            const nowInLive = after.liveSlugs.has(testSlug);
            const nowPusherLive = _pusherLiveSlugs.has(testSlug);
            log('Sonuç State', nowInLive ? 'ok' : 'error',
                `liveSlugs'ta: ${nowInLive}, _pusherLiveSlugs'ta: ${nowPusherLive}`);

            // 6. Temizlik - test kanalını state'ten çıkar (gerçek kanalları etkileme)
            await handlePusherOfflineEvent(testSlug);
            const cleaned = await getPersistedState();
            log('Temizlik', !cleaned.liveSlugs.has(testSlug) ? 'ok' : 'warn',
                `Test kanalı temizlendi - offline event çalıştı: ${!cleaned.liveSlugs.has(testSlug)}`);
          } finally {
            // Geçici eklenen test kanalını cachedChannels'tan KESİNLİKLE çıkar
            if (_testChInjected) {
              const idx = cachedChannels.findIndex(c => c.channelSlug === testSlug);
              if (idx !== -1) cachedChannels.splice(idx, 1);
            }
            _unmarkPusherLive(testSlug); // garanti temizlik
          }
        }

        const allOk = results.every(r => r.status !== 'error');
        log('ÖZET', allOk ? 'ok' : 'error',
            allOk ? 'Plan F bildirim akışı çalışıyor ✓' : 'Akışta sorun var - adımları incele');
        respond({ success: allOk, results });
      } catch (e) {
        log('HATA', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ─── E2E Test: Gerçek akışı simüle et ───
  if (msg.type === 'E2E_TEST') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });

      try {
        // 1. API'den kanal listesi çek (diagnostic = cache bypass, gerçek API testi)
        // v2.3.1 fix: 'API Fetch: running' satırı sonuç satırıyla aynı isim taşıdığı için
        // canlı akışta iki satır gözüküyordu, ilki running takılı kalıyordu. Sadece sonuç.
        let channels;
        try {
          channels = await KickAPI.getAllFollowingChannels(true);
          log('API Fetch', 'ok', `${channels.length} channels returned, ${channels.filter(c => c.isLive).length} live`);
        } catch (e) {
          log('API Fetch', 'error', e.message);
          respond({ success: false, results });
          return;
        }

        // 2. Belirli kanalı bul (varsa)
        const targetSlug = msg.slug || null;
        const liveChannels = channels.filter(c => c.isLive);
        let targetCh = null;
        if (targetSlug) {
          targetCh = channels.find(c => c.channelSlug === targetSlug);
          if (!targetCh) {
            log('Channel Lookup', 'error', `"${targetSlug}" not in followed list`);
          } else {
            log('Channel Lookup', 'ok', `${targetCh.userUsername} - isLive: ${targetCh.isLive}, startedAt: ${targetCh.startedAt || 'null'}, viewers: ${targetCh.viewerCount}`);
          }
        } else {
          log('Channel List', 'ok', liveChannels.map(c => `${c.userUsername}(${c.viewerCount})`).join(', ') || 'No live channels');
        }

        // 3. State kontrol
        const state = await getPersistedState();
        log('State', 'ok', `liveSlugs: ${state.liveSlugs.size}, notifiedLives: ${Object.keys(state.notifiedLives).length}, lastCheckDone: ${state.lastCheckDone}`);

        // 4. Belirli kanal için karar simülasyonu
        if (targetCh) {
          const inLiveSlugs = state.liveSlugs.has(targetCh.channelSlug);
          log('liveSlugs Check', inLiveSlugs ? 'warn' : 'ok',
            inLiveSlugs ? `${targetSlug} is IN liveSlugs → counted as "already live", notification SKIPPED` : `${targetSlug} NOT in liveSlugs → new stream candidate`);

          if (!inLiveSlugs && targetCh.isLive) {
            // startedAt kontrolü
            if (targetCh.startedAt) {
              const streamAgeMs = Date.now() - new Date(targetCh.startedAt).getTime();
              const ageMin = Math.round(streamAgeMs / 60000);
              if (streamAgeMs > 10 * 60 * 1000) {
                log('startedAt Check', 'warn', `Stream started ${ageMin} min ago (>10min) → SKIP`);
              } else {
                log('startedAt Check', 'ok', `Stream started ${ageMin} min ago (<10min) → NOTIFY`);
              }
            } else {
              // API'den startTime sorgula
              log('startedAt', 'warn', 'startedAt null - querying API...');
              const apiTime = await KickAPI.getChannelStartTime(targetCh.channelSlug);
              if (apiTime) {
                const streamAgeMs = Date.now() - new Date(apiTime).getTime();
                const ageMin = Math.round(streamAgeMs / 60000);
                log('API startTime', ageMin > 10 ? 'warn' : 'ok',
                  `API startTime: ${apiTime} (${ageMin} min) → ${ageMin > 10 ? 'SKIP' : 'NOTIFY'}`);
              } else {
                log('API startTime', 'ok', 'API startTime null - counted as new stream → NOTIFY');
              }
            }

            // notifDelay kontrolü
            const notifDelay = await Storage.getNotifDelay();
            log('notifDelay', 'ok', `Delay setting: ${notifDelay} min`);

            // DND kontrolü
            const dndActive = await Storage.isDndActive();
            const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
            log('DND', dndActive ? 'warn' : 'ok',
              dndActive ? `DND ACTIVE - mute notification: ${dndMuteNotif}` : 'DND off');

            // Bildirim ayarı
            const showNotif = await Storage.getShowNotification();
            log('Notification Setting', showNotif ? 'ok' : 'warn',
              showNotif ? 'Notifications enabled' : 'Notifications DISABLED - will not send');

            // Suspend kontrolü
            const suspended = !!(await Storage.getSuspendFromDate());
            log('Suspend', suspended ? 'warn' : 'ok',
              suspended ? 'Extension suspended - will not notify' : 'Extension active');

            // i18n kontrolü
            await Utils.ensureI18n();
            const lang = Utils.getCurrentLang();
            const testTitle = Utils.i18n('notifStartedStreaming', [targetCh.userUsername]);
            log('i18n', 'ok', `Lang: ${lang} - Notification text: "${testTitle}"`);

            // Auto-launch kontrolü
            const autoOpen = await Storage.getAutoOpenChannels();
            const isAutoLaunch = !!(autoOpen && autoOpen[targetCh.channelSlug]);
            log('Auto-Launch', 'ok', isAutoLaunch ? `${targetSlug} auto-launch ON` : `${targetSlug} auto-launch off`);

            // Anomali kontrolü
            const anomalySettings = await Storage.getAnomalySettings();
            log('Anomaly', 'ok', `Anomaly: ${anomalySettings.enabled ? 'on' : 'off'}, Spike: ${anomalySettings.spikeSensitivity}, Drop: ${anomalySettings.dropEnabled ? anomalySettings.dropSensitivity : 'off'}`);
          }
        }

        // 5. viewerHistory durumu
        const vhData = await chrome.storage.local.get('viewerHistory');
        const vh = vhData.viewerHistory || {};
        const vhKeys = Object.keys(vh);
        const vhSummary = vhKeys.slice(0, 5).map(s => `${s}(c:${(vh[s].current||[]).length},p:${(vh[s].pastAvgs||[]).length})`).join(', ');
        log('viewerHistory', 'ok', `${vhKeys.length} channels: ${vhSummary}${vhKeys.length > 5 ? '...' : ''}`);

        respond({ success: true, results });
      } catch (e) {
        log('General Error', 'error', e.message + ' - ' + e.stack?.split('\n')[1]?.trim());
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v2.3.1 - 5 SENARYO HANDLER'I (Senaryo 3 = E2E_TEST yukarıda)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── SENARYO 1: SAĞLIK KONTROLÜ ───
  // Bağlantı, auth, hız ve cookie sağlığını ardışık ölçer.
  // v2.5.93 (b039): Kick uyumluluk kontrolü. Eklentinin dayandığı Kick
  // yapılarını tek tek yoklar: gerçek zamanlı sağlayıcı pazarlığı, etkin
  // bağlantı ve olay akışı, web.kick.com herkese açık uçları, kanal yayın
  // nesnesi (playback_url) ve açık bir kanal sekmesinde sohbet/reklam DOM'u.
  if (msg.type === 'RUN_SCENARIO_KICK_COMPAT') {
    (async () => {
      const results = []; const start = Date.now();
      const log = (step, status, detail) => results.push({ step, status, detail });
      const negotiate = async (provs) => {
        const r = await fetch(KICK_REALTIME_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
          body: JSON.stringify({ client: { id: crypto.randomUUID(), type: 'web' }, capabilities: { accepted_providers: provs.map(p => ({ provider: p })) } }) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        return (j && j.data && Array.isArray(j.data.connections)) ? j.data.connections : [];
      };
      try {
        const c1 = await negotiate(['pusher']);
        const p = c1.find(c => c.provider === 'pusher');
        const key = p && p.credentials && (p.credentials.app_key || p.credentials.key);
        log('Kick Pusher sunuyor mu', p ? 'ok' : 'error', p ? `Evet · anahtar ${key || '?'}${key && key !== KAPusherCfg.key ? ` (kullanılan ${KAPusherCfg.key}; bir sonraki yenilemede güncellenir)` : ''}` : `Hayır · sunulan: ${c1.map(c => c.provider).join(', ') || 'yok'}. Centrifugo yedeği gerekir`);
      } catch (e) { log('Kick Pusher sunuyor mu', 'warn', 'Sorulamadı: ' + e.message); }
      try {
        const c2 = await negotiate(['pusher', 'centrifugo']);
        const cf = c2.find(c => c.provider === 'centrifugo');
        const url = cf && cf.credentials && cf.credentials.url;
        log('Centrifugo adresi', url && KA_CF_URL_RE.test(url) ? 'ok' : 'warn', url ? (KA_CF_URL_RE.test(url) ? url : `Beklenmeyen biçim: ${url}`) : 'Kick Centrifugo adresi vermedi');
      } catch (e) { log('Centrifugo adresi', 'warn', 'Sorulamadı: ' + e.message); }
      const perm = await rtFallbackPermitted();
      const st = await chrome.storage.local.get(['_rtHealth', '_rtFallbackNeeded']);
      log('Etkin bağlantı', 'ok', KAPusherCfg.provider === 'centrifugo' ? `Centrifugo yedeği (${KAPusherCfg.cfUrl})` : `Pusher (${KAPusherCfg.key})`);
      log('Yedek izni (*.kick.com)', perm ? 'ok' : (st._rtFallbackNeeded ? 'error' : 'ok'), perm ? 'Verilmiş: gerekirse yedeğe kendiliğinden geçilir' : (st._rtFallbackNeeded ? 'Yedek gerekiyor ama izin yok: popup izni istiyor' : 'Verilmemiş (şu an gerekmiyor)'));
      const h = st._rtHealth;
      if (h && h.checkedAt) {
        const lbl = { ok: 'Olaylar geliyor', partial: 'Bazı kanallar sessiz', silent: 'Hiç olay gelmiyor', unknown: 'Ölçülecek kalabalık kanal yok' }[h.state] || h.state;
        log('Olay akışı (sessizlik bekçisi)', h.state === 'silent' ? 'error' : h.state === 'partial' ? 'warn' : 'ok', `${lbl} · ${h.eligible} kanal ölçüldü${h.silent && h.silent.length ? ' · sessiz: ' + h.silent.join(', ') : ''} · ${Math.round((Date.now() - h.checkedAt) / 1000)} sn önce`);
      } else log('Olay akışı (sessizlik bekçisi)', 'ok', 'Henüz ölçülmedi (canlı kanal yok ya da yeni başladı)');
      // web.kick.com uçları ve yayın nesnesi: canlı bir takip edilen kanal üzerinden
      const live = (cachedChannels || []).filter(c => c.isLive).sort((a, b) => (b.viewerCount || 0) - (a.viewerCount || 0));
      let idCache = {}; try { idCache = await Storage.getChannelIdCache(); } catch (e) {}
      const probe = live.find(c => idCache[c.channelSlug] > 0);
      if (!probe) {
        log('web.kick.com uçları', 'ok', 'Kimliği bilinen canlı kanal yok; atlandı');
      } else {
        const id = idCache[probe.channelSlug];
        KickAPI._webPublicOffUntil = 0;
        const s1 = await KickAPI.fetchWebPublic(`https://web.kick.com/api/v1/channels/${id}/chat/settings`);
        const d1 = s1 && s1.data;
        const need = ['slow_mode', 'subscribers_only_mode', 'followers_only_mode', 'emotes_only_mode'];
        const miss = d1 ? need.filter(k => !(k in d1)) : need;
        log('Sohbet ayarları ucu', d1 && !miss.length ? 'ok' : 'warn', d1 ? (miss.length ? `${probe.channelSlug}: eksik alan ${miss.join(', ')}` : `${probe.channelSlug}: tüm modlar okunuyor`) : `${probe.channelSlug}: yanıt yok`);
        KickAPI._webPublicOffUntil = 0;
        const s2 = await KickAPI.fetchWebPublic(`https://web.kick.com/api/v1/channels/${id}/chat/active-chatters`);
        const n = s2 && s2.data && s2.data.total_count;
        log('Aktif sohbetçi ucu', typeof n === 'number' ? 'ok' : 'warn', typeof n === 'number' ? `${probe.channelSlug}: ${n} aktif sohbetçi (${probe.viewerCount || 0} izleyici)` : `${probe.channelSlug}: total_count yok`);
      }
      if (live.length) {
        try {
          const r = await KickAPI.fetchKick(`https://kick.com/api/v2/channels/${live[0].channelSlug}`);
          const j = await r.json();
          log('Kanal nesnesi (playback_url, sohbet odası)', j && j.playback_url && j.chatroom && j.chatroom.id ? 'ok' : 'warn', `${live[0].channelSlug}: playback_url ${j && j.playback_url ? 'var' : 'YOK'}, chatroom ${j && j.chatroom && j.chatroom.id ? 'var' : 'YOK'}`);
        } catch (e) { log('Kanal nesnesi (playback_url, sohbet odası)', 'warn', 'Okunamadı: ' + e.message); }
      }
      // Açık bir kanal sekmesinde DOM
      let tab = null;
      try { tab = (await chrome.tabs.query({ url: 'https://kick.com/*' })).find(t => t.url && /^https:\/\/kick\.com\/[A-Za-z0-9_-]+\/?(\?.*)?$/.test(t.url)); } catch (e) {}
      if (!tab) {
        log('Sohbet ve oynatıcı DOM', 'ok', 'Açık kanal sekmesi yok; bir kanal sayfası açıp tekrar çalıştırın');
      } else {
        try {
          const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({
            root: !!document.querySelector('#chatroom-messages'),
            msg: document.querySelectorAll('#chatroom-messages [data-index]').length,
            user: !!document.querySelector('#chatroom-messages button.font-bold'),
            chatAttr: !!document.querySelector('[data-chat]'),
            video: !!document.querySelector('video'),
          }) });
          const v = res && res.result || {};
          const ok = v.root && v.msg > 0 && v.user;
          log('Sohbet ve oynatıcı DOM', ok ? 'ok' : (v.root ? 'warn' : 'error'), `${tab.url.replace('https://kick.com/', '')}: sohbet kökü ${v.root ? 'var' : 'YOK'}, mesaj ${v.msg || 0}, kullanıcı adı düğmesi ${v.user ? 'var' : 'YOK'}, data-chat ${v.chatAttr ? 'var' : 'yok'}, video ${v.video ? 'var' : 'yok'}`);
        } catch (e) { log('Sohbet ve oynatıcı DOM', 'warn', 'Sekmede çalıştırılamadı: ' + e.message); }
      }
      const bad = results.filter(r => r.status === 'error').length;
      if (bad) KLog.warn('CMP-01', `Kick uyumluluk kontrolü: ${bad} sorun · ${results.filter(r => r.status === 'error').map(r => r.step).join(', ')}`);
      respond({ success: true, results, totalMs: Date.now() - start });
    })().catch(e => respond({ success: false, error: e.message }));
    return true;
  }

  if (msg.type === 'RUN_SCENARIO_HEALTH') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();

      try {
        // 1. DNR ruleset aktif mi?
        // v2.3.1 fix: Eskiden ruleset ID'si 'origin_override' veya 'rules' diye sabit
        // arayordu. Manifest'te ID 'ruleset_1' ama yarın değişebilir. En az 1 enabled
        // ruleset varsa OK kabul et - gerçek dünya kanıtı bu yeterli.
        try {
          const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
          if (enabled.length > 0) {
            log('DNR Origin Override', 'ok', `Aktif rulesets: ${enabled.join(', ')}`);
          } else {
            log('DNR Origin Override', 'error', 'Hiçbir ruleset aktif değil - Cloudflare 403 yağmuru riski');
          }
        } catch (e) {
          log('DNR Origin Override', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 2. Session token mevcut mu?
        const token = await KickAPI.getSessionToken();
        log('Session Token', token ? 'ok' : 'warn',
          token ? `Token bulundu (${token.length} karakter)` : 'Token YOK - kick.com\'a giriş yapılmalı');

        // 3. Cookie durumu
        const cookies = await chrome.cookies.getAll({ domain: 'kick.com' });
        const cfBm = cookies.find(c => c.name === '__cf_bm');
        const cfClear = cookies.find(c => c.name === 'cf_clearance');
        const cfBmRemMin = cfBm?.expirationDate ? Math.round((cfBm.expirationDate * 1000 - Date.now()) / 60000) : null;
        log('Cookies', cfBm ? 'ok' : 'warn',
          `${cookies.length} cookie · __cf_bm: ${cfBm ? cfBmRemMin + 'dk' : 'YOK'} · cf_clearance: ${cfClear ? 'var' : 'yok'}`);

        // 4. Backoff durumu
        if (KickAPI._loadBackoffFromStorage) await KickAPI._loadBackoffFromStorage();
        const boRemain = Math.max(0, (KickAPI._lastBackoffUntil || 0) - Date.now());
        log('Backoff', boRemain > 0 ? 'warn' : 'ok',
          boRemain > 0 ? `Aktif - ${Math.round(boRemain/1000)}sn kaldı` : 'Temiz');

        // 5. Tek API testi (gerçek istek, response time)
        const apiStart = Date.now();
        try {
          // Backoff aktifken normal fetchKick reddeder; geçici bypass için doğrudan fetch yapalım
          if (boRemain > 0) {
            log('API Test', 'warn', 'Backoff aktif - gerçek istek atılmadı (recovery mekanizması bekleniyor)');
          } else {
            const resp = await KickAPI.fetchKick(KickAPI.API_URL);
            const data = await resp.json();
            const ms = Date.now() - apiStart;
            const live = (data?.channels || []).filter(c => c.is_live).length;
            log('API Test', 'ok', `HTTP ${resp.status} (${ms}ms) · ${(data?.channels || []).length} kanal, ${live} canlı`);
          }
        } catch (e) {
          log('API Test', 'error', e.message);
        }

        // 6. Son 5dk başarı oranı
        const stats = KickAPI.getRecentApiStats(5 * 60 * 1000);
        if (stats.requests === 0) {
          log('Son 5dk Stats', 'ok', 'Henüz istek yok (yeni başlatma)');
        } else {
          const status = stats.successRate >= 90 ? 'ok' : stats.successRate >= 50 ? 'warn' : 'error';
          log('Son 5dk Stats', status,
            `${stats.successes}/${stats.requests} (${stats.successRate}%) · ${stats.failures} hata · jitter ort: ${stats.avgJitterMs}ms`);
        }

        // 7. Alarm zamanlaması
        const alarm = await chrome.alarms.get(ALARM_NAME);
        const refreshAlarm = await chrome.alarms.get(SESSION_REFRESH_ALARM);
        const alarmOk = alarm && refreshAlarm;
        log('Alarms', alarmOk ? 'ok' : 'error',
          alarm ? `Ana alarm: her ${(alarm.periodInMinutes * 60).toFixed(0)}sn · Refresh alarm: ${refreshAlarm ? 'OK' : 'YOK'}` : 'Ana alarm zamanlanmamış');

        // 8. Plan C - Content Script Proxy hazır mı?
        try {
          const proxyAvail = await KickAPI.hasProxyTab();
          const proxyStats = KickAPI.getProxyStats();
          if (!proxyAvail) {
            log('Plan C Proxy', 'warn',
              `Açık kick.com sekmesi yok - istekler SW üzerinden gidiyor (CF baskısına açık)`);
          } else {
            // Tab var ama fail oranı yüksek mi? (eski content script senaryosu)
            const totalAttempts = proxyStats.hits + proxyStats.fails;
            const failRate = totalAttempts > 0 ? Math.round((proxyStats.fails / totalAttempts) * 100) : 0;
            if (totalAttempts >= 5 && failRate >= 30) {
              log('Plan C Proxy', 'warn',
                `Tab var ama %${failRate} fail (${proxyStats.fails}/${totalAttempts}) - kick.com sekmesini Ctrl+R ile yenile (eski content script)`);
            } else {
              log('Plan C Proxy', 'ok',
                `Aktif kick.com sekmesi · Hits: ${proxyStats.hits} · Misses: ${proxyStats.misses} · Fails: ${proxyStats.fails}` +
                (totalAttempts > 0 ? ` · Başarı: %${100 - failRate}` : ' · henüz istek yok'));
            }
          }
        } catch (e) {
          log('Plan C Proxy', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 9. Plan B - Savunma katmanları (jitter + dinamik yavaşlatma + peak saat)
        try {
          const peak = isPeakHour();
          const effSecs = _currentEffectiveSecs || 0;
          const baseSecs = (await Storage.getCheckInterval()) || 60;
          const slowed = effSecs > baseSecs;
          const detail = `Aralık: ${effSecs}s (baz ${baseSecs}s)`
            + ` · Peak saat: ${peak ? 'EVET (1.5x)' : 'hayır'}`
            + ` · Dinamik yavaşlatma: ${slowed ? 'AKTİF' : 'yok'}`
            + ` · Jitter: aktif`;
          log('Plan B (Savunma)', 'ok', detail);
        } catch (e) {
          log('Plan B (Savunma)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 10. Plan D - Minimal header reversal (3 header modu doğrulama)
        try {
          const hdrs = await KickAPI.makeHeaders('sw');
          const keys = Object.keys(hdrs);
          const hasAccept = 'Accept' in hdrs;
          const hasPlatform = 'X-App-Platform' in hdrs;
          const hasAuth = keys.some(k => k.toLowerCase() === 'authorization');
          const ok3 = hasAccept && hasPlatform; // Authorization token yoksa da olabilir
          log('Plan D (Min. Header)', ok3 ? 'ok' : 'warn',
            `${keys.length} header · Accept:${hasAccept ? '✓' : '✗'} · X-App-Platform:${hasPlatform ? '✓' : '✗'} · Authorization:${hasAuth ? '✓' : '-'}`);
        } catch (e) {
          log('Plan D (Min. Header)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 11. Plan E - Pusher state yönetimi (#C/#D/#E fix) + log temizliği
        try {
          const pusherLiveCount = _pusherLiveSlugs.size;
          log('Plan E (State+Log)', 'ok',
            `Pusher-canlı işaretli: ${pusherLiveCount} kanal · DEBUG modu: ${DEBUG_MODE ? 'AÇIK' : 'kapalı (prod)'} · _pusherLiveSlugs union aktif`);
        } catch (e) {
          log('Plan E (State+Log)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 12. Plan F - Pusher WebSocket durumu (offscreen LiveTracker)
        try {
          let pusherOk = false, pusherDetail = '';
          if (chrome.offscreen) {
            await startOffscreen();
            const resp2 = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'LIVE_GET_STATE' });
            const st = resp2?.state;
            pusherOk = !!st?.connected;
            pusherDetail = st
              ? `${st.connected ? '🟢 bağlı' : '🔴 kopuk'} · ${st.trackedCount || 0} kanal dinleniyor · ${st.subscribedCount || 0} subscribe`
              : 'offscreen yanıt vermedi';
          } else if (typeof Pusher !== 'undefined') {
            const st = Pusher.getState();
            pusherOk = !!st?.connected;
            pusherDetail = `${st?.connected ? '🟢 bağlı' : '🔴 kopuk'} (SW modu/Firefox)`;
          }
          log('Plan F (Pusher WS)', pusherOk ? 'ok' : 'warn', pusherDetail);
        } catch (e) {
          log('Plan F (Pusher WS)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        const totalMs = Date.now() - start;
        respond({ success: true, results, totalMs });
      } catch (e) {
        log('General Error', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ─── v2.5.61: SENARYO - KANAL OLAYLARI (değişim, yayın bitti, raid, filtre, izleme süresi) ───
  // Gerçek fonksiyonları ayrı bir test kanalıyla (__katest__) çalıştırır; gerçek
  // kanalların kayıtlarına dokunmamak için ilgili depolar önce yedeklenir, test
  // bitince geri yüklenir. Test bildirimleri gerçekten gösterilir.
  if (msg.type === 'RUN_SCENARIO_CHANNEL_EVENTS') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();
      const T = '__katest__';
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const histOf = async (kind) => ((await Storage.getNotificationHistory()) || []).filter(e => e.channelSlug === T && (!kind || e.kind === kind));
      const soundMode = await Storage.getSoundMode();
      const ctx = { isStale: false, showNotif: true, dndMuteNotif: false, soundMode };
      const nl = {};
      const metaBackup = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {};
      const endBackup = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
      try {
        // 1) Kanal tercihi yaz/oku
        await Storage.updateChannelAlertPref(T, { change: true, end: true, raid: true });
        const p = await Storage.getChannelAlertPref(T);
        log('Kanal tercihi', p.change && p.end && p.raid ? 'ok' : 'error', `Yazılan: değişim/bitiş/raid açık → okunan: ${JSON.stringify(p)}`);

        // 2) Filtre mantığı (gerçek matchChannelFilter)
        const cases = [
          [{}, 'Slots', 'x', true, 'filtre yok → geçer'],
          [{ cats: ['Just Chatting'] }, 'just chatting', 'x', true, 'büyük/küçük harf'],
          [{ cats: ['Slots'] }, 'GTA V', 'x', false, 'kategori uymuyor'],
          [{ words: ['istanbul'] }, 'x', 'İSTANBUL turu', true, 'Türkçe İ'],
          [{ words: ['kopru'] }, 'x', 'Köprü yayını', true, 'aksan (ö→o, ü→u)'],
          [{ words: ['turnuva'] }, 'x', 'sohbet', false, 'kelime yok'],
          [{ cats: ['Slots'], words: ['bonus'] }, 'Slots', 'bonus hunt', true, 'ikisi birden'],
          [{ cats: ['Slots'] }, '', 'x', true, 'kategori bilinmiyor → geçer'],
        ];
        const bad = cases.filter(([pref, c, t, exp]) => matchChannelFilter(pref, c, t).pass !== exp).map(x => x[4]);
        log('Filtre mantığı', bad.length ? 'error' : 'ok', bad.length ? `Hatalı: ${bad.join(', ')}` : `${cases.length}/${cases.length} durum doğru (harf, Türkçe İ, aksan, boş kategori)`);

        // 3) Kategori / başlık değişimi (gerçek checkChannelMetaChanges)
        const s0 = new Date(Date.now() - 3600e3).toISOString();
        const mk = (c, t, s) => ({ channelSlug: T, userUsername: 'KickAlert Test', isLive: true, startedAt: s, categoryName: c, sessionTitle: t, profilePic: '' });
        await checkChannelMetaChanges([mk('Just Chatting', 'Test yayını', s0)], nl, ctx);
        let m = ((await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {})[T];
        log('Değişim takibi: ilk gözlem', m && !m.off && m.c === 'Just Chatting' ? 'ok' : 'error',
          m ? `Kaydedildi: "${m.c}" · başlangıç ${m.s ? 'var' : 'yok'} · bildirim yok (beklenen)` : 'Kayıt oluşmadı');
        await checkChannelMetaChanges([mk('Slots', 'Test yayını', null)], nl, ctx);
        m = ((await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {})[T];
        log('Tek okuma bildirim üretmez', Object.keys(nl).length === 0 && m?.pc === 'Slots' && m?.pcn === 1 ? 'ok' : 'error',
          Object.keys(nl).length === 0 ? `İlk okumada aday kaydedildi (${m?.pcn}/${CHANGE_CONFIRM_POLLS}), bildirim yok (beklenen)` : 'Tek okumada bildirim gitti');
        // ikinci okuma: adayın ilk görülme anını geri al (gerçekte bir sonraki kontrol)
        { const all = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {}; if (all[T]) { all[T].pca -= CHANGE_CONFIRM_MIN_MS + 1000; all[T].at = Date.now(); await chrome.storage.local.set({ [CHANGE_META_KEY]: all }); } }
        await checkChannelMetaChanges([mk('Slots', 'Test yayını', null)], nl, ctx);
        m = ((await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {})[T];
        const chgIds = Object.keys(nl);
        log('Kategori değişimi (başlangıç saati boş)', chgIds.length === 1 && m?.c === 'Slots' ? 'ok' : 'error',
          chgIds.length === 1 ? 'Just Chatting → Slots bildirimi gönderildi (ekranda görünmeli)' : `Bildirim sayısı: ${chgIds.length}`);
        log('Başlangıç saati taşındı', m?.s === s0 ? 'ok' : 'warn', m?.s === s0 ? 'Aynı yayın olarak tanındı' : `s=${m?.s}`);
        await checkChannelMetaChanges([mk('Slots', 'Yeni başlık', null)], nl, ctx);
        { const all = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {}; if (all[T]) { all[T].pta -= CHANGE_CONFIRM_MIN_MS + 1000; await chrome.storage.local.set({ [CHANGE_META_KEY]: all }); } }
        await checkChannelMetaChanges([mk('Slots', 'Yeni başlık', null)], nl, ctx);
        m = ((await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {})[T];
        log('Bekleme süresi (5 dk)', Object.keys(nl).length === 1 && m?.nt === 'Test yayını' && m?.pt === 'Yeni başlık' ? 'ok' : 'error',
          Object.keys(nl).length === 1 ? 'Doğrulanan başlık değişimi bekleme süresinde tutuldu, süre dolunca bildirilecek' : 'Bekleme süresine rağmen ikinci bildirim gitti');

        // 4) Yayın bitti (gerçek addStreamEndCandidate + processStreamEndCandidates)
        await chrome.storage.local.set({ [END_PENDING_KEY]: {} }); // gerçek adaylar test sırasında işlenmesin
        await addStreamEndCandidate(T, 'test');
        let es = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
        log('Yayın bitti: aday', es[T] ? 'ok' : 'error', es[T] ? `Aday oluştu · başlangıç ${es[T].startedAt ? 'biliniyor' : 'yok'} · başlık "${es[T].title}"` : 'Aday oluşmadı');
        await processStreamEndCandidates([], new Set(), nl, ctx);
        es = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
        log('Yayın bitti: 2,5 dk doğrulama', es[T] ? 'ok' : 'error', es[T] ? 'Doğrulama süresi dolmadan bildirim gitmedi' : 'Aday erken düştü');
        if (es[T]) { es[T].since -= END_CONFIRM_MS + 1000; await chrome.storage.local.set({ [END_PENDING_KEY]: es }); }
        const before = Object.keys(nl).length;
        await processStreamEndCandidates([], new Set(), nl, ctx);
        await sleep(300);
        const endH = await histOf('end');
        log('Yayın bitti: bildirim', Object.keys(nl).length === before + 1 ? 'ok' : 'error',
          Object.keys(nl).length === before + 1 ? `Gönderildi · süre: ${endH[0]?.length || 'yok'}` : 'Bildirim gitmedi');
        log('Yayın bitti: süre', endH[0]?.length ? 'ok' : 'error', endH[0]?.length ? `Geçmişe "${endH[0].length}" yazıldı` : 'Süre hesaplanamadı');
        // geri gelirse iptal
        await addStreamEndCandidate(T, 'test');
        await processStreamEndCandidates([], new Set([T]), nl, ctx);
        es = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
        log('Yayın bitti: geri dönüş', !es[T] ? 'ok' : 'error', !es[T] ? 'Kanal tekrar canlı → aday iptal edildi' : 'Aday iptal edilmedi');

        // 5) Raid (gerçek handleRaidEvent: 4 sn birleştirme + 10 dk tekrar önleme)
        const seen = (await chrome.storage.local.get(RAID_SEEN_KEY))[RAID_SEEN_KEY] || {};
        delete seen[T]; await chrome.storage.local.set({ [RAID_SEEN_KEY]: seen });
        const r1 = handleRaidEvent({ slug: T, raider: 'TestRaider', viewers: null });
        const r2 = handleRaidEvent({ slug: T, raider: 'TestRaider', viewers: 123, message: 'test raid' });
        await Promise.all([r1, r2]);
        await sleep(300);
        let raidH = await histOf('raid');
        log('Raid: iki olay birleştirme', raidH.length === 1 && raidH[0].viewers === 123 ? 'ok' : 'error',
          raidH.length ? `Tek bildirim · gönderen ${raidH[0].raider} · ${raidH[0].viewers ?? '?'} izleyici` : 'Raid bildirimi oluşmadı');
        await processRaidEvent({ slug: T, raider: 'TestRaider', viewers: 50 });
        await sleep(300);
        raidH = await histOf('raid');
        log('Raid: 10 dk tekrar önleme', raidH.length === 1 ? 'ok' : 'error', raidH.length === 1 ? 'Aynı kanala ikinci raid bildirimi gitmedi' : 'Tekrar bildirimi gitti');

        // 6) İzleme süresi (gerçek addWatchTime)
        _watchLastTick.delete(T);
        addWatchTime(T, 30);
        await _watchChain;
        const wt = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY] || { days: {} };
        const today = wt.days?.[localDayKey()]?.[T] || 0;
        log('İzleme süresi: tik', today === 30 ? 'ok' : 'error', `Bugün ${today} sn yazıldı (beklenen 30)`);
        addWatchTime(T, 30);
        await _watchChain;
        const wt2 = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY] || { days: {} };
        log('İzleme süresi: çift sekme koruması', (wt2.days?.[localDayKey()]?.[T] || 0) === 30 ? 'ok' : 'error', '20 sn içindeki ikinci tik sayılmadı');
        const watchOn = await Storage.getWatchTimeEnabled();
        log('İzleme süresi ayarı', watchOn ? 'ok' : 'warn', watchOn ? 'Açık' : 'Kapalı (Ayarlar → İzleme süresi); içerik betiği tik göndermez');
      } catch (e) {
        log('Genel hata', 'error', e.message);
      } finally {
        // Temizlik: test kanalının tüm izleri
        try {
          await Storage.updateChannelAlertPref(T, { change: false, end: false, raid: false, host: false, cats: [], words: [] });
          const curMeta = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {};
          const restoredMeta = { ...curMeta, ...metaBackup }; delete restoredMeta[T];
          const curEnd = (await chrome.storage.local.get(END_PENDING_KEY))[END_PENDING_KEY] || {};
          const restoredEnd = { ...curEnd, ...endBackup }; delete restoredEnd[T];
          const seen = (await chrome.storage.local.get(RAID_SEEN_KEY))[RAID_SEEN_KEY] || {}; delete seen[T];
          const wt = (await chrome.storage.local.get(WATCH_KEY))[WATCH_KEY];
          if (wt?.days) for (const d of Object.values(wt.days)) delete d[T];
          await chrome.storage.local.set({ [CHANGE_META_KEY]: restoredMeta, [END_PENDING_KEY]: restoredEnd, [RAID_SEEN_KEY]: seen, ...(wt ? { [WATCH_KEY]: wt } : {}) });
          _watchLastTick.delete(T);
          await _withKeyLock(StorageKeys.NOTIFICATION_HISTORY, async () => {
            const h = (await Storage.getNotificationHistory()) || [];
            await Storage.set(StorageKeys.NOTIFICATION_HISTORY, h.filter(e => e.channelSlug !== T));
          });
          const left = (await Storage.getChannelAlertPrefs())[T];
          log('Temizlik', left ? 'warn' : 'ok', 'Test kanalının tercih, takip, aday, raid, izleme ve geçmiş kayıtları silindi; gerçek kanal kayıtları geri yüklendi');
        } catch (e) {
          log('Temizlik', 'warn', e.message);
        }
        respond({ success: true, results, totalMs: Date.now() - start });
      }
    })();
    return true;
  }

  // v2.5.61: Test paneli - bir kanalın filtresini örnek kategori/başlıkla dene
  // v2.5.63: Ayarlar'daki olay sesi "Test" butonu (seçili ses + seviye)
  if (msg.type === 'PLAY_EVENT_SOUND_TEST') {
    if (msg.sound === 'windows') {
      // Windows sesi ancak gerçek bir bildirimle duyulur: sesli örnek bildirim
      (async () => {
        await Utils.ensureI18n();
        chrome.notifications.create(`kickalert-evtest-${Date.now()}`, {
          type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: 'KickAlert', message: Utils.i18n('eventSoundWindowsTest') || 'Sample channel event alert (system sound)',
          ...(!IS_FIREFOX ? { silent: false } : {}),
        });
      })().catch(() => {});
    } else {
      playEventSoundFile(msg.sound, msg.volume);
    }
    return false;
  }

  if (msg.type === 'TEST_CHANNEL_FILTER') {
    Storage.getChannelAlertPref(msg.slug || '').then(pref => {
      respond({ success: true, pref, result: matchChannelFilter(pref, msg.category, msg.title) });
    }).catch(e => respond({ success: false, error: e.message }));
    return true;
  }

  // v2.5.61: Test paneli - gerçek bir kanalda bir sonraki kontrolde kategori
  // değişim bildirimi tetikle (son görülen kategori geçici bir değerle değiştirilir).
  if (msg.type === 'SIMULATE_CATEGORY_CHANGE') {
    (async () => {
      const slug = msg.slug;
      const pref = await Storage.getChannelAlertPref(slug);
      const all = (await chrome.storage.local.get(CHANGE_META_KEY))[CHANGE_META_KEY] || {};
      const m = all[slug];
      if (!pref.change) return respond({ success: false, error: 'Bu kanalda "kategori veya başlık değişince" kapalı' });
      if (!m || m.off) return respond({ success: false, error: 'Kanal şu an takipte değil (canlı görülmemiş)' });
      // v2.5.77: bildirilen kategori test değeriyle değiştirilir ve gerçek kategori
      // bir kez görülmüş aday olarak işaretlenir; böylece zorlanan kontrol ikinci
      // okuma sayılır ve bildirim gider (gerçek akıştaki 2 okuma doğrulamasıyla aynı yol)
      const real = m.c || '';
      m.nc = '(test) Önceki kategori'; m.nt = m.t || '';
      m.pc = real; m.pcn = real ? 1 : 0; m.pca = Date.now() - CHANGE_CONFIRM_MIN_MS - 1000;
      m.pt = ''; m.ptn = 0; m.pta = 0;
      m.n = 0; m.at = Date.now();
      await chrome.storage.local.set({ [CHANGE_META_KEY]: all });
      respond({ success: true });
    })().catch(e => respond({ success: false, error: e.message }));
    return true;
  }

  // ─── SENARYO 2: BİLDİRİM PIPELINE ───
  if (msg.type === 'RUN_SCENARIO_NOTIFICATION') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();

      try {
        // 1. Notification permission
        const permLevel = await new Promise(r => {
          try { chrome.notifications.getPermissionLevel(level => r(level)); }
          catch { r('unknown'); }
        });
        log('Notification Permission', permLevel === 'granted' ? 'ok' : 'warn',
          `Seviye: ${permLevel}`);

        // 2. Bildirim ayarları
        const showNotif = await Storage.getShowNotification();
        log('Bildirim Ayarı', showNotif ? 'ok' : 'warn',
          showNotif ? 'Bildirimler açık' : 'Bildirimler KAPALI (ayarlardan açılmalı)');

        // 3. Ses ayarı
        const soundMode = await Storage.getSoundMode();
        const volume = await Storage.getSoundVolume();
        log('Ses Ayarı', 'ok', `Mod: ${soundMode} · Volume: ${volume}%`);

        // 4. Test bildirim gönder
        try {
          await self.testNotification();
          log('Test Bildirimi', 'ok', 'Offscreen üzerinden test bildirimi gönderildi (ekranda görünmeli)');
        } catch (e) {
          log('Test Bildirimi', 'error', e.message);
        }

        // 5. DND kontrolü
        const dndActive = await Storage.isDndActive();
        const dndMuteN = dndActive && await Storage.getDndMuteNotif();
        const dndMuteS = dndActive && await Storage.getDndMuteSound();
        log('DND', dndActive ? 'warn' : 'ok',
          dndActive ? `AKTIF - bildirim mute: ${dndMuteN}, ses mute: ${dndMuteS}` : 'Pasif');

        // 6. Avatar cache
        const avatarCount = Object.keys(avatarCache || {}).length;
        log('Avatar Cache', 'ok', `${avatarCount}/${AVATAR_CACHE_MAX} avatar cache'lendi`);

        // 7. Anomali ayarları
        const anom = await Storage.getAnomalySettings();
        log('Anomali Ayarları', 'ok',
          `Anomali: ${anom.enabled ? 'on' : 'off'} · Artış: ${anom.spikeSensitivity} · Düşüş: ${anom.dropEnabled ? anom.dropSensitivity : 'off'}`);

        // 8. Notification delay
        const delay = await Storage.getNotifDelay();
        log('Bildirim Gecikme', 'ok', `${delay} saniye gecikme ayarlı`);

        const totalMs = Date.now() - start;
        respond({ success: true, results, totalMs });
      } catch (e) {
        log('General Error', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ─── SENARYO 4: GERİ KURTARMA TESTİ ───
  if (msg.type === 'RUN_SCENARIO_RECOVERY') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();

      try {
        // 1. Mevcut backoff durumu
        if (KickAPI._loadBackoffFromStorage) await KickAPI._loadBackoffFromStorage();
        const boRemain = Math.max(0, (KickAPI._lastBackoffUntil || 0) - Date.now());
        log('Mevcut Backoff', boRemain > 0 ? 'warn' : 'ok',
          boRemain > 0 ? `Aktif - ${Math.round(boRemain/1000)}sn kaldı` : 'Temiz (recovery testi başlatılabilir)');

        // 2. Refresh cooldown durumu
        const sinceLastRefresh = Date.now() - (KickAPI._lastSessionRefreshAt || 0);
        const cooldownLeft = Math.max(0, 60000 - sinceLastRefresh);
        log('Refresh Cooldown', cooldownLeft > 0 ? 'warn' : 'ok',
          cooldownLeft > 0 ? `${Math.round(cooldownLeft/1000)}sn cooldown var` : 'Cooldown temiz');

        // 3. Manuel session refresh dene
        const refreshStart = Date.now();
        const refreshed = await KickAPI.refreshKickSession('scenario_test');
        const refreshMs = Date.now() - refreshStart;
        log('Manuel Refresh', refreshed ? 'ok' : 'warn',
          refreshed ? `Başarılı (${refreshMs}ms) - Cookie'ler tazelendi` : `Başarısız veya cooldown reddi (${refreshMs}ms)`);

        // 4. Refresh sonrası backoff durumu
        const boAfter = Math.max(0, (KickAPI._lastBackoffUntil || 0) - Date.now());
        log('Refresh Sonrası Backoff', boAfter < boRemain ? 'ok' : (boAfter > 0 ? 'warn' : 'ok'),
          boAfter > 0 ? `Hâlâ ${Math.round(boAfter/1000)}sn` : 'İptal edildi (başarılı refresh)');

        // 5. Recovery alarm zamanlaması
        const refreshAlarm = await chrome.alarms.get(SESSION_REFRESH_ALARM);
        if (refreshAlarm) {
          const next = Math.max(0, refreshAlarm.scheduledTime - Date.now());
          log('Proactive Alarm', 'ok', `Sonraki refresh ${Math.round(next/60000)}dk içinde · Period: ${refreshAlarm.periodInMinutes}dk`);
        } else {
          log('Proactive Alarm', 'error', 'Proactive refresh alarm kayıp!');
        }

        // 6. Test sonrası API çağrısı (recovery'nin işe yaradı mı?)
        try {
          const apiStart = Date.now();
          const resp = await KickAPI.fetchKick(KickAPI.API_URL);
          await resp.json();
          log('Test API Çağrısı', 'ok', `HTTP ${resp.status} (${Date.now() - apiStart}ms) - recovery sonrası başarılı`);
        } catch (e) {
          log('Test API Çağrısı', 'error', `Hâlâ başarısız: ${e.message}`);
        }

        const totalMs = Date.now() - start;
        respond({ success: true, results, totalMs });
      } catch (e) {
        log('General Error', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ─── SENARYO 5: CLOUDFLARE BASKI TESTİ (Plan B değerlendirmesi) ───
  if (msg.type === 'RUN_SCENARIO_PRESSURE') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();

      try {
        // 1. Backoff sıfırla (temiz başlangıç)
        await KickAPI.resetBackoff();
        log('Backoff Sıfırlama', 'ok', 'Temiz başlangıç sağlandı');

        // 2. Başlangıç stats snapshot
        const before = KickAPI.getRecentApiStats(5 * 60 * 1000);
        log('Başlangıç Snapshot', 'ok',
          `Önceki 5dk: ${before.successes} başarı / ${before.failures} hata / oran: ${before.successRate ?? '-'}%`);

        // 3. 10 ardışık istek (5sn arayla = 50sn toplam)
        // v2.3.1 fix: Eski 'Baskı Testi: running' satırı sonuç gelince güncellenmiyordu,
        // mavi running takılı kalıyordu. Sadece Sonuç satırı kalsın.
        const test = { ok: 0, fail: 0, times: [] };
        for (let i = 1; i <= 10; i++) {
          const reqStart = Date.now();
          try {
            const resp = await KickAPI.fetchKick(KickAPI.API_URL);
            await resp.json();
            test.ok++;
            test.times.push({ i, status: resp.status, ms: Date.now() - reqStart });
          } catch (e) {
            test.fail++;
            test.times.push({ i, status: 'ERR', ms: Date.now() - reqStart, err: e.message.substring(0, 40) });
            // Eğer backoff'a düştüysek erken çık (M1 etkisi)
            if (e.message.includes('AUTH_REQUIRED') || e.message.includes('backoff')) {
              log(`İstek ${i}/10`, 'warn', `Hata sonrası backoff devreye girdi: ${e.message.substring(0, 50)}`);
              break;
            }
          }
          if (i < 10) await new Promise(r => setTimeout(r, 5000));
        }

        // 4. Sonuç özeti
        const successRate = Math.round((test.ok / (test.ok + test.fail)) * 100);
        const avgMs = Math.round(test.times.reduce((s, t) => s + t.ms, 0) / test.times.length);
        const summary = test.times.map(t => t.status === 200 ? '✓' : t.status === 'ERR' ? '✗' : '!').join(' ');
        log('Baskı Testi Sonucu',
          successRate >= 90 ? 'ok' : successRate >= 50 ? 'warn' : 'error',
          `${test.ok}/${test.ok + test.fail} başarı (${successRate}%) · Ort ${avgMs}ms · Pattern: ${summary}`);

        // 5. M4 yavaşlatma tetiklendi mi?
        // v2.3.1 fix C: Hem failure sayısını hem gerçek _slowModeActive state'i oku.
        // Eski: sadece failure >= 3 kontrolü → "AKTİF olmalı" diyordu ama state bilinmiyordu.
        // Yeni: gerçek state + sebep birleşik raporla.
        const failures = KickAPI.getRecentFailureCount();
        const m4Active = _slowModeActive;
        let m4Status, m4Detail;
        if (m4Active) {
          m4Status = 'ok';
          m4Detail = `M4 AKTİF - alarm aralığı ${_currentEffectiveSecs}sn (${failures} hata/10dk)`;
        } else if (failures >= SLOWMODE_FAILURE_THRESHOLD) {
          m4Status = 'warn';
          m4Detail = `Eşik aşıldı (${failures}/${SLOWMODE_FAILURE_THRESHOLD}) ama henüz alarm yeniden zamanlanmamış - bir sonraki tick aktive edecek`;
        } else {
          m4Status = 'ok';
          m4Detail = `${failures} hata/10dk (eşik: ${SLOWMODE_FAILURE_THRESHOLD}) - yavaşlatma gerekmiyor`;
        }
        log('M4 Yavaşlatma Durumu', m4Status, m4Detail);

        // 6. Backoff sonuç durumu
        const finalBackoff = Math.max(0, (KickAPI._lastBackoffUntil || 0) - Date.now());
        log('Test Sonrası Backoff',
          finalBackoff > 0 ? 'warn' : 'ok',
          finalBackoff > 0 ? `${Math.round(finalBackoff/1000)}sn aktif` : 'Temiz');

        // 7. Plan B değerlendirmesi
        // v2.3.21: Artık kesin biliyoruz - düşük başarı oranı Cloudflare baskısı
        // DEĞİL, Kick'in kendi sunucu tarafındaki tutarsızlık (aynı geçerli token
        // bazen 200 bazen 401 dönüyor, kick.com'un kendi sitesinde bile kanıtlandı).
        // Eski mesaj "CF baskısı yüksek, Plan C düşünülmeli" yanıltıcıydı - Plan C
        // zaten aktif olsa da bu sorunu çözmüyor.
        let verdict;
        if (successRate >= 90) verdict = '✅ Sağlam: %90+ başarı, tutarsızlık yok';
        else if (successRate >= 70 && failures >= 3) verdict = '✅ Savunma çalışıyor: M4 yavaşlatma devreye girdi';
        else if (successRate < 50) verdict = '⚠ Kick sunucu tutarsızlığı olası - "Auth Tutarlılık Testi (cf-ray)" ile örüntüyü incele';
        else verdict = '🟡 Karışık sonuç: Daha uzun gözlem gerekli';
        log('Plan B Değerlendirmesi', successRate >= 70 ? 'ok' : 'warn', verdict);

        const totalMs = Date.now() - start;
        respond({ success: true, results, totalMs });
      } catch (e) {
        log('General Error', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // v2.3.21: Auth Tutarlılık Teşhisi - backoff'u hiç tetiklemeden N ham istek
  // atar, her birinin durumunu + cf-ray başlığını kaydeder. Amaç: Kick'in
  // sunucu tarafı tutarsızlığının (aynı token bazen 200 bazen 401) belirli bir
  // Cloudflare veri merkezine/arka uç repliksına bağlı olup olmadığını görmek.
  if (msg.type === 'RUN_SCENARIO_AUTH_CONSISTENCY') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();
      try {
        const probe = await KickAPI.authConsistencyProbe(10, 1500);
        const okCount = probe.filter(p => p.ok).length;
        const failCount = probe.length - okCount;

        // Her isteği ayrı adım olarak göster - cf-ray dahil
        probe.forEach(p => {
          const rayShort = p.cfRay ? p.cfRay.split('-')[0] : '-';
          log(
            `İstek ${p.i}/${probe.length}`,
            p.ok ? 'ok' : 'error',
            `${p.status} · via:${p.via} · cf-ray:${rayShort} · ${p.ms}ms${p.err ? ' · ' + p.err : ''}`
          );
        });

        // cf-ray öneklerine göre grupla - örüntü var mı diye
        const rayGroups = {};
        probe.forEach(p => {
          const prefix = p.cfRay ? p.cfRay.split('-')[0] : 'bilinmiyor';
          if (!rayGroups[prefix]) rayGroups[prefix] = { ok: 0, fail: 0 };
          rayGroups[prefix][p.ok ? 'ok' : 'fail']++;
        });
        const groupSummary = Object.entries(rayGroups)
          .map(([ray, c]) => `${ray}: ${c.ok}✓/${c.fail}✗`)
          .join(' · ');
        log('cf-ray Grup Analizi', 'ok', groupSummary || 'cf-ray verisi yok (hepsi proxy üzerinden, header yakalanmadı)');

        // Genel sonuç
        const successRate = Math.round((okCount / probe.length) * 100);
        let verdict;
        if (successRate === 100) verdict = '✅ 10/10 başarı - bu oturumda tutarsızlık gözlenmedi (şu an sorun yok gibi)';
        else if (successRate === 0) verdict = '❌ 0/10 başarı - kalıcı bir reddediliş, geçici tutarsızlık değil';
        else verdict = `🟡 Karışık: ${okCount}/${probe.length} başarı - Kick sunucu tutarsızlığı örüntüsü kanıtlandı`;
        log('Genel Sonuç', successRate === 100 ? 'ok' : successRate === 0 ? 'error' : 'warn', verdict);

        respond({ success: true, results, totalMs: Date.now() - start });
      } catch (e) {
        log('General Error', 'error', e.message);
        respond({ success: false, results });
      }
    })();
    return true;
  }
});

self.onmessage = () => {};

// Debug helper - call testNotification() from Service Worker console
self.testNotification = async function() {
  const testCh = cachedChannels.find(c => c.isLive) || {
    channelSlug: 'test-channel',
    userUsername: 'TestChannel',
    sessionTitle: 'Test notification - try Open & Mute buttons',
    profilePic: '',
  };
  const state = await getPersistedState();
  await sendNotification(testCh, state.notifiedLives, true);
  await setPersistedNotifiedLives(state.notifiedLives);
  dbg(`[KickAlert] Test notification sent for: ${testCh.userUsername}`);
};

// ─── Test Panel ───
// Sadece geliştirici konsolundan erişilebilir
// background context konsoluna: openTestPanel() yaz
self.openTestPanel = function() {
  const url = chrome.runtime.getURL('html/test.html') + '?key=Temmuz2014';
  chrome.tabs.create({ url, active: true });
  dbg('[KickAlert] Test panel opened');
};
