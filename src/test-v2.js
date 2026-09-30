// ═══════════════════════════════════════════════════════════════════════════
// KickAlert Test Paneli v2 (v2.5.61)
// test.js'in üzerine yüklenir: sekmeler, log araçları, v2.5.48+ özelliklerinin
// senaryoları (kanal olayları, raid dinleyicisi, ayar bütünlüğü, 14 dil,
// değerlendirme koşulları), elle tetikleme araçları ve canlı durum tabloları.
// Dinamik içerik innerHTML yerine DOM düğümleriyle kurulur.
// ═══════════════════════════════════════════════════════════════════════════

const TP = {
  LOCALES: ['ar', 'cs', 'de', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'pt_BR', 'ru', 'sk', 'tr', 'zh_CN'],
  RATE: { MIN_DAYS: 7, MIN_OPENS: 10, MIN_ALERTS: 3, MAX_SHOWS: 2 },
  RATE_PREF_KEYS: ['favoriteChannels', 'channelSoundMode', 'autoOpenChannels', 'channelAlertPrefs', 'channelGroupMap'],
  END_CONFIRM_MS: 150 * 1000,
  RAID_DEDUP_MS: 10 * 60 * 1000,
};

// ─── Küçük yardımcılar ───
function el(tag, props, ...children) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'title') n.title = v;
      else n.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return n;
}
function mount(id, node) {
  const box = document.getElementById(id);
  if (!box) return;
  box.replaceChildren(node);
}
function tag(text, kind) { return el('span', { class: 'tag' + (kind ? ' ' + kind : ''), text }); }
function table(headers, rows) {
  if (!rows.length) return el('div', { class: 'empty', text: 'Kayıt yok' });
  return el('div', { class: 'tbl-wrap' },
    el('table', { class: 'tbl' },
      el('thead', null, el('tr', null, headers.map(h => el('th', { text: h })))),
      el('tbody', null, rows.map(r => el('tr', null, r.map(c => (c instanceof Node && c.tagName === 'TD') ? c : el('td', null, c)))))));
}
function td(content, cls, title) { return el('td', { class: cls, title }, content); }
function ago(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return s + ' sn önce';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' dk önce';
  return Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk önce';
}
function dur(ms) {
  if (!ms || ms < 0) return '—';
  const m = Math.floor(ms / 60000);
  return m >= 60 ? Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk' : m + ' dk';
}
function hhmm(ts) {
  const d = new Date(ts);
  return isFinite(d) ? d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' }) : '—';
}
function secText(sec) {
  sec = Math.round(sec || 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h} sa ${m} dk` : (m ? `${m} dk` : `${sec} sn`);
}
function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
async function lget(keys) { return chrome.storage.local.get(keys); }
function send(msg) { return chrome.runtime.sendMessage(msg).catch(e => ({ success: false, error: e.message })); }
function out(id, text, kind) {
  const box = document.getElementById(id);
  if (!box) return;
  box.style.color = kind === 'err' ? 'var(--err)' : kind === 'warn' ? 'var(--warn)' : kind === 'ok' ? 'var(--ok)' : '';
  box.textContent = text;
}
function slugOf(id) { return (document.getElementById(id)?.value || '').trim().toLowerCase(); }

// ─── Sekmeler ───
function showView(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
  try { localStorage.setItem('ka-test-tab', name); } catch (e) {}
  if (name === 'state') renderStateTables();
}

// ─── Log araçları ───
function setupLogTools() {
  const box = document.getElementById('log');
  document.querySelectorAll('.log-filter button').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('.log-filter button').forEach(x => x.classList.toggle('active', x === b));
    box.classList.remove('f-err', 'f-warn');
    if (b.dataset.f) box.classList.add('f-' + b.dataset.f);
  }));
  document.getElementById('btn-log-clear')?.addEventListener('click', () => box.replaceChildren());
  document.getElementById('btn-log-copy')?.addEventListener('click', async () => {
    const text = [...box.children].map(d => d.textContent).join('\n');
    try { await navigator.clipboard.writeText(text); dlog('Log panoya kopyalandı (' + box.children.length + ' satır)', 'ok'); }
    catch (e) { dlog('Kopyalanamadı: ' + e.message, 'err'); }
  });
  document.getElementById('btn-log-toggle')?.addEventListener('click', (e) => {
    document.body.classList.toggle('log-collapsed');
    const icon = e.currentTarget.querySelector('.mi');
    if (icon) icon.textContent = document.body.classList.contains('log-collapsed') ? 'expand_less' : 'expand_more';
  });
}

// ─── Takip edilen kanallar (datalist) ───
async function fillFollowedList() {
  const { _cachedChannels } = await lget('_cachedChannels');
  const list = document.getElementById('followed-slugs');
  if (!list || !Array.isArray(_cachedChannels)) return;
  const sorted = [..._cachedChannels].sort((a, b) => (b.isLive ? 1 : 0) - (a.isLive ? 1 : 0));
  list.replaceChildren(...sorted.map(c => el('option', { value: c.channelSlug, text: (c.isLive ? '● ' : '') + (c.userUsername || c.channelSlug) })));
}

// ═══════════════════════════════════════════════════════════════════════════
// YENİ SENARYOLAR
// ═══════════════════════════════════════════════════════════════════════════

SCENARIOS.pusher = {
  title: 'Plan F bildirim akışı',
  msgType: 'PUSHER_E2E_TEST',
  payload: () => ({ dryRun: true }),
};

SCENARIOS.channelEvents = {
  title: 'Kanal olayları uçtan uca',
  msgType: 'RUN_SCENARIO_CHANNEL_EVENTS',
  payload: () => ({}),
};

SCENARIOS.raidTracker = {
  title: 'Raid dinleyicisi',
  run: async () => {
    const t0 = Date.now();
    const results = [];
    const log = (step, status, detail) => results.push({ step, status, detail });
    const d = await lget(['channelAlertPrefs', '_cachedChannels']);
    const prefs = d.channelAlertPrefs || {};
    const cached = Array.isArray(d._cachedChannels) ? d._cachedChannels : [];
    const raidSlugs = Object.keys(prefs).filter(s => prefs[s]?.raid);
    const liveRaid = raidSlugs.filter(s => cached.some(c => c.channelSlug === s && c.isLive));
    log('Raid açık kanallar', raidSlugs.length ? 'ok' : 'warn',
      raidSlugs.length ? `${raidSlugs.length} kanal: ${raidSlugs.slice(0, 8).join(', ')}${raidSlugs.length > 8 ? '…' : ''}` : 'Hiçbir kanalda "raid gelince" açık değil; dinleyici çalışmaz (normal)');
    log('Şu an canlı olanlar', 'ok', liveRaid.length ? liveRaid.join(', ') : 'Raid açık kanallardan canlı olan yok');
    const st = await send({ type: 'GET_BOT_TRACKER_STATUS' });
    if (!st?.success) {
      log('Dinleyici modülü', st?.available === false ? 'error' : 'warn', st?.reason || st?.error || 'Yanıt yok');
    } else {
      log('Platform', 'ok', st.platform === 'firefox-local' ? 'Firefox (arka planda)' : 'Chrome (offscreen belge)');
      log('Bot skoru ana anahtarı', 'ok', st.masterToggleEnabled ? 'Açık: tam mod (skor + raid)' : 'Kapalı: sadece raid modu (raid açık kanalları dinler)');
      if (liveRaid.length) {
        log('Dinleyici çalışıyor mu', st.offscreenRunning ? 'ok' : 'error',
          st.offscreenRunning ? 'Çalışıyor; raid olayları yakalanır' : 'Raid açık canlı kanal var ama dinleyici KAPALI; raid kaçar');
      } else {
        log('Dinleyici çalışıyor mu', 'ok', st.offscreenRunning ? 'Çalışıyor' : 'Beklemede (dinlenecek canlı kanal yok)');
      }
    }
    const { _raidSeen } = await lget('_raidSeen');
    const lastRaids = Object.entries(_raidSeen || {}).sort((a, b) => b[1] - a[1]);
    log('Son raid bildirimi', 'ok', lastRaids.length ? `${lastRaids[0][0]} · ${ago(lastRaids[0][1])}` : 'Son 10 dk içinde yok');
    return { success: true, results, totalMs: Date.now() - t0 };
  },
};

SCENARIOS.settingsIntegrity = {
  title: 'Ayar bütünlüğü',
  run: async () => {
    const t0 = Date.now();
    const results = [];
    const log = (step, status, detail) => results.push({ step, status, detail });
    const d = await lget(['channelAlertPrefs', '_cachedChannels', '_channelMeta', '_endPending', '_watchTime', 'notificationHistory', 'adBlockEnabled', 'watchTimeEnabled', '_raidSeen']);

    // 1) Dışa/içe aktarma anahtarları
    if (typeof EXPORTABLE_SETTINGS_KEYS === 'undefined') {
      log('Dışa aktarma listesi', 'warn', 'EXPORTABLE_SETTINGS_KEYS okunamadı');
    } else {
      const need = [StorageKeys.CHANNEL_ALERT_PREFS, StorageKeys.WATCH_TIME_ENABLED, StorageKeys.EVENT_SOUND, StorageKeys.EVENT_SOUND_VOLUME];
      const miss = need.filter(k => !EXPORTABLE_SETTINGS_KEYS.includes(k));
      log('Dışa aktarma listesi', miss.length ? 'error' : 'ok',
        miss.length ? `Eksik: ${miss.join(', ')} (yedekte kaybolur)` : 'Kanal bildirim tercihleri, izleme süresi ve olay sesi ayarları yedeğe dahil');
    }

    // 2) Kanal tercihlerinin biçimi
    const prefs = d.channelAlertPrefs || {};
    const bad = [];
    for (const [slug, p] of Object.entries(prefs)) {
      if (!p || typeof p !== 'object') { bad.push(slug); continue; }
      for (const k of ['change', 'end', 'raid']) if (k in p && typeof p[k] !== 'boolean') bad.push(`${slug}.${k}`);
      for (const k of ['cats', 'words']) if (k in p && (!Array.isArray(p[k]) || p[k].some(x => typeof x !== 'string' || !x.trim()))) bad.push(`${slug}.${k}`);
    }
    log('Kanal tercihleri biçimi', bad.length ? 'error' : 'ok',
      bad.length ? `Bozuk kayıt: ${bad.join(', ')}` : `${Object.keys(prefs).length} kanal kaydı geçerli`);

    // 3) Takipten çıkılmış kanallarda kalan tercih
    const cached = Array.isArray(d._cachedChannels) ? d._cachedChannels : [];
    const followed = new Set(cached.map(c => c.channelSlug));
    if (followed.size) {
      const orphan = Object.keys(prefs).filter(s => !followed.has(s));
      log('Takip dışı tercih', orphan.length ? 'warn' : 'ok',
        orphan.length ? `Artık takip edilmeyen kanalda tercih var: ${orphan.join(', ')}` : 'Tüm tercihler takip edilen kanallarda');
    } else {
      log('Takip dışı tercih', 'warn', 'Kanal listesi önbellekte yok; kontrol atlandı');
    }

    // 4) Değişim takibi kapsaması
    const meta = d._channelMeta || {};
    const liveChange = cached.filter(c => c.isLive && prefs[c.channelSlug]?.change).map(c => c.channelSlug);
    const notTracked = liveChange.filter(s => !meta[s] || meta[s].off);
    log('Değişim takibi kapsaması', notTracked.length ? 'warn' : 'ok',
      liveChange.length
        ? (notTracked.length ? `Canlı ama henüz kayıt yok: ${notTracked.join(', ')} (bir sonraki kontrolde kaydedilir; sürerse hata)` : `${liveChange.length} canlı kanal takipte`)
        : 'Değişim açık canlı kanal yok');
    const staleMeta = Object.entries(meta).filter(([, m]) => !m.off && Date.now() - (m.at || 0) > 60 * 60 * 1000).map(([s]) => s);
    log('Takip tazeliği', staleMeta.length ? 'warn' : 'ok',
      staleMeta.length ? `60 dk'dır taze veri gelmeyen: ${staleMeta.join(', ')} (Cloudflare engeli olabilir)` : 'Canlı kayıtların hepsi son 60 dk içinde güncellendi');
    const noStart = Object.entries(meta).filter(([s, m]) => !m.off && !m.s && (prefs[s]?.change || prefs[s]?.end)).map(([s]) => s);
    log('Yayın başlangıcı', noStart.length ? 'warn' : 'ok',
      noStart.length ? `Başlangıç saati alınamayan: ${noStart.join(', ')} (yayın bitti bildirimi süresiz gelir)` : 'Değişim/bitiş açık kanalların başlangıç saati biliniyor');

    // 5) Yayın bitti adayları
    const endP = d._endPending || {};
    const oldEnd = Object.entries(endP).filter(([, c]) => Date.now() - c.since > 30 * 60 * 1000).map(([s]) => s);
    log('Yayın bitti adayları', oldEnd.length ? 'warn' : 'ok',
      oldEnd.length ? `30 dk'dan eski aday: ${oldEnd.join(', ')} (düşmüş olmalıydı)` : `${Object.keys(endP).length} aday, süresi dolmuş yok`);

    // 6) İzleme süresi verisi
    const days = d._watchTime?.days || {};
    const badDays = Object.keys(days).filter(k => !/^\d{4}-\d{2}-\d{2}$/.test(k) || Object.values(days[k] || {}).some(v => typeof v !== 'number' || v < 0));
    const oldest = Object.keys(days).sort()[0];
    const tooOld = oldest && (Date.now() - new Date(oldest + 'T00:00:00').getTime()) > 36 * 86400000;
    log('İzleme süresi verisi', badDays.length ? 'error' : (tooOld ? 'warn' : 'ok'),
      badDays.length ? `Bozuk gün: ${badDays.join(', ')}` : (tooOld ? `35 günden eski kayıt duruyor (${oldest})` : `${Object.keys(days).length} günlük kayıt · ayar ${d.watchTimeEnabled === false ? 'KAPALI' : 'açık'}`));

    // 7) Bildirim geçmişi
    const hist = Array.isArray(d.notificationHistory) ? d.notificationHistory : [];
    const k = { live: 0, end: 0, raid: 0, filtered: 0 };
    hist.forEach(e => { if (e.kind === 'end') k.end++; else if (e.kind === 'raid') k.raid++; else k.live++; if (e.filtered) k.filtered++; });
    log('Bildirim geçmişi', 'ok', `${hist.length} kayıt · canlı ${k.live} · bitti ${k.end} · raid ${k.raid} · filtrelenen ${k.filtered}`);
    const testLeft = hist.filter(e => e.channelSlug === '__katest__').length;
    if (testLeft) log('Test kalıntısı', 'warn', `Geçmişte ${testLeft} test kaydı kaldı`);

    // 8) Depolama
    try {
      const bytes = await chrome.storage.local.getBytesInUse(null);
      log('Yerel depolama', bytes > 8 * 1024 * 1024 ? 'warn' : 'ok', fmtBytes(bytes));
    } catch (e) {
      log('Yerel depolama', 'ok', 'Boyut bu tarayıcıda ölçülemiyor');
    }
    // v2.5.63: kanal olayı sesi
    const evSound = await Storage.getEventSound();
    const evVol = await Storage.getEventSoundVolume();
    const evNames = { soft: 'Yumuşak damla', chime: 'Hafif çan', tick: 'Tık', windows: 'Windows bildirim sesi', silent: 'Sessiz' };
    log('Kanal olayı sesi', 'ok', `${evNames[evSound]}${['silent', 'windows'].includes(evSound) ? '' : ' · seviye %' + evVol}${evSound === 'windows' ? ' (sadece sistem sesi)' : ' (sistem sesi kapalı istenir)'}`);
    // v2.5.66: bulut senkronu
    const syncOn = await Storage.getCloudSyncEnabled();
    const { _syncPending, _syncIssues } = await lget(['_syncPending', '_syncIssues']);
    const pend = Object.keys(_syncPending || {}), iss = Object.entries(_syncIssues || {});
    log('Bulut senkronu', !syncOn ? 'ok' : (iss.length ? 'warn' : (pend.length ? 'warn' : 'ok')),
      !syncOn ? 'Kapalı (ayarlar sadece bu cihazda)'
        : iss.length ? `8 KB sınırını aşan: ${iss.map(([k, b]) => k + ' ' + fmtBytes(b)).join(', ')} (bu cihazda korunuyor, diğer cihazlara gitmiyor)`
        : pend.length ? `Buluta yazılmayı bekleyen: ${pend.join(', ')} (bir sonraki uyanışta tekrar denenir)`
        : 'Açık, bekleyen yazım yok');
    log('Reklam engelleme', 'ok', d.adBlockEnabled ? 'Açık (deneysel)' : 'Kapalı');
    return { success: true, results, totalMs: Date.now() - t0 };
  },
};

