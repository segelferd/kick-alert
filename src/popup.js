/**
 * KickAlert - Popup Script
 * Handles popup UI: tabs, channel cards, toggles, history.
 * Bell button (3-state): main sound / sub sound / silent
 * © 2025 Segelferd. All rights reserved.
 */

// v2.3.1 Plan E: Production log temizliği. Aç/kapat:
//   chrome.storage.local.set({ _debugMode: true })
let DEBUG_MODE = false;
chrome.storage.local.get(['_debugMode']).then(r => { DEBUG_MODE = !!r._debugMode; }).catch(() => {});
function dbg(...args) { if (DEBUG_MODE) console.debug(...args); }

let allChannels = [];
let autoRefreshTimer = null;

// Bell icon states
const BELL_STATES = ['main', 'sub', 'silent', 'muted'];
const BELL_ICONS = { main: 'notifications_active', sub: 'notifications', silent: 'notifications_off', muted: 'block' };
const BELL_COLORS = { main: '#53FC18', sub: '#f0883e', silent: 'var(--text-muted)', muted: '#eb0400' };
const BELL_TITLES = { main: 'bellMain', sub: 'bellSub', silent: 'bellSilent', muted: 'bellMuted' };

// ─── Init ───

document.addEventListener('DOMContentLoaded', async () => {
  await applyTheme();
  await Utils.initI18n();
  setupI18n();
  applyOptionsI18n();   // Translate #options-panel + #chat-panel + tab buttons on first load (v2.0.1)
  setupTabs();
  setupMenu();
  setupSearch();
  setupFollowSortBar();
  setupHistoryClear();
  setupRateLink();
  await updateChatTabVisibility();
  await loadChatSettings();
  setupChatHandlers();
  await loadChannels();
  await loadHistory();
  await updateMenuState();
  await startAutoRefresh();
});

async function updateChatTabVisibility() {
  const chatEnabled = await Storage.getChatIntegrationEnabled();
  const chatBtn = document.getElementById('chat-btn');
  if (chatBtn) {
    chatBtn.style.display = chatEnabled ? '' : 'none';
    if (chatEnabled) chatBtn.textContent = Utils.i18n('chatTab') || 'Chat';
  }
}

async function applyTheme() {
  const theme = await Storage.getTheme();
  document.documentElement.setAttribute('data-theme', theme);
}

function setupI18n() {
  setText('following-btn', Utils.i18n('following'));
  setText('autolaunch-btn', Utils.i18n('autoLaunchTab'));
  setText('history-btn', Utils.i18n('history'));
  setTitle('suspend-chip', Utils.i18n('autoLaunchButtonTooltip'));
  setTitle('dup-guard-chip', Utils.i18n('duplicateTabGuardButtonTooltip'));
  setTitle('refresh-chip', Utils.i18n('refreshButtonTooltip'));
  setTitle('option-chip', Utils.i18n('optionsButtonTooltip'));
  const searchInput = document.getElementById('autolaunch-search');
  if (searchInput) searchInput.placeholder = Utils.i18n('searchChannels');
}

function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }
function setTitle(id, text) { const el = document.getElementById(id); if (el) el.title = text; }

// ─── Tabs ───

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab)?.classList.add('active');

      // Chat tab: detect active channel from browser tabs
      if (btn.dataset.tab === 'chat-panel') {
        detectActiveChannel();
        loadChatSettings();
      }
    });
  });
}

async function detectActiveChannel() {
  const statusEl = document.getElementById('chat-status');
  if (!statusEl) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (!activeTab || !activeTab.url) {
      statusEl.innerHTML = `<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;">info</span> <span>${Utils.i18n('chatNoChannel') || 'No active Kick channel'}</span>`;
      return;
    }
    // Parse Kick URL
    const match = activeTab.url.match(/^https:\/\/kick\.com\/([a-zA-Z0-9_-]+)(?:\/|$|\?)/);
    const excluded = ['browse', 'categories', 'following', 'dashboard', 'signup',
                      'login', 'help', 'community-guidelines', 'terms', 'privacy',
                      'subscriptions', 'wallet', 'settings', 'search', 'vods',
                      'clips', 'channels', 'home', 'api', 'events', 'watch'];
    if (!match || excluded.includes(match[1].toLowerCase())) {
      statusEl.innerHTML = `<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;color:#f0a500;">warning</span> <span>${Utils.i18n('chatNoChannel') || 'No active Kick channel'}</span>`;
      return;
    }
    const slug = match[1];
    statusEl.innerHTML = `<span class="material-icons-outlined" style="font-size:14px;vertical-align:middle;color:#53FC18;">check_circle</span> <span>${Utils.i18n('chatActiveChannel') || 'Active channel'}: <b style="color:#53FC18">${esc(slug)}</b></span>`;
  } catch (e) {
    console.warn('[KickAlert] detectActiveChannel error:', e);
  }
}

// ─── Menu ───

function setupMenu() {
  document.getElementById('refresh-chip')?.addEventListener('click', async () => {
    // v2.2.1: Manuel refresh → backoff'u sıfırla, anında fresh fetch
    // VPN açıp düzelttikten sonra kullanıcı yeniden çalıştırabilir
    try { await chrome.runtime.sendMessage({ type: 'RESET_BACKOFF' }); } catch {}
    await loadChannels();
    await loadHistory();
  });
  document.getElementById('multi-chip')?.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('html/multistream.html') });
  });
  document.getElementById('option-chip')?.addEventListener('click', () => showOptionsPanel());
  document.getElementById('options-back')?.addEventListener('click', () => hideOptionsPanel());
  document.getElementById('suspend-chip')?.addEventListener('click', async () => {
    const cur = await Storage.getSuspendFromDate();
    if (cur) {
      await Storage.remove(StorageKeys.SUSPEND_FROM_DATE);
    } else {
      await Storage.setSuspendFromDate(new Date().toISOString());
    }
    await updateMenuState();
  });
  document.getElementById('dup-guard-chip')?.addEventListener('click', async () => {
    const cur = await Storage.isDuplicateTabGuard();
    await Storage.setDuplicateTabGuard(!cur);
    await updateMenuState();
  });
}

async function updateMenuState() {
  const suspended = !!(await Storage.getSuspendFromDate());
  const dupGuard = await Storage.isDuplicateTabGuard();

  const sChip = document.getElementById('suspend-chip');
  const sIcon = document.getElementById('suspend-icon');
  const sStatus = document.getElementById('suspend-status');
  if (sIcon) sIcon.textContent = suspended ? 'pause' : 'play_arrow';
  if (sChip) { sChip.classList.remove('on', 'off'); sChip.classList.add(suspended ? 'off' : 'on'); }
  if (sStatus) sStatus.textContent = suspended ? 'OFF' : 'ON';

  const dChip = document.getElementById('dup-guard-chip');
  const dIcon = document.getElementById('dup-guard-icon');
  const dStatus = document.getElementById('dup-guard-status');
  if (dIcon) dIcon.textContent = dupGuard ? 'tab' : 'tab_unselected';
  if (dChip) { dChip.classList.remove('on', 'off'); dChip.classList.add(dupGuard ? 'on' : 'off'); }
  if (dStatus) dStatus.textContent = dupGuard ? 'ON' : 'OFF';

  await chrome.action.setBadgeBackgroundColor({
    color: await Storage.isDndActive() ? '#eb0400' : suspended ? '#606060' : '#53FC18'
  });
}

// ─── Load Channels ───

// v2.2.1: 401 (auth) vs 403 (Cloudflare/IP block) ayrımı için error parser
function _pickFetchErrorKey(errorMsg) {
  // background.js error: "AUTH_REQUIRED: API 401" veya "AUTH_REQUIRED: API 403"
  if (typeof errorMsg === 'string' && /AUTH_REQUIRED:\s*API\s*403/i.test(errorMsg)) {
    return 'fetchErrorBlocked';
  }
  return 'fetchError'; // default: 401 veya bilinmeyen hata → "Kick'e giriş yap"
}

async function loadChannels() {
  showLoading(true);
  dbg('[KickAlert] loadChannels start');
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CHANNELS' });
    dbg('[KickAlert] GET_CHANNELS response:', {
      success: res?.success,
      channelCount: res?.channels?.length,
      fromCache: res?.fromCache,
      error: res?.error,
    });
    if (res?.success) {
      allChannels = res.channels;
      dbg(`[KickAlert] allChannels set: ${allChannels.length} total, ${allChannels.filter(c => c.isLive).length} live`);
      await renderFollowing();
      await renderAutoLaunch();
      showLoading(false);

      // If we got stale cache, fetch fresh data in background
      if (res.fromCache) {
        try {
          const freshRes = await chrome.runtime.sendMessage({ type: 'GET_CHANNELS_FRESH' });
          if (freshRes?.success && freshRes.channels) {
            allChannels = freshRes.channels;
            await renderFollowing();
            await renderAutoLaunch();
          }
        } catch {}
      }
    } else {
      console.warn(`[KickAlert] GET_CHANNELS failed: ${res?.error || 'unknown'}`);
      showMsg('following-list', Utils.i18n(_pickFetchErrorKey(res?.error)));
      showLoading(false);
    }
  } catch (e) {
    console.warn(`[KickAlert] loadChannels exception: ${e?.message}`);
    showMsg('following-list', Utils.i18n(_pickFetchErrorKey(e?.message)));
    showLoading(false);
  }
}

function showLoading(v) {
  const el = document.getElementById('loading-overlay');
  if (el) el.style.display = v ? 'flex' : 'none';
}

function showMsg(id, msg) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = `<div class="empty-state">${esc(msg)}</div>`;
}

// ─── Following Tab ───

