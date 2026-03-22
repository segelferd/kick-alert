/**
 * KickAlert - Background Service Worker
 * Monitors followed Kick channels, sends notifications, auto-launches streams.
 * Uses chrome.alarms API for guaranteed wake-up (MV3 service workers sleep after ~30s).
 * © 2025 Segelferd. All rights reserved.
 */

importScripts('./storage.js', './kickapi.js', './utils.js');

const BADGE_ACTIVE = '#53FC18';
const BADGE_SUSPENDED = '#606060';
const BADGE_DND = '#eb0400';
const ALARM_NAME = 'kickalert-check';
const DEFAULT_INTERVAL = 60;
const MIN_ALARM_PERIOD = 0.5;
const NOTIFIED_LIVES_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

let cachedChannels = [];

// ─── Init ───

async function initialize() {
  console.log('[KickAlert] Initializing...');

  await Utils.initI18n();

  const resetOnRestart = await Storage.getResetSuspendOnRestart();
  if (resetOnRestart) await Storage.remove(StorageKeys.SUSPEND_FROM_DATE);

  await updateBadgeColor();
  await migrateAutoOpenChannels();
  await startOffscreen();
  await checkSafe();
  await scheduleAlarm();
}

async function updateBadgeColor() {
  const dndActive = await Storage.isDndActive();
  if (dndActive) {
    await chrome.action.setBadgeBackgroundColor({ color: BADGE_DND });
    return;
  }
  const suspended = !!(await Storage.getSuspendFromDate());
  await chrome.action.setBadgeBackgroundColor({ color: suspended ? BADGE_SUSPENDED : BADGE_ACTIVE });
}

async function migrateAutoOpenChannels() {
  try {
    const raw = await Storage.get(StorageKeys.AUTO_OPEN_CHANNELS);
    if (Array.isArray(raw)) {
      const migrated = {};
      raw.forEach(entry => {
        if (entry && entry.slug) migrated[entry.slug] = true;
      });
      await Storage.set(StorageKeys.AUTO_OPEN_CHANNELS, migrated);
      console.log('[KickAlert] Migrated autoOpenChannels:', migrated);
    }
  } catch (e) {
    console.warn('[KickAlert] Migration error:', e);
  }
}

// ─── Persisted State ───

async function getPersistedState() {
  const result = await chrome.storage.local.get(['_liveSlugs', '_notifiedLives', '_lastCheckDone']);
  return {
    liveSlugs: new Set(result._liveSlugs || []),
    notifiedLives: result._notifiedLives || {},
    lastCheckDone: result._lastCheckDone || false,
  };
}

async function setPersistedLiveSlugs(slugsSet) {
  await chrome.storage.local.set({ _liveSlugs: [...slugsSet] });
}

async function setPersistedNotifiedLives(map) {
  await chrome.storage.local.set({ _notifiedLives: map });
}

async function setLastCheckDone() {
  await chrome.storage.local.set({ _lastCheckDone: true });
}

// BUG 14 FIX: Reset persisted state on install/update
async function resetPersistedState() {
  await chrome.storage.local.remove(['_liveSlugs', '_notifiedLives', '_lastCheckDone']);
}

// BUG 15 FIX: Clean up old notifiedLives entries (>24h)
async function cleanupNotifiedLives() {
  const state = await getPersistedState();
  const now = Date.now();
  const cleaned = {};
  for (const [id, url] of Object.entries(state.notifiedLives)) {
    // Extract timestamp from id: "kickalert-slug-1234567890"
    const parts = id.split('-');
    const ts = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(ts) && (now - ts) < NOTIFIED_LIVES_MAX_AGE) {
      cleaned[id] = url;
    }
  }
  if (Object.keys(cleaned).length !== Object.keys(state.notifiedLives).length) {
    await setPersistedNotifiedLives(cleaned);
  }
}

// ─── Alarm-based Check Loop ───

