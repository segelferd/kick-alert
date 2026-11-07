/**
 * KickAlert - Bot Tracker Module (v2.3.0)
 *
 * Cross-platform module for chat-based bot detection.
 * - Chrome: Loaded inside offscreen document (offscreen.html)
 * - Firefox: Loaded as a background script directly (no offscreen API in Firefox MV3)
 *
 * Exposes a global `BotTracker` object. Pure JS, no chrome.* dependencies
 * inside the tracker logic itself - message handlers wire it to the host.
 *
 * © 2026 Segelferd. All rights reserved.
 */

// ═══════════════════════════════════════════════════════════════
// BOT TRACKER - Pusher WebSocket
// ═══════════════════════════════════════════════════════════════

// v2.5.78: Bağlantı adresi pusher-config.js'teki KAPusherCfg.url() (Kick anahtarı
// değiştirince arka plan yenisini alır). Chrome'da offscreen.html, Firefox'ta
// manifest bu dosyadan önce pusher-config.js'i yükler.

// v2.3.20: Chrome'da bu dosya offscreen.html içinde, kendi ayrı DevTools
// context'inde çalışıyor - arka plan servisi konsolundan kopuk. Önemli
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
// v2.5.91: Kick active-chatters total_count -> bizim 5 dk sayımımız. 22.10.2026
// ölçümü: 2.800-47.000 izleyicili 8 kanal, 17 dakika, 5. dakikadan sonra 104
// örnek, oran ortanca 0,33 (çeyrekler 0,29-0,39). Kanal bazında öğrenilen oran
// varsa o kullanılır.
const KICK_TO_OWN_RATIO = 0.33;
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
  _rt: kaRtHealth(), // v2.5.94

  // Map<chatroomId, { slug, userId, messages: [{t, userId}], modes: {...} }>
  channels: new Map(),

  // v2.5.54: Raid (host) olayı geldiğinde çağrılır: ({ slug, raider, viewers, message, event, raw })
  // Chrome: offscreen.js bunu arka plana mesajla iletir. Firefox: background.js doğrudan bağlar.
  onRaid: null,

  // v2.5.103: Arka plan sohbet radarı. Arka plan ayarı setRadar ile verir:
  // { slugs: ['kanal', ...], me: 'kullanıcıadı', words: ['kelime', ...] }.
  // Seçili kanallarda adın ya da kelimelerden biri geçerse onRadar çağrılır.
  // Eşleştirme textfold.js ile (sohbet filtreleriyle aynı kurallar).
  radar: null,
  onRadar: null,
  setRadar(cfg) {
    const slugs = Array.isArray(cfg && cfg.slugs) ? cfg.slugs.map(x => String(x).toLowerCase()).filter(Boolean).slice(0, 5) : [];
    const words = Array.isArray(cfg && cfg.words) ? cfg.words.map(x => String(x).trim()).filter(Boolean).slice(0, 50) : [];
    const me = cfg && cfg.me ? String(cfg.me).trim().replace(/^@/, '') : '';
    this.radar = (slugs.length && (me || words.length)) ? { slugs: new Set(slugs), me, words } : null;
  },

  // Connect WebSocket if not already connected
  async ensureConnection() {
    if (this.isConnected) return true;
    if (this.isConnecting) return false;

    this.isConnecting = true;
    try {
      const ws = kaOpenRealtimeSocket(); // v2.5.90: Pusher ya da Centrifugo
      this.ws = ws;

      this.connectionTimeoutTimer = setTimeout(() => {
        if (ws !== this.ws) return; // v2.5.78: bırakılmış eski bağlantı
        if (!this.isConnected) {
          // v2.5.94: kısa kopmalar uyarı değil; 5 dk (internet varken) sürerse uyarı
          if (this._rt.fail()) {
            console.warn('[KickAlert][BotTracker] 5 dakikadır bağlanamıyor (son deneme: zaman aşımı)');
            relayLog('warn', 'BOT-01', 'BotTracker 5 dakikadır bağlanamıyor (son deneme: zaman aşımı)');
          } else {
            console.debug('[KickAlert][BotTracker] Connection timeout, yeniden denenecek');
          }
          try { this.ws?.close(); } catch {}
        }
      }, CONNECTION_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        console.debug('[KickAlert][BotTracker] WebSocket open');
      });

      ws.addEventListener('message', (ev) => { if (ws === this.ws) this._handleMessage(ev); });

      ws.addEventListener('error', (err) => {
        if (ws !== this.ws) return;
        // v2.5.78: kalıcı hata döngüsünde her denemede uyarı yazmasın
        if (this._permanentKey === KAPusherCfg.key) return;
        if (this._rt.fail()) {
          console.warn('[KickAlert][BotTracker] 5 dakikadır bağlanamıyor (son deneme: WebSocket hatası)');
          relayLog('warn', 'BOT-02', 'BotTracker 5 dakikadır bağlanamıyor (son deneme: WebSocket hatası)');
        } else {
          console.debug('[KickAlert][BotTracker] WebSocket error, yeniden denenecek');
        }
      });

      ws.addEventListener('close', (ev) => {
        if (ws !== this.ws) return; // v2.5.78: restart()/shutdown() ile bırakılan eski bağlantı
        console.debug('[KickAlert][BotTracker] WebSocket closed');
        this.isConnected = false;
        this.isConnecting = false;
        clearTimeout(this.connectionTimeoutTimer);
        clearInterval(this.pingTimer);
        this.pingTimer = null;

        // v2.5.78: Kalıcı hata (4000-4099, ör. 4001 anahtar yok): arka plana
        // haber ver, aynı anahtarla 15 dk sonra dene (sonsuz 30 sn döngüsü yerine)
        const permanent = kaIsPermanentPusherCode(ev && ev.code);
        if (permanent) {
          if (this._permanentKey !== KAPusherCfg.key) {
            this._permanentKey = KAPusherCfg.key;
            console.warn(`[KickAlert][BotTracker] Pusher kalıcı hata (${ev.code}): ${ev.reason || ''}`);
            relayLog('warn', 'BOT-05', `BotTracker Pusher kalıcı hata (${ev.code}): ${ev.reason || ''}`);
          }
          KAPusherCfg.reportInvalid('bot', ev.code, ev.reason || '');
        }

        // Auto-reconnect if we still have channels to track
        if (this.channels.size > 0) {
          this._scheduleReconnect(permanent ? KA_PUSHER_PERMANENT_RETRY_MS : undefined);
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

  _scheduleReconnect(fixedDelay) {
    if (this.reconnectTimer) return;
    // v2.5.94: internet yokken deneme yapma; geri gelince hemen bağlan
    // (online olayı gelmezse 5 dk sonra yine dene)
    if (!fixedDelay && !kaRtOnline()) {
      this._onlineFn = this._onlineFn || (() => {
        if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
        this.reconnectDelay = RECONNECT_INITIAL_MS;
        if (this.channels.size > 0 && !this.isConnected) this._scheduleReconnect(1);
      });
      kaOnOnlineOnce(this._onlineFn);
      fixedDelay = KA_RT_OFFLINE_FALLBACK_MS;
      console.debug('[KickAlert][BotTracker] İnternet yok, bağlantı bekleniyor');
    }
    const delay = fixedDelay || this.reconnectDelay;
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
      this.connectedAt = Date.now(); // v2.5.89
      this.isConnecting = false;
      this.reconnectDelay = RECONNECT_INITIAL_MS;
      this._permanentKey = null;
      clearTimeout(this.connectionTimeoutTimer);
      console.debug('[KickAlert][BotTracker] Connection established');
      const down = this._rt.ok(); // v2.5.94
      relayLog('info', 'BOT-04', down ? `BotTracker bağlantısı ${Math.max(1, Math.round(down / 60000))} dakikalık kesintiden sonra geri geldi` : 'BotTracker bağlantısı kuruldu');

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

    // v2.5.54: Gelen raid. Kick, raid alan kanalın chatroom kanalına
    // StreamHostEvent (chatrooms.{id}.v2) ve StreamHostedEvent (chatrooms.{id})
    // gönderiyor. Alan adları (host_username, number_viewers, optional_message)
    // açık kaynak projelerden; gerçek olayla doğrulanana kadar esnek okunuyor
    // ve ham veri loglanıyor.
    if (data.event === 'App\\Events\\StreamHostEvent' || data.event === 'App\\Events\\StreamHostedEvent') {
      this._handleHostEvent(data);
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

    // v2.5.103: sohbet radarı
    if (this.radar && this.radar.slugs.has(String(info.slug).toLowerCase())) {
      try { this._radarCheck(info.slug, payload); } catch (e) {}
    }

    info.messages.push({ t: now, userId });
    info.lastMsgAt = now; // v2.5.89: sessizlik bekçisi
    this.lastAnyMsgAt = now;

    // Prune old messages
    const cutoff = now - TRACKING_WINDOW_MS;
    while (info.messages.length > 0 && info.messages[0].t < cutoff) {
      info.messages.shift();
    }
  },

  _radarCheck(slug, p) {
    if (typeof this.onRadar !== 'function' || typeof kaMatchWord !== 'function') return;
    const raw = typeof p?.content === 'string' ? p.content : '';
    if (!raw) return;
    const content = raw.replace(/\[emote:\d+:([^\]]*)\]/g, '$1').trim();
    const from = String(p?.sender?.username || p?.sender?.slug || '').slice(0, 64);
    const r = this.radar;
    if (r.me && from && kaFold(from) === kaFold(r.me)) return; // kendi mesajın
    let kind = null, word = '';
    if (r.me) {
      const orig = p?.metadata?.original_sender?.username || p?.metadata?.original_sender?.slug || '';
      if (orig && kaFold(orig) === kaFold(r.me)) kind = 'reply';
      else if (kaMatchWord(content, r.me) || kaMatchWord(content, '@' + r.me)) kind = 'mention';
    }
    if (!kind) {
      for (const w of r.words) { if (kaMatchWord(content, w)) { kind = 'keyword'; word = w; break; } }
    }
    if (!kind) return;
    this.onRadar({ slug, from, message: content.slice(0, 200), kind, word });
  },

  _handleHostEvent(data) {
    const channelMatch = data.channel?.match(/^chatrooms?[._](\d+)/);
    if (!channelMatch) return;
    const info = this.channels.get(parseInt(channelMatch[1], 10));
    if (!info) return;
    let p;
    try { p = typeof data.data === 'string' ? JSON.parse(data.data) : (data.data || {}); } catch { return; }
    const raider = p.host_username || p.hostUsername || p.host?.username || p.user?.username || p.username
      || p.message?.hostUsername || p.message?.host_username || '';
    // v2.5.82: bazı olaylarda bilgi message altında geliyor (MoKick bu şekli okuyor)
    const vRaw = p.number_viewers ?? p.numberViewers ?? p.viewers_count ?? p.viewers
      ?? p.message?.numberOfViewers ?? p.message?.number_viewers;
    const viewers = (vRaw != null && vRaw !== '' && Number.isFinite(Number(vRaw))) ? Number(vRaw) : null;
    const message = typeof p.optional_message === 'string' ? p.optional_message
      : (typeof p.message?.optionalMessage === 'string' ? p.message.optionalMessage : '');
    relayLog('info', 'RAID-00', `${data.event.split('\\').pop()} ← ${info.slug}: ${JSON.stringify(p).slice(0, 300)}`);
    try { if (typeof this.onRaid === 'function') this.onRaid({ slug: info.slug, raider, viewers, message, event: data.event, raw: p }); } catch (e) {}
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
      info.modesFromEvent = true;
    }
    if (payload?.subscribers_mode) {
      info.modes.subOnly = !!payload.subscribers_mode.enabled;
      info.modesFromEvent = true;
    }
    // v2.5.91 (b035): takipçi, emote ve hesap yaşı modları
    if (payload?.followers_mode) {
      info.modes.followersOnly = !!payload.followers_mode.enabled;
      info.modes.followersMinMin = info.modes.followersOnly ? (Number(payload.followers_mode.min_duration) || 0) : 0;
      info.modesFromEvent = true;
    }
    if (payload?.emotes_mode) {
      info.modes.emotesOnly = !!payload.emotes_mode.enabled;
      info.modesFromEvent = true;
    }
    if (payload?.account_age) {
      info.modes.accountAge = !!payload.account_age.enabled;
      info.modesFromEvent = true;
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

  async addChannel(slug, chatroomId, userId, modes) {
    if (this.channels.has(chatroomId)) return;

    this.channels.set(chatroomId, {
      slug,
      userId: userId || 0,
      addedAt: Date.now(), // v2.5.89: sessizlik bekçisi
      lastMsgAt: 0,
      messages: [],
      modes: { slowMode: false, slowModeCooldown: 0, subOnly: false, followersOnly: false, followersMinMin: 0, emotesOnly: false, accountAge: false },
      modesFromEvent: false,
    });
    this._seedModes(chatroomId, modes);

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
        await this.addChannel(ch.slug, ch.chatroomId, ch.userId, ch.modes);
      } else {
        this._seedModes(ch.chatroomId, ch.modes);
      }
    }
  },

  // v2.5.82: Sohbet modlarını (yavaş mod, abone modu) kanal bilgisinden başlat.
  // Önceden modlar sadece canlı ChatroomUpdatedEvent ile değişiyordu; takip
  // başladığında zaten yavaş moddaki bir kanal 1.0 çarpanla hesaplanıp skoru
  // düşük çıkıyordu. Canlı olaydan gelen bilgi her zaman önceliklidir.
  _seedModes(chatroomId, modes) {
    const info = this.channels.get(chatroomId);
    if (!info || !modes || info.modesFromEvent) return;
    info.modes = {
      slowMode: !!modes.slowMode,
      slowModeCooldown: Number(modes.slowModeCooldown) || 0,
      subOnly: !!modes.subOnly,
      followersOnly: !!modes.followersOnly,
      followersMinMin: Number(modes.followersMinMin) || 0,
      emotesOnly: !!modes.emotesOnly,
      accountAge: !!modes.accountAge,
    };
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
        // v2.5.89: sessizlik bekçisi için (bağlıyken olay gelmiyor mu)
        addedAt: info.addedAt || 0,
        lastMsgAt: info.lastMsgAt || 0,
        connected: !!this.isConnected,
        connectedAt: this.connectedAt || 0,
      };
    }
    return out;
  },

  // ═════════════════════════════════════════════════════════════
  // v2.3.0 Aşama 2 - Bot skor hesabı
  // ═════════════════════════════════════════════════════════════
  // v2.5.82 düzeltme: Buradaki eski açıklama MoKick'in formülünü anlatıyordu,
  // ama kod hiçbir zaman o formülü kullanmadı. Gerçek hesap _computeOne'da:
  //   expectedRatio = 0.10 / log10(viewer + 10)   (beklenen sohbetçi oranı)
  //   expected      = viewer × expectedRatio × mode_multiplier
  //   score         = min(100, round(50 × aktif_sohbetçi / expected))
  // Aktif sohbetçi: son 5 dakikada yazan benzersiz kullanıcı sayısı.
  // Mod çarpanı: abone modu 0.30, yavaş mod (bekleme süresine göre)
  //   ≤6 sn 0.85, ≤15 sn 0.65, ≤30 sn 0.50, ≤60 sn 0.30, daha uzun 0.20;
  //   ikisi birlikte açıksa çarpılır.
  //
  // Yetersiz veri → score: null (popup'ta gösterilmesin)

  // v2.5.82: Abone modu ve yavaş mod birlikte açıksa çarpanlar birleşir
  // (önceden abone modu yavaş modu yok sayıyordu).
  _modeMultiplier(modes) {
    if (!modes) return 1.0;
    let m = 1.0;
    if (modes.subOnly) m *= 0.30;
    if (modes.slowMode && modes.slowModeCooldown > 0) {
      const cd = modes.slowModeCooldown;
      if (cd <= 6) m *= 0.85;
      else if (cd <= 15) m *= 0.65;
      else if (cd <= 30) m *= 0.50;
      else if (cd <= 60) m *= 0.30;
      else m *= 0.20;
    }
    // v2.5.91 (b035): takipçi modu (uzun takip şartı daha çok kişiyi dışarıda
    // bırakır), emote modu (sadece emote yazılabiliyor), hesap yaşı sınırı.
    // Abone modu açıkken takipçi/hesap yaşı şartı zaten kapsanmış olur.
    if (modes.followersOnly && !modes.subOnly) m *= (Number(modes.followersMinMin) || 0) > 10 ? 0.80 : 0.90;
    if (modes.accountAge && !modes.subOnly) m *= 0.95;
    if (modes.emotesOnly) m *= 0.70;
    return m;
  },

  // v2.3.0: Sohbet sağlık skoru - logaritmik beklenti, linear 0-100 ölçek.
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
   * @param {Object} viewerMap - { slug: viewerCount } (background.js'den gelir)
   * @returns {Object} - { slug: { score, ratio, msgPerMin, activeChatters, expected, modeMult } | null }
   */
  computeScores(viewerMap, kickChatters) {
    const now = Date.now();
    const stats = this.getStats();
    const out = {};

    for (const [slug, s] of Object.entries(stats)) {
      const viewerCount = viewerMap?.[slug] || 0;
      const kc = kickChatters && typeof kickChatters[slug] === 'number' ? kickChatters[slug] : null;
      let infoRef = null;
      for (const info of this.channels.values()) { if (info.slug === slug) { infoRef = info; break; } }

      // En eski mesajın timestamp'ini bul (chatroomId sahibinin ilk mesajı)
      // Mesaj yoksa null - insufficient kontrolünde ayrıca handle ediyoruz
      let oldestMsgT = null;
      let totalMessages = 0;
      for (const [_chatroomId, info] of this.channels.entries()) {
        if (info.slug === slug) {
          oldestMsgT = info.messages?.[0]?.t ?? null;
          totalMessages = info.messages?.length ?? 0;
          break;
        }
      }

      // v2.3.0: Yetersiz veri kontrolü - daha pragmatik:
      // - Hiç mesaj yok → no_messages
      // - 30'dan az mesaj VE 2 dk'dan az veri (her ikisi de) → data_too_new
      //   (aktif kanallarda 30 mesaj saniyeler içinde dolar, sessiz kanallar için 2 dk fallback)
      // - 3'ten az aktif chatter → few_chatters
      // - Viewer count <= 0 → no_viewer_count
      const noData = oldestMsgT === null || totalMessages === 0;
      const dataAge = oldestMsgT ? (now - oldestMsgT) : 0;
      // Eşik: 30+ mesaj VEYA 2 dk+ pencere - en az birini sağlamalı
      const dataTooNew = !noData && totalMessages < 30 && dataAge < 2 * 60 * 1000;
      const insufficient = noData || dataTooNew || s.activeChatters < 3 || viewerCount <= 0;

      // v2.5.91 (b035): Kick'in kendi aktif sohbetçi sayısı (kc). Kendi 5 dk
      // sayımımız olgunsa (bağlı, 5 dk+ takip, sessiz değil) skor onunla
      // hesaplanır ve iki sayının oranı kanal bazında öğrenilir. Olgun değilse
      // (ilk dakikalar, bağlantı yok ya da sessiz) Kick sayısı bu oranla (yoksa
      // ölçülmüş genel oranla) bizim ölçeğe çevrilip kullanılır.
      const trackedMs = now - Math.max(s.addedAt || 0, s.connectedAt || 0);
      const ownMature = !insufficient && s.connected && trackedMs >= ACTIVE_CHATTER_MS && (now - (s.lastMsgAt || 0)) < ACTIVE_CHATTER_MS;
      if (kc !== null && kc > 0 && ownMature && infoRef) {
        const r = s.activeChatters / kc;
        infoRef.kickRatio = infoRef.kickRatio ? infoRef.kickRatio * 0.8 + r * 0.2 : r;
      }
      if (kc !== null && viewerCount > 0 && !ownMature) {
        const ratio = (infoRef && infoRef.kickRatio) || KICK_TO_OWN_RATIO;
        const eff = Math.round(kc * ratio);
        if (eff >= 3) {
          const calc = this._computeOne(viewerCount, eff, s.modes);
          if (calc) {
            out[slug] = {
              score: calc.score, ratio: calc.ratio, expected: calc.expected,
              msgPerMin: s.msgPerMin, activeChatters: eff, kickChatters: kc, totalMessages,
              modes: s.modes, modeMult: calc.modeMult, insufficient: false, source: 'kick',
            };
            continue;
          }
        }
      }

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
        source: 'ws',
        kickChatters: kc,
      };
    }

    return out;
  },

  // v2.5.78: Pusher anahtarı değişince yeni anahtarla yeniden bağlan
  restart() {
    this.shutdown();
    if (this.channels.size > 0) {
      this.ensureConnection();
    }
  },

  shutdown() {
    // v2.5.81: zaten kapalıyken her kontrolde "Shutdown" yazmasın
    if (this.ws || this.isConnected || this.isConnecting || this.reconnectTimer) {
      console.debug('[KickAlert][BotTracker] Shutdown');
    }
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