async function renderFollowing(categoryFilter) {
  const el = document.getElementById('following-list');
  if (!el) return;

  const showOffline = await Storage.getShowOfflineChannels();
  const favs = await Storage.getFavoriteChannels();
  const groupMap = await Storage.getChannelGroupMap();
  let list = showOffline ? allChannels : allChannels.filter(c => c.isLive);
  dbg(`[KickAlert] renderFollowing: allChannels=${allChannels?.length}, showOffline=${showOffline}, after filter=${list.length}`);

  // Kategori filtresi
  if (categoryFilter) {
    list = list.filter(c => c.categoryName === categoryFilter);
    dbg(`[KickAlert] After category filter '${categoryFilter}': ${list.length}`);
  } else {
    // Grup filtresi
    const activeGroup = document.querySelector('.group-chip.active')?.dataset.group || '__all__';
    if (activeGroup !== '__all__' && !activeGroup.startsWith('__cat__')) {
      list = list.filter(c => groupMap[c.channelSlug] === activeGroup);
      dbg(`[KickAlert] After group filter '${activeGroup}': ${list.length}`);
    }
  }

  // Build group filter bar
  await buildGroupFilterBar();

  if (list.length === 0) {
    dbg(`[KickAlert] List EMPTY — showing noLiveStreams message`);
    el.innerHTML = `<div class="empty-state">${Utils.i18n('noLiveStreams')}</div>`;
    return;
  }

  // v2.3.5: Kullanıcı sıralama tercihi (canlı + favori önceliği KORUNUR)
  const sortPref = await Storage.getFollowSort();
  const dirMul = sortPref.dir === 'desc' ? -1 : 1;
  // Kick API sırası için orijinal indeksi sakla (sort'tan önce)
  const origIdx = new Map(list.map((c, i) => [c.channelSlug, i]));

  list.sort((a, b) => {
    // 1. seviye: canlı kanallar her zaman önce
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    // 2. seviye: favori kanallar her zaman önce
    const aFav = favs[a.channelSlug] ? 1 : 0;
    const bFav = favs[b.channelSlug] ? 1 : 0;
    if (aFav !== bFav) return bFav - aFav;
    // 3. seviye: kullanıcının seçtiği kriter
    switch (sortPref.by) {
      case 'alphabetic':
        return dirMul * a.userUsername.localeCompare(b.userUsername);
      case 'liveTime': {
        // En yeni canlı yayını üste (desc) veya en eskiyi (asc).
        // Offline kanallarda startedAt yok → 0 farzedilir; zaten 1. seviyede ayrı bloktalar.
        const aT = a.startedAt ? new Date(a.startedAt).getTime() : 0;
        const bT = b.startedAt ? new Date(b.startedAt).getTime() : 0;
        return dirMul * (bT - aT); // desc=yeni üstte; asc için dirMul ters çevirir
      }
      case 'viewers': {
        const aV = a.viewerCount || 0;
        const bV = b.viewerCount || 0;
        return dirMul * (bV - aV); // desc=çok izleyici üstte
      }
      case 'kick':
      default:
        // Kick API'den geldiği orijinal sıra
        return dirMul * (origIdx.get(a.channelSlug) - origIdx.get(b.channelSlug));
    }
  });

  el.innerHTML = '';
  const cardMode = 'detail'; // Compact mod kaldırıldı

  // Batch yükle — her kart için ayrı storage.get yerine tek seferde
  const [favMap, groupMap2, bellMap, groupList, botScoresRes, botScoreAlways] = await Promise.all([
    Storage.getFavoriteChannels(),
    Storage.getChannelGroupMap(),
    Storage.getAllChannelSoundModes(),
    Storage.getChannelGroups(),
    // v2.3.0 Aşama 3: Bot skorlarını background'tan al (Chrome only).
    // Hata olursa ({}) — popup düzeni etkilenmez.
    chrome.runtime.sendMessage({ type: 'GET_BOT_SCORES' }).catch(() => null),
    // v2.3.0: "Her zaman göster" toggle'ı (default false)
    Storage.getBotScoreAlwaysVisible(),
  ]);
  const botScores = (botScoresRes?.success && botScoresRes.scores) ? botScoresRes.scores : {};
  const batchData = { favMap, groupMap: groupMap2, bellMap, groupList, botScores, botScoreAlways };

  for (const ch of list) el.appendChild(await channelCard(ch, cardMode, batchData));
}

async function buildGroupFilterBar() {
  const bar = document.getElementById('group-filter-bar');
  if (!bar) return;
  const groups = await Storage.getChannelGroups();

  // Canlı kanallardan benzersiz kategorileri topla
  const liveCategories = [...new Set(
    allChannels
      .filter(c => c.isLive && c.categoryName)
      .map(c => c.categoryName)
  )].slice(0, 5); // Max 5 kategori chip

  if (groups.length === 0 && liveCategories.length === 0) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = 'flex';
  const activeGroup = bar.querySelector('.group-chip.active')?.dataset.group || '__all__';

  bar.innerHTML = '';
  // "All" chip
  const allChip = document.createElement('button');
  allChip.className = `group-chip ${activeGroup === '__all__' ? 'active' : ''}`;
  allChip.dataset.group = '__all__';
  allChip.textContent = Utils.i18n('groupAll');
  allChip.addEventListener('click', () => { setActiveGroup('__all__'); });
  bar.appendChild(allChip);

  for (const g of groups) {
    const chip = document.createElement('button');
    chip.className = `group-chip ${activeGroup === g ? 'active' : ''}`;
    chip.dataset.group = g;
    chip.textContent = g;
    chip.addEventListener('click', () => { setActiveGroup(g); });
    bar.appendChild(chip);
  }

  // Kategori chip'leri — ayırıcı + canlı kategoriler
  if (liveCategories.length > 0) {
    if (groups.length > 0) {
      const sep = document.createElement('span');
      sep.className = 'group-chip-sep';
      bar.appendChild(sep);
    }
    for (const cat of liveCategories) {
      const chip = document.createElement('button');
      chip.className = `group-chip category-chip ${activeGroup === '__cat__' + cat ? 'active' : ''}`;
      chip.dataset.group = '__cat__' + cat;
      chip.dataset.category = cat;
      chip.textContent = cat;
      chip.addEventListener('click', () => { setActiveGroup('__cat__' + cat); });
      bar.appendChild(chip);
    }
  }
}

function setActiveGroup(group) {
  document.querySelectorAll('.group-chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`.group-chip[data-group="${group}"]`)?.classList.add('active');
  renderFollowing(group.startsWith('__cat__') ? group.replace('__cat__', '') : null);
}

// ─── Auto Launch Tab ───

async function renderAutoLaunch() {
  const el = document.getElementById('autolaunch-list');
  if (!el) return;

  if (allChannels.length === 0) {
    el.innerHTML = `<div class="empty-state">${Utils.i18n('noLiveStreams')}</div>`;
    return;
  }

  const sorted = [...allChannels].sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return 0;
  });

  el.innerHTML = '';
  const alCardMode = 'detail';
  const [alFavMap, alGroupMap, alBellMap, alGroupList] = await Promise.all([
    Storage.getFavoriteChannels(),
    Storage.getChannelGroupMap(),
    Storage.getAllChannelSoundModes(),
    Storage.getChannelGroups(),
  ]);
  const alBatch = { favMap: alFavMap, groupMap: alGroupMap, bellMap: alBellMap, groupList: alGroupList };
  for (const ch of sorted) el.appendChild(await autoLaunchCard(ch, alCardMode, alBatch));
}

// ─── Bell Button Helper ───

function createBellButton(slug, currentMode) {
  const btn = document.createElement('button');
  btn.className = 'card-action-btn bell-btn';
  btn.dataset.slug = slug;
  btn.dataset.mode = currentMode;
  btn.title = Utils.i18n(BELL_TITLES[currentMode]);
  btn.innerHTML = `<span class="material-icons">${BELL_ICONS[currentMode]}</span>`;
  btn.querySelector('.material-icons').style.color = BELL_COLORS[currentMode];

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const curIdx = BELL_STATES.indexOf(btn.dataset.mode);
    const nextMode = BELL_STATES[(curIdx + 1) % BELL_STATES.length];
    btn.dataset.mode = nextMode;
    btn.title = Utils.i18n(BELL_TITLES[nextMode]);
    const icon = btn.querySelector('.material-icons');
    icon.textContent = BELL_ICONS[nextMode];
    icon.style.color = BELL_COLORS[nextMode];
    await Storage.setChannelSoundMode(slug, nextMode);
    // Sync bell buttons in both tabs
    syncBellButtons(slug, nextMode);
  });

  return btn;
}

function syncBellButtons(slug, mode) {
  document.querySelectorAll(`.bell-btn[data-slug="${slug}"]`).forEach(btn => {
    btn.dataset.mode = mode;
    btn.title = Utils.i18n(BELL_TITLES[mode]);
    const icon = btn.querySelector('.material-icons');
    icon.textContent = BELL_ICONS[mode];
    icon.style.color = BELL_COLORS[mode];
  });
}

// ─── Channel Card (Following Tab) ───

