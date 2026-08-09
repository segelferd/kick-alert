/**
 * KickAlert - Storage Module
 * Handles all chrome.storage.local operations with optional cloud sync.
 * © 2025–2026 Segelferd. All rights reserved.
 */

const StorageKeys = {
  SHOW_NOTIFICATION: 'showNotification',
  SOUND_VOLUME: 'soundVolume',
  SUSPEND_FROM_DATE: 'suspendFromDate',
  RESET_SUSPEND_ON_RESTART: 'resetSuspendOnRestart',
  DUPLICATE_TAB_GUARD: 'duplicateTabGuard',
  AUTO_OPEN_CHANNELS: 'autoOpenChannels',
  AUTO_UNMUTE: 'autoUnmute',
  CHECK_INTERVAL: 'checkInterval',
  NOTIFICATION_HISTORY: 'notificationHistory',
  SHOW_OFFLINE_CHANNELS: 'showOfflineChannels',
  AUTO_REFRESH_POPUP: 'autoRefreshPopup',
  CUSTOM_SOUND_MAIN: 'customSoundMain',
  CUSTOM_SOUND_SUB: 'customSoundSub',
  USER_LANGUAGE: 'userLanguage',
  USE_BROWSER_LANGUAGE: 'useBrowserLanguage',
  DND_ENABLED: 'dndEnabled',
  DND_START: 'dndStart',
  DND_END: 'dndEnd',
  DND_MUTE_NOTIF: 'dndMuteNotif',
  DND_MUTE_SOUND: 'dndMuteSound',
  DND_MUTE_AUTOLAUNCH: 'dndMuteAutolaunch',
  SOUND_MODE: 'soundMode',
  CHANNEL_SOUND_MODE: 'channelSoundMode',
  FAVORITE_CHANNELS: 'favoriteChannels',
  CLOUD_SYNC_ENABLED: 'cloudSyncEnabled',
  THEME: 'theme', // 'dark' or 'light'
  CHANNEL_GROUPS: 'channelGroups', // ['Türk yayıncılar', 'FPS', ...]
  CHANNEL_GROUP_MAP: 'channelGroupMap', // { slug: 'groupName' }
  VIEWER_HISTORY: 'viewerHistory',   // { slug: [{v, t}, ...] }
  ANOMALY_SETTINGS: 'anomalySettings',
  NOTIF_DELAY: 'notifDelay',            // dakika: 0,5,10,15
  AUTO_OPEN_DELAY: 'autoOpenDelay',     // v2.3.5: WS sonrası tab açma gecikmesi (sn): 3,5,7,9
  FOLLOW_SORT_BY: 'followSortBy',       // v2.3.5: follow tab sıralama: kick|alphabetic|liveTime|viewers
  FOLLOW_SORT_DIR: 'followSortDir',     // v2.3.5: yön: asc|desc
  CHAT_INTEGRATION_ENABLED: 'chatIntegrationEnabled',
  CHAT_SETTINGS: 'chatSettings',        // { filterBlur, botFilter, botList, emojiFilter, repeatFilter, wordFilterEnabled, wordList, userFilterEnabled, userList, keywordEnabled, keywordList, favEnabled, favList, tagEnabled, tagUsername, broadcasterNotif }
  // v2.3.0: Bot tracker
  BOT_TRACKER_ENABLED: 'botTrackerEnabled',  // master toggle
  BOT_TRACKER_NOTIFY: 'botTrackerNotify',    // skor bildirimde göster (default false)
  BOT_SCORE_ALWAYS_VISIBLE: 'botScoreAlwaysVisible',  // popup'ta her zaman göster (default false — sadece anomaly'de)
  CHATROOM_ID_CACHE: '_chatroomIdCache',      // { slug: chatroomId, ... } — internal
  BOT_SCORES: '_botScores',                   // { slug: { score, msgPerMin, ratio, computedAt }, ... } — internal
};

// Keys that should NOT be synced (too large, device-specific, or internal)
const SYNC_EXCLUDE_KEYS = new Set([
  StorageKeys.CUSTOM_SOUND_MAIN,       // base64 audio, MB size
  StorageKeys.CUSTOM_SOUND_SUB,        // base64 audio, MB size
  StorageKeys.NOTIFICATION_HISTORY,     // grows large, device-specific
  StorageKeys.SUSPEND_FROM_DATE,        // device-specific runtime state
  StorageKeys.CLOUD_SYNC_ENABLED,      // meta — each device decides independently
  StorageKeys.VIEWER_HISTORY,          // grows very large (60 entries × N channels)
  StorageKeys.ANOMALY_SETTINGS,        // device-specific sensitivity prefs
  StorageKeys.CHATROOM_ID_CACHE,       // v2.3.0: internal API cache
  StorageKeys.BOT_SCORES,              // v2.3.0: runtime calculated, no need to sync
  '_liveSlugs', '_notifiedLives', '_lastCheckDone', // internal state
]);

