# KickAlert

**Browser extension for Kick.com - real-time live stream notifications, auto-launch, chat radar, multi-stream and optional ad blocking. Chrome, Firefox, Edge and Opera.**

Your favorite streamer goes live at 3 AM. You're asleep. You miss it. KickAlert makes sure that never happens again - catching every surprise broadcast the instant it starts.

🌐 **Website:** [segelferd.github.io/kick-alert](https://segelferd.github.io/kick-alert/) · **Current version:** 2.6.0 · [Changelog](CHANGELOG.md)

## Features

### ⚡ Real-Time Notifications
- **Live WebSocket alerts** - built on Kick's own real-time service (Pusher, with Kick's Centrifugo server as an automatic backup), notifications fire the **moment** a followed channel goes live (no polling lag)
- **Desktop notifications** with the streamer's avatar; click to open the stream
- **Channel event alerts** - raids, stream end, category or title change, and stream moved to another channel, each per channel and each with its own sound
- **Per-channel sound control** - 4-state bell: main / secondary / silent / muted
- **Pause notifications** - for 1 hour or until morning, optionally letting favorites through; "Mute for 1 hour" on a single channel
- **"Will this channel notify you?"** - the channel settings window checks every setting that decides whether an alert will come, and says why not
- **Notification history** with watch-time statistics
- **Toolbar tooltip** - hover the icon to see who's live without opening the popup

### 🤖 Bot-Inflated Stream Detection
A lightweight scoring model flags channels that might be running inflated viewer counts:

