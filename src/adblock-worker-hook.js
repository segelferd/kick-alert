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

      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var trimmed = line.trim();

        if (/^#EXT-X-CUE-OUT/i.test(trimmed)) { inAdBreak = true; outLines.push(line); continue; }
        if (/^#EXT-X-CUE-IN/i.test(trimmed)) { inAdBreak = false; outLines.push(line); continue; }
        if (/^#EXT-X-DATERANGE/i.test(trimmed)) {
          if (/CLASS="[^"]*stitched-ad-break-start[^"]*"/i.test(trimmed)) inAdBreak = true;
          else if (/CLASS="[^"]*stitched-ad-break-end[^"]*"/i.test(trimmed)) inAdBreak = false;
          if (!inAdBreak) outLines.push(line);
          continue;
        }

        if (trimmed.charAt(0) === '#' || trimmed === '') {
          if (!inAdBreak) outLines.push(line);
          continue;
        }

        // Bu bir segment URI'si (# ile başlamayan, boş olmayan satır)
        totalSegments++;
        if (inAdBreak) { removedCount++; continue; } // reklam segmenti - atla (kendisi + üstündeki #EXTINF zaten yukarıda eklendi/eklenmedi)
        outLines.push(line);
      }

      // GÜVENLİK KONTROLÜ: hiç segment çıkarılmadıysa ya da TÜM segmentler
      // çıkarılmış gibi görünüyorsa (parse hatası ihtimali), dokunma —
      // orijinali kullan. Yarım/bozuk bir playlist döndürmek, reklam
      // göstermekten çok daha kötü (akış tamamen durabilir).
      if (removedCount === 0) return null;
      if (removedCount >= totalSegments) return null;

      return outLines.join('\n');
    }

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
                try {
                  var stripped = stripAdSegments(txt);
                  if (stripped) {
                    log('medya playlistinden reklam segmenti cikarildi (segment-cerrahi)');
                    post({ kaAbSwapped: 1 }); // sayfa tarafı bunu 'adDetected' olarak yayınlayacak (mevcut bc.onmessage)
                    return new Response(stripped, { status: resp.status, statusText: resp.statusText, headers: rebuildHeaders(resp) });
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
