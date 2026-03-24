# KickAlert — Privacy Policy

**Last updated:** March 2026

## Overview

KickAlert is a browser extension that notifies you when your followed Kick.com streamers go live. Your privacy matters — this extension works entirely within your browser with no external data collection.

## Data Collection

**KickAlert does NOT collect, transmit, or store any personal data externally.**

All data is stored locally in your browser using Chrome's `chrome.storage.local` API and is never sent to any external server. When Cloud Sync is enabled, settings are synced via `chrome.storage.sync` through your Google account — Anthropic/Segelferd never sees this data.

### What is stored locally:

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

### What is synced (when Cloud Sync is enabled):

- All settings listed above EXCEPT: custom sound files, notification history, and internal runtime state
- Sync uses Chrome's built-in sync infrastructure tied to your Google account

### What is NOT stored:

- Your Kick.com credentials or account information
- Your browsing history
- Any personally identifiable information

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save preferences, favorites, groups, sound settings, history, and cloud sync |
| `notifications` | Show desktop notifications when a streamer goes live |
| `tabs` | Open stream tabs, detect duplicates, manage multi-stream viewer |
| `cookies` | Read Kick.com session cookie to access followed channels API (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in background (Chrome only) |
| `alarms` | Reliably schedule periodic channel checks |
| `declarativeNetRequestWithHostAccess` | Set Referer header for Kick.com API requests |

## Third-Party Services

KickAlert communicates only with:

- **kick.com** — To fetch followed channels and their live status
- **player.kick.com** — To embed live streams in multi-stream viewer (via iframe)

No analytics, tracking, or advertising services are used.

## Data Deletion

Uninstalling the extension removes all locally stored data. You can also clear notification history, reset favorites, and remove channel groups from the Options panel.

## Open Source

KickAlert is fully open source under the MIT License. Review the complete source code at [github.com/segelferd/kick-alert](https://github.com/segelferd/kick-alert).

## Contact

For questions or concerns, open an issue on [GitHub](https://github.com/segelferd/kick-alert/issues).
