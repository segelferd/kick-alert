/**
 * KickAlert - Background Service Worker
 * Monitors followed Kick channels, sends notifications, auto-launches streams.
 * Uses chrome.alarms API for guaranteed wake-up (MV3 service workers sleep after ~30s).
 * © 2025 Segelferd. All rights reserved.
 */

// Chrome uses service_worker (needs importScripts), Firefox uses background.scripts (auto-loaded)
if (typeof importScripts === 'function') {
  importScripts('./storage.js', './kickapi.js', './utils.js');
}

const BADGE_ACTIVE = '#53FC18';
const BADGE_SUSPENDED = '#606060';
const BADGE_DND = '#eb0400';
const ALARM_NAME = 'kickalert-check';
const DEFAULT_INTERVAL = 60;
const MIN_ALARM_PERIOD = 0.5;
const NOTIFIED_LIVES_MAX_AGE = 24 * 60 * 60 * 1000; // 24 hours

let cachedChannels = [];
const avatarCache = {}; // slug → dataUrl
const AVATAR_CACHE_MAX = 50;

// ─── Avatar Helper ───

async function getAvatarDataUrl(ch) {
  if (!ch.profilePic) return chrome.runtime.getURL('icons/icon128.png');
  const slug = ch.channelSlug;
  if (avatarCache[slug]) return avatarCache[slug];
  try {
    const resp = await fetch(ch.profilePic);
    if (!resp.ok) throw new Error(resp.status);
    const blob = await resp.blob();
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    // Evict oldest entries if cache is full
    const keys = Object.keys(avatarCache);
    if (keys.length >= AVATAR_CACHE_MAX) {
      delete avatarCache[keys[0]];
    }
    avatarCache[slug] = dataUrl;
    return dataUrl;
  } catch {
    return chrome.runtime.getURL('icons/icon128.png');
  }
}

// ─── Init ───

let _initRunning = false;

async function initialize() {
  if (_initRunning) return;
  _initRunning = true;

  // Storage-based lock: prevent duplicate init within 10s across SW restarts
  try {
    const lockData = await chrome.storage.local.get('_initLock');
    const lock = lockData._initLock || 0;
    if (Date.now() - lock < 10000) {
      console.log('[KickAlert] Init skipped — lock active');
      _initRunning = false;
      return;
    }
    await chrome.storage.local.set({ _initLock: Date.now() });
  } catch {}

  console.log('[KickAlert] Initializing...');

  try {
    await Utils.initI18n();
    await Storage.initSyncState();
    await Storage.pullFromSync();

    const resetOnRestart = await Storage.getResetSuspendOnRestart();
    if (resetOnRestart) await Storage.remove(StorageKeys.SUSPEND_FROM_DATE);

    await updateBadgeColor();
    await migrateAutoOpenChannels();
    await startOffscreen();
    await checkSafe();
    await scheduleAlarm();
  } catch (e) {
    console.warn('[KickAlert] Init error:', e.message);
  }
  _initRunning = false;
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
  await chrome.storage.local.remove(['_liveSlugs', '_notifiedLives', '_lastCheckDone', '_initLock']);
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
    await Utils.ensureI18n();
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
  // Persist channel data so popup can load instantly even if SW sleeps
  try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
  const liveCount = channels.filter(c => c.isLive).length;
  await chrome.action.setBadgeText({ text: liveCount > 0 ? String(liveCount) : '' });
  await updateBadgeColor();
  await updateDynamicTooltip(channels);

  const state = await getPersistedState();
  const liveChannelSlugs = state.liveSlugs;
  let notifiedLives = state.notifiedLives;

  // First run OR fresh startup with empty state — record current live, don't notify
  // Prevents duplicate notifications when browser starts with streams already live
  if (!state.lastCheckDone || state.liveSlugs.size === 0) {
    const currentLive = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
    await setPersistedLiveSlugs(currentLive);
    if (!state.lastCheckDone) await setLastCheckDone();
    console.log(`[KickAlert] Startup check — ${liveCount} live channels recorded, no notifications`);
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
      profilePic: ch.profilePic || '',
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
      await sendNotification(ch, notifiedLives, isSilentNotif);
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

// ─── Dynamic Tooltip ───

async function updateDynamicTooltip(channels) {
  const liveChannels = channels.filter(c => c.isLive);
  let tooltip = 'KickAlert';
  if (liveChannels.length === 0) {
    tooltip = Utils.i18n('tooltipNoLive') || 'KickAlert — No live streams';
  } else {
    const count = Utils.i18n('tooltipLiveCount', [String(liveChannels.length)])
      || `${liveChannels.length} live`;
    const lines = liveChannels
      .slice(0, 10)
      .map(c => `• ${c.userUsername}`);
    if (liveChannels.length > 10) {
      const more = Utils.i18n('tooltipMore', [String(liveChannels.length - 10)])
        || `+${liveChannels.length - 10} more`;
      lines.push(more);
    }
    tooltip = `KickAlert — ${count}\n\n${lines.join('\n')}`;
  }
  try { await chrome.action.setTitle({ title: tooltip }); } catch {}
}

// ─── Notification ───
// BUG 13 FIX: No longer writes to history (handled in checkChannels)
// Windows notification sound fix: silent: true — our own sound plays via offscreen

async function sendNotification(ch, notifiedLives, isSilent) {
  const id = `kickalert-${ch.channelSlug}-${Date.now()}`;
  const title = Utils.i18n('notifStartedStreaming', [ch.userUsername])
    || `${ch.userUsername} started streaming`;
  const iconUrl = await getAvatarDataUrl(ch);

  const btnOpen = Utils.i18n('notifButtonOpen') || 'Open';
  const btnMute = Utils.i18n('notifButtonMute') || 'Mute';

  chrome.notifications.create(id, {
    type: 'basic',
    iconUrl: iconUrl,
    title: title,
    message: ch.sessionTitle || '-',
    silent: isSilent,
    buttons: [
      { title: btnOpen },
      { title: btnMute },
    ],
  });
  notifiedLives[id] = { url: `https://kick.com/${ch.channelSlug}`, slug: ch.channelSlug };
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
  // Firefox doesn't support offscreen API — skip silently
  if (!chrome.offscreen) return;
  try {
    // hasDocument may throw "No SW" if service worker isn't fully ready
    let hasDoc = false;
    try { hasDoc = await chrome.offscreen.hasDocument(); } catch { return; }
    if (hasDoc) return;
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL('html/offscreen.html'),
      reasons: ['AUDIO_PLAYBACK'],
      justification: 'Notification sounds and service worker keep-alive',
    });
  } catch (e) {
    // "Only a single offscreen document may be created" is harmless — already exists
    if (!e.message?.includes('single offscreen')) {
      console.warn('[KickAlert] Offscreen create error:', e.message);
    }
  }
}

