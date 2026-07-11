# KickAlert

**Chrome & Firefox Extension — Real-Time Kick.com Live Stream Notifications, Chat Filters & Viewer Analytics**

Your favorite streamer goes live at 3 AM. You're asleep. You miss it. KickAlert makes sure that never happens again — catching every surprise broadcast the instant it starts.

## Features

### ⚡ Real-Time Notifications
- **Live WebSocket alerts** — built on a persistent Pusher WebSocket connection, notifications fire the **moment** a followed channel goes live (no polling lag)
- **Desktop notifications** with the streamer's avatar
- **Notification actions** — open or mute channels directly from the popup
- **Notification delay** — immediate, or after 5 / 10 / 15 minutes
- **Per-channel sound control** — 4-state bell: main / secondary / silent / muted
- **Dynamic tooltip** — hover the icon to see who's live without opening the popup

### 💬 Chat Integration (optional)
A dedicated Chat tab with **9 configurable filters** — take back control of any channel's chat:
- **Bot filter** — hide known chat bots
- **Word / user blocklists**
- **Repeated-message filter** (anti-spam)
- **Emoji-spam filter**
- **Keyword highlight** — glow on messages matching your keywords
- **Favorite-user highlight** — uses the user's own Kick color
- **@mention alerts** — desktop notification when someone tags you
- **Broadcaster-message alerts** — get notified when the streamer talks
- Each filter has its own on/off switch, with **hide** or **blur** mode

### 📊 Viewer Anomaly Detection
- **Spike & drop detection** — alerts when a channel's viewer count rises or falls abnormally fast
- **Sensitivity control** — Sensitive / Balanced / Strict
- **Rate-of-change engine** — sliding-window comparison to catch sudden jumps
- **Session peak/valley tracking** — per-stream all-time high and low
- **Anomaly badge** — colored badge (↑ spike / ↓ drop) on channel cards

### 📈 Channel Overview & Trends
- **Sparkline trend graph** — mini viewer chart on every live card
- **Viewer trend modal** — full chart with peak / low / averages, a rotating **Overall / Now** momentum badge, and marked peak point
- **Favorite channels** — star channels (available on both tabs); favorites + live appear first
- **Channel groups** — create custom groups, filter with a chip-bar
- **Category filter** — filter live channels by game/category
- **Offline channels** — optionally show followed channels that aren't live, with last-seen info
- **Search** — across Following and Auto-Launch tabs, including category names

### 📺 Multi-Stream Viewer
- Watch up to **4 Kick channels simultaneously** in a dedicated tab
- Multiple layout options (solo, side-by-side, triple, 2×2 grid, focus)
- Mute / unmute individual streams with one click

### 🚀 Auto-Launch
- Automatically open streams in a new tab — per-channel toggle
- **Duplicate tab guard** — won't open a tab if the stream is already open
- **Suspend mode** — pause auto-launch temporarily
- **Auto-unmute** — automatically unmute the player after launch

### ⚙️ Settings
- **Do Not Disturb** — schedule quiet hours; mute notifications, sounds, and auto-launch independently
- **Cloud sync** — sync settings across devices via your browser account
- **Dark & light theme**
- **Custom sounds** — upload your own audio files (up to 2 MB each), with volume control
- **Adjustable check interval** — fallback polling between 30–300 seconds
- **13 languages** — EN, TR, DE, FR, ES, PT-BR, IT, RU, JA, KO, ZH-CN, AR, CS (runtime switchable, auto-detected)

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
│   ├── background.js    # Service worker — WebSocket coordination, notifications, anomaly detection
│   ├── pusher.js        # Pusher WebSocket client — real-time live events
│   ├── offscreen.js     # Offscreen document — persistent WebSocket + background audio
│   ├── popup.js         # Popup UI — channel cards, sparklines, trend modal, options
│   ├── chat.js          # Chat integration — 9 filters, highlights, mention alerts
│   ├── bot_tracker.js   # Chat bot detection / health scoring
│   ├── content.js       # Content script — auto-unmute + reliable live-status on kick.com
│   ├── storage.js       # Storage abstraction layer
│   ├── kickapi.js       # Kick.com API client — Bearer auth, cursor pagination, backoff
│   ├── multistream.js   # Multi-stream viewer page logic
│   ├── utils.js         # i18n, formatters (formatViewers, formatDuration)
│   └── test.js          # Built-in test panel logic
├── html/
│   ├── popup.html       # Extension popup
│   ├── multistream.html # Multi-stream viewer tab
│   ├── offscreen.html   # Offscreen document (WebSocket + audio)
│   └── test.html        # Test / diagnostics panel
├── css/
│   ├── popup.css        # Popup & options styles
│   └── multistream.css  # Multi-stream viewer styles
├── _locales/            # 13 language files
├── icons/               # Extension icons
├── sounds/              # Default notification sounds
├── rules.json           # declarativeNetRequest rules (Referer header)
└── manifest.json        # Manifest V3 (Chrome & Firefox builds kept in sync)
```

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Preferences, per-channel settings, favorites, groups, history, cloud sync |
| `offscreen` | Holds the persistent WebSocket connection and plays notification sounds (MV3 workers can't do either directly) |
| `notifications` | Desktop notifications when streamers go live |
| `cookies` | Read Kick.com session cookie for API auth (never sent elsewhere) |
| `tabs` | Auto-launch, duplicate tab detection, multi-stream management |
| `alarms` | Fallback periodic checks (MV3 workers sleep after ~30s) |
| `declarativeNetRequestWithHostAccess` | Set Referer header for Kick.com API |
| `scripting` | Inject content script into open kick.com tabs (reliability fallback) |
| `host: kick.com` | Fetch followed channels & live status |
| `host: ws-us2.pusher.com` | Real-time WebSocket live events |

## Technical Highlights

- **Real-time over WebSocket** — a live Pusher connection (`wss://ws-us2.pusher.com`) delivers `StreamerIsLive` events instantly, replacing slow polling and bypassing peak-hour rate limits
- **Offscreen-held connection** — the WebSocket and audio live in an offscreen document, surviving Manifest V3 service-worker sleep
- **Layered request resilience** — Referer override, request jitter, content-script proxy fallback, and minimal headers keep API calls reliable
- **Zero dependencies** — pure vanilla JS, no build step required
- **Manifest V3** — modern, cross-browser architecture
- **Rate-of-change anomaly engine** — sliding-window comparison with session-wide peak/valley tracking
- **Exponential backoff** — smart retry on API failures (429-aware)
- **Stale-while-revalidate** — instant popup loading from cached channel data
- **Cloud sync** — optional browser sync with smart exclusion of large/local-only data
- **Custom i18n** — runtime language switching; notifications follow the user's selected language

## Privacy

KickAlert does not collect, transmit, or store any personal data externally. It communicates only with `kick.com` and Kick's real-time WebSocket service. All data stays in your browser. See [Privacy Policy](https://raw.githubusercontent.com/segelferd/kick-alert/main/privacy-policy.md).

## Support

If you find KickAlert useful, consider supporting the project:

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## License

[PolyForm Noncommercial 1.0.0](LICENSE) © 2025–2026 Segelferd — free for personal, hobby, and noncommercial use. See [LICENSE](LICENSE) for full terms.