SCENARIOS.i18n = {
  title: '14 dil tutarlılığı',
  run: async () => {
    const t0 = Date.now();
    const results = [];
    const log = (step, status, detail) => results.push({ step, status, detail });
    const load = async (loc) => (await fetch(chrome.runtime.getURL(`_locales/${loc}/messages.json`))).json();
    const ph = (m) => ((m || '').match(/\$\d/g) || []).sort().join(',');
    let en;
    try { en = await load('en'); } catch (e) { log('en', 'error', 'Okunamadı: ' + e.message); return { success: true, results }; }
    const enKeys = Object.keys(en);
    log('Kaynak (en)', 'ok', `${enKeys.length} anahtar`);
    const uiLang = chrome.i18n.getUILanguage();
    for (const loc of TP.LOCALES.filter(l => l !== 'en')) {
      try {
        const m = await load(loc);
        const keys = Object.keys(m);
        const missing = enKeys.filter(k => !(k in m));
        const extra = keys.filter(k => !(k in en));
        const empty = keys.filter(k => !String(m[k]?.message || '').trim());
        const phBad = enKeys.filter(k => k in m && ph(en[k].message) !== ph(m[k].message));
        const probs = [];
        if (missing.length) probs.push(`eksik ${missing.length}: ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? '…' : ''}`);
        if (extra.length) probs.push(`fazla ${extra.length}: ${extra.slice(0, 3).join(', ')}`);
        if (empty.length) probs.push(`boş ${empty.length}: ${empty.slice(0, 3).join(', ')}`);
        if (phBad.length) probs.push(`yer tutucu ($1/$2) uyumsuz ${phBad.length}: ${phBad.slice(0, 3).join(', ')}`);
        log(loc, missing.length || empty.length || phBad.length ? 'error' : (extra.length ? 'warn' : 'ok'),
          probs.length ? probs.join(' · ') : `${keys.length} anahtar, sorun yok`);
      } catch (e) {
        log(loc, 'error', 'Okunamadı veya JSON bozuk: ' + e.message);
      }
    }
    log('Tarayıcı dili', 'ok', uiLang);
    return { success: true, results, totalMs: Date.now() - t0 };
  },
};

