/**
 * KickAlert - Pusher WebSocket Module (Plan F)
 *
 * Connects to Kick's underlying Pusher WebSocket to receive real-time
 * `StreamerIsLive` events. This bypasses Cloudflare API rate limits because:
 *   1. WebSocket is on pusher.com (different infrastructure)
 *   2. Anonymous subscribe — no auth challenge
 *   3. Single long-lived connection vs periodic polling
 *
 * Architecture:
 *   - background.js calls Pusher.start(channelIds[])
 *   - We open WS to wss://ws-us2.pusher.com/app/...
 *   - For each channel_id we send pusher:subscribe → channel.{channel_id}
 *   - When 'App\\Events\\StreamerIsLive' arrives → callback with slug
 *   - background.js fetches fresh data + sends notification
 *
 * Resilience:
 *   - Auto-reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s)
 *   - Ping/pong every 30s (Pusher drops idle connections)
 *   - Resubscribe all channels on reconnect
 *   - If WS persistently fails → background.js falls back to API polling
 *
 * Browser compatibility:
 *   - chrome.runtime.connect / WebSocket native — both Chrome MV3 and Firefox MV2
 *   - In MV3 service worker, WebSocket connection keeps SW alive (anti-sleep)
 *
 * ⚠️ BUG#10 NOTU — İKİZ IMPLEMENTASYON SENKRONİZASYONU:
 *   Bu modül (pusher.js) FIREFOX yolunda kullanılır (SW içinde WebSocket).
 *   CHROME yolunda offscreen.js içindeki `LiveTracker` objesi kullanılır
 *   (offscreen document hiç uyumadığı için WebSocket kopmaz).
 *   İKİSİ DE aynı event formatını parse eder:
 *     - 'App\\Events\\StreamerIsLive'   → livestream.channel_id
 *     - 'App\\Events\\StopStreamBroadcast' → livestream.channel.id
 *   Kick event formatını değiştirirse HER İKİ dosyayı da güncelle:
 *   pusher.js (_onMessage) VE offscreen.js (LiveTracker._onMessage).
 *
 * © 2025 Segelferd
 */

