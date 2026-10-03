/**
 * KickAlert - Reklam Engelleme (DENEYSEL, v2.3.18)
 * MAIN dünya, document_start. Sadece Ayarlar'da "Reklam Engelleme (Deneysel)"
 * açıkken devrede olur (varsayılan: kapalı).
 *
 * ÇÖZÜM: Reklamı silmek/gizlemek yerine, oynatıcıyı REKLAMSIZ akışa yönlendirir.
 *
 * Kick videoyu Amazon IVS ile bir Web Worker içinde oynatır. Reklamlar (SSAI),
 * oynatıcının kullandığı playback token'ında `aws:ads-opt-out=false` olduğu için
 * sunucuda akışa dikilir. Kick'in genel API'si (/api/v2/channels/<slug>)
 * `aws:ads-opt-out=true` olan reklamsız bir playback_url veriyor.
 *
 * VOD (geçmiş yayın) reklamı TAMAMEN FARKLI mekanizma: canlıdan ayrı olarak,
 * Kick'in kendi sunucusunda videonun içine dikilir (SSAI). Kick'in genel API'si
 * aynı VOD'un reklamsız ham kaynağını da veriyor, sayfa seviyesinde değişiyoruz.
 *
 * GÜVENLİK: sadece amazon-ivs worker'ına dokunur; hata olursa orijinal akışa
 * düşer (oynatma bozulmaz). localStorage['__ka_ab_video']!=='1' ise devre dışı.
 * Bu özellik isteğe bağlıdır ve deneyseldir — Kick'in iç API yapısına bağımlı
 * olduğu için Kick tarafında değişiklik olursa bozulabilir.
 *
 * © 2026 Segelferd. All rights reserved.
 */