- **Live bot-suspicion score** per channel, colour-coded (very low → very high)
- **Multi-signal analysis** - viewer-to-chatter ratio (including Kick's own active-chatter count), chat velocity, chat modes, username patterns, message diversity
- Runs entirely client-side - no chat data leaves the browser
- Score badge shown inline on channel cards (always-on or anomaly-triggered, configurable)

### 💬 Chat Integration (optional)
A dedicated **Chat** tab with configurable filters - take back control of any channel's chat:

- **Bot filter** - hide known chat bots
- **Word / user blocklists**
- **Repeated-message filter** (anti-spam) and **emoji-spam filter**
- **Disguised spelling detection** - full-width or styled letters, look-alike letters, invisible characters and s.p.a.c.e.d letters are caught, while whole-word matching stays exact
- **Keyword highlight** and **favorite-user highlight** (uses the user's own Kick color)
- **@mention alerts** and **broadcaster-message alerts**
- **Background chat radar** - watches up to 5 followed channels' chat even with no Kick tab open and notifies you when your name or chosen words appear
- Each filter has its own on/off switch, with hide or blur mode

### 📊 Viewer Anomaly Detection
- **Spike & drop detection** - alerts when a channel's viewer count rises or falls abnormally fast
- **Sensitivity control** - Sensitive / Balanced / Strict
- **Session peak/valley tracking** - per-stream all-time high and low
- **Anomaly badge** - colored badge (↑ spike / ↓ drop) on channel cards

### 📈 Channel Overview & Trends
- **Sparkline trend graph** - mini viewer chart on every live card
- **Viewer trend modal** - full chart with peak / low / averages and momentum
- **Favorite channels**, **channel groups** with a chip-bar filter, **category filter**
- **Offline channels** - optionally show followed channels that aren't live, with last-seen info
- **Search** across Following and Auto-Launch tabs, including category names
- **Comfortable or compact card layout**

### 🖼️ Channel Preview Images (optional)
- Live thumbnail on every live channel card, with viewer count and bot score overlaid
- Loads progressively - the list renders immediately, thumbnails fill in as they arrive
- Off by default - sends one extra request per live channel each time the popup opens

### 📺 Multi-Stream Viewer
- Watch up to **4 Kick channels** simultaneously in a dedicated tab
- Layouts: solo, side-by-side, triple, 2×2 grid, focus; drag tiles to reorder
- Streams start muted; **listen to one stream** with a single click
- **Chat drawer** - Kick's chat for any of the open streams, on the side

### 🚀 Auto-Launch
- Automatically open streams in a new tab - per-channel toggle
- **Duplicate tab guard** - won't open a tab if the stream is already open
- **Suspend mode** - pause auto-launch temporarily
- **Auto-unmute** - unmutes the player after launch; falls back to muted playback if the browser's autoplay policy blocks it
- **Stream-moved guard** (optional) - closes a tab KickAlert opened when a raid sends it to another channel

### 🚫 Ad Blocking (experimental, optional)
- Skips pre-roll and mid-roll ads on Kick streams and blocks known ad domains on kick.com
- Off by default - one toggle in Settings to enable
- Experimental: depends on Kick's internal player structure and may break without notice

### ✨ Interface
- Smooth motion: cards glide to their new place, new live channels get a short ring wave, time-left rings on paused or muted items; all skipped when the system asks for reduced motion
- **Undo bar** for removing a favorite, clearing history, deleting a group or removing a chat word
- Clear empty states ("No one is live right now", "You're not following anyone yet")
- **Special-day icons** - a themed toolbar icon on a few holidays, based on the local time zone (can be turned off)
- Dark & light theme

### ⚙️ Settings
- **Do Not Disturb** - schedule quiet hours; mute notifications, sounds and auto-launch independently
- **Cloud sync** - sync settings across devices via your browser account
- **Backup** - export and import all settings as a file
- **Custom sounds** - upload your own audio files (up to 2 MB each), with volume control; 10 built-in event sounds
- **Adjustable check interval** - fallback polling between 30-300 seconds
- **14 languages** - EN, TR, DE, FR, ES, PT-BR, IT, RU, JA, KO, ZH-CN, AR, CS, SK (runtime switchable, auto-detected)

## Installation

### Chrome Web Store
Install from the [Chrome Web Store](https://chromewebstore.google.com/detail/kickalert/dlchkgjgcmbgpbdiiipibnpjfhipkbac).

### Firefox Add-ons
Install from [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/kickalert/).

### Microsoft Edge and Opera
Coming soon to Edge Add-ons and Opera Add-ons. Until then, Edge and Opera can install the Chrome Web Store version.

### Manual Install (Developer Mode)
1. Download or clone this repository
2. Go to `chrome://extensions/` (or `about:debugging` in Firefox)
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder
5. Log in to [kick.com](https://kick.com) and follow some channels

## File Structure

```
├── src/
│   ├── background.js          # Service worker - real-time coordination, notifications, anomaly detection
│   ├── pusher-config.js       # Real-time server settings from Kick; Centrifugo backup adapter
│   ├── pusher.js              # Pusher WebSocket client - real-time live events
│   ├── offscreen.js           # Offscreen document - persistent WebSocket + background audio
│   ├── popup.js               # Popup UI - channel cards, sparklines, trend modal, options
│   ├── motion.js              # Interface motion helpers (respects reduced motion)
│   ├── specialday.js          # Special-day toolbar icons (local calendar, no network)
│   ├── chat.js                # Chat integration - filters, highlights, mention alerts
│   ├── textfold.js            # Text normalisation for chat filters and the chat radar
│   ├── bot_tracker.js         # Chat bot detection / health scoring
│   ├── content.js             # Content script - auto-unmute + reliable live-status on kick.com
│   ├── adblock-worker-hook.js # MAIN-world hook - optional ad blocking
│   ├── adblock-gpt-stub.js    # MAIN-world stub for ad SDKs (optional ad blocking)
│   ├── adblock-dom-guard.js   # Hides ad containers on kick.com (optional ad blocking)
│   ├── ad-diag.js             # Ad diagnostics store; optional, off-by-default sharing
│   ├── storage.js             # Storage abstraction layer, cloud sync
│   ├── backup.js              # Settings export / import
│   ├── kickapi.js             # Kick.com API client - Bearer auth, cursor pagination, backoff
│   ├── multistream.js         # Multi-stream viewer page logic
│   ├── utils.js               # i18n, formatters
│   └── test.js, test-v2.js    # Built-in test / diagnostics panel
├── html/                      # popup, multistream, offscreen, backup, test pages
├── css/                       # popup, multistream and font styles
├── _locales/                  # 14 language files
├── icons/                     # Extension icons (icons/special/ for special days)
├── sounds/                    # Default notification and event sounds
├── rules/
│   └── ad-domains.json        # DNR ruleset for optional ad blocking (disabled by default)
├── rules.json                 # declarativeNetRequest rules (Referer / Origin headers)
└── manifest.json              # Manifest V3 (Chrome & Firefox builds kept in sync)
```

## Permissions

| Permission | Reason |
|---|---|
| `storage` | Preferences, per-channel settings, favorites, groups, history, cloud sync |
| `offscreen` | Holds the persistent WebSocket connection and plays notification sounds (MV3 workers can't do either directly) |
| `notifications` | Desktop notifications when streamers go live |
| `cookies` | Read Kick.com session cookie for API auth (never sent elsewhere) |
| `tabs` | Auto-launch, duplicate tab detection, multi-stream management |
| `alarms` | Fallback periodic checks, pause and mute timers (MV3 workers sleep after ~30s) |
| `declarativeNetRequestWithHostAccess` | Set Referer / Origin headers for Kick.com API; optional ad-domain blocking ruleset (disabled by default) |
| `scripting` | Inject content script into open kick.com tabs (reliability fallback) |
| host: `kick.com` | Fetch followed channels & live status |
| host: `web.kick.com` | Get Kick's current real-time server settings and public active-chatter count |
| host: `ws-us2.pusher.com` | Real-time WebSocket live events |
| optional host: `*.kick.com` | Requested only for the backup real-time connection (Kick's Centrifugo server) when Kick's main service goes quiet; not asked on install or update |
| optional host: ad domains | Requested only when Ad Blocking is turned on; lets the block rules stop ad requests from kick.com |

## Technical Highlights

- **Real-time over WebSocket** - a live Pusher connection (`wss://ws-us2.pusher.com`) delivers live events instantly, with an automatic switch to Kick's Centrifugo server if Pusher goes quiet
- **Offscreen-held connection** - the WebSocket and audio live in an offscreen document, surviving Manifest V3 service-worker sleep
- **Layered request resilience** - header rules, request jitter, content-script proxy fallback and minimal headers keep API calls reliable
- **Zero dependencies** - pure vanilla JS, no build step required
- **Manifest V3** - one code base for Chrome, Firefox, Edge and Opera
- **Exponential backoff** - smart retry on API failures (429-aware)
- **Stale-while-revalidate** - instant popup loading from cached channel data
- **Custom i18n** - runtime language switching; notifications follow the user's selected language

## Privacy

KickAlert does not collect, transmit, or store any personal data externally. It communicates only with `kick.com` and Kick's real-time WebSocket service, plus, only if you turn on the off-by-default *Share ad diagnostics* option, a technical ad diagnostics summary without personal data sent to the developer's Google Apps Script. Everything else stays in your browser. See the [Privacy Policy](https://segelferd.github.io/kick-alert/privacy/).

## Support

If you find KickAlert useful, consider supporting the project:

- **Buy Me a Coffee:** [buymeacoffee.com/segelferd](https://buymeacoffee.com/segelferd)
- **Bitcoin:** `bc1q7cmtp9vd6wmztxun0702whyve53u5xld2g82qp`

## License

[PolyForm Noncommercial 1.0.0](LICENSE) © 2025-2026 Segelferd - free for personal, hobby, and noncommercial use. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for full terms.
