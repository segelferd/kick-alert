# KickAlert — Privacy Policy

**Last updated:** March 2026

## Overview

KickAlert is a browser extension that notifies you when your followed Kick.com streamers go live. Your privacy matters — this extension is designed to work entirely within your browser with no external data collection.

## Data Collection

**KickAlert does NOT collect, transmit, or store any personal data externally.**

All data is stored locally in your browser using Chrome's `chrome.storage.local` API and is never sent to any external server.

### What is stored locally:

- Your notification preferences (sound volume, check interval, sound mode, toggle states)
- Per-channel sound preferences (main / sub / silent / muted bell state)
- Auto-launch channel selections
- Notification history (streamer name, title, category, timestamp — last 100 entries)
- Custom notification sound files (if uploaded, max 2 MB each)
- Do Not Disturb schedule and preferences
- Multi-stream session data (active channels and layout — cleared when tab is closed)
- Internal state for reliable operation (live channel tracking, notification click URLs)
- Selected UI language preference

### What is NOT stored:

- Your Kick.com credentials or account information
- Your browsing history
- Any personally identifiable information

## Permissions Explained

| Permission | Why it's needed |
|---|---|
| `storage` | Save your preferences, per-channel sound settings, notification history, and DND schedule locally |
| `notifications` | Show desktop notifications when a streamer goes live |
| `tabs` | Open stream tabs automatically, detect duplicate tabs, and manage multi-stream viewer |
| `cookies` | Read your Kick.com session cookie to access the followed channels API (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in the background when the popup is closed |
| `alarms` | Reliably schedule periodic channel checks — required because Manifest V3 service workers sleep after ~30 seconds of inactivity |
| `declarativeNetRequestWithHostAccess` | Set the `Referer` header for Kick.com API requests to function correctly |

### Host Permissions

| Host | Why it's needed |
|---|---|
| `https://kick.com/*` | Fetch your followed channels list and their live status via the Kick API |

## Third-Party Services

KickAlert communicates only with:

- **kick.com** — To fetch your followed channels and their live status via the Kick API
- **player.kick.com** — To embed live streams in the multi-stream viewer (via iframe)

No analytics, tracking, or advertising services are used.

## Data Deletion

Uninstalling the extension removes all locally stored data. You can also:

- Clear notification history via the "Clear" button in the Notification History tab
- Reset per-channel sound preferences by cycling the bell icon back to default (grey/silent)
- Clear all extension data via `chrome://settings/content/all`

## Open Source

KickAlert is fully open source under the MIT License. You can review the complete source code at [github.com/segelferd/kick-alert](https://github.com/segelferd/kick-alert).

## Changes to This Policy

Any changes to this privacy policy will be reflected in this document with an updated date.

## Support

If you find KickAlert useful, consider supporting the project:

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **GitHub Sponsors:** [github.com/sponsors/segelferd](https://github.com/sponsors/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## Contact

For questions or concerns, please open an issue on [GitHub](https://github.com/segelferd/kick-alert/issues).
