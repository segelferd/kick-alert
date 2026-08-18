/**
 * KickAlert - Content Script
 * 1) Auto-unmute functionality for kick.com.
 * 2) Plan C (v2.3.1): API Proxy — background SW'in fetchKick'i bu sekmeyi
 *    proxy olarak kullanır. Cloudflare için 'gerçek tarayıcı sekmesi' olduğumuz
 *    için 403 baskısı kırılır.
 * © 2025 Segelferd. All rights reserved.
 */

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
    chrome.runtime.sendMessage({
      type: 'CHANNEL_ID_HARVESTED',
      slug,
      channelId,
      chatroomId,
    }).catch(() => { /* SW uykuda olabilir, sorun değil — sonra tekrar denenir */ });
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

    const nonce = (crypto?.randomUUID?.() || String(Date.now()) + Math.random());
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
window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  const d = e.data;
  if (d && d.source === 'ka-ab-log' && typeof d.text === 'string') {
    chrome.runtime.sendMessage({
      type: 'AD_BLOCK_LOG',
      level: d.level || 'info',
      code: d.code || 'ADB-00',
      text: d.text,
    }).catch(() => { /* SW uykuda olabilir, sorun değil — bu log kaybolur ama kritik değil */ });
  }
});
