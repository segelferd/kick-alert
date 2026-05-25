# KickAlert — Privacy Policy

**Last updated:** May 2026

## Overview

KickAlert is a browser extension that notifies you in real time when your followed Kick.com streamers go live, offers optional chat filtering, and provides viewer analytics. Your privacy matters — this extension works entirely within your browser with no external data collection.

## Data Collection

**KickAlert does NOT collect, transmit, or store any personal data externally.**

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

### What is synced (when Cloud Sync is enabled)

All settings listed above **except**: custom sound files, notification history, viewer history data, and internal runtime state. Sync uses Chrome's built-in infrastructure tied to your Google account.

### What is NOT stored

- Your Kick.com credentials or account information
- Your browsing history
- Any personally identifiable information
- Any data on external servers

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

No analytics, tracking, advertising, or telemetry services are used. KickAlert connects to Pusher because that is the real-time infrastructure Kick itself uses; no data about you is sent to it — the extension only listens for public "channel is live" events.

## Chat Integration (Optional)

When you enable the optional Chat tab, KickAlert reads chat messages on the Kick.com page you are viewing **locally in your browser** to apply your chosen filters (hiding bots, spam, blocked words/users, etc.) and to highlight keywords, favorite users, mentions of you, and broadcaster messages. Chat content is processed entirely on your device in real time and is **never stored, logged, or transmitted anywhere**. The only persisted chat-related settings are your own filter preferences, blocklists, keywords, and favorite-user list.

## Viewer Anomaly Detection

The anomaly detection feature stores viewer count history locally for each live channel you follow. This data is used exclusively to detect unusual spikes or drops in viewer numbers and generate local alerts. It is never transmitted externally and is cleared when a stream ends.

## Data Deletion

Uninstalling the extension removes all locally stored data. You can also clear notification history from the Options panel. Viewer history data resets automatically when streams end.

## Open Source

KickAlert is fully open source under the MIT License. Review the complete source code at [github.com/segelferd/kick-alert](https://github.com/segelferd/kick-alert).

## Contact

For questions or concerns, open an issue on [GitHub](https://github.com/segelferd/kick-alert/issues).

## Support

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`
