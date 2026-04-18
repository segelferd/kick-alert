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

// Sensitivity → eşik mapping
const SPIKE_THRESHOLDS = {
  min: { warn: 25,  alert: 75  },
  avg: { warn: 50,  alert: 150 },
  max: { warn: 75,  alert: 250 },
};
const DROP_THRESHOLDS = {
  min: { warn: 10, alert: 20 },
  avg: { warn: 20, alert: 35 },
  max: { warn: 30, alert: 50 },
};
let _spikeEnabled     = true;
let _spikeSensitivity = 'avg';
let _dropSensitivity  = 'avg';
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
  if (changes[StorageKeys.USER_LANGUAGE] || changes[StorageKeys.USE_BROWSER_LANGUAGE]) {
    // Either manual language choice or "use browser language" toggle changed.
    // Re-detect and reload locale. detectLanguage() reads both flags.
    try {
      const newLang = await Utils.detectLanguage();
      console.log(`[KickAlert] Language preference changed — reloading locale: ${newLang}`);
      await Utils.loadLocale(newLang);
    } catch (e) {
      console.warn('[KickAlert] Language reload failed:', e);
    }
  }
});

// ─── Channel Check ───

async function checkSafe() {
  try { await checkChannels(); }
  catch (e) { console.error('[KickAlert] Check failed:', e); }
}

// ─── Viewer Anomaly Detection ───
// ─── Viewer Anomaly Sabitleri ───
// Artış eşikleri storage'dan okunur — sabit değerler kaldırıldı
// NEW_STREAM_WINDOW kaldırıldı — STREAM_SETTLE_MS getViewerAnomaly içinde tek eşik olarak tanımlı
const PAST_AVG_MULTIPLIER_WARN  = 3;
const PAST_AVG_MULTIPLIER_ALERT = 8;
const HISTORY_CURRENT_MAX = 60;  // 30 sn aralıklı × 60 = 30 dk pencere
const HISTORY_PAST_MAX    = 10;
const ANOMALY_COOLDOWN_MS = 15 * 60 * 1000; // 15 dk cooldown
const ANOMALY_RESET_MS    = 15 * 60 * 1000; // cooldown sonrası peak/valley sıfırla
const ANOMALY_MIN_VIEWERS = 1000;            // 1K altı kanallar için anomali yok

async function updateViewerHistory(channels) {
  try {
    const history = await Storage.getViewerHistory();
    const now = Date.now();
    const liveSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));

    // Yayın biten kanallar: current -> past avg'e çevir
    for (const slug of Object.keys(history)) {
      if (!liveSlugs.has(slug)) {
        const rec = history[slug];
        if (rec && rec.current && rec.current.length >= 2) {
          const avg = Math.round(
            rec.current.reduce((s, e) => s + e.v, 0) / rec.current.length
          );
          const pastAvgs = rec.pastAvgs || [];
          pastAvgs.push(avg);
          if (pastAvgs.length > HISTORY_PAST_MAX) pastAvgs.shift();
          // Sadece pastAvgs'i koru, current + peak/valley sıfırla
          history[slug] = { current: [], pastAvgs, streamPeak: null, streamValley: null };
        } else if (rec) {
          // Yeterli veri birikmeden yayın bitti — current'ı temizle
          history[slug] = { current: [], pastAvgs: rec.pastAvgs || [], streamPeak: null, streamValley: null };
        }
      }
    }

    // Canlı kanallar: current'a yeni kayıt ekle
    for (const ch of channels) {
      if (!ch.isLive) continue;
      const slug = ch.channelSlug;
      const rec = history[slug] || { current: [], pastAvgs: [] };
      rec.current = rec.current || [];
      rec.current.push({ v: ch.viewerCount, t: now });
      if (rec.current.length > HISTORY_CURRENT_MAX) rec.current.shift();

      // Cooldown sona erdikten sonra peak/valley sıfırla — her "bölüm" kendi referansıyla değerlendirilir
      const lastRiseAlert = rec._lastRiseAlert || 0;
      const lastDropAlert = rec._lastDropAlert || 0;
      const lastAlertTime = Math.max(lastRiseAlert, lastDropAlert);
      if (lastAlertTime > 0 && now - lastAlertTime >= ANOMALY_RESET_MS) {
        // Cooldown bitti: peak ve valley bu anki değere sıfırla
        rec.streamPeak = ch.viewerCount;
        rec.streamValley = ch.viewerCount;
        rec._lastRiseAlert = 0;
        rec._lastDropAlert = 0;
      } else {
        // Yayın boyunca peak/valley güncelle
        rec.streamPeak = rec.streamPeak ? Math.max(rec.streamPeak, ch.viewerCount) : ch.viewerCount;
        rec.streamValley = rec.streamValley ? Math.min(rec.streamValley, ch.viewerCount) : ch.viewerCount;
      }
      history[slug] = rec;
    }

    await Storage.setViewerHistory(history);

    // Her check sonrası anomali tespiti — popup kapalıyken de çalışır
    await checkViewerAnomalies(channels, history);
  } catch (e) {
    console.warn('[KickAlert] viewerHistory error:', e.message);
  }
}