async function evaluateRatePrompt() {
  const d = await lget(['_ratePrompt', 'notificationHistory', ...TP.RATE_PREF_KEYS]);
  const st = d._ratePrompt && typeof d._ratePrompt === 'object' ? d._ratePrompt : null;
  const now = Date.now();
  const hist = Array.isArray(d.notificationHistory) ? d.notificationHistory : [];
  const alerts = hist.filter(e => !e.filtered && !e.kind).length;
  const hasPrefs = TP.RATE_PREF_KEYS.some(k => d[k] && typeof d[k] === 'object' && Object.keys(d[k]).length > 0);
  const days = st ? (now - (st.firstSeen || now)) / 86400000 : 0;
  const conds = [
    ['Durum', st ? ['rated', 'dismissed'].includes(st.state) ? false : (st.state === 'snoozed' && now < (st.snoozeUntil || 0) ? false : true) : false,
      !st ? 'Kayıt yok (popup henüz açılmamış)' :
      st.state === 'rated' ? 'Değerlendirdi, bir daha sorulmaz' :
      st.state === 'dismissed' ? 'Kapattı, bir daha sorulmaz' :
      st.state === 'snoozed' ? (now < (st.snoozeUntil || 0) ? `Ertelendi, ${new Date(st.snoozeUntil).toLocaleDateString('tr-TR')} tarihine kadar` : 'Erteleme bitti') : 'Bekliyor'],
    ['Gösterim hakkı', st ? (st.shows || 0) < TP.RATE.MAX_SHOWS : false, `${st?.shows || 0}/${TP.RATE.MAX_SHOWS} kez gösterildi`],
    ['Kullanım süresi', days >= TP.RATE.MIN_DAYS, `${days.toFixed(1)} gün (en az ${TP.RATE.MIN_DAYS})`],
    ['Popup açılışı', (st?.opens || 0) >= TP.RATE.MIN_OPENS, `${st?.opens || 0} kez (en az ${TP.RATE.MIN_OPENS})`],
    ['Ayar değiştirdi', !!st?.settingsChanged, st?.settingsChanged ? 'Evet' : 'Hayır'],
    ['Kanal tercihi', hasPrefs, hasPrefs ? 'Var (favori, ses, otomatik açma, grup veya kanal bildirimi)' : 'Yok'],
    ['Yayın bildirimi', alerts >= TP.RATE.MIN_ALERTS, `${alerts} bildirim (en az ${TP.RATE.MIN_ALERTS})`],
  ];
  return { st, conds, due: conds.every(c => c[1]) };
}