const StorageDefaults = {
  [StorageKeys.SHOW_NOTIFICATION]: true,
  [StorageKeys.SOUND_VOLUME]: 80,
  [StorageKeys.RESET_SUSPEND_ON_RESTART]: false,
  [StorageKeys.DUPLICATE_TAB_GUARD]: true,
  [StorageKeys.AUTO_OPEN_CHANNELS]: {},
  [StorageKeys.AUTO_UNMUTE]: false,
  [StorageKeys.CHECK_INTERVAL]: 60,
  [StorageKeys.NOTIFICATION_HISTORY]: [],
  [StorageKeys.SHOW_OFFLINE_CHANNELS]: false,
  [StorageKeys.AUTO_REFRESH_POPUP]: false,
  // v2.3.0: Bot tracker — default açık (Chrome only)
  [StorageKeys.BOT_TRACKER_ENABLED]: true,
  [StorageKeys.BOT_TRACKER_NOTIFY]: false,
  [StorageKeys.BOT_SCORE_ALWAYS_VISIBLE]: false,
  [StorageKeys.CHATROOM_ID_CACHE]: {},
  [StorageKeys.BOT_SCORES]: {},
};

let _syncEnabled = false;
let _syncListenerAttached = false;

const Storage = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    if (result[key] !== undefined) return result[key];
    return StorageDefaults[key] !== undefined ? StorageDefaults[key] : undefined;
  },

  async set(key, value) {
    // v2.1.0: storage.local.set quota aşımı veya başka hata atabilir.
    // Eklentinin çökmesini engellemek için sarıldı; hata olursa warn'la
    // ve sessizce devam et (eski veri korunur).
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch (e) {
      console.warn('[KickAlert] Storage write failed:', key, e.message);
      return; // sync'e de yazma anlamsız — vazgeç
    }
    // Mirror to sync if enabled and key is syncable
    if (_syncEnabled && !SYNC_EXCLUDE_KEYS.has(key) && !key.startsWith('_')) {
      try { await chrome.storage.sync.set({ [key]: value }); }
      catch (e) { console.warn('[KickAlert] Sync write failed:', key, e.message); }
    }
  },

  async remove(key) {
    await chrome.storage.local.remove(key);
    if (_syncEnabled && !SYNC_EXCLUDE_KEYS.has(key) && !key.startsWith('_')) {
      try { await chrome.storage.sync.remove(key); }
      catch (e) { console.warn('[KickAlert] Sync remove failed:', key, e.message); }
    }
  },

  // ─── Cloud Sync ───

  async getCloudSyncEnabled() {
    return (await this.get(StorageKeys.CLOUD_SYNC_ENABLED)) || false;
  },

  async setCloudSyncEnabled(enabled) {
    _syncEnabled = enabled;
    await chrome.storage.local.set({ [StorageKeys.CLOUD_SYNC_ENABLED]: enabled });
    if (enabled) {
      this._listenForSyncChanges();
      // v2.3.7 FIX: Önceden burada SADECE _pushAllToSync() çağrılıyordu —
      // bu, yeni/temiz bir cihazda (yerel depolama boş) switch açıldığında,
      // buluttaki GERÇEK ayarları hiç okumadan, boş/varsayılan yerel veriyi
      // buluta yazıp mevcut bulut verisini SİLİYORDU. Şimdi önce buluttan
      // çekiyoruz (varsa gerçek veriyi yerel'e uyguluyoruz), SONRA push
      // ediyoruz (yerelde olup buluta hiç gitmemiş anahtarları ekliyoruz).
      // Sonuç: iki yönlü, veri kaybetmeyen bir birleştirme.
      await this.pullFromSync();
      await this._pushAllToSync();
    }
  },

  /**
   * v2.3.7: Manuel "Şimdi Senkronize Et" — kullanıcının popup'tan tetikleyebildiği,
   * açma/kapama switch'inden BAĞIMSIZ bir buton. Aynı güvenli sırayı izler:
   * önce pull (buluttaki başka cihaz değişikliklerini al), sonra push (yerelde
   * olup buluta gitmemiş anahtarları tamamla). Sync kapalıyken çağrılırsa
   * hiçbir şey yapmadan bunu bildirir.
   */
  async syncNow() {
    if (!_syncEnabled) {
      return { success: false, reason: 'disabled' };
    }
    try {
      await this.pullFromSync();
      await this._pushAllToSync();
      return { success: true };
    } catch (e) {
      console.warn('[KickAlert] syncNow failed:', e.message);
      return { success: false, reason: 'error', message: e.message };
    }
  },

  async initSyncState() {
    _syncEnabled = await this.getCloudSyncEnabled();
    if (_syncEnabled) {
      this._listenForSyncChanges();
    }
  },

  /** Push all syncable local settings to chrome.storage.sync */
  async _pushAllToSync() {
    const allLocal = await chrome.storage.local.get(null);
    const toSync = {};
    for (const [key, value] of Object.entries(allLocal)) {
      if (!SYNC_EXCLUDE_KEYS.has(key) && !key.startsWith('_')) {
        toSync[key] = value;
      }
    }
    try {
      await chrome.storage.sync.set(toSync);
      console.debug('[KickAlert] Cloud sync: pushed', Object.keys(toSync).length, 'keys');
    } catch (e) {
      console.warn('[KickAlert] Cloud sync push failed:', e.message);
    }
  },

  /** Pull all sync data and apply to local (for initial sync on new device) */
  async pullFromSync() {
    if (!_syncEnabled) return;
    try {
      const syncData = await chrome.storage.sync.get(null);
      const toLocal = {};
      for (const [key, value] of Object.entries(syncData)) {
        if (!SYNC_EXCLUDE_KEYS.has(key) && !key.startsWith('_')) {
          toLocal[key] = value;
        }
      }
      if (Object.keys(toLocal).length > 0) {
        await chrome.storage.local.set(toLocal);
        console.debug('[KickAlert] Cloud sync: pulled', Object.keys(toLocal).length, 'keys');
      }
    } catch (e) {
      console.warn('[KickAlert] Cloud sync pull failed:', e.message);
    }
  },

  /** Listen for changes from other devices via chrome.storage.sync */
  _listenForSyncChanges() {
    if (_syncListenerAttached) return;
    _syncListenerAttached = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync' || !_syncEnabled) return;
      const toLocal = {};
      for (const [key, { newValue }] of Object.entries(changes)) {
        if (!SYNC_EXCLUDE_KEYS.has(key) && !key.startsWith('_') && newValue !== undefined) {
          toLocal[key] = newValue;
        }
      }
      if (Object.keys(toLocal).length > 0) {
        chrome.storage.local.set(toLocal);
        console.debug('[KickAlert] Cloud sync: received', Object.keys(toLocal).length, 'keys from another device');
      }
    });
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

  async getCheckInterval() { return this.get(StorageKeys.CHECK_INTERVAL); },
  async setCheckInterval(v) { return this.set(StorageKeys.CHECK_INTERVAL, v); },

  async getNotificationHistory() { return this.get(StorageKeys.NOTIFICATION_HISTORY); },
  async addNotificationHistory(entry) {
    const history = await this.getNotificationHistory();
    history.unshift(entry);
    if (history.length > 100) history.length = 100;
    return this.set(StorageKeys.NOTIFICATION_HISTORY, history);
  },

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
  async getUseBrowserLanguage() { const v = await this.get(StorageKeys.USE_BROWSER_LANGUAGE); return v !== false; }, // default true
  async setUseBrowserLanguage(v) { return this.set(StorageKeys.USE_BROWSER_LANGUAGE, v); },

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
  async getAllChannelSoundModes() {
    // channelSoundMode key'inde { slug: mode } formatında saklanıyor
    return (await this.get(StorageKeys.CHANNEL_SOUND_MODE)) || {};
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

  async getFavoriteChannels() {
    return (await this.get(StorageKeys.FAVORITE_CHANNELS)) || {};
  },
  async isFavoriteChannel(slug) {
    const favs = await this.getFavoriteChannels();
    return favs[slug] === true;
  },
  async toggleFavoriteChannel(slug) {
    const favs = await this.getFavoriteChannels();
    if (favs[slug]) {
      delete favs[slug];
    } else {
      favs[slug] = true;
    }
    await this.set(StorageKeys.FAVORITE_CHANNELS, favs);
    return !!favs[slug];
  },

  async getTheme() { return (await this.get(StorageKeys.THEME)) || 'dark'; },
  async setTheme(v) { return this.set(StorageKeys.THEME, v); },

  // ─── Channel Groups ───
  async getChannelGroups() { return (await this.get(StorageKeys.CHANNEL_GROUPS)) || []; },
  async setChannelGroups(groups) { return this.set(StorageKeys.CHANNEL_GROUPS, groups); },
  async addChannelGroup(name) {
    const groups = await this.getChannelGroups();
    if (!groups.includes(name)) groups.push(name);
    return this.setChannelGroups(groups);
  },
  async removeChannelGroup(name) {
    let groups = await this.getChannelGroups();
    groups = groups.filter(g => g !== name);
    await this.setChannelGroups(groups);
    // Also unassign channels from deleted group
    const map = await this.getChannelGroupMap();
    for (const slug of Object.keys(map)) {
      if (map[slug] === name) delete map[slug];
    }
    return this.set(StorageKeys.CHANNEL_GROUP_MAP, map);
  },
  async getChannelGroupMap() { return (await this.get(StorageKeys.CHANNEL_GROUP_MAP)) || {}; },
  async getChannelGroup(slug) {
    const map = await this.getChannelGroupMap();
    return map[slug] || null;
  },
  async setChannelGroup(slug, groupName) {
    const map = await this.getChannelGroupMap();
    if (groupName) {
      map[slug] = groupName;
    } else {
      delete map[slug];
    }
    return this.set(StorageKeys.CHANNEL_GROUP_MAP, map);
  },

  /**
   * Check if current time is within DND hours.
   */
  // ─── Viewer Anomaly History ───
  // v2.3.5: notifDelay UI'ı kaldırıldı, davranış her zaman "Hemen" (0).
  // Backward compatibility: getter her zaman 0 döner, setter no-op.
  // (Eski kullanıcının storage'da 5/10/15 değeri olsa bile yok sayılır.)
  async getNotifDelay() { return 0; },
  async setNotifDelay() { /* no-op: UI kaldırıldı */ },

  // v2.3.5: WS → tab açma güvenlik gecikmesi (saniye). İzinli: 3, 5, 7, 9.
  // Default 5 (yeni kullanıcılar için). Mevcut kullanıcının ayarı kaydedildiyse
  // o ayar korunur — sadece hiç set edilmemişse 5'e düşer.
  async getAutoOpenDelay() {
    const v = await this.get(StorageKeys.AUTO_OPEN_DELAY);
    return [3, 5, 7, 9].includes(v) ? v : 5;
  },
  async setAutoOpenDelay(v) {
    if (![3, 5, 7, 9].includes(v)) v = 5; // güvenlik: sadece izinli değerler
    return this.set(StorageKeys.AUTO_OPEN_DELAY, v);
  },

  // v2.3.5: Follow tab sıralama tercihi
  // by: 'kick' (varsayılan, Kick API sırası) | 'alphabetic' | 'liveTime' | 'viewers'
  // dir: 'asc' | 'desc'
  async getFollowSort() {
    const by = await this.get(StorageKeys.FOLLOW_SORT_BY);
    const dir = await this.get(StorageKeys.FOLLOW_SORT_DIR);
    return {
      by: ['kick', 'alphabetic', 'liveTime', 'viewers'].includes(by) ? by : 'kick',
      dir: ['asc', 'desc'].includes(dir) ? dir : 'desc',
    };
  },
  async setFollowSort(by, dir) {
    if (by) await this.set(StorageKeys.FOLLOW_SORT_BY, by);
    if (dir) await this.set(StorageKeys.FOLLOW_SORT_DIR, dir);
  },


  async getAnomalySettings() {
    const stored = await this.get(StorageKeys.ANOMALY_SETTINGS);
    return Object.assign({ enabled: false, spikeEnabled: true, spikeSensitivity: 'avg', notifyMode: 'both', dropEnabled: false, dropSensitivity: 'avg' }, stored || {});
  },
  async setAnomalySettings(obj) { return this.set(StorageKeys.ANOMALY_SETTINGS, obj); },

  async getViewerHistory() {
    return (await this.get('viewerHistory')) || {};
  },
  async setViewerHistory(obj) {
    return this.set('viewerHistory', obj);
  },

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

  // ─── Chat Integration ───

  async getChatIntegrationEnabled() {
    return (await this.get(StorageKeys.CHAT_INTEGRATION_ENABLED)) || false;
  },

  async setChatIntegrationEnabled(enabled) {
    await chrome.storage.local.set({ [StorageKeys.CHAT_INTEGRATION_ENABLED]: enabled });
  },

  async getChatSettings() {
    const stored = await this.get(StorageKeys.CHAT_SETTINGS);
    const merged = Object.assign({
      filterBlur: false,       // false = hide, true = blur
      botFilter: false,
      botList: ['Nightbot', 'StreamElements', 'Moobot', 'Fossabot', 'KickBot'],
      emojiFilter: false,
      emojiThreshold: 5,
      repeatFilter: false,
      repeatWindow: 60,
      repeatThreshold: 3,
      // Per-category switches (v1.9.10+). Existing lists with data auto-migrate to enabled.
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
    }, stored || {});

    // ─── Migration for existing users (v1.9.10 chat panel upgrade) ───
    // If a user already has list items but no explicit enabled flag stored, auto-enable.
    // Only runs once — after first save, stored flags win.
    if (stored) {
      const migrations = [
        ['wordFilterEnabled', 'wordList'],
        ['userFilterEnabled', 'userList'],
        ['keywordEnabled', 'keywordList'],
        ['favEnabled', 'favList'],
        ['tagEnabled', 'tagUsername'],
      ];
      let migrated = false;
      for (const [flag, listKey] of migrations) {
        if (stored[flag] === undefined) {
          const v = stored[listKey];
          const hasData = Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim());
          if (hasData) {
            merged[flag] = true;
            migrated = true;
          }
        }
      }
      if (migrated) {
        // Persist migrated flags so this runs only once
        try { await chrome.storage.local.set({ [StorageKeys.CHAT_SETTINGS]: merged }); } catch (_) {}
      }
    }

    return merged;
  },

  async setChatSettings(settings) {
    await chrome.storage.local.set({ [StorageKeys.CHAT_SETTINGS]: settings });
  },

  async updateChatSetting(key, value) {
    const current = await this.getChatSettings();
    current[key] = value;
    await this.setChatSettings(current);
    return current;
  },

  // ─── v2.3.0: Bot Tracker ───

  async getBotTrackerEnabled() {
    return this.get(StorageKeys.BOT_TRACKER_ENABLED);
  },
  async setBotTrackerEnabled(v) {
    return this.set(StorageKeys.BOT_TRACKER_ENABLED, v);
  },

  async getBotTrackerNotify() {
    return this.get(StorageKeys.BOT_TRACKER_NOTIFY);
  },
  async setBotTrackerNotify(v) {
    return this.set(StorageKeys.BOT_TRACKER_NOTIFY, v);
  },

  // v2.3.0: Bot skoru popup'ta her zaman görünsün mü (default false)
  async getBotScoreAlwaysVisible() {
    return this.get(StorageKeys.BOT_SCORE_ALWAYS_VISIBLE);
  },
  async setBotScoreAlwaysVisible(v) {
    return this.set(StorageKeys.BOT_SCORE_ALWAYS_VISIBLE, v);
  },

  // chatroom_id cache: { slug → chatroomId }
  async getChatroomIdCache() {
    return (await this.get(StorageKeys.CHATROOM_ID_CACHE)) || {};
  },
  async getChatroomId(slug) {
    const cache = await this.getChatroomIdCache();
    return cache[slug] || null;
  },
  async setChatroomId(slug, chatroomId) {
    const cache = await this.getChatroomIdCache();
    cache[slug] = chatroomId;
    await this.set(StorageKeys.CHATROOM_ID_CACHE, cache);
  },

  // v2.3.1 Plan F: channel_id cache (slug → channelId) — Pusher subscribe için.
  // Pusher 'channel.{channel_id}' format kullanır; bu chatroomId'den farklı.
  async getChannelIdCache() {
    return (await this.get('channelIdCache')) || {};
  },
  async getChannelId(slug) {
    const cache = await this.getChannelIdCache();
    return cache[slug] || null;
  },
  async setChannelId(slug, channelId) {
    const cache = await this.getChannelIdCache();
    cache[slug] = channelId;
    await this.set('channelIdCache', cache);
  },

  // bot scores: { slug → { score, msgPerMin, ratio, computedAt } }
  async getBotScores() {
    return (await this.get(StorageKeys.BOT_SCORES)) || {};
  },
  async getBotScore(slug) {
    const scores = await this.getBotScores();
    return scores[slug] || null;
  },
  async setBotScore(slug, scoreData) {
    const scores = await this.getBotScores();
    scores[slug] = scoreData;
    await this.set(StorageKeys.BOT_SCORES, scores);
  },
  async removeBotScore(slug) {
    const scores = await this.getBotScores();
    delete scores[slug];
    await this.set(StorageKeys.BOT_SCORES, scores);
  },
};