async function channelCard(ch, cardMode, batch) {
  cardMode = cardMode || 'detail';
  const card = document.createElement('div');
  card.className = `channel-card ${ch.isLive ? 'live' : 'offline'} ${cardMode}-card`;
  const isFav = batch ? !!(batch.favMap?.[ch.channelSlug]) : await Storage.isFavoriteChannel(ch.channelSlug);
  const chGroup = batch ? (batch.groupMap?.[ch.channelSlug] || null) : await Storage.getChannelGroup(ch.channelSlug);
  const groupBadge = chGroup ? `<span class="channel-group-badge">${esc(chGroup)}</span>` : '';

  const pic = ch.profilePic || '../images/default-profile-pictures/default.jpeg';
  let meta = '';

  // Offline kart için son yayın bilgisi
  let lastSeenLabel = '';
  if (!ch.isLive) {
    try {
      const hist = await Storage.getNotificationHistory();
      const last = hist?.find(e => e.channelSlug === ch.channelSlug);
      if (last) lastSeenLabel = Utils.formatTimestamp(last.timestamp);
    } catch {}
  }

  // Sparkline — isLive bloğu dışında tanımla, offline kartlarda da scope'da olsun
  const sparkline = ch.isLive ? await buildSparkline(ch.channelSlug) : '';
  // v2.3.0: Bot skor (sparkline yanına) — isLive bloğunda set edilir, action row'da kullanılır
  let botScoreInSparkRow = '';
  // v2.3.0: Sparkline çerçeve durumu — spike (yeşil), drop (kırmızı), yoksa nötr
  let sparklineFrame = ''; // '', 'spike', 'spike-alert', 'drop', 'drop-alert'

  if (ch.isLive) {
    const dur = Utils.formatDuration(ch.startedAt);
    const viewers = Utils.formatViewers(ch.viewerCount);
    const anomalySettings = await Storage.getAnomalySettings();
    const anomaly = anomalySettings.enabled
      ? await getViewerAnomaly(ch.channelSlug, ch.viewerCount, ch.startedAt)
      : null;
    const drop = (anomalySettings.enabled && anomalySettings.dropEnabled)
      ? await getViewerDrop(ch.channelSlug, ch.viewerCount, ch.startedAt)
      : null;

    const anomalyBadge = (anomaly && cardMode !== 'compact')
      ? `<span class="viewer-anomaly viewer-anomaly-${anomaly.level}">↑+${anomaly.pct}%</span>`
      : (drop && cardMode !== 'compact')
      ? `<span class="viewer-anomaly viewer-anomaly-drop-${drop.level}">↓-${drop.pct}%</span>`
      : '';

    // v2.3.0: Sparkline çerçevesini spike/drop rengine göre set et
    // Spike → yeşil çerçeve, Drop → kırmızı çerçeve, Normal → nötr (silik gri)
    if (anomaly) sparklineFrame = `spike-${anomaly.level}`;
    else if (drop) sparklineFrame = `drop-${drop.level}`;

    // v2.3.0 Aşama 3: Bot skoru rozeti
    // Yetersiz veri (insufficient/null) → görünmez (Karar A — yetersiz veri).
    // 3 renk: 0-30 kırmızı, 30-70 sarı, 70-100 yeşil.
    // Format: "smart_toy 28%" (Karar B — yüzde işaretli).
    //
    // v2.3.0 Yerleşim mantığı (Patron'un seçtiği):
    //   alwaysVisible AÇIK   → Sparkline'ın yanında, butonların solunda (her zaman aynı yer)
    //   alwaysVisible KAPALI → Sadece anomaly varsa, anomaly satırının sonunda
    let botScoreBadge = '';        // anomaly satırı için
    // botScoreInSparkRow zaten dış scope'ta tanımlı — burada sadece atama
    const botData = batch?.botScores?.[ch.channelSlug];
    const alwaysVisible = !!batch?.botScoreAlways;

    if (botData && typeof botData.score === 'number' && cardMode !== 'compact') {
      const score = botData.score;
      // v2.3.0: 5 tier renk (streamscharts skalası)
      const tier = score < 20 ? 'very-low'
        : score < 40 ? 'low'
        : score < 60 ? 'medium'
        : score < 80 ? 'high'
        : 'very-high';
      const tooltip = (Utils.i18n('botScoreTooltip', [String(score)]) || `Bot suspicion score: ${score}%`)
        + (typeof botData.msgPerMin === 'number'
            ? ` (${botData.msgPerMin}/min, ${botData.activeChatters} chatters)`
            : '');
      const badgeHTML = `<span class="bot-score bot-score-${tier}" title="${esc(tooltip)}">`
        + `<span class="material-icons bot-score-icon">smart_toy</span>`
        + `<span class="bot-score-value">${score}%</span>`
        + `</span>`;

      if (alwaysVisible) {
        // Switch açık → sparkline satırı, butonların solunda (her kanalda)
        botScoreInSparkRow = badgeHTML;
      } else if (anomaly) {
        // Switch kapalı + spike var → anomaly satırı sonu
        // NOT: Drop sırasında bot skoru gösterilmez. Drop = izleyici düşüşü
        // demek, bot trafiği zaten azalıyor. Bot skoru drop sırasında
        // anlamsız çünkü chatter sayısı da düşmüş, "iyileşmiş" görünür.
        botScoreBadge = badgeHTML;
      }
      // Switch kapalı + drop var → bot skoru gizli
      // Switch kapalı + anomaly yok → hiç gösterme
    }

    const anomalyNote = (anomaly && cardMode !== 'compact')
      ? `<div class="anomaly-row ${anomaly.level}">↑ ${anomaly.label} ${anomalyBadge}${botScoreBadge}</div>`
      : (drop && cardMode !== 'compact')
      ? `<div class="anomaly-row drop-${drop.level}">↓ ${drop.label} ${anomalyBadge}${botScoreBadge}</div>`
      : '';

    meta = `<div class="channel-meta">
      <span class="rec-indicator"><span class="rec-dot"></span></span>
      <span class="stream-duration" data-slug="${esc(ch.channelSlug)}">${esc(dur)}</span>
      <span class="meta-separator">·</span>
      <span class="viewer-count">${esc(viewers)}</span>
      ${ch.categoryName ? `<span class="meta-separator">·</span><span class="category-name marquee-text" title="${esc(ch.categoryName)}"><span class="marquee-inner">${esc(ch.categoryName)}</span></span>` : ''}
    </div>${anomalyNote}`;
  }

  card.innerHTML = `
    <div class="card-top">
      <img class="channel-avatar" src="${esc(pic)}" alt="" />
      <div class="channel-info">
        <div class="channel-name" title="${esc(ch.userUsername)}">${esc(ch.userUsername)}${groupBadge}</div>
        ${ch.isLive ? `<div class="channel-title marquee-text" title="${esc(ch.sessionTitle || '-')}"><span class="marquee-inner">${esc(ch.sessionTitle || '-')}</span></div>` : (lastSeenLabel ? `<div class="offline-last-seen">${Utils.i18n('lastStream') || 'Last stream'}: ${esc(lastSeenLabel)}</div>` : '')}
        ${meta}
      </div>
    </div>
    ${ch.isLive && ch.thumbnailUrl ? `<img class="channel-thumbnail" src="${esc(ch.thumbnailUrl)}" alt="" loading="lazy" />` : ''}`;

  // v2.1.0: CSP-safe error handlers (Firefox inline onerror'ı yasaklar)
  const avatarImg = card.querySelector('.channel-avatar');
  if (avatarImg) {
    avatarImg.addEventListener('error', () => {
      avatarImg.src = '../images/default-profile-pictures/default.jpeg';
    }, { once: true });
  }
  const thumbImg = card.querySelector('.channel-thumbnail');
  if (thumbImg) {
    thumbImg.addEventListener('error', () => {
      thumbImg.style.display = 'none';
    }, { once: true });
  }


  // Thumbnail overlay lazy fetch sonrası kurulacak — aşağıda
  // Actions row — always show (live and offline both get star)
  const actions = document.createElement('div');
  actions.className = 'card-actions-row';

  // Sparkline — butonların yanında, sadece live + detail
  if (ch.isLive && cardMode !== 'compact' && sparkline) {
    const sparkWrap = document.createElement('span');
    // v2.3.0: Çerçeve rengi spike/drop durumuna göre
    sparkWrap.className = sparklineFrame
      ? `card-sparkline-wrap card-sparkline-wrap-${sparklineFrame}`
      : 'card-sparkline-wrap';
    sparkWrap.innerHTML = sparkline;
    actions.appendChild(sparkWrap);
  }

  // v2.3.0: Bot skor badge — sparkline'dan sonra, butonlardan önce.
  // Switch açık olduğunda her live kanalda, switch kapalıyken sadece anomaly satırında.
  // Renkler iki veriyi (sparkline çizgisi + badge zemini) zaten ayırıyor — seperatör yok.
  if (ch.isLive && cardMode !== 'compact' && botScoreInSparkRow) {
    const botWrap = document.createElement('span');
    botWrap.className = 'bot-score-action-wrap';
    botWrap.innerHTML = botScoreInSparkRow;
    actions.appendChild(botWrap);
  }

  // Open button — her zaman (live ve offline)
  const openBtn = document.createElement('button');
  openBtn.className = 'card-action-btn open-btn';
  openBtn.title = 'Open channel';
  openBtn.innerHTML = '<span class="material-icons">open_in_new</span>';
  openBtn.addEventListener('click', () => chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}` }));
  actions.appendChild(openBtn);

  if (ch.isLive) {
    // Multi button — sadece live
    const multiBtn = document.createElement('button');
    multiBtn.className = 'card-action-btn multi-btn';
    multiBtn.title = 'Add to Multi-Stream';
    multiBtn.innerHTML = '<span class="material-icons">grid_view</span>';
    multiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addToMultiStream(ch.channelSlug);
      multiBtn.querySelector('.material-icons').style.color = '#f0883e';
    });

    actions.appendChild(multiBtn);
  }

  // Bell button — her zaman (live ve offline)
  const bellMode = batch ? (batch.bellMap?.[ch.channelSlug] || 'silent') : await Storage.getChannelSoundMode(ch.channelSlug);
  const bellBtn = createBellButton(ch.channelSlug, bellMode);
  actions.appendChild(bellBtn);

  // Group assign button — always visible (only if groups exist)
  const groups = batch ? (batch.groupList || []) : await Storage.getChannelGroups();
  if (groups.length > 0) {
    const groupBtn = document.createElement('button');
    groupBtn.className = 'card-action-btn group-btn';
    groupBtn.title = chGroup || Utils.i18n('groupAssign');
    groupBtn.innerHTML = `<span class="material-icons" style="font-size:16px;${chGroup ? 'color:var(--accent)' : ''}">label</span>`;
    groupBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const currentGroup = await Storage.getChannelGroup(ch.channelSlug);
      // Cycle: no group → group1 → group2 → ... → no group
      const idx = currentGroup ? groups.indexOf(currentGroup) : -1;
      const nextIdx = idx + 1;
      const nextGroup = nextIdx < groups.length ? groups[nextIdx] : null;
      await Storage.setChannelGroup(ch.channelSlug, nextGroup);
      // Update badge in card
      const nameEl = card.querySelector('.channel-name');
      const oldBadge = nameEl.querySelector('.channel-group-badge');
      if (oldBadge) oldBadge.remove();
      if (nextGroup) {
        const badge = document.createElement('span');
        badge.className = 'channel-group-badge';
        badge.textContent = nextGroup;
        nameEl.appendChild(badge);
      }
      groupBtn.title = nextGroup || Utils.i18n('groupAssign');
      groupBtn.querySelector('.material-icons').style.color = nextGroup ? 'var(--accent)' : '';
    });
    actions.appendChild(groupBtn);
  }

  // Star/favorite button — always visible
  const starBtn = document.createElement('button');
  starBtn.className = 'card-action-btn star-btn';
  starBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  starBtn.innerHTML = `<span class="material-icons">${isFav ? 'star' : 'star_border'}</span>`;
  starBtn.querySelector('.material-icons').style.color = isFav ? '#f0c040' : '';
  starBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const nowFav = await Storage.toggleFavoriteChannel(ch.channelSlug);
    const icon = starBtn.querySelector('.material-icons');
    icon.textContent = nowFav ? 'star' : 'star_border';
    icon.style.color = nowFav ? '#f0c040' : '';
    starBtn.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
    // Sync star buttons across tabs
    document.querySelectorAll(`.star-btn[data-slug="${ch.channelSlug}"]`).forEach(b => {
      const ic = b.querySelector('.material-icons');
      ic.textContent = nowFav ? 'star' : 'star_border';
      ic.style.color = nowFav ? '#f0c040' : '';
    });
  });
  starBtn.dataset.slug = ch.channelSlug;
  actions.appendChild(starBtn);

  card.appendChild(actions);

  // Karta tıklayınca viewer history modal aç (butonlara tıklama hariç)
  if (ch.isLive) {
    card.style.cursor = 'pointer';
    card.addEventListener('click', (e) => {
      if (e.target.closest('.card-actions-row')) return;
      showViewerHistoryModal(ch);
    });
  }

  // Lazy fetch — startTime
  if (ch.isLive && !ch.startedAt) {
    chrome.runtime.sendMessage({ type: 'GET_CHANNEL_START_TIME', slug: ch.channelSlug }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.success && res.startTime) {
        const durEl = card.querySelector('.stream-duration');
        if (durEl) durEl.textContent = Utils.formatDuration(res.startTime);
      }
    });
  }

  // v2.3.5: Taşan metinleri ölç, sadece gerçekten taşanları kayan yap.
  // DOM'a eklendikten SONRA ölçülmeli (scrollWidth aksi halde 0), o yüzden rAF.
  requestAnimationFrame(() => {
    card.querySelectorAll('.marquee-text').forEach(box => {
      const inner = box.querySelector('.marquee-inner');
      if (!inner) return;
      // Taşma var mı? (içerik kutudan genişse)
      const overflow = inner.scrollWidth - box.clientWidth;
      if (overflow > 2) {
        box.classList.add('is-overflowing');
        // Kayma mesafesi: tam metin görünene kadar (+ küçük tampon)
        box.style.setProperty('--marquee-shift', `-${overflow + 6}px`);
      } else {
        box.classList.remove('is-overflowing');
        box.style.removeProperty('--marquee-shift');
      }
    });
  });

  return card;
}

// ─── Auto Launch Card ───

async function autoLaunchCard(ch, cardMode, batch) {
  const card = document.createElement('div');
  card.className = `channel-card autolaunch-card ${ch.isLive ? 'live' : 'offline'} ${cardMode || 'detail'}-card`;
  const pic = ch.profilePic || '../images/default-profile-pictures/default.jpeg';
  const isAuto = await Storage.isAutoOpenChannel(ch.channelSlug);

  card.innerHTML = `
    <img class="channel-avatar" src="${esc(pic)}" alt="" />
    <div class="channel-info">
      <div class="channel-name">${esc(ch.userUsername)}</div>
      ${ch.isLive
        ? `<div class="channel-meta-inline">
            <span class="rec-indicator"><span class="rec-dot"></span></span>
            <span class="stream-duration">${esc(Utils.formatDuration(ch.startedAt))}</span>
            <span class="meta-separator">·</span>
            <span class="viewer-count">${esc(Utils.formatViewers(ch.viewerCount))}</span>
           </div>`
        : '<div class="offline-label">Offline</div>'}
    </div>`;

  // v2.1.0: CSP-safe avatar fallback
  const avatarImg = card.querySelector('.channel-avatar');
  if (avatarImg) {
    avatarImg.addEventListener('error', () => {
      avatarImg.src = '../images/default-profile-pictures/default.jpeg';
    }, { once: true });
  }


  // v2.3.4: Yıldız (favori) butonu — "Takip Edilenler" sekmesiyle tutarlılık.
  // Aynı .star-btn class + data-slug → iki sekme otomatik senkronize olur.
  const isFav = batch ? !!batch.favMap?.[ch.channelSlug] : await Storage.isFavoriteChannel(ch.channelSlug);
  const starBtn = document.createElement('button');
  starBtn.className = 'card-action-btn star-btn';
  starBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
  starBtn.innerHTML = `<span class="material-icons">${isFav ? 'star' : 'star_border'}</span>`;
  starBtn.querySelector('.material-icons').style.color = isFav ? '#f0c040' : '';
  starBtn.dataset.slug = ch.channelSlug;
  starBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const nowFav = await Storage.toggleFavoriteChannel(ch.channelSlug);
    // Tüm sekmelerdeki aynı slug'lı yıldızları senkronla
    document.querySelectorAll(`.star-btn[data-slug="${ch.channelSlug}"]`).forEach(b => {
      const ic = b.querySelector('.material-icons');
      ic.textContent = nowFav ? 'star' : 'star_border';
      ic.style.color = nowFav ? '#f0c040' : '';
      b.title = nowFav ? 'Remove from favorites' : 'Add to favorites';
    });
  });
  card.appendChild(starBtn);

  // Bell button
  const bellMode = batch ? (batch.bellMap?.[ch.channelSlug] || 'silent') : await Storage.getChannelSoundMode(ch.channelSlug);
  const bellBtn = createBellButton(ch.channelSlug, bellMode);
  card.appendChild(bellBtn);

  // Auto-open toggle
  const toggleLabel = document.createElement('label');
  toggleLabel.className = 'toggle-switch';
  toggleLabel.innerHTML = `<input type="checkbox" ${isAuto ? 'checked' : ''} /><span class="toggle-slider"></span>`;
  card.appendChild(toggleLabel);

  const cb = card.querySelector('input[type="checkbox"]');
  cb.addEventListener('change', e => Storage.setAutoOpenChannel(ch.channelSlug, e.target.checked));

  // Click anywhere on card toggles the switch (except on switch, bell, and star)
  card.addEventListener('click', (e) => {
    if (e.target.closest('.toggle-switch') || e.target.closest('.bell-btn') || e.target.closest('.star-btn')) return;
    cb.checked = !cb.checked;
    cb.dispatchEvent(new Event('change'));
  });

  // Fetch start time if missing
  if (ch.isLive && !ch.startedAt) {
    chrome.runtime.sendMessage({ type: 'GET_CHANNEL_START_TIME', slug: ch.channelSlug }, (res) => {
      if (res?.success && res.startTime) {
        const durEl = card.querySelector('.stream-duration');
        if (durEl) durEl.textContent = Utils.formatDuration(res.startTime);
      }
    });
  }

  return card;
}

// ─── History Tab ───

async function loadHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;

  try {
    const history = await Storage.getNotificationHistory();
    if (!history?.length) {
      el.innerHTML = `<div class="empty-state">${Utils.i18n('noHistoryYet')}</div>`;
      return;
    }
    el.innerHTML = '';

    // Tarih gruplaması
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const yesterday = today - 86400000;
    const thisWeek = today - 6 * 86400000;

    function getGroup(ts) {
      const t = new Date(ts).getTime();
      if (t >= today) return Utils.i18n('historyGroupToday') || 'Today';
      if (t >= yesterday) return Utils.i18n('historyGroupYesterday') || 'Yesterday';
      if (t >= thisWeek) return Utils.i18n('historyGroupThisWeek') || 'Bu Hafta';
      return Utils.i18n('historyGroupOlder') || 'Earlier';
    }

    let lastGroup = null;
    history.forEach(entry => {
      const group = getGroup(entry.timestamp);
      if (group !== lastGroup) {
        const header = document.createElement('div');
        header.className = 'history-group-header';
        header.textContent = group;
        el.appendChild(header);
        lastGroup = group;
      }
      const item = document.createElement('div');
      item.className = 'history-item';
      const pic = entry.profilePic || '../images/default-profile-pictures/default.jpeg';
      item.innerHTML = `
        <img class="history-avatar" src="${esc(pic)}" alt="" />
        <div class="history-body">
          <div class="history-header">
            <span class="history-username">${esc(entry.username)}</span>
            <span class="history-time">${esc(Utils.formatTimestamp(entry.timestamp))}</span>
          </div>
          <div class="history-title">${esc(entry.title)}</div>
          <div class="history-category">${esc(entry.category)}</div>
        </div>`;
      // v2.1.0: CSP-safe avatar fallback
      const histAvatarImg = item.querySelector('.history-avatar');
      if (histAvatarImg) {
        histAvatarImg.addEventListener('error', () => {
          histAvatarImg.src = '../images/default-profile-pictures/default.jpeg';
        }, { once: true });
      }
      item.addEventListener('click', () => chrome.tabs.create({ url: `https://kick.com/${entry.channelSlug}` }));
      el.appendChild(item);
    });
  } catch { el.innerHTML = `<div class="empty-state">${Utils.i18n('errorLoadingHistory')}</div>`; }
}

