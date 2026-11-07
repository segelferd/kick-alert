(function () {
  var D = JSON.parse(document.getElementById('fun').textContent);
  var RM = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fmt = function (s, o) { return s.replace(/\{(\w)\}/g, function (_, k) { return o[k] == null ? '' : o[k]; }); };
  var COLORS = ['#5b6cff', '#ff7a45', '#18c29c', '#e0469b', '#f2b134', '#8b5cf6'];

  /* desktop-notification look-alike toasts */
  var stack = document.getElementById('toasts');
  function toast(o) {
    var el = document.createElement('div');
    el.className = 'ntoast ' + (o.kind || '');
    el.innerHTML = '<div class="app"><img src="' + D.icon + '" alt="">KickAlert<span><i class="live-dot"></i>' + D.now + '</span></div>' +
      '<div class="row"><div class="av"></div><div><b></b><small></small></div></div>';
    var av = el.querySelector('.av');
    av.textContent = o.av; av.style.background = o.color || '#5b6cff';
    if (o.kind === 'njt') av.style.boxShadow = '0 0 0 2px #ff5a5a';
    el.querySelector('b').textContent = o.t;
    el.querySelector('small').textContent = o.b;
    stack.insertBefore(el, stack.firstChild);
    while (stack.children.length > (window.innerWidth < 600 ? 2 : 3)) stack.removeChild(stack.lastChild);
    var gone = function () { el.classList.add('out'); setTimeout(function () { el.remove(); }, 420); };
    el.addEventListener('click', gone);
    setTimeout(gone, window.innerWidth < 600 ? 4500 : 6500);
  }

  /* hero: 2:59:55 -> 3:00, notification drops in */
  var scene = document.querySelector('.scene');
  if (scene) {
    var hm = scene.querySelector('.hm'), ss = scene.querySelector('.ss'), timers = [];
    var final = function () {
      hm.textContent = '3:00'; ss.textContent = '';
      scene.classList.remove('sleep'); scene.classList.add('hit');
      timers.push(setTimeout(function () { scene.classList.add('rang'); }, RM ? 0 : 380));
    };
    var play = function () {
      timers.forEach(clearTimeout); timers = [];
      scene.classList.remove('hit', 'rang'); void scene.offsetWidth;
      if (RM) { final(); return; }
      scene.classList.add('sleep'); hm.textContent = '2:59';
      var s = 55; ss.textContent = ':' + s;
      for (var i = 1; i <= 5; i++) timers.push(setTimeout(function () { s++; if (s === 60) final(); else ss.textContent = ':' + s; }, i * 850));
    };
    scene.querySelector('.replay').addEventListener('click', play);
    play();
  }

  /* try it: bell -> waiting -> live + notification */
  document.querySelectorAll('.ch').forEach(function (card, idx) {
    var bell = card.querySelector('.bell'), state = card.querySelector('.state'), n = card.dataset.n, t = null;
    var reset = function () {
      clearTimeout(t); card.classList.remove('on', 'live');
      bell.setAttribute('aria-pressed', 'false'); bell.setAttribute('aria-label', fmt(D.try_bell_on, { n: n }));
      state.textContent = D.try_off;
    };
    bell.addEventListener('click', function () {
      if (bell.getAttribute('aria-pressed') === 'true') { reset(); return; }
      bell.setAttribute('aria-pressed', 'true'); bell.setAttribute('aria-label', fmt(D.try_bell_off, { n: n }));
      card.classList.add('on'); state.textContent = D.try_wait;
      t = setTimeout(function () {
        card.classList.remove('on'); card.classList.add('live'); state.textContent = D.try_live;
        toast({ t: fmt(D.try_toast, { n: n }), b: card.querySelector('small').textContent, av: n[0], color: card.dataset.c });
      }, 1600 + idx * 350 + Math.random() * 900);
    });
  });

  /* ninja stream gag: once, when the third feature scrolls into view */
  var nj = document.querySelector('.ninja'), target = document.querySelector('[data-ninja]');
  if (nj && target && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      if (!es[0].isIntersecting) return;
      io.disconnect();
      var fire = function () { toast({ t: D.ninja_t, b: fmt(D.ninja_b, { n: D.ninja_n }), av: D.ninja_n[0], color: '#1b1f2a', kind: 'njt' }); };
      if (RM) { fire(); return; }
      nj.classList.add('run');
      var rect = nj.getBoundingClientRect(), y = window.innerHeight - parseFloat(getComputedStyle(nj).bottom) - 22;
      for (var k = 0; k < 6; k++) (function (k) {
        setTimeout(function () {
          var p = document.createElement('i'); p.className = 'puff';
          p.style.left = (k + 0.3) * window.innerWidth / 6 + 'px'; p.style.top = y + 'px';
          document.body.appendChild(p); setTimeout(function () { p.remove(); }, 950);
        }, 120 + k * 190);
      })(k);
      setTimeout(fire, 700);
      setTimeout(function () { nj.classList.remove('run'); }, 1500);
    }, { threshold: 0.45 });
    io.observe(target);
  }

  /* chat radar: fake chat, the visitor's name triggers a notification */
  var radar = document.querySelector('.radar');
  if (radar) {
    var ul = radar.querySelector('ul'), input = radar.querySelector('input'), i = 0, lastToast = 0, visible = false, timer = null;
    var tick = function () {
      var raw = D.radar_msgs[i++ % D.radar_msgs.length];
      var name = (input.value || '').trim() || D.radar_default;
      var u = D.users[Math.floor(Math.random() * D.users.length)];
      var li = document.createElement('li'), b = document.createElement('b');
      b.textContent = u; b.style.color = COLORS[u.length % COLORS.length];
      li.appendChild(b); li.appendChild(document.createTextNode(fmt(raw, { n: name })));
      if (raw.indexOf('{n}') > -1) {
        li.className = 'hit';
        if (Date.now() - lastToast > 5000) {
          lastToast = Date.now();
          toast({ t: fmt(D.radar_toast, { u: u, c: D.radar_chan }), b: fmt(raw, { n: name }), av: u[0].toUpperCase(), color: COLORS[u.length % COLORS.length], kind: 'radarhit' });
        }
      }
      ul.appendChild(li);
      while (ul.children.length > 9) ul.removeChild(ul.firstChild);
    };
    var loop = function () { clearTimeout(timer); if (!visible) return; tick(); timer = setTimeout(loop, 1150 + Math.random() * 700); };
    for (var w = 0; w < 4; w++) tick();
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) { visible = es[0].isIntersecting; if (visible) loop(); }, { threshold: 0.35 }).observe(radar);
    }
  }

  /* screenshots slide and tilt in on scroll */
  if ('IntersectionObserver' in window) {
    var ro = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); ro.unobserve(e.target); } });
    }, { threshold: 0.18 });
    document.querySelectorAll('.reveal').forEach(function (el) { ro.observe(el); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (el) { el.classList.add('in'); });
  }
})();