async function checkViewerAnomalies(channels, history) {
  try {
    const anomalySettings = await Storage.getAnomalySettings();
    if (!anomalySettings.enabled) return;

    const now = Date.now();
    let historyDirty = false;

    for (const ch of channels) {
      if (!ch.isLive || !ch.viewerCount) continue;
      if (ch.viewerCount < ANOMALY_MIN_VIEWERS) continue; // 1K altı — sus

      const chSoundPref = await Storage.getChannelSoundMode(ch.channelSlug);
      if (chSoundPref === 'muted') continue;

      const rec = history[ch.channelSlug];
      if (!rec) continue;

      // ── Artış tespiti ──
      const anomaly = _spikeEnabled ? getViewerAnomalySync(rec, ch.viewerCount, ch.startedAt, now) : null;
      if (anomaly) {
        const lastRise = rec._lastRiseAlert || 0;
        if (now - lastRise >= ANOMALY_COOLDOWN_MS) {
          console.log(`[KickAlert] Spike: ${ch.channelSlug} — ${anomaly.label}`);
          const mode = anomalySettings.notifyMode || 'both';
          if (mode === 'notif' || mode === 'both') {
            const icon = await getAvatarDataUrl(ch);
            const spikeTitle = Utils.i18n('anomalySpikeTitle') || 'Viewer spike';
            chrome.notifications.create('ka-anomaly-' + ch.channelSlug + '-' + now, {
              type: 'basic', iconUrl: icon,
              title: ch.userUsername + ' — ' + spikeTitle,
              message: anomaly.label,
            });
          }
          rec._lastRiseAlert = now;
          historyDirty = true;
        }
      }

      // ── Düşüş tespiti ──
      if (anomalySettings.dropEnabled) {
        const drop = getViewerDropSync(rec, ch.viewerCount, ch.startedAt, now, anomalySettings);
        if (drop) {
          const lastDrop = rec._lastDropAlert || 0;
          if (now - lastDrop >= ANOMALY_COOLDOWN_MS) {
            console.log(`[KickAlert] Drop: ${ch.channelSlug} — ${drop.label}`);
            const mode = anomalySettings.notifyMode || 'both';
            if (mode === 'notif' || mode === 'both') {
              const icon = await getAvatarDataUrl(ch);
              const dropTitle = Utils.i18n('anomalyDropTitle') || 'Viewer drop';
              chrome.notifications.create('ka-drop-' + ch.channelSlug + '-' + now, {
                type: 'basic', iconUrl: icon,
                title: ch.userUsername + ' — ' + dropTitle,
                message: drop.label,
              });
            }
            rec._lastDropAlert = now;
            historyDirty = true;
          }
        }
      }
    }

    if (historyDirty) await Storage.setViewerHistory(history);
  } catch (e) {
    console.warn('[KickAlert] anomaly check error:', e.message);
  }
}

