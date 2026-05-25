/**
 * KickAlert - Offscreen Document (v2.3.0)
 * Responsibilities:
 *   1. Audio playback (notification sounds) — existing since v1.x
 *   2. Service worker keep-alive — existing since v2.0
 *   3. Bot tracker chat WebSocket (NEW v2.3.0)
 *      - 1 Pusher connection, multi-channel subscribe
 *      - Sliding 15-min message counter per chatroom
 *      - Active chatters tracking (last 5 min)
 *      - Reports stats to background.js on demand
 *
 * © 2026 Segelferd. All rights reserved.
 */

// v2.3.2: DEBUG-aware log helper. _debugMode storage'da açıksa console'a yazar,
// kapalıysa sessiz. background.js'teki dbg() ile aynı davranış. console.warn ve
// console.error'a dokunmaz — gerçek hatalar her zaman görünür.
let _OFFSCREEN_DEBUG = false;
try {
  chrome.storage.local.get('_debugMode', (r) => { _OFFSCREEN_DEBUG = r && r._debugMode === true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes._debugMode) _OFFSCREEN_DEBUG = changes._debugMode.newValue === true;
  });
} catch {}
function dbg(...args) { if (_OFFSCREEN_DEBUG) console.debug(...args); }

// ═══════════════════════════════════════════════════════════════
// AUDIO (existing — unchanged)
// ═══════════════════════════════════════════════════════════════

const SoundPaths = {
  DEFAULT: '../sounds/new_live_sub.mp3',
  NEW_LIVE_MAIN: '../sounds/new_live_main.mp3',
  NEW_LIVE_SUB: '../sounds/new_live_sub.mp3',
};

setInterval(async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage('keepAlive');
  } catch {}
}, 20000);


// ═══════════════════════════════════════════════════════════════
// v2.3.1 PLAN F — LIVE TRACKER (Pusher WebSocket, offscreen'de yaşar)
// ═══════════════════════════════════════════════════════════════
//
// Neden offscreen? MV3 service worker ~30sn sonra uyur → WebSocket kopar →
// tam yayın başlarken gelen StreamerIsLive event kaçar. Offscreen document
// HİÇ uyumaz → WebSocket 7/24 ayakta → event hiç kaçmaz. GERÇEK kırılmaz.
//
// bot_tracker'dan AYRI bir bağlantı: bot_tracker chatroom mesajlarını dinler
// (yüksek trafik), LiveTracker sadece channel.{id} StreamerIsLive dinler
// (düşük trafik). Ayrı tutmak mantık karışmasını önler.
//
// Event geldiğinde chrome.runtime.sendMessage ile SW'ye haber verir; SW
// uykuda olsa bile mesaj onu uyandırır ve bildirim gönderilir.

const LIVE_PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

