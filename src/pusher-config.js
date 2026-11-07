/**
 * KickAlert - Pusher bağlantı ayarı (v2.5.78)
 *
 * Kick, Ekim 2026'da eski Pusher uygulamasını (32cbd69e4b950bf97679) kapattı;
 * o anahtarla bağlanınca 4001 "App key not in this cluster" dönüyor. Kick'in
 * kendi sayfası artık hangi uygulamaya bağlanacağını her açılışta
 * web.kick.com/api/v1/realtime/connection adresine soruyor.
 *
 * Bu dosya üç yerde yüklenir ve aynı global'i sağlar:
 *   - Chrome service worker (importScripts)   → anahtarı Kick'ten alır
 *   - Chrome offscreen.html                   → LiveTracker + BotTracker kullanır
 *   - Firefox arka plan scriptleri            → Pusher + BotTracker kullanır
 * Anahtarı sadece arka plan (background.js) Kick'ten sorar; offscreen'e
 * mesajla iletilir. Burada ağ isteği yok.
 *
 * © 2026 Segelferd. All rights reserved.
 */

// Kick'in 13.10.2026'da döndürdüğü değer; sorgu başarısız olursa kullanılır
var KA_PUSHER_FALLBACK = { key: '34bf7a0ff419a2a775b9', cluster: 'us2' };

// v2.5.90 (b034): Centrifugo yedeği. Kick Pusher'a yayını keserse (veya hiç
// sunmazsa) aynı olaylar Kick'in kendi Centrifugo sunucusundan alınır.
var KA_CF_URL_RE = /^wss:\/\/realtime\.[a-z0-9-]+\.platform\.kick\.com\/connection\/websocket$/;

var KAPusherCfg = {
  key: KA_PUSHER_FALLBACK.key,
  cluster: KA_PUSHER_FALLBACK.cluster,
  provider: 'pusher',   // 'pusher' | 'centrifugo'
  cfUrl: '',            // centrifugo modunda sunucu adresi
  _listeners: [],

  // Kick'in kendi istemcisiyle aynı sürüm parametreleri
  url() {
    return `wss://ws-${this.cluster}.pusher.com/app/${this.key}?protocol=7&client=js&version=8.4.0&flash=false`;
  },

  // Geçerli bir ayar mı? Sadece harf/rakam anahtar, harf/rakam/tire küme adı.
  valid(cfg) {
    return !!cfg && typeof cfg.key === 'string' && /^[A-Za-z0-9]{8,64}$/.test(cfg.key) &&
      (cfg.cluster === undefined || cfg.cluster === null || (typeof cfg.cluster === 'string' && /^[a-z0-9-]{1,32}$/.test(cfg.cluster)));
  },

  // Yeni ayarı uygula. Değiştiyse dinleyicilere haber verir, true döner.
  set(cfg) {
    if (!this.valid(cfg)) return false;
    const cluster = cfg.cluster || 'us2';
    const provider = (cfg.provider === 'centrifugo' && KA_CF_URL_RE.test(cfg.cfUrl || '')) ? 'centrifugo' : 'pusher';
    const cfUrl = provider === 'centrifugo' ? cfg.cfUrl : '';
    if (cfg.key === this.key && cluster === this.cluster && provider === this.provider && cfUrl === this.cfUrl) return false;
    this.key = cfg.key;
    this.cluster = cluster;
    this.provider = provider;
    this.cfUrl = cfUrl;
    for (const fn of this._listeners) { try { fn(this); } catch (e) {} }
    return true;
  },

  onChange(fn) { if (typeof fn === 'function') this._listeners.push(fn); },

  // Kalıcı Pusher hatası (4000-4099, ör. 4001 anahtar yok) geldiğinde
  // çağrılır. Firefox'ta background.js bağlar; Chrome offscreen'de
  // offscreen.js arka plana mesaj gönderir.
  onInvalid: null,
  reportInvalid(source, code, message) {
    try { if (typeof this.onInvalid === 'function') this.onInvalid({ key: this.key, source, code, message }); } catch (e) {}
  },
};

// Kalıcı hatadan sonra aynı anahtarla tekrar deneme aralığı (sonsuz döngü yerine)
var KA_PUSHER_PERMANENT_RETRY_MS = 15 * 60 * 1000;