// ─── Auto Refresh ───

async function startAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
  if (!(await Storage.getAutoRefreshPopup())) return;
  const secs = await Storage.getCheckInterval();
  // Guard: refuse to set interval faster than 10s or invalid values
  const safeSecs = Math.max(10, parseInt(secs, 10) || 60);
  autoRefreshTimer = setInterval(() => loadChannels(), safeSecs * 1000);
}

// ─── Multi-Stream Helper ───

async function addToMultiStream(slug) {
  const result = await chrome.storage.local.get(['multistream']);
  const data = result.multistream || { channels: [], layout: 'side' };
  if (!data.channels.includes(slug)) {
    data.channels.push(slug);
    await chrome.storage.local.set({ multistream: data });
  }
  try {
    const tabs = await chrome.tabs.query({});
    const msTab = tabs.find(t => t.url?.includes('multistream.html'));
    if (msTab) {
      chrome.tabs.update(msTab.id, { active: true });
      chrome.windows.update(msTab.windowId, { focused: true });
      chrome.runtime.sendMessage({ type: 'ADD_TO_MULTISTREAM', slug });
    } else {
      chrome.tabs.create({ url: chrome.runtime.getURL('html/multistream.html') });
    }
  } catch {
    chrome.tabs.create({ url: chrome.runtime.getURL('html/multistream.html') });
  }
}

// ─── Search ───

function setupSearch() {
  const input = document.getElementById('search-input') || document.getElementById('autolaunch-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    ['following-list', 'autolaunch-list'].forEach(listId => {
      document.querySelectorAll(`#${listId} .channel-card`).forEach(card => {
        const name = card.querySelector('.channel-name')?.textContent?.toLowerCase() || '';
        const cat = card.querySelector('.category-name')?.textContent?.toLowerCase() || '';
        card.style.display = (!q || name.includes(q) || cat.includes(q)) ? '' : 'none';
      });
    });
  });
}

// ─── v2.3.5: Follow tab sort bar ───
async function setupFollowSortBar() {
  const bar = document.getElementById('follow-sort-bar');
  if (!bar) return;
  const dirIcon = document.getElementById('sort-dir-icon');

  // Mevcut tercihi UI'a yansıt
  async function refresh() {
    const pref = await Storage.getFollowSort();
    bar.querySelectorAll('.sort-chip[data-sort-by]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.sortBy === pref.by);
    });
    if (dirIcon) {
      dirIcon.textContent = pref.dir === 'desc' ? 'arrow_downward' : 'arrow_upward';
    }
  }
  await refresh();

  // Kriter butonları
  bar.querySelectorAll('.sort-chip[data-sort-by]').forEach(btn => {
    btn.addEventListener('click', async () => {
      await Storage.setFollowSort(btn.dataset.sortBy, null);
      await refresh();
      await renderFollowing();
    });
  });

  // Yön toggle butonu
  const dirBtn = document.getElementById('sort-dir-toggle');
  if (dirBtn) {
    dirBtn.addEventListener('click', async () => {
      const cur = await Storage.getFollowSort();
      await Storage.setFollowSort(null, cur.dir === 'desc' ? 'asc' : 'desc');
      await refresh();
      await renderFollowing();
    });
  }
}

// ─── History Clear ───

function setupHistoryClear() {
  const btn = document.getElementById('history-clear-btn');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await Storage.set(StorageKeys.NOTIFICATION_HISTORY, []);
    await loadHistory();
  });
}

// ─── Rate Link (Chrome vs Firefox) ───

function setupRateLink() {
  const link = document.getElementById('rate-link');
  if (!link) return;
  const manifest = chrome.runtime.getManifest();
  const isFirefox = !manifest.background?.service_worker;
  if (isFirefox) {
    link.href = 'https://addons.mozilla.org/firefox/addon/kickalert/';
  }
}

