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
    if (d > 0) return `${d}d ago`;
    if (h > 0) return `${h}h ago`;
    const m = Math.floor(diffMs / 60000);
    return m > 0 ? `${m}m ago` : 'Just now';
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
    const saved = await Storage.getUserLanguage();
    if (saved && SUPPORTED_LANGUAGES.some(l => l.code === saved)) return saved;

    // Try browser's UI language
    const uiLang = chrome.i18n.getUILanguage();
    // Match exact (e.g. 'tr') or prefix (e.g. 'pt-BR' → 'pt_BR')
    const normalized = uiLang.replace('-', '_');
    const match = SUPPORTED_LANGUAGES.find(l =>
      l.code === normalized || l.code === uiLang.split('-')[0]
    );
    return match ? match.code : 'en';
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
