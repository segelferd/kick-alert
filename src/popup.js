/**
 * KickAlert - Popup Script
 * Handles popup UI: tabs, channel cards, toggles, history.
 * Bell button (3-state): main sound / sub sound / silent
 * © 2025 Segelferd. All rights reserved.
 */

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
  setupTabs();
  setupMenu();
  setupSearch();
  setupHistoryClear();
  setupRateLink();
  await loadChannels();
  await loadHistory();
  await updateMenuState();
  await startAutoRefresh();
});

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
    });
  });
}

// ─── Menu ───

function setupMenu() {
  document.getElementById('refresh-chip')?.addEventListener('click', async () => {
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

async function loadChannels() {
  showLoading(true);
  try {
    const res = await chrome.runtime.sendMessage({ type: 'GET_CHANNELS' });
    if (res?.success) {
      allChannels = res.channels;
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
      showMsg('following-list', Utils.i18n('fetchError'));
      showLoading(false);
    }
  } catch {
    showMsg('following-list', Utils.i18n('fetchError'));
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

  // Kategori filtresi
  if (categoryFilter) {
    list = list.filter(c => c.categoryName === categoryFilter);
  } else {
    // Grup filtresi
    const activeGroup = document.querySelector('.group-chip.active')?.dataset.group || '__all__';
    if (activeGroup !== '__all__' && !activeGroup.startsWith('__cat__')) {
      list = list.filter(c => groupMap[c.channelSlug] === activeGroup);
    }
  }

  // Build group filter bar
  await buildGroupFilterBar();

  if (list.length === 0) {
    el.innerHTML = `<div class="empty-state">${Utils.i18n('noLiveStreams')}</div>`;
    return;
  }

  list.sort((a, b) => {
    const aFav = favs[a.channelSlug] ? 1 : 0;
    const bFav = favs[b.channelSlug] ? 1 : 0;
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    if (aFav !== bFav) return bFav - aFav;
    return a.userUsername.localeCompare(b.userUsername);
  });

  el.innerHTML = '';
  const cardMode = 'detail'; // Compact mod kaldırıldı

  // Batch yükle — her kart için ayrı storage.get yerine tek seferde
  const [favMap, groupMap2, bellMap, groupList] = await Promise.all([
    Storage.getFavoriteChannels(),
    Storage.getChannelGroupMap(),
    Storage.getAllChannelSoundModes(),
    Storage.getChannelGroups(),
  ]);
  const batchData = { favMap, groupMap: groupMap2, bellMap, groupList };

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

  if (ch.isLive) {
    const dur = Utils.formatDuration(ch.startedAt);
    const viewers = Utils.formatViewers(ch.viewerCount);
    const anomaly = await getViewerAnomaly(ch.channelSlug, ch.viewerCount, ch.startedAt);
    const drop = await getViewerDrop(ch.channelSlug, ch.viewerCount, ch.startedAt);

    const anomalyBadge = (anomaly && cardMode !== 'compact')
      ? `<span class="viewer-anomaly viewer-anomaly-${anomaly.level}">↑+${anomaly.pct}%</span>`
      : (drop && cardMode !== 'compact')
      ? `<span class="viewer-anomaly viewer-anomaly-drop-${drop.level}">↓-${drop.pct}%</span>`
      : '';
    const anomalyNote = (anomaly && cardMode !== 'compact')
      ? `<div class="anomaly-row ${anomaly.level}">↑ ${anomaly.label}</div>`
      : (drop && cardMode !== 'compact')
      ? `<div class="anomaly-row drop-${drop.level}">↓ ${drop.label}</div>`
      : '';
    meta = `<div class="channel-meta">
      <span class="rec-indicator"><span class="rec-dot"></span></span>
      <span class="stream-duration" data-slug="${esc(ch.channelSlug)}">${esc(dur)}</span>
      <span class="meta-separator">·</span>
      <span class="viewer-count">${esc(viewers)}</span>
      ${anomalyBadge}
      ${ch.categoryName ? `<span class="meta-separator">·</span><span class="category-name" title="${esc(ch.categoryName)}">${esc(ch.categoryName)}</span>` : ''}
    </div>${anomalyNote}`;
  }

  card.innerHTML = `
    <div class="card-top">
      <img class="channel-avatar" src="${esc(pic)}" alt="" onerror="this.src='../images/default-profile-pictures/default.jpeg'" />
      <div class="channel-info">
        <div class="channel-name" title="${esc(ch.userUsername)}">${esc(ch.userUsername)}${groupBadge}</div>
        ${ch.isLive ? `<div class="channel-title" title="${esc(ch.sessionTitle || '-')}">${esc(ch.sessionTitle || '-')}</div>` : (lastSeenLabel ? `<div class="offline-last-seen">${Utils.i18n('lastStream') || 'Son yayın'}: ${esc(lastSeenLabel)}</div>` : '')}
        ${meta}
      </div>
    </div>
    ${ch.isLive && ch.thumbnailUrl ? `<img class="channel-thumbnail" src="${esc(ch.thumbnailUrl)}" alt="" loading="lazy" onerror="this.style.display='none'" />` : ''}`;

  // Thumbnail overlay lazy fetch sonrası kurulacak — aşağıda
  // Actions row — always show (live and offline both get star)
  const actions = document.createElement('div');
  actions.className = 'card-actions-row';

  // Sparkline — butonların yanında, sadece live + detail
  if (ch.isLive && cardMode !== 'compact' && sparkline) {
    const sparkWrap = document.createElement('span');
    sparkWrap.className = 'card-sparkline-wrap';
    sparkWrap.innerHTML = sparkline;
    actions.appendChild(sparkWrap);
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

  return card;
}

// ─── Auto Launch Card ───

async function autoLaunchCard(ch, cardMode, batch) {
  const card = document.createElement('div');
  card.className = `channel-card autolaunch-card ${ch.isLive ? 'live' : 'offline'} ${cardMode || 'detail'}-card`;
  const pic = ch.profilePic || '../images/default-profile-pictures/default.jpeg';
  const isAuto = await Storage.isAutoOpenChannel(ch.channelSlug);

  card.innerHTML = `
    <img class="channel-avatar" src="${esc(pic)}" alt="" onerror="this.src='../images/default-profile-pictures/default.jpeg'" />
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

  // Click anywhere on card toggles the switch (except on switch and bell)
  card.addEventListener('click', (e) => {
    if (e.target.closest('.toggle-switch') || e.target.closest('.bell-btn')) return;
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
      if (t >= today) return Utils.i18n('historyGroupToday') || 'Bugün';
      if (t >= yesterday) return Utils.i18n('historyGroupYesterday') || 'Dün';
      if (t >= thisWeek) return Utils.i18n('historyGroupThisWeek') || 'Bu Hafta';
      return Utils.i18n('historyGroupOlder') || 'Daha Önce';
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
        <img class="history-avatar" src="${esc(pic)}" alt="" onerror="this.src='../images/default-profile-pictures/default.jpeg'" />
        <div class="history-body">
          <div class="history-header">
            <span class="history-username">${esc(entry.username)}</span>
            <span class="history-time">${esc(Utils.formatTimestamp(entry.timestamp))}</span>
          </div>
          <div class="history-title">${esc(entry.title)}</div>
          <div class="history-category">${esc(entry.category)}</div>
        </div>`;
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
  autoRefreshTimer = setInterval(() => loadChannels(), secs * 1000);
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

function renderLangSelector() {
  const container = document.getElementById('lang-selector');
  if (!container) return;
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

  document.querySelectorAll('#options-panel [data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const sub = el.getAttribute('data-i18n-sub');
    el.textContent = Utils.i18n(key, sub ? [sub] : undefined);
  });
  document.querySelectorAll('#options-panel [data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = Utils.i18n(key);
  });
  document.querySelectorAll('#options-panel [data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = Utils.i18n(key);
  });
  document.querySelectorAll('#options-panel [data-i18n-placeholder]').forEach(el => {
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

  // Bildirim gecikmesi
  const notifDelay = await Storage.getNotifDelay();
  document.querySelectorAll('.notif-delay-btn').forEach(btn => {
    btn.classList.toggle('active', +btn.dataset.delay === notifDelay);
  });

  optEl('opt-cloud-sync').checked = await Storage.getCloudSyncEnabled();

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

  // Sensitivity slider'ları
  setupSensitivitySlider('opt-spike-sensitivity-slider', 'spikeSensitivity');
  setupSensitivitySlider('opt-drop-sensitivity-slider', 'dropSensitivity');

  // Bildirim gecikmesi
  document.querySelectorAll('.notif-delay-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const delay = +btn.dataset.delay;
      await Storage.setNotifDelay(delay);
      document.querySelectorAll('.notif-delay-btn').forEach(b =>
        b.classList.toggle('active', +b.dataset.delay === delay)
      );
    });
  });

  // Cloud Sync listener
  optBind('opt-cloud-sync', v => Storage.setCloudSyncEnabled(v));

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

  optEl('opt-test-sound').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType: 'NEW_LIVE_MAIN' });
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

  test.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType: type === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB' });
  });

  clear.addEventListener('click', async () => {
    await Storage.clearCustomSoundFile(type);
    file.value = '';
    await optUpdateSoundStatus(type);
  });
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

  title.textContent = ch.userUsername + ' — İzleyici Trendi';

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
  };
  const escHandler = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', escHandler);
  closeBtn.onclick = close;
  backdrop.onclick = close;
}