SCENARIOS.ratePrompt = {
  title: 'Değerlendirme koşulları',
  run: async () => {
    const t0 = Date.now();
    const { conds, due } = await evaluateRatePrompt();
    const results = conds.map(([step, okk, detail]) => ({ step, status: okk ? 'ok' : 'warn', detail }));
    results.push({ step: 'Sonuç', status: 'ok', detail: due
      ? 'Tüm koşullar sağlandı: bant bir sonraki popup açılışında görünür ("Yenilikler" bandı açık değilse)'
      : 'Bant görünmez; sarı adımlar eksik koşullar (hata değil)' });
    return { success: true, results, totalMs: Date.now() - t0 };
  },
};

// ─── Güvenli testlerin hepsi ───
async function runAllSafe() {
  const btn = document.getElementById('btn-run-all');
  const status = document.getElementById('run-all-status');
  const keys = [...document.querySelectorAll('.scenario-card[data-safe="1"]')].map(c => c.dataset.scenario);
  if (btn) btn.disabled = true;
  const sum = { ok: 0, warn: 0, err: 0, failed: [] };
  for (let i = 0; i < keys.length; i++) {
    if (status) status.textContent = `${i + 1}/${keys.length} · ${SCENARIOS[keys[i]]?.title || keys[i]}`;
    const r = await runScenario(keys[i]);
    if (!r) continue;
    sum.ok += r.ok; sum.warn += r.warn; sum.err += r.err;
    if (r.err) sum.failed.push(SCENARIOS[keys[i]]?.title || keys[i]);
  }
  if (btn) btn.disabled = false;
  const text = `${keys.length} senaryo · ${sum.ok} OK · ${sum.warn} uyarı · ${sum.err} hata`;
  if (status) status.textContent = text;
  dlog('▣ Toplu test bitti: ' + text + (sum.failed.length ? ' · Hatalı: ' + sum.failed.join(', ') : ''), sum.err ? 'err' : sum.warn ? 'warn' : 'ok');
}