// ─── Helpers ───

function esc(s) {
  if (!s) return '';
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ─── Inline Options Panel ───

const SUPPORTED_LANGUAGES_REF = typeof SUPPORTED_LANGUAGES !== 'undefined' ? SUPPORTED_LANGUAGES : [];

function showOptionsPanel() {
  document.getElementById('options-panel').style.display = 'block';
  document.querySelector('.menu-container').style.display = 'none';
  document.querySelector('.tabs-container').style.display = 'none';
  document.querySelector('.content-container').style.display = 'none';
  renderLangSelector();
  applyOptionsI18n();
  loadOptionsSettings();
  setupOptionsListeners();
}

async function renderLangSelector() {
  const container = document.getElementById('lang-selector');
  const note = document.getElementById('lang-browser-note');
  const sw = document.getElementById('opt-use-browser-lang');
  if (!container) return;

  const useBrowser = await Storage.getUseBrowserLanguage();

  // Switch durumu
  if (sw) sw.checked = useBrowser;

  // Grid görünürlüğü
  container.style.display = useBrowser ? 'none' : 'grid';

  // Not: sadece switch açıkken göster
  if (note) {
    if (useBrowser) {
      const browserLangName = Utils.getBrowserLangName();
      const noteKey = browserLangName ? 'langBrowserNoteSupported' : 'langBrowserNoteUnsupported';
      const tpl = Utils.i18n(noteKey) || '';
      note.textContent = tpl.replace('$1', browserLangName || '');
      note.style.display = '';
    } else {
      note.style.display = 'none';
    }
  }

  if (useBrowser) return; // grid'e gerek yok

  container.innerHTML = '';
  const currentLang = Utils.getCurrentLang();

  SUPPORTED_LANGUAGES.forEach(lang => {
    const btn = document.createElement('div');
    btn.className = 'lang-item' + (lang.code === currentLang ? ' active' : '');
    btn.title = lang.name;
    btn.innerHTML = `<span class="lang-code">${lang.label}</span><span class="lang-name">${lang.name}</span>`;
    btn.addEventListener('click', async () => {
      await Storage.setUserLanguage(lang.code);
      await Utils.loadLocale(lang.code);
      renderLangSelector();
      applyOptionsI18n();
      setupI18n();
    });
    container.appendChild(btn);
  });
}

function hideOptionsPanel() {
  document.getElementById('options-panel').style.display = 'none';
  document.querySelector('.menu-container').style.display = 'flex';
  document.querySelector('.tabs-container').style.display = 'flex';
  document.querySelector('.content-container').style.display = 'block';
  loadChannels();
}

function applyOptionsI18n() {
  // Versiyon bilgisini manifest'ten dinamik oku
  const verEl = document.getElementById('opt-app-version');
  if (verEl) {
    const v = chrome.runtime.getManifest().version;
    verEl.textContent = 'KickAlert v' + v;
  }

  document.querySelectorAll('#options-panel [data-i18n], #chat-panel [data-i18n], .tab-buttons [data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const sub = el.getAttribute('data-i18n-sub');
    el.textContent = Utils.i18n(key, sub ? [sub] : undefined);
  });
  document.querySelectorAll('#options-panel [data-i18n-html], #chat-panel [data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = Utils.i18n(key);
  });
  document.querySelectorAll('#options-panel [data-i18n-title], #chat-panel [data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = Utils.i18n(key);
  });
  document.querySelectorAll('#options-panel [data-i18n-placeholder], #chat-panel [data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = Utils.i18n(key);
  });
}

async function loadOptionsSettings() {
  optEl('opt-auto-unmute').checked = await Storage.getAutoUnmute();
  optEl('opt-reset-suspend').checked = await Storage.getResetSuspendOnRestart();
  optEl('opt-show-offline').checked = await Storage.getShowOfflineChannels();
  optEl('opt-show-notification').checked = await Storage.getShowNotification();
  optEl('opt-auto-refresh').checked = await Storage.getAutoRefreshPopup();
  // v2.3.0: Bot skorunu her zaman göster (default false)
  optEl('opt-bot-score-always-visible').checked = await Storage.getBotScoreAlwaysVisible();

  const vol = await Storage.getSoundVolume();
  optEl('opt-volume-slider').value = vol;
  optEl('opt-volume-value').textContent = vol;
  optUpdateSliderFill(optEl('opt-volume-slider'));

  const interval = await Storage.getCheckInterval();
  optEl('opt-interval-slider').value = interval;
  optEl('opt-interval-value').textContent = interval;
  optUpdateSliderFill(optEl('opt-interval-slider'));

  await optUpdateSoundStatus('main');
  await optUpdateSoundStatus('sub');

  // Sound mode
  const soundMode = await Storage.getSoundMode();
  optEl('opt-sound-extension').checked = soundMode === 'extension';
  optEl('opt-sound-windows').checked = soundMode === 'windows';
  optUpdateSoundModeVisibility();

  // DND
  optPopulateDndSelects();
  optEl('opt-dnd-enabled').checked = await Storage.getDndEnabled();
  optEl('opt-dnd-start').value = await Storage.getDndStart();
  optEl('opt-dnd-end').value = await Storage.getDndEnd();
  optEl('opt-dnd-mute-notif').checked = await Storage.getDndMuteNotif();
  optEl('opt-dnd-mute-sound').checked = await Storage.getDndMuteSound();
  optEl('opt-dnd-mute-autolaunch').checked = await Storage.getDndMuteAutolaunch();
  optUpdateDndVisibility();

  // Cloud Sync
  // Anomaly settings
  const anomalySettings = await Storage.getAnomalySettings();
  optEl('opt-anomaly-enabled').checked = anomalySettings.enabled;
  optUpdateAnomalyVisibility(anomalySettings.enabled);
  const anomalyMode = anomalySettings.notifyMode || 'both';
  const anomalyModeEl = document.querySelector(`input[name="anomaly-mode"][value="${anomalyMode}"]`);
  if (anomalyModeEl) anomalyModeEl.checked = true;
  const spikeEnabledEl = optEl('opt-anomaly-spike-enabled');
  if (spikeEnabledEl) {
    spikeEnabledEl.checked = anomalySettings.spikeEnabled !== false;
    setSensitivityDisabled('opt-spike-sensitivity-body', !spikeEnabledEl.checked);
  }

  const dropEl = optEl('opt-anomaly-drop-enabled');
  if (dropEl) {
    dropEl.checked = !!anomalySettings.dropEnabled;
    setSensitivityDisabled('opt-drop-sensitivity-body', !dropEl.checked);
  }

  const spikeSlider = optEl('opt-spike-sensitivity-slider');
  if (spikeSlider) { spikeSlider.value = ['min','avg','max'].indexOf(anomalySettings.spikeSensitivity || 'avg'); updateSensitivityFill(spikeSlider, SPIKE_LABELS); }

  const dropSlider = optEl('opt-drop-sensitivity-slider');
  if (dropSlider) { dropSlider.value = ['min','avg','max'].indexOf(anomalySettings.dropSensitivity || 'avg'); updateSensitivityFill(dropSlider, DROP_LABELS); }

  // v2.3.5: Auto-open (tab açma) gecikmesi (slider)
  const autoOpenDelay = await Storage.getAutoOpenDelay();
  const autoOpenDelaySlider = optEl('opt-auto-open-delay-slider');
  if (autoOpenDelaySlider) {
    autoOpenDelaySlider.value = autoOpenDelay;
    optEl('opt-auto-open-delay-value').textContent = autoOpenDelay;
    optUpdateSliderFill(autoOpenDelaySlider);
  }

  optEl('opt-cloud-sync').checked = await Storage.getCloudSyncEnabled();

  // Chat Integration
  const chatEnabled = await Storage.getChatIntegrationEnabled();
  optEl('opt-chat-integration').checked = chatEnabled;
  document.getElementById('chat-btn').style.display = chatEnabled ? '' : 'none';
  await loadChatSettings();

  // Theme
  const theme = await Storage.getTheme();
  document.querySelectorAll('.opt-theme-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === theme);
  });
}

function optPopulateDndSelects() {
  const startSel = optEl('opt-dnd-start');
  const endSel = optEl('opt-dnd-end');
  if (startSel.options.length > 0) return;
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 30) {
      const val = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
      startSel.add(new Option(val, val));
      endSel.add(new Option(val, val));
    }
  }
}

function optUpdateDndVisibility() {
  const on = optEl('opt-dnd-enabled').checked;
  const body = optEl('opt-dnd-body');
  if (body) body.classList.toggle('disabled', !on);
}

function optUpdateSoundModeVisibility() {
  const isExtension = optEl('opt-sound-extension').checked;
  const settings = optEl('opt-extension-sound-settings');
  if (settings) settings.classList.toggle('disabled', !isExtension);
}

let optListenersAttached = false;

