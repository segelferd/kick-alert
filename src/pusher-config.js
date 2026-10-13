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

var KAPusherCfg = {
  key: KA_PUSHER_FALLBACK.key,
  cluster: KA_PUSHER_FALLBACK.cluster,
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
    if (cfg.key === this.key && cluster === this.cluster) return false;
    this.key = cfg.key;
    this.cluster = cluster;
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

function kaIsPermanentPusherCode(code) {
  return typeof code === 'number' && code >= 4000 && code <= 4099;
}