// ═══════════════════════════════════════════════════════════════════════════
// KANAL OLAYLARI SEKMESİ
// ═══════════════════════════════════════════════════════════════════════════

async function simulateCategoryChange() {
  const slug = slugOf('chg-slug');
  if (!slug) return out('chg-out', 'Kanal gir', 'err');
  const r = await send({ type: 'SIMULATE_CATEGORY_CHANGE', slug });
  if (!r?.success) { out('chg-out', r?.error || 'Başarısız', 'err'); dlog('Değişim tetikleme: ' + (r?.error || 'başarısız'), 'err'); return; }
  out('chg-out', 'Son kategori değiştirildi, kontrol zorlanıyor…');
  const fr = await send({ type: 'FORCE_RECHECK' });
  const { _channelMeta } = await lget('_channelMeta');
  const m = (_channelMeta || {})[slug];
  if (m && m.c !== '(test) Önceki kategori' && m.n && Date.now() - m.n < 60000) {
    out('chg-out', `Bildirim gönderildi: (test) Önceki kategori → ${m.c}`, 'ok');
    dlog(`✓ ${slug} kategori değişim bildirimi gönderildi`, 'ok');
  } else if (!fr?.success) {
    out('chg-out', 'Kontrol yapılamadı (' + (fr?.error || 'backoff olabilir') + '); bir sonraki otomatik kontrolde bildirim gelir', 'warn');
  } else if (m && m.c === '(test) Önceki kategori') {
    out('chg-out', 'Bu kontrolde taze veri gelmedi (Cloudflare/backoff olabilir). Değişim beklemede; bildirim bir sonraki başarılı kontrolde gelir.', 'warn');
    dlog(`⚠ ${slug} değişim bekliyor: taze veri gelmedi`, 'warn');
  } else {
    out('chg-out', 'Değişim algılandı ama bildirim gösterilmedi. Olası sebep: kanal sessize alınmış, bildirimler kapalı veya DND. Arka plan konsolunda CHG kayıtlarına bak.', 'warn');
    dlog(`⚠ ${slug} değişim bildirimi gösterilmedi`, 'warn');
  }
}

