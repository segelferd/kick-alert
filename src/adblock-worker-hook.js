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

  var pageNonce = null;
  var pageEnabled = true; // canlı yayın reklamı ayarı
  try { pageEnabled = localStorage.getItem('__ka_ab_video') === '1'; } catch (e) {}
  var pageVod = true; // geçmiş yayın (VOD) ayrı bayrak
  try { pageVod = localStorage.getItem('__ka_ab_vod') !== '0'; } catch (e) {}

  function vodUrlBildir(u) {
    if (!u) return;
    try { window.__ka_ab_vodUrl = u; } catch (e) {}
    try { window.postMessage({ source: 'ka-ab', type: 'vodUrl', url: u, n: pageNonce }, '*'); } catch (e) {}
  }

  var PLAYBACK_PAGE_RE = /\/api\/v\d+\/stream\/[0-9a-f-]+\/playback(\?|$)/i;
  var STITCHED_RE      = /\/api\/v\d+\/stream\/manifest\.m3u8/i;
  var vodList = { slug: '', ts: 0, items: null };

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

  function getVodList(slug, origFetch) {
    if (vodList.items && vodList.slug === slug && (Date.now() - vodList.ts) < 60000) return Promise.resolve(vodList.items);
    if (!slug) return Promise.resolve([]);
    return origFetch.call(window, 'https://kick.com/api/v2/channels/' + slug + '/videos')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var arr = Array.isArray(j) ? j : ((j && j.data) || []);
        vodList = { slug: slug, ts: Date.now(), items: arr };
        return arr;
      });
  }

  function cleanVodSource(vs, slug, origFetch) {
    var want = Number(vs && vs.video_duration);
    if (!want || !slug) return Promise.resolve(null);
    return getVodList(slug, origFetch).then(function (arr) {
      var cands = arr.filter(function (x) {
        var d = Number(x && x.duration);
        return d && Math.abs(Math.round(d / 1000) - want) <= 1;
      });
      if (cands.length > 1 && vs.video_title) {
        var t = cands.filter(function (x) { return String(x.session_title || '') === String(vs.video_title); });
        if (t.length) cands = t;
      }
      var src = cands[0] && cands[0].source;
      return (typeof src === 'string' && /^https:\/\/[^/]+\.kick\.com\/.+\.m3u8/i.test(src)) ? src : null;
    }).catch(function () { return null; });
  }

  try {
    var origPageFetch = window.fetch;
    if (typeof origPageFetch === 'function') {
      window.fetch = function (input, init) {
        var url = '';
        try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (e) {}
        var p = origPageFetch.apply(this, arguments);
        if (!pageVod || !url || !PLAYBACK_PAGE_RE.test(url)) return p;
        return p.then(function (resp) {
          try {
            return resp.clone().json().then(function (j) {
              var vs = j && j.video_session, pu = j && j.playback_url;
              var touched = neutralizeAds(j);
              var isVod = vs && String(vs.video_stream_status || '').toLowerCase() === 'vod';
              if (isVod && pu && typeof pu.vod === 'string') vodUrlBildir(pu.vod);
              if (!isVod || !pu || typeof pu.vod !== 'string' || !STITCHED_RE.test(pu.vod)) {
                return touched ? jsonResponse(j, resp) : resp;
              }
              return cleanVodSource(vs, slugNow(), origPageFetch).then(function (clean) {
                if (!clean) { try { console.log('[KickAlert][AdBlock] VOD temiz kaynak bulunamadi, dokunulmadi'); } catch (e) {} return touched ? jsonResponse(j, resp) : resp; }
                pu.vod = clean;
                vodUrlBildir(clean);
                pu.vod_session = '';
                try { window.__ka_ab_adsBlocked = (window.__ka_ab_adsBlocked || 0) + 1; } catch (e) {}
                try { window.postMessage({ source: 'ka-ab', type: 'adDetected', kind: 'video', n: pageNonce }, '*'); } catch (e) {}
                try { console.log('[KickAlert][AdBlock] VOD reklami atlandi (temiz kaynak kullanildi)'); } catch (e) {}
                try { window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-04', text: 'Geçmiş yayın (VOD) reklamı atlandı, temiz kaynak kullanıldı' }, '*'); } catch (e) {}
                return jsonResponse(j, resp);
              }).catch(function () { return resp; });
            }).catch(function () { return resp; });
          } catch (e) { return resp; }
        });
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
      try { console.log.apply(console, ['[KickAlert][AdBlock]'].concat(args)); } catch (e) {}
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

    if (origFetch) {
      self.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var fw = fixWasm(url);
        if (fw) return origFetch.call(self, fw, init);

        var p = origFetch.apply(self, arguments);
        if (!enabled) return p;

        if (/\.m3u8/i.test(url)) {
          return p.then(function (resp) {
            return resp.clone().text().then(function (txt) {
              if (txt.indexOf('#EXT-X-STREAM-INF') !== -1) {
                if (VOD_MASTER_RE.test(url)) return resp;
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
              }
              return resp;
            }).catch(function () { return resp; });
          });
        }

        if (PLAYBACK_RE.test(url)) {
          return p.then(function (resp) {
            return resp.clone().json().then(function (j) {
              if (!neutralizePlayback(j)) return resp;
              return new Response(JSON.stringify(j), { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
            }).catch(function () { return resp; });
          });
        }
        return p;
      };
    }

    try {
      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        try { var fw2 = fixWasm(String(url)); if (fw2) { url = fw2; arguments[1] = fw2; } } catch (e) {}
        return origOpen.apply(this, arguments);
      };
    } catch (e) {}

    post({ kaAbHookReady: 1 });
    log('worker kancasi kuruldu (slug=' + KA_AB_SLUG + ')');
    prefetchMaster();
  }

  var SHIM_TEMPLATE = '(' + kaAbWorkerShim.toString() + ')();\n;\n';

  function readSync(u) {
    try { var x = new XMLHttpRequest(); x.open('GET', u, false); x.send(); if (x.status === 200 || x.status === 0) return x.responseText || null; } catch (e) {}
    return null;
  }
  function baseOf(u) {
    try { var abs = new URL(u, window.location.href).href; return abs.slice(0, abs.lastIndexOf('/') + 1); } catch (e) { return window.location.origin + '/'; }
  }
  function currentSlug() {
    try { return (window.location.pathname.split('/').filter(Boolean)[0] || ''); } catch (e) { return ''; }
  }

  function KaAbWorker(scriptURL, options) {
    try {
      var url = String(scriptURL);
      var videoOn = false;
      try { videoOn = localStorage.getItem('__ka_ab_video') === '1'; } catch (e) {}
      var isModule = options && options.type === 'module';
      if (videoOn && !isModule && /amazon-ivs|\/ivs\//i.test(url)) {
        var src = readSync(url);
        if (src) {
          var base = baseOf(url);
          var shim = SHIM_TEMPLATE
            .replace('"__KA_AB_BASE__"', JSON.stringify(base))
            .replace('"__KA_AB_SLUG__"', JSON.stringify(currentSlug()))
            .replace('"__KA_AB_NONCE__"', JSON.stringify(pageNonce || ''));
          var blob = new Blob([shim + src], { type: 'text/javascript' });
          window.__ka_ab_wrapCount = (window.__ka_ab_wrapCount || 0) + 1;
          try { console.log('[KickAlert][AdBlock] IVS worker sarmalandi, slug=' + currentSlug()); } catch (e) {}
          try { window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-05', text: 'IVS oynatıcı worker\'ı sarmalandı (slug=' + currentSlug() + ')' }, '*'); } catch (e) {}
          return new OrigWorker(URL.createObjectURL(blob), options);
        }
      }
    } catch (e) {
      try { console.log('[KickAlert][AdBlock] wrap hatasi, passthrough:', String(e).slice(0, 100)); } catch (er) {}
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
      try { var s = (window.location.pathname.split('/').filter(Boolean)[0] || ''); if (s && s !== lastSlug) { lastSlug = s; bc.postMessage({ kaAbSlug: s, _n: pageNonce }); } } catch (er) {}
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