const Pusher = {
  // Pusher Channels app ID — reverse-engineered from Kick.com sayfa
  // (this is the same app every Kick browser tab connects to)
  APP_KEY: '32cbd69e4b950bf97679',
  WS_URL: 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false',

  // State
  _ws: null,                          // Current WebSocket instance
  _subscribedChannels: new Set(),     // 'channel.123', 'channel.456'
  _pendingSubscribes: new Set(),      // queue while connecting
  _channelIdToSlug: {},               // v2.3.1 Plan F: { 229932: 'jahrein' } — live event channel_id → slug map
  _reconnectAttempt: 0,
  _reconnectTimer: null,
  _pingTimer: null,
  _lastPongAt: 0,
  _connected: false,
  _socketId: null,                    // pusher socket_id (for diagnostic)
  _onLiveCallback: null,              // (slug, livestreamData) => {}
  _onOfflineCallback: null,           // (slug, data) => {} — StopStreamBroadcast
  _stats: {
    connects: 0,
    disconnects: 0,
    messages: 0,
    liveEvents: 0,
    errors: 0,
  },

  /**
   * Start Pusher connection. Should be called once during init.
   * @param {Function} onLive - Callback when channel goes live: (slug, data) => {}
   * @param {Function} [onOffline] - Callback when channel goes offline: (slug, data) => {}
   */
  start(onLive, onOffline) {
    this._onLiveCallback = onLive;
    this._onOfflineCallback = onOffline || null;
    this._connect();
  },

  /**
   * Subscribe to a channel by its numeric channel ID.
   * v2.3.1 Plan F: slug parametresi de alıyoruz — live event channel_id veriyor,
   * slug vermiyor. channel_id → slug mapping'i burada kuruyoruz.
   * @param {number} channelId
   * @param {string} slug - kanal slug'ı (live event'te slug gelmiyor, map için gerekli)
   */
  subscribeChannel(channelId, slug) {
    if (!channelId) return;
    // channel_id → slug mapping (live event geldiğinde ters lookup için)
    if (slug) this._channelIdToSlug[channelId] = slug;

    const channelName = `channel.${channelId}`;
    if (this._subscribedChannels.has(channelName)) return;

    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
      this._sendSubscribe(channelName);
      this._subscribedChannels.add(channelName);
    } else {
      // Connection not ready, queue for after connect
      this._pendingSubscribes.add(channelName);
    }
  },

  /** Unsubscribe a channel (e.g. user removed from favorites). */
  unsubscribeChannel(channelId) {
    if (!channelId) return;
    const channelName = `channel.${channelId}`;
    this._subscribedChannels.delete(channelName);
    this._pendingSubscribes.delete(channelName);
    delete this._channelIdToSlug[channelId];
    if (this._connected && this._ws && this._ws.readyState === WebSocket.OPEN) {
      try {
        this._ws.send(JSON.stringify({
          event: 'pusher:unsubscribe',
          data: { channel: channelName },
        }));
      } catch (e) { /* ignore */ }
    }
  },

  /**
   * Subscribe to many channels in one batch.
   * @param {Array<{channelId:number, slug:string}>} items
   */
  subscribeAll(items) {
    for (const item of items) {
      if (typeof item === 'object') {
        this.subscribeChannel(item.channelId, item.slug);
      } else {
        // Geriye dönük uyumluluk: sadece ID array'i
        this.subscribeChannel(item);
      }
    }
  },

  /** Get diagnostic state */
  getState() {
    return {
      connected: this._connected,
      socketId: this._socketId,
      subscribedCount: this._subscribedChannels.size,
      pendingCount: this._pendingSubscribes.size,
      reconnectAttempt: this._reconnectAttempt,
      lastPongAt: this._lastPongAt,
      stats: { ...this._stats },
    };
  },

  /** Force stop (cleanup) */
  stop() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    if (this._ws) {
      try { this._ws.close(); } catch (e) { /* ignore */ }
      this._ws = null;
    }
    this._connected = false;
  },

  // ─── Internal methods ──────────────────────────────────────────────────

  _connect() {
    if (this._ws && (this._ws.readyState === WebSocket.OPEN || this._ws.readyState === WebSocket.CONNECTING)) {
      return; // Already connecting/connected
    }
    try {
      console.debug('[KickAlert] Pusher: bağlanıyor...');
      this._ws = new WebSocket(this.WS_URL);
      this._stats.connects++;

      this._ws.addEventListener('open', () => {
        console.debug('[KickAlert] Pusher: WebSocket açıldı (handshake bekleniyor)');
        // Pusher will send pusher:connection_established next
      });

      this._ws.addEventListener('message', (e) => this._onMessage(e));

      this._ws.addEventListener('close', (e) => {
        console.debug(`[KickAlert] Pusher: kapandı (code: ${e.code}, reason: ${e.reason || 'yok'})`);
        this._stats.disconnects++;
        this._connected = false;
        this._socketId = null;
        if (this._pingTimer) {
          clearInterval(this._pingTimer);
          this._pingTimer = null;
        }
        this._scheduleReconnect();
      });

      this._ws.addEventListener('error', (e) => {
        this._stats.errors++;
        // Don't log noisy 'error' — close handler will manage reconnect
      });
    } catch (e) {
      console.warn('[KickAlert] Pusher: WebSocket oluşturulamadı:', e.message);
      this._stats.errors++;
      this._scheduleReconnect();
    }
  },

  _onMessage(e) {
    this._stats.messages++;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      return; // ignore malformed
    }

    const event = msg.event;

    // Pusher protocol events
    if (event === 'pusher:connection_established') {
      try {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        this._socketId = data.socket_id;
        this._connected = true;
        this._reconnectAttempt = 0;
        this._lastPongAt = Date.now();
        console.debug(`[KickAlert] Pusher: bağlantı kuruldu (socket_id: ${this._socketId})`);

        // Subscribe to all pending + already-subscribed channels
        const allChannels = new Set([...this._subscribedChannels, ...this._pendingSubscribes]);
        this._subscribedChannels.clear();
        this._pendingSubscribes.clear();
        for (const ch of allChannels) {
          this._sendSubscribe(ch);
          this._subscribedChannels.add(ch);
        }

        // Start ping interval
        if (this._pingTimer) clearInterval(this._pingTimer);
        this._pingTimer = setInterval(() => this._sendPing(), 30000);
      } catch (err) {
        console.warn('[KickAlert] Pusher: connection_established parse hatası:', err.message);
      }
      return;
    }

    if (event === 'pusher:pong') {
      this._lastPongAt = Date.now();
      return;
    }

    if (event === 'pusher:ping') {
      // Server-initiated ping — respond with pong
      this._sendRaw({ event: 'pusher:pong', data: {} });
      return;
    }

    if (event === 'pusher:error') {
      // Pusher protokolü: code 4000-4099 KALICI (gerçek sorun), 4100+ geçici
      // (reconnect zaten devrede). Geçici hataları Verbose'a, kalıcıları warn'a.
      let d = msg.data;
      try { d = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data; } catch {}
      const code = d && (d.code ?? d.Code);
      const message = (d && (d.message ?? d.Message)) || '';
      if (typeof code === 'number' && code >= 4000 && code <= 4099) {
        console.warn(`[KickAlert] Pusher kalıcı hata (${code}): ${message}`);
      } else {
        console.debug(`[KickAlert] Pusher geçici hata (${code ?? '?'}): ${message} — reconnect devrede`);
      }
      return;
    }

    if (event === 'pusher_internal:subscription_succeeded') {
      // Channel subscribe confirmed — no action needed
      return;
    }

    // App events (Kick's Laravel backend forwards these via Pusher)
    // Event isimleri 'App\Events\' ile başlar.
    // StreamerIsLive data: { livestream: { id, channel_id, session_title, created_at } }
    // NOT: Event 'slug' VERMİYOR — channel_id veriyor. Slug'a map etmemiz lazım.
    if (event === 'App\\Events\\StreamerIsLive') {
      this._stats.liveEvents++;
      try {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const channelId = data.livestream?.channel_id;
        const slug = this._channelIdToSlug[channelId];
        if (slug && this._onLiveCallback) {
          console.debug(`[KickAlert] Pusher: StreamerIsLive → ${slug} (channel_id: ${channelId})`);
          this._onLiveCallback(slug, data);
        } else if (!slug) {
          console.debug(`[KickAlert] Pusher: StreamerIsLive channel_id ${channelId} için slug bulunamadı (map eksik)`);
        }
      } catch (err) {
        console.warn('[KickAlert] Pusher: live event parse hatası:', err.message);
      }
      return;
    }

    // StopStreamBroadcast: yayın bitti — live state'i güncelle (bildirim yok)
    // data: { livestream: { id, channel: { id, is_banned } } }
    if (event === 'App\\Events\\StopStreamBroadcast') {
      try {
        const data = typeof msg.data === 'string' ? JSON.parse(msg.data) : msg.data;
        const channelId = data.livestream?.channel?.id;
        const slug = this._channelIdToSlug[channelId];
        if (slug && this._onOfflineCallback) {
          console.debug(`[KickAlert] Pusher: StopStreamBroadcast → ${slug} offline`);
          this._onOfflineCallback(slug, data);
        }
      } catch (err) { /* sessiz */ }
      return;
    }

    // Other events (ChatMessage etc) — ignore for now
  },

  _sendSubscribe(channelName) {
    this._sendRaw({
      event: 'pusher:subscribe',
      data: { auth: '', channel: channelName },
    });
  },

  _sendPing() {
    if (!this._connected || !this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    this._sendRaw({ event: 'pusher:ping', data: {} });

    // Health check: if no pong received in 45s, force reconnect
    if (Date.now() - this._lastPongAt > 45000) {
      console.debug('[KickAlert] Pusher: pong gelmedi 45sn, reconnect ediliyor');
      try { this._ws.close(); } catch (e) { /* close listener reconnect tetikler */ }
    }
  },

  _sendRaw(msg) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;
    try {
      this._ws.send(JSON.stringify(msg));
    } catch (e) {
      this._stats.errors++;
    }
  },

  _scheduleReconnect() {
    if (this._reconnectTimer) return; // Already scheduled

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempt), 30000);
    this._reconnectAttempt++;
    // Add small jitter to avoid thundering herd
    const jitteredDelay = delay + Math.random() * 1000;

    console.debug(`[KickAlert] Pusher: ${Math.round(jitteredDelay/1000)}sn sonra reconnect (deneme ${this._reconnectAttempt})`);

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, jitteredDelay);
  },
};

// SW global'e ekle
if (typeof self !== 'undefined') self.Pusher = Pusher;