async function simulateRaid(split) {
  const slug = slugOf('raid-slug');
  if (!slug) return out('raid-out', 'Kanal gir', 'err');
  const { channelAlertPrefs, _raidSeen } = await lget(['channelAlertPrefs', '_raidSeen']);
  if (!(channelAlertPrefs || {})[slug]?.raid) return out('raid-out', 'Bu kanalda "raid gelince" kapalı; önce popup\'tan aç', 'err');
  const seen = _raidSeen || {}; delete seen[slug];
  await chrome.storage.local.set({ _raidSeen: seen });
  const raider = document.getElementById('raid-from').value.trim() || 'TestRaider';
  const viewers = parseInt(document.getElementById('raid-viewers').value, 10);
  const message = document.getElementById('raid-msg').value.trim();
  if (split) {
    await send({ type: 'RAID_EVENT', slug, raider, viewers: null });
    await new Promise(r => setTimeout(r, 800));
  }
  await send({ type: 'RAID_EVENT', slug, raider, viewers: isFinite(viewers) ? viewers : null, message });
  out('raid-out', 'Gönderildi, 4 sn birleştirme bekleniyor…');
  await new Promise(r => setTimeout(r, 4800));
  const { notificationHistory } = await lget('notificationHistory');
  const last = (notificationHistory || []).find(e => e.kind === 'raid' && e.channelSlug === slug);
  if (last && Date.now() - new Date(last.timestamp).getTime() < 15000) {
    out('raid-out', `Bildirim: ${last.raider} → ${slug} · ${last.viewers ?? '?'} izleyici${split ? ' (iki olay tek bildirimde birleşti)' : ''}`, 'ok');
    dlog(`✓ Raid simülasyonu: ${slug}`, 'ok');
  } else {
    out('raid-out', 'Geçmişe raid kaydı düşmedi; arka plan konsolunda RAID kayıtlarına bak', 'err');
  }
}

async function testFilter() {
  const slug = slugOf('flt-slug');
  if (!slug) return out('flt-out', 'Kanal gir', 'err');
  const r = await send({ type: 'TEST_CHANNEL_FILTER', slug, category: document.getElementById('flt-cat').value, title: document.getElementById('flt-title').value });
  if (!r?.success) return out('flt-out', r?.error || 'Başarısız', 'err');
  const p = r.pref || {};
  const f = `Kategori: ${(p.cats || []).join(', ') || '—'} · Kelime: ${(p.words || []).join(', ') || '—'}`;
  if (r.result.pass) {
    out('flt-out', `GEÇER: bildirim gider${r.result.unknownCategory ? ' (kategori bilinmediği için)' : ''} · ${f}`, 'ok');
  } else {
    out('flt-out', `ELENİR: ${r.result.reason === 'category' ? 'kategori uymuyor' : 'başlıkta kelime yok'}, geçmişe "Filtrelendi" yazılır · ${f}`, 'warn');
  }
}

async function sendWatchTick() {
  const slug = slugOf('watch-slug');
  if (!/^[a-z0-9_-]{2,40}$/.test(slug)) return out('watch-out', 'Geçerli bir kanal gir', 'err');
  const before = ((await lget('_watchTime'))._watchTime?.days?.[localDay()] || {})[slug] || 0;
  await send({ type: 'WATCH_TICK', slug, sec: 30 });
  await new Promise(r => setTimeout(r, 400));
  const after = ((await lget('_watchTime'))._watchTime?.days?.[localDay()] || {})[slug] || 0;
  if (after > before) out('watch-out', `Eklendi: bugün ${secText(after)} (+${after - before} sn)`, 'ok');
  else out('watch-out', `Sayılmadı: son 20 sn içinde bu kanala tik gelmiş (çift sekme koruması). Bugün ${secText(after)}`, 'warn');
}

async function ratePreview() {
  const d = await lget(['_ratePrompt', '_ratePromptTestBackup']);
  if (!d._ratePromptTestBackup) await chrome.storage.local.set({ _ratePromptTestBackup: { value: d._ratePrompt || null, at: Date.now() } });
  await chrome.storage.local.set({ _ratePrompt: { firstSeen: Date.now() - 8 * 86400000, opens: TP.RATE.MIN_OPENS, settingsChanged: true, state: 'pending', shows: 0 } });
  const { due, conds } = await evaluateRatePrompt();
  const miss = conds.filter(c => !c[1]).map(c => c[0]);
  out('rate-out', due ? 'Hazır: popup\'ı aç, bant görünmeli. Bitince "Önceki duruma dön".' : `Hâlâ eksik (gerçek veriden): ${miss.join(', ')}`, due ? 'ok' : 'warn');
  dlog('Değerlendirme önizlemesi hazırlandı (yedek alındı)', 'info');
}
async function rateRestore() {
  const { _ratePromptTestBackup: b } = await lget('_ratePromptTestBackup');
  if (!b) return out('rate-out', 'Yedek yok; önizleme yapılmamış', 'warn');
  if (b.value) await chrome.storage.local.set({ _ratePrompt: b.value });
  else await chrome.storage.local.remove('_ratePrompt');
  await chrome.storage.local.remove('_ratePromptTestBackup');
  out('rate-out', 'Önceki duruma dönüldü', 'ok');
  dlog('Değerlendirme durumu geri yüklendi', 'ok');
}
async function rateReset() {
  if (!confirm('Değerlendirme durumu silinecek; popup bir sonraki açılışta sıfırdan hesaplar. Devam?')) return;
  await chrome.storage.local.remove(['_ratePrompt', '_ratePromptTestBackup']);
  out('rate-out', 'Sıfırlandı', 'ok');
  dlog('Değerlendirme durumu sıfırlandı', 'warn');
}