(function () {
  'use strict';
  if (window.__ka_ab_hook) return;
  window.__ka_ab_hook = true;

  var KA_LOG_STYLES = { 'ADB-12': 'background:#53FC18;color:#000;font-weight:bold', 'ADB-13': 'background:#1f6f2a;color:#fff', 'ADB-16': 'background:#ff9800;color:#000;font-weight:bold', 'ADB-11': 'background:#ffd54f;color:#000', 'ADB-03': 'background:#ffd54f;color:#000', 'ADB-14': 'background:#1e88e5;color:#fff', 'ADB-15': 'background:#1e88e5;color:#fff', 'ADB-10': 'background:#00897b;color:#fff', 'ADB-02': 'background:#00897b;color:#fff', 'ADB-04': 'background:#00897b;color:#fff', 'ADB-09': 'background:#616161;color:#fff', 'ADB-01': 'background:#5e35b1;color:#fff', 'ADB-05': 'background:#5e35b1;color:#fff', 'ADB-06': 'background:#5e35b1;color:#fff', 'ADB-07': 'background:#8e24aa;color:#fff', 'ADB-08': 'background:#6d4c41;color:#fff' };
  // v2.5.74: konsolda renkli rozet: "KickAlert · ADB-xx" + metin (konsol filtresi 'kickalert' çalışmaya devam eder)
  function kaClog(code, text) {
    try { console.log('%c KickAlert \u00b7 ' + code + ' %c ' + text, (KA_LOG_STYLES[code] || 'background:#37474f;color:#fff') + ';border-radius:3px;padding:1px 2px', 'color:inherit'); } catch (e) {}
  }

  var pageNonce = null;
  var pageEnabled = true; // canlı yayın reklamı ayarı
  try { pageEnabled = localStorage.getItem('__ka_ab_video') === '1'; } catch (e) {}
  var pageVod = true; // geçmiş yayın (VOD) ayrı bayrak
  try { pageVod = localStorage.getItem('__ka_ab_vod') !== '0'; } catch (e) {}

  // v2.5.14: TEŞHİS LOGU — koşulsuz çalışır, bu script'in gerçekten
  // çalıştığını ve localStorage'dan ne okuduğunu kesin olarak görmemiz için.
  try {
    var __diagRaw = null;
    try { __diagRaw = localStorage.getItem('__ka_ab_video'); } catch (e) { __diagRaw = 'OKUMA HATASI'; }
    kaClog('ADB-09', 'TEŞHİS: worker-hook.js calisti, __ka_ab_video=' + JSON.stringify(__diagRaw) + ' pageEnabled=' + pageEnabled + ' pageVod=' + pageVod);
    window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-09', text: 'worker-hook.js calisti, __ka_ab_video=' + JSON.stringify(__diagRaw) + ' pageEnabled=' + pageEnabled + ' pageVod=' + pageVod }, '*');
  } catch (e) {}

  function vodUrlBildir(u) {
    if (!u) return;
    try { window.__ka_ab_vodUrl = u; } catch (e) {}
    try { window.postMessage({ source: 'ka-ab', type: 'vodUrl', url: u, n: pageNonce }, '*'); } catch (e) {}
  }

  var PLAYBACK_PAGE_RE = /\/api\/v\d+\/stream\/[0-9a-f-]+\/playback(\?|$)/i;
  var STITCHED_RE      = /\/api\/v\d+\/stream\/manifest\.m3u8/i;

  function slugNow() {
    try { return window.location.pathname.split('/').filter(Boolean)[0] || ''; } catch (e) { return ''; }
  }

  function jsonResponse(obj, resp) {
    try {
      var hh = new Headers();
      try { resp.headers.forEach(function (v, k) { if (k.toLowerCase() !== 'content-length') hh.append(k, v); }); } catch (e) {}
      return new Response(JSON.stringify(obj), { status: resp.status, statusText: resp.statusText, headers: hh });
    } catch (e) { return resp; }
  }

  function neutralizeAds(json) {
    var changed = false;
    try {
      var vp = json && json.video_player;
      if (vp) ['google_ads_sdk', 'pal_sdk'].forEach(function (k) {
        var s = vp[k];
        if (s) { if (s.initiate_sdk) { s.initiate_sdk = false; changed = true; } if (s.sdk_available) { s.sdk_available = false; changed = true; } }
      });
      var vs = json && json.video_session;
      if (vs && vs.auto_ads_enabled) { vs.auto_ads_enabled = false; changed = true; }
    } catch (e) {}
    return changed;
  }

  var vodListCache = new Map(); // slug -> {ts, items} — v2.5.3: Mo'Kick v3.2.8'den esinlenildi
  var vodListInFlight = new Map(); // slug -> promise

  // v2.5.3: Eskiden vodList/vodListInFlight TEK SLOTLUYDU (sadece bir slug'ı
  // hatırlayabiliyordu). Kullanıcı hızlıca iki farklı kanal arasında geçiş
  // yaparsa (örn. iki VOD sekmesi), tek-slotlu yapı YANLIŞ kanalın verisini/
  // in-flight promise'ini döndürebilirdi. Artık her slug kendi kaydını taşıyor.
  function getVodList(slug, origFetch) {
    var cached = vodListCache.get(slug);
    if (cached && (Date.now() - cached.ts) < 60000) return Promise.resolve(cached.items);
    if (!slug) return Promise.resolve([]);
    var inFlight = vodListInFlight.get(slug);
    if (inFlight) return inFlight;

    function attempt(retriesLeft) {
      return origFetch.call(window, 'https://kick.com/api/v2/channels/' + slug + '/videos')
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var arr = Array.isArray(j) ? j : ((j && j.data) || []);
          vodListCache.set(slug, { ts: Date.now(), items: arr });
          return arr;
        })
        .catch(function (err) {
          if (retriesLeft > 0) {
            return new Promise(function (resolve) { setTimeout(resolve, 250); }).then(function () { return attempt(retriesLeft - 1); });
          }
          throw err;
        });
    }

    var p = attempt(1).catch(function () { return []; }).finally(function () {
      if (vodListInFlight.get(slug) === p) vodListInFlight.delete(slug);
    });
    vodListInFlight.set(slug, p);
    return p;
  }

  function primeVodCatalog(slug, origFetch) {
    if (!slug) return;
    var cached = vodListCache.get(slug);
    if (cached && (Date.now() - cached.ts) < 60000) return;
    getVodList(slug, origFetch).catch(function () {});
  }

  function isVodPage() {
    try { return /\/videos\/[0-9a-f-]{8,}/i.test(window.location.pathname); } catch (e) { return false; }
  }

  (function setupVodPriming() {
    var lastPrimedSlug = '';
    function prime() {
      try {
        if (!pageVod || !isVodPage()) return;
        var slug = slugNow();
        if (!slug || slug === lastPrimedSlug) return;
        lastPrimedSlug = slug;
        // v2.5.2: origPageFetch bu noktada henüz atanmamış olabilir (aşağıda
        // tanımlanıyor) — ama 'var' hoisting + setTimeout ile bir sonraki
        // tick'e ertelendiği için, bu fonksiyon GERÇEKTEN çalıştığında script
        // tamamen yüklenmiş, origPageFetch atanmış olacak.
        if (typeof origPageFetch === 'function') primeVodCatalog(slug, origPageFetch);
      } catch (e) {}
    }
    setTimeout(prime, 0);
    try {
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig === 'function') { history[m] = function () { var r = orig.apply(this, arguments); try { prime(); } catch (e) {} return r; }; }
      });
      window.addEventListener('popstate', prime);
    } catch (e) {}
  })();

  // v2.5.2: Mo'Kick v3.2.4'ten esinlenildi. Slug'ı sadece sayfa URL'sinden değil,
  // ÖNCE yanıtın kendi payload'ından çıkarmayı dene — hangi VOD'un işlendiğine
  // dair en güvenilir kaynak bu, URL ile senkronizasyon gecikmesi riski taşımıyor.
  function slugFromPayload(json) {
    try {
      var vs = json && json.video_session;
      var candidates = [
        vs && vs.livestream && vs.livestream.channel && vs.livestream.channel.slug,
        vs && vs.channel && vs.channel.slug,
        json && json.livestream && json.livestream.channel && json.livestream.channel.slug,
        json && json.channel && json.channel.slug,
      ];
      for (var i = 0; i < candidates.length; i++) {
        if (typeof candidates[i] === 'string' && candidates[i]) return candidates[i];
      }
    } catch (e) {}
    return null;
  }

  function cleanVodSource(vs, slug, origFetch) {
    var want = Number(vs && vs.video_duration);
    if (!want || !slug) return Promise.resolve(null);
    return getVodList(slug, origFetch).then(function (arr) {
      var scored = arr.map(function (x) {
        var d = Number(x && x.duration);
        return { entry: x, diff: d ? Math.abs(Math.round(d / 1000) - want) : Infinity };
      });
      var title = vs && vs.video_title;
      var sameTitle = function (s) { return title && String(s.entry.session_title || '') === String(title); };

      // v2.5.2: Önce SIKI tolerans (1sn) dene. Bulunamazsa GEVŞEK tolerans
      // (5sn) ile dene AMA sadece başlık da eşleşiyorsa — yanlış pozitif
      // riskini artırmadan daha fazla eşleşme yakalıyoruz.
      var cands = scored.filter(function (s) { return s.diff <= 1; }).map(function (s) { return s.entry; });
      if (!cands.length) {
        cands = scored.filter(function (s) { return s.diff <= 5 && sameTitle(s); }).map(function (s) { return s.entry; });
      }
      if (cands.length > 1 && title) {
        var t = cands.filter(function (x) { return String(x.session_title || '') === String(title); });
        if (t.length) cands = t;
      }
      var src = cands[0] && cands[0].source;
      return (typeof src === 'string' && /^https:\/\/[^/]+\.kick\.com\/.+\.m3u8/i.test(src)) ? src : null;
    }).catch(function () { return null; });
  }

  // v2.5.3: Mo'Kick v3.2.8'den esinlenildi. Kick'in thumbnail URL'si genelde
  // aynı depolama alanının bir alt yolu — bu yoldan doğrudan reklamsız master'ı
  // TAHMİN edebiliyoruz, katalog aramaya (getVodList, bir ağ isteği daha) hiç
  // gerek kalmadan. Sadece hızlı bir DENEME — tutmazsa cleanVodSource'a (asıl
  // katalog araması) düşülüyor, hiçbir davranış kaybı yok.
  function deriveSourceFromThumbnail(pu) {
    try {
      var thumb = pu && pu.thumbnail;
      if (typeof thumb !== 'string' || !thumb) return null;
      var marker = '/media/thumbnails/';
      var cut = thumb.indexOf(marker);
      if (cut === -1) return null;
      var derived = thumb.slice(0, cut) + '/media/hls/master.m3u8';
      if (!/^https:\/\/[^/]+\.kick\.com\//i.test(derived)) return null; // güvenlik: sadece kick.com'a ait host
      return derived;
    } catch (e) { return null; }
  }

  function isVodUrlPage() {
    try { return /\/videos\/[0-9a-f-]{8,}/i.test(window.location.pathname); } catch (e) { return false; }
  }

  // v2.5.68: SAYFA SEVİYESİNDE CANLI DEĞİŞİM (ClearKick 1.0.3 ve Kick Ad
  // Blocker 1.1.0'ın Ekim 2026 yöntemi). Kick oynatıcısı akış adresini
  // /api/v1/stream/<id>/playback yanıtından alıyor; bu yanıttaki
  // playback_url.live token'ı reklam parametreleri (aws:ads-player-params,
  // MediaTailor SSAI) taşıyor. Aynı kanalın /api/v2/channels/<slug>
  // adresi ise aws:ads-opt-out=true. Yanıt oynatıcıya ulaşmadan önce adresi
  // değiştiriyoruz; böylece worker sarmalaması tutmasa bile oynatıcı en
  // baştan reklamsız akışı açıyor. Worker'daki master değişimi yedek olarak
  // duruyor.
  // GÜVENLİK: iki adresin yolu birebir aynı olmalı (aynı IVS kanalı, sadece
  // token farklı); değilse dokunulmuyor. Her hata ve 2.5 sn zaman aşımı
  // durumunda orijinal yanıt dönüyor.
  var LIVE_RESERVED = { video: 1, videos: 1, clips: 1, clip: 1, category: 1, categories: 1, browse: 1, following: 1, search: 1, drops: 1, subscriptions: 1, messages: 1, dashboard: 1, settings: 1, api: 1, popout: 1, help: 1, about: 1 };
  function liveSlug() {
    try {
      var segs = window.location.pathname.split('/').filter(Boolean);
      if (segs.length !== 1) return '';
      return LIVE_RESERVED[segs[0].toLowerCase()] ? '' : segs[0];
    } catch (e) { return ''; }
  }
  function sameChannel(a, b) {
    try { return new URL(a).pathname === new URL(b).pathname; } catch (e) { return false; }
  }
  var liveAf = { slug: '', url: '', ts: 0, inflight: null, inflightSlug: '' };
  function getLiveAdFree(slug) {
    if (!slug || typeof origPageFetch !== 'function') return Promise.resolve(null);
    var now = Date.now();
    if (liveAf.slug === slug && liveAf.url && (now - liveAf.ts) < 60000) return Promise.resolve(liveAf.url);
    if (liveAf.inflight && liveAf.inflightSlug === slug) return liveAf.inflight;
    var pr = origPageFetch.call(window, 'https://kick.com/api/v2/channels/' + slug, { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pu = j && j.playback_url;
        var u = typeof pu === 'string' ? pu : (pu && typeof pu.live === 'string' ? pu.live : '');
        if (!u || !/^https:\/\//i.test(u)) return null;
        liveAf.slug = slug; liveAf.url = u; liveAf.ts = Date.now();
        return u;
      })
      .catch(function () { return null; })
      .finally(function () { if (liveAf.inflight === pr) { liveAf.inflight = null; liveAf.inflightSlug = ''; } });
    liveAf.inflight = pr; liveAf.inflightSlug = slug;
    return pr;
  }
  function primeLiveAdFree() {
    try { if (pageEnabled) { var s = liveSlug(); if (s) getLiveAdFree(s); } } catch (e) {}
  }
  function withTimeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var t = setTimeout(function () { if (!done) { done = true; resolve(null); } }, ms);
      Promise.resolve(promise).then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } }, function () { if (!done) { done = true; clearTimeout(t); resolve(null); } });
    });
  }
  function pageLog(code, text, level) {
    kaClog(code, text);
    try { window.postMessage({ source: 'ka-ab-log', level: level || 'info', code: code, text: text }, '*'); } catch (e) {}
  }
  function handleLivePlayback(j, resp, slug) {
    var touched = neutralizeAds(j);
    var pu = j && j.playback_url;
    var cur = typeof pu === 'string' ? pu : (pu && typeof pu.live === 'string' ? pu.live : '');
    if (!cur) return touched ? jsonResponse(j, resp) : resp;
    return withTimeout(getLiveAdFree(slug), 2500).then(function (af) {
      if (!af) { pageLog('ADB-11', 'Canlı: reklamsız adres alınamadı (zaman aşımı veya hata), orijinal yanıt kullanıldı', 'warn'); return touched ? jsonResponse(j, resp) : resp; }
      if (af === cur) return touched ? jsonResponse(j, resp) : resp;
      if (!sameChannel(cur, af)) { pageLog('ADB-11', 'Canlı: yanıt farklı bir kanala ait görünüyor, dokunulmadı', 'warn'); return touched ? jsonResponse(j, resp) : resp; }
      if (typeof pu === 'string') j.playback_url = af; else pu.live = af;
      try { window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1; } catch (e) {}
      try { window.__ka_ab_pageSwap = (window.__ka_ab_pageSwap || 0) + 1; } catch (e) {}
      try { window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*'); } catch (e) {}
      pageLog('ADB-10', 'Canlı yayın adresi oynatıcıya gitmeden reklamsız akışla değiştirildi (sayfa seviyesi, slug=' + slug + ')');
      startAdMonitor(slug, cur);
      return jsonResponse(j, resp);
    }).catch(function () { return resp; });
  }

  // v2.5.69: REKLAM ARASI İZLEYİCİ (sadece tespit, oynatmaya dokunmaz).
  // Sayfa seviyesi değişimden sonra oynatıcı reklamsız akışta olduğu için
  // reklam hiç gelmiyor ve "engellendi" diye bir olay da oluşmuyordu. Bu
  // izleyici, Kick'in oynatıcıya vermek istediği REKLAMLI akışın sadece medya
  // listesine (birkaç KB metin, video segmenti indirilmez) 10 sn'de bir bakar;
  // reklam arası başlayınca ADB-12, bitince ADB-13 yazar ve sayaçları artırır.
  // Reklamlı adresin token'ı ~10 dk geçerli; liste 403 verirse Kick'in kendi
  // /playback isteği (yakalanan aynı istek) tekrarlanıp yeni adres alınır.
  // Kanal değişince, ayar kapanınca veya 3 başarısız yenilemede durur.
  var AD_DNA_RE = /[?&]dna=([^&#\s]+)/;
  function detectAdMarkers(txt) {
    if (typeof txt !== 'string' || txt.indexOf('#EXTINF') === -1) return '';
    if (txt.indexOf('#EXT-X-CUE-OUT') !== -1) return 'CUE-OUT';
    if (txt.indexOf('stitched-ad') !== -1) {
      // v2.5.73: işaretin tam sınıf adını yaz (ör. live-video-net-stitched-ad-break-start)
      var sm = /CLASS="([^"]*stitched-ad[^"]*)"/i.exec(txt);
      return sm ? sm[1] : 'stitched-ad';
    }
    var lines = txt.split('\n'), liveLabel = 0, i, l, m, src;
    for (i = 0; i < lines.length; i++) {
      l = lines[i];
      m = /X-NET-LIVE-VIDEO-STREAM-SOURCE="?([^",]+)/i.exec(l);
      if (m && m[1].trim().toLowerCase() !== 'live') return 'kaynak=' + m[1].trim();
      if (l.indexOf('#EXTINF:') === 0) {
        var ci = l.indexOf(',');
        src = (ci >= 0 ? l.slice(ci + 1) : '').trim().toLowerCase();
        if (src === 'live') liveLabel++;
        else if (src) return 'etiket=' + src;
      } else if (l.indexOf('#EXT-X-PREFETCH:') === 0) {
        // v2.5.70: IVS önceden yükleme satırı; adres etiketle aynı satırda
        var pd = AD_DNA_RE.exec(l);
        if (pd && pd[1].length >= 1200) return 'uzun-dna (prefetch)';
        var pu2 = l.slice(16).trim();
        if (/^https?:\/\//i.test(pu2)) {
          try { if (!/\.live-video\.net$/i.test(new URL(pu2).hostname)) return 'yabanci-host (prefetch)=' + new URL(pu2).hostname; } catch (e) {}
        }
      } else if (l && l.charAt(0) !== '#') {
        var d = AD_DNA_RE.exec(l);
        if (d && d[1].length >= 1200) return 'uzun-dna';
        if (/^https?:\/\//i.test(l)) {
          try { if (!/\.live-video\.net$/i.test(new URL(l).hostname)) return 'yabanci-host=' + new URL(l).hostname; } catch (e) {}
        }
      }
    }
    return '';
  }
  // v2.5.70: TEŞHİS. Normal Kick canlı listesinde görülen etiketler ve
  // DATERANGE sınıfları. Reklamlı akışta bunların dışında bir şey çıkarsa
  // (TR'de farklı reklam işareti kullanılıyor olabilir) sayfa başına bir kez
  // ADB-16 olarak yazılır ve listenin o kısmı örnek olarak saklanır.
  var KNOWN_TAGS = { '#EXT-X-TWITCH-LIVE-SEQUENCE': 1, '#EXT-X-DISCONTINUITY': 1, '#EXTM3U': 1, '#EXT-X-VERSION': 1, '#EXT-X-TARGETDURATION': 1, '#EXT-X-MEDIA-SEQUENCE': 1, '#EXT-X-NET-LIVE-VIDEO-LIVE-SEQUENCE': 1, '#EXT-X-NET-LIVE-VIDEO-ELAPSED-SECS': 1, '#EXT-X-NET-LIVE-VIDEO-TOTAL-SECS': 1, '#EXT-X-DATERANGE': 1, '#EXT-X-PROGRAM-DATE-TIME': 1, '#EXT-X-PREFETCH': 1, '#EXTINF': 1 };
  var KNOWN_CLASSES = { 'timestamp': 1, 'live-video-net-stream-source': 1, 'live-video-net-assignment': 1 }; // v2.5.72: assignment = sunucu ataması (SERVING-ID/NODE/CLUSTER), TR testinde doğrulandı, reklam değil
  var diag = { polls: 0, ok: 0, errors: 0, refreshes: 0, lastPollAt: 0, lastOkAt: 0, lastError: '', startedAt: 0, seen: {}, findings: [], samples: [] };
  function diagSample(txt, idx, why) {
    try {
      var lines = txt.split('\n');
      var from = Math.max(0, idx - 6), to = Math.min(lines.length, idx + 10);
      // v2.5.71: DATERANGE satırları teşhis için tam saklanır (öznitelik adları görünsün), segment adresleri kısaltılır
      var snip = lines.slice(from, to).map(function (x) { var lim = x.indexOf('#EXT-X-DATERANGE') === 0 ? 2500 : 220; return x.length > lim ? x.slice(0, lim) + '…(' + x.length + ')' : x; }).join('\n');
      diag.samples.push({ at: new Date().toISOString(), slug: adMon.slug, why: why, text: snip });
      if (diag.samples.length > 5) diag.samples.shift();
      window.__ka_ab_adMonSamples = diag.samples;
    } catch (e) {}
  }
  // v2.5.74: biriktirme / isteğe bağlı gönderim için TEMİZLENMİŞ örnek:
  // sadece '#' etiket satırları; tüm adresler <url>, 24+ karakterlik kimlik
  // benzeri değerler <id> olur. Kanal adı, video adresi, token gönderilmez.
  function sanitizeSample(txt, idx) {
    try {
      var lines = String(txt).split('\n');
      var from = Math.max(0, (idx || 0) - 12), to = Math.min(lines.length, (idx || 0) + 20);
      var out = [];
      for (var i = from; i < to && out.length < 30; i++) {
        var l = lines[i];
        if (!l || l.charAt(0) !== '#') continue;
        l = strictTagLine(l);
        out.push(l.length > 400 ? l.slice(0, 400) + '…' : l);
      }
      return out.join('\n');
    } catch (e) { return ''; }
  }
  // v2.5.74: SIKI temizlik - etiket adı ve öznitelik ADLARI kalır; değer
  // sadece güvenli listedeki özniteliklerde (CLASS, süre, tarih, kaynak) ve
  // kısa/sade ise korunur, diğer tüm değerler <v> olur. Adresler <url>.
  var SAFE_ATTRS = { CLASS: 1, DURATION: 1, 'PLANNED-DURATION': 1, 'END-ON-NEXT': 1, 'X-NET-LIVE-VIDEO-STREAM-SOURCE': 1, 'START-DATE': 1, 'END-DATE': 1 };
  function strictTagLine(l) {
    l = String(l).replace(/https?:\/\/[^\s",]+/gi, '<url>');
    var ci = l.indexOf(':');
    if (ci < 0) return l.slice(0, 80);
    var tag = l.slice(0, ci), rest = l.slice(ci + 1);
    if (tag === '#EXTINF') { var m = /^([0-9.]+)\s*,?\s*(.{0,20})/.exec(rest); return '#EXTINF:' + (m ? m[1] + ',' + m[2].replace(/[^A-Za-z0-9 _.-]/g, '').trim() : '<v>'); }
    if (rest.indexOf('=') === -1) return tag + ':' + (/^[A-Za-z0-9 _.:+-]{1,32}$/.test(rest) ? rest : '<v>');
    var parts = rest.match(/[A-Z0-9-]+=("[^"]*"|[^,]*)/g) || [];
    return tag + ':' + parts.map(function (kv) {
      var eq = kv.indexOf('='), k = kv.slice(0, eq), v = kv.slice(eq + 1), raw = v.replace(/^"|"$/g, '');
      var keep = SAFE_ATTRS[k] && /^[A-Za-z0-9 _.:+-]{1,64}$/.test(raw);
      return k + '=' + (keep ? v : '<v>');
    }).join(',');
  }
  function emitDiag(kind, marker, extra) {
    try {
      var m = { source: 'ka-ab-diag', kind: kind, marker: String(marker || '').slice(0, 120), n: pageNonce };
      if (extra) for (var k in extra) m[k] = extra[k];
      window.postMessage(m, '*');
    } catch (e) {}
  }
  function firstLineIndex(txt, needle) {
    try { var ls = txt.split('\n'); for (var i = 0; i < ls.length; i++) if (ls[i].indexOf(needle) !== -1) return i; } catch (e) {}
    return 0;
  }

  function diagnosePlaylist(txt) {
    try {
      var lines = txt.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var l = lines[i];
        if (!l || l.charAt(0) !== '#') continue;
        var ci = l.indexOf(':');
        var tag = ci > 0 ? l.slice(0, ci) : l.trim();
        var key = '', label = '';
        if (!KNOWN_TAGS[tag]) { key = 'tag:' + tag; label = 'yeni etiket ' + tag; }
        else if (tag === '#EXT-X-DATERANGE') {
          var cm = /CLASS="([^"]*)"/i.exec(l);
          var cls = cm ? cm[1] : '(sinifsiz)';
          // v2.5.73: TR'de 03.10'da doğrulanan reklam sınıfları (live-video-net-stitched-ad-break-start / -creative-start ...) bilinen reklam işareti; ADB-12 zaten yazıyor
          if (!KNOWN_CLASSES[cls] && cls.indexOf('stitched-ad') === -1) { key = 'class:' + cls; label = 'yeni DATERANGE sinifi ' + cls; }
        }
        if (key && !diag.seen[key]) {
          diag.seen[key] = 1;
          diag.findings.push({ at: new Date().toISOString(), slug: adMon.slug, what: label });
          diagSample(txt, i, label);
          emitDiag('marker', key, { sample: sanitizeSample(txt, i) });
          pageLog('ADB-16', 'TEŞHİS: reklamlı akışta ' + label + ' görüldü (slug=' + adMon.slug + '). Örnek: window.__ka_ab_adMonSamples', 'warn');
        }
      }
    } catch (e) {}
  }
  function adMonStatus() {
    return {
      calisiyor: !!adMon.timer, kanal: adMon.slug, reklamArasinda: adMon.inAd,
      kontrol: diag.polls, basarili: diag.ok, hata: diag.errors, adresYenileme: diag.refreshes,
      sonKontrol: diag.lastPollAt ? new Date(diag.lastPollAt).toLocaleTimeString() : '-',
      sonBasarili: diag.lastOkAt ? new Date(diag.lastOkAt).toLocaleTimeString() : '-',
      sonHata: diag.lastError || '-',
      yakalananReklamArasi: window.__ka_ab_adBreaks || 0,
      yeniIsaretler: diag.findings.slice()
    };
  }
  try { window.__ka_ab_adMonStatus = adMonStatus; } catch (e) {}

  var lastPlaybackReq = null; // { url, init } — Kick'in kendi /playback isteği
  var adMon = { slug: '', master: '', media: '', timer: null, inAd: false, adStart: 0, reason: '', fails: 0, refreshFails: 0, lastRefresh: 0, busy: false };
  function stopAdMonitor(why) {
    if (adMon.timer) { clearInterval(adMon.timer); adMon.timer = null; }
    if (adMon.slug && why) pageLog('ADB-14', 'Reklam izleyici durdu (' + why + ')');
    adMon.slug = ''; adMon.master = ''; adMon.media = ''; adMon.inAd = false; adMon.busy = false;
  }
  function startAdMonitor(slug, adsUrl) {
    try {
      if (!slug || !adsUrl || typeof origPageFetch !== 'function') return;
      var same = adMon.slug === slug && adMon.timer;
      adMon.master = adsUrl; adMon.media = ''; adMon.fails = 0; adMon.refreshFails = 0;
      if (same) return; // izleyici zaten çalışıyor, sadece adres tazelendi
      stopAdMonitor('');
      adMon.slug = slug; adMon.master = adsUrl; adMon.inAd = false;
      adMon.timer = setInterval(adMonTick, 10000);
      pageLog('ADB-14', 'Reklam izleyici başladı (slug=' + slug + '): Kick\'in reklamlı akışı 10 sn\'de bir kontrol ediliyor, oynatıcı reklamsız akışta');
      setTimeout(adMonTick, 1500);
    } catch (e) {}
  }
  function pickMediaUrl(masterTxt, base) {
    var best = '', bestBw = Infinity, lines = masterTxt.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var m = /^#EXT-X-STREAM-INF:.*?BANDWIDTH=(\d+)/i.exec(lines[i]);
      if (!m) continue;
      var u = (lines[i + 1] || '').trim();
      if (!u || u.charAt(0) === '#') continue;
      var bw = Number(m[1]);
      if (bw < bestBw) { bestBw = bw; try { best = new URL(u, base).href; } catch (e) {} }
    }
    return best;
  }
  function refreshAdsUrl() {
    if (!lastPlaybackReq || Date.now() - adMon.lastRefresh < 60000) return Promise.resolve(false);
    adMon.lastRefresh = Date.now();
    return origPageFetch.call(window, lastPlaybackReq.url, lastPlaybackReq.init)
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var pu = j && j.playback_url;
        var u = typeof pu === 'string' ? pu : (pu && typeof pu.live === 'string' ? pu.live : '');
        if (!u || (adMon.master && !sameChannel(u, adMon.master))) return false;
        adMon.master = u; adMon.media = '';
        return true;
      }).catch(function () { return false; });
  }
  function adMonTick() {
    if (adMon.busy || !adMon.slug) return;
    if (!pageEnabled || liveSlug() !== adMon.slug) { stopAdMonitor(!pageEnabled ? 'reklam engelleme kapatıldı' : 'kanal değişti'); return; }
    adMon.busy = true;
    var forSlug = adMon.slug;
    diag.polls++; diag.lastPollAt = Date.now();
    // v2.5.70: ~10 dakikada bir özet (ADB-15) - izleyicinin gerçekten çalıştığının kanıtı
    if (diag.polls % 60 === 0) pageLog('ADB-15', 'Reklam izleyici özeti (slug=' + forSlug + '): ' + diag.polls + ' kontrol, ' + diag.ok + ' başarılı, ' + diag.errors + ' hata, ' + diag.refreshes + ' adres yenileme, yakalanan reklam arası: ' + (window.__ka_ab_adBreaks || 0) + ', yeni işaret: ' + diag.findings.length + (diag.lastError ? ', son hata: ' + diag.lastError : ''));
    var getMedia = adMon.media ? Promise.resolve(adMon.media) : origPageFetch.call(window, adMon.master, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('master ' + r.status); return r.text(); })
      .then(function (t) { var u = pickMediaUrl(t, adMon.master); if (!u) throw new Error('varyant yok'); adMon.media = u; return u; });
    getMedia.then(function (mu) {
      return origPageFetch.call(window, mu, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('liste ' + r.status);
        return r.text();
      });
    }).then(function (txt) {
      if (adMon.slug !== forSlug) return;
      adMon.fails = 0; adMon.refreshFails = 0;
      diag.ok++; diag.lastOkAt = Date.now();
      diagnosePlaylist(txt);
      var reason = detectAdMarkers(txt);
      if (reason && !adMon.inAd) {
        adMon.inAd = true; adMon.adStart = Date.now(); adMon.reason = reason;
        diagSample(txt, Math.floor(txt.split('\n').length / 2), 'reklam: ' + reason);
        emitDiag('adbreak', reason, { sample: sanitizeSample(txt, firstLineIndex(txt, reason.indexOf('-') > 0 ? reason : 'EXT-X-CUE-OUT')) });
        try { window.__ka_ab_adBreaks = (window.__ka_ab_adBreaks || 0) + 1; } catch (e) {}
        try { window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1; } catch (e) {}
        try { window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*'); } catch (e) {}
        pageLog('ADB-12', 'REKLAM GELDİ, ENGELLENDİ: Kick reklamlı akışta reklam arası başlattı (' + reason + '), oynatıcı reklamsız akışta kaldı (slug=' + forSlug + ', bugüne kadar: ' + window.__ka_ab_adBreaks + ')', 'warn');
      } else if (!reason && adMon.inAd) {
        adMon.inAd = false;
        var durSec = Math.round((Date.now() - adMon.adStart) / 1000);
        pageLog('ADB-13', 'Reklam arası bitti (yaklaşık ' + durSec + ' sn sürdü, işaret: ' + adMon.reason + ')');
        emitDiag('adbreak-end', adMon.reason, { durationSec: durSec });
      }
    }).catch(function (err) {
      if (adMon.slug !== forSlug) return;
      diag.errors++; diag.lastError = String(err && err.message || err).slice(0, 80) + ' @' + new Date().toLocaleTimeString();
      adMon.fails++;
      adMon.media = '';
      if (adMon.fails < 2) return;
      return refreshAdsUrl().then(function (ok) {
        if (ok) { adMon.fails = 0; diag.refreshes++; return; }
        adMon.refreshFails++;
        if (adMon.refreshFails >= 3) stopAdMonitor('reklamlı akış adresi yenilenemedi: ' + String(err && err.message || err).slice(0, 60));
      });
    }).then(function () { adMon.busy = false; }, function () { adMon.busy = false; });
  }

  // v2.5.68: ClearKick 1.0.3'ten uyarlandı. Yeni VOD akışında oynatıcı
  // /api/v1/stream/vod_session ucundan bir MediaTailor manifestUrl'i alıyor:
  //   https://<mt>/v1/master/<imza>/<yapılandırma>/<VARLIK-YOLU>.m3u8
  // Aynı varlık reklamsız olarak https://stream.kick.com/<VARLIK-YOLU>
  // adresinde duruyor. Türetilen adres önce çekilip gerçek bir HLS manifesti
  // olduğu doğrulanıyor; doğrulanamazsa yanıta dokunulmuyor.
  var VOD_SESSION_RE = /\/api\/v\d+\/stream\/vod_session/i;
  function vodOriginFromMediaTailor(mtUrl) {
    try {
      var m = /^https?:\/\/[^/]+\/v1\/master\/[0-9a-f]+\/[^/]+\/(.+\.m3u8)$/i.exec(String(mtUrl).split('?')[0]);
      return m ? 'https://stream.kick.com/' + m[1] : '';
    } catch (e) { return ''; }
  }
  function handleVodSession(p) {
    return p.then(function (resp) {
      try {
        return resp.clone().json().then(function (j) {
          var org = j && typeof j.manifestUrl === 'string' ? vodOriginFromMediaTailor(j.manifestUrl) : '';
          if (!org) return resp;
          return withTimeout(origPageFetch.call(window, org).then(function (probe) {
            return probe.ok ? probe.text() : null;
          }), 2500).then(function (t) {
            if (typeof t !== 'string' || t.indexOf('#EXTM3U') !== 0) return resp;
            j.manifestUrl = org;
            vodUrlBildir(org);
            try { window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1; } catch (e) {}
            try { window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*'); } catch (e) {}
            pageLog('ADB-04', 'Geçmiş yayın (VOD) MediaTailor oturumu reklamsız kaynakla değiştirildi');
            return jsonResponse(j, resp);
          }).catch(function () { return resp; });
        }).catch(function () { return resp; });
      } catch (e) { return resp; }
    }).catch(function (e) { throw e; });
  }

  try {
    var origPageFetch = window.fetch;
    if (typeof origPageFetch === 'function') {
      window.fetch = function (input, init) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        var p = origPageFetch.apply(this, arguments);
        if (!url) return p;
        try {
          if (VOD_SESSION_RE.test(url)) return pageVod ? handleVodSession(p) : p;
        } catch (e) { return p; }
        if (!PLAYBACK_PAGE_RE.test(url)) return p;
        var lSlug = '';
        try { lSlug = (pageEnabled && !isVodUrlPage()) ? liveSlug() : ''; } catch (e) { lSlug = ''; }
        if (!pageVod && !lSlug) return p;
        // v2.5.69: reklam izleyicinin adres yenilemesi için Kick'in isteğini sakla
        if (lSlug && typeof input === 'string') {
          try { lastPlaybackReq = { url: url, init: init ? { method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined, credentials: init.credentials } : undefined }; } catch (e) {}
        }
        // v2.5.0: PureKick v10.15'in aynı sorununa karşı ekledikleri savunmadan
        // esinlenildi. Ham istek (p) ağ hatasıyla reddederse, bizim eklediğimiz
        // .then() zinciri bu reddi hiç yakalamadan çağırana (Kick'in kendi
        // kodu) iletiyordu — Chrome bu durumda "Uncaught (in promise)" hatasını
        // BİZİM yığın izimizle raporlayabiliyor, gerçek sebep bizim kodumuz
        // olmasa bile. Sondaki .catch(rethrow) NİHAİ sonucu DEĞİŞTİRMİYOR
        // (aynı hata çağırana yine gidiyor) — sadece ara adımları "tüketilmiş"
        // işaretleyip yanlış atıf riskini azaltıyor.
        return p.then(function (resp) {
          try {
            return resp.clone().json().then(function (j) {
              var vs = j && j.video_session, pu = j && j.playback_url;
              var isVod = vs && String(vs.video_stream_status || '').toLowerCase() === 'vod';
              // v2.5.68: canlı kanal sayfasında canlı yanıt → sayfa seviyesi değişim
              if (!isVod && lSlug) return handleLivePlayback(j, resp, lSlug);
              if (!pageVod) return resp; // sadece canlı açık, bu yanıt VOD: eski davranış (dokunma)
              var touched = neutralizeAds(j);

              // v2.5.3: Mo'Kick'in kenar durumu — VOD sayfasındayız ama akış
              // hâlâ CANLI (henüz VOD'a dönüşmemiş). Reklamsız kaynak aramanın
              // bir anlamı yok, sadece izleme oturumunu temizleyip dokunmadan geç.
              if (!isVod && pu && isVodUrlPage() && pu.vod_session) {
                pu.vod_session = '';
                kaClog('ADB-04', 'VOD sayfasinda ama akis hala canli, sadece oturum temizlendi');
                return jsonResponse(j, resp);
              }

              if (isVod && pu && typeof pu.vod === 'string') vodUrlBildir(pu.vod);
              if (!isVod || !pu || typeof pu.vod !== 'string' || !STITCHED_RE.test(pu.vod)) {
                return touched ? jsonResponse(j, resp) : resp;
              }

              // v2.5.3: Önce HIZLI yolu dene (thumbnail'den türetme, ağ isteği yok).
              // Tutmazsa asıl katalog aramasına (cleanVodSource) düş.
              var derivedFast = deriveSourceFromThumbnail(pu);
              var sourcePromise = derivedFast
                ? Promise.resolve(derivedFast)
                : cleanVodSource(vs, (slugFromPayload(j) || slugNow()), origPageFetch);
              if (derivedFast) { kaClog('ADB-04', 'VOD kaynagi thumbnail\'den turetildi (hizli yol): ' + derivedFast); }

              return sourcePromise
                .then(function (result) {
                  return new Promise(function (resolve) {
                    var settled = false;
                    var timer = setTimeout(function () {
                      if (settled) return;
                      settled = true;
                      kaClog('ADB-04', 'VOD temiz kaynak arama zaman asimina ugradi (2.5sn), orijinal kullanildi');
                      resolve(null);
                    }, 2500); // v2.5.2: Mo'Kick'in swapBudgetMs'inden esinlenildi — arama asla akışı süresiz bekletmesin
                    Promise.resolve(result).then(function (v) {
                      if (settled) return;
                      settled = true;
                      clearTimeout(timer);
                      resolve(v);
                    });
                  });
                })
                .then(function (clean) {
                if (!clean) { kaClog('ADB-04', 'VOD temiz kaynak bulunamadi, dokunulmadi'); return touched ? jsonResponse(j, resp) : resp; }
                pu.vod = clean;
                vodUrlBildir(clean);
                pu.vod_session = '';
                try { window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1; } catch (e) {}
                try { window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*'); } catch (e) {}
                kaClog('ADB-04', 'VOD reklami atlandi (temiz kaynak kullanildi)');
                try { window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-04', text: 'Geçmiş yayın (VOD) reklamı atlandı, temiz kaynak kullanıldı' }, '*'); } catch (e) {}
                return jsonResponse(j, resp);
              }).catch(function () { return resp; });
            }).catch(function () { return resp; });
          } catch (e) { return resp; }
        }).catch(function (e) { throw e; }); // v2.5.0: bkz. yukarıdaki yorum - nihai sonucu değiştirmiyor
      };
    }
  } catch (e) {}

  var OrigWorker = window.Worker;
  if (typeof OrigWorker !== 'function') return;

  function kaAbWorkerShim() {
    if (self.__ka_ab_shim) return;
    self.__ka_ab_shim = true;

    var KA_AB_BASE = "__KA_AB_BASE__";
    var KA_AB_SLUG = "__KA_AB_SLUG__";
    var KA_AB_NONCE = "__KA_AB_NONCE__";
    var PLAYBACK_RE = /\/api\/v\d+\/stream\/[0-9a-f-]+\/playback/i;
    var VOD_MASTER_RE = /\/api\/v\d+\/stream\/manifest\.m3u8|stream\.kick\.com\//i;
    var enabled = true;

    var bc = null;
    try {
      bc = new BroadcastChannel('kickalert-ab');
      bc.onmessage = function (e) {
        var d = e && e.data;
        if (!d) return;
        if (KA_AB_NONCE && d._n !== KA_AB_NONCE) return;
        if (d.kaAbSettings) enabled = (d.kaAbSettings.enabled !== false) && (d.kaAbSettings.blockVideoAds !== false);
        if (d.kaAbSlug && d.kaAbSlug !== KA_AB_SLUG) { KA_AB_SLUG = d.kaAbSlug; adFree.url = null; adFree.ts = 0; adFree.slug = ''; masterCache.text = null; masterCache.slug = ''; prefetchMaster(); }
      };
    } catch (e) {}

    function post(m) { try { if (bc) { m._n = KA_AB_NONCE; bc.postMessage(m); } } catch (e) {} }
    function log() {
      var args = [].slice.call(arguments);
      try { console.log('%c KickAlert \u00b7 ADB-06 (worker) %c ' + args.join(' '), 'background:#5e35b1;color:#fff;border-radius:3px;padding:1px 2px', 'color:inherit'); } catch (e) {}
      // v2.3.20: Worker'ın kendi metin logları da sayfa katmanına (ve oradan
      // background.js'e) iletilsin — 3 önceki event'in (ADB-01/02/03) yanı sıra,
      // "master prefetch önbellekten", "worker kancası kuruldu" gibi metin
      // logları da artık tek konsolda görünür.
      try { post({ kaAbLog: args.join(' ') }); } catch (e) {}
    }

    var origFetch = self.fetch;

    function fixWasm(url) {
      try {
        if (!/\.wasm(\?|#|$)/i.test(url)) return null;
        var h = url.split('#')[0], q = '', qi = h.indexOf('?');
        if (qi >= 0) { q = h.slice(qi); h = h.slice(0, qi); }
        var name = h.split('/').pop();
        return name ? (KA_AB_BASE + name + q) : null;
      } catch (e) { return null; }
    }

    function rebuildHeaders(resp) {
      try {
        var hh = new Headers();
        resp.headers.forEach(function (v, k) { if (k.toLowerCase() !== 'content-length') hh.append(k, v); });
        return hh;
      } catch (e) { return undefined; }
    }

    var adFree = { url: null, ts: 0, slug: '' };
    function getAdFreeMaster() {
      var now = Date.now();
      if (adFree.url && adFree.slug === KA_AB_SLUG && (now - adFree.ts) < 60000) return Promise.resolve(adFree.url);
      if (!KA_AB_SLUG) return Promise.resolve(null);
      var forSlug = KA_AB_SLUG;
      return origFetch.call(self, 'https://kick.com/api/v2/channels/' + forSlug, { credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j && j.playback_url) { adFree.url = j.playback_url; adFree.ts = now; adFree.slug = forSlug; return j.playback_url; }
          return null;
        }).catch(function () { return null; });
    }

    var masterCache = { text: null, slug: '', ts: 0, ct: '' };
    function prefetchMaster() {
      var forSlug = KA_AB_SLUG;
      if (!forSlug || !enabled) return;
      if (masterCache.text && masterCache.slug === forSlug && (Date.now() - masterCache.ts) < 30000) return;
      getAdFreeMaster().then(function (af) {
        if (!af || KA_AB_SLUG !== forSlug) return;
        return origFetch.call(self, af).then(function (afr) {
          return afr.text().then(function (aftxt) {
            if (aftxt.indexOf('#EXT-X-STREAM-INF') === -1 || KA_AB_SLUG !== forSlug) return;
            masterCache = { text: absolutize(aftxt, af), slug: forSlug, ts: Date.now(), ct: (afr.headers.get('content-type') || 'application/vnd.apple.mpegurl') };
          });
        });
      }).catch(function () {});
    }

    function absolutize(text, baseUrl) {
      try {
        var base = new URL(baseUrl);
        var lines = text.split('\n');
        for (var i = 0; i < lines.length; i++) {
          var l = lines[i];
          if (!l) continue;
          if (l.charAt(0) === '#') {
            lines[i] = l.replace(/URI="([^"]+)"/g, function (m, u) { try { return 'URI="' + new URL(u, base).href + '"'; } catch (e) { return m; } });
          } else {
            try { lines[i] = new URL(l, base).href; } catch (e) {}
          }
        }
        return lines.join('\n');
      } catch (e) { return text; }
    }

    // v2.5.68: IVS playback token'ı (JWT) aws:ads-opt-out=true taşıyor mu?
    function isOptOutUrl(u) {
      try {
        var m = /[?&]token=([^&#]+)/.exec(String(u));
        if (!m) return false;
        var part = decodeURIComponent(m[1]).split('.')[1];
        if (!part) return false;
        part = part.replace(/-/g, '+').replace(/_/g, '/');
        while (part.length % 4) part += '=';
        var payload = JSON.parse(atob(part));
        return !!payload && payload['aws:ads-opt-out'] === true;
      } catch (e) { return false; }
    }

    function neutralizePlayback(json) {
      if (!json || typeof json !== 'object') return false;
      var changed = false, vp = json.video_player;
      if (vp) ['google_ads_sdk', 'pal_sdk'].forEach(function (k) {
        var s = vp[k]; if (s) { if (s.initiate_sdk) { s.initiate_sdk = false; changed = true; } if (s.sdk_available) { s.sdk_available = false; changed = true; } }
      });
      var vs = json.video_session;
      if (vs && vs.auto_ads_enabled) { vs.auto_ads_enabled = false; changed = true; }
      return changed;
    }

    // v2.5.0: JWT-tabanlı slug ÇAPRAZ KONTROLÜ (Mo'Kick'in slug senkron
    // düzeltmesinden esinlenildi). DAVRANIŞI DEĞİŞTİRMİYOR — hangi slug'ın
    // kullanılacağına hâlâ KA_AB_SLUG karar veriyor. Bu sadece bir KANARYA:
    // manifest URL'sindeki imzalı token'ın içine gömülü olabilecek yol
    // bilgisini çözüp KA_AB_SLUG ile karşılaştırıyor, uyuşmazlık olursa
    // logluyor. Kick'in token yapısını %100 doğrulayamadığımız için önce
    // gerçek dünyada bu uyumsuzluk hiç oluyor mu diye VERİ topluyoruz —
    // veri olmadan mevcut (zaten senkron/anlık çalışan) mekanizmayı
    // riske atmıyoruz.
    function slugFromManifestUrl(u) {
      try {
        var m = /[?&]token=([^&]+)/.exec(u);
        if (!m) return null;
        var parts = decodeURIComponent(m[1]).split('.');
        if (parts.length < 2) return null;
        var payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        while (payload.length % 4) payload += '=';
        var json = JSON.parse(atob(payload));
        var path = json && json['aws:ads-player-params'] && json['aws:ads-player-params'].urlPath;
        if (typeof path !== 'string') return null;
        var seg = path.split('/').filter(Boolean)[0];
        return seg || null;
      } catch (e) { return null; }
    }

    if (origFetch) {
      self.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var fw = fixWasm(url);
        if (fw) return origFetch.call(self, fw, init);

        if (/\.m3u8/i.test(url)) {
          try {
            var urlSlug = slugFromManifestUrl(url);
            if (urlSlug && KA_AB_SLUG && urlSlug !== KA_AB_SLUG) {
              log('KANARYA: manifest URL slug (' + urlSlug + ') != KA_AB_SLUG (' + KA_AB_SLUG + ') - inceleme gerekebilir');
            }
          } catch (e) {}
        }

        var p = origFetch.apply(self, arguments);
        if (!enabled) return p;

        // v2.4.11: Segment-cerrahi (3. teknik) — master swap'tan BAĞIMSIZ çalışır.
    // Medya playlist'inde (segment listesi) doğrudan gömülü SCTE-35 reklam
    // işaretçilerini (#EXT-X-CUE-OUT/-IN, DATERANGE'da stitched-ad-break)
    // tanıyıp SADECE o segmentleri çıkarır — ayrı bir "temiz kaynak" aramaya
    // gerek yok. Master swap zaten başarılıysa burası muhtemelen hiç
    // tetiklenmez (temiz kaynakta zaten bu işaretçiler yoktur) — bu, ek bir
    // GÜVENLİK AĞI, ana yöntemin yerini almıyor.
    //
    // BİLİNÇLİ TEMKİNLİLİK: Diğer eklentilerde gördüğümüz daha agresif
    // sezgisel yöntemleri (segment başlığı UUID'ye benziyorsa reklam say vb.)
    // kasıtlı olarak KULLANMIYORUZ — yanlış pozitif riski (gerçek içeriği
    // reklam sanıp atlamak), reklamı kaçırmaktan daha kötü bir kullanıcı
     // deneyimi. Sadece açık, belirsizlik taşımayan CUE-OUT/CUE-IN ve
    // DATERANGE class="...stitched-ad..." işaretçilerine güveniyoruz.
    function stripAdSegments(txt) {
      if (typeof txt !== 'string' || txt.length < 16) return null;
      if (txt.indexOf('#EXTM3U') === -1) return null;
      if (txt.indexOf('#EXT-X-STREAM-INF') !== -1) return null; // bu bir master, medya değil
      if (txt.indexOf('#EXTINF') === -1) return null;
      if (txt.indexOf('#EXT-X-CUE-OUT') === -1 && txt.indexOf('stitched-ad') === -1) return null; // hiç işaretçi yok, dokunma

      var lines = txt.split('\n');
      var outLines = [];
      var inAdBreak = false;
      var removedCount = 0;
      var totalSegments = 0;
      // v2.5.4: KRİTİK GÜVENLİK DÜZELTMESİ. Bir CUE-OUT'un karşılığı olan
      // CUE-IN bu manifest içinde HİÇ gelmezse (örn. yayıncı tam bir reklam
      // arası SIRASINDA yayını kapatırsa), eski kod listenin SONUNA kadar her
      // şeyi reklam sayıp siliyordu — bu da oynatıcının "akış bitti" sinyalini
      // hiç görmemesine, sonsuza kadar reklam bekliyormuş gibi DONMASINA yol
      // açabiliyordu (kullanıcı raporu: yayın kapanınca "offline" yerine
      // reklam ekranında donuk kalıyor). Artık kapanmamış bir arayı, kapanana
      // KADAR geçici bir tampona alıyoruz; liste kapanmadan biterse o
      // segmentleri SİLMİYORUZ, olduğu gibi geri koyuyoruz — bir sonraki
      // manifest yenilemesinde (eğer reklam gerçekten devam ediyorsa) zaten
      // yakalanacak. Riski dengelenmiş: en kötü ihtimalle birkaç saniyelik
      // reklam görünür, ama oynatıcı asla donmaz.
      var pendingAdLines = [];
      var pendingAdCount = 0;

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();

        if (/^#EXT-X-CUE-OUT/i.test(trimmed)) { inAdBreak = true; pendingAdLines.push(line); continue; }
        if (/^#EXT-X-CUE-IN/i.test(trimmed)) {
          inAdBreak = false;
          removedCount += pendingAdCount; // ara düzgün kapandı - şimdi kalıcı olarak sil
          pendingAdLines = []; pendingAdCount = 0;
          outLines.push(line);
          continue;
        }
        if (/^#EXT-X-DATERANGE/i.test(trimmed)) {
          if (/CLASS="[^"]*stitched-ad-break-start[^"]*"/i.test(trimmed)) { inAdBreak = true; pendingAdLines.push(line); continue; }
          else if (/CLASS="[^"]*stitched-ad-break-end[^"]*"/i.test(trimmed)) {
            inAdBreak = false;
            removedCount += pendingAdCount;
            pendingAdLines = []; pendingAdCount = 0;
          }
          if (!inAdBreak) outLines.push(line);
          continue;
        }

        if (trimmed.charAt(0) === '#' || trimmed === '') {
          if (inAdBreak) pendingAdLines.push(line); else outLines.push(line);
          continue;
        }

        // Bu bir segment URI'si (# ile başlamayan, boş olmayan satır)
        if (inAdBreak) { totalSegments++; pendingAdCount++; pendingAdLines.push(line); continue; }
        totalSegments++;
        outLines.push(line);
      }

      // Liste, ara HÂLÂ AÇIKKEN bitti — kapanmamış kısmı silmeden geri koy.
      if (inAdBreak && pendingAdLines.length) {
        pendingAdLines.forEach(function (l) { outLines.push(l); });
      }

      // GÜVENLİK KONTROLÜ: hiç segment çıkarılmadıysa ya da TÜM segmentler
      // çıkarılmış gibi görünüyorsa (parse hatası ihtimali), dokunma —
      // orijinali kullan. Yarım/bozuk bir playlist döndürmek, reklam
      // göstermekten çok daha kötü (akış tamamen durabilir).
      if (removedCount === 0) return null;
      if (removedCount >= totalSegments) return null;

      return outLines.join('\n');
    }

    // v2.5.3: Mo'Kick v3.2.8'den esinlenildi — İKİNCİL, DAR KAPSAMLI bir yedek.
    // stripAdSegments (yukarıda) açık SCTE-35 işaretçilerine bakıyor; bu bulunamazsa,
    // segment URI'sinin HOST'una bakıp kick.com'a ait olmayanları (yabancı/reklam
    // sunucusu) çıkarıyoruz. BİLİNÇLİ TEMKİNLİLİK: Bu kontrolü SADECE Mo'Kick'in
    // belirlediği VOD-özel URL deseninde (VOD_STITCH_RE) çalıştırıyoruz — canlı
    // yayının genel .m3u8'lerinde DEĞİL. Sebep: Kick'in kendi CDN'i her zaman
    // *.kick.com olmayabilir; bunu genel olarak uygularsak meşru segmentleri
    // yanlışlıkla "yabancı" sayıp akışı bozma riski taşırdık. Dar kapsam, bu
    // riski en aza indiriyor.
    var VOD_STITCH_RE = /production-kick-vod|\/api\/v1\/stream\/manifest\.m3u8/i;
    var KICK_HOST_RE = /(^|\.)kick\.com$/i;
    function isKickSegmentUri(uri, baseUrl) {
      try { return KICK_HOST_RE.test(new URL(uri, baseUrl).hostname); } catch (e) { return false; }
    }
    function stripForeignHostSegments(txt, baseUrl) {
      if (typeof txt !== 'string' || txt.indexOf('#EXTINF') === -1) return null;
      var lines = txt.split('\n');
      var outLines = [];
      var pending = [];
      var removed = 0, kept = 0;

      function flushPending() {
        // kept===0 ise (henüz hiç meşru segment eklenmediyse) sarkan
        // #EXT-X-DISCONTINUITY etiketlerini de at — anlamsız kalırlardı
        var flushable = kept ? pending : pending.filter(function (p) { return p.trim() !== '#EXT-X-DISCONTINUITY'; });
        flushable.forEach(function (p) { outLines.push(p); });
        pending = [];
      }

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i], trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.charAt(0) === '#') {
          if (trimmed.indexOf('#EXTINF') === 0 || trimmed.indexOf('#EXT-X-BYTERANGE') === 0 ||
              trimmed.indexOf('#EXT-X-PROGRAM-DATE-TIME') === 0 || trimmed === '#EXT-X-DISCONTINUITY') {
            pending.push(line);
            continue;
          }
          flushPending();
          outLines.push(line);
          continue;
        }
        if (isKickSegmentUri(trimmed, baseUrl)) {
          flushPending();
          outLines.push(line);
          kept++;
          continue;
        }
        pending = []; // yabancı segment - hem kendisi hem üzerindeki #EXTINF vs. atılır
        removed++;
      }
      flushPending();

      if (!removed || !kept) return null; // ya hiç yabancı yok ya da HEPSİ yabancı (şüpheli) - dokunma
      return outLines.join('\n');
    }

    // v2.5.51: Kick Ad Blocker (AI Chat) v1.1.1'den uyarlandı — üçüncü yedek.
    // Amazon IVS medya listesinde her segmentin kaynağını etiketliyor:
    // gerçek yayın "#EXTINF:<süre>,live", reklam segmentleri farklı bir kaynak
    // adıyla; ayrıca "X-NET-LIVE-VIDEO-STREAM-SOURCE" DATERANGE özniteliği.
    // CUE-OUT işareti OLMAYAN reklam aralarını da yakalar.
    // GÜVENLİK: sadece listede en az bir segment açıkça "live" etiketliyse
    // (etiket düzeni kullanılıyor demek) ve en az bir "live" segment kalıyorsa
    // uygulanır; etiketsiz (boş başlıklı) segmentler içerik sayılır.
    var STREAM_SOURCE_RE = /X-NET-LIVE-VIDEO-STREAM-SOURCE="?([^",]+)/i;
    function extinfSource(line) {
      var ci = line.indexOf(',');
      return (ci >= 0 ? line.slice(ci + 1) : '').trim().toLowerCase();
    }
    function stripNonLiveSegments(txt) {
      if (typeof txt !== 'string' || txt.indexOf('#EXTINF') === -1) return null;
      if (txt.indexOf('#EXT-X-STREAM-INF') !== -1) return null; // master, medya değil
      var lines = txt.split('\n');
      var liveTagged = 0, adSegs = 0, liveSegs = 0, inAd = false, i, l, m, src;
      for (i = 0; i < lines.length; i++) {
        l = lines[i];
        m = l.match(STREAM_SOURCE_RE);
        if (m) { inAd = m[1].trim().toLowerCase() !== 'live'; continue; }
        if (l.indexOf('#EXTINF:') === 0) {
          src = extinfSource(l);
          if (src === 'live') liveTagged++;
          if (inAd || (src && src !== 'live')) adSegs++; else liveSegs++;
        }
      }
      if (!adSegs || !liveTagged || !liveSegs) return null;
      var out = [], cur = false;
      for (i = 0; i < lines.length; i++) {
        l = lines[i];
        m = l.match(STREAM_SOURCE_RE);
        if (m) { cur = m[1].trim().toLowerCase() !== 'live'; if (!cur) out.push(l); continue; }
        if (l.indexOf('#EXT-X-MAP') === 0) { if (!cur) out.push(l); continue; } // reklamın init segmenti
        if (l.indexOf('#EXTINF:') === 0) {
          src = extinfSource(l);
          if (cur || (src && src !== 'live')) {
            // #EXTINF ile URI arasındaki etiketleri de atla, URI satırını atla
            while (i + 1 < lines.length && lines[i + 1].charAt(0) === '#') i++;
            i++;
            continue;
          }
          out.push(l);
          continue;
        }
        out.push(l);
      }
      return out.join('\n');
    }

    if (/\.m3u8/i.test(url)) {
          return p.then(function (resp) {
            return resp.clone().text().then(function (txt) {
              if (txt.indexOf('#EXT-X-STREAM-INF') !== -1) {
                if (VOD_MASTER_RE.test(url)) return resp;
                // v2.5.68: sayfa seviyesi değişim tuttuysa oynatıcı zaten
                // reklamsız (ads-opt-out) adresi istiyor; tekrar değiştirip
                // sayacı iki kez artırmaya gerek yok.
                if (isOptOutUrl(url)) { log('master zaten reklamsiz adresten (sayfa seviyesi), dokunulmadi'); return resp; }
                if (masterCache.text && masterCache.slug === KA_AB_SLUG && (Date.now() - masterCache.ts) < 30000) {
                  post({ kaAbSwapped: 1 });
                  log('master prefetch onbellekten (aninda)');
                  return new Response(masterCache.text, { status: 200, statusText: 'OK', headers: new Headers({ 'content-type': masterCache.ct || 'application/vnd.apple.mpegurl' }) });
                }
                return getAdFreeMaster().then(function (af) {
                  if (!af) return resp;
                  return origFetch.call(self, af).then(function (afr) {
                    return afr.text().then(function (aftxt) {
                      if (aftxt.indexOf('#EXT-X-STREAM-INF') === -1) return resp;
                      post({ kaAbSwapped: 1 });
                      log('master reklamsiz akisla degistirildi');
                      var absTxt = absolutize(aftxt, af);
                      masterCache = { text: absTxt, slug: KA_AB_SLUG, ts: Date.now(), ct: (afr.headers.get('content-type') || 'application/vnd.apple.mpegurl') };
                      return new Response(absTxt, { status: 200, statusText: 'OK', headers: rebuildHeaders(afr) });
                    });
                  }).catch(function () { return resp; });
                }).catch(function () { return resp; });
              }
              if (txt.indexOf('#EXT-X-CUE-OUT') !== -1 || txt.indexOf('stitched-ad') !== -1) {
                post({ kaAbAdLeak: 1 });
                try {
                  var stripped = stripAdSegments(txt);
                  if (stripped) {
                    log('medya playlistinden reklam segmenti cikarildi (segment-cerrahi)');
                    post({ kaAbSwapped: 1 }); // sayfa tarafı bunu 'adDetected' olarak yayınlayacak (mevcut bc.onmessage)
                    return new Response(stripped, { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
                  }
                } catch (e) { /* parse hatasi - orijinal akisa dokunulmadan devam */ }
              }
              // v2.5.51: CUE-OUT yok ya da segment-cerrahi bir şey çıkaramadıysa IVS kaynak etiketine bak
              try {
                var strippedSrc = stripNonLiveSegments(txt);
                if (strippedSrc) {
                  post({ kaAbAdLeak: 1 });
                  log('medya playlistinden "live" disi kaynak segmentleri cikarildi (IVS kaynak etiketi)');
                  post({ kaAbSwapped: 1 });
                  return new Response(strippedSrc, { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
                }
              } catch (e) { /* parse hatasi - orijinal akisa dokunulmadan devam */ }
              if (!(txt.indexOf('#EXT-X-CUE-OUT') !== -1 || txt.indexOf('stitched-ad') !== -1) && VOD_STITCH_RE.test(url)) {
                // v2.5.3: Açık CUE-OUT işaretçisi yoktu ama bu VOD-özel bir istek —
                // host-bazlı yedek tekniği dene.
                try {
                  var strippedHost = stripForeignHostSegments(txt, resp.url || url);
                  if (strippedHost) {
                    log('VOD playlistinden yabanci-host segmenti cikarildi (host-bazli yedek)');
                    post({ kaAbSwapped: 1 });
                    return new Response(strippedHost, { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
                  }
                } catch (e) { /* parse hatasi - orijinal akisa dokunulmadan devam */ }
              }
              return resp;
            }).catch(function () { return resp; });
          }).catch(function (e) { throw e; }); // v2.5.0: ham istek reddi varsa - bkz. sayfa bağlamındaki aynı yorum
        }

        if (PLAYBACK_RE.test(url)) {
          return p.then(function (resp) {
            return resp.clone().json().then(function (j) {
              if (!neutralizePlayback(j)) return resp;
              return new Response(JSON.stringify(j), { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
            }).catch(function () { return resp; });
          }).catch(function (e) { throw e; }); // v2.5.0: aynı savunma
        }
        return p;
      };
    }

    try {
      var origOpen = XMLHttpRequest.prototype.open;
      var origSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          var fw2 = fixWasm(String(url));
          if (fw2) { url = fw2; arguments[1] = fw2; }
        } catch (e) {}
        // v2.4.11: /playback isteğinin bu XHR üzerinden gittiğini işaretle —
        // send() içinde JSON temizliği yapabilmek için url'i saklıyoruz.
        try { this.__kaAbUrl = String(url); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      // v2.4.11: IVS worker'ı /playback için normalde fetch() kullanıyor, ama
      // XHR üzerinden gelme ihtimaline karşı (Kick tarafında değişebilir)
      // aynı neutralizePlayback() temizliğini burada da uyguluyoruz. .m3u8
      // değişimi (asenkron, "temiz kaynak" arama gerektiriyor) burada
      // uygulanmıyor — sadece senkron JSON temizliği, düşük risk.
      XMLHttpRequest.prototype.send = function () {
        var xhr = this;
        if (enabled && xhr.__kaAbUrl && PLAYBACK_RE.test(xhr.__kaAbUrl)) {
          xhr.addEventListener('readystatechange', function () {
            if (xhr.readyState !== 4) return;
            try {
              var txt = xhr.responseText;
              if (!txt) return;
              var j = JSON.parse(txt);
              if (!neutralizePlayback(j)) return;
              var patched = JSON.stringify(j);
              Object.defineProperty(xhr, 'responseText', { value: patched, configurable: true });
              Object.defineProperty(xhr, 'response', { value: patched, configurable: true });
              log('XHR /playback JSON temizlendi');
            } catch (e) { /* parse/patch hatasi - orijinal yanit dokunulmadan kalir */ }
          });
        }
        return origSend.apply(this, arguments);
      };
    } catch (e) {}

    post({ kaAbHookReady: 1 });
    log('worker kancasi kuruldu (slug=' + KA_AB_SLUG + ')');
    prefetchMaster();
  }

  var SHIM_TEMPLATE = '(' + kaAbWorkerShim.toString() + ')();\n;\n';
  function baseOf(u) {
    try { var abs = new URL(u, window.location.href).href; return abs.slice(0, abs.lastIndexOf('/') + 1); } catch (e) { return window.location.origin + '/'; }
  }
  function currentSlug() {
    try { return (window.location.pathname.split('/').filter(Boolean)[0] || ''); } catch (e) { return ''; }
  }

  function readSync(u) {
    try { var x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); if (x.status === 200 || x.status === 0) return x.responseText || null; } catch (e) {}
    return null;
  }

  function KaAbWorker(scriptURL, options) {
    try {
      var url = String(scriptURL);
      var videoOn = false;
      try { videoOn = localStorage.getItem('__ka_ab_video') === '1'; } catch (e) {}
      var isModule = options && options.type === 'module';
      if (videoOn && !isModule && /amazon-ivs|\/ivs\//i.test(url)) {
        // v2.5.7: v2.5.3'te importScripts() yaklaşımına geçmiştik (senkron
        // indirmeyi ortadan kaldırmak için) — ama bu, worker'ın script URL'sinin
        // sarmalama anında HÂLÂ geçerli/erişilebilir olduğunu varsayıyordu.
        // Yayın bitip yeni bir worker denemesi olduğunda bu URL geçersiz kalırsa,
        // importScripts() worker'ı SESSİZCE ÇÖKERTİYOR — Kick'in sayfası o
        // worker'dan beklediği mesajları hiç alamayıp donuk kalabiliyor
        // (kullanıcı raporu: yayın bitince "Ad" ekranında/boş ekranda dakikalarca
        // takılı kalma). Eski, daha sağlam yönteme (script'i senkron indirip
        // shim'in içine GÖMME) geri dönüyoruz — indirme başarısız olursa
        // sarmalamayı hiç denemeyip orijinal worker'a düşüyoruz.
        var src = readSync(url);
        if (src) {
          var base = baseOf(url);
          var shim = SHIM_TEMPLATE
            .replace('"__KA_AB_BASE__"', JSON.stringify(base))
            .replace('"__KA_AB_SLUG__"', JSON.stringify(currentSlug()))
            .replace('"__KA_AB_NONCE__"', JSON.stringify(pageNonce || ''));
          var blob = new Blob([shim + src], { type: 'text/javascript' });
          window.__ka_ab_wrapCount = (window.__ka_ab_wrapCount || 0) + 1;
          kaClog('ADB-05', 'IVS worker sarmalandi, slug=' + currentSlug());
          try { window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-05', text: 'IVS oynatıcı worker\'ı sarmalandı (slug=' + currentSlug() + ')' }, '*'); } catch (e) {}
          return new OrigWorker(URL.createObjectURL(blob), options);
        }
        kaClog('ADB-05', 'worker script indirilemedi, sarmalanmadan gecildi');
      }
    } catch (e) {
      kaClog('ADB-05', 'wrap hatasi, passthrough: ' + String(e).slice(0, 100));
    }
    return new OrigWorker(scriptURL, options);
  }
  try { KaAbWorker.prototype = OrigWorker.prototype; } catch (e) {}
  try { Object.setPrototypeOf(KaAbWorker, OrigWorker); } catch (e) {}
  try { Object.defineProperty(window, 'Worker', { value: KaAbWorker, writable: true, configurable: true }); }
  catch (e) { try { window.Worker = KaAbWorker; } catch (e2) {} }

  try {
    var bc = new BroadcastChannel('kickalert-ab');
    bc.onmessage = function (e) {
      var d = e && e.data;
      if (d && d.kaAbHookReady) {
        window.__ka_ab_shimReady = true;
        window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-01', text: 'IVS worker kancası hazır (slug=' + slugNow() + ')' }, '*');
      }
      if (d && d.kaAbSwapped && (!pageNonce || d._n === pageNonce)) {
        window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1;
        window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*');
        window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-02', text: 'Canlı yayın master\'ı reklamsız akışla değiştirildi (toplam: ' + window.__ka_ab_adsBlocked + ')' }, '*');
      }
      if (d && d.kaAbAdLeak) {
        window.__ka_ab_adLeak = (window.__ka_ab_adLeak || 0) + 1;
        window.postMessage({ source: 'ka-ab-log', level: 'warn', code: 'ADB-03', text: 'Reklam markörü sızıntısı tespit edildi (temiz akışta beklenmiyordu, toplam: ' + window.__ka_ab_adLeak + ')' }, '*');
      }
      if (d && typeof d.kaAbLog === 'string') {
        window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-06', text: d.kaAbLog }, '*');
      }
    };
    window.addEventListener('message', function (e) {
      if (e.source !== window) return;
      var d = e.data;
      if (d && d.source === 'ka-ab-cfg' && d.settings && d.n) {
        if (!pageNonce) pageNonce = d.n;
        else if (d.n !== pageNonce) return;
        pageEnabled = (d.settings.enabled !== false) && (d.settings.blockVideoAds !== false);
        pageVod     = (d.settings.enabled !== false) && (d.settings.blockVodAds   !== false);
        try { bc.postMessage({ kaAbSettings: d.settings, _n: pageNonce }); } catch (er) {}
      }
    });
    var lastSlug = '';
    function pushSlug() {
      try { var s = (window.location.pathname.split('/').filter(Boolean)[0] || ''); if (s && s !== lastSlug) { lastSlug = s; bc.postMessage({ kaAbSlug: s, _n: pageNonce }); primeLiveAdFree(); } } catch (er) {}
    }
    pushSlug();
    setInterval(pushSlug, 2000);
    try {
      ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        if (typeof orig === 'function') { history[m] = function () { var r = orig.apply(this, arguments); try { pushSlug(); } catch (e) {} return r; }; }
      });
      window.addEventListener('popstate', pushSlug);
    } catch (e) {}
  } catch (e) {}
})();
