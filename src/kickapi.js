/**
 * KickAlert - Kick API Module
 * Handles all communication with Kick.com API.
 * © 2025 Segelferd. All rights reserved.
 */

const KickAPI = {
  API_URL: 'https://kick.com/api/v2/channels/followed',

  /**
   * Get session token from kick.com cookies for Bearer auth.
   * Service workers cannot use credentials:'include', so we
   * read the session_token cookie and send it as a Bearer header.
   */
  async getSessionToken() {
    try {
      const cookies = await chrome.cookies.getAll({ domain: 'kick.com', name: 'session_token' });
      if (cookies.length === 0) return null;
      return decodeURIComponent(cookies[0].value);
    } catch { return null; }
  },

  async makeHeaders() {
    const token = await this.getSessionToken();
    if (!token) return {};
    return { 'Authorization': 'Bearer ' + token };
  },

  // Retry config
  _retryDelays: [1000, 2000, 4000, 8000], // exponential backoff
  _lastBackoffUntil: 0, // timestamp — skip API calls until this time

  async fetchKick(url) {
    // If in backoff period, throw immediately
    if (Date.now() < this._lastBackoffUntil) {
      throw new Error(`API backoff — retry after ${Math.ceil((this._lastBackoffUntil - Date.now()) / 1000)}s`);
    }

    let lastError;
    for (let attempt = 0; attempt <= this._retryDelays.length; attempt++) {
      try {
        const response = await fetch(url, {
          headers: await this.makeHeaders(),
          redirect: 'error',
        });

        if (response.status === 429) {
          // Rate limited — enter backoff
          const retryAfter = parseInt(response.headers.get('Retry-After') || '30', 10);
          this._lastBackoffUntil = Date.now() + (retryAfter * 1000);
          console.warn(`[KickAlert] Rate limited (429) — backing off ${retryAfter}s`);
          throw new Error(`Rate limited: retry after ${retryAfter}s`);
        }

        if (!response.ok) throw new Error(`API error: ${response.status}`);

        // Success — reset backoff
        this._lastBackoffUntil = 0;
        return response;
      } catch (e) {
        lastError = e;
        if (attempt < this._retryDelays.length) {
          const delay = this._retryDelays[attempt];
          console.warn(`[KickAlert] API attempt ${attempt + 1} failed: ${e.message} — retrying in ${delay}ms`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    console.error(`[KickAlert] API failed after ${this._retryDelays.length + 1} attempts: ${lastError.message}`);
    throw lastError;
  },

  /**
   * Get ALL following channels (live + offline, paginated)
   */
  async getAllFollowingChannels() {
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

    return all;
  },

  /**
   * Get start time for a specific channel (fallback when followed API doesn't include it)
   */
  async getChannelStartTime(slug) {
    try {
      const response = await this.fetchKick(`https://kick.com/api/v2/channels/${slug}`);
      const data = await response.json();
      return data?.livestream?.created_at ?? null;
    } catch { return null; }
  },

  /**
   * Get extra details for a live channel (thumbnail, startTime) in one call
   */
  async getChannelLiveDetails(slug) {
    try {
      const response = await this.fetchKick(`https://kick.com/api/v2/channels/${slug}`);
      const data = await response.json();
      const ls = data?.livestream;
      if (!ls) return null;

      let thumbnailUrl = '';

      // Strategy 1: Try thumbnail object from API (images.kick.com URLs work)
      const thumb = ls.thumbnail;
      if (thumb) {
        if (typeof thumb === 'string') {
          if (!thumb.includes('stream.kick.com')) thumbnailUrl = thumb;
        } else {
          // Try srcset first — it uses images.kick.com which is accessible
          if (thumb.srcset) thumbnailUrl = thumb.srcset.split(' ')[0];
          else if (thumb.responsive) thumbnailUrl = thumb.responsive.split(' ')[0];
          // url/src fields use stream.kick.com which is blocked — skip
          if (!thumbnailUrl && thumb.src && !thumb.src.includes('stream.kick.com')) thumbnailUrl = thumb.src;
          if (!thumbnailUrl && thumb.url && !thumb.url.includes('stream.kick.com')) thumbnailUrl = thumb.url;
        }
      }

      // Strategy 2: Construct from IVS source URL
      if (!thumbnailUrl && ls.source) {
        const m = ls.source.match(/\/([A-Za-z0-9]{6,})\/\d{4}\/\d+\/\d+\/\d+\/\d+\/([A-Za-z0-9]+)\/media/);
        if (m) thumbnailUrl = `https://images.kick.com/video_thumbnails/${m[1]}/${m[2]}/720.webp`;
      }

      return {
        startTime: ls.created_at || ls.start_time || null,
        thumbnailUrl,
      };
    } catch (e) {
      console.warn('[KickAlert] getChannelLiveDetails error:', e.message);
      return null;
    }
  },

  /**
   * Map API response to our domain model
   */
  toDomainChannel(ch) {
    return {
      isLive: ch.is_live || false,
      profilePic: ch.profile_picture || '',
      channelSlug: ch.channel_slug || ch.slug || '',
      userUsername: ch.user_username || ch.channel_slug || ch.slug || '',
      sessionTitle: ch.session_title || '',
      categoryName: ch.categories?.[0]?.name || ch.category_name || '',
      viewerCount: ch.viewer_count || 0,
      startedAt: ch.start_time || ch.started_at || ch.livestream?.start_time || null,
      thumbnailUrl: (typeof ch.thumbnail === 'object' ? (ch.thumbnail?.url || ch.thumbnail?.src) : ch.thumbnail) || '',
    };
  },
};
