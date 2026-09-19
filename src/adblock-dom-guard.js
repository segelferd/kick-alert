/**
 * KickAlert - Ad Block: DOM Guard (3. Katman)
 * ISOLATED dünya (normal content script), document_idle civarı yeterli.
 *
 * İlk iki katmanımız (adblock-worker-hook.js: akış değiştirme,
 * adblock-gpt-stub.js: SDK sahtesi) çoğu durumda yeterli, ama Kick ileride
 * DOM'a doğrudan bir reklam elementi enjekte etmeye başlarsa (örn. "Ad 1 of 1"
 * geri sayım metni, boş reklam kutuları) bu iki katman onu yakalayamaz.
 *
 * Bu dosya bir GÜVENLİK AĞI — sürekli çalışan bir gözlemci DEĞİL. Sadece
 * worker-hook.js/gpt-stub.js'in "bir reklam olayı tespit edildi" sinyalini
 * yaydığı andan sonraki 60 saniye boyunca aktifleşiyor, gerisinde boşta
 * duruyor. Bu, performans maliyetini neredeyse sıfıra indiriyor.
 *
 * Kick'in canlı DOM yapısını taklit etmek yerine (kırılgan olurdu), sadece
 * Kick'in KENDİ test-id kuralına (data-testid="ad-...") ve kısa, sabit
 * kalıplı geri sayım metnine ("Ad 1 of 1" gibi) bakıyoruz — ikisi de Kick'in
 * ürün ekibi değiştirmedikçe stabil kalır.
 *
 * © 2026 Segelferd. All rights reserved.
 */
