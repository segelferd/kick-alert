/**
 * KickAlert - Storage Module
 * Handles all chrome.storage.local operations.
 * © 2025 Segelferd. All rights reserved.
 */

const StorageKeys = {
  SHOW_NOTIFICATION: 'showNotification',
  SOUND_VOLUME: 'soundVolume',
  SUSPEND_FROM_DATE: 'suspendFromDate',
  RESET_SUSPEND_ON_RESTART: 'resetSuspendOnRestart',
  DUPLICATE_TAB_GUARD: 'duplicateTabGuard',
  AUTO_OPEN_CHANNELS: 'autoOpenChannels',
  AUTO_UNMUTE: 'autoUnmute',
  ONLY_SWITCH_CHANNELS: 'onlySwitchChannels',
  CHECK_INTERVAL: 'checkInterval',
  NOTIFICATION_HISTORY: 'notificationHistory',
  SILENT_FOR_OTHERS: 'silentForOthers',
  SHOW_OFFLINE_CHANNELS: 'showOfflineChannels',
  AUTO_REFRESH_POPUP: 'autoRefreshPopup',
  CUSTOM_SOUND_MAIN: 'customSoundMain',
  CUSTOM_SOUND_SUB: 'customSoundSub',
  USER_LANGUAGE: 'userLanguage',
  DND_ENABLED: 'dndEnabled',
  DND_START: 'dndStart',
  DND_END: 'dndEnd',
  DND_MUTE_NOTIF: 'dndMuteNotif',
  DND_MUTE_SOUND: 'dndMuteSound',
  DND_MUTE_AUTOLAUNCH: 'dndMuteAutolaunch',
  SOUND_MODE: 'soundMode', // 'extension' or 'windows'
  CHANNEL_SOUND_MODE: 'channelSoundMode', // { slug: 'main'|'sub'|'silent' }
};

const StorageDefaults = {
  [StorageKeys.SHOW_NOTIFICATION]: true,
  [StorageKeys.SOUND_VOLUME]: 80,
  [StorageKeys.RESET_SUSPEND_ON_RESTART]: false,
  [StorageKeys.DUPLICATE_TAB_GUARD]: true,
  [StorageKeys.AUTO_OPEN_CHANNELS]: {},
  [StorageKeys.AUTO_UNMUTE]: false,
  [StorageKeys.ONLY_SWITCH_CHANNELS]: false,
  [StorageKeys.CHECK_INTERVAL]: 60,
  [StorageKeys.NOTIFICATION_HISTORY]: [],
  [StorageKeys.SILENT_FOR_OTHERS]: false,
  [StorageKeys.SHOW_OFFLINE_CHANNELS]: false,
  [StorageKeys.AUTO_REFRESH_POPUP]: false,
};