// ═══════════════════════════════════════════════════════════════════════════
// CANLI DURUM TABLOLARI
// ═══════════════════════════════════════════════════════════════════════════

async function renderStateTables() {
  const d = await lget(['channelAlertPrefs', '_channelMeta', '_endPending', '_raidSeen', '_watchTime', '_ratePrompt', 'notificationHistory', '_cachedChannels']);
  const cached = Array.isArray(d._cachedChannels) ? d._cachedChannels : [];
  const chOf = (s) => cached.find(c => c.channelSlug === s);
  const nameOf = (s) => chOf(s)?.userUsername || s;
  const prefs = d.channelAlertPrefs || {};
  const onOff = (v) => v ? tag('açık', 'ok') : tag('—');

  // Tercihler
  mount('st-prefs', table(['Kanal', 'Yayında', 'Değişim', 'Bitiş', 'Raid', 'Kategori filtresi', 'Kelime filtresi'],
    Object.entries(prefs).map(([s, p]) => [
      nameOf(s), chOf(s)?.isLive ? tag('canlı', 'ok') : tag(chOf(s) ? 'kapalı' : 'takipte değil', chOf(s) ? '' : 'warn'),
      onOff(p.change), onOff(p.end), onOff(p.raid),
      (p.cats || []).map(x => tag(x, 'info')), (p.words || []).map(x => tag(x, 'info')),
    ])));

  // Değişim takibi
  const meta = d._channelMeta || {};
  mount('st-meta', table(['Kanal', 'Durum', 'Kategori', 'Başlık', 'Başlangıç', 'Süre', 'Son kontrol', 'Son değişim bildirimi', 'Değişim'],
    Object.entries(meta).sort((a, b) => (a[1].off ? 1 : 0) - (b[1].off ? 1 : 0) || (b[1].at || 0) - (a[1].at || 0)).map(([s, m]) => {
      const start = m.s ? new Date(m.s).getTime() : null;
      return [
        nameOf(s), m.off ? tag('kapalı') : tag('takipte', 'ok'), m.c || '—',
        td(m.t || '—', 'trunc', m.t || ''), start ? hhmm(start) : tag('bilinmiyor', 'warn'),
        start && !m.off ? dur(Date.now() - start) : '—',
        td(ago(m.at), 'mono'), m.n ? ago(m.n) : '—', onOff(prefs[s]?.change),
      ];
    })));

  // Yayın bitti adayları
  const endP = d._endPending || {};
  mount('st-end', table(['Kanal', 'Kaynak', 'Aday oldu', 'Doğrulama'],
    Object.entries(endP).map(([s, c]) => {
      const left = TP.END_CONFIRM_MS - (Date.now() - c.since);
      return [c.username || s, c.source, ago(c.since), left > 0 ? tag(Math.ceil(left / 1000) + ' sn kaldı', 'info') : tag('sonraki taze kontrolde', 'warn')];
    })));

  // Raid
  mount('st-raid', table(['Kanal', 'Son bildirim', 'Tekrar kilidi'],
    Object.entries(d._raidSeen || {}).sort((a, b) => b[1] - a[1]).map(([s, t]) => {
      const left = TP.RAID_DEDUP_MS - (Date.now() - t);
      return [nameOf(s), ago(t), left > 0 ? tag(Math.ceil(left / 60000) + ' dk', 'warn') : tag('açık', 'ok')];
    })));

  // İzleme süresi
  const days = d._watchTime?.days || {};
  const today = days[localDay()] || {};
  const week = {};
  for (let i = 0; i < 7; i++) {
    const k = localDay(new Date(Date.now() - i * 86400000));
    for (const [s, v] of Object.entries(days[k] || {})) week[s] = (week[s] || 0) + v;
  }
  const todayTotal = Object.values(today).reduce((a, b) => a + b, 0);
  const weekTotal = Object.values(week).reduce((a, b) => a + b, 0);
  mount('st-watch', el('div', null,
    el('dl', { class: 'kv', style: 'margin-bottom:10px;' },
      el('dt', { text: 'Bugün' }), el('dd', { text: secText(todayTotal) }),
      el('dt', { text: 'Son 7 gün' }), el('dd', { text: secText(weekTotal) }),
      el('dt', { text: 'Kayıtlı gün' }), el('dd', { text: String(Object.keys(days).length) })),
    table(['Kanal', 'Bugün', '7 gün'],
      Object.entries(week).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, v]) => [nameOf(s), secText(today[s] || 0), secText(v)]))));

  // Değerlendirme
  const { conds, due } = await evaluateRatePrompt();
  mount('st-rate', el('div', null,
    el('div', { style: 'margin-bottom:8px;' }, due ? tag('Bant gösterilecek', 'ok') : tag('Bant gösterilmez', 'warn')),
    el('dl', { class: 'kv' }, conds.map(([k, okk, v]) => [el('dt', { text: k }), el('dd', { style: 'color:' + (okk ? 'var(--ok)' : 'var(--warn)'), text: v })]))));

  // Geçmiş
  const hist = (Array.isArray(d.notificationHistory) ? d.notificationHistory : []).slice(0, 20);
  const kindTag = (e) => e.kind === 'end' ? tag('bitti', 'info') : e.kind === 'raid' ? tag('raid', 'warn') : tag('canlı', 'ok');
  const detail = (e) => e.kind === 'end' ? `${e.length ? e.length + ' · ' : ''}${e.title || ''}`
    : e.kind === 'raid' ? `${e.raider || '?'} · ${e.viewers ?? '?'} izleyici`
    : `${e.category || ''}${e.title ? ' · ' + e.title : ''}`;
  mount('st-history', table(['Zaman', 'Tür', 'Kanal', 'Detay', ''],
    hist.map(e => [td(new Date(e.timestamp).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }), 'mono'), kindTag(e),
      e.username || e.channelSlug, td(detail(e), 'trunc', detail(e)), e.filtered ? tag('filtrelendi', 'warn') : ''])));
}

