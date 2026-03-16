/**
 * KickAlert — Multi-Stream App
 * Watch multiple Kick channels simultaneously.
 * Uses player.kick.com embed, drag-drop reorder, per-card fullscreen.
 * © 2025 Segelferd. All rights reserved.
 */

(function () {
  'use strict';

  const PLAYER_BASE = 'https://player.kick.com/';
  const STORAGE_KEY = 'multistream';

  let streams = [];  // [{ slug }]
  let layout = 'side';
  let dragSrcIdx = null;

  // ─── SVG Icons ───

  function svgFullscreen() {
    return `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="fill:none">
      <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
    </svg>`;
  }

  function svgClose() {
    return `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" style="fill:none">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>`;
  }

  // ─── Init ───

  async function init() {
    const local = await chrome.storage.local.get([STORAGE_KEY]);
    const saved = local[STORAGE_KEY];
    if (saved) {
      layout = saved.layout || 'side';
      (saved.channels || []).forEach(slug => addStream(slug, false));
    }

    setLayout(layout, false);
    render();
    bindEvents();
    listenMessages();
  }

  // ─── Stream Management ───

  function addStream(slug, save = true) {
    slug = slug.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return;
    if (streams.find(s => s.slug === slug)) return;
    streams.push({ slug });
    if (save) saveToStorage();
    render();
    updateEmptyState();
  }

  function removeStream(slug) {
    streams = streams.filter(s => s.slug !== slug);
    saveToStorage();
    render();
    updateEmptyState();
  }

  function closeAll() {
    streams = [];
    saveToStorage();
    render();
    updateEmptyState();
  }

  async function saveToStorage() {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        channels: streams.map(s => s.slug),
        layout
      }
    });
  }

  // ─── Layout ───

  function setLayout(name, save = true) {
    layout = name;
    const grid = document.getElementById('stream-grid');
    grid.dataset.layout = name;

    document.querySelectorAll('.layout-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.layout === name);
    });

    applyLayoutCSS();
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

    // Add new cards — don't touch existing ones (avoids iframe reload)
    streams.forEach(stream => {
      if (!grid.querySelector(`[data-slug="${stream.slug}"]`)) {
        grid.appendChild(buildCard(stream));
      }
    });

    applyLayoutCSS();
    updateEmptyState();
  }

  function buildCard(stream) {
    const card = document.createElement('div');
    card.className = 'stream-card';
    card.dataset.slug = stream.slug;
    card.draggable = true;

    card.innerHTML = `
      <div class="stream-overlay">
        <div class="stream-info">
          <span class="stream-name">${escHtml(stream.slug)}</span>
          <span class="stream-live-badge" style="display:none">LIVE</span>
          <span class="stream-viewers" data-slug="${escHtml(stream.slug)}"></span>
        </div>
        <div class="stream-controls">
          <button class="ctrl-btn" data-action="fullscreen" title="Fullscreen">${svgFullscreen()}</button>
          <button class="ctrl-btn remove" data-action="remove" title="Remove">${svgClose()}</button>
        </div>
      </div>
      <iframe
        class="stream-iframe"
        src="${PLAYER_BASE}${escHtml(stream.slug)}?muted=1"
        allow="autoplay; fullscreen"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms"
      ></iframe>
    `;

    // Control buttons
    card.querySelector('.stream-controls').addEventListener('click', e => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      e.stopPropagation();
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
      streams.forEach(s => {
        const c = g.querySelector(`[data-slug="${s.slug}"]`);
        if (c) g.appendChild(c);
      });
      applyLayoutCSS();
      saveToStorage();
    });

    return card;
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
