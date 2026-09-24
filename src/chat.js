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
  // v2.5.24: Akıllı bahsedilme sesi modu için - kullanıcı sohbeti alttan
  // ne kadar kaydırmış (aşağıda değilse, en son mesajları kaçırıyor olabilir).
  let isScrolledUp = false;
  const dupMap   = new Map();
  let stylesInjected = false;

  // v2.5.30: Kick'in KENDİ sohbet paneli tam ekran/theater modunda kapalı mı?
  // Mo'Kick'in kodunda GÜVENİLİR bir kaynak olarak kullanılan native
  // data-chat="true/false" özniteliğine dayanıyoruz (tahmin değil, Kick'in
  // kendi React state'inin dışarı yansıttığı GERÇEK bir sinyal). Element
  // bulunamazsa (öznitelik hiç yoksa) güvenli tarafta kalıp "açık" varsayıyoruz.
  function isKickChatHidden() {
    try {
      const el = document.querySelector('[data-chat]');
      return el ? el.getAttribute('data-chat') === 'false' : false;
    } catch (_) {
      return false;
    }
  }

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

  // v2.5.23: Kick'in native "yanıt veriyor" göstergesi — mesajın en üstünde,
  // eğri ok ikonlu bir buton içinde, kime yanıt verildiğini gösterir. Sabit
  // bir CSS class'ına DEĞİL, semantik ve değişmesi daha düşük ihtimalli olan
  // data-ic-icon="ArrowCurveLeft" özniteliğine dayanıyoruz (kullanıcının
  // gerçek Elements çıktısıyla doğrulanmıştır). İlk <span> her zaman
  // ORİJİNAL (yanıtlanan) mesajın sahibinin kullanıcı adını taşıyor.
  function getReplyTargetUsername(node) {
    try {
      const icon = node.querySelector('svg[data-ic-icon="ArrowCurveLeft"]');
      if (!icon) return null;
      const btn = icon.closest('button');
      const nameSpan = btn && btn.querySelector('span.ml-1 > span');
      return nameSpan ? norm(nameSpan.textContent) : null;
    } catch (_) {
      return null;
    }
  }

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
        mentionSoundSmart: false, // v2.5.24: false = her zaman çal (mevcut davranış korunuyor)
        mentionSoundEnabled: true, // v2.5.27: true = ses de çalsın (mevcut davranış korunuyor)
        showPopupNotification: true, // v2.5.30: true = popup göster (mevcut davranış korunuyor)
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
  // v2.5.26: KRİTİK DÜZELTME. Kick'in sohbeti "virtualized" (DOM node'larını
  // geri dönüştüren) bir liste kullanıyor — kullanıcı sohbetin EN ALTINDA
  // (canlı akışı takip ederken, yani "kaydırılmamış" durumda) iken, YENİ bir
  // mesaj genellikle mevcut bir node'un data-index'i değiştirilerek (recycled)
  // gösteriliyor, YENİ bir DOM elementi eklenerek değil. Biz "recycled"
  // node'ları HER ZAMAN isNew=false sayıyorduk — bu da tag/yanıt/yayıncı
  // bildirimlerinin (hepsi isNew şartına bağlı) TAM DA kullanıcının en çok
  // önemsediği anda (sohbeti canlı takip ederken) hiç tetiklenmemesine yol
  // açıyordu. Node başına SON İŞLENEN İÇERİĞİ saklayıp, recycled bir node
  // GERÇEKTEN FARKLI bir mesaj içeriyorsa bunu YENİ MESAJ sayıyoruz.
  const lastSeenContent = new WeakMap();

  function processMessage(node, isNew, isPriming) {
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

    // v2.5.26: recycled (isNew=false) bir node'un içeriği, o node için EN SON
    // gördüğümüzden FARKLIYSA, bu aslında yeni bir mesajdır — isNew'ı buna
    // göre düzeltiyoruz. PRIMING modunda (ilk toplu tarama) bu kontrol
    // ATLANIR — aksi halde lastSeenContent boş olduğu için TÜM mevcut
    // (eski) mesajlar yanlışlıkla "yeni" sayılırdı.
    const contentKey = username + '\u0001' + text;
    if (!isPriming && !isNew && lastSeenContent.get(node) !== contentKey) {
      isNew = true;
    }
    lastSeenContent.set(node, contentKey);

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

    // 8. Tag/mention notification (+ v2.5.23: birine YANIT olarak gelen
    // mesajlar da aynı şekilde bildiriliyor — Mo'Kick'te de aynı davranış var)
    if (settings.tagEnabled && settings.tagUsername && isNew) {
      const me = norm(settings.tagUsername);
      const isTextMention = me && text.toLowerCase().includes(me);
      const replyTarget = getReplyTargetUsername(node);
      const isReplyToMe = me && replyTarget === me;
      if (isTextMention || isReplyToMe) {
        node.classList.add('ka-mention');
        if (canNotify('tag')) {
          try {
            chrome.runtime.sendMessage({
              type: 'CHAT_TAG_NOTIFICATION',
              channel: slug,
              fromUser: username,
              message: text.substring(0, 200),
              isReply: isReplyToMe && !isTextMention,
              tabHidden: document.hidden,
              chatScrolledUp: isScrolledUp,
              chatHidden: isKickChatHidden(),
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
              tabHidden: document.hidden,
              chatScrolledUp: isScrolledUp,
              chatHidden: isKickChatHidden(),
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

    // v2.5.24: Sohbetin alttan uzaklığını izle - akıllı bahsedilme sesi
    // modu için. Basit bir eşik (100px) kullanıyoruz, hassas bir ölçüm
    // gerekmiyor, sadece "kullanıcı en son mesajları takip ediyor mu" sinyali.
    const SCROLL_THRESHOLD = 100;
    root.addEventListener('scroll', () => {
      const distanceFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight;
      isScrolledUp = distanceFromBottom > SCROLL_THRESHOLD;
    }, { passive: true });

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

    // v2.5.26: İlk toplu tarama, PRIMING modunda (3. parametre) çağrılıyor —
    // yoksa lastSeenContent boş olduğu için TÜM mevcut (eski) mesajlar
    // yanlışlıkla "yeni mesaj" sayılıp bildirim yağmuruna yol açardı.
    root.querySelectorAll(MSG_SEL).forEach(n => processMessage(n, false, true));
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

  // v2.5.12: SPA navigasyon tespiti — eskiden document.body'nin TÜM alt
  // ağacını (subtree:true), sayfa açık olduğu sürece HİÇ DURMADAN izleyen
  // bir MutationObserver kullanıyorduk, sadece URL değişip değişmediğini
  // kontrol etmek için. Bu, Kick'in kendi React uygulamasının YOĞUN DOM
  // değişikliği yaptığı anlarda (örn. yayın kapanışı — oynatıcı kaldırılıp
  // "offline" kapağı eklenirken) gereksiz ek yük bindiriyor olabilirdi —
  // tam da kullanıcının "yayın kapanınca oynatıcı takılı kalıyor" raporuyla
  // aynı zamanlamada. Artık History API'sini doğrudan kancalayan, DOM'a hiç
  // dokunmayan bir yönteme geçiyoruz (adblock-worker-hook.js'te zaten
  // kullandığımız aynı desen) — sıfır sürekli DOM izleme maliyeti.
  let lastUrl = location.href;
  function checkSpaNavigation() {
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
  }
  try {
    ['pushState', 'replaceState'].forEach(m => {
      const orig = history[m];
      if (typeof orig === 'function') {
        history[m] = function () {
          const r = orig.apply(this, arguments);
          try { checkSpaNavigation(); } catch (e) {}
          return r;
        };
      }
    });
    window.addEventListener('popstate', checkSpaNavigation);
  } catch (e) {}

  // Init
  loadThrottle();
  loadSettings(() => {
    console.debug('[KickAlert Chat] enabled=' + enabled + ' slug=' + slug);
    if (!enabled) return;
    activate();
  });

})();
