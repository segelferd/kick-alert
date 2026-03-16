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

  async fetchKick(url) {
    const response = await fetch(url, {
      headers: await this.makeHeaders(),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response;
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
      thumbnailUrl: ch.thumbnail || '',
    };
  },
};
