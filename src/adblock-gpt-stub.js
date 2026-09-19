/**
 * KickAlert - Ad Block: Google GPT / IMA SDK Stub
 * MAIN dünya, document_start. src/adblock-worker-hook.js ile birlikte çalışır
 * ama farklı bir katmanı hedefler:
 *
 *   adblock-worker-hook.js  → akış zaten reklamlıysa, reklamsız kaynakla DEĞİŞTİRİR
 *   adblock-gpt-stub.js     → reklam isteği Google'ın GPT/IMA SDK'sı üzerinden
 *                             geliyorsa, o isteği DAHA BAŞLAMADAN engeller
 *
 * Kick'in reklam kodu genelde window.googletag (Google Publisher Tag) ve
 * window.google.ima (Interactive Media Ads SDK) nesnelerinin yüklenmesini
 * bekler. Bu dosya, sayfanın kendi reklam kütüphaneleri yüklenmeden önce bu
 * nesnelerin yerine hiçbir şey yapmayan (no-op) sahte sürümlerini koyar.
 * Sonuç: reklam isteği hiç oluşmaz, video oynatıcı reklam beklemeden akışa
 * devam eder.
 *
 * v2.3.30'daki reklam engelleme kararı ve etik çerçevesi burada da geçerli:
 * ağa hiçbir istek atmıyoruz, hiçbir veri toplamıyoruz — sadece iki global
 * nesneyi zararsız kopyalarıyla kilitliyoruz.
 *
 * © 2026 Segelferd. All rights reserved.
 */