function setupOptionsListeners() {
  if (optListenersAttached) return;
  optListenersAttached = true;

  optBind('opt-auto-unmute', v => Storage.setAutoUnmute(v));
  optBind('opt-reset-suspend', v => Storage.setResetSuspendOnRestart(v));
  optBind('opt-show-offline', v => Storage.setShowOfflineChannels(v));
  optBind('opt-show-notification', v => Storage.setShowNotification(v));
  optBind('opt-auto-refresh', v => Storage.setAutoRefreshPopup(v));
  // v2.3.0: Bot skor görünürlüğü değişince popup'ı anında yenile
  optBind('opt-bot-score-always-visible', async (v) => {
    await Storage.setBotScoreAlwaysVisible(v);
    await renderFollowing();
  });

  // Sound mode radio
  optEl('opt-sound-extension').addEventListener('change', () => {
    Storage.setSoundMode('extension');
    optUpdateSoundModeVisibility();
  });
  optEl('opt-sound-windows').addEventListener('change', () => {
    Storage.setSoundMode('windows');
    optUpdateSoundModeVisibility();
  });

  // DND listeners
  optBind('opt-dnd-enabled', v => { Storage.setDndEnabled(v); optUpdateDndVisibility(); });
  optEl('opt-dnd-start').addEventListener('change', e => Storage.setDndStart(e.target.value));
  optEl('opt-dnd-end').addEventListener('change', e => Storage.setDndEnd(e.target.value));
  optBind('opt-dnd-mute-notif', v => Storage.setDndMuteNotif(v));
  optBind('opt-dnd-mute-sound', v => Storage.setDndMuteSound(v));
  optBind('opt-dnd-mute-autolaunch', v => Storage.setDndMuteAutolaunch(v));

  // Anomaly listeners
  optEl('opt-anomaly-enabled').addEventListener('change', async e => {
    const s = await Storage.getAnomalySettings();
    s.enabled = e.target.checked;
    await Storage.setAnomalySettings(s);
    optUpdateAnomalyVisibility(e.target.checked);
    // Background threshold güncelle
    chrome.runtime.sendMessage({ type: 'SET_ANOMALY_SETTINGS', settings: s }).catch(()=>{});
  });
  document.querySelectorAll('input[name="anomaly-mode"]').forEach(radio => {
    radio.addEventListener("change", async () => {
      const s = await Storage.getAnomalySettings();
      s.notifyMode = radio.value;
      await Storage.setAnomalySettings(s);
      chrome.runtime.sendMessage({ type: 'SET_ANOMALY_SETTINGS', settings: s }).catch(()=>{});
    });
  });

  // Düşüş tespiti toggle
  const dropToggleEl = optEl('opt-anomaly-drop-enabled');
  if (dropToggleEl) {
    dropToggleEl.addEventListener('change', async e => {
      setSensitivityDisabled('opt-drop-sensitivity-body', !e.target.checked);
      const s = await Storage.getAnomalySettings();
      s.dropEnabled = e.target.checked;
      await Storage.setAnomalySettings(s);
      chrome.runtime.sendMessage({ type: 'SET_ANOMALY_SETTINGS', settings: s }).catch(()=>{});
    });
  }

  // Spike switch
  const spikeSwEl = optEl('opt-anomaly-spike-enabled');
  if (spikeSwEl) {
    spikeSwEl.addEventListener('change', async e => {
      setSensitivityDisabled('opt-spike-sensitivity-body', !e.target.checked);
      const s = await Storage.getAnomalySettings();
      s.spikeEnabled = e.target.checked;
      await Storage.setAnomalySettings(s);
      chrome.runtime.sendMessage({ type: 'SET_ANOMALY_SETTINGS', settings: s }).catch(()=>{});
    });
  }

  // Tarayıcı dili switch
  const browserLangSw = optEl('opt-use-browser-lang');
  if (browserLangSw) {
    browserLangSw.addEventListener('change', async e => {
      await Storage.setUseBrowserLanguage(e.target.checked);
      if (e.target.checked) {
        // Otomatik moda dönünce kullanıcı tercihini temizle
        await Storage.setUserLanguage(null);
        const lang = await Utils.detectLanguage();
        await Utils.loadLocale(lang);
        applyOptionsI18n();
        setupI18n();
      }
      renderLangSelector();
    });
  }

  // Sensitivity slider'ları
  setupSensitivitySlider('opt-spike-sensitivity-slider', 'spikeSensitivity');
  setupSensitivitySlider('opt-drop-sensitivity-slider', 'dropSensitivity');

  // v2.3.5: Auto-open (tab açma) gecikmesi (slider)
  const autoOpenSlider = optEl('opt-auto-open-delay-slider');
  if (autoOpenSlider) {
    autoOpenSlider.addEventListener('input', () => {
      optEl('opt-auto-open-delay-value').textContent = autoOpenSlider.value;
      optUpdateSliderFill(autoOpenSlider);
    });
    autoOpenSlider.addEventListener('change', () => Storage.setAutoOpenDelay(+autoOpenSlider.value));
  }

  // Cloud Sync listener
  optBind('opt-cloud-sync', v => Storage.setCloudSyncEnabled(v));

  // Chat Integration master switch
  optBind('opt-chat-integration', async v => {
    await Storage.setChatIntegrationEnabled(v);
    document.getElementById('chat-btn').style.display = v ? '' : 'none';
    if (!v && document.querySelector('.tab-button[data-tab="chat-panel"].active')) {
      // If chat tab was active, switch back to following
      document.getElementById('following-btn').click();
    }
  });

  // Chat sub-settings
  setupChatHandlers();

  // Theme buttons
  document.querySelectorAll('.opt-theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const theme = btn.dataset.theme;
      await Storage.setTheme(theme);
      document.documentElement.setAttribute('data-theme', theme);
      document.querySelectorAll('.opt-theme-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });

  const volSlider = optEl('opt-volume-slider');
  volSlider.addEventListener('input', () => {
    optEl('opt-volume-value').textContent = volSlider.value;
    optUpdateSliderFill(volSlider);
  });
  volSlider.addEventListener('change', () => Storage.setSoundVolume(+volSlider.value));

  const intSlider = optEl('opt-interval-slider');
  intSlider.addEventListener('input', () => {
    optEl('opt-interval-value').textContent = intSlider.value;
    optUpdateSliderFill(intSlider);
  });
  intSlider.addEventListener('change', () => Storage.setCheckInterval(+intSlider.value));

  optEl('opt-test-sound').addEventListener('click', async () => {
    await popupPlaySound('NEW_LIVE_MAIN');
  });

  optSetupSound('main');
  optSetupSound('sub');

  // Groups management
  optEl('opt-group-add-btn').addEventListener('click', async () => {
    const input = optEl('opt-group-input');
    const name = input.value.trim();
    if (!name) return;
    await Storage.addChannelGroup(name);
    input.value = '';
    await optRenderGroups();
    await buildGroupFilterBar();
  });
  optEl('opt-group-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') optEl('opt-group-add-btn').click();
  });
  optRenderGroups();
}

async function optRenderGroups() {
  const list = document.getElementById('opt-groups-list');
  if (!list) return;
  const groups = await Storage.getChannelGroups();
  list.innerHTML = '';
  for (const g of groups) {
    const tag = document.createElement('span');
    tag.className = 'opt-group-tag';
    tag.innerHTML = `${esc(g)}<button class="remove-group" title="Remove">&times;</button>`;
    tag.querySelector('.remove-group').addEventListener('click', async () => {
      await Storage.removeChannelGroup(g);
      await optRenderGroups();
      await buildGroupFilterBar();
    });
    list.appendChild(tag);
  }
}

function optBind(id, fn) {
  optEl(id).addEventListener('change', e => fn(e.target.checked));
}

function optSetupSound(type) {
  const file = optEl(`opt-${type}-sound-file`);
  const test = optEl(`opt-${type}-sound-test`);
  const clear = optEl(`opt-${type}-sound-clear`);

  file.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      optSetSoundStatus(type, Utils.i18n('customSoundStatusErrorTooLarge', [(f.size / 1048576).toFixed(1)]));
      return;
    }
    try {
      const url = await optToDataUrl(f);
      await Storage.setCustomSoundFile(type, f.name, url);
      await optUpdateSoundStatus(type);
    } catch { optSetSoundStatus(type, Utils.i18n('customSoundStatusErrorSave')); }
  });

  test.addEventListener('click', async () => {
    await popupPlaySound(type === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB');
  });

  clear.addEventListener('click', async () => {
    await Storage.clearCustomSoundFile(type);
    file.value = '';
    await optUpdateSoundStatus(type);
  });
}

// Popup context'inde ses çal — Chrome ve Firefox uyumlu
// Chrome'da background offscreen'e ilet, Firefox'ta doğrudan Audio() kullan
async function popupPlaySound(soundType) {
  try {
    const soundMode = await Storage.getSoundMode();
    if (soundMode === 'windows') {
      // Windows sesi — background'a bırak
      chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType });
      return;
    }
    const volume = (await Storage.getSoundVolume()) / 100;
    const key = soundType === 'NEW_LIVE_MAIN' ? 'main' : 'sub';
    const customFile = await Storage.getCustomSoundFile(key);

    if (chrome.offscreen) {
      // Chrome: offscreen üzerinden çal
      chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType });
    } else {
      // Firefox: popup context'inde doğrudan Audio() — çalışır
      const SoundPaths = {
        NEW_LIVE_MAIN: chrome.runtime.getURL('sounds/new_live_main.mp3'),
        NEW_LIVE_SUB:  chrome.runtime.getURL('sounds/new_live_sub.mp3'),
      };
      const src = customFile?.dataUrl || SoundPaths[soundType] || SoundPaths.NEW_LIVE_MAIN;
      const audio = new Audio(src);
      audio.volume = volume;
      await audio.play();
    }
  } catch (e) {
    console.warn('[KickAlert] popupPlaySound error:', e.message);
  }
}

async function optUpdateSoundStatus(type) {
  const data = await Storage.getCustomSoundFile(type);
  optSetSoundStatus(type, data?.fileName || Utils.i18n('customSoundStatusUnset'));
}

function optSetSoundStatus(type, text) { optEl(`opt-${type}-sound-status`).textContent = text; }

function optUpdateSliderFill(slider) {
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const val = parseFloat(slider.value) || 0;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, #53FC18 0%, #53FC18 ${pct}%, #3a3a3e ${pct}%, #3a3a3e 100%)`;
}

function optToDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function optEl(id) { return document.getElementById(id); }

// Segment buton yardımcıları
function setSegActive(groupId, val) {
  const group = optEl(groupId);
  if (!group) return;
  group.querySelectorAll('.anomaly-seg-btn').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.val === +val);
  });
}

const SPIKE_LABELS = {
  min: 'Warn +25% · Alert +75%',
  avg: 'Warn +50% · Alert +150%',
  max: 'Warn +75% · Alert +250%',
};
const DROP_LABELS = {
  min: 'Warn -10% · Alert -20%',
  avg: 'Warn -20% · Alert -35%',
  max: 'Warn -30% · Alert -50%',
};

function setSensitivityDisabled(bodyId, disabled) {
  const el = optEl(bodyId);
  if (el) el.classList.toggle('disabled', disabled);
}

function updateSensitivityFill(slider, labels) {
  if (!slider) return;
  // min=0 max=2 step=1 — sabit 3 pozisyon, fill hesabı doğrudan
  const pct = (+slider.value / 2) * 100;
  slider.style.background = `linear-gradient(to right, #53FC18 0%, #53FC18 ${pct}%, #3a3a3e ${pct}%, #3a3a3e 100%)`;
  const valEl = optEl(slider.id.replace('-slider', '-val'));
  if (valEl && labels) {
    const key = ['min','avg','max'][+slider.value];
    valEl.textContent = labels[key] || '';
  }
}

function setupSensitivitySlider(sliderId, storageKey) {
  const slider = optEl(sliderId);
  if (!slider) return;
  const labels = sliderId.includes('spike') ? SPIKE_LABELS : DROP_LABELS;
  slider.addEventListener('input', () => updateSensitivityFill(slider, labels));
  slider.addEventListener('change', async () => {
    const val = ['min', 'avg', 'max'][+slider.value];
    const s = await Storage.getAnomalySettings();
    s[storageKey] = val;
    await Storage.setAnomalySettings(s);
    chrome.runtime.sendMessage({ type: 'SET_ANOMALY_SETTINGS', settings: s }).catch(()=>{});
  });
}

function setupSensitivityGroup(groupId, storageKey) {}
function setupSegGroup(groupId, storageKey) {}

// Viewer anomaly — background'a sorar
async function getViewerAnomaly(slug, viewerCount, startedAt) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_VIEWER_ANOMALY',
      slug,
      viewerCount,
      startedAt: startedAt || null,
    });
    return res?.anomaly || null;
  } catch { return null; }
}