const STREAM_SETTLE_MS = 15 * 60 * 1000;
const ROC_WINDOW = 4; // Rate of change: son 4 entry vs önceki 4 entry (her biri ~2 dk)
const ROC_MIN_ENTRIES = 8; // En az 8 entry gerekli (~4 dk veri)

// Ani sıçrama tespiti — sliding window rate of change
// Son ROC_WINDOW entry ortalaması vs önceki ROC_WINDOW entry ortalaması
// Hem yayın başında hem ortasında çalışır — 15 dk sınırı yok
function getRateOfChange(current) {
  if (!current || current.length < ROC_MIN_ENTRIES) return null;
  const recent = current.slice(-ROC_WINDOW);
  const prev   = current.slice(-ROC_WINDOW * 2, -ROC_WINDOW);
  const avgRecent = recent.reduce((s, e) => s + e.v, 0) / recent.length;
  const avgPrev   = prev.reduce((s, e) => s + e.v, 0) / prev.length;
  if (!avgPrev || avgPrev < 1000) return null;
  const pct = Math.round(((avgRecent - avgPrev) / avgPrev) * 100);
  const windowMin = Math.round((recent[recent.length-1].t - prev[0].t) / 60000);
  return { pct, avgRecent: Math.round(avgRecent), avgPrev: Math.round(avgPrev), windowMin };
}

// Sync versiyon — checkViewerAnomalies'de history zaten yüklü
function getViewerAnomalySync(rec, currentCount, streamStartedAt, now) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null; // yeterli veri yok — sus

    const { warn: warnThreshold, alert: alertThreshold } = SPIKE_THRESHOLDS[_spikeSensitivity] || SPIKE_THRESHOLDS.avg;

    // ── Rate of change — her zaman aktif (ilk dk'dan itibaren) ──
    const roc = getRateOfChange(current);
    if (roc && roc.pct >= warnThreshold) {
      const level = roc.pct >= alertThreshold ? 'alert' : 'warn';
      let streamAge = streamStartedAt
        ? now - new Date(streamStartedAt).getTime()
        : now - current[0].t;
      const streamAgeMin = Math.round(streamAge / 60000);
      const ageLabel = Utils.i18n('anomalyAgeLabel', [String(streamAgeMin)]) || `${streamAgeMin} min`;
      const label = `${ageLabel} · ${formatK(roc.avgPrev)} → ${formatK(roc.avgRecent)}`;
      return { pct: roc.pct, level, label };
    }

    // ── Geniş pencere: streamValley'den bu yana toplam artış ──
    // Ani değil ama çok büyük toplam fark varsa da yakala
    const baseValue = rec.streamValley || Math.min(...current.map(e => e.v));
    if (!baseValue || baseValue < 1000) return null;
    const totalPct = Math.round(((currentCount - baseValue) / baseValue) * 100);
    if (totalPct < warnThreshold * 2) return null;

    const level = totalPct >= alertThreshold ? 'alert' : 'warn';
    let streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;
    const streamAgeMin = Math.round(streamAge / 60000);
    const ageLabel2 = Utils.i18n('anomalyAgeLabel', [String(streamAgeMin)]) || `${streamAgeMin} min`;
    return { pct: totalPct, level,
      label: `${ageLabel2} · ${formatK(baseValue)} → ${formatK(currentCount)}` };
  } catch { return null; }
}

// Async wrapper — popup mesaj handler için
async function getViewerAnomaly(slug, currentCount, streamStartedAt) {
  try {
    const history = await Storage.getViewerHistory();
    return getViewerAnomalySync(history[slug], currentCount, streamStartedAt, Date.now());
  } catch { return null; }
}

function formatK(n) {
  if (n >= 10000) return Math.round(n / 1000) + 'K';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';  // 3.6K — hassas gösterim
  return String(n);
}

