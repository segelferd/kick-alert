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
  await Utils.initI18n();
  setupI18n();
  setupTabs();
  setupMenu();
  setupSearch();
  setupHistoryClear();
  await loadChannels();
  await loadHistory();
  await updateMenuState();
  await startAutoRefresh();
});

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
    } else {
      showMsg('following-list', Utils.i18n('fetchError'));
    }
  } catch { showMsg('following-list', Utils.i18n('fetchError')); }
  showLoading(false);
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

async function renderFollowing() {
  const el = document.getElementById('following-list');
  if (!el) return;

  const showOffline = await Storage.getShowOfflineChannels();
  let list = showOffline ? allChannels : allChannels.filter(c => c.isLive);

  if (list.length === 0) {
    el.innerHTML = `<div class="empty-state">${Utils.i18n('noLiveStreams')}</div>`;
    return;
  }

  list.sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return a.userUsername.localeCompare(b.userUsername);
  });

  el.innerHTML = '';
  for (const ch of list) el.appendChild(await channelCard(ch));
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
  for (const ch of sorted) el.appendChild(await autoLaunchCard(ch));
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

async function channelCard(ch) {
  const card = document.createElement('div');
  card.className = `channel-card ${ch.isLive ? 'live' : 'offline'}`;

  const pic = ch.profilePic || '../images/default-profile-pictures/default.jpeg';
  let meta = '';
  if (ch.isLive) {
    const dur = Utils.formatDuration(ch.startedAt);
    const viewers = Utils.formatViewers(ch.viewerCount);
    meta = `<div class="channel-meta">
      <span class="rec-indicator"><span class="rec-dot"></span></span>
      <span class="stream-duration" data-slug="${esc(ch.channelSlug)}">${esc(dur)}</span>
      <span class="meta-separator">·</span>
      <span class="viewer-count">${esc(viewers)}</span>
      ${ch.categoryName ? `<span class="meta-separator">·</span><span class="category-name" title="${esc(ch.categoryName)}">${esc(ch.categoryName)}</span>` : ''}
    </div>`;
  }

  card.innerHTML = `
    <div class="card-top">
      <img class="channel-avatar" src="${esc(pic)}" alt="" onerror="this.src='../images/default-profile-pictures/default.jpeg'" />
      <div class="channel-info">
        <div class="channel-name" title="${esc(ch.userUsername)}">${esc(ch.userUsername)}</div>
        ${ch.isLive ? `<div class="channel-title" title="${esc(ch.sessionTitle || '-')}">${esc(ch.sessionTitle || '-')}</div>` : ''}
        ${meta}
      </div>
    </div>`;

  if (ch.isLive) {
    const actions = document.createElement('div');
    actions.className = 'card-actions-row';

    // Open button
    const openBtn = document.createElement('button');
    openBtn.className = 'card-action-btn open-btn';
    openBtn.title = 'Open channel';
    openBtn.innerHTML = '<span class="material-icons">open_in_new</span>';
    openBtn.addEventListener('click', () => chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}` }));

    // Multi button
    const multiBtn = document.createElement('button');
    multiBtn.className = 'card-action-btn multi-btn';
    multiBtn.title = 'Add to Multi-Stream';
    multiBtn.innerHTML = '<span class="material-icons">grid_view</span>';
    multiBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addToMultiStream(ch.channelSlug);
      multiBtn.querySelector('.material-icons').style.color = '#f0883e';
    });

    // Bell button
    const bellMode = await Storage.getChannelSoundMode(ch.channelSlug);
    const bellBtn = createBellButton(ch.channelSlug, bellMode);

    actions.appendChild(openBtn);
    actions.appendChild(multiBtn);
    actions.appendChild(bellBtn);
    card.appendChild(actions);
  }

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

// ─── Auto Launch Card ───

async function autoLaunchCard(ch) {
  const card = document.createElement('div');
  card.className = `channel-card autolaunch-card ${ch.isLive ? 'live' : 'offline'}`;
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
  const bellMode = await Storage.getChannelSoundMode(ch.channelSlug);
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
    history.forEach(entry => {
      const item = document.createElement('div');
      item.className = 'history-item';
      item.innerHTML = `
        <div class="history-header">
          <span class="history-username">${esc(entry.username)}</span>
          <span class="history-time">${esc(Utils.formatTimestamp(entry.timestamp))}</span>
        </div>
        <div class="history-title">${esc(entry.title)}</div>
        <div class="history-category">${esc(entry.category)}</div>`;
      item.addEventListener('click', () => chrome.tabs.create({ url: `https://kick.com/${entry.channelSlug}` }));
      el.appendChild(item);
    });
  } catch { el.innerHTML = `<div class="empty-state">${Utils.i18n('errorLoadingHistory')}</div>`; }
}

// ─── Auto Refresh ───

async function startAutoRefresh() {
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
  const input = document.getElementById('autolaunch-search');
  if (!input) return;
  input.addEventListener('input', () => {
    const query = input.value.toLowerCase().trim();
    const cards = document.querySelectorAll('#autolaunch-list .channel-card');
    cards.forEach(card => {
      const name = card.querySelector('.channel-name')?.textContent?.toLowerCase() || '';
      card.style.display = name.includes(query) ? '' : 'none';
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
  document.querySelectorAll('#options-panel [data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const sub = el.getAttribute('data-i18n-sub');
    el.textContent = Utils.i18n(key, sub ? [sub] : undefined);
  });
  document.querySelectorAll('#options-panel [data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = Utils.i18n(key);
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
