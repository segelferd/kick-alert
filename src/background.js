/**
 * KickAlert - Background Service Worker
 * Monitors followed Kick channels, sends notifications, auto-launches streams.
 * Uses chrome.alarms API for guaranteed wake-up (MV3 service workers sleep after ~30s).
 * © 2025 Segelferd. All rights reserved.
 */

// Chrome uses service_worker (needs importScripts), Firefox uses background.scripts (auto-loaded)
if (typeof importScripts === 'function') {
  importScripts('./storage.js', './kickapi.js', './utils.js', './pusher.js');
}

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

async function initialize() {
  if (_initRunning) return;
  _initRunning = true;

  // Storage-based lock: prevent duplicate init within 10s across SW restarts
  try {
    const lockData = await chrome.storage.local.get('_initLock');
    const lock = lockData._initLock || 0;
    if (Date.now() - lock < 10000) {
      dbg('[KickAlert] Init skipped — lock active');
      _initRunning = false;
      return;
    }
    await chrome.storage.local.set({ _initLock: Date.now() });
  } catch {}

  dbg('[KickAlert] Initializing...');

  try {
    await Utils.initI18n();
    await Storage.initSyncState();
    await Storage.pullFromSync();

    const resetOnRestart = await Storage.getResetSuspendOnRestart();
    if (resetOnRestart) await Storage.remove(StorageKeys.SUSPEND_FROM_DATE);

    await updateBadgeColor();
    await migrateAutoOpenChannels();
    await startOffscreen();

    // v2.3.18: AdBlock DNR ruleset'ini kullanıcı ayarıyla senkronize et — SW
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
    // 10-15 saniyeden 0 saniyeye iniyor — popup anında veri görür.
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

    // v2.3.1 Plan F: Pusher WebSocket — gerçek zamanlı StreamerIsLive event'leri.
    // İlk checkSafe'de cachedChannels dolduğu için channel_id'leri kullanabiliriz.
    startPusherIfPossible();
  } catch (e) {
    console.warn('[KickAlert] Init error:', e.message);
  }
  _initRunning = false;
}

/**
 * v2.3.1 Plan F: Pusher WebSocket başlat ve takip edilen kanallara subscribe et.
 *
 * İKİ MOD:
 *   - Chrome (offscreen API var): WebSocket offscreen document'ta çalışır
 *     (hiç uyumaz → event kaçmaz). SW sadece sync mesajı atar + event dinler.
 *   - Firefox (offscreen yok): pusher.js doğrudan SW'de çalışır (fallback).
 *
 * Çalışmazsa sessizce başarısız olur — checkChannels polling devam eder.
 */
function startPusherIfPossible() {
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
      dbg('[KickAlert] Plan F: SW modu (Firefox — WebSocket SW\'de)');
    }
  } catch (e) {
    console.warn('[KickAlert] Pusher start hatası:', e.message);
  }
}

/**
 * v2.3.1 Plan F: Subscribed kanal listesini güncelle.
 * cachedChannels değişince (yeni takip / unfollow) çağrılır.
 * Storage'dan channel_id'leri okur (yapısı /api/v2/channels/followed dönmez,
 * sadece /api/v2/channels/{slug} verir — bot_tracker zaten bunları cache'liyor)
 */
