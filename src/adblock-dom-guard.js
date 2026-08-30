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

  var enabled = false;
  var lastAdAt = 0;
  var observer = null;
  var scanQueued = false;

  function log(text, level) {
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

  function hasVisibleContent(el) {
    for (var i = 0; i < el.children.length; i++) {
      var child = el.children[i];
      if (child.hasAttribute(HIDDEN_ATTR)) continue;
      if (child.matches && child.matches('[data-testid^="ad-"]')) continue;
      var r = child.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  function collapseEmptyAdContainers(root) {
    var hits = 0;
    var adEls = root.querySelectorAll('[data-testid^="ad-"]');
    for (var i = 0; i < adEls.length; i++) {
      var parent = adEls[i].parentElement;
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

  function scan() {
    scanQueued = false;
    if (!enabled || !withinAdWindow()) return;
    var root = playerRoot();
    if (!root) return;

    var countdownHits = hideCountdownText(root);
    var containerHits = collapseEmptyAdContainers(root);
    if (countdownHits || containerHits) {
      log('DOM temizliği: ' + countdownHits + ' geri sayım metni, ' + containerHits + ' boş reklam kabı gizlendi');
    }
  }

  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(scan);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function () {
      if (withinAdWindow()) queueScan();
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
    if (enabled) startObserver();
    else stopObserver();
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
