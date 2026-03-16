# KickAlert

**Chrome Extension — Kick.com Live Stream Notification & Auto-Launch**

Get notified when your favorite Kick streamers go live. Auto-launch streams, control notifications per channel, watch multiple streams simultaneously, and never miss a broadcast.

## Features

- **Live Notifications** — Desktop alerts when followed channels go live
- **Auto-Launch** — Automatically open streams in a new tab (per-channel toggle)
- **Per-Channel Sound Control** — 4-state bell icon for each channel: main sound, secondary sound, silent notification, or fully muted
- **Multi-Stream Viewer** — Watch multiple Kick channels simultaneously with 5 layout options (Solo, Side-by-Side, Triple, 2×2 Grid, Focus) and drag-drop reorder
- **Do Not Disturb** — Schedule quiet hours with granular control — mute notifications, sounds, and auto-launch independently
- **Sound Mode Selection** — Choose between extension sounds (custom audio + volume control) or Windows notification sounds
- **Duplicate Tab Guard** — Prevents opening the same stream twice
- **Notification History** — Browse past live events with timestamps
- **Custom Sounds** — Upload your own notification sounds for main and secondary alerts (up to 2 MB each)
- **Adjustable Check Interval** — 30–300 seconds
- **Auto-Unmute** — Automatically unmute player after auto-launch
- **8 Languages** — EN, TR, DE, FR, ES, PT-BR, AR, JA (runtime switchable)
- **Suspend Mode** — Temporarily pause all auto-launches
- **Stream Duration & Viewer Count** — Live time counter with K/M formatted viewer counts and category tags

## Installation

### Chrome Web Store
Install from the [Chrome Web Store](https://chromewebstore.google.com/) (search "KickAlert").

### Manual Install (Developer Mode)
1. Download or clone this repository
2. Go to `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder
5. Log in to [kick.com](https://kick.com) and follow some channels

## Project Structure

```
kickalert/
├── manifest.json          # Extension manifest (MV3)
├── rules.json             # Declarative net request rules
├── LICENSE                # MIT License
├── privacy-policy.md      # Privacy policy
├── src/
│   ├── background.js      # Service worker — chrome.alarms monitoring, notifications, auto-launch
│   ├── popup.js           # Popup UI — tabs, channel cards, bell buttons, options panel
│   ├── storage.js         # Chrome storage abstraction — all get/set operations
│   ├── kickapi.js         # Kick.com API client — Bearer auth, cursor pagination
│   ├── utils.js           # Utility functions — i18n, formatters, slug extraction
│   ├── content.js         # Content script — auto-unmute on kick.com
│   ├── offscreen.js       # Audio playback & service worker keep-alive
│   └── multistream.js     # Multi-stream viewer — layouts, drag-drop, session management
├── html/
│   ├── popup.html         # Popup UI
│   ├── multistream.html   # Multi-stream viewer page
│   └── offscreen.html     # Offscreen document for audio
├── css/
│   ├── popup.css          # Popup styles — Kick-themed dark UI
│   ├── multistream.css    # Multi-stream viewer styles
│   └── option.css         # Options styles (legacy)
├── icons/                 # Extension icons (48px, 128px)
├── sounds/                # Default notification sounds (main + sub)
├── images/                # Default profile pictures
└── _locales/              # i18n messages (8 languages)
    ├── en/
    ├── tr/
    ├── de/
    ├── fr/
    ├── es/
    ├── pt_BR/
    ├── ar/
    └── ja/
```

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Save preferences, per-channel sound settings, DND schedule, and notification history |
| `notifications` | Show desktop notifications when streamers go live |
| `tabs` | Auto-launch streams, duplicate tab detection, and multi-stream management |
| `cookies` | Read Kick.com session cookie for API authentication (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in background |
| `alarms` | Reliably schedule periodic channel checks (MV3 service workers sleep after ~30s) |
| `declarativeNetRequestWithHostAccess` | Set referer header for Kick.com API requests |

## Technical Highlights

- **Zero dependencies** — Pure vanilla JavaScript, no build step required
- **Manifest V3** — Modern Chrome extension architecture
- **chrome.alarms** — Reliable scheduling that survives service worker sleep cycles
- **Persisted state** — Live channel tracking and notification click URLs survive worker restarts
- **Custom i18n** — Runtime language switching (Chrome's built-in i18n doesn't support this)
- **Smart rendering** — Multi-stream iframe management without reload on reorder

## Privacy

KickAlert does not collect, transmit, or store any personal data externally. All data stays in your browser's local storage. See [Privacy Policy](https://raw.githubusercontent.com/segelferd/kick-alert/main/privacy-policy.md).

## Support

If you find KickAlert useful, consider supporting the project:

- **GitHub Sponsors:** [github.com/sponsors/segelferd](https://github.com/sponsors/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## License

MIT © 2025–2026 Segelferd
