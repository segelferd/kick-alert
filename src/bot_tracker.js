/**
 * KickAlert - Bot Tracker Module (v2.3.0)
 *
 * Cross-platform module for chat-based bot detection.
 * - Chrome: Loaded inside offscreen document (offscreen.html)
 * - Firefox: Loaded as a background script directly (no offscreen API in Firefox MV3)
 *
 * Exposes a global `BotTracker` object. Pure JS, no chrome.* dependencies
 * inside the tracker logic itself — message handlers wire it to the host.
 *
 * © 2026 Segelferd. All rights reserved.
 */

// ═══════════════════════════════════════════════════════════════
// BOT TRACKER — Pusher WebSocket
// ═══════════════════════════════════════════════════════════════

const PUSHER_URL = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

// v2.3.20: Chrome'da bu dosya offscreen.html içinde, kendi ayrı DevTools
// context'inde çalışıyor — arka plan servisi konsolundan kopuk. Önemli
// olayları background.js'e iletir (Firefox'ta zaten background context'in
// içinde olduğu için bu no-op'a yakın davranır, zararı yok).
function relayLog(level, code, text) {
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_LOG', level, code, text }).catch(() => {});
    }
  } catch (e) {}
}

const TRACKING_WINDOW_MS = 15 * 60 * 1000;     // 15 dk sliding window
const ACTIVE_CHATTER_MS = 5 * 60 * 1000;       // son 5 dk = aktif chatter
const RECONNECT_INITIAL_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const PING_INTERVAL_MS = 30000;
const CONNECTION_TIMEOUT_MS = 10000;