function getViewerDropSync(rec, currentCount, streamStartedAt, now, anomalySettings) {
  try {
    if (!rec) return null;

    const current = rec.current || [];
    if (current.length < ROC_MIN_ENTRIES) return null;

    const { warn: warnThreshold, alert: alertThreshold } = DROP_THRESHOLDS[_dropSensitivity] || DROP_THRESHOLDS.avg;

    // ── Rate of change — ani düşüş tespiti ──
    const roc = getRateOfChange(current);
    if (roc && roc.pct <= -warnThreshold) {
      const absPct = Math.abs(roc.pct);
      const level = absPct >= alertThreshold ? 'alert' : 'warn';
      let streamAge = streamStartedAt
        ? now - new Date(streamStartedAt).getTime()
        : now - current[0].t;
      // İlk 15 dk'da düşüş alarmı verme — yayın başında organik dalgalanma olabilir
      if (streamAge < STREAM_SETTLE_MS) return null;
      const streamAgeMin = Math.round(streamAge / 60000);
      const ageLabel = Utils.i18n('anomalyAgeLabel', [String(streamAgeMin)]) || `${streamAgeMin} min`;
      const label = `${ageLabel} · ${formatK(roc.avgPrev)} → ${formatK(roc.avgRecent)}`;
      return { pct: absPct, level, label };
    }

    // ── Geniş pencere: streamPeak'ten toplam düşüş ──
    const peak = rec.streamPeak || Math.max(...current.map(e => e.v));
    if (!peak || peak < 1000) return null;

    let streamAge = streamStartedAt
      ? now - new Date(streamStartedAt).getTime()
      : now - current[0].t;
    if (streamAge < STREAM_SETTLE_MS) return null;

    const dropPct = Math.round(((peak - currentCount) / peak) * 100);
    if (dropPct < warnThreshold * 1.5) return null; // geniş pencere için daha yüksek eşik

    const level = dropPct >= alertThreshold ? 'alert' : 'warn';
    const streamAgeMin = Math.round(streamAge / 60000);
    const ageLabel2 = Utils.i18n('anomalyAgeLabel', [String(streamAgeMin)]) || `${streamAgeMin} min`;
    return { pct: dropPct, level,
      label: `${ageLabel2} · ${formatK(peak)} → ${formatK(currentCount)}` };
  } catch { return null; }
}

async function getViewerDrop(slug, currentCount, streamStartedAt, anomalySettings) {
  try {
    const history = await Storage.getViewerHistory();
    return getViewerDropSync(history[slug], currentCount, streamStartedAt, Date.now(), anomalySettings);
  } catch { return null; }
}

let _autoLaunchTabOpened = false; // Her check döngüsünde sıfırlanır

