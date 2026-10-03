/**
 * KickAlert - Content Script
 * 1) Auto-unmute functionality for kick.com.
 * 2) Plan C (v2.3.1): API Proxy — background SW'in fetchKick'i bu sekmeyi
 *    proxy olarak kullanır. Cloudflare için 'gerçek tarayıcı sekmesi' olduğumuz
 *    için 403 baskısı kırılır.
 * © 2025 Segelferd. All rights reserved.
 */

// ─── v2.5.62: Eklenti bağlamı koruması ───
// Eklenti güncellenince / yeniden yüklenince açık kick.com sekmelerindeki eski
// içerik betiği "yetim" kalır; chrome.runtime.sendMessage bu durumda Promise
// reddetmek yerine ANINDA "Extension context invalidated" hatası fırlatır ve
// .catch() bunu yakalayamaz (chrome://extensions → Hatalar'a düşer). Tüm
// mesajlar bu yardımcıdan geçer; bağlam kopmuşsa sessizce hiçbir şey yapmaz.
function kaContextAlive() {
  try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
}
function kaSend(msg) {
  if (!kaContextAlive()) return;
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => { /* SW uykuda olabilir */ });
  } catch (e) { /* bağlam koptu */ }
}

// ─── 1) Auto-unmute (mevcut) ───
(async function () {
  const result = await chrome.storage.local.get('autoUnmute');
  if (!result.autoUnmute) return;

  const observer = new MutationObserver(() => {
    const video = document.querySelector('video');
    if (video && video.muted) {
      video.muted = false;
      observer.disconnect();
      // v2.3.27: Tarayıcının otomatik oynatma politikası, kullanıcı etkileşimi
      // olmayan sekmelerde (örn. "Otomatik Aç" ile arka planda açılan sekmeler)
      // sesi açma girişimini engelleyip videoyu DURDURUYOR — sessiz ama oynayan
      // bir video yerine tamamen donmuş bir video elde ediyorduk. Kısa bir süre
      // sonra videonun durdurulup durdurulmadığını kontrol ediyoruz; durduysa
      // sessize geri dönüp oynatmayı devam ettiriyoruz — en azından akış kesilmesin.
      setTimeout(() => {
        if (video.paused) {
          video.muted = true;
          video.play().catch(() => {});
        }
      }, 300);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
})();

// ─── 2) Plan C: API Proxy — background SW'in fetchKick proxy isteklerine cevap ───
//
// Background SW şu mesajı atar:
//   { type: 'KICK_API_PROXY_FETCH', url: '...', headers: {Authorization: 'Bearer ...', ...} }
// Biz cevap olarak şunu döneriz:
//   { ok: true, status: 200, body: '<json text>', headers: {<key:val>} }
//   veya { ok: false, error: '<msg>', status?: <num> }
//
// v2.3.1 fix: SW'den gelen headers (Authorization Bearer dahil) MUTLAKA fetch'e
// iletilmeli, yoksa kick.com 401 döner. Eski sürümde headers eklenmiyordu.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'KICK_API_PROXY_FETCH' && typeof msg.url === 'string') {
    (async () => {
      try {
        // Sadece kick.com domain'ine izin ver — güvenlik koruması
        const url = new URL(msg.url);
        if (url.hostname !== 'kick.com' && !url.hostname.endsWith('.kick.com')) {
          sendResponse({ ok: false, error: 'Only kick.com URLs allowed' });
          return;
        }
        const resp = await fetch(msg.url, {
          method: 'GET',
          credentials: 'include',
          headers: msg.headers || {},  // v2.3.1 fix: SW'den gelen Authorization vb. iletilir
        });
        const body = await resp.text();
        // Response header'larından önemli olanları yakala (Retry-After vb.)
        const respHeaders = {};
        for (const [k, v] of resp.headers.entries()) {
          respHeaders[k.toLowerCase()] = v;
        }
        sendResponse({
          ok: resp.ok,
          status: resp.status,
          body: body,
          headers: respHeaders,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true; // async response
  }
  // Diğer mesaj tipleri için no-op
});

// ─── 3) Plan F (v2.3.1): channel_id harvest — sayfa context'inden ───
//
// Pusher WebSocket subscribe için channel_id gerekli. SW'den /api/v2/channels/{slug}
// çağırmak Cloudflare 403 riski taşıyor (peak saatte). AMA content script SAYFA
// context'inde çalışıyor → sayfa cf_clearance cookie'sine sahip → 403 ALMAZ.
//
// Kullanıcı bir kanal sayfası açtığında (kick.com/{slug}), o slug'ın channel_id'sini
// sayfa context'inde çekip SW'ye iletiyoruz. SW bunu kalıcı cache'ler. Sıfır SW-API
// baskısı ile Plan F'in yakıtı (channel_id) toplanmış olur.
(async function harvestChannelIdFromPage() {
  try {
    // Sadece kanal sayfalarında çalış: kick.com/{slug}
    // Hariç tutulan path'ler: ana sayfa, /browse, /following, /category vb.
    const path = location.pathname.replace(/^\/+|\/+$/g, ''); // baştaki/sondaki / temizle
    if (!path) return; // ana sayfa
    const slug = path.split('/')[0].toLowerCase();

    // Slug olmayan bilinen route'ları atla
    const NON_CHANNEL_ROUTES = new Set([
      'browse', 'following', 'category', 'categories', 'search', 'clips',
      'subscriptions', 'messages', 'settings', 'wallet', 'dashboard',
      'help', 'about', 'careers', 'partners', 'community', 'discover',
    ]);
    if (NON_CHANNEL_ROUTES.has(slug)) return;
    // Slug formatı kontrolü (Kick kullanıcı adları: harf/rakam/_/- )
    if (!/^[a-z0-9_-]{2,32}$/.test(slug)) return;

    // Sayfa context'inde channel verisini çek (cf_clearance korumalı → 403 yok)
    const resp = await fetch(`https://kick.com/api/v2/channels/${slug}`, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'application/json' },
    });
    if (!resp.ok) return; // 403/404 — sessiz, harvest fallback devreye girer
    const data = await resp.json();
    const channelId = data?.id ?? null;
    const chatroomId = data?.chatroom?.id ?? null;
    if (!channelId) return;

    // SW'ye ilet — kalıcı cache + Pusher subscribe
    kaSend({
      type: 'CHANNEL_ID_HARVESTED',
      slug,
      channelId,
      chatroomId,
    }); // SW uykuda olabilir, sorun değil — sonra tekrar denenir
  } catch (e) {
    // Sessiz — sayfa context'i hatası kritik değil
  }
})();

// ─── 4) Reklam Engelleme (DENEYSEL, v2.3.18) — ayar köprüsü ───
//
// adblock-worker-hook.js (MAIN dünya) reklam mantığını çalıştırır, ama Chrome
// storage'a MAIN dünyadan erişilemez. Bu köprü, ISOLATED dünyada storage'ı
// okuyup postMessage + localStorage ile MAIN dünyaya iletir. Jeton (nonce)
// sahte config mesajlarını engellemek için kullanılıyor (worker-hook.js
// içindeki mantıkla birebir aynı doğrulama).
(async function adBlockConfigBridge() {
  try {
    const result = await chrome.storage.local.get('adBlockEnabled');
    const enabled = result.adBlockEnabled === true;
    // localStorage bayrakları — worker sarmalama kararı document_start'ta,
    // storage.local'ı bekleyemeden ÖNCE alınıyor, bu yüzden senkron okunabilir
    // bir yere de yazmamız lazım.
    try { localStorage.setItem('__ka_ab_video', enabled ? '1' : '0'); } catch (e) {}
    try { localStorage.setItem('__ka_ab_vod', enabled ? '1' : '0'); } catch (e) {}

    // v2.5.14: TEŞHİS LOGU — chrome.storage.local'dan GERÇEKTE ne okunduğunu
    // ve localStorage'a ne yazıldığını görmemiz için.
    try { console.log('%c KickAlert \u00b7 ADB-09 %c TEŞHİS: content.js koprusu calisti, chrome.storage.adBlockEnabled=' + JSON.stringify(result.adBlockEnabled) + ' -> localStorage yazildi=' + (enabled ? '1' : '0'), 'background:#616161;color:#fff;border-radius:3px;padding:1px 2px', 'color:inherit'); } catch (e) {}
    kaSend({
      type: 'AD_BLOCK_LOG', level: 'info', code: 'ADB-09',
      text: 'content.js koprusu calisti, chrome.storage.adBlockEnabled=' + JSON.stringify(result.adBlockEnabled) + ' -> localStorage yazildi=' + (enabled ? '1' : '0'),
    });

    const nonce = (crypto?.randomUUID?.() || String(Date.now()) + Math.random());
    kaAbNonce = nonce; // v2.5.74: teşhis köprüsü aynı jetonu doğrular
    window.postMessage({
      source: 'ka-ab-cfg',
      n: nonce,
      settings: { enabled, blockVideoAds: enabled, blockVodAds: enabled },
    }, '*');

    // Ayar popup'tan değişirse (sayfa yeniden yüklenmeden), canlı güncelle
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.adBlockEnabled) return;
      const newEnabled = changes.adBlockEnabled.newValue === true;
      try { localStorage.setItem('__ka_ab_video', newEnabled ? '1' : '0'); } catch (e) {}
      try { localStorage.setItem('__ka_ab_vod', newEnabled ? '1' : '0'); } catch (e) {}
      window.postMessage({
        source: 'ka-ab-cfg',
        n: nonce,
        settings: { enabled: newEnabled, blockVideoAds: newEnabled, blockVodAds: newEnabled },
      }, '*');
    });
  } catch (e) {
    // Sessiz — reklam engelleme opsiyonel bir özellik, hata kritik değil
  }
})();