// Viewer drop — background'a sorar
async function getViewerDrop(slug, viewerCount, startedAt) {
  try {
    const res = await chrome.runtime.sendMessage({
      type: 'GET_VIEWER_DROP',
      slug,
      viewerCount,
      startedAt: startedAt || null,
    });
    return res?.drop || null;
  } catch { return null; }
}

function optUpdateAnomalyVisibility(enabled) {
  const body = document.getElementById('opt-anomaly-body');
  if (body) body.classList.toggle('disabled', !enabled);
}

function optUpdateAnomalyForCardMode() {
  // Compact mod kaldırıldı — anomaly section her zaman aktif
  const section = document.getElementById('opt-anomaly-section');
  if (section) section.classList.remove('disabled');
}

// Sparkline — smooth curve + son nokta, yukarı=yeşil aşağı=kırmızı
async function buildSparkline(slug) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_VIEWER_HISTORY', slug });
    const entries = res?.history?.current;
    if (!entries || entries.length < 2) return '';

    const vals = entries.map(e => e.v);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    if (max === min) return '';

    const W = 32, H = 10;

    // Trend yönü: ilk yarı ort vs ikinci yarı ort
    const mid = Math.floor(vals.length / 2);
    const firstHalfAvg = vals.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
    const secondHalfAvg = vals.slice(mid).reduce((s, v) => s + v, 0) / (vals.length - mid);
    const color = secondHalfAvg >= firstHalfAvg ? '#53FC18' : '#E24B4A';

    // %5'ten az değişimde yapay dalga önle — görsel aralığı genişlet
    const changeRatio = (max - min) / (max || 1);
    const pad = changeRatio < 0.05 ? (max - min) * 2 : 0;
    const visMin = min - pad;
    const visMax = max + pad;
    const range = visMax - visMin || 1;

    const pts = vals.map((v, i) => ({
      x: (i / (vals.length - 1)) * (W - 6) + 2,
      y: H - 2 - ((v - visMin) / range) * (H - 5),
    }));

    // Bezier path
    let d = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const cp1x = (pts[i-1].x + pts[i].x) / 2;
      const cp2x = cp1x;
      d += ` C${cp1x.toFixed(1)},${pts[i-1].y.toFixed(1)} ${cp2x.toFixed(1)},${pts[i].y.toFixed(1)} ${pts[i].x.toFixed(1)},${pts[i].y.toFixed(1)}`;
    }

    const last = pts[pts.length - 1];

    return `<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
      <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>
      <circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="2.5" fill="${color}"/>
    </svg>`;
  } catch { return ''; }
}


// ─── Viewer History Modal ───

async function showViewerHistoryModal(ch) {
  const modal = document.getElementById('viewer-history-modal');
  const title = document.getElementById('vh-modal-title');
  const svg = document.getElementById('vh-chart-svg');
  const labels = document.getElementById('vh-chart-labels');
  const noData = document.getElementById('vh-no-data');
  const closeBtn = document.getElementById('vh-modal-close');
  const backdrop = modal.querySelector('.vh-modal-backdrop');

  if (!modal) return;

  title.textContent = ch.userUsername + ' — ' + (Utils.i18n('viewerTrendTitle') || 'Viewer Trend');

  // Navigasyon — canlı kanallar arasında geçiş
  const liveChannels = allChannels.filter(c => c.isLive);
  const currentIdx = liveChannels.findIndex(c => c.channelSlug === ch.channelSlug);

  let prevBtn = document.getElementById('vh-prev-btn');
  let nextBtn = document.getElementById('vh-next-btn');
  const header = modal.querySelector('.vh-modal-header');

  if (!prevBtn) {
    prevBtn = document.createElement('button');
    prevBtn.id = 'vh-prev-btn';
    prevBtn.className = 'vh-close-btn';
    prevBtn.innerHTML = '<span class="material-icons">chevron_left</span>';
    nextBtn = document.createElement('button');
    nextBtn.id = 'vh-next-btn';
    nextBtn.className = 'vh-close-btn';
    nextBtn.innerHTML = '<span class="material-icons">chevron_right</span>';
    header.insertBefore(prevBtn, header.firstChild);
    header.appendChild(nextBtn);
  }

  prevBtn.style.visibility = currentIdx > 0 ? 'visible' : 'hidden';
  nextBtn.style.visibility = currentIdx < liveChannels.length - 1 ? 'visible' : 'hidden';
  prevBtn.onclick = () => showViewerHistoryModal(liveChannels[currentIdx - 1]);
  nextBtn.onclick = () => showViewerHistoryModal(liveChannels[currentIdx + 1]);
  svg.innerHTML = '';
  labels.innerHTML = '';
  noData.style.display = 'none';
  // v2.3.7: Eski metrik kutularını temizle (başka kanala geçince / veri yoksa)
  const oldMetrics = modal.querySelector('.vh-metrics');
  if (oldMetrics) oldMetrics.remove();
  const oldMinMax2 = modal.querySelector('.vh-minmax-row');
  if (oldMinMax2) oldMinMax2.remove();
  // v2.3.3: Rozet dönüşüm timer'ını durdur (yeniden çizimde yeniden kurulur)
  const titleForClear = document.getElementById('vh-modal-title');
  if (titleForClear && titleForClear._vhBadgeTimer) {
    clearInterval(titleForClear._vhBadgeTimer);
    titleForClear._vhBadgeTimer = null;
  }
  modal.style.display = 'flex';

  // Veri çek
  const res = await chrome.runtime.sendMessage({ type: 'GET_VIEWER_HISTORY', slug: ch.channelSlug });
  const entries = res?.history?.current || [];

  if (entries.length < 2) {
    noData.style.display = 'block';
  } else {
    drawViewerChart(svg, labels, entries, ch);
  }

  // Kapat
  const close = () => {
    modal.style.display = 'none';
    document.removeEventListener('keydown', escHandler);
    // v2.3.3: Rozet dönüşüm timer'ını durdur (modal kapalıyken boşa dönmesin)
    const t = document.getElementById('vh-modal-title');
    if (t && t._vhBadgeTimer) { clearInterval(t._vhBadgeTimer); t._vhBadgeTimer = null; }
  };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  closeBtn.onclick = close;
  backdrop.onclick = close;
}

// v2.3.3: Bir yüzde değerini eklentinin RESMİ spike/drop renk standardına çevirir.
// Hem genel trend hem "son 6 interval" ivmesi bu helper'ı kullanır (tek kaynak).
// Döndürür: { level, color } — level CSS class eki, color SVG çizgi rengi.
// v2.3.3: Bir yüzde değerini KART SPARKLINE standardına çevirir (birebir aynı):
//   yukarı → #53FC18 (Kick yeşili), aşağı → #E24B4A (kırmızı),
//   neredeyse sabit (<%3) → #8a8a8a (gri).
// Hem genel trend hem "şu an" ivmesi bu helper'ı kullanır (tek kaynak).
function _trendStyle(pct) {
  const FLAT = 3;
  if (pct >= FLAT)  return { level: 'up',   color: '#53FC18' };
  if (pct <= -FLAT) return { level: 'down', color: '#E24B4A' };
  return { level: 'flat', color: '#8a8a8a' };
}