const BotTracker = {
  ws: null,
  isConnecting: false,
  isConnected: false,
  reconnectDelay: RECONNECT_INITIAL_MS,
  reconnectTimer: null,
  pingTimer: null,
  connectionTimeoutTimer: null,

  // Map<chatroomId, { slug, userId, messages: [{t, userId}], modes: {...} }>
  channels: new Map(),

  // Connect WebSocket if not already connected
  async ensureConnection() {
    if (this.isConnected) return true;
    if (this.isConnecting) return false;

    this.isConnecting = true;
    try {
      this.ws = new WebSocket(PUSHER_URL);

      this.connectionTimeoutTimer = setTimeout(() => {
        if (!this.isConnected) {
          console.warn('[KickAlert][BotTracker] Connection timeout');
          relayLog('warn', 'BOT-01', 'BotTracker bağlantı zaman aşımı');
          try { this.ws?.close(); } catch {}
        }
      }, CONNECTION_TIMEOUT_MS);

      this.ws.addEventListener('open', () => {
        console.debug('[KickAlert][BotTracker] WebSocket open');
      });

      this.ws.addEventListener('message', (ev) => this._handleMessage(ev));

      this.ws.addEventListener('error', (err) => {
        console.warn('[KickAlert][BotTracker] WebSocket error');
        relayLog('warn', 'BOT-02', 'BotTracker WebSocket hatası');
      });

      this.ws.addEventListener('close', () => {
        console.debug('[KickAlert][BotTracker] WebSocket closed');
        this.isConnected = false;
        this.isConnecting = false;
        clearTimeout(this.connectionTimeoutTimer);
        clearInterval(this.pingTimer);
        this.pingTimer = null;

        // Auto-reconnect if we still have channels to track
        if (this.channels.size > 0) {
          this._scheduleReconnect();
        }
      });

      return false;
    } catch (e) {
      console.warn('[KickAlert][BotTracker] ensureConnection error:', e.message);
      relayLog('warn', 'BOT-03', 'BotTracker bağlantı kurma hatası: ' + e.message);
      this.isConnecting = false;
      return false;
    }
  },

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    console.debug(`[KickAlert][BotTracker] Reconnect in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.ensureConnection().then(() => {
        if (this.isConnected) {
          for (const [chatroomId, info] of this.channels) {
            this._sendSubscribes(chatroomId, info.userId);
          }
        }
      });
    }, delay);
  },

  _handleMessage(ev) {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch { return; }

    if (data.event === 'pusher:connection_established') {
      this.isConnected = true;
      this.isConnecting = false;
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      clearTimeout(this.connectionTimeoutTimer);
      console.debug('[KickAlert][BotTracker] Connection established');
      relayLog('info', 'BOT-04', 'BotTracker bağlantısı kuruldu');

      for (const [chatroomId, info] of this.channels) {
        this._sendSubscribes(chatroomId, info.userId);
      }

      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ event: 'pusher:ping', data: {} }));
        }
      }, PING_INTERVAL_MS);
      return;
    }

    if (data.event === 'pusher:pong' || data.event === 'pusher:error') return;
    if (data.event === 'pusher_internal:subscription_succeeded') return;

    // Chat message events
    if (data.event === 'App\\Events\\ChatMessageEvent' || data.event === 'App\\Events\\ChatMessageSentEvent') {
      this._handleChatMessage(data);
      return;
    }

    // Chatroom mode updates: slow mode / sub-only mode
    if (data.event === 'App\\Events\\ChatroomUpdatedEvent') {
      this._handleChatroomUpdate(data);
      return;
    }
  },

  _handleChatMessage(data) {
    // data.channel format: "chatrooms.{id}.v2"
    const channelMatch = data.channel?.match(/^chatrooms\.(\d+)\./);
    if (!channelMatch) return;
    const chatroomId = parseInt(channelMatch[1], 10);
    const info = this.channels.get(chatroomId);
    if (!info) return;

    let payload;
    try {
      payload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
    } catch { return; }

    const userId = payload?.sender?.id || payload?.user_id || 0;
    const now = Date.now();

    info.messages.push({ t: now, userId });

    // Prune old messages
    const cutoff = now - TRACKING_WINDOW_MS;
    while (info.messages.length > 0 && info.messages[0].t < cutoff) {
      info.messages.shift();
    }
  },

  _handleChatroomUpdate(data) {
    const channelMatch = data.channel?.match(/^chatrooms?[._](\d+)/);
    if (!channelMatch) return;
    const chatroomId = parseInt(channelMatch[1], 10);
    const info = this.channels.get(chatroomId);
    if (!info) return;

    let payload;
    try {
      payload = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
    } catch { return; }

    if (payload?.slow_mode) {
      info.modes.slowMode = !!payload.slow_mode.enabled;
      info.modes.slowModeCooldown = payload.slow_mode.message_interval || 0;
    }
    if (payload?.subscribers_mode) {
      info.modes.subOnly = !!payload.subscribers_mode.enabled;
    }
  },

  _sendSubscribes(chatroomId, userId) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const subs = [
      `chatrooms.${chatroomId}.v2`,
      `chatrooms.${chatroomId}`,
      `chatroom_${chatroomId}`,
    ];
    if (userId) {
      subs.push(`channel_${userId}`);
      subs.push(`channel.${userId}`);
    }
    for (const channel of subs) {
      this.ws.send(JSON.stringify({
        event: 'pusher:subscribe',
        data: { auth: '', channel },
      }));
    }
  },

  _sendUnsubscribes(chatroomId, userId) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const subs = [
      `chatrooms.${chatroomId}.v2`,
      `chatrooms.${chatroomId}`,
      `chatroom_${chatroomId}`,
    ];
    if (userId) {
      subs.push(`channel_${userId}`);
      subs.push(`channel.${userId}`);
    }
    for (const channel of subs) {
      try {
        this.ws.send(JSON.stringify({
          event: 'pusher:unsubscribe',
          data: { channel },
        }));
      } catch {}
    }
  },

  async addChannel(slug, chatroomId, userId) {
    if (this.channels.has(chatroomId)) return;

    this.channels.set(chatroomId, {
      slug,
      userId: userId || 0,
      messages: [],
      modes: { slowMode: false, slowModeCooldown: 0, subOnly: false },
    });

    await this.ensureConnection();
    if (this.isConnected) {
      this._sendSubscribes(chatroomId, userId);
    }
  },

  removeChannel(chatroomId) {
    const info = this.channels.get(chatroomId);
    if (!info) return;
    this._sendUnsubscribes(chatroomId, info.userId);
    this.channels.delete(chatroomId);

    if (this.channels.size === 0) {
      this.shutdown();
    }
  },

  // Replace tracked channels with new list
  // newList: Array<{ slug, chatroomId, userId }>
  async syncChannels(newList) {
    const newIds = new Set(newList.map(c => c.chatroomId));
    const currentIds = new Set(this.channels.keys());

    // Remove channels no longer in list
    for (const id of currentIds) {
      if (!newIds.has(id)) {
        this.removeChannel(id);
      }
    }

    // Add new channels
    for (const ch of newList) {
      if (!currentIds.has(ch.chatroomId)) {
        await this.addChannel(ch.slug, ch.chatroomId, ch.userId);
      }
    }
  },

  // Returns: { [slug]: { msgPerMin, activeChatters, totalMessages, modes } }
  getStats() {
    const now = Date.now();
    const out = {};
    for (const [chatroomId, info] of this.channels) {
      const totalMessages = info.messages.length;

      const oldestMsg = info.messages[0]?.t || now;
      const windowMs = Math.min(now - oldestMsg, TRACKING_WINDOW_MS);
      const windowMin = Math.max(windowMs / 60000, 1);
      const msgPerMin = totalMessages / windowMin;

      const activeCutoff = now - ACTIVE_CHATTER_MS;
      const activeUsers = new Set();
      for (const m of info.messages) {
        if (m.t >= activeCutoff && m.userId) {
          activeUsers.add(m.userId);
        }
      }

      out[info.slug] = {
        msgPerMin: Math.round(msgPerMin * 10) / 10,
        activeChatters: activeUsers.size,
        totalMessages,
        modes: { ...info.modes },
      };
    }
    return out;
  },

  // ═════════════════════════════════════════════════════════════
  // v2.3.0 Aşama 2 — MoKick Bot Skor Hesabı
  // ═════════════════════════════════════════════════════════════
  // Formül (MoKick'ten reverse-engineered):
  //   p = 0.6725 + 0.07 * (1 - exp(-viewer_count / 3000))
  //   expected = viewer_count^p * 0.465 * mode_multiplier
  //   ratio = active_chatters / expected
  //   score = 100 / (1 + exp(-2.0 * (ratio - 0.9)))
  //
  // Mode multiplier (chatter beklentisi azalır):
  //   sub_only: 0.30 (sadece subscriber yazabilir)
  //   slow_mode (cooldown'a göre): 6sn=0.85, 30sn=0.50, 60sn=0.30, 120sn+=0.20
  //   normal: 1.0
  //
  // Skor anlamı:
  //   0-30  = bot şüphesi yüksek (chatter beklenenden çok az)
  //   30-70 = belirsiz / küçük community
  //   70-100 = sağlıklı (chatter beklenen düzeyde veya üzeri)
  //
  // Yetersiz veri → score: null (popup'ta gösterilmesin)

  _modeMultiplier(modes) {
    if (!modes) return 1.0;
    if (modes.subOnly) return 0.30;
    if (modes.slowMode && modes.slowModeCooldown > 0) {
      const cd = modes.slowModeCooldown;
      if (cd <= 6) return 0.85;
      if (cd <= 15) return 0.65;
      if (cd <= 30) return 0.50;
      if (cd <= 60) return 0.30;
      return 0.20;
    }
    return 1.0;
  },

  // v2.3.0: Sohbet sağlık skoru — logaritmik beklenti, linear 0-100 ölçek.
  // Streamscharts'ın "viewsRatio" mantığına benzer ama Kick'e adapte (chat-bazlı).
  //
  // Mantık:
  //   1. Beklenen chatter ORANI viewer büyüklüğüne göre logaritmik düşer:
  //        100 viewer  → ~%4.9 chatter beklenir (1/20 izleyici)
  //        1000 viewer → ~%3.3 chatter (1/30)
  //        10K viewer  → ~%2.5 chatter (1/40)
  //        30K viewer  → ~%2.2 chatter (1/45)
  //   2. Gerçek oran ile karşılaştır → health = actual / expected_ratio
  //   3. Linear ölçek: health=1.0 → 50 puan, health=2.0+ → 100 puan, health=0 → 0 puan
  //
  // 5 tier renk (streamscharts skalası):
  //   0-20:  very-low (çok şüpheli)
  //   20-40: low      (şüpheli)
  //   40-60: medium   (normal)
  //   60-80: high     (sağlıklı)
  //   80+:   very-high (çok aktif community)
  _computeOne(viewerCount, activeChatters, modes) {
    if (!viewerCount || viewerCount <= 0) return null;

    // Logaritmik beklenen chatter oranı
    // log10(10) = 1 (küçük), log10(30000) ≈ 4.48 (büyük)
    const expectedRatio = 0.10 / Math.log10(viewerCount + 10);

    // Mode multiplier (sub-only, slow mode → beklenti düşer)
    const modeMult = this._modeMultiplier(modes);
    const adjustedExpectedRatio = expectedRatio * modeMult;

    if (adjustedExpectedRatio <= 0) return null;

    // Gerçek oran ve sağlık (health)
    const actualRatio = activeChatters / viewerCount;
    const health = actualRatio / adjustedExpectedRatio;

    // 0-100 linear ölçek (cap at 100)
    // health = 1.0 (tam beklenen) → 50 puan
    // health = 2.0+ (beklenenin 2 katı veya üstü) → 100 puan
    // health = 0 (hiç chatter yok) → 0 puan
    const score = Math.min(100, Math.round(health * 50));

    // Beklenen chatter sayısı (gösterim için)
    const expected = Math.round(adjustedExpectedRatio * viewerCount);

    return {
      score,
      ratio: Math.round(health * 100) / 100,  // health (1.0 = beklenen)
      expected,
      modeMult,
    };
  },

  /**
   * Tüm tracked kanallar için skor hesapla.
   * @param {Object} viewerMap — { slug: viewerCount } (background.js'den gelir)
   * @returns {Object} — { slug: { score, ratio, msgPerMin, activeChatters, expected, modeMult } | null }
   */
  computeScores(viewerMap) {
    const now = Date.now();
    const stats = this.getStats();
    const out = {};

    for (const [slug, s] of Object.entries(stats)) {
      const viewerCount = viewerMap?.[slug] || 0;

      // En eski mesajın timestamp'ini bul (chatroomId sahibinin ilk mesajı)
      // Mesaj yoksa null — insufficient kontrolünde ayrıca handle ediyoruz
      let oldestMsgT = null;
      let totalMessages = 0;
      for (const [_chatroomId, info] of this.channels.entries()) {
        if (info.slug === slug) {
          oldestMsgT = info.messages?.[0]?.t ?? null;
          totalMessages = info.messages?.length ?? 0;
          break;
        }
      }

      // v2.3.0: Yetersiz veri kontrolü — daha pragmatik:
      // - Hiç mesaj yok → no_messages
      // - 30'dan az mesaj VE 2 dk'dan az veri (her ikisi de) → data_too_new
      //   (aktif kanallarda 30 mesaj saniyeler içinde dolar, sessiz kanallar için 2 dk fallback)
      // - 3'ten az aktif chatter → few_chatters
      // - Viewer count <= 0 → no_viewer_count
      const noData = oldestMsgT === null || totalMessages === 0;
      const dataAge = oldestMsgT ? (now - oldestMsgT) : 0;
      // Eşik: 30+ mesaj VEYA 2 dk+ pencere — en az birini sağlamalı
      const dataTooNew = !noData && totalMessages < 30 && dataAge < 2 * 60 * 1000;
      const insufficient = noData || dataTooNew || s.activeChatters < 3 || viewerCount <= 0;

      if (insufficient) {
        out[slug] = {
          score: null,
          ratio: null,
          expected: null,
          msgPerMin: s.msgPerMin,
          activeChatters: s.activeChatters,
          totalMessages,
          modes: s.modes,
          insufficient: true,
          insufficientReason: noData ? 'no_messages'
            : dataTooNew ? 'data_too_new'
            : s.activeChatters < 3 ? 'few_chatters'
            : 'no_viewer_count',
        };
        continue;
      }

      const calc = this._computeOne(viewerCount, s.activeChatters, s.modes);
      if (!calc) {
        out[slug] = { score: null, insufficient: true, msgPerMin: s.msgPerMin, activeChatters: s.activeChatters };
        continue;
      }

      out[slug] = {
        score: calc.score,
        ratio: calc.ratio,
        expected: calc.expected,
        msgPerMin: s.msgPerMin,
        activeChatters: s.activeChatters,
        modes: s.modes,
        modeMult: calc.modeMult,
        insufficient: false,
      };
    }

    return out;
  },

  shutdown() {
    console.debug('[KickAlert][BotTracker] Shutdown');
    clearInterval(this.pingTimer);
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectionTimeoutTimer);
    this.pingTimer = null;
    this.reconnectTimer = null;
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectDelay = RECONNECT_INITIAL_MS;
  },
};