(function () {
  'use strict';
  if (window.__kaAbDomGuard) return;
  window.__kaAbDomGuard = true;

  var AD_WINDOW_MS = 60000; // reklam tespitinden sonra ne kadar süre aktif kalınacak
  var HIDDEN_ATTR = 'data-ka-ab-hidden';
  var COUNTDOWN_RE = /^ad\s+\d+\s+of\s+\d+$/i; // "Ad 1 of 1" gibi kısa geri sayım metinleri

  // v2.5.21: KRİTİK DÜZELTME. [data-ka-ab-hidden] için gizleme kuralını
  // v2.5.20'de css/popup.css'e eklemiştik — AMA bu dosya SADECE bizim
  // eklenti popup'ımızın kendi HTML'i için kullanılıyor, manifest.json'daki
  // content_scripts bloklarının HİÇBİRİNDE bir "css" girdisi yok. Yani o
  // kural Kick.com sayfasına HİÇBİR ZAMAN yüklenmedi — JS tarafı elementleri
  // doğru şekilde data-ka-ab-hidden="1" ile işaretliyordu ama karşılığı
  // olan CSS kuralı o sayfada hiç mevcut değildi. Şimdi kuralı DOĞRUDAN
  // Kick.com sayfasının <head>'ine bir <style> etiketiyle enjekte ediyoruz —
  // manifest'e yeni bir dosya eklemeye gerek kalmadan, güvenilir bir çözüm.
  (function injectHiddenAttrCss() {
    try {
      var style = document.createElement('style');
      style.textContent = '[' + HIDDEN_ATTR + '] { display: none !important; visibility: hidden !important; }';
      (document.head || document.documentElement).appendChild(style);
    } catch (e) {}
  })();

  var enabled = false;
  var lastAdAt = 0;
  var observer = null;

  function log(text, level) {
    try { console.log('[KickAlert][AdBlock]', text); } catch (e) {}
    try {
      window.postMessage({ source: 'ka-ab-log', level: level || 'info', code: 'ADB-08', text: text }, '*');
    } catch (e) {}
  }

  function withinAdWindow() {
    return Date.now() - lastAdAt < AD_WINDOW_MS;
  }

  // v2.4.11: worker-hook.js'in yaydığı 'adDetected' sinyalini dinle.
  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (d && d.source === 'ka-ab' && d.type === 'adDetected') {
      lastAdAt = Date.now();
      queueScan();
    }
  });

  function playerRoot() {
    var v = document.querySelector('video');
    if (!v) return null;
    var wrap = v.closest('div[id*="player" i], div[class*="player" i]');
    if (wrap) return wrap;
    return (v.parentElement && v.parentElement.parentElement) || null;
  }

  // v2.5.20: Kick'in bazı reklam elementleri "ad-" ile BAŞLAMIYOR ama
  // içeriyor (örn. "ima-ad-controls" — Google IMA reklam kontrol çubuğu).
  // Basit bir "içerir" kontrolü (*="ad-") KULLANMIYORUZ çünkü bu, alakasız
  // elementleri de yanlışlıkla yakalardı (örn. "upload-progress",
  // "load-more", "already-following" gibi tire ile ayrılmış id'ler de
  // "ad-" alt dizesini içerir). Bunun yerine testid'i tire ile bölüp "ad"ın
  // TAM BİR SEGMENT olarak geçip geçmediğini kontrol ediyoruz — güvenli ve kesin.
  function isAdTestId(testid) {
    if (!testid) return false;
    var segments = testid.toLowerCase().split('-');
    for (var i = 0; i < segments.length; i++) {
      if (segments[i] === 'ad' || segments[i] === 'ads') return true;
    }
    return false;
  }

  function matchesAdTestId(el) {
    return el && el.hasAttribute && el.hasAttribute('data-testid') && isAdTestId(el.getAttribute('data-testid'));
  }

  function hasVisibleContent(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (child.hasAttribute(HIDDEN_ATTR)) continue;
      if (matchesAdTestId(child)) continue;
      var r = child.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  // v2.5.21: KRİTİK DÜZELTME. Bu fonksiyon (ve içindeki "elementin kendisini
  // doğrudan gizle" mantığı) SADECE withinAdWindow() true iken çağrılıyordu
  // — yani SADECE bizim ağ-seviyesi reklam tespitimiz bir reklam isteği
  // YAKALADIYSA. Ama reklam engellememiz başarılı olduğunda (isteği kaynakta
  // engellediğimizde) bu sinyal HİÇ oluşmuyor — Kick'in kendi arayüzü yine de
  // "Ad" durumuna geçmiş halde kalabiliyor. Bu yüzden "görünür reklam
  // elementini doğrudan gizleme" kısmını, siyah-slate kontrolü gibi zaman
  // penceresinden TAMAMEN BAĞIMSIZ, HER taramada çalışan ayrı bir fonksiyona
  // taşıdık. "Boş kabı gizleme" kısmı (daha geniş kapsamlı, yanlış pozitif
  // riski taşıyor) hâlâ zaman penceresi İÇİNDE kalıyor.
  function hideDirectAdTestIdElements(root) {
    var hits = 0;
    var candidates = root.querySelectorAll('[data-testid]');
    for (var i = 0; i < candidates.length; i++) {
      if (!matchesAdTestId(candidates[i])) continue;
      if (candidates[i].hasAttribute(HIDDEN_ATTR)) continue;
      var r = candidates[i].getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue; // zaten görünmüyorsa dokunma
      candidates[i].setAttribute(HIDDEN_ATTR, '1');
      hits++;
    }
    return hits;
  }

  function collapseEmptyAdContainers(root) {
    var hits = 0;
    var candidates = root.querySelectorAll('[data-testid]');
    for (var i = 0; i < candidates.length; i++) {
      if (!matchesAdTestId(candidates[i])) continue;
      if (!candidates[i].hasAttribute(HIDDEN_ATTR)) {
        candidates[i].setAttribute(HIDDEN_ATTR, '1');
        hits++;
      }
      var parent = candidates[i].parentElement;
      if (!parent || parent === root || parent.hasAttribute(HIDDEN_ATTR)) continue;
      if (parent.getClientRects().length === 0) continue;
      if (hasVisibleContent(parent)) continue;
      parent.setAttribute(HIDDEN_ATTR, '1');
      hits++;
    }
    return hits;
  }

  function hideCountdownText(root) {
    var hits = 0;
    var candidates = root.querySelectorAll('span, div, p, small, time');
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (el.firstElementChild || el.hasAttribute(HIDDEN_ATTR)) continue;
      var t = (el.textContent || '').trim();
      if (!t || t.length > 24) continue;
      if (COUNTDOWN_RE.test(t)) {
        el.setAttribute(HIDDEN_ATTR, '1');
        hits++;
      }
    }
    return hits;
  }

  // v2.5.8: PureKick v10.22'de bulunan tekniğin kendi tarzımızda uygulaması.
  // Kick, yayın-sonu/reklam-arası geçişte KENDİ statik "siyah slate" videosunu
  // (static.kick.com/ads/black_2s.mp4) sınıfsız/ID'siz bir kapsayıcı içinde
  // oynatıyor — bizim data-testid="ad-*" tabanlı tespitimiz bunu YAKALAMIYOR,
  // çünkü bu gerçek bir üçüncü-taraf reklamı değil, Kick'in kendi dahili
  // geçiş mekanizması. Video elementini KENDİ src'sinden buluyoruz, onu
  // SARAN katmanı (video-player'ın ebeveyni) gizliyoruz — gerçek yayın
  // oynatıcısı ayrı bir ağaçta, ona hiç dokunmuyoruz.
  //
  // BİLİNÇLİ TASARIM KARARI: Bu kontrol, diğerlerinin aksine 60 saniyelik
  // "reklam tespit edildi" penceresine BAĞLI DEĞİL — çünkü bu senaryoda
  // diğer mekanizmalarımız (manifest değişimi, GPT stub) hiç tetiklenmemiş
  // olabilir, yani o pencere hiç açılmamış olabilir. src eşleşmesi zaten
  // çok kesin/dar kapsamlı olduğu için sürekli çalışması düşük risklidir.
  var BLACK_SLATE_SEL = 'video[src*="static.kick.com/ads"], video[src*="/ads/black"]';
  function hideBlackSlateOverlay(root) {
    var hits = 0;
    var vids;
    try { vids = (root || document).querySelectorAll(BLACK_SLATE_SEL); } catch (e) { return 0; }
    for (var i = 0; i < vids.length; i++) {
      var v = vids[i];
      var vp = (v.closest && v.closest('video-player')) || v.parentElement;
      var wrap = vp && vp.parentElement;
      if (wrap && wrap instanceof HTMLElement && !wrap.hasAttribute(HIDDEN_ATTR)) {
        wrap.setAttribute(HIDDEN_ATTR, '1');
        hits++;
      }
    }
    return hits;
  }

  function scan() {
    if (!enabled) return;

    // Siyah slate kontrolü VE görünür reklam elementlerinin doğrudan
    // gizlenmesi her zaman çalışır (zaman penceresinden bağımsız) — v2.5.21:
    // ikisi de artık bizim ağ-seviyesi tespitimize bağımlı değil.
    var slateHits = hideBlackSlateOverlay(document);
    var directHits = hideDirectAdTestIdElements(document);
    if (slateHits || directHits) {
      log('DOM temizliği (koşulsuz): ' + slateHits + ' siyah slate, ' + directHits + ' görünür reklam elementi gizlendi');
    }

    if (!withinAdWindow()) return;
    var root = playerRoot();
    if (!root) return;

    var countdownHits = hideCountdownText(root);
    var containerHits = collapseEmptyAdContainers(root);
    if (countdownHits || containerHits) {
      log('DOM temizliği: ' + countdownHits + ' geri sayım metni, ' + containerHits + ' boş reklam kabı gizlendi');
    }
  }

  // v2.5.12: Eskiden requestAnimationFrame kullanıyorduk — bu, HER frame'de
  // (yaklaşık 16ms'de bir) tetiklenebiliyordu, yoğun bir DOM değişikliği
  // patlaması sırasında (örn. Kick'in kendi React'i yayın geçişinde çok
  // sayıda öğeyi değiştirirken) onlarca kez art arda taranmaya devam
  // edebiliyordu — tam da bu tür anlarda EKSTRA yük bindirmek istemediğimiz
  // yer. Artık gerçek bir debounce kullanıyoruz: DOM 250ms boyunca
  // sakinleşene kadar tarama ertelenir, sadece bir kez çalışır.
  var scanDebounceTimer = null;
  function queueScan() {
    if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(function () {
      scanDebounceTimer = null;
      scan();
    }, 250);
  }

  function startObserver() {
    if (observer) return;
    // v2.5.8: Artık HER mutasyonda tarama sıraya alınıyor (sadece "reklam
    // tespit edildi" penceresindeyken değil) — çünkü siyah slate kontrolü
    // pencereden bağımsız çalışması gerekiyor. scan() fonksiyonunun kendisi
    // hangi alt kontrollerin çalışacağına karar veriyor.
    observer = new MutationObserver(function () {
      queueScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function stopObserver() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    var hidden = document.querySelectorAll('[' + HIDDEN_ATTR + ']');
    for (var i = 0; i < hidden.length; i++) hidden[i].removeAttribute(HIDDEN_ATTR);
  }

  function applyEnabled(v) {
    enabled = v;
    if (enabled) {
      startObserver();
      // v2.5.21: Sadece SONRAKİ DOM değişikliklerine değil, bu an itibarıyla
      // SAYFADA ZATEN VAR OLAN reklam içeriğine karşı da ilk bir tarama
      // yapalım — örn. Kick'in kendi hydration'ı sırasında "Ad" arayüzü
      // DAHA BİZ ÇALIŞMAYA BAŞLAMADAN önce render edilmiş olabilir, bu
      // durumda hiçbir mutasyon tetiklenmeyeceği için taramamız hiç çalışmazdı.
      queueScan();
    } else {
      stopObserver();
    }
  }

  // v2.4.11: adblock-worker-hook.js/gpt-stub.js ile AYNI bayrağı paylaşıyor —
  // ayrı bir ayar eklemedik, hepsi tek "Ad Blocking" anahtarına bağlı.
  try {
    chrome.storage.local.get('adBlockEnabled', function (res) {
      applyEnabled(res && res.adBlockEnabled === true);
    });
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.adBlockEnabled) return;
      applyEnabled(changes.adBlockEnabled.newValue === true);
    });
  } catch (e) {}
})();
