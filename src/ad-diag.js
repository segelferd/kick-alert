/**
 * KickAlert - Reklam teşhis deposu ve isteğe bağlı gönderim (v2.5.74)
 *
 * adblock-worker-hook.js (sayfa) yeni / tanımsız akış işaretlerini ve reklam
 * aralarını yayınlar, content.js bunları AD_DIAG mesajıyla buraya iletir.
 *
 * 1) BİRİKTİRME (her zaman, sadece bu cihazda): chrome.storage.local
 *    '_adDiag' anahtarında, işaret başına tek kayıt (ilk/son görülme, sayı,
 *    temizlenmiş örnek). En fazla 100 kayıt. Test panelinden kopyalanır,
 *    indirilir, temizlenir. Senkronize edilmez, dışa aktarılmaz.
 *
 * 2) GÖNDERİM (İSTEĞE BAĞLI, VARSAYILAN KAPALI): Kullanıcı Ayarlar'da
 *    "Reklam teşhislerini paylaş"ı açarsa, gönderilmemiş kayıtlar en geç
 *    5 dk içinde ve 12 saatte bir geliştiricinin Google Apps Script
 *    toplayıcısına gönderilir. Gönderilen: işaret adı, sayı, zamanlar,
 *    ortalama reklam süresi, temizlenmiş etiket satırları, eklenti sürümü,
 *    tarayıcı türü ve arayüz dili. GÖNDERİLMEYEN: kanal adı, izlenen yayın,
 *    video/oynatma adresleri, token, hesap veya cihaz kimliği.
 *    Firefox'ta ayrıca 'technicalAndInteraction' veri izni istenir.
 *
 * © 2026 Segelferd. All rights reserved.
 */
