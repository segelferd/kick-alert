/**
 * KickAlert - Utility Functions
 * © 2025 Segelferd. All rights reserved.
 */

const SUPPORTED_LANGUAGES = [
  { code: 'en',    label: 'GB', name: 'English' },
  { code: 'tr',    label: 'TR', name: 'Türkçe' },
  { code: 'de',    label: 'DE', name: 'Deutsch' },
  { code: 'fr',    label: 'FR', name: 'Français' },
  { code: 'es',    label: 'ES', name: 'Español' },
  { code: 'pt_BR', label: 'PT', name: 'Português' },
  { code: 'ar',    label: 'SA', name: 'العربية' },
  { code: 'ja',    label: 'JP', name: '日本語' },
  { code: 'ko',    label: 'KR', name: '한국어' },
  { code: 'ru',    label: 'RU', name: 'Русский' },
  { code: 'it',    label: 'IT', name: 'Italiano' },
  { code: 'zh_CN', label: 'CN', name: '中文' },
  { code: 'cs',    label: 'CZ', name: 'Čeština' },
];

// Cache for loaded locale messages
let _localeMessages = null;
let _currentLang = null;

const Utils = {
  formatViewers(count) {
    if (count == null) return '0';
    if (count < 1000) return String(count);
    if (count < 1000000) {
      const k = count / 1000;
      return k % 1 === 0 ? `${k}K` : `${k.toFixed(1)}K`;
    }
    const m = count / 1000000;
    return m % 1 === 0 ? `${m}M` : `${m.toFixed(1)}M`;
  },

  formatDuration(startedAt) {
    if (!startedAt) return '';
    let isoStr = String(startedAt).trim();
    // Normalize: "2026-03-15 17:28:25" → "2026-03-15T17:28:25Z"
    if (!isoStr.includes('T')) isoStr = isoStr.replace(' ', 'T');
    if (!isoStr.endsWith('Z') && !isoStr.includes('+')) isoStr += 'Z';
    const startMs = new Date(isoStr).getTime();
    if (isNaN(startMs)) return '';
    const diffMs = Date.now() - startMs;
    if (diffMs < 0) return '';
    const mins = Math.floor(diffMs / 60000);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  },

  formatTimestamp(iso) {
    const diffMs = Date.now() - new Date(iso).getTime();
    const h = Math.floor(diffMs / 3600000);
    const d = Math.floor(h / 24);
    if (d > 0) return Utils.i18n('timeAgoDay', [String(d)]) || `${d}d ago`;
    if (h > 0) return Utils.i18n('timeAgoHour', [String(h)]) || `${h}h ago`;
    const m = Math.floor(diffMs / 60000);
    if (m > 0) return Utils.i18n('timeAgoMin', [String(m)]) || `${m}m ago`;
    return Utils.i18n('timeAgoJustNow') || 'Just now';
  },

  /**
   * Custom i18n — reads from loaded locale JSON, falls back to chrome.i18n.
   * Supports $1, $2 substitution like Chrome i18n.
   */
  i18n(key, subs) {
    // Try custom loaded messages first
    if (_localeMessages && _localeMessages[key]) {
      let msg = _localeMessages[key].message || key;
      if (subs && Array.isArray(subs)) {
        subs.forEach((s, i) => { msg = msg.replace(`$${i + 1}`, s); });
      }
      return msg;
    }
    // Fallback to Chrome's built-in i18n
    return chrome.i18n.getMessage(key, subs) || key;
  },

  /**
   * Detect best language: user preference > browser UI language > 'en'
   */
  async detectLanguage() {
    const useBrowser = await Storage.getUseBrowserLanguage();

    if (!useBrowser) {
      // Manuel mod: kayıtlı kullanıcı tercihi varsa kullan
      const saved = await Storage.getUserLanguage();
      if (saved && SUPPORTED_LANGUAGES.some(l => l.code === saved)) return saved;
    }

    // Tarayıcı dili (default davranış)
    const uiLang = chrome.i18n.getUILanguage();
    const normalized = uiLang.replace('-', '_');
    const match = SUPPORTED_LANGUAGES.find(l =>
      l.code === normalized || l.code === uiLang.split('-')[0]
    );
    return match ? match.code : 'en';
  },

  getBrowserLangName() {
    const uiLang = chrome.i18n.getUILanguage();
    const normalized = uiLang.replace('-', '_');
    const match = SUPPORTED_LANGUAGES.find(l =>
      l.code === normalized || l.code === uiLang.split('-')[0]
    );
    return match ? match.name : null; // null = desteklenmiyor, EN fallback
  },

  /**
   * Load locale messages JSON for the given language code.
   */
  async loadLocale(langCode) {
    if (_currentLang === langCode && _localeMessages) return;
    try {
      const url = chrome.runtime.getURL(`_locales/${langCode}/messages.json`);
      const res = await fetch(url);
      _localeMessages = await res.json();
      _currentLang = langCode;
    } catch (e) {
      console.warn(`[KickAlert] Failed to load locale: ${langCode}`, e);
      // Fallback to English
      if (langCode !== 'en') {
        await Utils.loadLocale('en');
      }
    }
  },

  /**
   * Initialize i18n: detect language, load messages.
   */
  async initI18n() {
    const lang = await this.detectLanguage();
    await this.loadLocale(lang);
    return lang;
  },

  /**
   * Ensure i18n is loaded AND matches current user preference.
   * Called before using i18n() in background contexts where SW may have slept
   * or where user may have switched language since init.
   * The loadLocale() call is no-op if the target language is already cached.
   */
  async ensureI18n() {
    try {
      const lang = await this.detectLanguage();
      await this.loadLocale(lang);
    } catch (e) {
      // If anything fails, fall back to English
      if (!_localeMessages) {
        await this.loadLocale('en');
      }
    }
  },

  getCurrentLang() {
    return _currentLang || 'en';
  },

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  },

  extractSlugFromUrl(url) {
    const m = url.match(/^https:\/\/kick\.com\/([^/?#]+)/);
    return m ? m[1].toLowerCase() : null;
  },
};

/**
 * ════════════════════════════════════════════════════════════════════════════
 * KLog — KickAlert Merkezi Logging Sistemi (v2.3.5+)
 * ════════════════════════════════════════════════════════════════════════════
 *
 * AMAÇ: Her log satırı 4 bilgi taşır:
 *   1. ZAMAN  — HH:MM:SS.mmm (ms hassasiyetinde)
 *   2. SEVİYE — ERROR/WARN/INFO/DEBUG/TRACE (renkli ikon)
 *   3. ADRES  — KATEGORI-STEPNUM (örn: PUSH-16) → koddaki katman+adım
 *   4. MESAJ  — okunabilir açıklama
 *
 * SEVİYELER (sırası: severity yüksekten düşüğe):
 *   ERROR (🔴) — exception, kalıcı hata. HER ZAMAN görünür (prod dahil).
 *   WARN  (🟡) — beklenmedik ama kurtarılan durum. HER ZAMAN görünür.
 *   INFO  (🔵) — önemli olay: yayın yakalandı, tab açıldı. HER ZAMAN görünür.
 *   DEBUG (⚪) — detaylı akış: state değişim, ayar okuma. _debugMode açıksa.
 *   TRACE (🔍) — çok ince detay: interval, hesaplama. _traceMode açıksa.
 *
 * KATEGORİLER (alt sistemler):
 *   BOOT  — service worker başlangıç, importScripts, alarm kurulumu
 *   PUSH  — Pusher WebSocket akışı (handlePusherLiveEvent)
 *   POLL  — Polling akışı (checkChannels)
 *   NOTIF — Bildirim, ses, history
 *   TAB   — Auto-open, sekme açma
 *   API   — Kick API çağrıları (fetchKick, getAllFollowingChannels)
 *   BOT   — Bot tracker
 *   STATE — Persisted state, storage, cache
 *   AUTH  — Session, cookie, OAuth
 *   CHAT  — Chat panel
 *
 * ADRES (STEP-ID) ŞEMASI:
 *   {KATEGORI}-{NUM}  →  örn: PUSH-16  =  Pusher akışının 16. adımı
 *
 * KULLANIM:
 *   KLog.info('PUSH-10', `${slug} → event alındı`);
 *   KLog.debug('PUSH-12', `duplicate check`, { liveSlugs: state.liveSlugs.size });
 *   KLog.warn('API-82', `403 backoff aktif, ${ms}ms bekle`);
 *   KLog.error('PUSH-99', 'unexpected error', err);
 *
 *   const t = KLog.timer();
 *   ... iş ...
 *   KLog.info('PUSH-16', `gecikme bitti (${t.ms()}ms)`);
 *
 * KONTROL:
 *   chrome.storage.local.set({ _debugMode: true })   // DEBUG seviyesi aç
 *   chrome.storage.local.set({ _traceMode: true })   // TRACE seviyesi aç
 *   chrome.storage.local.set({ _debugMode: false, _traceMode: false })  // sessiz
 * ════════════════════════════════════════════════════════════════════════════
 */
const KLog = (() => {
  let DEBUG = false;
  let TRACE = false;

  // Ayarları storage'dan oku (service worker uyandığında)
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.get(['_debugMode', '_traceMode']).then(r => {
      DEBUG = !!r._debugMode;
      TRACE = !!r._traceMode;
    }).catch(() => {});
    chrome.storage.onChanged?.addListener((changes) => {
      if (changes._debugMode) DEBUG = !!changes._debugMode.newValue;
      if (changes._traceMode) TRACE = !!changes._traceMode.newValue;
    });
  }

  function ts() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  }

  // Renkli prefix formatlama (Chrome DevTools %c stil destekli)
  function fmt(level, icon, color, addr, msg, ...rest) {
    const prefix = `%c[${ts()}] ${icon} ${level.padEnd(5)} %c[${addr.padEnd(8)}]%c ${msg}`;
    const baseStyle = `color:${color};font-weight:bold`;
    const addrStyle = `color:#9c88ff;font-weight:bold`;
    const msgStyle  = `color:inherit;font-weight:normal`;
    return [prefix, baseStyle, addrStyle, msgStyle, ...rest];
  }

  return {
    // ── Seviyeler ──
    error(addr, msg, ...extra) {
      console.error(...fmt('ERROR', '🔴', '#FF6B6B', addr, msg), ...extra);
    },
    warn(addr, msg, ...extra) {
      console.warn(...fmt('WARN', '🟡', '#FFD93D', addr, msg), ...extra);
    },
    info(addr, msg, ...extra) {
      console.log(...fmt('INFO', '🔵', '#53FC18', addr, msg), ...extra);
    },
    debug(addr, msg, ...extra) {
      if (!DEBUG && !TRACE) return;
      console.log(...fmt('DEBUG', '⚪', '#AAAAAA', addr, msg), ...extra);
    },
    trace(addr, msg, ...extra) {
      if (!TRACE) return;
      console.log(...fmt('TRACE', '🔍', '#6c7280', addr, msg), ...extra);
    },

    // ── Timer yardımcısı (timing bug'ları için) ──
    timer() {
      const start = performance.now();
      return {
        ms: () => Math.round(performance.now() - start),
        s: () => ((performance.now() - start) / 1000).toFixed(2),
      };
    },

    // ── Durum sorguları ──
    isDebug: () => DEBUG,
    isTrace: () => TRACE,

    // ── Eski dbg() köprüsü (geçiş için, hep DEBUG seviyesinde) ──
    legacy(...args) {
      if (!DEBUG && !TRACE) return;
      console.debug(...args);
    },
  };
})();