async function checkChannels() {
  _autoLaunchTabOpened = false; // Her check başında sıfırla — ilk sekme öne gelsin
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

  // Bildirim gecikmesi — loop dışında tek seferde oku
  const notifDelay = await Storage.getNotifDelay();

  // startedAt null olan kanallar için viewerHistory tek seferlik yüklenir
  const vhData = await chrome.storage.local.get('viewerHistory');
  const vh = vhData.viewerHistory || {};

  for (const ch of channels) {
    if (liveChannelSlugs.has(ch.channelSlug) || !ch.isLive) continue;

    // Yayın eklenti session başlamadan önce mi başladı?
    if (ch.startedAt) {
      // startedAt varsa: yayın 10 dk+ önce başlamışsa atla — zaten yayındaydı
      const streamStart = new Date(ch.startedAt).getTime();
      const streamAgeMs = Date.now() - streamStart;
      if (streamAgeMs > 10 * 60 * 1000) {
        console.log(`[KickAlert] Skipping long-running live (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
        liveChannelSlugs.add(ch.channelSlug);
        continue;
      }
    } else {
      // startedAt null — yayın ne zaman başladı bilinmiyor.
      // API'den yayın başlangıcını sorgula — viewerHistory eski oturumdan kalmış olabilir
      const apiStartTime = await KickAPI.getChannelStartTime(ch.channelSlug);
      if (apiStartTime) {
        const streamStart = new Date(apiStartTime).getTime();
        const streamAgeMs = Date.now() - streamStart;
        if (streamAgeMs > 10 * 60 * 1000) {
          // Yayın 10 dk+ önce başlamış — zaten yayındaydı, atla
          console.log(`[KickAlert] Skipping long-running live API (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
          liveChannelSlugs.add(ch.channelSlug);
          continue;
        }
        // Yayın 10 dk içinde başlamış — yeni yayın, devam et
        console.log(`[KickAlert] New live confirmed via API startTime (${Math.round(streamAgeMs/60000)} min): ${ch.channelSlug}`);
      } else {
        // API'den de bilgi gelmedi — büyük ihtimalle yeni başlamış yayın (API henüz güncellenmemiş)
        // Bildirim gönder, yanlış skip'ten iyidir
        console.log(`[KickAlert] No startedAt, no API time — treating as new live: ${ch.channelSlug}`);
      }
    }

    // Bildirim gecikmesi kontrolü
    if (notifDelay > 0) {
      let streamAgeMin = null;
      if (ch.startedAt) {
        streamAgeMin = (Date.now() - new Date(ch.startedAt).getTime()) / 60000;
      } else {
        // startedAt null — API'den alınan startTime ile hesapla
        const apiTime = await KickAPI.getChannelStartTime(ch.channelSlug);
        if (apiTime) streamAgeMin = (Date.now() - new Date(apiTime).getTime()) / 60000;
      }
      if (streamAgeMin !== null && streamAgeMin < notifDelay) {
        console.log(`[KickAlert] Delay pending: ${ch.channelSlug} (${Math.round(streamAgeMin)}/${notifDelay}min)`);
        continue;
      }
    }

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
        // İlk açılan sekmeyi öne getir — Cloudflare otomatik onayı için gerekli
        // Sonraki kanallar arka planda — kullanıcı kendi geçer
        await chrome.tabs.create({ url: `https://kick.com/${ch.channelSlug}`, active: !_autoLaunchTabOpened });
        _autoLaunchTabOpened = true;
      }
    }
  }

  const newLiveSlugs = new Set(channels.filter(c => c.isLive).map(c => c.channelSlug));
  await setPersistedLiveSlugs(newLiveSlugs);
  await setPersistedNotifiedLives(notifiedLives);

  // viewerHistory'yi bildirim kararından SONRA güncelle
  // Önceden güncellenirse startedAt=null olan yeni kanallar skip edilir
  await updateViewerHistory(channels);
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
  await Utils.ensureI18n();
  const id = `kickalert-${ch.channelSlug}-${Date.now()}`;
  const title = Utils.i18n('notifStartedStreaming', [ch.userUsername])
    || `${ch.userUsername} started streaming`;
  const iconUrl = await getAvatarDataUrl(ch);

  const isFirefox = typeof browser !== 'undefined';
  const notifOptions = {
    type: 'basic',
    iconUrl: iconUrl,
    title: title,
    message: ch.sessionTitle || '-',
  };

  // Firefox doesn't support buttons or silent in notifications.create
  if (!isFirefox) {
    const btnOpen = Utils.i18n('notifButtonOpen') || 'Open';
    const btnMute = Utils.i18n('notifButtonMute') || 'Mute';
    notifOptions.silent = isSilent;
    notifOptions.buttons = [
      { title: btnOpen },
      { title: btnMute },
    ];
  }

  chrome.notifications.create(id, notifOptions);
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
  await chrome.storage.local.set({ _sessionStart: Date.now() });
  // Reset state only on fresh install or extension update, not on every browser start
  if (details.reason === 'install' || details.reason === 'update') {
    await resetPersistedState();
  }
  await initialize();
});