// ─── v2.5.94: geçici kopmalarda gürültüsüz izleme ───
// Uyku/uyanma, Wi-Fi ya da VPN değişimi gibi kısa kopmalar normal; yeniden
// bağlanma zaten devrede. Uyarı (console.warn, tarayıcının Hatalar sayfasına
// düşer) sadece internet varken 5 dakika boyunca bağlanılamazsa yazılır.
// İnternet yokken (navigator.onLine === false) denemeler durur, "online"
// olayıyla hemen yeniden bağlanılır.
var KA_RT_WARN_AFTER_MS = 5 * 60 * 1000;
var KA_RT_OFFLINE_FALLBACK_MS = 5 * 60 * 1000;
function kaRtOnline() {
  try { return typeof navigator === 'undefined' || navigator.onLine !== false; } catch (e) { return true; }
}
function kaRtHealth() {
  return {
    since: 0, warned: false,
    // Bir başarısız deneme. Uyarı yazılması gerekiyorsa true döner (kesinti başına bir kez).
    fail() {
      const now = Date.now();
      if (!this.since) this.since = now;
      if (this.warned || !kaRtOnline()) return false;
      if (now - this.since >= KA_RT_WARN_AFTER_MS) { this.warned = true; return true; }
      return false;
    },
    // Bağlantı kuruldu. Daha önce uyarı yazılmışsa kesinti süresini (ms) döner.
    ok() {
      const dur = this.warned && this.since ? Date.now() - this.since : 0;
      this.since = 0; this.warned = false;
      return dur;
    },
  };
}
// İnternet geri gelince fn bir kez çağrılır (aynı fn tekrar kaydedilmez).
function kaOnOnlineOnce(fn) {
  try {
    if (typeof self === 'undefined' || !self.addEventListener) return false;
    if (fn._kaOnline) return true;
    fn._kaOnline = true;
    self.addEventListener('online', function h() { self.removeEventListener('online', h); fn._kaOnline = false; try { fn(); } catch (e) {} });
    return true;
  } catch (e) { return false; }
}

function kaIsPermanentPusherCode(code) {
  return typeof code === 'number' && code >= 4000 && code <= 4099;
}

// ─── v2.5.90 (b034): Gerçek zamanlı soket fabrikası ───
// Pusher modunda düz WebSocket; Centrifugo modunda Pusher gibi davranan bir
// sarmalayıcı döner. Üç izleyici (LiveTracker, BotTracker, Firefox Pusher)
// kodlarını değiştirmeden ikisiyle de çalışır.
function kaOpenRealtimeSocket() {
  if (KAPusherCfg.provider === 'centrifugo' && KAPusherCfg.cfUrl) return new KACentrifugoSocket(KAPusherCfg.cfUrl);
  return new WebSocket(KAPusherCfg.url());
}

/**
 * Kick'in Centrifugo sunucusunu Pusher protokolüyle konuşuyormuş gibi sunar.
 * Akış (Kick'in kendi sayfa kodundan, 16.10.2026):
 *   1) POST web.kick.com/api/v1/realtime/auth/connection {client_id} -> misafir anahtar (45 dk)
 *   2) {id, connect:{token}}  ->  yanıt gelince "pusher:connection_established"
 *   3) pusher:subscribe -> {id, subscribe:{channel}} (herkese açık kanal, anahtarsız)
 *   4) push.pub.data {event, data} -> {event, channel, data} (Pusher biçimi)
 *   5) sunucu "{}" ping'ine "{}" ile cevap; pusher:ping'e sahte pusher:pong
 * Kaynak başlığı: Kick eklenti kaynaklı bağlantıyı 403 ile reddediyor; rules.json
 * kural 2 bu adrese giden websocket isteğinde Origin'i https://kick.com yapar
 * (isteğe bağlı *.kick.com site izni verilmişse uygulanır).
 */
