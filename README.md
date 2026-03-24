# KickAlert

**Chrome & Firefox Extension — Kick.com Live Stream Notification & Auto-Launch**

Get notified when your favorite Kick streamers go live. Auto-launch streams, control notifications per channel, watch multiple streams simultaneously, and never miss a broadcast.

## Features

- **Live Notifications** — Desktop alerts with streamer's avatar when followed channels go live
- **Auto-Launch** — Automatically open streams in a new tab (per-channel toggle)
- **Per-Channel Sound Control** — 4-state bell icon: main sound, secondary sound, silent notification, or fully muted
- **Favorite Channels** — Star your top channels, they appear first in the list
- **Channel Groups** — Create custom groups and filter your following list with one click
- **Multi-Stream Viewer** — Watch up to 4 Kick channels simultaneously with 5 layouts and drag-drop reorder
- **Do Not Disturb** — Schedule quiet hours — mute notifications, sounds, and auto-launch independently
- **Cloud Sync** — Sync settings across devices via your Google account
- **Dark & Light Theme** — Choose your preferred appearance
- **Sound Mode Selection** — Extension sounds (custom audio + volume) or Windows notification sounds
- **Duplicate Tab Guard** — Prevents opening the same stream twice
- **Notification History** — Browse past live events with timestamps (last 100)
- **Custom Sounds** — Upload your own notification sounds (up to 2 MB each)
- **Adjustable Check Interval** — 30–300 seconds
- **Auto-Unmute** — Automatically unmute player after auto-launch
- **12 Languages** — EN, TR, DE, FR, ES, PT-BR, AR, JA, KO, RU, IT, ZH-CN (runtime switchable)

## Installation

### Chrome Web Store
Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/kickalert/dlchkgjgcmbgpbdiiipibnpjfhipkbac).

### Firefox Add-ons
Install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/kickalert/) (coming soon).

### Manual Install (Developer Mode)
1. Download or clone this repository
2. Go to `chrome://extensions/` (or `about:debugging` in Firefox)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder
5. Log in to [kick.com](https://kick.com) and follow some channels

## Project Structure

```
kickalert/
├── manifest.json              # Chrome manifest (MV3)
├── manifest.firefox.json      # Firefox manifest (MV3)
├── rules.json                 # Declarative net request rules
├── LICENSE                    # MIT License
├── privacy-policy.md          # Privacy policy
├── src/
│   ├── background.js          # Service worker — alarms, notifications, auto-launch
│   ├── popup.js               # Popup UI — tabs, cards, bells, groups, favorites, options
│   ├── storage.js             # Storage abstraction — local + optional cloud sync
│   ├── kickapi.js             # Kick.com API client — auth, pagination, channel details
│   ├── utils.js               # Utilities — i18n, formatters, slug extraction
│   ├── content.js             # Content script — auto-unmute on kick.com
│   ├── offscreen.js           # Audio playback & worker keep-alive (Chrome only)
│   └── multistream.js         # Multi-stream viewer — layouts, drag-drop
├── html/
│   ├── popup.html             # Popup UI
│   ├── multistream.html       # Multi-stream viewer
│   └── offscreen.html         # Offscreen document (Chrome only)
├── css/
│   ├── popup.css              # Popup styles — dark/light theme, Kick-themed
│   └── multistream.css        # Multi-stream viewer styles
├── icons/                     # Extension icons (48px, 128px)
├── images/
│   ├── bmc/                   # Buy Me a Coffee buttons (white + dark)
│   ├── default-profile-pictures/
│   └── no_stream/
├── sounds/                    # Default notification sounds (main + sub)
└── _locales/                  # i18n messages (12 languages)
    ├── en/ tr/ de/ fr/ es/ pt_BR/ ar/ ja/ ko/ ru/ it/ zh_CN/
```

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Preferences, per-channel sound, favorites, groups, DND, cloud sync, history |
| `notifications` | Desktop notifications when streamers go live |
| `tabs` | Auto-launch, duplicate tab detection, multi-stream management |
| `cookies` | Read Kick.com session cookie for API auth (never sent elsewhere) |
| `offscreen` | Play custom notification sounds in background (Chrome only) |
| `alarms` | Reliable periodic channel checks (MV3 workers sleep after ~30s) |
| `declarativeNetRequestWithHostAccess` | Set referer header for Kick.com API |

## Technical Highlights

- **Zero dependencies** — Pure vanilla JS, no build step
- **Manifest V3** — Modern extension architecture
- **Cross-browser** — Chrome + Firefox from single codebase
- **chrome.alarms** — Reliable scheduling surviving worker sleep
- **Cloud sync** — Optional chrome.storage.sync with smart exclusion (audio files, history excluded)
- **Custom i18n** — Runtime language switching, notifications follow user's selected language

## Privacy

KickAlert does not collect, transmit, or store any personal data externally. All data stays in your browser's local storage. See [Privacy Policy](https://raw.githubusercontent.com/segelferd/kick-alert/main/privacy-policy.md).

## Support

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## License

MIT © 2025–2026 Segelferd