async function scheduleAlarm() {
  await chrome.alarms.clear(ALARM_NAME);
  const secs = await Storage.getCheckInterval();
  const clampedSecs = Math.max(secs, 30);
  const periodMinutes = Math.max(clampedSecs / 60, MIN_ALARM_PERIOD);

  chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: periodMinutes,
    periodInMinutes: periodMinutes
  });
  console.log(`[KickAlert] Alarm scheduled — every ${clampedSecs}s (${periodMinutes.toFixed(2)} min)`);
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    console.log(`[KickAlert] Alarm fired at ${new Date().toLocaleTimeString()}`);
    await cleanupNotifiedLives(); // BUG 15 FIX
    await checkSafe();
  }
});

// BUG 16 FIX: Only react to user-facing storage key changes
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  // Skip internal keys
  const internalKeys = ['_liveSlugs', '_notifiedLives', '_lastCheckDone'];
  const changedKeys = Object.keys(changes);
  if (changedKeys.every(k => internalKeys.includes(k))) return;

  if (changes[StorageKeys.CHECK_INTERVAL]) {
    console.log(`[KickAlert] Check interval changed — rescheduling alarm`);
    await scheduleAlarm();
  }
  if (changes[StorageKeys.DND_ENABLED] || changes[StorageKeys.DND_START] ||
      changes[StorageKeys.DND_END] || changes[StorageKeys.SUSPEND_FROM_DATE]) {
    await updateBadgeColor();
  }
  if (changes[StorageKeys.USER_LANGUAGE]) {
    const newLang = changes[StorageKeys.USER_LANGUAGE].newValue;
    if (newLang) {
      console.log(`[KickAlert] Language changed to ${newLang} — reloading locale`);
      await Utils.loadLocale(newLang);
    }
  }
});

// ─── Channel Check ───

async function checkSafe() {
  try { await checkChannels(); }
  catch (e) { console.error('[KickAlert] Check failed:', e); }
}

async function checkChannels() {
  const channels = await KickAPI.getAllFollowingChannels();
  cachedChannels = channels;
  const liveCount = channels.filter(c => c.isLive).length;
  await chrome.action.setBadgeText({ text: liveCount > 0 ? String(liveCount) : '' });
  await updateBadgeColor();

  const state = await getPersistedState();
  const liveChannelSlugs = state.liveSlugs;
  let notifiedLives = state.notifiedLives;

  // First run — just record, don't notify
  if (!state.lastCheckDone) {
    const currentLive = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    await setPersistedLiveSlugs(currentLive);
    await setLastCheckDone();
    console.log(`[KickAlert] First check — ${liveCount} live channels recorded`);
    return;
  }

  const showNotif = await Storage.getShowNotification();
  const suspended = !!(await Storage.getSuspendFromDate());

  const dndActive = await Storage.isDndActive();
  const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
  const dndMuteSound = dndActive && await Storage.getDndMuteSound();
  const dndMuteAutolaunch = dndActive && await Storage.getDndMuteAutolaunch();
  const soundMode = await Storage.getSoundMode();

  if (dndActive) console.log('[KickAlert] DND active — muting:', { notif: dndMuteNotif, sound: dndMuteSound, autolaunch: dndMuteAutolaunch });

  let notified = false;

  for (const ch of channels) {
    if (liveChannelSlugs.has(ch.channelSlug) || !ch.isLive) continue;

    console.log(`[KickAlert] New live: ${ch.userUsername} (${ch.channelSlug})`);

    // Always log to history
    Storage.addNotificationHistory({
      username: ch.userUsername,
      channelSlug: ch.channelSlug,
      title: ch.sessionTitle || '-',
      category: ch.categoryName || '-',
      timestamp: new Date().toISOString(),
    });

    // Channel-level sound preference: main / sub / silent / muted
    const chSoundPref = await Storage.getChannelSoundMode(ch.channelSlug);

    // Muted = no notification, no sound, only history
    if (chSoundPref === 'muted') continue;

    // Send notification (if enabled and not DND-muted)
    if (showNotif && !dndMuteNotif) {
      if (notified) await Utils.delay(5000);
      // silent flag: true when extension mode (we play our own), false when windows mode
      const isSilentNotif = soundMode === 'extension' || chSoundPref === 'silent';
      sendNotification(ch, notifiedLives, isSilentNotif);
      notified = true;
    }

    // Play sound based on channel preference
    if (!dndMuteSound && chSoundPref !== 'silent') {
      const soundType = chSoundPref === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB';
      await playSound(soundType);
    }

    // Auto-open tab (independent of sound)
    if (!suspended && !dndMuteAutolaunch) {
      if (await shouldAutoOpen(ch)) {
        await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: false });
      }
    }
  }

  const newLiveSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
  await setPersistedLiveSlugs(newLiveSlugs);
  await setPersistedNotifiedLives(notifiedLives);
}

