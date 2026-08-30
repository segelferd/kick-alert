/**
 * KickAlert - Kick API Module
 * Handles all communication with Kick.com API.
 * © 2025 Segelferd. All rights reserved.
 */

const KickAPI = {
  API_URL: 'https://kick.com/api/v2/channels/followed',

  /**
   * Get session token from kick.com cookies for Bearer auth.
   * v2.1.0: Also uses credentials:'include' in fetchKick to send
   * additional session cookies (XSRF-TOKEN, etc.) automatically.
   *
   * v2.3.9: Birden fazla session_token cookie'si aynı anda var olabilir
   * (özellikle giriş yöntemi değiştirildiğinde — Google OAuth ↔ email/şifre —
   * eski cookie hemen silinmeyebilir). Önceden cookies[0] (Chrome'un keyfi/
   * tanımsız sırası) kullanılıyordu, bu da bazen ESKİ/geçersiz cookie'nin
   * seçilmesine yol açabiliyordu. Şimdi Kick Signal'ın da kullandığı yöntemle
   * (kpjjlpmbcbnbemdadfnkgmhchiibifda) en son geçerlilik tarihine (expirationDate)
   * sahip olanı seçiyoruz — giriş yöntemi ne olursa olsun her zaman en güncel
   * session kullanılır.
   */
  async getSessionToken() {
    try {
      const cookies = await chrome.cookies.getAll({ domain: 'kick.com', name: 'session_token' });
      if (cookies.length === 0) return null;
      // v2.4.3: CHIPS (partitionKey) teşhisi — Kick Signal v2.2.0 incelemesinden
      // esinlenildi. Chrome'un bölümlenmiş çerez sistemi, bir çerezi sadece
      // belirli bir üst-seviye bağlamda görünür kılabiliyor. Google/Apple OAuth
      // girişi (yönlendirme/popup içeren bir akış) email/şifreden YAPISAL olarak
      // farklı bir tarayıcı bağlamı yaratıyor — eğer sonuçtaki session_token
      // farklı bir partitionKey ile işaretleniyorsa, bu daha önce hiç
      // bakmadığımız bir ayrım noktası olabilir. NOT: Bu, bugüne kadar
      // kanıtladığımız "Kick sunucu tarafı tutarsızlığı" sonucunu DEĞİŞTİRMEZ —
      // sadece Kick'e sunulacak teşhis raporunu zenginleştirir.
      const partitionKeyOf = (c) => {
        try { return c.partitionKey ? JSON.stringify(c.partitionKey) : 'none'; }
        catch { return 'n/a'; }
      };
      if (cookies.length === 1) {
        // v2.3.22: tek cookie olsa bile teşhis için maskeli id'sini logla
        const val = decodeURIComponent(cookies[0].value);
        const userId = val.split('|')[0] || val.split('%7C')[0] || '?';
        KLog.info('TOK-01', `session_token: tek aday, userId=${userId}, exp=${cookies[0].expirationDate}, partitionKey=${partitionKeyOf(cookies[0])}`);
        return val;
      }

      // v2.3.22: TÜM adayları teşhis için logla — "en yeni expirationDate" seçimi
      // YANLIŞ olabilir: eski token daha UZUN ömürlü verilmiş olabilir, yeni
      // token daha KISA ömürlü. Bu durumda "en yeni tarih" aslında ESKİ/bozuk
      // token'ı seçer. Bunu görmeden bilemeyiz.
      const candidates = cookies.map(c => {
        const val = decodeURIComponent(c.value);
        const userId = val.split('|')[0] || val.split('%7C')[0] || '?';
        return { userId, exp: c.expirationDate, val, partitionKey: partitionKeyOf(c) };
      });
      KLog.warn('TOK-02', `${cookies.length} adet session_token cookie: ` +
        candidates.map(c => `[userId=${c.userId}, exp=${c.exp}, partitionKey=${c.partitionKey}]`).join(' vs '));

      const newest = cookies.reduce((best, c) =>
        (c.expirationDate ?? 0) > (best.expirationDate ?? 0) ? c : best
      );
      const chosenVal = decodeURIComponent(newest.value);
      const chosenUserId = chosenVal.split('|')[0] || chosenVal.split('%7C')[0] || '?';
      KLog.warn('TOK-03', `Seçilen: userId=${chosenUserId}, exp=${newest.expirationDate}, partitionKey=${partitionKeyOf(newest)} (en yüksek expirationDate mantığıyla)`);
      return chosenVal;
    } catch { return null; }
  },

  /**
   * Build request headers for Kick API calls.
   *
   * v2.3.1 KRİTİK GERİ ALMA: Plan D/E header zenginleştirme YANLIŞ yöndeydi.
   * HAR + 3 test sonuçları gösterdi ki:
   *   - 20 header (Plan E)     → 403 ❌
   *   - 0 header (çıplak fetch)→ 403 ❌
   *   - 1 header (sadece Auth) → 200 ✅
   *
   * Sebep: Chrome JavaScript fetch'inde Sec-CH-UA-* header'larını STRİP ediyor
   * (güvenlik kuralı — browser fingerprint manipüle edilmesin). Plan D/E'de
   * eklediğimiz Sec-CH-UA-* header'ları aslında ASLA gönderilmedi.
   *
   * Cloudflare bunu bir bot fingerprint olarak yorumladı:
   *   "priority, sec-fetch-*, origin, referer var ama sec-ch-ua-* yok → BOT"
   *
   * Sadece Authorization + minimum yetkilendirme header'ları → Cloudflare bunu
   * 'legitimate API client' olarak değerlendiriyor, 200 OK dönüyor.
   *
   * NOT: 'via' parametresi geriye dönük uyumluluk için korundu, ama davranışı
   * değiştirmiyor — her iki yolda da aynı minimal header set.
   */
  async makeHeaders(via = 'sw') {
    // v2.3.12 denemesi (Accept-Language/Cache-Control ekleme) sonuç değiştirmedi —
    // geri alındı. Minimal header'a dönüldü.
    const headers = {
      'Accept': 'application/json',
      'X-App-Platform': 'web',
    };
    const token = await this.getSessionToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  },

  /**
   * Alternatif endpoint URL'leri — web.kick.com alt domain'i Cloudflare için
   * farklı kurallar uygulayabilir.
   */
  ALT_FOLLOWED_URLS: [
    // Şimdilik kapalı — endpoint formatı tam değil
  ],

  // Retry config
  _retryDelays: [1000, 2000, 4000, 8000], // exponential backoff
  _lastBackoffUntil: 0, // timestamp — skip API calls until this time
  _lastBackoffDuration: 0, // v2.3.0: son backoff süresi (adaptif uzatma için)
  _lastBackoffEndTime: 0,  // v2.3.0: son backoff bitiş zamanı (kısa sürede tekrar 403 ise uzat)
  _backoffLoadedFromStorage: false, // SW restart sonrası tek seferlik yükleme

  // v2.3.1 (Plan B/M4): Dinamik yavaşlatma için son 10 dk hata penceresi.
  // Alarm tetiklendiğinde bu sayıyı kontrol edip 3+ ise alarm aralığını 2x yavaşlatırız.
  // Diagnostic panel "Son 5dk istatistik" panosu da bu veriyi okur.
  _recentFailures: [],         // timestamp dizisi (401/403 olayları)
  _recentSuccesses: [],        // timestamp dizisi (200 OK olayları)
  _recentJitters: [],          // {ts, ms} — alarm jitter ölçümleri
  _FAILURE_WINDOW_MS: 10 * 60 * 1000, // 10 dakikalık pencere

  _pruneRecent(arr) {
    const now = Date.now();
    // Pencere dışı olanları at (in-place mutate, alloc'tan kaçın)
    let i = 0;
    while (i < arr.length && now - (arr[i].ts ?? arr[i]) > this._FAILURE_WINDOW_MS) i++;
    if (i > 0) arr.splice(0, i);
  },

  _recordFailure() {
    this._recentFailures.push(Date.now());
    this._pruneRecent(this._recentFailures);
  },

  _recordSuccess() {
    this._recentSuccesses.push(Date.now());
    this._pruneRecent(this._recentSuccesses);
  },

  recordJitter(ms) {
    this._recentJitters.push({ ts: Date.now(), ms });
    this._pruneRecent(this._recentJitters);
  },

  /** Son 10 dk içindeki başarısız (401/403) istek sayısı */
  getRecentFailureCount() {
    this._pruneRecent(this._recentFailures);
    return this._recentFailures.length;
  },

  /** Son 5dk istatistiği — diagnostic panel için */
  getRecentApiStats(windowMs = 5 * 60 * 1000) {
    const now = Date.now();
    this._pruneRecent(this._recentFailures);
    this._pruneRecent(this._recentSuccesses);
    this._pruneRecent(this._recentJitters);
    const fails = this._recentFailures.filter(t => now - t <= windowMs).length;
    const ok    = this._recentSuccesses.filter(t => now - t <= windowMs).length;
    const jitters = this._recentJitters.filter(j => now - j.ts <= windowMs).map(j => j.ms);
    const avgJitter = jitters.length
      ? Math.round(jitters.reduce((a,b) => a+b, 0) / jitters.length)
      : 0;
    const maxJitter = jitters.length ? Math.max(...jitters) : 0;
    return {
      windowMin: Math.round(windowMs / 60000),
      requests: ok + fails,
      successes: ok,
      failures: fails,
      successRate: (ok + fails) > 0 ? Math.round((ok / (ok + fails)) * 100) : null,
      avgJitterMs: avgJitter,
      maxJitterMs: maxJitter,
      jitterSamples: jitters.length,
    };
  },

  // v2.3.1 PLAN C — Content Script Proxy
  // ────────────────────────────────────────────────────────────────────────
  // Background SW'in fetch'i Cloudflare için 'şüpheli bot fingerprint' oluyor.
  // Çözüm: kick.com sekmesi açıksa, fetch'i o sekmenin content script'inden
  // yap. Cloudflare için 'gerçek tarayıcı sekmesi' olduğumuz için 403 baskısı
  // büyük ölçüde kırılır.
  //
  // _proxyFetch(url) → {ok, status, body} | null
  // Null dönerse: sekme yok / proxy çalışmadı → çağıran SW fetch'e düşer.

  _proxyTabId: null,           // En son başarılı proxy tab'ın ID'si (cache)
  _proxyTabIdAt: 0,            // Cache zaman damgası
  _PROXY_TAB_CACHE_MS: 90000,  // v2.3.1 fix: 30 → 90sn — tabs.query MV3'te flaky,
                                // daha az sıklıkla yeniden sorgu yap, yanlış miss'leri azalt
  _proxyStats: { hits: 0, misses: 0, fails: 0 }, // Diagnostic için

  /**
   * Açık kick.com sekmesi var mı? Cache'li.
   * v2.3.1 fix: tabs.query MV3'te ara ara boş döner (race condition / SW uyandırma).
   * Mitigations:
   *   1) Cache 90sn (eskisi 30sn) — daha az query
   *   2) Query boş dönerse: 100ms bekle, 1 retry yap
   *   3) Yine boşsa: son bilinen tab ID hala geçerli mi tabs.get() ile doğrula
   */
  async _findKickTab() {
    // Cache hit?
    if (this._proxyTabId && Date.now() - this._proxyTabIdAt < this._PROXY_TAB_CACHE_MS) {
      // Cache'deki tab hâlâ var mı doğrula
      try {
        const tab = await chrome.tabs.get(this._proxyTabId);
        if (tab && tab.url && tab.url.startsWith('https://kick.com')) {
          return this._proxyTabId;
        }
      } catch (_) { /* tab kapanmış */ }
      // Cache'i invalidate etme — son bilinen ID'yi koru, fresh query'de fallback olarak kullan
    }

    const lastKnownTabId = this._proxyTabId;

    // Yeni sorgu — gerekirse 1 retry
    let tabs = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
        if (tabs && tabs.length > 0) break;
      } catch (e) {
        console.debug('[KickAlert] Plan C tab query error:', e.message);
      }
      // İlk attempt boş döndü, 100ms bekle ve tekrar dene (flaky workaround)
      if (attempt === 0) await new Promise(r => setTimeout(r, 100));
    }

    if (tabs && tabs.length > 0) {
      // En son aktif olanı tercih et (lastAccessed varsa), yoksa ilk
      const best = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
      this._proxyTabId = best.id;
      this._proxyTabIdAt = Date.now();
      return best.id;
    }

    // Query 2 kere de boş döndü — son bilinen tab ID hala geçerli mi?
    if (lastKnownTabId) {
      try {
        const tab = await chrome.tabs.get(lastKnownTabId);
        if (tab && tab.url && tab.url.startsWith('https://kick.com')) {
          // Tab hâlâ var, query bug'ından dolayı bulamadı; cache'i tazele
          this._proxyTabId = lastKnownTabId;
          this._proxyTabIdAt = Date.now();
          return lastKnownTabId;
        }
      } catch (_) {
        // Tab gerçekten kapanmış — cache'i temizle
        this._proxyTabId = null;
      }
    }
    return null;
  },

  /** Content script üzerinden API çağrısı. Başarısızsa null döner (SW fallback). */
  async _proxyFetch(url) {
    const tabId = await this._findKickTab();
    if (!tabId) {
      this._proxyStats.misses++;
      return null;
    }
    try {
      // v2.3.1 fix: Authorization Bearer token vb. header'ları content script'e ilet.
      // Önceki sürümde header iletilmiyordu → kick.com authenticated endpoint'ler 401
      // dönüyordu (örn. /api/v2/channels/followed). Cookie tek başına yetmiyor.
      // v2.3.1 Plan D: via='proxy' → sec-fetch-site: same-origin (sayfa zaten kick.com'da)
      const proxyHeaders = await this.makeHeaders('proxy');

      // v2.3.1 Plan E fix: sendMessage'ı manuel Promise'e sar — chrome.runtime.lastError'u
      // yakalayabilelim. Bu kritik: tab var ama content script listener YOK durumunda
      // sendMessage promise undefined ile resolve oluyor (timeout atmıyor). Önceki
      // sürümde bu 'undefined response' olarak görünüyordu. Şimdi açıkça fail sayıyoruz.
      const respPromise = new Promise((resolve) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'KICK_API_PROXY_FETCH',
          url: url,
          headers: proxyHeaders,
        }, (response) => {
          if (chrome.runtime.lastError) {
            // 'Could not establish connection. Receiving end does not exist.'
            // Yani tab var ama content script listener yok (henüz inject edilmemiş
            // veya navigate etti). SW fallback'e düş.
            resolve({ __noListener: true, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      });

      // Timeout sarmalı: content script bazen yavaş cevap verir veya hiç vermez
      const PROXY_TIMEOUT_MS = 5000;
      const timeoutPromise = new Promise((_, rej) =>
        setTimeout(() => rej(new Error('proxy timeout')), PROXY_TIMEOUT_MS)
      );
      const result = await Promise.race([respPromise, timeoutPromise]);

      // v2.3.1 Plan E fix: result null/undefined olabilir, açıkça kontrol et
      if (!result || typeof result !== 'object') {
        this._proxyStats.fails++;
        return null;
      }
      if (result.__noListener) {
        // Content script listener yok — auto-inject mekanizmasına bırak
        this._proxyStats.fails++;
        const now = Date.now();
        if (!this._lastProxyFailLogAt || now - this._lastProxyFailLogAt > 60000) {
          console.debug(`[KickAlert] Plan C: content script yok (Hits: ${this._proxyStats.hits}, Fails: ${this._proxyStats.fails})`);
          this._lastProxyFailLogAt = now;
        }
        return null;
      }
      if (result.error) {
        // Content script'te runtime hatası — fallback'e düş
        console.debug('[KickAlert] Plan C proxy error:', result.error);
        this._proxyStats.fails++;
        return null;
      }
      // v2.3.1 Plan E fix: result var ama status field eksikse fail say
      if (typeof result.status !== 'number') {
        console.debug('[KickAlert] Plan C: result.status eksik —', result);
        this._proxyStats.fails++;
        return null;
      }
      this._proxyStats.hits++;
      return result; // { ok, status, body, headers }
    } catch (e) {
      // Timeout, sekme kapanmış, mesaj listener yok vb.
      this._proxyStats.fails++;
      const now = Date.now();
      if (!this._lastProxyFailLogAt || now - this._lastProxyFailLogAt > 60000) {
        console.debug(`[KickAlert] Plan C proxy fail (60sn pencere — Hits: ${this._proxyStats.hits}, Fails: ${this._proxyStats.fails}): ${e.message}`);
        this._lastProxyFailLogAt = now;
      }
      // v2.3.1 fix: Tab cache'i invalidate ETME — tek timeout = tab kapandı demek değil.
      // Tab muhtemelen hâlâ duruyor (arka plan, yavaş cevap). Bu çağrı SW'ye fallback,
      // bir sonraki çağrıda yine aynı tab'ı denemeye devam et. Eğer gerçekten ölü tab
      // varsa _findKickTab içindeki tabs.get() kontrolü onu yakalar.
      return null;
    }
  },

  /** Diagnostic için proxy istatistiği snapshot */
  getProxyStats() {
    return {
      ...this._proxyStats,
      tabCached: !!this._proxyTabId,
      cacheAgeMs: this._proxyTabId ? Date.now() - this._proxyTabIdAt : null,
    };
  },

  /** Diagnostic için proxy yapılabilir mi sorgu (hızlı) */
  async hasProxyTab() {
    return (await this._findKickTab()) !== null;
  },

  /**
   * Plan C ana giriş — _doFetch(url, headers)
   * Strateji c: Sekme varsa her zaman proxy dene; null dönerse SW fetch'e düş.
   * Response benzeri nesne döndürür: { ok, status, json(), text(), via: 'proxy'|'sw' }
   */
  async _doFetch(url) {
    // v2.3.1 Plan E: İki katmanlı fetch — proxy başarısızsa SW'ye fallback.
    // Önceki sürümde proxy 403 dönse bile responseLike döndürüyor, hiç SW denenmeden
    // backoff'a düşülüyordu. Şu mantıkta:
    //   1. Proxy varsa dene
    //   2. Proxy 200 OK → kullan
    //   3. Proxy 401/403 → SW yoluyla ikinci şans (SW farklı header context'i, kurtulabilir)
    //   4. SW de 401/403 → gerçek baskı, backoff'a düş

    // 1) Proxy yolu (varsa)
    const proxied = await this._proxyFetch(url);

    // Helper: proxy response'unu Response-benzeri nesne yap
    const wrapProxied = (p) => ({
      ok: p.ok,
      status: p.status,
      via: 'proxy',
      // v2.3.21: content.js zaten cf-ray dahil response header'larını yakalayıp
      // gönderiyordu (respHeaders), ama burada hiç açılmıyordu — sadece bunu ekledik.
      headers: { get: (name) => (p.headers && p.headers[String(name).toLowerCase()]) || null },
      async json() {
        try { return JSON.parse(p.body); }
        catch (e) { throw new Error('Invalid JSON from proxy: ' + e.message); }
      },
      async text() { return p.body; },
      headers: {
        get(name) {
          if (!p.headers) return null;
          return p.headers[name.toLowerCase()] || null;
        },
      },
    });

    // Proxy başarılı (200) — kullan
    if (proxied !== null && proxied.status >= 200 && proxied.status < 400) {
      return wrapProxied(proxied);
    }

    // Proxy 401/403 — SW ile ikinci şans (NADIR ama kurtarıcı olabilir)
    if (proxied !== null && (proxied.status === 401 || proxied.status === 403)) {
      const now = Date.now();
      if (!this._lastProxyAuthLogAt || now - this._lastProxyAuthLogAt > 60000) {
        console.debug(`[KickAlert] Plan C proxy HTTP ${proxied.status} → SW ile ikinci şans deneniyor`);
        this._lastProxyAuthLogAt = now;
      }
      try {
        const swResp = await fetch(url, {
          headers: await this.makeHeaders('sw'),
          credentials: 'include',
          redirect: 'error',
        });
        swResp.via = 'sw_rescue'; // diagnostic: proxy başarısız → SW kurtardı
        if (swResp.ok) {
          console.debug(`[KickAlert] SW rescue başarılı (proxy ${proxied.status} → SW ${swResp.status})`);
        }
        return swResp;
      } catch (e) {
        // SW de patladı — proxy response'unu döndür (en azından gerçek HTTP status alır)
        return wrapProxied(proxied);
      }
    }

    // Proxy diğer hatalar (4xx/5xx, null değil) — proxy response'unu döndür
    if (proxied !== null) {
      return wrapProxied(proxied);
    }

    // Proxy null (tab yok / listener yok / timeout) — SW fallback
    const swResp = await fetch(url, {
      headers: await this.makeHeaders('sw'),
      credentials: 'include',
      redirect: 'error',
    });
    swResp.via = 'sw';
    return swResp;
  },

  // v2.3.0: Per-slug negative cache (RAM-only, SW restart'ta sıfırlanır)
  // 403/null yanıt aldığımız slug'ları kayıt et, kısa süre tekrar deneme.
  // Bu sayede aynı slug'a saniyede birkaç kez istek bombardımanı yapılmaz.
  // Map<slug, expiresAt>
  _negativeCache: new Map(),
  _NEGATIVE_CACHE_MS: 30 * 60 * 1000, // 30 dakika sustur

  _isNegativeCached(slug) {
    const exp = this._negativeCache.get(slug);
    if (!exp) return false;
    if (Date.now() >= exp) {
      this._negativeCache.delete(slug);
      return false;
    }
    return true;
  },

  _markNegative(slug) {
    this._negativeCache.set(slug, Date.now() + this._NEGATIVE_CACHE_MS);
  },

  _clearNegative(slug) {
    this._negativeCache.delete(slug);
  },

  // v2.1.0: Backoff state SW restart'ta kayboluyordu — storage'a persist
  async _loadBackoffFromStorage() {
    if (this._backoffLoadedFromStorage) return;
    this._backoffLoadedFromStorage = true;
    try {
      const r = await chrome.storage.local.get('_apiBackoffUntil');
      const ts = r._apiBackoffUntil || 0;
      // Sadece gelecekteki bir timestamp ise yükle (eski/geçersiz değeri atla)
      if (ts > Date.now()) {
        this._lastBackoffUntil = ts;
      }
    } catch { /* sessizce devam */ }
  },

  async _saveBackoffToStorage(ts) {
    try {
      await chrome.storage.local.set({ _apiBackoffUntil: ts });
    } catch { /* sessizce devam */ }
  },

  // v2.2.1: Manuel refresh için backoff state'i sıfırla
  // Kullanıcı popup'ta refresh butonuna bastığında çağrılır.
  // VPN açıp düzelttikten sonra anında tekrar API isteği yapabilmeyi sağlar.
  // v2.3.0: Negatif cache de temizlenir (403 düşmüş slug'lar tekrar denenebilsin)
  async resetBackoff() {
    this._lastBackoffUntil = 0;
    this._negativeCache.clear();
    try {
      await chrome.storage.local.remove('_apiBackoffUntil');
    } catch { /* sessizce devam */ }
  },

  /**
   * v2.3.1: Cloudflare bot management cookie'lerini (__cf_bm, _cfuvid) yeniler.
   * 403 yakalandığında veya proaktif olarak çağrılır. kick.com ana sayfasına
   * basit bir GET atar — Cloudflare'in döndürdüğü Set-Cookie header'ları
   * cookie jar'a yazılır (credentials: include sayesinde) ve sonraki API
   * isteği taze cookie'lerle gider.
   *
   * NOT: Eğer Cloudflare JS challenge gerektirirse bu yöntem yetmez,
   * o durumda Plan B (görünmez tab) gerekir. Çoğu zaman basit cookie verir.
   */
  _lastSessionRefreshAt: 0,
  _SESSION_REFRESH_MIN_INTERVAL_MS: 60 * 1000, // 1 dk içinde 2. refresh isteği reddedilir

  async refreshKickSession(reason = 'manual') {
    // Cooldown — peş peşe refresh çağrılarını engelle
    const now = Date.now();
    if (now - this._lastSessionRefreshAt < this._SESSION_REFRESH_MIN_INTERVAL_MS) {
      console.debug(`[KickAlert] Session refresh skipped (cooldown, last ${Math.round((now - this._lastSessionRefreshAt)/1000)}s ago)`);
      return false;
    }
    this._lastSessionRefreshAt = now;

    try {
      // kick.com ana sayfasına basit GET — Cloudflare cookie'lerini yeniler
      const response = await fetch('https://kick.com/', {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        // mode kullanmıyoruz — host_permissions zaten kick.com içeriyor
        headers: {
          // Gerçek tarayıcı gibi davran (Cloudflare için)
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
        },
      });
      console.debug(`[KickAlert] Session refresh (${reason}): HTTP ${response.status}`);

      // v2.3.1 (B+C kombinasyonu): Refresh 200 sonrası backoff yönetimi:
      //   - Plan C tab varsa: backoff TAM SIFIRLA (proxy zaten Cloudflare-safe)
      //   - Plan C yok: 5sn'lik kısa cooldown (eskisi 30sn — popup gecikmesini önler)
      // Proactive (alarm tabanlı) ve manuel test refresh'leri bu yola düşer.
      if (response.ok && this._lastBackoffUntil > Date.now() + 5 * 1000) {
        const proxyAvailable = await this._findKickTab() !== null;
        if (proxyAvailable) {
          console.debug(`[KickAlert] Session refresh başarılı + Plan C aktif → backoff tam iptal`);
          this._lastBackoffUntil = 0;
          this._lastBackoffDuration = 0;
          this._saveBackoffToStorage(0);
        } else {
          const SOFT_COOLDOWN = 5 * 1000; // v2.3.1 fix: 30sn → 5sn
          console.debug(`[KickAlert] Session refresh başarılı → backoff ${SOFT_COOLDOWN/1000}sn cooldown'a indi`);
          this._lastBackoffUntil = Date.now() + SOFT_COOLDOWN;
          this._lastBackoffDuration = 0;
          this._saveBackoffToStorage(this._lastBackoffUntil);
        }
      }

      // 200 = başarılı, 403 = challenge engellendi (yine de cookie güncellenmiş olabilir)
      return response.ok;
    } catch (e) {
      console.debug(`[KickAlert] Session refresh failed (${reason}):`, e.message);
      return false;
    }
  },

  /**
   * v2.3.21: Auth Tutarlılık Teşhisi (DENEYSEL). Kick'in kendi sunucusunun
   * AYNI geçerli token'a bazen 200 bazen 401 döndüğü kanıtlandı (bkz. Patron'la
   * paylaşılan network dökümleri). Bu fonksiyon, backoff/hata yönetimini hiç
   * tetiklemeden (erken çıkış yok) N ardışık ham istek atar ve her birinin
   * durumunu + cf-ray başlığını kaydeder — amaç, hata Cloudflare'ın belirli bir
   * veri merkezine/arka uç repliksına mı bağlı, yoksa tamamen rastgele mi
   * olduğunu görmek. _doFetch() zaten Plan C + SW fallback'i kendi içinde
   * yapıyor, backoff mantığına hiç girmiyor — bu yüzden temiz bir ölçüm.
   */
  async authConsistencyProbe(n = 10, delayMs = 1500) {
    const results = [];
    for (let i = 1; i <= n; i++) {
      const start = Date.now();
      try {
        const resp = await this._doFetch(this.API_URL);
        let cfRay = null;
        try { cfRay = resp.headers?.get?.('cf-ray') || null; } catch (e) {}
        results.push({
          i,
          status: resp.status,
          ok: resp.status === 200,
          cfRay,
          via: resp.via || '?',
          ms: Date.now() - start,
        });
      } catch (e) {
        results.push({ i, status: 'ERR', ok: false, cfRay: null, via: '?', ms: Date.now() - start, err: e.message.substring(0, 60) });
      }
      if (i < n) await new Promise(r => setTimeout(r, delayMs));
    }
    return results;
  },

  async fetchKick(url) {
    // v2.1.0: SW restart sonrası backoff state'i storage'tan recover et
    await this._loadBackoffFromStorage();

    // v2.3.1: Backoff aktif ama her 2 dk'da bir session refresh ile recovery dene.
    // Eğer cookie tazelenince HTTP 200 dönerse → backoff'u kısa cooldown'a indir.
    // KRİTİK: refresh 200 dönse bile inline retry YAPMA — Cloudflare için 'recovery →
    // anında istek' davranışı bot sinyali. Bir sonraki alarm tick'inde (30-90sn)
    // doğal aralıkta denensin.
    if (Date.now() < this._lastBackoffUntil) {
      // v2.3.1 fix (Plan C bypass): Plan C tab varsa backoff'u doğrudan sıfırla,
      // recovery beklemeden fetch'e geç. Proxy zaten Cloudflare-safe — bir 403 olsa
      // bile Plan C'nin 1dk yumuşatması devreye girer. Mevcut backoff Cloudflare'in
      // birkaç dakika önceki baskısının kalıntısı; şu an Plan C aktifken anlamsız.
      const planCActive = await this._findKickTab() !== null;
      if (planCActive) {
        const remainingS = Math.ceil((this._lastBackoffUntil - Date.now()) / 1000);
        KLog.info('BKF-01', `Backoff aktif (${remainingS}sn kalan) ama Plan C tab bulundu → backoff bypass, fetch denenecek`);
        console.debug(`[KickAlert] Backoff aktif (${remainingS}s), Plan C tab var, backoff bypass, fetch'e devam`);
        this._lastBackoffUntil = 0;
        this._lastBackoffDuration = 0;
        this._saveBackoffToStorage(0);
        // Akış devam — _doFetch'e düş
      } else {
        KLog.info('BKF-02', `Backoff aktif, Plan C tab bulunamadı (_findKickTab() → null) → recovery/backoff akışına devam`);
        // Plan C yok — eski güvenli akış (recovery dene, başarısızsa hata fırlat)
        // v2.3.1 fix E: Recovery atışı için cooldown 2dk → 1dk
        const sinceLastRecovery = Date.now() - (this._lastBackoffRecoveryAt || 0);
        const RECOVERY_COOLDOWN = 60 * 1000; // 1 dk (eski 2dk)

        if (sinceLastRecovery > RECOVERY_COOLDOWN) {
          this._lastBackoffRecoveryAt = Date.now();
          console.debug('[KickAlert] Backoff aktif, early recovery deneniyor (session refresh)...');
          const refreshed = await this.refreshKickSession('backoff_recovery');
          if (refreshed) {
            // Plan C yok → 5sn'lik kısa cooldown (panic loop koruması)
            const NEXT_ATTEMPT_DELAY = 5 * 1000;
            this._lastBackoffUntil = Date.now() + NEXT_ATTEMPT_DELAY;
            this._lastBackoffDuration = 0;
            this._saveBackoffToStorage(this._lastBackoffUntil);
            console.debug(`[KickAlert] Session refresh başarılı, ${NEXT_ATTEMPT_DELAY/1000}sn cooldown — şimdiki çağrı ATLANDI`);
            throw new Error(`API recovery cooldown — retry after ${NEXT_ATTEMPT_DELAY/1000}s`);
          } else {
            throw new Error(`API backoff — retry after ${Math.ceil((this._lastBackoffUntil - Date.now()) / 1000)}s`);
          }
        } else {
          throw new Error(`API backoff — retry after ${Math.ceil((this._lastBackoffUntil - Date.now()) / 1000)}s`);
        }
      }
    }

    // v2.1.0: Erken offline kontrolü — gereksiz retry'lardan kaçın
    // navigator.onLine bazı Firefox SW context'lerinde undefined olabilir,
    // o yüzden sadece kesin false ise kısa devre yapıyoruz (false-negative kabul).
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('OFFLINE: navigator reports offline');
    }

    let lastError;
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt++) {
      try {
        // Plan C entegre: önce proxy (varsa), sonra SW fallback
        const response = await this._doFetch(url);

        if (response.status === 429) {
          // Rate limited — enter backoff
          const retryAfter = parseInt(response.headers.get('Retry-After') || '30', 10);
          this._lastBackoffUntil = Date.now() + (retryAfter * 1000);
          // v2.1.0: persist (SW restart'ta korunsun)
          this._saveBackoffToStorage(this._lastBackoffUntil);
          console.warn(`[KickAlert] Rate limited (429) — backing off ${retryAfter}s`);
          throw new Error(`Rate limited: retry after ${retryAfter}s`);
        }

        // v2.1.0: 401/403 = auth/session issue
        // v2.3.1 (Plan B/M1): ANINDA inline recovery refresh KALDIRILDI.
        // Konsol verisi (8/8 fail) gösterdi ki "403 alır almaz refresh" Cloudflare için
        // bot/panic signal — refresh de 403 yiyor, durum kötüleşiyor.
        // Recovery sorumluluğu artık iki MEVCUT mekanizmaya devredildi:
        //   1) `proactive_25min` — 25 dk'da bir cookie tazeleme (alarm tabanlı)
        //   2) `backoff_recovery` — backoff aktifken 2 dk cooldown'lu refresh denemesi
        //      (fetchKick'in girişindeki kontrol bloğu — bkz. yukarısı)
        // 403 gelince DOĞRUDAN adaptif backoff'a düşüyoruz, panic loop'u kırıyoruz.
        if (response.status === 401 || response.status === 403) {
          // M4: Failure'ı kayıt et (dinamik yavaşlatma için son 10 dk penceresi)
          this._recordFailure();

          const now = Date.now();
          // v2.3.1 Plan E: via bilgisi de log'a girsin — Cloudflare baskısının
          // hangi katmandan geldiğini görmek için kritik (proxy vs SW).
          const via = response.via || '?';

          // v2.3.11: Kick'in GERÇEKTEN ne söylediğini oku. Şu ana kadar sadece
          // HTTP status kodunu yakalayıp atıyorduk — response body'de muhtemelen
          // Kick'in kendi hata mesajı var (örn. "Unauthenticated", token formatı
          // hatası, Cloudflare challenge sayfası HTML'i vb.). Bunu görmeden
          // "neden 401 alıyoruz" sorusuna kör tahminle cevap veriyorduk.
          let bodySnippet = '';
          try {
            const bodyText = await response.text();
            bodySnippet = bodyText.slice(0, 300);
          } catch (bodyErr) {
            bodySnippet = `[body okunamadı: ${bodyErr.message}]`;
          }
          KLog.warn('AUTH-01', `API ${response.status} (via:${via}) — Kick body: ${bodySnippet}`);

          // v2.3.13: 401 aldığımızda, o an elimizde GERÇEKTEN geçerli bir
          // session_token var mıydı diye kontrol ediyoruz. Aylarca süren
          // araştırma sonunda kanıtladık: bazen token var, geçerli, kick.com'un
          // kendi sitesi aynı token'la 200 alıyor, ama biz yine de 401 alıyoruz —
          // bu durumda kullanıcıya "giriş yap" demek YANLIŞ ve yanıltıcı, çünkü
          // zaten giriş yapmış. Bu iki durumu ayırt ediyoruz.
          const hadToken = !!(await this.getSessionToken());
          const tokenFlag = hadToken ? 'token:yes' : 'token:no';

          if (now - (this._lastAuthWarnAt || 0) > 5 * 60 * 1000) {
            console.warn(`[KickAlert] API ${response.status} (via:${via}) — adaptif backoff'a geçiliyor. Body: ${bodySnippet}`);
            this._lastAuthWarnAt = now;
          } else {
            console.debug(`[KickAlert] API ${response.status} (via:${via}) — auth required, backoff aktive. Body: ${bodySnippet}`);
          }

          // v2.3.1 fix: Plan C tab varsa 403 backoff'unu yumuşat.
          // Proxy üzerinden bir sonraki istek muhtemelen başarılı olacak,
          // 5-20dk beklemeye gerek yok. 1dk bekleyip tekrar denesin.
          // Plan C yoksa eski mantık (5→10→20→30dk adaptif zincir) korunur.
          const planCActive = (typeof this._findKickTab === 'function')
            ? await this._findKickTab() !== null
            : false;

          let backoffMs;
          if (planCActive) {
            backoffMs = 60 * 1000; // 1 dk — Plan C ile hızlı kurtarma yeterli
            console.debug(`[KickAlert] Plan C aktif — backoff 1dk'ya yumuşatıldı (response: ${response.status})`);
          } else {
            // v2.3.0: 403 yağmurunu önle — global ADAPTİF backoff (5→10→20→30 dk).
            const lastBackoffEnded = this._lastBackoffEndTime || 0;
            const sinceLastBackoff = Date.now() - lastBackoffEnded;
            backoffMs = 5 * 60 * 1000; // default 5 dk
            if (sinceLastBackoff < 5 * 60 * 1000 && lastBackoffEnded > 0) {
              const lastDuration = this._lastBackoffDuration || (5 * 60 * 1000);
              backoffMs = Math.min(lastDuration * 2, 30 * 60 * 1000);
              console.warn(`[KickAlert] Adaptive backoff: ${Math.round(backoffMs/60000)} dk (art arda 403)`);
            }
          }

          this._lastBackoffUntil = Date.now() + backoffMs;
          this._lastBackoffDuration = backoffMs;
          this._lastBackoffEndTime = this._lastBackoffUntil;
          this._saveBackoffToStorage(this._lastBackoffUntil);
          throw new Error(`AUTH_REQUIRED: API ${response.status} (${tokenFlag})`);
        }

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        // Success — reset backoff
        if (this._lastBackoffUntil !== 0) {
          this._lastBackoffUntil = 0;
          this._lastBackoffDuration = 0; // adaptif sıfırla — başarılı session yeni başlangıç
          // v2.1.0: storage'tan da temizle
          this._saveBackoffToStorage(0);
        }
        // v2.1.0: auth recover — bir sonraki 401/403'te tekrar warn versin
        this._lastAuthWarnAt = 0;
        // M4: Başarıyı pencereye kaydet (diagnostic panel + dinamik yavaşlatma için)
        this._recordSuccess();
        return response;
      } catch (e) {
        lastError = e;
        // v2.1.0: AUTH_REQUIRED için retry deneme, hemen fırlat
        if (e.message && e.message.startsWith('AUTH_REQUIRED:')) {
          throw e;
        }
        if (attempt < this._retryDelays.length) {
          const delay = this._retryDelays[attempt];
          // v2.1.0: console.warn → console.debug (daha az gürültü)
          console.debug(`[KickAlert] API attempt ${attempt + 1} failed: ${e.message} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    // v2.1.0: console.error → console.warn (eklenti çalışmaya devam ediyor, "critical" değil)
    console.warn(`[KickAlert] API failed after ${this._retryDelays.length + 1} attempts: ${lastError.message}`);
    throw lastError;
  },

  // v2.3.0: getAllFollowingChannels resilience cache
  // Followed listesini her check'te API'den fresh alıyoruz (viewer count tazeliği için).
  // Ama 403 yağmuru anında eski veri ile çalışmaya devam etmek için son başarılı response'u
  // saklıyoruz. Bu cache "bozuk gün sigortası" — normal akışta devreye girmez,
  // sadece API erişilemezken eklentinin tamamen ölmesini engeller.
  _followedFallback: null, // { channels: [...], cachedAt: timestamp }

  // v2.3.1 Risk#2 fix: Son getAllFollowingChannels çağrısı fallback cache mi
  // kullandı (403/network hatası) yoksa taze veri mi döndürdü? checkChannels
  // bunu okuyarak "API'ye mi Pusher'a mı güveneyim" kararını verir.
  // false = taze veri (API offline dediğine güvenilir)
  // true  = eski fallback (Pusher'ın canlı dediği daha güncel olabilir)
  _lastFetchWasStale: false,

  /**
   * Get ALL following channels (live + offline, paginated)
   * v2.3.0: Her zaman fresh API çağrısı. 403/network hatası olursa son başarılı
   * response'u (fallback cache) döndürür. forceFresh parametresi tutarlılık için
   * kabul ediliyor (cache ile çalışan kod yolu için).
   */
  async getAllFollowingChannels(forceFresh = false) {
    try {
      const all = [];
      let cursor = null;
      let page = 0;

      do {
        const url = new URL(this.API_URL);
        if (cursor) url.searchParams.append('cursor', cursor.toString());

        const response = await this.fetchKick(url.toString());
        const data = await response.json();
        const items = data?.channels || [];

        all.push(...items.map(ch => this.toDomainChannel(ch)));
        cursor = data.nextCursor;
        page++;
      } while (cursor && page < 20);

      // Başarılı — taze veri, fallback cache'i güncelle
      this._followedFallback = { channels: all, cachedAt: Date.now() };
      this._lastFetchWasStale = false; // Risk#2: taze veri
      // v2.3.23: Başarılı çekim → önceki "session reddedildi" uyarısı varsa temizle
      try { await chrome.storage.local.set({ _authSessionRejected: false }); } catch (e) {}
      return all;
    } catch (e) {
      // v2.3.23: token VARDI ama Kick yine de reddettiyse (fetchErrorSessionRejected
      // durumu) — popup'ın Ayarlar ikonunu yeniden vurgulaması için işaretle.
      // token:no (gerçekten giriş yok) durumunda işaretlemiyoruz, çünkü o zaten
      // farklı, klasik bir "giriş yap" mesajı gösteriyor, email/şifre önerisiyle
      // alakası yok.
      try {
        const isSessionRejected = e.message && e.message.startsWith('AUTH_REQUIRED:') && /token:yes/i.test(e.message);
        await chrome.storage.local.set({ _authSessionRejected: isSessionRejected });
      } catch (e2) {}

      // 403 / network hatası — son başarılı response varsa kullan
      if (this._followedFallback) {
        const ageMin = Math.round((Date.now() - this._followedFallback.cachedAt) / 60000);
        console.debug(`[KickAlert] getAllFollowing fetch failed, using fallback cache (${ageMin} dk eski): ${e.message}`);
        this._lastFetchWasStale = true; // Risk#2: eski fallback veri
        return this._followedFallback.channels;
      }
      // Hiç fallback yok — hatayı yukarı fırlat
      this._lastFetchWasStale = true;
      throw e;
    }
  },

  /**
   * Get start time for a specific channel (fallback when followed API doesn't include it)
   * v2.3.0: Per-slug negative cache — 403 spamını önler.
   */
  async getChannelStartTime(slug) {
    // Negatif cache: bu slug için yakın zamanda başarısız olduysak hiç deneme
    if (this._isNegativeCached(slug)) return null;

    try {
      const response = await this.fetchKick(`https://kick.com/api/v2/channels/${slug}`);
      const data = await response.json();
      const raw = data?.livestream?.created_at ?? null;
      if (!raw) {
        // API geri geldi ama yayın bilgisi yok — kısa süre tekrar deneme
        this._markNegative(slug);
        return null;
      }
      // Başarılı sonuç — negatif cache'i temizle (eski hata silinsin)
      this._clearNegative(slug);
      return raw.endsWith('Z') || raw.includes('+') ? raw : raw + 'Z';
    } catch (e) {
      // 403, 401, network hatası vs. → negatif cache (30 dk sustur)
      this._markNegative(slug);
      return null;
    }
  },

  /**
   * v2.3.0: Get chatroom ID for a channel (cache-first).
   * Used by bot tracker to subscribe to Pusher WebSocket chatroom channels.
   *
   * v2.3.1 Plan F: Aynı response'tan channel_id'yi de cache'liyoruz —
   * Pusher 'channel.{channel_id}' subscribe için gerekli, ayrı çağrı yapma.
   *
   * @param {string} slug - channel slug
   * @returns {Promise<number|null>} chatroom ID or null on failure
   */
  async getChatroomId(slug) {
    // Pozitif cache (Storage) — chatroom_id kanalın ömrü boyunca sabittir
    const cached = await Storage.getChatroomId(slug);
    if (cached) return cached;

    // Negatif cache: yakın zamanda 403 aldığımız slug'a tekrar baskı yapma
    if (this._isNegativeCached(slug)) return null;

    try {
      const response = await this.fetchKick(`https://kick.com/api/v2/channels/${slug}`);
      const data = await response.json();
      const chatroomId = data?.chatroom?.id ?? null;
      const channelId = data?.id ?? null; // Plan F: channel.id (top-level field)
      if (!chatroomId) {
        this._markNegative(slug);
        return null;
      }
      // Başarılı — Storage'a kalıcı yaz, negatif cache'i temizle
      await Storage.setChatroomId(slug, chatroomId);
      if (channelId) await Storage.setChannelId(slug, channelId);
      this._clearNegative(slug);
      return chatroomId;
    } catch (e) {
      // 403/401/network → negatif cache (30 dk sustur)
      this._markNegative(slug);
      return null;
    }
  },

  /**
   * Get extra details for a live channel (thumbnail, startTime) in one call
   */
  async getChannelLiveDetails(slug) {
    try {
      // v2.3.29 DÜZELTME: Yanlış endpoint kullanıyorduk. /api/v2/channels/{slug}
      // (genel kanal bilgisi) thumbnail/source alanlarını artık boş döndürüyor.
      // Kick Signal'ın kod tabanında görüldüğü gibi, doğru/özel endpoint
      // /api/v2/channels/{slug}/livestream — yanıt yapısı da farklı: veri
      // data.livestream altında DEĞİL, doğrudan data altında.
      const response = await this.fetchKick(`https://kick.com/api/v2/channels/${slug}/livestream`);
      const data = await response.json();
      const ls = data?.data;
      if (!ls) {
        KLog.warn('THM-01', `${slug}: response geldi ama 'data' alanı yok/boş (canlı değil mi, API şekli mi değişti?)`);
        return null;
      }

      let thumbnailUrl = '';

      // stream.kick.com → images.kick.com dönüşüm fonksiyonu
      const convertStreamUrl = (url) => {
        if (!url || !url.includes('stream.kick.com')) return url || '';
        const m = url.match(/stream\.kick\.com\/thumbnails\/livestream\/(\d+)\/(thumb\d+)\//);
        if (m) return `https://images.kick.com/video_thumbnails/${m[1]}/${m[2]}/720.webp`;
        // Fallback: sadece stream ID ile dene
        const m2 = url.match(/livestream\/(\d+)\//);
        if (m2) return `https://images.kick.com/video_thumbnails/${m2[1]}/thumb0/720.webp`;
        return '';
      };

      // Strategy 1: thumbnail objesi — stream.kick.com URL'lerini dönüştür
      const thumb = ls.thumbnail;
      if (thumb) {
        if (typeof thumb === 'string') {
          thumbnailUrl = convertStreamUrl(thumb);
        } else {
          if (thumb.srcset) thumbnailUrl = convertStreamUrl(thumb.srcset.split(' ')[0]);
          else if (thumb.responsive) thumbnailUrl = convertStreamUrl(thumb.responsive.split(' ')[0]);
          if (!thumbnailUrl && thumb.src)  thumbnailUrl = convertStreamUrl(thumb.src);
          if (!thumbnailUrl && thumb.url)  thumbnailUrl = convertStreamUrl(thumb.url);
        }
      }

      // Strategy 2: IVS source URL'den oluştur
      if (!thumbnailUrl && ls.source) {
        const m = ls.source.match(/\/([A-Za-z0-9]{6,})\/\d{4}\/\d+\/\d+\/\d+\/\d+\/([A-Za-z0-9]+)\/media/);
        if (m) thumbnailUrl = `https://images.kick.com/video_thumbnails/${m[1]}/${m[2]}/720.webp`;
      }

      if (!thumbnailUrl) {
        KLog.warn('THM-02', `${slug}: livestream verisi var ama hiçbir stratejiyle thumbnail çıkarılamadı — thumbnail:${JSON.stringify(ls.thumbnail).slice(0,100)} source:${(ls.source||'').slice(0,60)}`);
      } else {
        KLog.debug('THM-03', `${slug}: thumbnail başarıyla alındı`);
      }

      return {
        startTime: (() => {
          const t = ls.created_at || ls.start_time || null;
          if (!t) return null;
          return t.endsWith('Z') || t.includes('+') ? t : t + 'Z';
        })(),
        thumbnailUrl,
      };
    } catch (e) {
      KLog.warn('THM-04', `${slug}: getChannelLiveDetails hatası — ${e.message}`);
      return null;
    }
  },

  /**
   * Map API response to our domain model
   */
  toDomainChannel(ch) {
    // startedAt UTC normalize — Kick API Z suffix olmadan UTC döndürebilir
    let rawStart = ch.start_time || ch.started_at || ch.livestream?.start_time || null;
    if (rawStart && typeof rawStart === 'string' && !rawStart.endsWith('Z') && !rawStart.includes('+')) {
      rawStart = rawStart + 'Z';
    }
    return {
      isLive: ch.is_live || false,
      profilePic: ch.profile_picture || '',
      channelSlug: ch.channel_slug || ch.slug || '',
      userUsername: ch.user_username || ch.channel_slug || ch.slug || '',
      sessionTitle: ch.session_title || '',
      categoryName: ch.categories?.[0]?.name || ch.category_name || '',
      viewerCount: ch.viewer_count || 0,
      startedAt: rawStart,
      thumbnailUrl: (typeof ch.thumbnail === 'object' ? (ch.thumbnail?.url || ch.thumbnail?.src) : ch.thumbnail) || '',
    };
  },
};
