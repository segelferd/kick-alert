# KickAlert — Privacy Policy

**Last updated:** October 2026

## Overview

KickAlert is a browser extension that notifies you in real time when your followed Kick.com streamers go live, offers optional chat filtering, and provides viewer analytics. Your privacy matters — this extension works entirely within your browser. The only data that can ever leave your device is the optional, off-by-default ad diagnostics summary described below, and only if you turn it on.

## Data Collection

**KickAlert does NOT collect, transmit, or store any personal data externally.** The single exception to transmission is the optional technical ad diagnostics summary (see *Optional Ad Diagnostics*), which contains no personal data and is sent only if you enable it.

All data is stored locally in your browser using `chrome.storage.local` and is never sent to any external server. When Cloud Sync is enabled, settings are synced via `chrome.storage.sync` through your Google account — Segelferd never sees this data.

### What is stored locally

- Notification preferences (sound volume, check interval, sound mode, toggle states)
- Per-channel sound preferences (main / sub / silent / muted bell state)
- Favorite channels and channel group assignments
- Auto-launch channel selections
- Notification history (streamer name, title, category, timestamp — last 100 entries)
- Custom notification sound files (if uploaded, max 2 MB each)
- Do Not Disturb schedule and preferences
- Theme preference (dark / light)
- Multi-stream session data (cleared when tab is closed)
- Selected UI language preference
- Viewer history data (viewer counts per live channel, used for anomaly detection — local only)
- Anomaly detection settings (sensitivity level, spike/drop thresholds, enabled state)
- Default channel alert mode (used by channels without their own bell setting)
- Ad diagnostics log, when ad blocking is on (stream marker names, counts, times, average ad break length and cleaned playlist tag lines — no channel names, addresses or tokens; last 100 entries)

### What is synced (when Cloud Sync is enabled)

All settings listed above **except**: custom sound files, notification history, viewer history data, the ad diagnostics log and its sharing consent, and internal runtime state. Sync uses Chrome's built-in infrastructure tied to your Google account.

### What is NOT stored

- Your Kick.com credentials or account information
- Your browsing history
- Any personally identifiable information
- Any data on external servers (except the optional ad diagnostics summary, if you enable it)

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save preferences, favorites, groups, sound settings, history, viewer history, cloud sync |
| `notifications` | Show desktop notifications when a streamer goes live |
| `tabs` | Open stream tabs, detect duplicates, manage multi-stream viewer |
| `cookies` | Read Kick.com session cookie to access followed channels API (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in background (Chrome only) |
| `alarms` | Reliably schedule periodic channel checks every 30–300 seconds |
| `declarativeNetRequestWithHostAccess` | Set Referer header for Kick.com API requests |
| `scripting` | Inject the content script into open kick.com tabs as a reliability fallback (reads only public channel status) |
| `host: kick.com` | Fetch followed channels and live status; read session cookie for auth |
| `host: ws-us2.pusher.com` | Connect to Kick's real-time WebSocket service for instant live-stream events |

## Third-Party Services

KickAlert communicates only with:

- **kick.com** — To fetch followed channels and their live status via the official API
- **ws-us2.pusher.com** — Kick's own real-time WebSocket service, used to receive instant live-stream events for channels you follow (only public stream-start events are read)
- **player.kick.com** — To embed live streams in the multi-stream viewer (via iframe)
- **script.google.com** — Only if you turn on *Share ad diagnostics*: receives the technical ad diagnostics summary (no personal data)

No analytics, tracking or advertising services are used. If, and only if, you enable *Share ad diagnostics*, the technical summary described below is sent to the developer's Google Apps Script endpoint (script.google.com). KickAlert connects to Pusher because that is the real-time infrastructure Kick itself uses; no data about you is sent to it — the extension only listens for public "channel is live" events.

## Chat Integration (Optional)

When you enable the optional Chat tab, KickAlert reads chat messages on the Kick.com page you are viewing **locally in your browser** to apply your chosen filters (hiding bots, spam, blocked words/users, etc.) and to highlight keywords, favorite users, mentions of you, and broadcaster messages. Chat content is processed entirely on your device in real time and is **never stored, logged, or transmitted anywhere**. The only persisted chat-related settings are your own filter preferences, blocklists, keywords, and favorite-user list.

## Viewer Anomaly Detection

The anomaly detection feature stores viewer count history locally for each live channel you follow. This data is used exclusively to detect unusual spikes or drops in viewer numbers and generate local alerts. It is never transmitted externally and is cleared when a stream ends.

## Optional Ad Diagnostics

Ad blocking is an optional, off-by-default feature that works locally on kick.com pages. While it is on, KickAlert keeps a small **local** log of ad breaks it blocked and of stream markers it does not recognize, so blocking can be adjusted when Kick changes how ads are delivered.

**Sharing is off by default.** Only if you turn on *Options → Ad Blocking → Share ad diagnostics* (Firefox additionally asks for the "technical and interaction data" permission) does KickAlert send this summary to the developer, about 5 minutes after a new entry and otherwise every 12 hours:

- Marker name (for example `live-video-net-stitched-ad-break-start`), how many times it was seen, first/last time, average ad break length
- Cleaned playlist tag lines around the marker: only tag and attribute names are kept; attribute values are kept only for a short safe list (class, duration, dates, stream source) and everything else, including all web addresses, is replaced
- Extension version, browser type (Chrome or Firefox) and interface language

**Never sent:** channel or streamer names, what you watch, video or playback addresses, tokens, your Kick account, cookies, IP-derived identifiers or any device ID. The data is stored in a private Google Sheet owned by the developer and used only to fix and improve ad blocking; it is not sold or shared. Entries older than 90 days are deleted from that sheet. You can turn sharing off at any time; the local log keeps at most 100 entries, stays on your device and is removed when you uninstall the extension.

## Data Deletion

Uninstalling the extension removes all locally stored data, including the ad diagnostics log. You can also clear notification history from the Options panel. Viewer history data resets automatically when streams end.

## Open Source

KickAlert's complete source code is publicly available for review under the PolyForm Noncommercial License 1.0.0 at [github.com/segelferd/kick-alert](https://github.com/segelferd/kick-alert).

## Contact

For questions or concerns, open an issue on [GitHub](https://github.com/segelferd/kick-alert/issues).

## Support

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`