/* global chrome, browser */
const AdDiag = (() => {
  const KEY = '_adDiag';
  const SHARE_KEY = 'adDiagShareEnabled';
  const ENDPOINT_KEY = '_adDiagEndpoint';      // test paneli geçici adres (boşsa varsayılan)
  // Apps Script web uygulaması adresi (Patron yayınladıktan sonra doldurulur)
  const DEFAULT_ENDPOINT = 'https://script.google.com/macros/s/AKfycbyZAtxB5VfoK03KMxLdq8IfvvmYAjv3z6D7v-R1dzNGv8oy7MLe59jumUFENixi08q-/exec'; // 03.10.2026 Patron'un dağıtımı
  const COLLECT_KEY = 'ka-diag-v1';            // toplayıcıda basit gürültü filtresi (gizli değil)
  const MAX_ITEMS = 100;
  const SEND_ALARM = 'ka-diag-send';
  const DAILY_ALARM = 'ka-diag-daily';

  let chain = Promise.resolve(); // yazımları sıraya koy (aynı anda iki sekme)

  function isFirefox() {
    try { return typeof IS_FIREFOX !== 'undefined' ? !!IS_FIREFOX : (typeof browser !== 'undefined' && !!browser.runtime && typeof browser.runtime.getBrowserInfo === 'function'); } catch (e) { return false; }
  }
  // Sayfadaki strictTagLine ile aynı kural (ikinci katman): etiket ve öznitelik
  // adları kalır, değerler sadece güvenli listede ve sade ise korunur.
  const SAFE_ATTRS = { CLASS: 1, DURATION: 1, 'PLANNED-DURATION': 1, 'END-ON-NEXT': 1, 'X-NET-LIVE-VIDEO-STREAM-SOURCE': 1, 'START-DATE': 1, 'END-DATE': 1 };
  function strictTagLine(l) {
    l = String(l).replace(/https?:\/\/[^\s",]+/gi, '<url>');
    const ci = l.indexOf(':');
    if (ci < 0) return l.slice(0, 80);
    const tag = l.slice(0, ci), rest = l.slice(ci + 1);
    if (tag === '#EXTINF') { const m = /^([0-9.]+)\s*,?\s*(.{0,20})/.exec(rest); return '#EXTINF:' + (m ? m[1] + ',' + m[2].replace(/[^A-Za-z0-9 _.-]/g, '').trim() : '<v>'); }
    if (rest.indexOf('=') === -1) return tag + ':' + (/^[A-Za-z0-9 _.:+-]{1,32}$/.test(rest) ? rest : '<v>');
    const parts = rest.match(/[A-Z0-9-]+=("[^"]*"|[^,]*)/g) || [];
    return tag + ':' + parts.map(kv => {
      const eq = kv.indexOf('='), k = kv.slice(0, eq), v = kv.slice(eq + 1), raw = v.replace(/^"|"$/g, '');
      return k + '=' + ((SAFE_ATTRS[k] && /^[A-Za-z0-9 _.:+-]{1,64}$/.test(raw)) ? v : '<v>');
    }).join(',');
  }
  function cleanSample(s) {
    try {
      return String(s || '').split('\n').filter(l => l.charAt(0) === '#').slice(0, 30)
        .map(l => strictTagLine(l).slice(0, 400)).join('\n').slice(0, 6000);
    } catch (e) { return ''; }
  }
  async function load() {
    const o = (await chrome.storage.local.get(KEY))[KEY];
    if (o && o.v === 1 && Array.isArray(o.items)) return o;
    return { v: 1, items: [], lastSendAt: 0, lastSendResult: '' };
  }
  async function save(o) { await chrome.storage.local.set({ [KEY]: o }); }
  function version() { try { return chrome.runtime.getManifest().version; } catch (e) { return ''; } }

  function record(msg) {
    chain = chain.then(async () => {
      const kind = msg.kind === 'marker' ? 'marker' : 'adbreak';
      const marker = String(msg.marker || '').slice(0, 120);
      if (!marker) return;
      const key = (kind === 'marker' ? 'm|' : 'a|') + marker;
      const o = await load();
      const now = Date.now();
      let it = o.items.find(x => x.key === key);
      if (msg.kind === 'adbreak-end') {
        if (it && Number.isFinite(msg.durationSec)) {
          it.durN = (it.durN || 0) + 1;
          it.durSum = (it.durSum || 0) + msg.durationSec;
          it.avgDurationSec = Math.round(it.durSum / it.durN);
          it.lastDurationSec = msg.durationSec;
          await save(o);
        }
        return;
      }
      if (!it) {
        it = { key, kind, marker, firstAt: now, lastAt: now, count: 0, unsent: 0, sample: '', version: version() };
        o.items.push(it);
      }
      it.lastAt = now; it.count++; it.unsent = (it.unsent || 0) + 1; it.version = version();
      const smp = cleanSample(msg.sample);
      if (smp && (!it.sample || kind === 'marker')) it.sample = smp;
      // Taşarsa önce gönderilmiş, sonra en eski kayıtlar düşer
      if (o.items.length > MAX_ITEMS) { o.items.sort((a, b) => ((b.unsent > 0) - (a.unsent > 0)) || (b.lastAt - a.lastAt)); o.items.length = MAX_ITEMS; }
      await save(o);
      try { if (typeof KLog !== 'undefined') KLog.info(kind === 'marker' ? 'ADB-16' : 'ADB-12', 'Teşhis kaydedildi: ' + marker + ' (toplam ' + it.count + ')'); } catch (e) {}
      if (await isShareOn()) scheduleSoon();
    }).catch(() => {});
    return chain;
  }

  async function isShareOn() {
    const v = (await chrome.storage.local.get(SHARE_KEY))[SHARE_KEY];
    return v === true;
  }
  async function firefoxConsentOk() {
    if (!isFirefox()) return true;
    try {
      if (!browser.permissions || !browser.permissions.contains) return false;
      return await browser.permissions.contains({ data_collection: ['technicalAndInteraction'] });
    } catch (e) { return false; }
  }
  async function endpoint() {
    const o = (await chrome.storage.local.get(ENDPOINT_KEY))[ENDPOINT_KEY];
    const u = (typeof o === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(o)) ? o : DEFAULT_ENDPOINT;
    return u || '';
  }
  function scheduleSoon() {
    try {
      chrome.alarms.get(SEND_ALARM, (a) => { if (!a) chrome.alarms.create(SEND_ALARM, { delayInMinutes: 5 }); });
    } catch (e) {}
  }
  function scheduleDaily(on) {
    try {
      if (on) chrome.alarms.get(DAILY_ALARM, (a) => { if (!a) chrome.alarms.create(DAILY_ALARM, { delayInMinutes: 30, periodInMinutes: 720 }); });
      else { chrome.alarms.clear(DAILY_ALARM); chrome.alarms.clear(SEND_ALARM); }
    } catch (e) {}
  }

  let sending = false;
  async function send(reason) {
    if (sending) return { ok: false, reason: 'busy' };
    sending = true;
    try { return await sendInner(reason); } finally { sending = false; }
  }
  async function sendInner(reason) {
    if (!(await isShareOn())) return { ok: false, reason: 'disabled' };
    if (!(await firefoxConsentOk())) return { ok: false, reason: 'no-consent' };
    const url = await endpoint();
    if (!url) return { ok: false, reason: 'no-endpoint' };
    const o = await load();
    const pending = o.items.filter(x => (x.unsent || 0) > 0);
    if (!pending.length) return { ok: true, sent: 0 };
    let lang = '';
    try { lang = chrome.i18n.getUILanguage(); } catch (e) {}
    const payload = {
      key: COLLECT_KEY, v: 1, ext: version(), browser: isFirefox() ? 'firefox' : 'chrome', lang, reason: reason || '',
      items: pending.slice(0, 50).map(x => ({ kind: x.kind, marker: x.marker, count: x.unsent, total: x.count, firstAt: x.firstAt, lastAt: x.lastAt, avgDurationSec: x.avgDurationSec || null, sample: x.sample || '' })),
    };
    let ok = false, note = '';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload), redirect: 'follow', credentials: 'omit' });
      note = 'HTTP ' + r.status;
      // Sadece toplayıcının kendi {ok:true} cevabı başarı sayılır (giriş sayfası
      // veya betik hatası da 200 HTML dönebilir; o durumda kayıtlar silinmez)
      let j = null;
      try { j = await r.json(); } catch (e) { note += ' (JSON değil)'; }
      ok = !!(r.ok && j && j.ok === true);
      if (j && j.ok === false && j.error) note = j.error;
    } catch (e) {
      note = String(e && e.message || e).slice(0, 80);
    }
    const sentCounts = new Map(pending.slice(0, 50).map(x => [x.key, x.unsent]));
    const sentKeys = new Set(sentCounts.keys());
    await (chain = chain.then(async () => {
      const cur = await load();
      // gönderim sürerken gelen yeni olaylar silinmesin: sadece gönderilen sayı düşülür
      if (ok) cur.items.forEach(x => { if (sentCounts.has(x.key)) x.unsent = Math.max(0, (x.unsent || 0) - sentCounts.get(x.key)); });
      cur.lastSendAt = Date.now();
      cur.lastSendResult = (ok ? 'ok ' : 'hata ') + note;
      await save(cur);
    }).catch(() => {}));
    try { if (typeof KLog !== 'undefined') KLog[ok ? 'info' : 'warn']('ADB-17', 'Teşhis gönderimi: ' + (ok ? sentKeys.size + ' kayıt gönderildi' : 'başarısız (' + note + ')')); } catch (e) {}
    return { ok, sent: ok ? sentKeys.size : 0, note };
  }

  async function status() {
    const o = await load();
    return { items: o.items, lastSendAt: o.lastSendAt, lastSendResult: o.lastSendResult, share: await isShareOn(), consent: await firefoxConsentOk(), endpoint: await endpoint(), firefox: isFirefox(), defaultEndpoint: !!DEFAULT_ENDPOINT };
  }
  async function clear() { await (chain = chain.then(() => save({ v: 1, items: [], lastSendAt: 0, lastSendResult: '' })).catch(() => {})); return { ok: true }; }
  async function setEndpoint(u) {
    const v = String(u || '').trim();
    if (v && !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(v)) return { ok: false, reason: 'invalid' };
    await chrome.storage.local.set({ [ENDPOINT_KEY]: v });
    return { ok: true };
  }

  // Alarm ve ayar değişimi
  try {
    chrome.alarms.onAlarm.addListener((a) => {
      if (a && (a.name === SEND_ALARM || a.name === DAILY_ALARM)) send(a.name === SEND_ALARM ? 'soon' : 'daily').catch(() => {});
    });
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch[SHARE_KEY]) return;
      const on = ch[SHARE_KEY].newValue === true;
      scheduleDaily(on);
      if (on) scheduleSoon();
    });
    isShareOn().then(on => scheduleDaily(on)).catch(() => {});
    // Firefox: izin istemi açılınca araç çubuğu penceresi kapanabilir; izin
    // verildiğinde/kaldırıldığında paylaşım bayrağını burada da eşitle.
    if (isFirefox() && typeof browser !== 'undefined' && browser.permissions && browser.permissions.onAdded) {
      browser.permissions.onAdded.addListener((p) => {
        if (p && Array.isArray(p.data_collection) && p.data_collection.includes('technicalAndInteraction')) chrome.storage.local.set({ [SHARE_KEY]: true });
      });
      browser.permissions.onRemoved.addListener((p) => {
        if (p && Array.isArray(p.data_collection) && p.data_collection.includes('technicalAndInteraction')) chrome.storage.local.set({ [SHARE_KEY]: false });
      });
    }
  } catch (e) {}

  return { record, send, status, clear, setEndpoint, cleanSample, KEY, SHARE_KEY, ENDPOINT_KEY };
})();
if (typeof self !== 'undefined') self.AdDiag = AdDiag;