(function () {
  'use strict';

  if (window.__kaGptStubbed) return;

  // v2.5.14: TEŞHİS LOGU — enabled kontrolünden ÖNCE, koşulsuz çalışır.
  // "Reklam Engelleme'yi açtım, sayfayı yeniledim, hâlâ hiç log yok" sorununu
  // çözmek için: bu script GERÇEKTEN çalışıyor mu, localStorage'da GERÇEKTE
  // ne okunuyor — bunu kesin olarak görmemiz lazım, tahmin etmek yerine.
  try {
    var __diagVal = null;
    try { __diagVal = localStorage.getItem('__ka_ab_video'); } catch (e) { __diagVal = 'OKUMA HATASI: ' + e.message; }
    try { console.log('[KickAlert][AdBlock][TEŞHİS]', 'gpt-stub.js calisti, __ka_ab_video okunan deger=' + JSON.stringify(__diagVal)); } catch (e) {}
    window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-09', text: 'gpt-stub.js calisti, __ka_ab_video okunan deger=' + JSON.stringify(__diagVal) }, '*');
  } catch (e) {}

  // Diğer hook'larla (adblock-worker-hook.js) aynı localStorage bayrağını
  // kullanıyoruz — ayrı bir ayar/anahtar eklemeye gerek yok, ikisi de aynı
  // "Ad Blocking" ayarına bağlı olarak açılıp kapanıyor.
  var enabled = false;
  try { enabled = localStorage.getItem('__ka_ab_video') === '1'; } catch (e) {}
  if (!enabled) return;

  window.__kaGptStubbed = true;

  var noop = function () {};
  var returns = function (v) { return function () { return v; }; };
  var thisRef = function () { return this; };

  function log(text) {
    try { console.log('[KickAlert][AdBlock]', text); } catch (e) {}
    try {
      window.postMessage({ source: 'ka-ab-log', level: 'info', code: 'ADB-07', text: text }, '*');
    } catch (e) {}
  }

  /* ---- googletag (Google Publisher Tag) sahtesi ---- */

  var fakeSlot = {
    addService: thisRef,
    clearCategoryExclusions: thisRef,
    clearTargeting: thisRef,
    defineSizeMapping: thisRef,
    get: returns(null),
    getAdUnitPath: returns(''),
    getResponseInformation: returns(null),
    getSlotElementId: returns(''),
    getTargeting: returns([]),
    set: thisRef,
    setCategoryExclusion: thisRef,
    setCollapseEmptyDiv: thisRef,
    setTargeting: thisRef
  };

  var fakePubads = {
    addEventListener: noop,
    clearCategoryExclusions: thisRef,
    clearTargeting: thisRef,
    collapseEmptyDivs: noop,
    disableInitialLoad: noop,
    display: noop,
    enableAsyncRendering: noop,
    enableLazyLoad: noop,
    enableSingleRequest: noop,
    enableVideoAds: noop,
    get: returns(null),
    getSlots: returns([]),
    getTargeting: returns([]),
    isInitialLoadDisabled: returns(false),
    refresh: noop,
    set: thisRef,
    setCategoryExclusion: thisRef,
    setCentering: noop,
    setPrivacySettings: thisRef,
    setPublisherProvidedId: noop,
    setRequestNonPersonalizedAds: noop,
    setTargeting: thisRef,
    setVideoContent: noop,
    updateCorrelator: noop
  };

  var fakeGoogletag = {
    apiReady: true,
    pubadsReady: true,
    cmd: [],
    content: returns({}),
    defineOutOfPageSlot: returns(fakeSlot),
    defineSlot: returns(fakeSlot),
    destroySlots: noop,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    getVersion: returns(''),
    pubads: returns(fakePubads),
    setConfig: noop
  };

  // Kick'in reklam kodu genelde googletag.cmd.push(fn) ile kuyruğa alma
  // deseni kullanır (GPT'nin standart async yükleme kalıbı). cmd dizisine
  // bir fonksiyon eklendiği anda hemen (zararsızca) çalıştırıp atıyoruz —
  // içindeki çağrılar yukarıdaki no-op'lara düştüğü için hiçbir reklam
  // isteği oluşmuyor.
  fakeGoogletag.cmd = new Proxy(fakeGoogletag.cmd, {
    set: function (target, prop, value) {
      if (prop === 'length') { target.length = value; return true; }
      target[prop] = value;
      if (typeof value === 'function') {
        try { value(); } catch (e) { /* yut */ }
      }
      return true;
    }
  });

  try {
    Object.defineProperty(window, 'googletag', {
      value: fakeGoogletag,
      writable: false,
      configurable: false
    });
  } catch (e) { /* zaten tanımlıysa (nadir) sessizce geç */ }

  /* ---- google.ima (Interactive Media Ads / video reklam SDK'sı) sahtesi ---- */

  var fakeIma = {
    AdDisplayContainer: function () {
      this.initialize = noop;
      this.destroy = noop;
    },
    AdError: function () {},
    AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
    AdEvent: {
      Type: {
        AD_BREAK_READY: 'adBreakReady',
        ALL_ADS_COMPLETED: 'allAdsCompleted',
        CONTENT_PAUSE_REQUESTED: 'contentPauseRequested',
        CONTENT_RESUME_REQUESTED: 'contentResumeRequested',
        LOADED: 'loaded',
        STARTED: 'started'
      }
    },
    AdsLoader: function () {
      this.addEventListener = noop;
      this.removeEventListener = noop;
      this.requestAds = noop;
      this.destroy = noop;
      this.getSettings = returns({});
      this.contentComplete = noop;
    },
    AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } },
    AdsRenderingSettings: function () {},
    AdsRequest: function () {},
    ImaSdkSettings: function () {
      this.setAutoPlayAdBreaks = noop;
      this.setLocale = noop;
      this.setPlayerType = noop;
      this.setPlayerVersion = noop;
      this.setVpaidMode = noop;
    },
    ViewMode: { NORMAL: 'normal', FULLSCREEN: 'fullscreen' },
    VERSION: '0.0.0-kickalert-stub'
  };

  // v2.5.5: Eskiden window.google'ın TAMAMINI Object.defineProperty ile
  // configurable:false yaparak kilitliyorduk. Ama window.google, SADECE
  // reklam (IMA) için değil — Kick'in sayfası başka bir amaçla (farklı bir
  // Google entegrasyonu, analytics vb.) da bu isim alanına yazmaya çalışırsa,
  // bizim kilidimiz yüzünden SESSİZCE başarısız olur ya da hata fırlatırdı.
  // Zaten domain engelleme (DNR kuralları) gerçek IMA script'inin hiç
  // yüklenmesini engelliyor — bu sıkı kilide gerçek bir ihtiyaç yok. Artık
  // sadece normal atama kullanıyoruz, window.google'ın geri kalanına
  // sayfanın kendi kodu istediği gibi dokunabilir.
  try {
    window.google = window.google || {};
    window.google.ima = fakeIma;
  } catch (e) { /* zaten salt-okunursa (nadir) sessizce geç */ }

  log('GPT/IMA SDK stub kuruldu — reklam isteği kaynağında engellendi');
})();