async function refreshPusherSubscriptions() {
  if (!chrome.offscreen && typeof Pusher === 'undefined') return;

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
      // Mesaj göndermeden önce açık olduğundan emin ol — startOffscreen
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
        channels: subscribableItems,
        authoritative: true, // Bulgu#6: tam liste — offscreen unfollow edilenleri temizlesin
      });
    } else if (typeof Pusher !== 'undefined') {
      // Firefox: SW içi Pusher
      Pusher.subscribeAll(subscribableItems);
    }
    KLog.debug('PSH-01', `${subscribableItems.length}/${cachedChannels.length} kanala subscribe`);
  } else {
    dbg(`[KickAlert] Pusher: subscribe edilecek kanal yok (channel_id cache boş — harvest başlatılacak)`);
  }

  // Eksik channel_id'leri arka planda topla (yavaş tempo, sadece ilk kurulumda)
  const missingCount = (cachedChannels || []).filter(c =>
    c.channelSlug && !channelIdCache[c.channelSlug]
  ).length;
  if (missingCount > 0) {
    harvestMissingChannelIds(); // await YOK — arka planda çalışsın, init'i bloklamasın
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
      // Yanıt geldi ama success değil — yine de "ulaştı" sayılır, döndür
      if (resp) return resp;
    } catch (e) {
      // "Could not establish connection" — listener henüz yok, retry
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
      // Bu çağrı Cloudflare'e gidebilir AMA sadece İLK KEZ — sonra kalıcı cache.
      try {
        await KickAPI.getChatroomId(slug);
        const channelId = await Storage.getChannelId(slug);
        if (channelId) {
          if (chrome.offscreen) {
            // Chrome: offscreen'e tek kanal ekle (retry helper ile)
            await sendToOffscreenWithRetry({
              target: 'offscreen',
              type: 'LIVE_TRACK_SYNC',
              channels: [{ channelId, slug }],
            });
          } else if (typeof Pusher !== 'undefined') {
            // Firefox: SW içi Pusher
            Pusher.subscribeChannel(channelId, slug);
          }
        }
      } catch (e) { /* sessiz — sonraki harvest'e kalır */ }

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
 *   2. Yayın yaşı kontrolü (created_at — eski yayını bildirme)
 *   3. cachedChannels'ta varsa state güncelle (yoksa minimal kanal objesi kur)
 *   4. DND / sound / showNotif ayarlarını uygula
 *   5. sendNotification + playSound + autoOpen
 *   6. Persisted state güncelle (liveSlugs, notifiedLives)
 *
 * API'ye HİÇ gitmez — checkChannels akışını TETİKLEMEZ.
 */
async function handlePusherLiveEvent(slug, livestreamData) {
  if (!slug) return;
  const _t0 = KLog.timer(); // toplam akış süresi

  KLog.info('PUSH-10', `${slug} → Pusher StreamerIsLive event alındı`);

  const ls = livestreamData?.livestream || {};

  // ── PUSH-11: Bulgu#6 — Kanal hâlâ takip ediliyor mu? ──
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
  // İlk kurulum: lastCheckDone yoksa baseline kurulmadı — sessizce kaydet,
  // badge'e dokunma (polling baseline kurunca tutarlı sayı yazacak).
  if (!state.lastCheckDone) {
    KLog.warn('PUSH-15', `${slug} — baseline kurulmadan geldi, sessizce kaydedildi (polling badge düzeltecek)`);
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
  // NOT: liveSlugs.add() yukarıda yapıldı (PUSH-13) — bu gecikme boyunca polling
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
  const chSoundPref = await Storage.getChannelSoundMode(slug);
  KLog.debug('NOTIF-50', `${slug} ayarlar: showNotif=${showNotif} suspended=${suspended} dnd=${dndActive} chSoundPref=${chSoundPref}`);

  // ── NOTIF-51: Bildirim gecikmesi (kullanıcı ayarı, opsiyonel) ──
  const notifDelay = await Storage.getNotifDelay();
  if (notifDelay > 0) {
    KLog.info('NOTIF-51', `${slug} → notifDelay ayarı: ${notifDelay} dakika ek bekleme`);
    await Utils.delay(notifDelay * 1000);
  }

  // ── NOTIF-52: History ──
  Storage.addNotificationHistory({
    username: ch.userUsername,
    channelSlug: ch.channelSlug,
    profilePic: ch.profilePic || '',
    title: ch.sessionTitle || '-',
    category: ch.categoryName || '-',
    timestamp: new Date().toISOString(),
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
    if (chSoundPref !== 'muted') {
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
          KLog.info('TAB-70', `${slug} → SEKME AÇILDI (tabId=${tab.id}) — toplam akış ${_t0.ms()}ms`);
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
 * v2.3.1 Plan F: StopStreamBroadcast — yayın bitti.
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

async function updateBadgeColor() {
  const dndActive = await Storage.isDndActive();
  if (dndActive) {
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
// scheduleAlarm her tetiklendiğinde gerek var mı/yok mu hızlıca anlayalım — fazladan
// chrome.alarms.create çağrısı yapmayalım (Chrome internal cooldown'ı vardır).
let _currentEffectiveSecs = 0;
let _slowModeActive = false; // M4: yavaşlatma modunda mıyız?
let _peakModeActive = false; // M5: peak saat (akşam) yavaşlatması aktif mi?

const SLOWMODE_FAILURE_THRESHOLD = 2; // v2.3.1 fix B: 3 → 2 (son 10 dk'da 2+ hata → yavaşlat)
                                        // Daha proaktif: ilk 2 hata'da yavaşlatma kararı verilir.
const SLOWMODE_MULTIPLIER = 2;        // baz aralığı 2x'e çıkar (M4)

// M5 — Peak saat yavaşlatması (kanıt: 8h konsol → 18-22 arası tüm 403'lerin %100'ü)
// 18:00-22:00 lokal saat aralığında baz aralığı 1.5x yavaşlat. Cloudflare baskısı
// başlamadan önce proaktif yavaşlatma. Tüm gün kapsayıcı yavaşlatma değil — sadece
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

  // M5: Saat bazlı yavaşlatma — 18-22 arası baz aralığı 1.5x
  const wantPeak = isPeakHour();
  const peakAdjustedSecs = wantPeak ? Math.round(baseSecs * PEAK_MULTIPLIER) : baseSecs;

  // M4: Dinamik yavaşlatma — son 10 dk'da 3+ failure varsa 2x yavaşlat (peak üstüne uygulanır)
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

  // Mod geçişlerini logla — gereksiz tekrarlamayı önle
  if (wantSlow && !wasSlow) {
    console.warn(`[KickAlert] M4: Yavaşlatma aktif — baz ${baseSecs}s → ${effectiveSecs}s (${failures} hata/10dk)`);
  } else if (!wantSlow && wasSlow) {
    dbg(`[KickAlert] M4: Yavaşlatma kalktı — ${effectiveSecs}s'ye döndü`);
  } else if (wantPeak && !wasPeak) {
    console.warn(`[KickAlert] M5: Peak saat (${PEAK_HOUR_START}-${PEAK_HOUR_END}) yavaşlatması — ${baseSecs}s → ${effectiveSecs}s`);
  } else if (!wantPeak && wasPeak) {
    dbg(`[KickAlert] M5: Peak saat sona erdi — ${effectiveSecs}s'ye döndü`);
  } else {
    dbg(`[KickAlert] Alarm scheduled — every ${effectiveSecs}s (${periodMinutes.toFixed(2)} min)`);
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
let _currentRefreshPeriod = 0; // dk cinsinden — gereksiz yeniden zamanlamayı önle

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
  dbg(`[KickAlert] Session refresh alarm scheduled — every ${desiredPeriod} min ${isPeakHour() ? '(peak)' : ''}`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    // M3 (jitter): 0-5 sn rastgele bekle — fingerprint riskini azalt.
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
  const internalKeys = ['_liveSlugs', '_notifiedLives', '_lastCheckDone'];
  const changedKeys = Object.keys(changes);
  if (changedKeys.every(k => internalKeys.includes(k))) return;

  if (changes[StorageKeys.CHECK_INTERVAL]) {
    dbg(`[KickAlert] Check interval changed — rescheduling alarm`);
    await scheduleAlarm();
  }
  if (changes[StorageKeys.DND_ENABLED] || changes[StorageKeys.DND_START] ||
      changes[StorageKeys.DND_END] || changes[StorageKeys.SUSPEND_FROM_DATE]) {
    await updateBadgeColor();
  }
  if (changes[StorageKeys.USER_LANGUAGE] || changes[StorageKeys.USE_BROWSER_LANGUAGE]) {
    // Either manual language choice or "use browser language" toggle changed.
    // Re-detect and reload locale. detectLanguage() reads both flags.
    try {
      const newLang = await Utils.detectLanguage();
      dbg(`[KickAlert] Language preference changed — reloading locale: ${newLang}`);
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
 * localStorage bayraklarını okuyor — bu fonksiyon SADECE ağ seviyesi (DNR)
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
    // v2.1.0: AUTH_REQUIRED zaten kickapi.js'te warn'la loglandı — burada tekrar etme
    if (e && e.message && e.message.startsWith('AUTH_REQUIRED:')) {
      return; // sessizce devam, kullanıcı login olunca recover olur
    }
    // Beklenmeyen hatalar — console.warn (error değil, eklenti çalışmaya devam ediyor)
    console.warn('[KickAlert] Check failed:', e?.message || e);
  }
}

// ─── Viewer Anomaly Detection ───
// ─── Viewer Anomaly Sabitleri ───
// Artış eşikleri storage'dan okunur — sabit değerler kaldırıldı
// NEW_STREAM_WINDOW kaldırıldı — STREAM_SETTLE_MS getViewerAnomaly içinde tek eşik olarak tanımlı
// v2.1.0: PAST_AVG_MULTIPLIER_WARN/ALERT silindi (kullanılmayan dead code)
const HISTORY_CURRENT_MAX = 60;  // 30 sn aralıklı × 60 = 30 dk pencere
const HISTORY_PAST_MAX    = 10;
const ANOMALY_COOLDOWN_MS = 15 * 60 * 1000; // 15 dk cooldown
const ANOMALY_RESET_MS    = 15 * 60 * 1000; // cooldown sonrası peak/valley sıfırla
const ANOMALY_MIN_VIEWERS = 500;             // v2.2.0: 100→500, ciddi kanalları kapsa

// v2.2.1: Plato detection (C imzası — bot tutulan yayında sabit izleyici)
const PLATEAU_WINDOW_ENTRIES = 60;            // Son 60 entry (~30 dk)
const PLATEAU_MIN_ENTRIES    = 50;            // En az 50 entry gerekli (~25 dk veri)
const PLATEAU_THRESHOLD      = 0.02;          // (max-min)/avg < %2 = plato
const PLATEAU_MIN_VIEWERS    = 1000;          // 1K altında dalgalanma doğal, yanlış pozitif

// v2.2.1: Smoothness detection (B imzası — kademeli bot tırmanışı)
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
          // Yeterli veri birikmeden yayın bitti — current'ı temizle
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

      // Cooldown sona erdikten sonra peak/valley sıfırla — her "bölüm" kendi referansıyla değerlendirilir
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

    // Her check sonrası anomali tespiti — popup kapalıyken de çalışır
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
      if (ch.viewerCount < ANOMALY_MIN_VIEWERS) continue; // 500 altı — sus

      const chSoundPref = await Storage.getChannelSoundMode(ch.channelSlug);
      if (chSoundPref === 'muted') continue;

      const rec = history[ch.channelSlug];
      if (!rec) continue;

      // v2.1.1: Diagnostic — her kanal için anomaly check özetini console.debug'a yaz
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
          dbg(`[KickAlert] Spike: ${ch.channelSlug} — ${anomaly.label}`);
          const mode = anomalySettings.notifyMode || 'both';
          if (mode === 'notif' || mode === 'both') {
            const icon = await getAvatarDataUrl(ch);
            const spikeTitle = Utils.i18n('anomalySpikeTitle') || 'Viewer spike';
            // v2.2.1: F format — title'a yüzde eklendi: "Spike (+67%)"
            const titleSuffix = ` (+${anomaly.pct}%)`;
            chrome.notifications.create('ka-anomaly-' + ch.channelSlug + '-' + now, {
              type: 'basic', iconUrl: icon,
              title: ch.userUsername + ' — ' + spikeTitle + titleSuffix,
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
            dbg(`[KickAlert] Drop: ${ch.channelSlug} — ${drop.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if (mode === 'notif' || mode === 'both') {
              const icon = await getAvatarDataUrl(ch);
              const dropTitle = Utils.i18n('anomalyDropTitle') || 'Viewer drop';
              // v2.2.1: F format — title'a yüzde eklendi: "Drop (-21%)"
              const titleSuffix = ` (-${drop.pct}%)`;
              chrome.notifications.create('ka-drop-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' — ' + dropTitle + titleSuffix,
                message: drop.label,
              });
            }
            rec._lastDropAlert = now;
            historyDirty = true;
          }
        }
      }

      // ── v2.2.1: Smoothness detection (B imzası — kademeli bot tırmanışı) ──
      // Plato'dan ÖNCE çalışıyor çünkü smoothness tetiklenirse plato 30 dk susturulur (cross-cooldown)
      if (_spikeEnabled) {
        const smooth = getViewerSmoothness(rec, ch.viewerCount, ch.startedAt, now);
        if (smooth) {
          const lastSmooth = rec._lastSmoothAlert || 0;
          if (now - lastSmooth >= ANOMALY_COOLDOWN_MS) {
            dbg(`[KickAlert] Smoothness: ${ch.channelSlug} — ${smooth.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if (mode === 'notif' || mode === 'both') {
              const icon = await getAvatarDataUrl(ch);
              const smoothTitle = Utils.i18n('anomalySmoothTitle') || 'Suspicious Linear Growth';
              chrome.notifications.create('ka-smooth-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' — ' + smoothTitle,
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

      // ── v2.2.1: Plato detection (C imzası — bot tutulan sabit izleyici) ──
      if (_spikeEnabled) {
        const plateau = getViewerPlateauSync(rec, ch.viewerCount, ch.startedAt, now);
        if (plateau) {
          const lastPlateau = rec._lastPlateauAlert || 0;
          if (now - lastPlateau >= ANOMALY_COOLDOWN_MS) {
            dbg(`[KickAlert] Plateau: ${ch.channelSlug} — ${plateau.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if (mode === 'notif' || mode === 'both') {
              const icon = await getAvatarDataUrl(ch);
              const plateauTitle = Utils.i18n('anomalyPlateauTitle') || 'Suspicious Steady Viewers';
              chrome.notifications.create('ka-plateau-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' — ' + plateauTitle,
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

// Ani sıçrama tespiti — sliding window rate of change
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

// Sync versiyon — checkViewerAnomalies'de history zaten yüklü
function getViewerAnomalySync(rec, currentCount, streamStartedAt, now) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null; // yeterli veri yok — sus

    const streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;

    // v2.2.0: Yayın başı 10 dk grace — bu süre içinde organik patlama
    // (notification push + discovery + raid kombinasyonu) gerçek spike'tan
    // ayırt edilemez. 10 dk sonrası ROC algoritması güvenilir çalışır.
    if (streamAge < STREAM_SETTLE_MS) return null;

    const { warn: warnThreshold, alert: alertThreshold } = SPIKE_THRESHOLDS[_spikeSensitivity] || SPIKE_THRESHOLDS.avg;

    // ── Rate of change — ani sıçrama tespiti ──
    // v2.2.0: Geniş pencere yolu (streamValley referans) kaldırıldı.
    // Yapısal hatalıydı — yayın boyunca biriken sabit referans, dalgalanan
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

// Async wrapper — popup mesaj handler için
async function getViewerAnomaly(slug, currentCount, streamStartedAt) {
  try {
    const history = await Storage.getViewerHistory();
    return getViewerAnomalySync(history[slug], currentCount, streamStartedAt, Date.now());
  } catch { return null; }
}

function formatK(n) {
  if (n >= 10000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';  // 3.6K — hassas gösterim
  return String(n);
}

function getViewerDropSync(rec, currentCount, streamStartedAt, now, anomalySettings) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null;

    const { warn: warnThreshold, alert: alertThreshold } = DROP_THRESHOLDS[_dropSensitivity] || DROP_THRESHOLDS.avg;

    // ── Rate of change — ani düşüş tespiti ──
    // v2.2.0: Grace period kaldırıldı (mantıken gereksizdi — yayın başında
    // peak yokken düşüş hesaplanamaz, ROC için ROC_MIN_ENTRIES (~4 dk veri)
    // zaten yeterli koruma sağlıyor).
    // v2.2.0: Geniş pencere yolu (streamPeak referans) kaldırıldı —
    // spike'taki streamValley'in simetriği aynı yapısal hatayı taşıyordu.
    const roc = getRateOfChange(current);
    if (roc && roc.pct <= -warnThreshold) {
      // v2.3.0: Yayın kapanışı tespiti — kapanan yayında viewer count dramatik düşer.
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

    // Yayın başı 10 dk grace (spike ile aynı — yayın yeni başlamış olabilir)
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
  _autoLaunchTabOpened = false; // Her check başında sıfırla — ilk sekme öne gelsin
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
        // Bu durumda temizleme — gerçek offline ise bir sonraki check yakalar.
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
  // state'ini koruyalım — aksi halde badge/popup tutarsız olur.
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

  // First run OR fresh startup with empty state — record current live, don't notify
  // Prevents duplicate notifications when browser starts with streams already live
  if (!state.lastCheckDone || state.liveSlugs.size === 0) {
    const currentLive = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    await setPersistedLiveSlugs(currentLive);
    if (!state.lastCheckDone) await setLastCheckDone();
    dbg(`[KickAlert] Startup check — ${liveCount} live channels recorded, no notifications`);
    return;
  }

  const showNotif = await Storage.getShowNotification();
  const suspended = !!(await Storage.getSuspendFromDate());

  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const dndMuteSound = dndActive && await Storage.getDndMuteSound();
  const dndMuteAutolaunch = dndActive && await Storage.getDndMuteAutolaunch();
  const soundMode = await Storage.getSoundMode();

  if (dndActive) dbg('[KickAlert] DND active — muting:', { notif: dndMuteNotif, sound: dndMuteSound, autolaunch: dndMuteAutolaunch });

  let notified = false;

  // Bildirim gecikmesi — loop dışında tek seferde oku
  const notifDelay = await Storage.getNotifDelay();

  // startedAt null olan kanallar için viewerHistory tek seferlik yüklenir
  const vhData = await chrome.storage.local.get('viewerHistory');
  const vh = vhData.viewerHistory || {};

  for (const ch of channels) {
    if (liveChannelSlugs.has(ch.channelSlug) || !ch.isLive) continue;
    // #D/#E FIX: Pusher bu kanalı zaten canlı bildirdiyse polling tekrar
    // bildirmesin (dar yarış penceresinde getPersistedState snapshot'ı
    // Pusher'ın persist'inden eski olabilir — bu RAM Set'i o boşluğu kapatır).
    if (_pusherLiveSlugs.has(ch.channelSlug)) {
      liveChannelSlugs.add(ch.channelSlug);
      continue;
    }
    if (ch.startedAt) {
      // startedAt varsa: yayın 10 dk+ önce başlamışsa atla — zaten yayındaydı
      const streamStart = new Date(ch.startedAt).getTime();
      const streamAgeMs = Date.now() - streamStart;
      if (streamAgeMs > 10 * 60 * 1000) {
        dbg(`[KickAlert] Skipping long-running live (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
        liveChannelSlugs.add(ch.channelSlug);
        continue;
      }
    } else {
      // startedAt null — yayın ne zaman başladı bilinmiyor.
      // API'den yayın başlangıcını sorgula — viewerHistory eski oturumdan kalmış olabilir
      const apiStartTime = await KickAPI.getChannelStartTime(ch.channelSlug);
      if (apiStartTime) {
        const streamStart = new Date(apiStartTime).getTime();
        const streamAgeMs = Date.now() - streamStart;
        if (streamAgeMs > 10 * 60 * 1000) {
          // Yayın 10 dk+ önce başlamış — zaten yayındaydı, atla
          dbg(`[KickAlert] Skipping long-running live API (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        // Yayın 10 dk içinde başlamış — yeni yayın, devam et
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
          dbg(`[KickAlert] No API time but has history — skipping (likely long-running): ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        if (lastViewerCount > 1000) {
          // Geçmiş yok ama 1000+ viewer = büyük olasılıkla zaten saatlerdir yayında, organik trafik birikmiş
          dbg(`[KickAlert] No API time, no history, but ${lastViewerCount} viewers — likely long-running, skipping: ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        // Geçmiş yok ve viewer sayısı düşük → büyük ihtimalle gerçekten yeni başlamış
        dbg(`[KickAlert] No API time, no history, low viewers — treating as new live: ${ch.channelSlug}`);
      }
    }

    // Bildirim gecikmesi kontrolü
    if (notifDelay > 0) {
      let streamAgeMin = null;
      if (ch.startedAt) {
        streamAgeMin = (Date.now() - new Date(ch.startedAt).getTime()) / 60000;
      } else {
        // startedAt null — API'den alınan startTime ile hesapla
        const apiTime = await KickAPI.getChannelStartTime(ch.channelSlug);
        if (apiTime) streamAgeMin = (Date.now() - new Date(apiTime).getTime()) / 60000;
      }
      if (streamAgeMin !== null && streamAgeMin < notifDelay) {
        dbg(`[KickAlert] Delay pending: ${ch.channelSlug} (${Math.round(streamAgeMin)}/${notifDelay}min)`);
        continue;
      }
    }

    dbg(`[KickAlert] New live: ${ch.userUsername} (${ch.channelSlug})`);

    // Always log to history
    Storage.addNotificationHistory({
      username: ch.userUsername,
      channelSlug: ch.channelSlug,
      profilePic: ch.profilePic || '',
      title: ch.sessionTitle || '-',
      category: ch.categoryName || '-',
      timestamp: new Date().toISOString(),
    });

    // Channel-level sound preference: main / sub / silent / muted
    const chSoundPref = await Storage.getChannelSoundMode(ch.channelSlug);

    // Muted = no notification, no sound, only history
    if (chSoundPref === 'muted') continue;

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
    // 30sn cycle ile çalışır — yayın yakalandığında zaten birkaç saniye geçmiştir.
    if (!suspended && !dndMuteAutolaunch) {
      if (await shouldAutoOpen(ch)) {
        const tab = await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: !_autoLaunchTabOpened });
        KLog.info('TAB-71', `${ch.channelSlug} → polling SEKME AÇILDI (tabId=${tab.id}, gecikme yok)`);
        _autoLaunchTabOpened = true;
      } else {
        KLog.debug('TAB-71', `${ch.channelSlug} → polling shouldAutoOpen=false → sekme açılmadı`);
      }
    }
  }

  // #E FIX: Polling liveSlugs'u REPLACE ediyor (API snapshot'ına göre).
  // AMA Pusher'ın canlı bildiği kanalları EZMEMELI — özellikle API 403 +
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

  // ─── v2.3.0: Bot Tracker — sync live channels to offscreen ───
  await syncBotTracker(channels);

  // ─── v2.3.1 Plan F: Pusher subscription sync ───
  // Kanal listesi değişmiş olabilir (yeni takip / unfollow) → yeni ID'lere subscribe et
  refreshPusherSubscriptions();
}

// v2.3.0: Bot tracker lifecycle management
// Live kanallar için chatroom_id alır, offscreen'e BOT_TRACK_SYNC gönderir.
// Hiç canlı kanal yoksa offscreen'i durdurur (Strateji B — kanal varsa açık).
//
// v2.3.0 Firefox desteği — Dual-mode:
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

  // Offscreen "var" mı kontrol et — Firefox'ta her zaman true (BotTracker yüklü)
  async isAlive() {
    if (this.isLocal) return true; // Firefox: BotTracker zaten bu bağlamda yüklü
    if (!this.hasOffscreen) return false;
    try { return await chrome.offscreen.hasDocument(); } catch { return false; }
  },

  // BOT_TRACK_SYNC — tracker'ı bu kanal listesi için sync et
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
      target: 'offscreen', type: 'BOT_TRACK_SYNC', channels,
    });
  },

  // BOT_TRACK_STOP — tracker'ı durdur
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

  // BOT_GET_STATS — istatistikleri al
  async getStats() {
    if (this.isLocal) {
      try { return { success: true, stats: BotTracker.getStats() }; }
      catch (e) { return { success: false, error: e.message }; }
    }
    if (!this.hasOffscreen) return { success: false, error: 'unsupported' };
    if (!await this.isAlive()) return { success: false, error: 'no_offscreen' };
    return chrome.runtime.sendMessage({ target: 'offscreen', type: 'BOT_GET_STATS' });
  },

  // BOT_COMPUTE_SCORES — skorları hesapla
  async computeScores(viewerMap) {
    if (this.isLocal) {
      try { return { success: true, scores: BotTracker.computeScores(viewerMap) }; }
      catch (e) { return { success: false, error: e.message }; }
    }
    if (!this.hasOffscreen) return { success: false, error: 'unsupported' };
    return chrome.runtime.sendMessage({
      target: 'offscreen', type: 'BOT_COMPUTE_SCORES', viewerMap,
    });
  },
};

async function syncBotTracker(channels) {
  // Firefox veya Chrome — BotTrackerHost ikisini de hallediyor
  if (!BotTrackerHost.isSupported) return;

  // Master toggle
  const enabled = await Storage.getBotTrackerEnabled();
  if (!enabled) {
    // Disabled olsa da çalışıyor olabilir — durdur
    await BotTrackerHost.stop();
    return;
  }

  const liveChannels = channels.filter(c => c.isLive);
  if (liveChannels.length === 0) {
    // Canlı kanal yok — tracker'ı durdur
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
        trackList.push({
          slug: ch.channelSlug,
          chatroomId,
          userId: 0, // Pusher chat subscribe için chatroomId yeterli
        });
      }
    } catch (e) {
      dbg(`[KickAlert] BotTracker chatroom lookup skip ${ch.channelSlug}:`, e.message);
    }
  }

  if (trackList.length === 0) return;

  // Sync et — chrome offscreen'e mesaj veya firefox direct call
  try {
    const response = await BotTrackerHost.sync(trackList);
    if (response?.success) {
      KLog.debug('BSC-01', `BotTracker ${response.trackedCount} kanal takip ediyor`);
    }
  } catch (e) {
    console.warn('[KickAlert] BotTracker sync error:', e.message);
  }

  // v2.3.0 Aşama 2: Skor hesabı (1 dakikada bir)
  await recomputeBotScores(liveChannels);
}

// v2.3.0 Aşama 2: MoKick skor hesabı — her dakika tetiklenir
// 1. Offscreen'den her live kanal için skor al
// 2. Storage'a yaz (popup açıldığında anında okunur)
// 3. Canlıdan çıkan kanalların skorunu temizle
const _BOT_SCORE_INTERVAL_MS = 60 * 1000; // 1 dakika
let _lastBotScoreCompute = 0;

async function recomputeBotScores(liveChannels) {
  if (!BotTrackerHost.isSupported) {
    dbg('[KickAlert][BotScore] BotTracker desteklenmiyor (Firefox script eksik?), çıkıyor');
    return;
  }
  const now = Date.now();
  const elapsed = now - _lastBotScoreCompute;
  if (elapsed < _BOT_SCORE_INTERVAL_MS) {
    KLog.debug('BSC-02', `Throttle: ${Math.round(elapsed/1000)}s geçti, ${_BOT_SCORE_INTERVAL_MS/1000}s gerekiyor — atlanıyor`);
    return;
  }
  _lastBotScoreCompute = now;
  KLog.debug('BSC-03', `recomputeBotScores başladı — ${liveChannels.length} canlı kanal (${BotTrackerHost.isLocal ? 'local/firefox' : 'offscreen/chrome'})`);

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
    const res = await BotTrackerHost.computeScores(viewerMap);
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

  // Storage'a yaz — sadece anlamlı (insufficient olmayan) skorları
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
  const liveChannels = channels.filter(c => c.isLive);
  let tooltip = 'KickAlert';
  if (liveChannels.length === 0) {
    tooltip = Utils.i18n('tooltipNoLive') || 'KickAlert — No live streams';
  } else {
    const count = Utils.i18n('tooltipLiveCount', [String(liveChannels.length)])
      || `${liveChannels.length} live`;
    const lines = liveChannels
      .slice(0, 10)
      .map(c => `• ${c.userUsername}`);
    if (liveChannels.length > 10) {
      const more = Utils.i18n('tooltipMore', [String(liveChannels.length - 10)])
        || `+${liveChannels.length - 10} more`;
      lines.push(more);
    }
    tooltip = `KickAlert — ${count}\n\n${lines.join('\n')}`;
  }
  try { await chrome.action.setTitle({ title: tooltip }); } catch {}
}

// ─── Notification ───
// BUG 13 FIX: No longer writes to history (handled in checkChannels)
// Windows notification sound fix: silent: true — our own sound plays via offscreen

async function sendNotification(ch, notifiedLives, isSilent) {
  await Utils.ensureI18n();
  const id = `kickalert-${ch.channelSlug}-${Date.now()}`;
  const title = Utils.i18n('notifStartedStreaming', [ch.userUsername])
    || `${ch.userUsername} started streaming`;
  const iconUrl = await getAvatarDataUrl(ch);

  const isFirefox = typeof browser !== 'undefined';
  const notifOptions = {
    type: 'basic',
    iconUrl: iconUrl,
    title: title,
    message: ch.sessionTitle || '-',
  };

  // Firefox doesn't support buttons or silent in notifications.create
  if (!isFirefox) {
    const btnOpen = Utils.i18n('notifButtonOpen') || 'Open';
    const btnMute = Utils.i18n('notifButtonMute') || 'Mute';
    notifOptions.silent = isSilent;
    notifOptions.buttons = [
      { title: btnOpen },
      { title: btnMute },
    ];
  }

  chrome.notifications.create(id, notifOptions);
  notifiedLives[id] = { url: `https://kick.com/${ch.channelSlug}`, slug: ch.channelSlug };
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
  // Firefox doesn't support offscreen API — skip silently
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
    // "Only a single offscreen document may be created" is harmless — already exists
    if (!e.message?.includes('single offscreen')) {
      console.warn('[KickAlert] Offscreen create error:', e.message);
    }
  }
}

async function playSound(type) {
  const soundMode = await Storage.getSoundMode();
  if (soundMode === 'windows') return;

  const volume = (await Storage.getSoundVolume()) / 100;
  const customFile = await Storage.getCustomSoundFile(type === 'NEW_LIVE_MAIN' ? 'main' : 'sub');

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

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('kickalert-')) return;
  dbg(`[KickAlert] Notification body clicked: ${id}`);
  const state = await getPersistedState();
  const entry = state.notifiedLives[id];
  if (entry) {
    const url = typeof entry === 'string' ? entry : entry.url;
    await chrome.tabs.create({ url });
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
    console.warn(`[KickAlert] No entry found for ${id} — already cleared?`);
    return;
  }

  const url = typeof entry === 'string' ? entry : entry.url;
  const slug = typeof entry === 'string'
    ? id.replace('kickalert-', '').replace(/-\d+$/, '')
    : entry.slug;

  dbg(`[KickAlert] Button action — slug: "${slug}", index: ${buttonIndex}`);

  if (buttonIndex === 0) {
    await chrome.tabs.create({ url });
    dbg(`[KickAlert] Opened: ${slug}`);
  } else if (buttonIndex === 1) {
    await Storage.setChannelSoundMode(slug, 'muted');
    const verify = await Storage.getChannelSoundMode(slug);
    dbg(`[KickAlert] Muted: ${slug} — verified mode: ${verify}`);
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
      dbg('[KickAlert] chrome.scripting yok — Plan C otomatik inject atlandı');
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
        // Tab kapanmış, izin yok, veya zaten yüklü — sessiz fail
        fail++;
      }
    }
    dbg(`[KickAlert] Plan C inject: ${ok}/${tabs.length} kick.com tab'ı tazelendi (${fail} fail)`);
  } catch (e) {
    dbg('[KickAlert] Plan C inject hatası:', e.message);
  }
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await chrome.storage.local.set({ _sessionStart: Date.now() });
  // Reset state only on fresh install or extension update, not on every browser start
  if (details.reason === 'install' || details.reason === 'update') {
    await resetPersistedState();
  }
  // Plan C: Mevcut kick.com tab'larına content script'i tazele
  await injectContentScriptToOpenKickTabs();
  await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tarayıcı yeniden açıldı — liveSlugs sıfırla
  const now = Date.now();
  await chrome.storage.local.remove(['_liveSlugs', '_lastCheckDone', '_initLock']);
  await chrome.storage.local.set({ _sessionStart: now });

  // viewerHistory current dizilerini temizle — anomali sistemi temiz başlasın
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

  initialize();
});

// Fallback: SW woke from alarm. Only run if alarm already exists (was previously set up).
// Delay 200ms so onInstalled/onStartup can run first if they are also firing.
chrome.alarms.get(ALARM_NAME).then(alarm => {
  if (alarm) {
    setTimeout(() => {
      if (!_initRunning) initialize();
    }, 200);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  // v2.3.0: Offscreen-targeted mesajları görmezden gel (loop'u önle)
  // chrome.runtime.sendMessage broadcast'tir — hem background hem offscreen alır.
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
  if (msg.type === 'AD_BLOCK_LOG') {
    const level = msg.level === 'warn' ? 'warn' : 'info';
    KLog[level](msg.code || 'ADB-00', msg.text || '');
    return false;
  }

  // ─── v2.3.20: offscreen.html (LiveTracker/BotTracker) log köprüsü ───
  // offscreen.js/bot_tracker.js ayrı DevTools context'inde çalışıyor —
  // önemli olaylarını buraya (KLog'a) iletiyorlar, tek konsol için.
  if (msg.type === 'OFFSCREEN_LOG') {
    const level = msg.level === 'warn' ? 'warn' : 'info';
    KLog[level](msg.code || 'OFF-00', msg.text || '');
    return false;
  }

  // ─── v2.3.1 Plan F (BUG#9): Content script'ten channel_id geldi ───
  // Kullanıcı bir kanal sayfası açtığında content script o kanalın channel_id'sini
  // SAYFA context'inde (cf_clearance korumalı, 403 riski YOK) çekip gönderir.
  // SW olarak kalıcı cache'leyip Pusher'a subscribe ediyoruz — sıfır SW-API baskısı.
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
    dbg(`[KickAlert] GET_CHANNELS received — RAM cache size: ${cachedChannels.length}`);
    if (cachedChannels.length > 0) {
      const liveInRam = cachedChannels.filter(c => c.isLive).length;
      dbg(`[KickAlert] Responding from RAM: ${cachedChannels.length} total, ${liveInRam} live`);
      respond({ success: true, channels: cachedChannels });
      return false;
    }
    // RAM cache empty (SW slept) — try storage cache first, then fetch fresh
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

  // Backoff durumu — kalan süre, son backoff bilgisi
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

  // Tek API çağrısı — anlık 200/403 testi
  if (msg.type === 'RUN_API_TEST') {
    (async () => {
      try {
        const cookies = await chrome.cookies.getAll({ domain: 'kick.com', name: 'session_token' });
        if (!cookies[0]) {
          respond({ success: false, error: 'session_token cookie yok — Kick.com\'a giriş yap' });
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

  // Rate test — N istek arka arkaya, gecikme ile
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

  // İstatistikler — alarm sayısı, son alarm, vb.
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

  // Force re-fetch — backoff atla, hemen API çağır
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

  // v2.3.1 (Plan B/M4): Son 5 dk API istatistiği — test paneli "Son 5dk" panosu
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

  // Plan C — sadece proxy durumu sorgusu (light-weight, frequent polling için)
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

  // Anomaly listesi — popup'ın anomaly check'lerinin son halini ver
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
  // v2.3.0: Popup chat istatistiklerini ister — Chrome offscreen'e veya Firefox local'e
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

  // v2.3.0: Diagnostic — bot tracker durumunu öğren
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
        // SW-tarafı Plan F durumu (offscreen/Firefox fark etmez) — test/teşhis için
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
        const isFirefox = typeof browser !== 'undefined';
        const fromUser = msg.fromUser || 'Someone';
        const channel = msg.channel || '';
        const message = msg.message || '';

        const title = Utils.i18n('chatTagNotifTitle', [fromUser]) || `@${fromUser} mentioned you`;
        const body = (channel ? `[${channel}] ` : '') + message;

        const id = `kickalert-tag-${Date.now()}`;
        const notifOptions = {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: title,
          message: body.substring(0, 200),
        };
        if (!isFirefox) {
          notifOptions.silent = false;
          if (channel) {
            notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
          }
        }

        chrome.notifications.create(id, notifOptions);

        // Track for click handling — reuse notifiedLives structure
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
        const isFirefox = typeof browser !== 'undefined';
        const fromUser = msg.fromUser || '';
        const channel = msg.channel || '';
        const message = msg.message || '';

        const title = Utils.i18n('chatBroadcasterNotifTitle', [fromUser || channel])
                      || `${fromUser || channel} wrote`;
        const body = message;

        const id = `kickalert-broadcaster-${Date.now()}`;
        const notifOptions = {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: title,
          message: body.substring(0, 200),
        };
        if (!isFirefox) {
          notifOptions.silent = false;
          if (channel) {
            notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
          }
        }

        chrome.notifications.create(id, notifOptions);

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
    // Test notification with buttons — uses first live channel or a fake one
    const testCh = cachedChannels.find(c => c.isLive) || {
      channelSlug: 'test-channel',
      userUsername: 'TestChannel',
      sessionTitle: 'Test notification — try Open & Mute buttons',
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
  // Gerçek bir kanalı yayın açmış gibi simüle eder — handlePusherLiveEvent'i
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

        // 2. baseline guard kontrolü — lastCheckDone yoksa bildirim gitmez
        if (!before.lastCheckDone) {
          log('Baseline', 'warn', 'lastCheckDone=false — gerçek bildirim için önce bir check çalışmalı (test yine de akışı dener)');
        } else {
          log('Baseline', 'ok', 'lastCheckDone=true — bildirim akışı aktif');
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
        const notifyMode = msg.dryRun ? '(dryRun — gerçek bildirim gönderilmeyecek)' : '(gerçek bildirim gönderilecek)';
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

            // 6. Temizlik — test kanalını state'ten çıkar (gerçek kanalları etkileme)
            await handlePusherOfflineEvent(testSlug);
            const cleaned = await getPersistedState();
            log('Temizlik', !cleaned.liveSlugs.has(testSlug) ? 'ok' : 'warn',
                `Test kanalı temizlendi — offline event çalıştı: ${!cleaned.liveSlugs.has(testSlug)}`);
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
            allOk ? 'Plan F bildirim akışı çalışıyor ✓' : 'Akışta sorun var — adımları incele');
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
            log('Channel Lookup', 'ok', `${targetCh.userUsername} — isLive: ${targetCh.isLive}, startedAt: ${targetCh.startedAt || 'null'}, viewers: ${targetCh.viewerCount}`);
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
              log('startedAt', 'warn', 'startedAt null — querying API...');
              const apiTime = await KickAPI.getChannelStartTime(targetCh.channelSlug);
              if (apiTime) {
                const streamAgeMs = Date.now() - new Date(apiTime).getTime();
                const ageMin = Math.round(streamAgeMs / 60000);
                log('API startTime', ageMin > 10 ? 'warn' : 'ok',
                  `API startTime: ${apiTime} (${ageMin} min) → ${ageMin > 10 ? 'SKIP' : 'NOTIFY'}`);
              } else {
                log('API startTime', 'ok', 'API startTime null — counted as new stream → NOTIFY');
              }
            }

            // notifDelay kontrolü
            const notifDelay = await Storage.getNotifDelay();
            log('notifDelay', 'ok', `Delay setting: ${notifDelay} min`);

            // DND kontrolü
            const dndActive = await Storage.isDndActive();
            const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
            log('DND', dndActive ? 'warn' : 'ok',
              dndActive ? `DND ACTIVE — mute notification: ${dndMuteNotif}` : 'DND off');

            // Bildirim ayarı
            const showNotif = await Storage.getShowNotification();
            log('Notification Setting', showNotif ? 'ok' : 'warn',
              showNotif ? 'Notifications enabled' : 'Notifications DISABLED — will not send');

            // Suspend kontrolü
            const suspended = !!(await Storage.getSuspendFromDate());
            log('Suspend', suspended ? 'warn' : 'ok',
              suspended ? 'Extension suspended — will not notify' : 'Extension active');

            // i18n kontrolü
            await Utils.ensureI18n();
            const lang = Utils.getCurrentLang();
            const testTitle = Utils.i18n('notifStartedStreaming', [targetCh.userUsername]);
            log('i18n', 'ok', `Lang: ${lang} — Notification text: "${testTitle}"`);

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
        log('General Error', 'error', e.message + ' — ' + e.stack?.split('\n')[1]?.trim());
        respond({ success: false, results });
      }
    })();
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // v2.3.1 — 5 SENARYO HANDLER'I (Senaryo 3 = E2E_TEST yukarıda)
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── SENARYO 1: SAĞLIK KONTROLÜ ───
  // Bağlantı, auth, hız ve cookie sağlığını ardışık ölçer.
  if (msg.type === 'RUN_SCENARIO_HEALTH') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });
      const start = Date.now();

      try {
        // 1. DNR ruleset aktif mi?
        // v2.3.1 fix: Eskiden ruleset ID'si 'origin_override' veya 'rules' diye sabit
        // arayordu. Manifest'te ID 'ruleset_1' ama yarın değişebilir. En az 1 enabled
        // ruleset varsa OK kabul et — gerçek dünya kanıtı bu yeterli.
        try {
          const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
          if (enabled.length > 0) {
            log('DNR Origin Override', 'ok', `Aktif rulesets: ${enabled.join(', ')}`);
          } else {
            log('DNR Origin Override', 'error', 'Hiçbir ruleset aktif değil — Cloudflare 403 yağmuru riski');
          }
        } catch (e) {
          log('DNR Origin Override', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 2. Session token mevcut mu?
        const token = await KickAPI.getSessionToken();
        log('Session Token', token ? 'ok' : 'warn',
          token ? `Token bulundu (${token.length} karakter)` : 'Token YOK — kick.com\'a giriş yapılmalı');

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
          boRemain > 0 ? `Aktif — ${Math.round(boRemain/1000)}sn kaldı` : 'Temiz');

        // 5. Tek API testi (gerçek istek, response time)
        const apiStart = Date.now();
        try {
          // Backoff aktifken normal fetchKick reddeder; geçici bypass için doğrudan fetch yapalım
          if (boRemain > 0) {
            log('API Test', 'warn', 'Backoff aktif — gerçek istek atılmadı (recovery mekanizması bekleniyor)');
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

        // 8. Plan C — Content Script Proxy hazır mı?
        try {
          const proxyAvail = await KickAPI.hasProxyTab();
          const proxyStats = KickAPI.getProxyStats();
          if (!proxyAvail) {
            log('Plan C Proxy', 'warn',
              `Açık kick.com sekmesi yok — istekler SW üzerinden gidiyor (CF baskısına açık)`);
          } else {
            // Tab var ama fail oranı yüksek mi? (eski content script senaryosu)
            const totalAttempts = proxyStats.hits + proxyStats.fails;
            const failRate = totalAttempts > 0 ? Math.round((proxyStats.fails / totalAttempts) * 100) : 0;
            if (totalAttempts >= 5 && failRate >= 30) {
              log('Plan C Proxy', 'warn',
                `Tab var ama %${failRate} fail (${proxyStats.fails}/${totalAttempts}) — kick.com sekmesini Ctrl+R ile yenile (eski content script)`);
            } else {
              log('Plan C Proxy', 'ok',
                `Aktif kick.com sekmesi · Hits: ${proxyStats.hits} · Misses: ${proxyStats.misses} · Fails: ${proxyStats.fails}` +
                (totalAttempts > 0 ? ` · Başarı: %${100 - failRate}` : ' · henüz istek yok'));
            }
          }
        } catch (e) {
          log('Plan C Proxy', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 9. Plan B — Savunma katmanları (jitter + dinamik yavaşlatma + peak saat)
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

        // 10. Plan D — Minimal header reversal (3 header modu doğrulama)
        try {
          const hdrs = await KickAPI.makeHeaders('sw');
          const keys = Object.keys(hdrs);
          const hasAccept = 'Accept' in hdrs;
          const hasPlatform = 'X-App-Platform' in hdrs;
          const hasAuth = keys.some(k => k.toLowerCase() === 'authorization');
          const ok3 = hasAccept && hasPlatform; // Authorization token yoksa da olabilir
          log('Plan D (Min. Header)', ok3 ? 'ok' : 'warn',
            `${keys.length} header · Accept:${hasAccept ? '✓' : '✗'} · X-App-Platform:${hasPlatform ? '✓' : '✗'} · Authorization:${hasAuth ? '✓' : '—'}`);
        } catch (e) {
          log('Plan D (Min. Header)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 11. Plan E — Pusher state yönetimi (#C/#D/#E fix) + log temizliği
        try {
          const pusherLiveCount = _pusherLiveSlugs.size;
          log('Plan E (State+Log)', 'ok',
            `Pusher-canlı işaretli: ${pusherLiveCount} kanal · DEBUG modu: ${DEBUG_MODE ? 'AÇIK' : 'kapalı (prod)'} · _pusherLiveSlugs union aktif`);
        } catch (e) {
          log('Plan E (State+Log)', 'warn', `Sorgulanamadı: ${e.message}`);
        }

        // 12. Plan F — Pusher WebSocket durumu (offscreen LiveTracker)
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
          dndActive ? `AKTIF — bildirim mute: ${dndMuteN}, ses mute: ${dndMuteS}` : 'Pasif');

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
          boRemain > 0 ? `Aktif — ${Math.round(boRemain/1000)}sn kaldı` : 'Temiz (recovery testi başlatılabilir)');

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
          refreshed ? `Başarılı (${refreshMs}ms) — Cookie'ler tazelendi` : `Başarısız veya cooldown reddi (${refreshMs}ms)`);

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
          log('Test API Çağrısı', 'ok', `HTTP ${resp.status} (${Date.now() - apiStart}ms) — recovery sonrası başarılı`);
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
          `Önceki 5dk: ${before.successes} başarı / ${before.failures} hata / oran: ${before.successRate ?? '—'}%`);

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
          m4Detail = `M4 AKTİF — alarm aralığı ${_currentEffectiveSecs}sn (${failures} hata/10dk)`;
        } else if (failures >= SLOWMODE_FAILURE_THRESHOLD) {
          m4Status = 'warn';
          m4Detail = `Eşik aşıldı (${failures}/${SLOWMODE_FAILURE_THRESHOLD}) ama henüz alarm yeniden zamanlanmamış — bir sonraki tick aktive edecek`;
        } else {
          m4Status = 'ok';
          m4Detail = `${failures} hata/10dk (eşik: ${SLOWMODE_FAILURE_THRESHOLD}) — yavaşlatma gerekmiyor`;
        }
        log('M4 Yavaşlatma Durumu', m4Status, m4Detail);

        // 6. Backoff sonuç durumu
        const finalBackoff = Math.max(0, (KickAPI._lastBackoffUntil || 0) - Date.now());
        log('Test Sonrası Backoff',
          finalBackoff > 0 ? 'warn' : 'ok',
          finalBackoff > 0 ? `${Math.round(finalBackoff/1000)}sn aktif` : 'Temiz');

        // 7. Plan B değerlendirmesi
        // v2.3.21: Artık kesin biliyoruz — düşük başarı oranı Cloudflare baskısı
        // DEĞİL, Kick'in kendi sunucu tarafındaki tutarsızlık (aynı geçerli token
        // bazen 200 bazen 401 dönüyor, kick.com'un kendi sitesinde bile kanıtlandı).
        // Eski mesaj "CF baskısı yüksek, Plan C düşünülmeli" yanıltıcıydı — Plan C
        // zaten aktif olsa da bu sorunu çözmüyor.
        let verdict;
        if (successRate >= 90) verdict = '✅ Sağlam: %90+ başarı, tutarsızlık yok';
        else if (successRate >= 70 && failures >= 3) verdict = '✅ Savunma çalışıyor: M4 yavaşlatma devreye girdi';
        else if (successRate < 50) verdict = '⚠ Kick sunucu tutarsızlığı olası — "Auth Tutarlılık Testi (cf-ray)" ile örüntüyü incele';
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

  // v2.3.21: Auth Tutarlılık Teşhisi — backoff'u hiç tetiklemeden N ham istek
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

        // Her isteği ayrı adım olarak göster — cf-ray dahil
        probe.forEach(p => {
          const rayShort = p.cfRay ? p.cfRay.split('-')[0] : '—';
          log(
            `İstek ${p.i}/${probe.length}`,
            p.ok ? 'ok' : 'error',
            `${p.status} · via:${p.via} · cf-ray:${rayShort} · ${p.ms}ms${p.err ? ' · ' + p.err : ''}`
          );
        });

        // cf-ray öneklerine göre grupla — örüntü var mı diye
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
        if (successRate === 100) verdict = '✅ 10/10 başarı — bu oturumda tutarsızlık gözlenmedi (şu an sorun yok gibi)';
        else if (successRate === 0) verdict = '❌ 0/10 başarı — kalıcı bir reddediliş, geçici tutarsızlık değil';
        else verdict = `🟡 Karışık: ${okCount}/${probe.length} başarı — Kick sunucu tutarsızlığı örüntüsü kanıtlandı`;
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

// Debug helper — call testNotification() from Service Worker console
self.testNotification = async function() {
  const testCh = cachedChannels.find(c => c.isLive) || {
    channelSlug: 'test-channel',
    userUsername: 'TestChannel',
    sessionTitle: 'Test notification — try Open & Mute buttons',
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