chrome.runtime.onStartup.addListener(async () => {
  // Tarayıcı yeniden açıldı — liveSlugs sıfırla
  const now = Date.now();
  await chrome.storage.local.remove(['_liveSlugs', '_lastCheckDone', '_initLock']);
  await chrome.storage.local.set({ _sessionStart: now });

  // viewerHistory current dizilerini temizle — anomali sistemi temiz başlasın
  // PC kapat/aç sonrası eski current verisi kalıyor → sahte anomali gösterimi
  try {
    const vhData = await chrome.storage.local.get('viewerHistory');
    const vh = vhData.viewerHistory || {};
    let changed = false;
    for (const slug of Object.keys(vh)) {
      if (vh[slug].current && vh[slug].current.length > 0) {
        vh[slug].current = [];
        vh[slug].streamPeak = null;
        vh[slug].streamValley = null;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ viewerHistory: vh });
  } catch (e) {
    console.warn('[KickAlert] Failed to clear viewerHistory on startup:', e);
  }

  initialize();
});

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
  if (msg.type === 'SET_ANOMALY_SETTINGS') {
    _spikeEnabled     = msg.settings?.spikeEnabled !== false;
    _spikeSensitivity = msg.settings?.spikeSensitivity || 'avg';
    _dropSensitivity  = msg.settings?.dropSensitivity  || 'avg';
    respond({ success: true });
    return false;
  }

  if (msg.type === 'GET_VIEWER_HISTORY') {
    Storage.getViewerHistory()
      .then(history => respond({ success: true, history: history[msg.slug] || null }))
      .catch(() => respond({ success: true, history: null }));
    return true;
  }

  if (msg.type === 'GET_VIEWER_ANOMALY') {
    getViewerAnomaly(msg.slug, msg.viewerCount, msg.startedAt)
      .then(anomaly => respond({ success: true, anomaly }))
      .catch(() => respond({ success: true, anomaly: null }));
    return true;
  }

  if (msg.type === 'GET_VIEWER_DROP') {
    Storage.getAnomalySettings()
      .then(settings => getViewerDrop(msg.slug, msg.viewerCount, msg.startedAt, settings))
      .then(drop => respond({ success: true, drop }))
      .catch(() => respond({ success: true, drop: null }));
    return true;
  }

  if (msg.type === 'CHAT_TAG_NOTIFICATION') {
    (async () => {
      try {
        await Utils.ensureI18n();
        const isFirefox = typeof browser !== 'undefined';
        const fromUser = msg.fromUser || 'Someone';
        const channel = msg.channel || '';
        const message = msg.message || '';

        const title = Utils.i18n('chatTagNotifTitle', [fromUser]) || `@${fromUser} sizi etiketledi`;
        const body = (channel ? `[${channel}] ` : '') + message;

        const id = `kickalert-tag-${Date.now()}`;
        const notifOptions = {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: title,
          message: body.substring(0, 200),
        };
        if (!isFirefox) {
          notifOptions.silent = false;
          if (channel) {
            notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
          }
        }

        chrome.notifications.create(id, notifOptions);

        // Track for click handling — reuse notifiedLives structure
        if (channel) {
          const state = await getPersistedState();
          state.notifiedLives[id] = {
            url: `https://kick.com/${channel}`,
            slug: channel,
            isTag: true,
          };
          await setPersistedNotifiedLives(state.notifiedLives);
        }

        respond({ success: true });
      } catch (e) {
        console.warn('[KickAlert] CHAT_TAG_NOTIFICATION error:', e);
        respond({ success: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CHAT_BROADCASTER_NOTIFICATION') {
    (async () => {
      try {
        await Utils.ensureI18n();
        const isFirefox = typeof browser !== 'undefined';
        const fromUser = msg.fromUser || '';
        const channel = msg.channel || '';
        const message = msg.message || '';

        const title = Utils.i18n('chatBroadcasterNotifTitle', [fromUser || channel])
                      || `${fromUser || channel} wrote`;
        const body = message;

        const id = `kickalert-broadcaster-${Date.now()}`;
        const notifOptions = {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: title,
          message: body.substring(0, 200),
        };
        if (!isFirefox) {
          notifOptions.silent = false;
          if (channel) {
            notifOptions.buttons = [{ title: Utils.i18n('notifButtonOpen') || 'Open' }];
          }
        }

        chrome.notifications.create(id, notifOptions);

        if (channel) {
          const state = await getPersistedState();
          state.notifiedLives[id] = {
            url: `https://kick.com/${channel}`,
            slug: channel,
            isBroadcaster: true,
          };
          await setPersistedNotifiedLives(state.notifiedLives);
        }

        respond({ success: true });
      } catch (e) {
        console.warn('[KickAlert] CHAT_BROADCASTER_NOTIFICATION error:', e);
        respond({ success: false, error: e.message });
      }
    })();
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

  // ─── E2E Test: Gerçek akışı simüle et ───
  if (msg.type === 'E2E_TEST') {
    (async () => {
      const results = [];
      const log = (step, status, detail) => results.push({ step, status, detail });

      try {
        // 1. API'den kanal listesi çek
        log('API Fetch', 'running', 'getAllFollowingChannels() çağrılıyor...');
        let channels;
        try {
          channels = await KickAPI.getAllFollowingChannels();
          log('API Fetch', 'ok', `${channels.length} kanal döndü, ${channels.filter(c => c.isLive).length} canlı`);
        } catch (e) {
          log('API Fetch', 'error', e.message);
          respond({ success: false, results });
          return;
        }

        // 2. Belirli kanalı bul (varsa)
        const targetSlug = msg.slug || null;
        const liveChannels = channels.filter(c => c.isLive);
        let targetCh = null;
        if (targetSlug) {
          targetCh = channels.find(c => c.channelSlug === targetSlug);
          if (!targetCh) {
            log('Kanal Bulma', 'error', `"${targetSlug}" takip listesinde yok`);
          } else {
            log('Kanal Bulma', 'ok', `${targetCh.userUsername} — isLive: ${targetCh.isLive}, startedAt: ${targetCh.startedAt || 'null'}, viewers: ${targetCh.viewerCount}`);
          }
        } else {
          log('Kanal Listesi', 'ok', liveChannels.map(c => `${c.userUsername}(${c.viewerCount})`).join(', ') || 'Canlı kanal yok');
        }

        // 3. State kontrol
        const state = await getPersistedState();
        log('State', 'ok', `liveSlugs: ${state.liveSlugs.size}, notifiedLives: ${Object.keys(state.notifiedLives).length}, lastCheckDone: ${state.lastCheckDone}`);

        // 4. Belirli kanal için karar simülasyonu
        if (targetCh) {
          const inLiveSlugs = state.liveSlugs.has(targetCh.channelSlug);
          log('liveSlugs Check', inLiveSlugs ? 'warn' : 'ok',
            inLiveSlugs ? `${targetSlug} liveSlugs'da VAR → "zaten canlı" sayılır, bildirim GİTMEZ` : `${targetSlug} liveSlugs'da YOK → yeni yayın adayı`);

          if (!inLiveSlugs && targetCh.isLive) {
            // startedAt kontrolü
            if (targetCh.startedAt) {
              const streamAgeMs = Date.now() - new Date(targetCh.startedAt).getTime();
              const ageMin = Math.round(streamAgeMs / 60000);
              if (streamAgeMs > 10 * 60 * 1000) {
                log('startedAt Check', 'warn', `Yayın ${ageMin} dk önce başlamış (>10dk) → SKIP`);
              } else {
                log('startedAt Check', 'ok', `Yayın ${ageMin} dk önce başlamış (<10dk) → BİLDİRİM GİDER`);
              }
            } else {
              // API'den startTime sorgula
              log('startedAt', 'warn', 'startedAt null — API sorgulanıyor...');
              const apiTime = await KickAPI.getChannelStartTime(targetCh.channelSlug);
              if (apiTime) {
                const streamAgeMs = Date.now() - new Date(apiTime).getTime();
                const ageMin = Math.round(streamAgeMs / 60000);
                log('API startTime', ageMin > 10 ? 'warn' : 'ok',
                  `API startTime: ${apiTime} (${ageMin} dk) → ${ageMin > 10 ? 'SKIP' : 'BİLDİRİM GİDER'}`);
              } else {
                log('API startTime', 'ok', 'API startTime null — yeni yayın sayılır → BİLDİRİM GİDER');
              }
            }

            // notifDelay kontrolü
            const notifDelay = await Storage.getNotifDelay();
            log('notifDelay', 'ok', `Gecikme ayarı: ${notifDelay} dk`);

            // DND kontrolü
            const dndActive = await Storage.isDndActive();
            const dndMuteNotif = dndActive && await Storage.getDndMuteNotif();
            log('DND', dndActive ? 'warn' : 'ok',
              dndActive ? `DND AKTİF — bildirim susturma: ${dndMuteNotif}` : 'DND kapalı');

            // Bildirim ayarı
            const showNotif = await Storage.getShowNotification();
            log('Bildirim Ayarı', showNotif ? 'ok' : 'warn',
              showNotif ? 'Bildirimler açık' : 'Bildirimler KAPALI — bildirim gitmez');

            // Suspend kontrolü
            const suspended = !!(await Storage.getSuspendFromDate());
            log('Suspend', suspended ? 'warn' : 'ok',
              suspended ? 'Eklenti askıda — bildirim gitmez' : 'Eklenti aktif');

            // i18n kontrolü
            await Utils.ensureI18n();
            const lang = Utils.getCurrentLang();
            const testTitle = Utils.i18n('notifStartedStreaming', [targetCh.userUsername]);
            log('i18n', 'ok', `Dil: ${lang} — Bildirim metni: "${testTitle}"`);

            // Auto-launch kontrolü
            const autoOpen = await Storage.getAutoOpenChannels();
            const isAutoLaunch = !!(autoOpen && autoOpen[targetCh.channelSlug]);
            log('Auto-Launch', 'ok', isAutoLaunch ? `${targetSlug} auto-launch AÇIK` : `${targetSlug} auto-launch kapalı`);

            // Anomali kontrolü
            const anomalySettings = await Storage.getAnomalySettings();
            log('Anomali', 'ok', `Anomali: ${anomalySettings.enabled ? 'açık' : 'kapalı'}, Spike: ${anomalySettings.spikeSensitivity}, Drop: ${anomalySettings.dropEnabled ? anomalySettings.dropSensitivity : 'kapalı'}`);
          }
        }

        // 5. viewerHistory durumu
        const vhData = await chrome.storage.local.get('viewerHistory');
        const vh = vhData.viewerHistory || {};
        const vhKeys = Object.keys(vh);
        const vhSummary = vhKeys.slice(0, 5).map(s => `${s}(c:${(vh[s].current||[]).length},p:${(vh[s].pastAvgs||[]).length})`).join(', ');
        log('viewerHistory', 'ok', `${vhKeys.length} kanal: ${vhSummary}${vhKeys.length > 5 ? '...' : ''}`);

        respond({ success: true, results });
      } catch (e) {
        log('Genel Hata', 'error', e.message + ' — ' + e.stack?.split('\n')[1]?.trim());
        respond({ success: false, results });
      }
    })();
    return true;
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

// ─── Test Panel ───
// Sadece geliştirici konsolundan erişilebilir
// background context konsoluna: openTestPanel() yaz
self.openTestPanel = function() {
  const url = chrome.runtime.getURL('html/test.html') + '?key=Temmuz2014';
  chrome.tabs.create({ url, active: true });
  console.log('[KickAlert] Test panel açıldı');
};