function drawViewerChart(svg, labels, entries, ch) {
  const W = 400, H = 120, padX = 8, padY = 10;
  const vals = entries.map(e => e.v);
  const times = entries.map(e => e.t);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const range = maxV - minV || 1;

  // Trend rengi
  const mid = Math.floor(vals.length / 2);
  const firstAvg = vals.slice(0, mid).reduce((s, v) => s + v, 0) / mid;
  const secondAvg = vals.slice(mid).reduce((s, v) => s + v, 0) / (vals.length - mid);
  const color = secondAvg >= firstAvg ? '#53FC18' : '#E24B4A';

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

  // Tek seferde set et — innerHTML += yerine
  svg.innerHTML = `
    <defs>
      <linearGradient id="vh-grad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${fillD}" fill="url(#vh-grad)"/>
    <path d="${lineD}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round"/>
    ${dotsHtml}
    <text x="${padX}" y="${padY + 4}" font-size="9" fill="#6e7681">${Utils.formatViewers(maxV)}</text>
    <text x="${padX}" y="${H - padY + 1}" font-size="9" fill="#6e7681">${Utils.formatViewers(minV)}</text>`;

  // X ekseni — ilk ve son zaman
  const fmt = (t) => {
    const d = new Date(t);
    return d.getHours().toString().padStart(2,'0') + ':' + d.getMinutes().toString().padStart(2,'0');
  };
  labels.innerHTML = `<span>${fmt(times[0])}</span><span>${Utils.formatViewers(vals[vals.length-1])} izleyici</span><span>${fmt(times[times.length-1])}</span>`;
}