class KACentrifugoSocket extends (typeof EventTarget === 'function' ? EventTarget : Object) {
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this._id = 0;
    this._subs = new Map();      // istek id -> kanal
    this._ws = null;
    this._refreshTimer = null;
    this._closed = false;
    this._clientId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2);
    this._start();
  }
  static get CONNECTING() { return 0; }
  static get OPEN() { return 1; }
  static get CLOSING() { return 2; }
  static get CLOSED() { return 3; }

  async _token() {
    const r = await fetch('https://web.kick.com/api/v1/realtime/auth/connection', {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ client_id: this._clientId }), credentials: 'omit', cache: 'no-store',
    });
    if (!r.ok) throw new Error('auth HTTP ' + r.status);
    const j = await r.json();
    const t = j && j.data && j.data.token;
    if (!t) throw new Error('auth yanıtında token yok');
    return t;
  }

  async _start() {
    let token;
    try { token = await this._token(); } catch (e) { return this._fail(4900, 'centrifugo auth: ' + (e && e.message)); }
    if (this._closed) return;
    let ws;
    try { ws = new WebSocket(this.url); } catch (e) { return this._fail(4901, 'centrifugo ws: ' + (e && e.message)); }
    this._ws = ws;
    ws.addEventListener('open', () => {
      this._emit('open');
      this._sendRaw({ id: ++this._id, connect: { token, name: 'js' } });
      this._connectId = this._id;
    });
    ws.addEventListener('message', (ev) => this._onRaw(ev.data));
    ws.addEventListener('error', () => this._emit('error'));
    ws.addEventListener('close', (ev) => this._finish(ev.code, ev.reason));
  }

  _sendRaw(obj) { try { if (this._ws && this._ws.readyState === 1) this._ws.send(JSON.stringify(obj)); } catch (e) {} }

  _deliver(obj) {
    const data = JSON.stringify(obj);
    let ev;
    try { ev = new MessageEvent('message', { data }); } catch (e) { ev = new Event('message'); ev.data = data; }
    this.dispatchEvent(ev);
  }

  _onRaw(raw) {
    if (typeof raw !== 'string') return;
    for (const line of raw.split('\n')) {
      if (!line) continue;
      if (line === '{}') { try { this._ws.send('{}'); } catch (e) {} continue; }
      let j; try { j = JSON.parse(line); } catch (e) { continue; }
      if (j.id && j.id === this._connectId) {
        if (j.error) { this._fail(4902, 'centrifugo connect: ' + JSON.stringify(j.error)); return; }
        this.readyState = 1;
        const ttl = j.connect && j.connect.expires && Number(j.connect.ttl);
        if (ttl > 120) this._scheduleRefresh(ttl);
        this._deliver({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: (j.connect && j.connect.client) || this._clientId, activity_timeout: 120, provider: 'centrifugo' }) });
        continue;
      }
      if (j.id && this._subs.has(j.id)) {
        const ch = this._subs.get(j.id); this._subs.delete(j.id);
        if (!j.error || j.error.code === 105) this._deliver({ event: 'pusher_internal:subscription_succeeded', channel: ch, data: '{}' });
        continue;
      }
      const push = j.push;
      if (!push) continue;
      if (push.disconnect) { try { this._ws.close(); } catch (e) {} continue; }
      const pub = push.pub;
      if (!pub) continue;
      let pd = pub.data;
      if (typeof pd === 'string') { try { pd = JSON.parse(pd); } catch (e) { pd = null; } }
      const event = (pd && pd.event) || (pub.tags && pub.tags.event);
      if (!event || !pd) continue;
      const payload = pd.data;
      this._deliver({ event, channel: push.channel, data: typeof payload === 'string' ? payload : JSON.stringify(payload === undefined ? {} : payload) });
    }
  }

  _scheduleRefresh(ttl) {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(async () => {
      if (this._closed) return;
      try { const token = await this._token(); this._sendRaw({ id: ++this._id, refresh: { token } }); this._scheduleRefresh(ttl); }
      catch (e) { try { this._ws.close(); } catch (e2) {} }
    }, Math.max(60, ttl - 60) * 1000);
  }

  send(str) {
    let m; try { m = typeof str === 'string' ? JSON.parse(str) : str; } catch (e) { return; }
    if (!m || !m.event) return;
    if (m.event === 'pusher:ping') { setTimeout(() => this._deliver({ event: 'pusher:pong', data: '{}' }), 0); return; }
    const ch = m.data && m.data.channel;
    if (!ch || /^private-|^presence-/.test(ch)) return;
    if (m.event === 'pusher:subscribe') { const id = ++this._id; this._subs.set(id, ch); this._sendRaw({ id, subscribe: { channel: ch } }); }
    else if (m.event === 'pusher:unsubscribe') { this._sendRaw({ id: ++this._id, unsubscribe: { channel: ch } }); }
  }

  close() {
    this._closed = true;
    clearTimeout(this._refreshTimer);
    if (this._ws) { this.readyState = 2; try { this._ws.close(); } catch (e) {} }
    else this._finish(1000, 'closed');
  }

  _emit(type) { try { this.dispatchEvent(new Event(type)); } catch (e) {} }
  _fail(code, reason) {
    try { console.warn('[KickAlert][Centrifugo] ' + reason); } catch (e) {}
    this._emit('error');
    if (this._ws) { try { this._ws.close(); } catch (e) {} }
    this._finish(code, reason);
  }
  _finish(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    clearTimeout(this._refreshTimer);
    let ev;
    try { ev = new CloseEvent('close', { code: code || 1006, reason: reason || '' }); }
    catch (e) { ev = new Event('close'); ev.code = code || 1006; ev.reason = reason || ''; }
    this.dispatchEvent(ev);
  }
}
