/**
 * KickAlert — Chat Integration
 * Based on v1.7.0 proven implementation. Selectors verified with KickKit v1.0.0.
 *
 * Kick DOM (2025/2026):
 *   #chatroom-messages                       — chat root
 *   [data-index]                             — message node (virtual scroll, recycled)
 *   button.font-bold       — username (textContent)
 *   span.font-normal                         — message text
 *   .break-words                             — message box
 *   [data-emote-id]                          — emote
 *
 * Features (9):
 *   1. Bot / 2. User / 3. Word / 4. Repeat / 5. Emoji filters (with per-category enable flags)
 *   6. Favorite user highlight / 7. Keyword highlight
 *   8. Tag mention notification / 9. Broadcaster message notification (username === slug)
 *   Notifications throttled to 1 per type per 60s to prevent flood.
 *
 * © 2025 Segelferd. All rights reserved.
 */

(function () {
  'use strict';

  // v2.1.0: dinamik version stamp (manifest'ten okunur)
  const _v = (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?';
  console.debug('%c[KickAlert Chat v' + _v + '] loaded: ' + location.href,
    'background:#53FC18;color:#000;font-weight:bold;padding:2px 6px');

  const NON_CHANNEL = new Set([
    '', 'categories', 'following', 'browse', 'search', 'dashboard',
    'terms-of-service', 'privacy-policy', 'community-guidelines',
    'contact', 'about', 'settings', 'wallet', 'subscriptions',
    'inventory', 'messages', 'notifications', 'drops', 'clips',
    'leaderboards', 'store', 'events', 'help', 'signup', 'login',
    'api', 'vods', 'channels', 'home', 'watch',
  ]);
  const slug = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0].toLowerCase();
  if (!slug || NON_CHANNEL.has(slug)) {
    console.debug('[KickAlert Chat] not a channel page, exiting');
    return;
  }

  // ─── Proven selectors (KickKit v1.0.0 verified) ───
  const CHAT_ROOT = '#chatroom-messages';
  const MSG_SEL   = '[data-index]';
  const USER_SEL  = 'button.font-bold';
  const TEXT_SEL  = 'span.font-normal';

  // ─── State ───
  let enabled    = false;
  let settings   = null;
  let chatRoot   = null;
  let chatObs    = null;
  const dupMap   = new Map();
  let stylesInjected = false;

  // Throttle: prevent notification flood (same type within NOTIF_THROTTLE_MS).
  // Backed by chrome.storage.local so the throttle survives page refresh and
  // SW restarts. Read once at init, write-through on each notification.
  const NOTIF_THROTTLE_MS = 60 * 1000;
  const THROTTLE_KEY = '_chatNotifThrottle';
  const lastNotifAt = { tag: 0, broadcaster: 0 };

  function loadThrottle() {
    try {
      chrome.storage.local.get(THROTTLE_KEY, r => {
        const stored = r && r[THROTTLE_KEY];
        if (stored && typeof stored === 'object') {
          lastNotifAt.tag = stored.tag || 0;
          lastNotifAt.broadcaster = stored.broadcaster || 0;
        }
      });
    } catch (_) {}
  }

  function canNotify(type) {
    const now = Date.now();
    if (now - (lastNotifAt[type] || 0) < NOTIF_THROTTLE_MS) return false;
    lastNotifAt[type] = now;
    // Write-through: persist the timestamp so refresh/SW-restart doesn't reset throttle
    try {
      chrome.storage.local.set({ [THROTTLE_KEY]: { ...lastNotifAt } }).catch(() => {});
    } catch (_) {}
    return true;
  }

  // ─── Helpers ───
  const norm = s => (s || '').toLowerCase().replace(/-/g, '_').trim();

  function msgHash(text, node) {
    const t = text.toLowerCase().replace(/\s+/g, '').substring(0, 100);
    const emotes = [...node.querySelectorAll('[data-emote-id]')]
      .map(e => e.getAttribute('data-emote-id') || '').join(',');
    return t + '|' + emotes;
  }

  function matchesWord(text, word) {
    const isLetter = c => /[\p{L}\p{N}_]/u.test(c);
    const lt = text.toLowerCase();
    const lw = word.toLowerCase();
    let idx = 0;
    while ((idx = lt.indexOf(lw, idx)) !== -1) {
      const before = idx > 0 ? lt[idx - 1] : '';
      const after  = idx + lw.length < lt.length ? lt[idx + lw.length] : '';
      if (!isLetter(before) && !isLetter(after)) return true;
      idx++;
    }
    return false;
  }

  // ─── Styles ───
  function injectStyles() {
    if (stylesInjected || document.getElementById('ka-chat-style')) {
      stylesInjected = true;
      return;
    }
    const style = document.createElement('style');
    style.id = 'ka-chat-style';
    style.textContent = `
      html.ka-chat-active .ka-hide-bot,
      html.ka-chat-active .ka-hide-user,
      html.ka-chat-active .ka-hide-word,
      html.ka-chat-active .ka-hide-dup {
        display: none !important;
      }
      html.ka-chat-active .ka-blur,
      html.ka-chat-active .ka-emoji-spam {
        filter: blur(5px);
        opacity: 0.45;
        transition: filter 0.2s, opacity 0.2s;
        cursor: pointer;
      }
      html.ka-chat-active .ka-blur:hover,
      html.ka-chat-active .ka-emoji-spam:hover {
        filter: none;
        opacity: 1;
      }
      html.ka-chat-active .ka-fav-msg .break-words {
        border-left: 2px solid var(--ka-fav-color, #53FC18) !important;
        background: color-mix(in srgb, var(--ka-fav-color, #53FC18) 8%, transparent) !important;
        padding-left: 8px !important;
      }
      html.ka-chat-active .ka-fav-msg button.font-bold {
        font-weight: 700 !important;
      }
      html.ka-chat-active .ka-keyword .break-words {
        background: rgba(83, 252, 24, 0.12) !important;
        border-left: 3px solid #53FC18 !important;
        padding-left: 8px !important;
        border-radius: 0 4px 4px 0 !important;
      }
      html.ka-chat-active .ka-keyword button.font-bold {
        color: #53FC18 !important;
        font-weight: 700 !important;
      }
      html.ka-chat-active .ka-mention .break-words {
        background: rgba(255, 100, 0, 0.14) !important;
        border-left: 3px solid #ff6400 !important;
        padding-left: 8px !important;
        border-radius: 0 4px 4px 0 !important;
      }
      html.ka-chat-active .ka-mention button.font-bold {
        font-weight: 700 !important;
      }
    `;
    document.head.appendChild(style);
    stylesInjected = true;
  }

  // ─── Settings ───
  function loadSettings(cb) {
    chrome.storage.local.get(['chatIntegrationEnabled', 'chatSettings'], r => {
      enabled = !!r.chatIntegrationEnabled;
      const defaults = {
        filterBlur: false,
        botFilter: false,
        botList: ['Nightbot', 'StreamElements', 'Moobot', 'Fossabot', 'KickBot'],
        emojiFilter: false,
        emojiThreshold: 10,
        repeatFilter: false,
        repeatWindow: 60,
        repeatThreshold: 3,
        wordFilterEnabled: false,
        wordList: [],
        userFilterEnabled: false,
        userList: [],
        keywordEnabled: false,
        keywordList: [],
        favEnabled: false,
        favList: [],
        tagEnabled: false,
        tagUsername: '',
        broadcasterNotif: false,
      };
      settings = Object.assign(defaults, r.chatSettings || {});
      // First run: persist defaults so popup and content script stay in sync
      if (!r.chatSettings) {
        chrome.storage.local.set({ chatSettings: settings }).catch(() => {});
      }
      if (cb) cb();
    });
  }

  // ─── Process message ───
  function processMessage(node, isNew) {
    if (!node || !node.hasAttribute || !node.hasAttribute('data-index')) return;

    node.classList.remove(
      'ka-hide-bot', 'ka-hide-user', 'ka-hide-word', 'ka-hide-dup',
      'ka-blur', 'ka-emoji-spam', 'ka-fav-msg', 'ka-keyword', 'ka-mention'
    );
    node.style.removeProperty('--ka-fav-color');

    const userBtn  = node.querySelector(USER_SEL);
    const username = norm(userBtn?.textContent?.trim() || '');
    const textSpan = node.querySelector(TEXT_SEL);
    const text     = textSpan?.textContent?.trim() || '';
    const blurMode = !!settings.filterBlur;

    if (!username || !text) return;

    // 1. Bot filter
    if (settings.botFilter && (settings.botList || []).length) {
      if (settings.botList.some(b => norm(b) === username)) {
        node.classList.add(blurMode ? 'ka-blur' : 'ka-hide-bot');
        return;
      }
    }

    // 2. User filter
    if (settings.userFilterEnabled && (settings.userList || []).length) {
      if (settings.userList.some(u => u && norm(u) === username)) {
        node.classList.add(blurMode ? 'ka-blur' : 'ka-hide-user');
        return;
      }
    }

    // 3. Word filter
    if (settings.wordFilterEnabled && (settings.wordList || []).length) {
      for (const word of settings.wordList) {
        if (word && matchesWord(text, word)) {
          node.classList.add(blurMode ? 'ka-blur' : 'ka-hide-word');
          return;
        }
      }
    }

    // 4. Repeat filter
    if (settings.repeatFilter && isNew) {
      const h = msgHash(text, node);
      if (h && h !== '|') {
        const key = username + ':' + h;
        const windowMs = (settings.repeatWindow || 60) * 1000;
        const threshold = Math.max(2, settings.repeatThreshold || 3);
        const now = Date.now();
        const entry = dupMap.get(key) || { count: 0, ts: 0 };
        if (now - entry.ts > windowMs) {
          dupMap.set(key, { count: 1, ts: now });
        } else {
          entry.count++;
          entry.ts = now;
          dupMap.set(key, entry);
          if (entry.count >= threshold) {
            node.classList.add(blurMode ? 'ka-blur' : 'ka-hide-dup');
            return;
          }
        }
      }
    }

    // 5. Emoji spam
    if (settings.emojiFilter) {
      const emoteCount   = node.querySelectorAll('[data-emote-id]').length;
      const unicodeCount = (text.match(/\p{Emoji_Presentation}/gu) || []).length;
      if (emoteCount + unicodeCount >= (settings.emojiThreshold || 10)) {
        node.classList.add('ka-emoji-spam');
        return;
      }
    }

    // 6. Favorite user
    if (settings.favEnabled && (settings.favList || []).length) {
      if (settings.favList.some(u => u && norm(u) === username)) {
        node.classList.add('ka-fav-msg');
        const color = userBtn?.style?.color;
        if (color) node.style.setProperty('--ka-fav-color', color);
      }
    }

    // 7. Keyword highlight
    if (settings.keywordEnabled && (settings.keywordList || []).length) {
      for (const kw of settings.keywordList) {
        if (kw && matchesWord(text, kw)) {
          node.classList.add('ka-keyword');
          break;
        }
      }
    }

    // 8. Tag/mention notification
    if (settings.tagEnabled && settings.tagUsername && isNew) {
      const me = norm(settings.tagUsername);
      if (me && text.toLowerCase().includes(me)) {
        node.classList.add('ka-mention');
        if (canNotify('tag')) {
          try {
            chrome.runtime.sendMessage({
              type: 'CHAT_TAG_NOTIFICATION',
              channel: slug,
              fromUser: username,
              message: text.substring(0, 200),
            });
          } catch (_) {}
        }
      }
    }

    // 9. Broadcaster message notification (username matches channel slug)
    if (settings.broadcasterNotif && isNew) {
      const rawUser = (userBtn?.textContent?.trim() || '').toLowerCase();
      if (rawUser && (rawUser === slug || username === norm(slug))) {
        if (canNotify('broadcaster')) {
          try {
            chrome.runtime.sendMessage({
              type: 'CHAT_BROADCASTER_NOTIFICATION',
              channel: slug,
              fromUser: rawUser,
              message: text.substring(0, 200),
            });
          } catch (_) {}
        }
      }
    }
  }

  // ─── Observer ───
  function startObserver(root) {
    chatObs && chatObs.disconnect();
    chatRoot = root;

    chatObs = new MutationObserver(mutations => {
      const recycled = new Set();
      const added    = new Set();

      for (const mut of mutations) {
        if (mut.type === 'attributes') {
          if (mut.target && mut.target.hasAttribute && mut.target.hasAttribute('data-index')) {
            recycled.add(mut.target);
          }
        } else {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.hasAttribute && node.hasAttribute('data-index')) {
              added.add(node);
            } else {
              const parent = node.closest && node.closest(MSG_SEL);
              if (parent) {
                added.add(parent);
              } else if (node.querySelectorAll) {
                node.querySelectorAll(MSG_SEL).forEach(n => added.add(n));
              }
            }
          }
        }
      }

      recycled.forEach(n => { if (!added.has(n)) processMessage(n, false); });
      added.forEach(n => processMessage(n, true));
    });

    chatObs.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-index'],
    });

    root.querySelectorAll(MSG_SEL).forEach(n => processMessage(n, false));
    console.debug('[KickAlert Chat] observer started on ' + slug);
  }

  function waitForChat(cb) {
    const el = document.querySelector(CHAT_ROOT);
    if (el) { cb(el); return; }
    const obs = new MutationObserver(() => {
      const found = document.querySelector(CHAT_ROOT);
      if (found) { obs.disconnect(); cb(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function reprocessAll() {
    dupMap.clear();
    if (chatRoot) {
      // Defensive: remove ALL our classes from every node FIRST, then re-evaluate.
      // Prevents stale ka-emoji-spam / ka-blur from lingering when a switch is turned off
      // while virtual-scroll DOM nodes are off-screen or detached.
      chatRoot.querySelectorAll(MSG_SEL).forEach(n => {
        n.classList.remove(
          'ka-hide-bot', 'ka-hide-user', 'ka-hide-word', 'ka-hide-dup',
          'ka-blur', 'ka-emoji-spam', 'ka-fav-msg', 'ka-keyword', 'ka-mention'
        );
        n.style.removeProperty('--ka-fav-color');
      });
      chatRoot.querySelectorAll(MSG_SEL).forEach(n => processMessage(n, false));
    }
  }

  function disable() {
    const html = document.documentElement;
    html.classList.remove('ka-chat-active');
    chatObs && chatObs.disconnect();
    chatObs = null;
    if (chatRoot) {
      chatRoot.querySelectorAll(MSG_SEL).forEach(node => {
        node.classList.remove(
          'ka-hide-bot', 'ka-hide-user', 'ka-hide-word', 'ka-hide-dup',
          'ka-blur', 'ka-emoji-spam', 'ka-fav-msg', 'ka-keyword', 'ka-mention'
        );
        node.style.removeProperty('--ka-fav-color');
      });
    }
  }

  function activate() {
    injectStyles();
    document.documentElement.classList.add('ka-chat-active');
    waitForChat(startObserver);
  }

  // Listen for settings changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.chatIntegrationEnabled && !changes.chatSettings) return;
    console.debug('[KickAlert Chat] settings changed, reprocessing');
    try {
      loadSettings(() => {
        if (!enabled) {
          disable();
          return;
        }
        injectStyles();
        document.documentElement.classList.add('ka-chat-active');
        if (!chatRoot || !document.contains(chatRoot)) {
          waitForChat(startObserver);
        } else {
          reprocessAll();
        }
      });
    } catch (_) {}
  });

  // SPA navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const newSlug = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0].toLowerCase();
    if (NON_CHANNEL.has(newSlug)) return;
    chatObs && chatObs.disconnect();
    chatRoot = null;
    dupMap.clear();
    if (enabled) {
      setTimeout(() => waitForChat(startObserver), 600);
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Init
  loadThrottle();
  loadSettings(() => {
    console.debug('[KickAlert Chat] enabled=' + enabled + ' slug=' + slug);
    if (!enabled) return;
    activate();
  });

})();
