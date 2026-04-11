# KickAlert — Privacy Policy

**Last updated:** April 2026

## Overview

KickAlert is a browser extension that notifies you when your followed Kick.com streamers go live and provides viewer analytics. Your privacy matters — this extension works entirely within your browser with no external data collection.

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

## Third-Party Services

KickAlert communicates only with:

- **kick.com** — To fetch followed channels and their live status via the official API
- **player.kick.com** — To embed live streams in the multi-stream viewer (via iframe)

No analytics, tracking, advertising, or telemetry services are used.

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
