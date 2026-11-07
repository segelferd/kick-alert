// v2.6.0: Interface motion helpers (popup + multistream).
// Every effect is short, never delays content, and is skipped when the
// system asks for reduced motion. No timers keep running in the background.
(function () {
  'use strict';
  const reduced = () => {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  };
  const EASE = 'cubic-bezier(.2,.8,.25,1)';

  // Positions of the keyed children of a list, before it is rebuilt.
  function snapshot(container) {
    const map = new Map();
    if (!container) return map;
    container.querySelectorAll(':scope > [data-flip]').forEach(el => {
      map.set(el.dataset.flip, el.getBoundingClientRect());
    });
    return map;
  }

  // FLIP: cards that existed before glide from their old place to the new one,
  // new cards fade in. Nothing happens on the very first render (empty snapshot).
  // opts.scale: also animate the size change (multistream tiles).
  function flip(container, before, opts) {
    if (!container || !before || before.size === 0 || reduced()) return;
    const scale = !!(opts && opts.scale);
    container.querySelectorAll(':scope > [data-flip]').forEach(el => {
      if (el.hidden || el.style.display === 'none') return;
      const old = before.get(el.dataset.flip);
      if (old) {
        const now = el.getBoundingClientRect();
        const dx = old.left - now.left, dy = old.top - now.top;
        const sx = scale && now.width ? old.width / now.width : 1;
        const sy = scale && now.height ? old.height / now.height : 1;
        if (Math.abs(dx) < 2 && Math.abs(dy) < 2 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) return;
        el.animate([
          { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
          { transformOrigin: 'top left', transform: 'none' }],
          { duration: scale ? 300 : 240, easing: EASE });
      } else {
        el.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 200, easing: EASE });
      }
    });
  }

  // Restart a CSS class animation on an element (class removed on animationend).
  function pulseClass(el, cls) {
    if (!el || reduced()) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
    el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
  }

  // Remaining-time ring on an element: --ka-left is the remaining share (0..1).
  function setRing(el, until, total) {
    if (!el) return;
    const left = Math.max(0, Math.min(1, (until - Date.now()) / total));
    if (left <= 0) { el.classList.remove('ka-ring-on'); el.style.removeProperty('--ka-left'); return; }
    el.classList.add('ka-ring-on');
    el.style.setProperty('--ka-left', left.toFixed(4));
  }

  // Sliding highlight under the active tab of a segmented tab bar.
  function initTabIndicator(container, btnSelector) {
    if (!container || container._kaInd) return;
    const ind = document.createElement('span');
    ind.className = 'ka-tab-ind';
    ind.setAttribute('aria-hidden', 'true');
    container.prepend(ind);
    container.classList.add('ka-has-ind');
    container._kaInd = ind;
    let first = true;
    const place = () => {
      const a = container.querySelector(btnSelector + '.active');
      if (!a || a.offsetParent === null) { ind.style.opacity = '0'; return; }
      ind.style.opacity = '1';
      if (first || reduced()) ind.style.transition = 'none';
      ind.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
      ind.style.width = a.offsetWidth + 'px';
      ind.style.height = a.offsetHeight + 'px';
      if (first || reduced()) { void ind.offsetWidth; ind.style.transition = ''; }
      first = false;
    };
    container._kaPlace = place;
    try {
      const ro = new ResizeObserver(place);
      ro.observe(container);
      container.querySelectorAll(btnSelector).forEach(b => ro.observe(b));
    } catch (e) {}
    try {
      new MutationObserver(recs => { if (recs.some(r => r.target !== ind)) place(); }).observe(container, { subtree: true, attributes: true, attributeFilter: ['class', 'style', 'data-count'] });
    } catch (e) {}
    place();
  }

  // Text of one element per keyed card (e.g. viewer counts), before a rebuild.
  function snapshotText(container, selector) {
    const map = new Map();
    if (!container) return map;
    container.querySelectorAll(':scope > [data-flip]').forEach(el => {
      const t = el.querySelector(selector);
      if (t) map.set(el.dataset.flip, t.textContent);
    });
    return map;
  }
  // A changed number slides in from below.
  function rollChanged(container, selector, before) {
    if (!container || !before || before.size === 0 || reduced()) return;
    container.querySelectorAll(':scope > [data-flip]').forEach(el => {
      const t = el.querySelector(selector);
      if (!t || !before.has(el.dataset.flip) || before.get(el.dataset.flip) === t.textContent) return;
      if (getComputedStyle(t).display === 'inline') t.style.display = 'inline-block';
      t.animate([{ transform: 'translateY(55%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        { duration: 260, easing: EASE });
    });
  }

  window.KAMotion = { reduced, snapshot, flip, pulseClass, setRing, initTabIndicator, snapshotText, rollChanged };
})();