// ─── 5) Reklam Engelleme (DENEYSEL, v2.3.19) — log köprüsü ───
//
// adblock-worker-hook.js (MAIN dünya, hatta bazı loglar onun içindeki AYRI
// Worker thread'inde) kendi konsoluna yazıyor — bu, extension'ın arka plan
// konsolundan tamamen kopuk, DevTools'ta ayrı context'ler gerektiriyor.
// Bu köprü, o logları yakalayıp background.js'e iletir; background.js da
// KLog'a yazar → test panelindeki TEK Aktivite Logu'nda hepsi bir arada görünür.
window.addEventListener('message', function kaAdLogBridge(e) {
  if (e.source !== window) return;
  const d = e.data;
  if (d && d.source === 'ka-ab-log' && typeof d.text === 'string') {
    // v2.5.62: eklenti güncellendiyse bu eski betik artık log iletemez; dinlemeyi bırak
    if (!kaContextAlive()) { window.removeEventListener('message', kaAdLogBridge); return; }
    kaSend({
      type: 'AD_BLOCK_LOG',
      level: d.level || 'info',
      code: d.code || 'ADB-00',
      text: d.text,
    }); // SW uykuda olabilir, sorun değil — bu log kaybolur ama kritik değil
  }
});

// ─── 6) v2.5.74: Reklam teşhis köprüsü ───
// adblock-worker-hook.js (MAIN) yeni/tanımsız akış işaretlerini ve reklam
// aralarını 'ka-ab-diag' olarak yayınlar; burada jeton ve boyut doğrulanıp
// arka plana (AD_DIAG) iletilir, arka plan _adDiag deposunda biriktirir.
// Sayfa başına en fazla 40 mesaj (bozuk/döngüsel bir durumda taşmasın).
// var: eklenti güncellemesinde betik aynı dünyaya yeniden enjekte edilir; let/const 'already declared' hatası verirdi
var kaAbNonce = null;
var kaDiagCount = 0;
window.addEventListener('message', function kaAdDiagBridge(e) {
  if (e.source !== window) return;
  const d = e.data;
  if (!d || d.source !== 'ka-ab-diag') return;
  if (!kaContextAlive()) { window.removeEventListener('message', kaAdDiagBridge); return; }
  if (!kaAbNonce || d.n !== kaAbNonce) return;
  if (++kaDiagCount > 40) return;
  const kind = ['marker', 'adbreak', 'adbreak-end'].includes(d.kind) ? d.kind : null;
  if (!kind || typeof d.marker !== 'string' || !d.marker) return;
  kaSend({
    type: 'AD_DIAG', kind,
    marker: d.marker.slice(0, 120),
    sample: typeof d.sample === 'string' ? d.sample.slice(0, 6000) : '',
    durationSec: Number.isFinite(d.durationSec) ? Math.max(0, Math.min(3600, Math.round(d.durationSec))) : null,
  });
});