// ═══════════════════════════════════════════════════════════════════════════
// ARAÇLAR — ek butonlar
// ═══════════════════════════════════════════════════════════════════════════

function showJson(id, obj) {
  const box = document.getElementById(id);
  if (!box) return;
  box.style.color = '';
  box.replaceChildren(el('pre', { style: 'white-space:pre-wrap;margin:0;font-family:inherit;', text: JSON.stringify(obj, null, 2) }));
}

async function realLiveNotif() {
  const r = await send({ type: 'TEST_NOTIFICATION' });
  out('real-notif-out', r?.success ? `Gönderildi: ${r.channel} (Aç / Sustur butonlarıyla)` : (r?.error || 'Başarısız'), r?.success ? 'ok' : 'err');
}
async function pusherReal() {
  if (!confirm('Plan F testi gerçek bildirim gönderir ve test kanalı için geçici durum yazar. Devam?')) return;
  const r = await send({ type: 'PUSHER_E2E_TEST' });
  (r?.results || []).forEach(x => dlog(`[Plan F] ${x.step}: ${x.detail}`, x.status === 'error' ? 'err' : x.status));
  out('real-notif-out', r?.results ? `${r.results.length} adım · ${r.success ? 'başarılı' : 'sorun var'} (ayrıntı logda)` : (r?.error || 'Yanıt yok'), r?.success ? 'ok' : 'warn');
}

// ═══════════════════════════════════════════════════════════════════════════
// BAŞLAT
// ═══════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', () => {
  const ver = document.getElementById('ver-chip');
  if (ver) ver.textContent = 'v' + chrome.runtime.getManifest().version;
  const br = document.getElementById('browser-chip');
  if (br) br.textContent = isFF ? 'Firefox' : 'Chrome';

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
  let last = null;
  try { last = localStorage.getItem('ka-test-tab'); } catch (e) {}
  if (last && document.getElementById('view-' + last)) showView(last);

  setupLogTools();
  fillFollowedList();

  // Sorun listesi varsayılan kapalı; başlıkta sayı görünür
  const issues = document.getElementById('health-issues');
  const list = document.getElementById('health-issues-list');
  const cnt = document.getElementById('issues-count');
  document.getElementById('issues-toggle')?.addEventListener('click', () => issues?.classList.toggle('expanded'));
  if (list && cnt) {
    const upd = () => {
      const items = [...list.children];
      const crit = items.filter(li => li.textContent.includes('🔴')).length;
      cnt.textContent = `${items.length}${crit ? ' · ' + crit + ' kritik' : ''}`;
    };
    new MutationObserver(upd).observe(list, { childList: true });
    upd();
  }

  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);
  on('btn-run-all', runAllSafe);
  on('btn-chg-sim', simulateCategoryChange);
  on('btn-raid-sim', () => simulateRaid(false));
  on('btn-raid-sim-split', () => simulateRaid(true));
  on('btn-flt-test', testFilter);
  on('btn-watch-tick', sendWatchTick);
  on('btn-watch-show', () => { showView('state'); document.getElementById('sec-watch')?.scrollIntoView({ behavior: 'smooth' }); });
  on('btn-rate-preview', ratePreview);
  on('btn-rate-restore', rateRestore);
  on('btn-rate-reset', rateReset);
  on('btn-state-refresh', renderStateTables);
  on('btn-real-notif', realLiveNotif);
  on('btn-pusher-real', pusherReal);
  on('btn-bot-status', async () => showJson('modules-out', await send({ type: 'GET_BOT_TRACKER_STATUS' })));
  on('btn-bot-stats', async () => showJson('modules-out', await send({ type: 'GET_BOT_STATS' })));
  on('btn-proxy-status', async () => showJson('modules-out', await send({ type: 'GET_PROXY_STATUS' })));
  const sn = document.getElementById('btn-sniffer');
  if (sn) {
    if (!chrome.offscreen) { sn.disabled = true; sn.title = 'Sadece Chrome (offscreen)'; }
    sn.addEventListener('click', async () => showJson('modules-out', await send({ type: 'START_SNIFFER' })));
  }

  // Canlı durum sekmesi açıkken 10 sn'de bir yenile
  setInterval(() => {
    if (document.getElementById('view-state')?.classList.contains('active') && !document.hidden) renderStateTables();
  }, 10000);
});