const LiveTracker = {
  ws: null,
  isConnected: false,
  isConnecting: false,
  reconnectDelay: 1000,
  reconnectTimer: null,
  pingTimer: null,
  connectionTimeoutTimer: null,  // BUG#5 FIX: bağlanma takılmasını yakalar
  lastPongAt: 0,
  // channel_id → slug map (StreamerIsLive event channel_id veriyor, slug değil)
  channelIdToSlug: {},
  // subscribe edilmiş 'channel.{id}' set
  subscribed: new Set(),
  stats: { connects: 0, liveEvents: 0, offlineEvents: 0, messages: 0 },

  // v2.4.0 SNIFFER: keşif modu. Açıkken App\Events\* event'lerini ham loglar
  // ve chatroom kanallarına da abone olur (abone/hediye event'lerini görmek için).
  _snifferMode: false,
  _snifferChatrooms: [], // sniffer için ekstra subscribe edilecek chatroom_id'ler
  _snifferSubscribed: new Set(),

  ensureConnection() {
    if (this.isConnected || this.isConnecting) return;
    this.isConnecting = true;
    try {
      this.stats.connects++;
      this.ws = new WebSocket(LIVE_PUSHER_URL);

      // BUG#5 FIX: 10sn'de bağlanamazsa (handshake gelmezse) ws.close() →
      // close handler reconnect tetikler. Aksi halde isConnecting=true
      // sonsuza kalır ve LiveTracker sessizce ölürdü.
      this.connectionTimeoutTimer = setTimeout(() => {
        if (!this.isConnected) {
          console.warn('[KickAlert][LiveTracker] connection timeout (10sn) — kapatılıp yeniden denenecek');
          try { this.ws?.close(); } catch {}
          // close event gelmezse manuel reset + reconnect garantisi
          this.isConnecting = false;
          if (Object.keys(this.channelIdToSlug).length > 0) {
            this._scheduleReconnect();
          }
        }
      }, 10000);

      // BUG#6 FIX: open listener (teşhis + timeout ile birlikte sağlamlık)
      this.ws.addEventListener('open', () => {
        console.debug('[KickAlert][LiveTracker] WebSocket open (handshake bekleniyor)');
      });

      this.ws.addEventListener('message', (ev) => this._onMessage(ev));

      this.ws.addEventListener('close', () => {
        this.isConnected = false;
        this.isConnecting = false;
        clearTimeout(this.connectionTimeoutTimer);
        clearInterval(this.pingTimer);
        this.pingTimer = null;
        // Kanal varsa yeniden bağlan
        if (Object.keys(this.channelIdToSlug).length > 0) {
          this._scheduleReconnect();
        }
      });

      this.ws.addEventListener('error', () => { /* close handler reconnect yapar */ });
    } catch (e) {
      this.isConnecting = false;
      clearTimeout(this.connectionTimeoutTimer);
      console.warn('[KickAlert][LiveTracker] connection error:', e.message);
      this._scheduleReconnect();
    }
  },

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay + Math.random() * 1000;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
      this.ensureConnection();
    }, delay);
  },

  _onMessage(ev) {
    this.stats.messages++;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    const event = msg.event;

    // ─── v2.4.0 SNIFFER (geçici keşif aracı) ───
    // Chat mesajları (ChatMessageEvent) çok trafikli ve aradığımız değil →
    // GİZLENİR. Asıl avımız: abone, hediye, takipçi event'leri (nadir).
    // Sayaç tutar ama gürültüyü loglamaz. Mevcut akışa DOKUNMAZ.
    if (this._snifferMode && event && event.startsWith('App\\Events\\')) {
      const NOISE = new Set([
        'App\\Events\\ChatMessageEvent',
        'App\\Events\\ChatMessageSentEvent',
        'App\\Events\\MessageDeletedEvent',
        'App\\Events\\UserBannedEvent',
        'App\\Events\\UserUnbannedEvent',
        'App\\Events\\PinnedMessageCreatedEvent',
        'App\\Events\\PinnedMessageDeletedEvent',
      ]);
      this._snifferCounts = this._snifferCounts || {};
      const short = event.replace('App\\Events\\', '');
      this._snifferCounts[short] = (this._snifferCounts[short] || 0) + 1;

      if (!NOISE.has(event)) {
        let rawData = msg.data;
        try { rawData = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; } catch {}
        // Hem obje (tıklanabilir) hem düz JSON metin (kopyalanabilir) yaz
        let pretty = '';
        try { pretty = JSON.stringify(rawData, null, 2); } catch { pretty = String(rawData); }
        console.log('%c[SNIFFER] ⭐ ' + short, 'color:#1D9E75;font-weight:bold;font-size:14px',
          '\n  channel:', msg.channel,
          '\n  event:', event,
          '\n  data (obje):', rawData,
          '\n  data (metin):\n' + pretty);
        // Yakalanan event'leri biriktir (son 50) — topluca alınabilsin
        this._snifferCatch = this._snifferCatch || [];
        this._snifferCatch.push({ event: short, channel: msg.channel, data: rawData, at: new Date().toISOString() });
        if (this._snifferCatch.length > 50) this._snifferCatch.shift();
      }
    }

    if (event === 'pusher:connection_established') {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectDelay = 1000;
      this.lastPongAt = Date.now();
      clearTimeout(this.connectionTimeoutTimer); // BUG#5: başarılı bağlantı, timeout'u iptal et
      console.debug('[KickAlert][LiveTracker] bağlantı kuruldu');
      // Tüm bilinen kanallara (yeniden) subscribe ol
      this.subscribed.clear();
      for (const channelId of Object.keys(this.channelIdToSlug)) {
        this._subscribe(channelId);
      }
      // SNIFFER açıksa chatroom'lara da yeniden abone ol
      if (this._snifferMode) {
        this._snifferSubscribed.clear();
        for (const crid of this._snifferChatrooms) this._subscribeChatroom(crid);
      }
      // Ping
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this._ping(), 30000);
      return;
    }

    if (event === 'pusher:pong') { this.lastPongAt = Date.now(); return; }
    if (event === 'pusher:ping') { this._send({ event: 'pusher:pong', data: {} }); return; }
    if (event === 'pusher:error') {
      // Pusher protokolü: error event'i bir { code, message } taşır.
      // code aralıkları (Pusher Channels Protocol):
      //   4000-4099: KALICI hata — yeniden bağlanma (örn. geçersiz app key)
      //   4100-4199: backoff ile yeniden bağlan (geçici)
      //   4200-4299: hemen yeniden bağlan (geçici, örn. 4200 kapanma)
      //   4201: pong gelmedi — SW/sekme arka plandayken ÇOK YAYGIN, zararsız
      // Bağlantı close handler'ı + _scheduleReconnect zaten reconnect yapıyor.
      // Geçici hataları (4100+) sessizce yut — kullanıcıyı endişelendirme.
      // Sadece KALICI (4000-4099) hataları warn'la, çünkü bunlar gerçek sorun.
      let d = msg.data;
      try { d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; } catch {}
      const code = d && (d.code ?? d.Code);
      const message = (d && (d.message ?? d.Message)) || '';
      if (typeof code === 'number' && code >= 4000 && code <= 4099) {
        // Kalıcı hata — gerçek sorun, logla
        console.warn(`[KickAlert][LiveTracker] Pusher kalıcı hata (${code}): ${message}`);
      } else {
        // Geçici hata (4100+, 4201 pong, vb.) — reconnect zaten devrede, sessiz geç
        dbg(`[KickAlert][LiveTracker] Pusher geçici hata (${code ?? '?'}): ${message} — reconnect devrede`);
      }
      return;
    }
    if (event === 'pusher_internal:subscription_succeeded') return;

    // StreamerIsLive: { livestream: { id, channel_id, session_title, created_at } }
    if (event === 'App\\Events\\StreamerIsLive') {
      this.stats.liveEvents++;
      try {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const channelId = data.livestream?.channel_id;
        const slug = this.channelIdToSlug[channelId];
        if (slug) {
          console.debug(`[KickAlert][LiveTracker] StreamerIsLive → ${slug} (SW'ye iletiliyor)`);
          chrome.runtime.sendMessage({
            type: 'PUSHER_LIVE_EVENT',
            slug,
            livestream: data.livestream || {},
          }).catch(() => { /* SW henüz hazır değilse sessiz */ });
        }
      } catch (e) { /* sessiz */ }
      return;
    }

    // StopStreamBroadcast: { livestream: { id, channel: { id } } }
    if (event === 'App\\Events\\StopStreamBroadcast') {
      this.stats.offlineEvents++;
      try {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const channelId = data.livestream?.channel?.id;
        const slug = this.channelIdToSlug[channelId];
        if (slug) {
          chrome.runtime.sendMessage({
            type: 'PUSHER_OFFLINE_EVENT',
            slug,
          }).catch(() => {});
        }
      } catch (e) { /* sessiz */ }
      return;
    }
  },

  _subscribe(channelId) {
    const name = `channel.${channelId}`;
    if (this.subscribed.has(name)) return;
    if (this._send({ event: 'pusher:subscribe', data: { auth: '', channel: name } })) {
      this.subscribed.add(name);
    }
  },

  _unsubscribe(channelId) {
    const name = `channel.${channelId}`;
    if (!this.subscribed.has(name)) return;
    // Bağlı değilsek sadece local set'ten çıkar (reconnect'te zaten subscribe etmeyiz)
    this._send({ event: 'pusher:unsubscribe', data: { channel: name } });
    this.subscribed.delete(name);
  },

  // v2.4.0 SNIFFER: chatroom kanalına abone ol (abone/hediye event'leri orada)
  _subscribeChatroom(chatroomId) {
    const name = `chatrooms.${chatroomId}.v2`;
    if (this._snifferSubscribed.has(name)) return;
    if (this._send({ event: 'pusher:subscribe', data: { auth: '', channel: name } })) {
      this._snifferSubscribed.add(name);
    }
  },

  // v2.4.0 SNIFFER: keşif modunu aç. chatroomIds: izlenecek chatroom'lar.
  // Açıkken hem channel.{id} (zaten abone) hem chatrooms.{id}.v2 event'leri loglanır.
  enableSniffer(chatroomIds) {
    this._snifferMode = true;
    this._snifferChatrooms = chatroomIds || [];
    console.log('%c[SNIFFER] AÇIK', 'color:#1D9E75;font-weight:bold',
      '— channel.{id} + ' + this._snifferChatrooms.length + ' chatroom dinleniyor. Event bekleniyor...');
    if (this.isConnected) {
      for (const crid of this._snifferChatrooms) this._subscribeChatroom(crid);
    } else {
      this.ensureConnection();
    }
  },

  _ping() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this._send({ event: 'pusher:ping', data: {} });
    // 45sn pong gelmezse force reconnect
    if (Date.now() - this.lastPongAt > 45000) {
      try { this.ws.close(); } catch {}
    }
  },

  _send(obj) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    try { this.ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  },

  /**
   * SW'den gelen kanal listesini senkronize et.
   * @param {Array<{channelId:number, slug:string}>} list
   * @param {boolean} authoritative true ise: listede OLMAYAN kanallar unfollow
   *   sayılıp unsubscribe edilir (tam liste sync). false ise sadece ekleme yapılır
   *   (tekil kanal harvest — örn. CHANNEL_ID_HARVESTED ile gelen tek kanal).
   */
  sync(list, authoritative = false) {
    let added = false;
    const incomingIds = new Set();
    for (const item of list) {
      if (!item.channelId || !item.slug) continue;
      incomingIds.add(item.channelId);
      if (!this.channelIdToSlug[item.channelId]) added = true;
      this.channelIdToSlug[item.channelId] = item.slug;
    }

    // Bulgu#6 FIX: authoritative sync ise, listede olmayan kanalları
    // unfollow sayıp temizle. Aksi halde unfollow edilen kanal map'te kalır,
    // yayın açınca StreamerIsLive gelir → kullanıcı takip etmediği kanaldan
    // bildirim alır (hayalet bildirim).
    if (authoritative) {
      for (const channelId of Object.keys(this.channelIdToSlug)) {
        if (!incomingIds.has(Number(channelId))) {
          this._unsubscribe(channelId);
          delete this.channelIdToSlug[channelId];
        }
      }
    }

    this.ensureConnection();
    // Bağlıysa yeni kanallara hemen subscribe ol
    if (this.isConnected) {
      for (const channelId of Object.keys(this.channelIdToSlug)) {
        this._subscribe(channelId);
      }
    }
    return { tracked: Object.keys(this.channelIdToSlug).length, added };
  },

  getState() {
    return {
      connected: this.isConnected,
      trackedCount: Object.keys(this.channelIdToSlug).length,
      subscribedCount: this.subscribed.size,
      stats: { ...this.stats },
      snifferMode: this._snifferMode,
      snifferCounts: this._snifferCounts || {},
      snifferCatch: this._snifferCatch || [],
    };
  },
};


// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // PLAY_SOUND — existing audio handler (legacy: messageType, no target tag needed)
  if (msg.messageType === 'PLAY_SOUND') {
    const { sound, volume, customSoundFile } = msg.options;
    const src = customSoundFile || SoundPaths[sound] || SoundPaths.DEFAULT;
    const audio = new Audio(src);
    audio.volume = typeof volume === 'number' ? volume : 1;
    audio.play().catch(e => console.error('[KickAlert] Audio error:', e));
    return false;
  }

  // ─── v2.3.0: Bot Tracker messages (only if target=offscreen) ───
  // Bu sayede background'ın kendi handler'ı bu mesajları yakalayıp
  // promise loop'una sebep olmaz.
  if (msg.target !== 'offscreen') return false;

  // ─── v2.3.1 Plan F: LiveTracker mesajları ───
  if (msg.type === 'LIVE_TRACK_SYNC') {
    const result = LiveTracker.sync(msg.channels || [], !!msg.authoritative);
    sendResponse({ success: true, ...result });
    return false;
  }

  if (msg.type === 'LIVE_GET_STATE') {
    sendResponse({ success: true, state: LiveTracker.getState() });
    return false;
  }

  // v2.4.0 SNIFFER: keşif modunu başlat
  if (msg.type === 'LIVE_SNIFFER_START') {
    LiveTracker.enableSniffer(msg.chatroomIds || []);
    sendResponse({ success: true, sniffing: true, chatrooms: (msg.chatroomIds || []).length });
    return false;
  }

  if (msg.type === 'BOT_TRACK_SYNC') {
    BotTracker.syncChannels(msg.channels || []).then(() => {
      sendResponse({ success: true, trackedCount: BotTracker.channels.size });
    });
    return true;
  }

  if (msg.type === 'BOT_GET_STATS') {
    sendResponse({ success: true, stats: BotTracker.getStats() });
    return false;
  }

  // v2.3.0 Aşama 2: Skor hesabı
  // payload: { viewerMap: { slug: viewerCount, ... } }
  if (msg.type === 'BOT_COMPUTE_SCORES') {
    sendResponse({ success: true, scores: BotTracker.computeScores(msg.viewerMap || {}) });
    return false;
  }

  if (msg.type === 'BOT_TRACK_STOP') {
    BotTracker.shutdown();
    BotTracker.channels.clear();
    sendResponse({ success: true });
    return false;
  }

  return false;
});