function drawViewerChart(svg, labels, entries, ch) {
  const W = 400, H = 120, padX = 8, padY = 10;
  const vals = entries.map(e => e.v);
  const times = entries.map(e => e.t);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;

  // Trend rengi — _trendStyle helper'ı (3 katman: standart / soluk / gri)
  const mid = Math.floor(vals.length / 2);
  const firstAvg = vals.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
  const secondAvg = vals.slice(mid).reduce((s, v) => s + v, 0) / (vals.length - mid);
  const _trendPct = firstAvg > 0 ? Math.round(((secondAvg - firstAvg) / firstAvg) * 100) : 0;
  const _genStyle = _trendStyle(_trendPct);
  const color = _genStyle.color;
  const trendLevel = _genStyle.level;

  // Nokta koordinatları
  const pts = vals.map((v, i) => ({
    x: padX + (i / (vals.length - 1)) * (W - padX * 2),
    y: padY + (1 - (v - minV) / range) * (H - padY * 2),
  }));

  // Fill path
  let fillD = `M${pts[0].x},${H - padY}`;
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) fillD += ` L${pts[0].x},${pts[0].y}`;
    else {
      const cp1x = (pts[i-1].x + pts[i].x) / 2;
      fillD += ` C${cp1x},${pts[i-1].y} ${cp1x},${pts[i].y} ${pts[i].x},${pts[i].y}`;
    }
  }
  fillD += ` L${pts[pts.length-1].x},${H - padY} Z`;

  // Line path
  let lineD = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length; i++) {
    const cp1x = (pts[i-1].x + pts[i].x) / 2;
    lineD += ` C${cp1x},${pts[i-1].y} ${cp1x},${pts[i].y} ${pts[i].x},${pts[i].y}`;
  }

  // Tüm dots
  const dotsHtml = pts.map((pt, i) =>
    i === pts.length - 1
      ? `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="4.5" fill="${color}"/>`
      : `<circle cx="${pt.x.toFixed(1)}" cy="${pt.y.toFixed(1)}" r="3" fill="${color}" opacity="0.8"/>`
  ).join('');

  // SVG — min/max label'ları dışarıda, chart temiz
  svg.innerHTML = `
    <defs>
      <linearGradient id="vh-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${fillD}" fill="url(#vh-grad)"/>
    <path d="${lineD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    ${dotsHtml}`;

  // ── v2.3.7 (B): Metrikleri hesapla — hepsi mevcut entries verisinden ──
  const chartWrap = svg.closest('.vh-chart-wrap');
  // Yayın (tüm izleme) ortalaması
  const avgAll = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  // Son 6 interval ortalaması (yaklaşık son 3 dk — 30sn aralıkla)
  const lastN = vals.slice(-6);
  const avgRecent = Math.round(lastN.reduce((s, v) => s + v, 0) / lastN.length);
  const maxIdx = vals.indexOf(maxV);                      // zirve hangi entry
  // İzlenen süre (ilk-son entry arası — yayın başı değil, izleme süresi)
  const watchedMs = times[times.length - 1] - times[0];
  const watchedMin = Math.max(1, Math.round(watchedMs / 60000));
  const durLabel = watchedMin >= 60
    ? `${Math.floor(watchedMin / 60)}s ${watchedMin % 60}dk`
    : `${watchedMin}dk`;

  const fmt = (t) => {
    const d = new Date(t);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  };

  // ── Son 6 interval ivmesi (anlık momentum — son ~3 dk) ──
  // Son 6 intervalin ilk değeri vs son değeri arası yüzde değişim.
  let recentPct = 0;
  if (lastN.length >= 2) {
    const rFirst = lastN[0], rLast = lastN[lastN.length - 1];
    recentPct = rFirst > 0 ? Math.round(((rLast - rFirst) / rFirst) * 100) : 0;
  }
  const _recentStyle = _trendStyle(recentPct);

  // Rozet metni üreten yardımcı (etiket + yön oku + yüzde + renk class)
  const buildBadgeData = (label, pct, style) => {
    const absT = Math.abs(pct);
    if (style.level === 'flat') {
      return { cls: 'vh-trend-flat', text: `${label} → ${Utils.i18n('trendStable') || 'sabit'}` };
    }
    const isUp = style.level === 'up';
    return { cls: `vh-trend-${style.level}`, text: `${label} ${isUp ? '↑' : '↓'} ${absT}%` };
  };

  // ── Başlığa DÖNÜŞÜMLÜ trend rozeti: Genel ↔ Son 6 (her 3.5sn'de geçiş) ──
  const titleEl = document.getElementById('vh-modal-title');
  if (titleEl) {
    const oldBadge = titleEl.querySelector('.vh-trend-badge');
    if (oldBadge) oldBadge.remove();
    // Önceki interval'ı temizle (başka kanala geçilince çift dönüş olmasın)
    if (titleEl._vhBadgeTimer) { clearInterval(titleEl._vhBadgeTimer); titleEl._vhBadgeTimer = null; }

    const badge = document.createElement('span');
    badge.className = 'vh-trend-badge';
    titleEl.appendChild(badge);

    const states = [
      buildBadgeData(Utils.i18n('vhTrendGeneral') || 'Genel', _trendPct, _genStyle),
      buildBadgeData(Utils.i18n('vhTrendRecent') || 'Şu an', recentPct, _recentStyle),
    ];
    let idx = 0;
    const apply = () => {
      const st = states[idx];
      badge.className = `vh-trend-badge ${st.cls} vh-badge-fade`;
      badge.textContent = st.text;
      // fade efektini yeniden tetikle
      void badge.offsetWidth;
      badge.classList.add('vh-badge-show');
    };
    apply();
    // İki durum farklıysa dönüşümü başlat (aynıysa sabit kalsın)
    if (states[0].text !== states[1].text) {
      titleEl._vhBadgeTimer = setInterval(() => {
        idx = (idx + 1) % states.length;
        badge.classList.remove('vh-badge-show');
        setTimeout(apply, 180); // kısa fade-out → fade-in
      }, 3500);
    }
  }

  // ── min/max row'u kaldır (artık metrik kutularında) ──
  const oldMinMax = chartWrap.parentElement.querySelector('.vh-minmax-row');
  if (oldMinMax) oldMinMax.remove();

  // ── 4 metrik kutusu: Zirve / Dip / Yayın ort. / Son 6 ort. ──
  let metricsRow = chartWrap.parentElement.querySelector('.vh-metrics');
  if (!metricsRow) {
    metricsRow = document.createElement('div');
    metricsRow.className = 'vh-metrics';
    chartWrap.parentElement.appendChild(metricsRow);
  }
  const L = {
    peak: Utils.i18n('vhPeak') || 'Zirve',
    low:  Utils.i18n('vhLow')  || 'Dip',
    avgAll: Utils.i18n('vhAvgAll') || 'Yayın ort.',
    avgRecent: Utils.i18n('vhAvgRecent') || 'Son 6 ort.',
  };
  metricsRow.innerHTML =
    `<div class="vh-metric"><div class="vh-m-label">${L.peak}</div><div class="vh-m-value vh-m-peak">${Utils.formatViewers(maxV)}</div></div>` +
    `<div class="vh-metric"><div class="vh-m-label">${L.low}</div><div class="vh-m-value vh-m-low">${Utils.formatViewers(minV)}</div></div>` +
    `<div class="vh-metric"><div class="vh-m-label">${L.avgAll}</div><div class="vh-m-value">${Utils.formatViewers(avgAll)}</div></div>` +
    `<div class="vh-metric"><div class="vh-m-label">${L.avgRecent}</div><div class="vh-m-value">${Utils.formatViewers(avgRecent)}</div></div>`;

  // ── X ekseni — başlangıç (+izleme süresi) · zirve zamanı · şu an ──
  labels.innerHTML =
    `<span>${fmt(times[0])} <span class="vh-peak-time">(${durLabel})</span></span>` +
    `<span class="vh-peak-time">${Utils.i18n('vhPeakAt') || 'zirve'}: ${fmt(times[maxIdx])}</span>` +
    `<span>${fmt(times[times.length-1])}</span>`;
}

// ─── Chat Settings ───

/**
 * Sync data-enabled attribute for all collapsible chat sections
 * based on their data-flag value in settings.
 * Must run on load AND whenever any flag checkbox changes.
 */
function syncChatSectionStates(s) {
  document.querySelectorAll('#chat-panel .chat-section[data-collapsible="true"]').forEach(section => {
    const flag = section.dataset.flag;
    if (!flag) return;
    const on = !!s[flag];
    section.setAttribute('data-enabled', on ? 'true' : 'false');
  });
}

async function loadChatSettings() {
  const s = await Storage.getChatSettings();

  const set = (id, prop, val) => { const el = document.getElementById(id); if (el) el[prop] = val; };

  // Filter mode
  set('chat-filter-blur', 'checked', !!s.filterBlur);
  // Radio buttons: sync with filterBlur value
  const modeHide = document.getElementById('chat-mode-hide');
  const modeBlur = document.getElementById('chat-mode-blur');
  if (modeHide && modeBlur) {
    modeHide.checked = !s.filterBlur;
    modeBlur.checked = !!s.filterBlur;
  }

  // Section enable switches (9 total)
  set('chat-bot-filter', 'checked', !!s.botFilter);
  set('chat-emoji-filter', 'checked', !!s.emojiFilter);
  set('chat-repeat-filter', 'checked', !!s.repeatFilter);
  set('chat-word-enabled', 'checked', !!s.wordFilterEnabled);
  set('chat-user-enabled', 'checked', !!s.userFilterEnabled);
  set('chat-keyword-enabled', 'checked', !!s.keywordEnabled);
  set('chat-fav-enabled', 'checked', !!s.favEnabled);
  set('chat-tag-enabled', 'checked', !!s.tagEnabled);
  set('chat-broadcaster-notif', 'checked', !!s.broadcasterNotif);

  // Text input
  set('chat-tag-username', 'value', s.tagUsername || '');

  // Chip lists
  renderChips('chat-bot-chips', s.botList || [], 'botList');
  renderChips('chat-word-chips', s.wordList || [], 'wordList');
  renderChips('chat-user-chips', s.userList || [], 'userList');
  renderChips('chat-keyword-chips', s.keywordList || [], 'keywordList');
  renderChips('chat-fav-chips', s.favList || [], 'favList');

  // Collapsible state
  syncChatSectionStates(s);
}

function renderChips(containerId, items, settingKey) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  items.forEach(item => {
    const chip = document.createElement('span');
    chip.className = 'chat-chip';
    chip.textContent = item;
    chip.title = Utils.i18n('chatChipRemoveTooltip') || 'Click to remove';
    chip.addEventListener('click', async () => {
      const s = await Storage.getChatSettings();
      s[settingKey] = (s[settingKey] || []).filter(x => x !== item);
      await Storage.setChatSettings(s);
      renderChips(containerId, s[settingKey], settingKey);
    });
    el.appendChild(chip);
  });
}

function setupChatHandlers() {
  /**
   * Bind a flag checkbox: save to storage AND update its section's data-enabled attr.
   * Returns nothing; assumes element exists.
   */
  const bindFlag = (checkboxId, settingKey) => {
    const el = document.getElementById(checkboxId);
    if (!el) return;
    el.addEventListener('change', async e => {
      const on = e.target.checked;
      await Storage.updateChatSetting(settingKey, on);
      // Update its containing section's data-enabled so the CSS collapse kicks in
      const section = el.closest('.chat-section[data-collapsible="true"]');
      if (section) section.setAttribute('data-enabled', on ? 'true' : 'false');
    });
  };

  // Filter mode — radio buttons (v2.0.1, Options-style)
  // Hidden checkbox `chat-filter-blur` is still the storage source of truth.
  const modeHide = document.getElementById('chat-mode-hide');
  const modeBlur = document.getElementById('chat-mode-blur');
  const hiddenBlur = document.getElementById('chat-filter-blur');
  const applyFilterMode = async (blur) => {
    if (hiddenBlur) hiddenBlur.checked = blur;
    if (modeHide) modeHide.checked = !blur;
    if (modeBlur) modeBlur.checked = blur;
    await Storage.updateChatSetting('filterBlur', blur);
  };
  modeHide?.addEventListener('change', e => { if (e.target.checked) applyFilterMode(false); });
  modeBlur?.addEventListener('change', e => { if (e.target.checked) applyFilterMode(true); });

  // 9 collapsible section flags
  bindFlag('chat-bot-filter', 'botFilter');
  bindFlag('chat-emoji-filter', 'emojiFilter');
  bindFlag('chat-repeat-filter', 'repeatFilter');
  bindFlag('chat-word-enabled', 'wordFilterEnabled');
  bindFlag('chat-user-enabled', 'userFilterEnabled');
  bindFlag('chat-keyword-enabled', 'keywordEnabled');
  bindFlag('chat-fav-enabled', 'favEnabled');
  bindFlag('chat-tag-enabled', 'tagEnabled');
  bindFlag('chat-broadcaster-notif', 'broadcasterNotif');

  // Tag username (debounced)
  let tagTimeout;
  document.getElementById('chat-tag-username')?.addEventListener('input', e => {
    clearTimeout(tagTimeout);
    tagTimeout = setTimeout(async () => {
      await Storage.updateChatSetting('tagUsername', e.target.value.trim());
    }, 500);
  });

  // List add/remove handlers
  setupListHandler('chat-bot-input', 'chat-bot-add', 'chat-bot-chips', 'botList');
  setupListHandler('chat-word-input', 'chat-word-add', 'chat-word-chips', 'wordList');
  setupListHandler('chat-user-input', 'chat-user-add', 'chat-user-chips', 'userList');
  setupListHandler('chat-keyword-input', 'chat-keyword-add', 'chat-keyword-chips', 'keywordList');
  setupListHandler('chat-fav-input', 'chat-fav-add', 'chat-fav-chips', 'favList');
}

function setupListHandler(inputId, btnId, chipsId, settingKey) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  if (!input || !btn) return;

  const addItem = async () => {
    const val = input.value.trim();
    if (!val) return;
    const s = await Storage.getChatSettings();
    const list = s[settingKey] || [];
    if (!list.includes(val)) {
      list.push(val);
      s[settingKey] = list;
      await Storage.setChatSettings(s);
      renderChips(chipsId, list, settingKey);
    }
    input.value = '';
  };

  btn.addEventListener('click', addItem);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); addItem(); }
  });
}
