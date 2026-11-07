/**
 * KickAlert - Multi-Stream App
 * Watch multiple Kick channels simultaneously.
 * Uses player.kick.com embed, drag-drop reorder, per-card fullscreen.
 * © 2025 Segelferd. All rights reserved.
 */

(function () {
  'use strict';

  const PLAYER_BASE = 'https://player.kick.com/';
  const STORAGE_KEY = 'multistream';

  // v2.5.104: Kick oynatıcısı sessiz başlatma için muted=true bekliyor (muted=1
  // tanınmıyordu, yayınlar sesli başlıyordu). Ses odağı (v2.5.105) muted=false kullanır.
  function playerUrl(slug, muted = true) {
    return `${PLAYER_BASE}${encodeURIComponent(slug)}?muted=${muted ? 'true' : 'false'}`;
  }

  let streams = [];  // [{ slug }]
  let layout = 'side';
  let dragSrcIdx = null;
  // v2.5.105: sesi açık tek kart (null = hepsi sessiz)
  let audioSlug = null;
  // v2.5.106: sohbet çekmecesi
  let chatOpen = false;
  let chatSlug = null;
  let chatPicked = false; // kullanıcı seçti ya da kayıttan geldi; değilse varsayılan izlenir
  const CHAT_BASE = 'https://kick.com/popout/';
  function chatUrl(slug) { return `${CHAT_BASE}${encodeURIComponent(slug)}/chat`; }

  // v2.5.105: sayfa artık KickAlert dil ayarını kullanıyor
  function t(key, fallback, subs) {
    try { if (typeof Utils !== 'undefined') { const m = Utils.i18n(key, subs); if (m && m !== key) return m; } } catch (e) {}
    return fallback;
  }
  function applyI18n() {
    document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n, el.textContent); });
    document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle, el.title); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder, el.placeholder); });
    try { if (typeof Utils !== 'undefined') document.documentElement.lang = Utils.getCurrentLang().replace('_', '-'); } catch (e) {}
  }

  // ─── SVG Icons ───

  function svgFullscreen() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="fill:none">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
    </svg>`;
  }

  function svgSpeaker(on) {
    return on
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" style="fill:currentColor"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="fill:none"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>`;
  }

  function svgClose() {
    return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="fill:none">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
  }

  // ─── Init ───

  async function init() {
    try { if (typeof Utils !== 'undefined') await Utils.initI18n(); } catch (e) {}
    applyI18n();
    const local = await chrome.storage.local.get([STORAGE_KEY]);
    const saved = local[STORAGE_KEY];
    if (saved) {
      layout = saved.layout || 'side';
      if (saved.audio && (saved.channels || []).includes(saved.audio)) audioSlug = saved.audio;
      if (saved.chat && typeof saved.chat === 'object') {
        chatOpen = !!saved.chat.open;
        if (saved.chat.slug && (saved.channels || []).includes(saved.chat.slug)) { chatSlug = saved.chat.slug; chatPicked = !!saved.chat.picked; }
      }
      (saved.channels || []).forEach(slug => addStream(slug, false));
    }

    setLayout(layout, false);
    render();
    bindEvents();
    listenMessages();
    // v2.6.0: özel gün logosu
    try {
      if (window.KASpecialDay) {
        const ev = await KASpecialDay.resolve();
        if (ev) KASpecialDay.decorateImg(document.querySelector('.brand-logo'), ev, p => chrome.runtime.getURL(p));
      }
    } catch (e) {}
  }

  // ─── Stream Management ───

  function addStream(slug, save = true) {
    slug = slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return;
    if (streams.find(s => s.slug === slug)) return;
    streams.push({ slug });
    render();
    if (save) saveToStorage();
    updateEmptyState();
  }

  function removeStream(slug) {
    if (audioSlug === slug) audioSlug = null;
    streams = streams.filter(s => s.slug !== slug);
    render();
    saveToStorage();
    updateEmptyState();
  }

  function closeAll() {
    audioSlug = null;
    streams = [];
    render();
    saveToStorage();
    updateEmptyState();
  }

  async function saveToStorage() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        channels: streams.map(s => s.slug),
        layout,
        audio: audioSlug,
        chat: { open: chatOpen, slug: chatSlug, picked: chatPicked }
      }
    });
  }

  // ─── Layout ───

  function setLayout(name, save = true) {
    layout = name;
    const grid = document.getElementById('stream-grid');
    // v2.6.0: yerleşim değişince karolar yeni yer ve boyutlarına kayar
    const flipBefore = (save && window.KAMotion) ? KAMotion.snapshot(grid) : null;
    grid.dataset.layout = name;

    document.querySelectorAll('.layout-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === name);
    });

    applyLayoutCSS();
    if (flipBefore) KAMotion.flip(grid, flipBefore, { scale: true });
    if (save) saveToStorage();
  }

  function applyLayoutCSS() {
    const grid = document.getElementById('stream-grid');
    const cards = Array.from(grid.querySelectorAll('.stream-card'));

    if (layout === 'focus' && cards.length > 0) {
      const sideCount = Math.max(1, cards.length - 1);
      grid.style.gridTemplateRows = `repeat(${sideCount}, 1fr)`;
      cards.forEach((card, i) => {
        if (i === 0) {
          card.style.gridRow = '1 / -1';
          card.style.gridColumn = '1';
        } else {
          card.style.gridRow = '';
          card.style.gridColumn = '2';
        }
      });
    } else {
      grid.style.gridTemplateRows = '';
      cards.forEach(card => {
        card.style.gridRow = '';
        card.style.gridColumn = '';
      });
    }
  }

  // ─── Render ───
  // Smart render: only add/remove changed cards, don't reload existing iframes

  function render() {
    const grid = document.getElementById('stream-grid');

    const existingSlugs = new Set();
    grid.querySelectorAll('.stream-card[data-slug]').forEach(el => existingSlugs.add(el.dataset.slug));
    const newSlugs = new Set(streams.map(s => s.slug));

    // Remove cards that are no longer in streams
    existingSlugs.forEach(slug => {
      if (!newSlugs.has(slug)) {
        grid.querySelector(`[data-slug="${slug}"]`)?.remove();
      }
    });

    // Add new cards - don't touch existing ones (avoids iframe reload)
    streams.forEach(stream => {
      if (!grid.querySelector(`[data-slug="${stream.slug}"]`)) {
        grid.appendChild(buildCard(stream));
      }
    });

    applyLayoutCSS();
    updateEmptyState();
    updateChat();
  }

  function buildCard(stream) {
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.slug = stream.slug;
    card.dataset.flip = stream.slug; // v2.6.0
    card.draggable = true;

    card.innerHTML = `
      <span class="ms-eq" aria-hidden="true"><i></i><i></i><i></i></span>
      <div class="stream-overlay">
        <div class="stream-info">
          <span class="stream-name">${escHtml(stream.slug)}</span>
          <span class="stream-live-badge" style="display:none">LIVE</span>
          <span class="stream-viewers" data-slug="${escHtml(stream.slug)}"></span>
        </div>
        <div class="stream-controls">
          <button class="ctrl-btn audio" data-action="audio"><span class="ic-off">${svgSpeaker(false)}</span><span class="ic-on">${svgSpeaker(true)}</span></button>
          <button class="ctrl-btn" data-action="fullscreen" title="${escHtml(t('msFullscreen', 'Fullscreen'))}">${svgFullscreen()}</button>
          <button class="ctrl-btn remove" data-action="remove" title="${escHtml(t('msRemove', 'Remove'))}">${svgClose()}</button>
        </div>
      </div>
      <iframe
        class="stream-iframe"
        src="${escHtml(playerUrl(stream.slug, audioSlug !== stream.slug))}"
        allow="autoplay; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      ></iframe>
    `;

    // Control buttons
    card.querySelector('.stream-controls').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
      if (btn.dataset.action === 'audio') toggleAudio(stream.slug);
      if (btn.dataset.action === 'remove') removeStream(stream.slug);
      if (btn.dataset.action === 'fullscreen') enterFullscreen(card);
    });

    // Drag & Drop
    card.addEventListener('dragstart', e => {
      dragSrcIdx = streams.findIndex(s => s.slug === stream.slug);
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', e => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const destIdx = streams.findIndex(s => s.slug === stream.slug);
      if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
      const [moved] = streams.splice(dragSrcIdx, 1);
      streams.splice(destIdx, 0, moved);
      dragSrcIdx = null;
      // Reorder DOM without rebuilding (avoids iframe reload)
      const g = document.getElementById('stream-grid');
      const flipBefore = window.KAMotion ? KAMotion.snapshot(g) : null; // v2.6.0
      streams.forEach(s => {
        const c = g.querySelector(`[data-slug="${s.slug}"]`);
        if (c) g.appendChild(c);
      });
      applyLayoutCSS();
      if (flipBefore) KAMotion.flip(g, flipBefore, { scale: true });
      saveToStorage();
    });

    updateAudioButton(card, stream.slug);
    return card;
  }

  // ─── v2.5.105: Ses odağı ───
  // Kick oynatıcısı başka bir siteden geldiği için sesi doğrudan kontrol
  // edilemiyor. Tıklanan kart muted=false adresiyle, önceki sesli kart
  // muted=true adresiyle yeniden yüklenir (iki tarayıcıda da aynı çalışır).
  // Diğer kartlara dokunulmaz; onlar zaten sessiz başlıyor.
  function cardOf(slug) {
    return document.querySelector(`#stream-grid .stream-card[data-slug="${CSS.escape(slug)}"]`);
  }
  function reloadPlayer(slug, muted) {
    const f = cardOf(slug)?.querySelector('.stream-iframe');
    if (!f) return;
    const url = playerUrl(slug, muted);
    if (f.getAttribute('src') !== url) f.setAttribute('src', url);
  }
  function updateAudioButton(card, slug) {
    const on = audioSlug === slug;
    card.classList.toggle('audio-on', on);
    const b = card.querySelector('[data-action="audio"]');
    if (!b) return;
    b.classList.toggle('active', on);
    b.title = on ? t('msListenOff', 'Mute this stream') : t('msListen', 'Listen to this stream only');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  function toggleAudio(slug) {
    const prev = audioSlug;
    if (prev === slug) {
      audioSlug = null;
      reloadPlayer(slug, true);
    } else {
      audioSlug = slug;
      if (prev) reloadPlayer(prev, true);
      reloadPlayer(slug, false);
    }
    document.querySelectorAll('#stream-grid .stream-card[data-slug]').forEach(c => updateAudioButton(c, c.dataset.slug));
    updateChat();
    saveToStorage();
  }

  // ─── v2.5.106: Sohbet çekmecesi ───
  // Kick'in açılır sohbet sayfası (kick.com/popout/{kanal}/chat) sağdaki
  // çekmecede açılır. Kanal seçilebilir; varsayılan sesi açık kart, yoksa ilk kart.
  function updateChat() {
    const drawer = document.getElementById('chat-drawer');
    if (!drawer) return;
    const slugs = streams.map(s => s.slug);
    if (chatSlug && !slugs.includes(chatSlug)) { chatSlug = null; chatPicked = false; }
    if (!chatPicked) chatSlug = slugs.length ? ((audioSlug && slugs.includes(audioSlug)) ? audioSlug : slugs[0]) : null;
    drawer.hidden = !chatOpen;
    document.body.classList.toggle('chat-open', chatOpen);
    const btn = document.getElementById('btn-chat');
    if (btn) {
      btn.classList.toggle('active', chatOpen);
      btn.setAttribute('aria-pressed', chatOpen ? 'true' : 'false');
      btn.title = chatOpen ? t('msChatClose', 'Close chat') : t('msChatShow', 'Show chat');
    }
    const sel = document.getElementById('chat-channel');
    if (sel) {
      const cur = [...sel.options].map(o => o.value).join(',');
      if (cur !== slugs.join(',')) {
        sel.innerHTML = '';
        for (const s of slugs) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); }
      }
      if (chatSlug) sel.value = chatSlug;
      sel.disabled = !slugs.length;
    }
    const frame = document.getElementById('chat-frame');
    const empty = document.getElementById('chat-empty');
    const openTab = document.getElementById('chat-open-tab');
    if (openTab) openTab.disabled = !chatSlug;
    if (empty) empty.hidden = !!chatSlug;
    if (frame) {
      frame.hidden = !chatSlug;
      // Çekmece kapalıyken sohbet yüklenmez (gereksiz bağlantı olmasın)
      const want = (chatOpen && chatSlug) ? chatUrl(chatSlug) : '';
      if ((frame.getAttribute('src') || '') !== want) {
        if (want) frame.setAttribute('src', want); else frame.removeAttribute('src');
      }
    }
  }
  function setChatOpen(open) {
    chatOpen = !!open;
    updateChat();
    saveToStorage();
  }

  // ─── Helpers ───

  function updateEmptyState() {
    const empty = document.getElementById('empty-state');
    empty.hidden = streams.length > 0;
  }

  function enterFullscreen(card) {
    if (!document.fullscreenElement) {
      card.requestFullscreen?.();
    } else {
      document.exitFullscreen?.();
    }
  }

  function bindEvents() {
    document.getElementById('add-form').addEventListener('submit', e => {
      e.preventDefault();
      const input = document.getElementById('input-channel');
      addStream(input.value);
      input.value = '';
      input.focus();
    });

    document.getElementById('layout-btns').addEventListener('click', e => {
      const btn = e.target.closest('.layout-btn');
      if (!btn) return;
      setLayout(btn.dataset.layout);
    });

    document.getElementById('btn-close-all').addEventListener('click', closeAll);

    // v2.5.106: sohbet çekmecesi
    document.getElementById('btn-chat')?.addEventListener('click', () => setChatOpen(!chatOpen));
    document.getElementById('chat-close')?.addEventListener('click', () => setChatOpen(false));
    document.getElementById('chat-channel')?.addEventListener('change', e => { chatSlug = e.target.value || null; chatPicked = !!chatSlug; updateChat(); saveToStorage(); });
    document.getElementById('chat-open-tab')?.addEventListener('click', () => {
      if (!chatSlug) return;
      try { chrome.tabs.create({ url: chatUrl(chatSlug) }); } catch (e) { window.open(chatUrl(chatSlug), '_blank', 'noopener'); }
    });

    // Clear storage when tab is closed
    // BUG 8 FIX: beforeunload async calls may not complete.
    // Use both beforeunload and pagehide for better coverage.
    const clearStorage = () => { chrome.storage.local.remove(STORAGE_KEY); };
    window.addEventListener('beforeunload', clearStorage);
    window.addEventListener('pagehide', clearStorage);
  }

  function listenMessages() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'ADD_TO_MULTISTREAM' && msg.slug) {
        addStream(msg.slug);
      }
    });
  }

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  init();
})();