// ─── Notification ───
// BUG 13 FIX: No longer writes to history (handled in checkChannels)
// Windows notification sound fix: silent: true — our own sound plays via offscreen

async function sendNotification(ch, notifiedLives, isSilent) {
  const id = `kickalert-${ch.channelSlug}-${Date.now()}`;
  const title = Utils.i18n('notifStartedStreaming', [ch.userUsername])
    || `${ch.userUsername} started streaming`;

  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: title,
    message: ch.sessionTitle || '-',
    silent: isSilent,
  });
  notifiedLives[id] = `https://kick.com/${ch.channelSlug}`;
}

// ─── Auto Open ───

async function shouldAutoOpen(ch) {
  const isAuto = await Storage.isAutoOpenChannel(ch.channelSlug);
  if (!isAuto) return false;
  const dupGuard = await Storage.isDuplicateTabGuard();
  if (!dupGuard) return true;

  try {
    const tabs = await chrome.tabs.query({});
    const openSlugs = tabs.map(t => {
      const m = (t.url || '').match(/^https:\/\/kick\.com\/([^/?#]+)/);
      return m ? m[1].toLowerCase() : null;
    }).filter(Boolean);
    return !openSlugs.includes(ch.channelSlug.toLowerCase());
  } catch { return true; }
}

// ─── Sound via Offscreen ───

async function startOffscreen() {
  try {
    const hasDoc = await chrome.offscreen?.hasDocument?.();
    if (hasDoc) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('html/offscreen.html'),
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Notification sounds and service worker keep-alive',
    });
  } catch (e) {
    console.warn('[KickAlert] Offscreen create error:', e.message);
  }
}

async function playSound(type) {
  // Don't play extension sound if user chose Windows notification sounds
  const soundMode = await Storage.getSoundMode();
  if (soundMode === 'windows') return;

  await startOffscreen();
  const volume = (await Storage.getSoundVolume()) / 100;
  const customFile = await Storage.getCustomSoundFile(type === 'NEW_LIVE_MAIN' ? 'main' : 'sub');
  try {
    await chrome.runtime.sendMessage({
      messageType: 'PLAY_SOUND',
      options: { sound: type, volume, customSoundFile: customFile?.dataUrl || null },
    });
  } catch (e) {
    console.warn('[KickAlert] Sound send error:', e.message);
  }
}

// ─── Events ───

chrome.notifications.onClicked.addListener(async (id) => {
  const state = await getPersistedState();
  const url = state.notifiedLives[id];
  if (url) {
    await chrome.tabs.create({ url });
    delete state.notifiedLives[id];
    await setPersistedNotifiedLives(state.notifiedLives);
  }
});

// BUG 14 FIX: Reset persisted state on install/update to avoid stale data
chrome.runtime.onInstalled.addListener(async () => {
  await resetPersistedState();
  await initialize();
});
chrome.runtime.onStartup.addListener(() => initialize());

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'GET_CHANNELS') {
    if (cachedChannels.length > 0) {
      respond({ success: true, channels: cachedChannels });
      return false;
    }
    KickAPI.getAllFollowingChannels()
      .then(channels => { cachedChannels = channels; respond({ success: true, channels }); })
      .catch(err => respond({ success: false, error: err.message }));
    return true;
  }
  if (msg.type === 'PLAY_TEST_SOUND') {
    startOffscreen().then(() => {
      playSound(msg.soundType || 'NEW_LIVE_MAIN');
    });
    respond({ success: true });
    return false;
  }
  if (msg.type === 'GET_CHANNEL_START_TIME') {
    KickAPI.getChannelStartTime(msg.slug)
      .then(startTime => respond({ success: true, startTime }))
      .catch(() => respond({ success: false }));
    return true;
  }
});

self.onmessage = () => {};
initialize();