async function playSound(type) {
  const soundMode = await Storage.getSoundMode();
  if (soundMode === 'windows') return;

  const volume = (await Storage.getSoundVolume()) / 100;
  const customFile = await Storage.getCustomSoundFile(type === 'NEW_LIVE_MAIN' ? 'main' : 'sub');

  if (chrome.offscreen) {
    // Chrome: use offscreen document for audio
    await startOffscreen();
    try {
      await chrome.runtime.sendMessage({
        messageType: 'PLAY_SOUND',
        options: { sound: type, volume, customSoundFile: customFile?.dataUrl || null },
      });
    } catch (e) {
      console.warn('[KickAlert] Sound send error:', e.message);
    }
  } else {
    // Firefox: play audio directly in background script
    try {
      const SoundPaths = {
        NEW_LIVE_MAIN: chrome.runtime.getURL('sounds/new_live_main.mp3'),
        NEW_LIVE_SUB: chrome.runtime.getURL('sounds/new_live_sub.mp3'),
      };
      const src = customFile?.dataUrl || SoundPaths[type] || SoundPaths.NEW_LIVE_SUB;
      const audio = new Audio(src);
      audio.volume = volume;
      await audio.play();
    } catch (e) {
      console.warn('[KickAlert] Firefox audio error:', e.message);
    }
  }
}

// ─── Events ───

chrome.notifications.onClicked.addListener(async (id) => {
  if (!id.startsWith('kickalert-')) return;
  console.log(`[KickAlert] Notification body clicked: ${id}`);
  const state = await getPersistedState();
  const entry = state.notifiedLives[id];
  if (entry) {
    const url = typeof entry === 'string' ? entry : entry.url;
    await chrome.tabs.create({ url });
    chrome.notifications.clear(id);
    delete state.notifiedLives[id];
    await setPersistedNotifiedLives(state.notifiedLives);
  }
});

chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
  if (!id.startsWith('kickalert-')) return;
  console.log(`[KickAlert] Notification BUTTON ${buttonIndex} clicked: ${id}`);
  const state = await getPersistedState();
  const entry = state.notifiedLives[id];

  if (!entry) {
    console.warn(`[KickAlert] No entry found for ${id} — already cleared?`);
    return;
  }

  const url = typeof entry === 'string' ? entry : entry.url;
  const slug = typeof entry === 'string'
    ? id.replace('kickalert-', '').replace(/-\d+$/, '')
    : entry.slug;

  console.log(`[KickAlert] Button action — slug: "${slug}", index: ${buttonIndex}`);

  if (buttonIndex === 0) {
    await chrome.tabs.create({ url });
    console.log(`[KickAlert] Opened: ${slug}`);
  } else if (buttonIndex === 1) {
    await Storage.setChannelSoundMode(slug, 'muted');
    const verify = await Storage.getChannelSoundMode(slug);
    console.log(`[KickAlert] Muted: ${slug} — verified mode: ${verify}`);
  }

  chrome.notifications.clear(id);
  delete state.notifiedLives[id];
  await setPersistedNotifiedLives(state.notifiedLives);
});

// BUG 14 FIX: Reset persisted state on install/update to avoid stale data
chrome.runtime.onInstalled.addListener(async (details) => {
  // Reset state only on fresh install or extension update, not on every browser start
  if (details.reason === 'install' || details.reason === 'update') {
    await resetPersistedState();
  }
  await initialize();
});

chrome.runtime.onStartup.addListener(() => initialize());

// Fallback: SW woke from alarm. Only run if alarm already exists (was previously set up).
// Delay 200ms so onInstalled/onStartup can run first if they are also firing.
chrome.alarms.get(ALARM_NAME).then(alarm => {
  if (alarm) {
    setTimeout(() => {
      if (!_initRunning) initialize();
    }, 200);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === 'GET_CHANNELS') {
    if (cachedChannels.length > 0) {
      respond({ success: true, channels: cachedChannels });
      return false;
    }
    // RAM cache empty (SW slept) — try storage cache first, then fetch fresh
    chrome.storage.local.get(['_cachedChannels']).then(async (result) => {
      const stored = result._cachedChannels;
      if (stored?.length) {
        cachedChannels = stored;
        respond({ success: true, channels: stored, fromCache: true });
      } else {
        try {
          const channels = await KickAPI.getAllFollowingChannels();
          cachedChannels = channels;
          try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
          respond({ success: true, channels });
        } catch (err) {
          respond({ success: false, error: err.message });
        }
      }
    });
    return true;
  }
  if (msg.type === 'GET_CHANNELS_FRESH') {
    // Always fetch from API, update cache
    KickAPI.getAllFollowingChannels()
      .then(async (channels) => {
        cachedChannels = channels;
        try { await chrome.storage.local.set({ _cachedChannels: channels }); } catch {}
        respond({ success: true, channels });
      })
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
  if (msg.type === 'GET_CHANNEL_LIVE_DETAILS') {
    KickAPI.getChannelLiveDetails(msg.slug)
      .then(details => respond({ success: true, details }))
      .catch(() => respond({ success: false }));
    return true;
  }
  if (msg.type === 'TEST_NOTIFICATION') {
    // Test notification with buttons — uses first live channel or a fake one
    const testCh = cachedChannels.find(c => c.isLive) || {
      channelSlug: 'test-channel',
      userUsername: 'TestChannel',
      sessionTitle: 'Test notification — try Open & Mute buttons',
      profilePic: '',
    };
    const testNotifiedLives = {};
    sendNotification(testCh, testNotifiedLives, true);
    // Merge test entries into persisted state
    getPersistedState().then(async (state) => {
      Object.assign(state.notifiedLives, testNotifiedLives);
      await setPersistedNotifiedLives(state.notifiedLives);
    });
    respond({ success: true, channel: testCh.userUsername });
    return false;
  }
});

self.onmessage = () => {};

// Debug helper — call testNotification() from Service Worker console
self.testNotification = async function() {
  const testCh = cachedChannels.find(c => c.isLive) || {
    channelSlug: 'test-channel',
    userUsername: 'TestChannel',
    sessionTitle: 'Test notification — try Open & Mute buttons',
    profilePic: '',
  };
  const state = await getPersistedState();
  await sendNotification(testCh, state.notifiedLives, true);
  await setPersistedNotifiedLives(state.notifiedLives);
  console.log(`[KickAlert] Test notification sent for: ${testCh.userUsername}`);
};