// ─── 3) v2.5.55: İzleme süresi (sadece bu cihazda) ───
// Bir kanal sayfasında video oynarken 30 sn'de bir arka plana "tik" gönderir.
// Sayılmayanlar: VOD/klip sayfaları, ana sayfa/gezinme sayfaları, arka planda
// sessiz oynayan sekme. Ayarlar'dan kapatılabilir (varsayılan açık).
(function () {
  const TICK_MS = 30000;
  const RESERVED = new Set(['browse', 'following', 'categories', 'category', 'search', 'subscriptions', 'settings',
    'dashboard', 'video', 'videos', 'clips', 'clip', 'auth', 'signup', 'login', 'terms', 'privacy', 'community-guidelines',
    'dmca', 'popout', 'embed', 'transparency', 'about', 'help', 'kick-streamer-program']);
  function slugNow() {
    const seg = location.pathname.split('/').filter(Boolean);
    if (!seg.length) return '';
    const s = seg[0].toLowerCase();
    if (RESERVED.has(s)) return '';
    if (seg[1] && ['videos', 'clips', 'about'].includes(seg[1].toLowerCase())) return '';
    return /^[a-z0-9_-]{2,40}$/.test(s) ? s : '';
  }
  const timer = setInterval(async () => {
    // v2.5.62: eklenti güncellendiyse yetim kalan sayaç kendini durdurur
    if (!kaContextAlive()) { clearInterval(timer); return; }
    try {
      const slug = slugNow();
      if (!slug) return;
      const v = document.querySelector('video');
      if (!v || v.paused || v.ended || v.readyState < 3) return;
      if (document.visibilityState !== 'visible' && v.muted) return;
      const { watchTimeEnabled } = await chrome.storage.local.get('watchTimeEnabled');
      if (watchTimeEnabled === false) return;
      kaSend({ type: 'WATCH_TICK', slug, sec: TICK_MS / 1000 });
    } catch (e) {}
  }, TICK_MS);
})();
