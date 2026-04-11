# KickAlert

**Chrome & Firefox Extension — Kick.com Live Stream Notifications & Viewer Analytics**

No more ninja streams at 3 AM — KickAlert catches every surprise broadcast, even the sneakiest ones ;)

## Features

### 🔔 Notifications & Alerts
- **Live Notifications** — Desktop alerts with streamer's avatar when followed channels go live
- **Notification Actions** — Open or Mute channels directly from the notification popup
- **Notification Delay** — Get notified immediately, or after 5, 10, or 15 minutes
- **Per-Channel Sound Control** — 4-state bell: main sound / secondary sound / silent / muted
- **Dynamic Tooltip** — Hover over the icon to see who's live without opening the popup

### 📊 Viewer Anomaly Detection
- **Spike Detection** — Alerts when a channel's viewer count rises abnormally fast
- **Drop Detection** — Alerts when a channel's viewer count falls abnormally fast
- **Sensitivity Control** — Sensitive / Balanced / Strict for both spike and drop
- **Rate-of-Change Engine** — Detects sudden jumps using a 30-minute sliding window (60 data points)
- **Session Peak/Valley Tracking** — Tracks all-time high and low per stream, resets each cooldown
- **Smart Thresholds** — Min 1,000 viewers required; no false alarms at stream start

### 📺 Multi-Stream Viewer
- Watch up to 4 Kick channels simultaneously in a dedicated tab
- 5 layout options: solo, side-by-side, triple, 2×2 grid, focus
- Drag and drop to reorder streams

### 🚀 Auto-Launch
- Automatically open streams in a new tab per-channel toggle
- **Duplicate Tab Guard** — Won't open a tab if the stream is already open
- **Suspend Mode** — Pause auto-launch temporarily

### 📋 Channel Overview
- **Sparkline Trend Graph** — Mini viewer trend chart on every live card
- **Viewer History Modal** — Full trend chart with min/max labels, navigate between live channels
- **Anomaly Badge** — Colored badge (↑ spike / ↓ drop) directly on channel cards
- **Favorite Channels** — Star channels, they appear first (favorite+live priority)
- **Channel Groups** — Create custom groups, filter with chip-bar
- **Category Filter** — Filter live channels by game/category
- **Offline Channels** — Optionally show followed channels that are not live, with last-seen info
- **Search** — Filter across Following and Auto-Launch tabs, including category names

### ⚙️ Settings
- **Do Not Disturb** — Schedule quiet hours; mute notifications, sounds, auto-launch independently
- **Cloud Sync** — Sync settings across devices via your Google account
- **Dark & Light Theme**
- **Sound Mode** — Extension sounds (custom audio + volume control) or Windows notification sounds
- **Custom Sounds** — Upload your own audio files (up to 2 MB each)
- **Auto-Refresh Popup** — Keep the following list up to date automatically
- **Adjustable Check Interval** — 30–300 seconds
- **Auto-Unmute** — Automatically unmute player after auto-launch
- **12 Languages** — EN, TR, DE, FR, ES, PT-BR, AR, JA, KO, RU, IT, ZH-CN (runtime switchable)

## Installation

### Chrome Web Store
Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/kickalert/dlchkgjgcmbgpbdiiipibnpjfhipkbac).

### Firefox Add-ons
Install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/kickalert/).

### Manual Install (Developer Mode)
1. Download or clone this repository
2. Go to `chrome://extensions/` (or `about:debugging` in Firefox)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder
5. Log in to [kick.com](https://kick.com) and follow some channels

## File Structure

```
├── src/
│   ├── background.js    # Service worker — channel polling, notifications, anomaly detection
│   ├── popup.js         # Popup UI — channel cards, sparklines, options panel
│   ├── storage.js       # Storage abstraction layer
│   ├── kickapi.js       # Kick.com API client — Bearer auth, cursor pagination, backoff
│   ├── utils.js         # i18n, formatters (formatK, formatDuration)
│   ├── offscreen.js     # Background audio playback (Chrome)
│   ├── content.js       # Content script — auto-unmute on kick.com
│   └── multistream.js   # Multi-stream viewer page logic
├── html/
│   ├── popup.html       # Extension popup
│   ├── multistream.html # Multi-stream viewer tab
│   └── offscreen.html   # Offscreen document for audio
├── css/
│   ├── popup.css        # Popup & options styles
│   └── multistream.css  # Multi-stream viewer styles
├── _locales/            # 12 language files
├── icons/               # Extension icons (48px, 128px)
├── sounds/              # Default notification sounds
├── manifest.json        # Chrome MV3 manifest
└── manifest.firefox.json # Firefox-specific manifest
```

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Preferences, per-channel settings, favorites, groups, history, cloud sync |
| `notifications` | Desktop notifications when streamers go live |
| `tabs` | Auto-launch, duplicate tab detection, multi-stream management |
| `cookies` | Read Kick.com session cookie for API auth (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in background (Chrome only) |
| `alarms` | Reliable periodic channel checks (MV3 workers sleep after ~30s) |
| `declarativeNetRequestWithHostAccess` | Set Referer header for Kick.com API |

## Technical Highlights

- **Zero dependencies** — Pure vanilla JS, no build step required
- **Manifest V3** — Modern extension architecture, cross-browser
- **chrome.alarms** — Reliable scheduling that survives service worker sleep
- **Rate-of-change anomaly engine** — Sliding window comparison (last 2 min vs previous 2 min)
- **streamPeak / streamValley** — Session-wide extremes for accurate long-term detection
- **Exponential backoff** — Smart retry on API failures (1s → 2s → 4s → 8s, 429-aware)
- **Stale-while-revalidate** — Instant popup loading from cached channel data
- **Cloud sync** — Optional chrome.storage.sync with smart exclusion of large/local-only data
- **Custom i18n** — Runtime language switching, notifications follow user's selected language
- **Persisted state** — liveChannelSlugs and notifiedLives survive service worker restarts

## Privacy

KickAlert does not collect, transmit, or store any personal data externally. All data stays in your browser. See [Privacy Policy](https://raw.githubusercontent.com/segelferd/kick-alert/main/privacy-policy.md).

## Support

If you find KickAlert useful, consider supporting the project:

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **GitHub Sponsors:** [github.com/sponsors/segelferd](https://github.com/sponsors/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## License

MIT © 2025–2026 Segelferd