const Storage = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    if (result[key] !== undefined) return result[key];
    return StorageDefaults[key] !== undefined ? StorageDefaults[key] : undefined;
  },

  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },

  async remove(key) {
    await chrome.storage.local.remove(key);
  },

  async getShowNotification() { return this.get(StorageKeys.SHOW_NOTIFICATION); },
  async setShowNotification(v) { return this.set(StorageKeys.SHOW_NOTIFICATION, v); },

  async getSoundVolume() { return this.get(StorageKeys.SOUND_VOLUME); },
  async setSoundVolume(v) { return this.set(StorageKeys.SOUND_VOLUME, v); },

  async getSuspendFromDate() { return this.get(StorageKeys.SUSPEND_FROM_DATE); },
  async setSuspendFromDate(v) { return this.set(StorageKeys.SUSPEND_FROM_DATE, v); },

  async getResetSuspendOnRestart() { return this.get(StorageKeys.RESET_SUSPEND_ON_RESTART); },
  async setResetSuspendOnRestart(v) { return this.set(StorageKeys.RESET_SUSPEND_ON_RESTART, v); },

  async isDuplicateTabGuard() { return this.get(StorageKeys.DUPLICATE_TAB_GUARD); },
  async setDuplicateTabGuard(v) { return this.set(StorageKeys.DUPLICATE_TAB_GUARD, v); },

  async getAutoOpenChannels() { return this.get(StorageKeys.AUTO_OPEN_CHANNELS); },
  async isAutoOpenChannel(slug) {
    const channels = await this.getAutoOpenChannels();
    return channels[slug] === true;
  },
  async setAutoOpenChannel(slug, enabled) {
    const channels = await this.getAutoOpenChannels();
    if (enabled) {
      channels[slug] = true;
    } else {
      delete channels[slug]; // BUG 11 FIX: Remove instead of storing false
    }
    return this.set(StorageKeys.AUTO_OPEN_CHANNELS, channels);
  },

  async getAutoUnmute() { return this.get(StorageKeys.AUTO_UNMUTE); },
  async setAutoUnmute(v) { return this.set(StorageKeys.AUTO_UNMUTE, v); },

  async getOnlySwitchChannels() { return this.get(StorageKeys.ONLY_SWITCH_CHANNELS); },
  async setOnlySwitchChannels(v) { return this.set(StorageKeys.ONLY_SWITCH_CHANNELS, v); },

  async getCheckInterval() { return this.get(StorageKeys.CHECK_INTERVAL); },
  async setCheckInterval(v) { return this.set(StorageKeys.CHECK_INTERVAL, v); },

  async getNotificationHistory() { return this.get(StorageKeys.NOTIFICATION_HISTORY); },
  async addNotificationHistory(entry) {
    const history = await this.getNotificationHistory();
    history.unshift(entry);
    if (history.length > 100) history.length = 100;
    return this.set(StorageKeys.NOTIFICATION_HISTORY, history);
  },

  async getSilentForOthers() { return this.get(StorageKeys.SILENT_FOR_OTHERS); },
  async setSilentForOthers(v) { return this.set(StorageKeys.SILENT_FOR_OTHERS, v); },

  async getShowOfflineChannels() { return this.get(StorageKeys.SHOW_OFFLINE_CHANNELS); },
  async setShowOfflineChannels(v) { return this.set(StorageKeys.SHOW_OFFLINE_CHANNELS, v); },

  async getAutoRefreshPopup() { return this.get(StorageKeys.AUTO_REFRESH_POPUP); },
  async setAutoRefreshPopup(v) { return this.set(StorageKeys.AUTO_REFRESH_POPUP, v); },

  async getCustomSoundFile(type) {
    return this.get(type === 'main' ? StorageKeys.CUSTOM_SOUND_MAIN : StorageKeys.CUSTOM_SOUND_SUB);
  },
  async setCustomSoundFile(type, fileName, dataUrl) {
    const key = type === 'main' ? StorageKeys.CUSTOM_SOUND_MAIN : StorageKeys.CUSTOM_SOUND_SUB;
    return this.set(key, { fileName, dataUrl });
  },
  async clearCustomSoundFile(type) {
    const key = type === 'main' ? StorageKeys.CUSTOM_SOUND_MAIN : StorageKeys.CUSTOM_SOUND_SUB;
    return this.remove(key);
  },

  async getUserLanguage() { return this.get(StorageKeys.USER_LANGUAGE); },
  async setUserLanguage(v) { return this.set(StorageKeys.USER_LANGUAGE, v); },

  async getDndEnabled() { return this.get(StorageKeys.DND_ENABLED); },
  async setDndEnabled(v) { return this.set(StorageKeys.DND_ENABLED, v); },
  async getDndStart() { return (await this.get(StorageKeys.DND_START)) || '23:00'; },
  async setDndStart(v) { return this.set(StorageKeys.DND_START, v); },
  async getDndEnd() { return (await this.get(StorageKeys.DND_END)) || '08:00'; },
  async setDndEnd(v) { return this.set(StorageKeys.DND_END, v); },
  async getDndMuteNotif() { const v = await this.get(StorageKeys.DND_MUTE_NOTIF); return v !== undefined ? v : true; },
  async setDndMuteNotif(v) { return this.set(StorageKeys.DND_MUTE_NOTIF, v); },
  async getDndMuteSound() { const v = await this.get(StorageKeys.DND_MUTE_SOUND); return v !== undefined ? v : true; },
  async setDndMuteSound(v) { return this.set(StorageKeys.DND_MUTE_SOUND, v); },
  async getDndMuteAutolaunch() { return this.get(StorageKeys.DND_MUTE_AUTOLAUNCH); },
  async setDndMuteAutolaunch(v) { return this.set(StorageKeys.DND_MUTE_AUTOLAUNCH, v); },

  async getSoundMode() { return (await this.get(StorageKeys.SOUND_MODE)) || 'extension'; },
  async setSoundMode(v) { return this.set(StorageKeys.SOUND_MODE, v); },

  async getChannelSoundMode(slug) {
    const modes = (await this.get(StorageKeys.CHANNEL_SOUND_MODE)) || {};
    return modes[slug] || 'silent'; // default: silent notification
  },
  async setChannelSoundMode(slug, mode) {
    const modes = (await this.get(StorageKeys.CHANNEL_SOUND_MODE)) || {};
    if (mode === 'silent') {
      delete modes[slug]; // silent is default, don't store
    } else {
      modes[slug] = mode;
    }
    return this.set(StorageKeys.CHANNEL_SOUND_MODE, modes);
  },

  /**
   * Check if current time is within DND hours.
   */
  async isDndActive() {
    const enabled = await this.getDndEnabled();
    if (!enabled) return false;
    const start = await this.getDndStart();
    const end = await this.getDndEnd();
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    // Handle overnight range (e.g. 23:00 - 08:00)
    if (startMins <= endMins) {
      return nowMins >= startMins && nowMins < endMins;
    } else {
      return nowMins >= startMins || nowMins < endMins;
    }
  },
};
