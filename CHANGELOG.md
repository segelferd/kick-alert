# Changelog

All notable changes to KickAlert are documented here. Entries are grouped by
meaningful milestone rather than every internal build - small consecutive
patch versions with no user-facing change are folded into the entry that
follows them.

## v2.6.0 - Smoother interface, special-day icons, Undo

Store release (Chrome, Firefox, and for the first time Microsoft Edge and Opera). It also carries everything from v2.5.111, which never reached the stores.

- **Interface motion:** cards glide to their new place when the list changes (a channel goes live, sorting changes) instead of jumping; new cards fade in. Channels that went live since the popup was last opened get a short green ring wave on the avatar. The bell rings when switched to a sound mode and dips when silenced or muted. The refresh icon spins while the list reloads. The active tab highlight slides between tabs. Dialogs open with a short scale-in. A notification that arrives while the popup is open slides into the history list. Chat chips pop in when added and shrink away when removed. A changed viewer count slides in. All motion is skipped when the system asks for reduced motion
- **Time-left rings:** the pause pill and the bell of a channel muted with "Mute for 1 hour" show the remaining time as a ring; the bell tooltip says until when (new string `bellSnoozedUntil`)
- **Cleaner channel cards:** the bell, the favourite star and any button that carries a state (custom alerts) stay visible; open, Multi-Stream, group and alerts slide out on hover or keyboard focus, without leaving gaps. Cards with a preview image keep all buttons
- **Undo bar:** removing a favourite, clearing the notification history (no confirmation before), deleting a channel group (assignments come back too) and removing a chat word or channel chip can be undone for 5 seconds
- **Empty lists:** "No one is live right now" with a "Show offline channels" button (only when that setting is off) and, for new users, "You're not following anyone yet" with an "Open Kick.com" button
- **Special-day icons:** on a few holidays the toolbar icon (and the logo in Multi-Stream and the welcome screen) gets a themed design: New Year and Halloween for everyone; 23 April, 19 May, 30 August, 29 October (Turkey), 4 July (US), 7 September and Carnival (Brazil), 5 May (Japan), 16 September (Mexico). On 10 November the logo is black and white in Turkey. The region comes from the computer's time zone and is never sent anywhere. Toolbar sizes (16 and 32 px) are drawn pixel by pixel. Settings > General > Display: "Special-day icons" (on by default). The developer test panel can preview each design
- **Multi-Stream:** the tile playing sound shows a small equalizer; tiles slide to their new place and size when the layout changes or a tile is dragged, without reloading players
- **Visual polish:** one icon style everywhere (outlined), the sort bar and the Auto-Launch search stay on top while the list scrolls (frosted background, shadow under the tabs), buttons press in slightly, switches move with a spring, theme changes cross-fade where the browser supports it
- **Website:** the extension's homepage link now opens segelferd.github.io/kick-alert
- **Translations:** French now addresses the user as "tu" everywhere and uses typographic apostrophes (136 strings); Slovak new strings follow the file's informal "ty". New strings (14 languages): `bellSnoozedUntil`, `specialDayIconsLabel`, `specialDayIconsDesc`, `emptyLiveTitle`, `emptyLiveDesc`, `emptyShowOffline`, `emptyFollowTitle`, `emptyFollowDesc`, `undo`, `toastFavRemoved`, `toastHistoryCleared`, `toastGroupRemoved`, `toastChipRemoved`
- What's New (14 languages): new V0 entry and banner; v2.5.111 and v2.5.87 kept
- No new permissions compared with v2.5.111. Compared with the last store version (v2.5.87) the optional `*://*.kick.com/*` and `wss://*.kick.com/*` permissions from v2.5.110 are included; they are only requested for the backup connection, never on install or update. No remote code.

## v2.5.111 - What's New wording and untranslated tooltips

- **What's New banner (14 languages):** the short note on the main screen read as a fragment ("New: pause notifications, ... in Multi-Stream."): it started in lower case after the colon and ended on the capitalised page name. It is now one complete sentence in every language, starting with a capital letter and naming the page in plain words ("This version lets you pause notifications, ... in the multi-stream view.")
- **Untranslated tooltips:** some tooltips stayed in English in every language: the sort buttons above the channel list (their translations existed but were only applied inside Settings and Chat), the Multi-Stream and Kick.com buttons in the top bar, the open / add to Multi-Stream / favourite buttons on channel cards and the remove button on group tags. All now follow the selected language. Close buttons also get a translated screen-reader label
- New strings (14 languages): `cardOpenChannel`, `cardAddToMulti`, `favAdd`, `favRemove`, `multiStreamOpen`, `openKickSite`
- What's New history: the v2.5.110 entry is now labelled v2.5.111, since v2.5.110 never reached the stores
- **Japanese:** the interface now says 自動入場 (the word Japanese Kick viewers use for streams opening by themselves) instead of 自動オープン in all 12 places
- **Store title and summary (Japanese, English):** rewritten around what people search for. JA: "KickAlert - Kick配信通知・自動入場・広告ブロック"; EN: "KickAlert - Kick Live Alerts, Auto-Launch & Ad Blocker". The old summaries with the "ninja" joke are gone
- **Store titles and summaries (12 more languages):** rewritten around what people search for in each language (live stream notifications for Kick, auto-launch, ad blocking); the "ninja" joke moved from the summary to the end of the full store description
- **Firefox name:** Firefox Add-ons and Edge allow at most 45 characters for the name, so the Firefox package uses a new short name (`appNameShort`, 14 languages); Chrome keeps the longer title
- **Rating request:** shown at a better moment. It now appears after you open a stream from a KickAlert notification (within 48 hours), once the extension has been used for 3 days and the popup opened 5 times (was 7 days, 10 opens and a changed setting). Without such a moment it appears after 14 days. Still at most 2 times, "Later" waits 14 days (was 21), and nothing is offered in return
- **Translation consistency:** German now addresses the user as "du" everywhere (36 strings still used "Sie"), Brazilian Portuguese treats Kick as feminine everywhere ("a Kick", 26 strings), Italian calls channel cards "card" instead of "schede" (9 strings)

## v2.5.110 - Store release

- Store release that collects test versions v2.5.88 to v2.5.109 (see their entries below): pause and 1-hour channel mute, "Will this channel notify you?" check, background chat radar, 10 new event sounds with a sound per event, Multi-Stream muted start, single-stream audio and chat drawer, stream-moved alert and auto-tab guard, compact cards, chat filter text cleaning, bot score from Kick's chatter count, Centrifugo backup connection, and fixes (Cloud Sync settings reverting, Multi-Stream players with the kick.com permission, Chrome toolbar card)
- What's New (14 languages): new V0 entry and banner; previous entries shifted (v2.5.87 and v2.5.79 kept)
- New optional permission since the last store version: `*://*.kick.com/*` and `wss://*.kick.com/*` (optional, only requested for the backup connection; not asked on install or update)

## v2.5.109 - Toolbar hover card and text clean-up

- **Toolbar hover card (Chrome):** Chrome now shows its own card when the mouse rests on an extension icon: the extension name, the first lines of the extension's title text and its site access. Our title started with "KickAlert -", a count and an empty line, so the card showed only "KickAlert - 10 live" and the first channel cut off; the full list appeared only when hovering over the card text. On Chrome the title is now one paragraph without the name (the card already shows it): "10 live: Jahrein, CyberRulzTv, Burhi, ..." so the visible lines are filled with channel names, and the full list is still in the tooltip on the card text. With no live channel it reads "No live streams". Firefox shows the whole title in its own tooltip and keeps the line-by-line list
- **Text clean-up:** long dashes and en dashes were replaced with a normal hyphen in every interface string (14 languages), page titles, the test panel, logs, README and this changelog

## v2.5.108 - Channel event sounds match the event

- New installs, and users who never changed their channel event sound, now hear a sound made for each event: incoming raid **Fanfare**, stream ended **Closing bell**, stream moved **Whoosh**, category/title change **Update blip** (set once in "Different sound per event"; the general sound stays as it was)
- Anyone who picked another general sound (Light chime, Tick, Windows sound, Silent, a new sound) or chose a sound for any single event keeps exactly what they had. Applied once per device on install/update (`_evThemed108`), logged as `SND-40`
- Volume, Do Not Disturb, the pause, channel "Silent notification" mode and every per-event menu work as before; any event can be set back to "General sound"

## v2.5.107 - New channel event sounds

- 10 new sounds made for KickAlert (synthesised from scratch, no third-party samples), grouped by the event they are meant for: **Raid** (Fanfare, Drum roll), **Stream ended** (Closing bell, Power down), **Stream moved** (Whoosh, Hop), **Category / title change** (Page flip, Update blip) and two more general ones (Pop, Marimba). Every sound can be used for any event; the groups are only a guide
- Options › Notifications › Channel event sounds: the general sound and each "Different sound per event" row now list the sounds in these groups. The test buttons play the chosen sound at the event volume
- The new files are loudness-matched a little above the old event sounds (−25 LUFS against −27/−28) and stay well below the live alert sound. Existing choices are unchanged; nobody's sound changes until they pick a new one
- Playback now passes the file address to the offscreen player directly, so adding sounds does not need a second list there; Firefox already played `sounds/event_<name>.mp3` directly
- 15 new strings × 14 languages

## v2.5.106 - Multi-Stream: chat drawer

- New **Chat** button in the Multi-Stream top bar opens a drawer on the right with Kick's pop-out chat (`kick.com/popout/{channel}/chat`). A drop-down picks which stream's chat is shown; it starts on the stream that has sound, otherwise the first one, and follows when streams are added or removed. The drawer has buttons to open the same chat in a new tab and to close it
- The chat loads only while the drawer is open. Open/closed state and the chosen channel are kept while the page is open (`multistream.chat`)
- If the browser keeps Kick's sign-in out of embedded pages (for example Firefox's cookie protection), the chat can be read but not written in; a short note under the drawer points to "Open chat in a new tab"
- 6 new strings × 14 languages

## v2.5.105 - Multi-Stream: listen to one stream

- Each stream card has a **speaker button** (shown on hover, next to fullscreen): "Listen to this stream only" turns that stream's sound on and mutes the stream that had sound before; clicking it again mutes it. The card with sound gets a green outline. Kick's player comes from another site, so its sound can not be switched directly; the chosen card reloads with `muted=false` and the previous one with `muted=true` (a 2-3 second reload, the same in Chrome and Firefox). Other cards are not touched, they already start muted. The choice is kept while the page is open (`multistream.audio`)
- The Multi-Stream page now follows KickAlert's language setting: channel field, Add, Clear, layout buttons, card buttons and the empty-page text (14 languages)
- 15 new strings × 14 languages

## v2.5.104 - Multi-Stream players start muted

- **Fix:** Multi-Stream opened every player with `?muted=1`, but Kick's player only recognises `muted=true`, so all streams started with sound at the same time. Players now open with `muted=true`; sound is turned on from the player's own button (or the new listen button in the next version)
- Checked against the live player: `muted=1` → sound on, `muted=true` → muted, `muted=false` → sound on

## v2.5.103 - Background chat radar

- Chat tab › Notifications › **Background chat radar** (off by default): pick up to 5 followed channels and a list of words. While those channels are live, their chat is read in the background through the same connection the bot score uses, even when no Kick tab is open. A notification comes when someone mentions or replies to your username (the one under Tag notification) or writes one of the radar words. Clicking it opens the channel
- The radar stays quiet when that channel's tab is already open (the in-page chat integration notifies there), for your own messages, while notifications are paused or the channel is muted for an hour, and during Do Not Disturb when it mutes notifications and sounds. At most one radar notification per channel per minute for mentions and one for words. Popup and sound follow the existing Chat notification sound settings
- Matching uses the same cleaning as the chat filters (v2.5.101), so disguised spellings are caught and "spammer" does not match "spam"
- Works with bot detection turned off: radar channels are listened to on their own, like raid alerts. Channels can be picked from your followed list; other names are refused with a short note
- Saved inside the chat settings (`chatSettings.radarEnabled`, `radarChannels`, `radarWords`), so it syncs and is backed up with them
- Logs: `RDR-02`…`RDR-05` radar skipped (off, tab open, Do Not Disturb, 1-minute limit), `PAU-14` skipped while paused, `RDR-10` radar notification sent
- 9 new strings × 14 languages

## v2.5.102 - Multi-Stream players work with the optional kick.com permission

- **Fix:** with the optional `*://*.kick.com/*` permission granted (asked for the real-time backup since v2.5.90), every Multi-Stream player showed "This embed seems to be misconfigured". Header rule 1 (`rules.json`) sets `Origin`/`Referer` to kick.com on requests to kick.com; with access to all Kick subdomains it also rewrote the requests `player.kick.com` makes to the Kick API, so their CORS check failed. The rule now skips requests to `player.kick.com` and requests started by Kick's own pages (`excludedRequestDomains`, `excludedInitiatorDomains`). It still applies to KickAlert's own background requests, which is what it is for, so nothing changes for installs without that permission. Kick's own pages now send their normal headers, as without the extension
- Checked in Chromium with and without the permission: Multi-Stream players load and play, background Kick requests and live tracking unchanged

## v2.5.101 - Chat filters see through disguised spelling

- Chat word filter, keyword highlight, repeat filter and tag mentions now compare a cleaned copy of the message, so the usual tricks no longer slip past: full-width or styled letters (ｓｐａｍ, 𝐬𝐩𝐚𝐦), invisible characters (zero-width space/joiner, soft hyphen), Cyrillic/Greek look-alike letters (ѕрам), accents on Latin letters (a filter word "şerefsiz" also catches "serefsiz", "ŞEREFSİZ") and letters split by spaces, dots or dashes ("s p a m", "s.p.a.m")
- Whole-word matching is kept: "spam" still does not hide "spammer", and joining split letters only applies to runs of single letters, so "is pamela" is never read as "spam". Words in other scripts (Russian, Arabic, Japanese…) keep matching themselves exactly as before; accents are removed only from Latin letters
- The cleaning lives in one shared file (`src/textfold.js`), loaded before `chat.js` and in the background, so the upcoming background chat radar uses the same rules
- No new settings or strings

## v2.5.100 - Close auto-opened tabs when the stream moves

- Options › Auto-Launch Settings › **Close auto-opened tabs when the stream moves to another channel** (off by default). When a followed channel moves its viewers to another channel (Kick "host"/raid, `ChatMoveToSupportedChannelEvent`), Kick sends the open tab to the target channel; with this option on, a tab KickAlert opened by auto-launch is closed instead of staying on an unrelated channel (and adding to that channel's watch time). It works whether or not the channel's "Stream moved to another channel" alert is on
- Safe by design: only tabs KickAlert auto-opened are tracked (`_autoTabs`, this device only), and a tab is closed only when it lands on the exact channel named in the move event within 5 minutes. If the event arrives after the tab moved, the tab is checked again after 20 seconds. A tab you moved to another channel yourself, or opened yourself, is never closed and is no longer tracked. With the option off nothing changes
- Synced and backed up (`raidGuardClose`)
- Logs: `RGD-01` tab tracked, `RGD-02` tab moved by the user (left alone), `RGD-10` tab closed after a stream move
- 2 new strings × 14 languages

## v2.5.99 - A different sound per channel event

- Options › Notifications › Channel event sounds › **Different sound per event**: category/title change, stream ended, incoming raid and stream moved can each use their own sound (Soft drop, Light chime, Tick, Windows notification sound or Silent) or stay on "General sound", which follows the setting above. Each row has a test button; the volume is the shared event volume. The section starts collapsed and opens by itself once one event has its own sound. Synced and backed up (`eventSoundByType`). Channel "Silent notification" mode, Do Not Disturb and the new pause still silence these sounds
- The event sound description now also lists stream moved alerts (14 languages)
- 3 new strings × 14 languages

## v2.5.98 - Pause notifications, mute a channel for 1 hour

- **Pause** pill in the popup header (next to Auto and Guard): "For 1 hour" or "Until morning (08:00)", with "Favourites still notify" as an option. While paused, go-live notifications, sounds, auto-launch, channel event alerts (category/title change, stream end, raid, stream moved), viewer anomaly alerts and chat tag/streamer-message alerts all stop; streams that go live are still written to Notification History (marked as paused). The pill shows "Paused · 21:40" in red, the toolbar badge turns red like Do Not Disturb, and "Resume notifications now" ends it. It ends by itself at the chosen time (alarm `kickalert-pause-end`). Stored on this device only (`_notifPause`, not synced)
- **Chrome notification button "Mute for 1 hour"** (was "Mute"): it now mutes only that channel for one hour (`_chSnooze`) instead of permanently switching the channel to "No notification"; the permanent choice stays on the channel's bell. Firefox notifications have no buttons
- "Will this channel notify you?" now also reports a pause (and when it ends), a 1-hour mute from a notification, and a favourite that still notifies during a pause
- Logs: `PAU-01`/`PAU-02` pause set/ended, `PAU-10`…`PAU-13` alerts skipped while paused, `PAU-20` channel muted for 1 hour
- 14 new strings × 14 languages

## v2.5.97 - "Will this channel notify you?"

- The channel settings window (tune button on a card) now opens with a check of everything that decides whether a go-live notification comes from that channel, in the same order the background applies them: the Options notification switch, browser/OS notification permission (Chrome), kick.com access, the channel mode ("No notification" chosen on the bell, or the default mode being "No notification"; "Silent notification" means no sound), Do Not Disturb (active now, or its hours), the category/keyword filter (and whether the stream that is live now passes it), the instant connection (down, or not yet set up for this channel: then the alert comes with the follow-list check 1 to 1.5 minutes late), Kick rate limiting, and the last stream of this channel in History (when, and whether the filter skipped it). The headline says "You'll get a notification" or "No notification will come from this channel" with the reasons first. It updates when you change a switch in the window. Checks run in the background (`DIAG_CHANNEL_NOTIF`); nothing leaves the device
- 21 new strings × 14 languages

## v2.5.96 - Chat notification options only when Chat is on

- Options › Notifications › **Chat notifications** is hidden while Chat Integration is off (it used to show as a greyed-out block). Turning Chat Integration on shows it again, and a "Go to chat notification settings" button appears under the Chat Integration switch: it opens the Notifications group, scrolls to the section and highlights it, so there is no need to scroll back up. Turning Chat Integration off hides both again; the saved chat notification settings are kept
- 1 new string × 14 languages

## v2.5.95 - Compact card layout

- Options › General › **Card layout: Comfortable / Compact**. Comfortable is the v2.5.46 design and stays the default. Compact uses 7 px card padding instead of 12, 4 px between cards instead of 8, a 34 px avatar, no divider line and less space above the button row, and 24 px buttons. A live card goes from 140 px to 106 px high and the title gets about 10 % more width in the two-column popup, so fewer titles and categories are cut off. Applies to Following and Auto-launch cards; synced with Cloud Sync and included in backups (`cardDensity`)
- 3 new strings × 14 languages

## v2.5.94 - Quiet reconnects

- Short connection drops (sleep and wake, Wi-Fi or VPN change, a brief Pusher disconnect) no longer write warnings. With developer mode on, Chrome collected these `console.warn` lines on the extension's Errors page (`BOT-01` timeout, `BOT-02` WebSocket error, `OFF-01` LiveTracker 10 s timeout), so a PC left on for days showed "errors" although every reconnect had worked. They are now debug lines; a warning is written only when the browser is online and LiveTracker or BotTracker has not reconnected for 5 minutes, once per outage. When the connection comes back after such an outage, `BOT-04` / `OFF-06` log how long it was down
- While the browser reports no network (`navigator.onLine` false) LiveTracker, BotTracker and the Firefox Pusher client stop retrying every 30 s and reconnect immediately on the browser's `online` event (with a 5-minute fallback retry in case that event never comes)

## v2.5.93 - Kick compatibility check

- New test panel scenario **Kick compatibility**: asks Kick which realtime servers it offers (Pusher key, Centrifugo address), shows the active connection, the backup permission and the silence watchdog state, checks the chat-settings and active-chatter endpoints and the channel object (`playback_url`, chat room) on a live followed channel, and, when a channel tab is open, the chat DOM KickAlert's chat features rely on (`#chatroom-messages`, `[data-index]`, username buttons, `data-chat`). Any failing item is also logged as `CMP-01`

## v2.5.92 - Stream moved to another channel

- New per-channel option **Stream moved to another channel** (channel bell, off by default). When a followed streamer sends their viewers to another channel with Kick's host feature, Kick publishes `ChatMoveToSupportedChannelEvent` on `channel.{id}` (payload `hosted`: slug, username, category, viewers, taken from Kick's own "Join host" dialog code). KickAlert already listens to that channel for go-live alerts, so no new connection is opened. The alert says "X moved the stream to Y" with Y's category and viewer count and opens Y when clicked; it is kept in History. Same host and target are alerted once per 10 minutes; Do Not Disturb and the channel's "No notification" choice are respected. Chrome (offscreen) and Firefox (background page), Pusher and Centrifugo
- 4 new strings × 14 languages, proofread

## v2.5.91 - Bot score from Kick's own chatter count, all chat modes

- **Score from the first minute, without the WebSocket.** Kick now publishes its own active-chatter count (`web.kick.com/api/v1/channels/{id}/chat/active-chatters`, no login, 60 s cache). The background reads it for live channels (at most 12 per minute, each at most once a minute) and passes it to the score. While our own 5-minute count is not mature (first 5 minutes, connection down, or no chat events for 5 minutes) the score uses Kick's count scaled to our scale; once ours is mature, ours is used and the ratio between the two is learned per channel. Default ratio 0.33, measured on 8 channels with 2,800 to 47,000 viewers over 17 minutes (104 samples, quartiles 0.29 to 0.39). The tooltip says "Kick: N active chatters" when Kick's count was used
- **All chat modes.** Chat modes now come from the same settings endpoint Kick's chat uses (`/chat/settings`), falling back to the channel object: slow mode, subscriber mode, and new followers-only (with minimum follow time), emote-only and minimum account age. Live ChatroomUpdatedEvent updates them too. Followers-only lowers the expected chatters by 10 % (20 % above 10 minutes), account age by 5 % (both ignored when subscriber mode is on), emote-only by 30 %. The v2.5.89 watchdog now really skips emote-only channels
- These web.kick.com requests never touch the follow-list Cloudflare backoff: on any error they pause for 10 minutes (`WEB-01`)

## v2.5.90 - Centrifugo backup connection

- **Backup when Pusher goes quiet.** Kick's site runs on its Centrifugo server and still publishes the same events to Pusher. KickAlert now has an adapter (`KACentrifugoSocket` in `pusher-config.js`) that speaks Centrifugo but looks like a Pusher socket to LiveTracker, BotTracker and the Firefox Pusher client, so all go-live, stream-end, raid and chat-count code runs unchanged on either server. It gets a guest token from `web.kick.com/api/v1/realtime/auth/connection` (45 min, refreshed before expiry), subscribes to the same channel names and turns Centrifugo publications into Pusher-style events
- **When it switches:** Kick stops offering Pusher (`PSH-13` → switch), or the v2.5.89 watchdog sees all busy channels silent for 10 minutes even after re-asking Kick (`PSH-23`). It stays on Centrifugo for at least 6 hours, then the normal 12-hour refresh tries Pusher again; a forced re-ask (silence, permanent error) also goes back to Pusher. Failed attempts are at least 5 minutes apart (`PSH-25`)
- **New optional permission `*.kick.com`.** Centrifugo refuses connections whose Origin is the extension, so a new DNR rule (rules.json id 2) sets Origin `https://kick.com` on `platform.kick.com/connection/websocket`; that needs host access to the Centrifugo server. The permission is optional and is not asked on install or update. The permission band and the guide ask for it only when the backup is needed (`_rtFallbackNeeded`, `PSH-24`, logged once); Options › Extension permissions always lists it. Granting it while the backup is needed switches at once. The flag clears when Pusher is healthy again
- Watchdog log lines name the active server (Pusher or Centrifugo)
- 4 new strings × 14 languages, proofread

## v2.5.89 - Pusher silence watchdog

- Kick's own site now takes chat from its Centrifugo server and publishes the same events to Pusher in parallel (measured 16.10.2026). If Kick ever stops publishing to Pusher, the connection stays open (pongs keep arriving) but no events come, and the existing PSH-13 check (Pusher no longer offered) does not notice. BotTracker now records when each chat room last delivered a message; the background checks once a minute: on live channels with at least 500 viewers, tracked for 5 minutes and not in subscriber-only mode, if none delivered a chat event for 5 minutes → `PSH-20` warning and an immediate re-ask of Kick's realtime settings; if only some are silent → `PSH-21` (a per-chat-room move); recovery → `PSH-22`. State in `_rtHealth` for the test panel. Same code on Chrome (offscreen) and Firefox (background page)

## v2.5.88 - Settings changed in the popup no longer revert (Cloud Sync)

- **Settings reverted after an update or browser restart (Cloud Sync on).** The storage module keeps a "Cloud Sync is on" flag per page; only the background page ever filled it. In the popup it stayed false, so every change made there (Chat tab: tag notification, username, streamer messages, filters; and other popup settings) was saved on this device only and never reached the browser account. On the next fresh session (update, browser start) the background pulled the old cloud copy and overwrote the newer local settings. The v2.5.45 fix only worked for writes made from the background. Now every page reads the flag from storage on first use and follows changes to it. "Sync now" in the popup works again (it returned "disabled" before)
- **One-time repair on update:** the first fresh session after updating to this version writes this device's settings to the cloud instead of pulling the stale copy (`_syncLocalWins`, `SYNC-02`). Later sessions pull as before
- `SYNC-01` log names any setting a cloud pull changes on this device

## v2.5.87 - Store release

Store release of v2.5.82 to v2.5.86 (ad-domain blocking fix, no black screen at stream end, bot score chat modes, Firefox permission window, welcome screen, Options › Extension permissions, permanent permission reminder). Code unchanged from v2.5.86; only the What's New banner and the Release History title are updated in 14 languages.

## v2.5.86 - Welcome screen, permission status in Options, reminder that stays

- **Welcome on first install.** After a fresh install (`onInstalled` reason `install` sets `_welcomePending`), the first popup opening shows a welcome dialog in front of the channel list: what KickAlert accesses and why (kick.com and the Kick session, instant connection web.kick.com + ws-us2.pusher.com, notifications and tabs, optional ad blocking), with a check mark on access that is already granted and the line "does not look at other sites, read your browsing history or see your password". Continue asks only for the missing permissions in one browser prompt (Chrome: over the popup; Firefox: the small KickAlert window); nothing missing goes straight to "You're all set". Not now closes it for good. Ad blocking is not switched on from the welcome screen, so the experimental-risk confirmation stays the only way to turn it on
- **Permission reminder no longer disappears.** The band above the channel list now shows on every popup opening while kick.com, web.kick.com, ws-us2.pusher.com (or the ad domains with ad blocking on) are off, not only after the update guide. Closing it hides it for the browser session (`storage.session`). It updates live when a permission is removed or granted while the popup is open. When only the ad-domain permission is off it says so instead of warning about alerts
- **Options › Extension permissions.** New section listing each permission with On/Off and a Turn on button (Chrome: asks inside the popup; Firefox: the small window, for that permission only). The ad-domain row appears when ad blocking is on
- Firefox window: `permtab=all` (guide, welcome) asks for every missing permission, any other value only for that permission
- `<html lang>` follows the chosen language, so upper-case headings are spelled correctly (Turkish "EKLENTİ İZİNLERİ")
- 21 new strings + 1 release-history bullet × 14 languages, proofread

## v2.5.85 - Firefox: one-click permission window

- The Firefox permission window no longer repeats the step-by-step guide (the popup already explained each permission). It shows one button that opens Firefox's own prompt and asks for every missing permission in a single request: all permissions that are off when coming from the guide, only the ad domains when coming from the Ad Blocking confirmation. When Firefox grants them the window shows "Thank you" and closes after 3 seconds; if the user declines, a note is shown and the button can be pressed again; "Not now" closes the window at once and leaves the reminder band. Window height 620 px so the longest list (10 hosts) fits. 4 new strings × 14 languages, proofread
- Log: `TOK-01` (session cookie) is written only when the cookie changes, not on every Kick request (it appeared about 5 times per check)

## v2.5.84 - Firefox: permission guide in a small extension window

- The Firefox permission request (v2.5.83) now opens in KickAlert's own small window (`windows.create`, type popup, centred on the browser window, same method as the backup window since v2.5.41) instead of a new browser tab. The window shows only the guide and closes itself 3 seconds after Finish. Falls back to a tab if a window cannot be created. Chrome unchanged

## v2.5.83 - Firefox: permission prompts work

- **Firefox permission prompt did nothing.** On Firefox, `permissions.request` called from the toolbar popup opens the browser's prompt and the popup closes; the page that asked is gone, so "Allow" had no effect (tested by Patron, 14.10.2026). This affected the permission guide (kick.com, web.kick.com, ws-us2.pusher.com, ad domains) and the ad-domain permission when turning Ad Blocking on. On Firefox the request is now made from a normal tab that shows the same guide (`popup.html?permtab=<step>`, starting at the step the user clicked); the tab stays open while the prompt is shown and closes itself 3 seconds after Finish. Chrome is unchanged (its prompt does not close the popup)
- Opening the permission tab does not count as a popup opening for the rating reminder

## v2.5.82 - Ad domain blocking really works, no black screen at stream end, better bot score

- **Ad domain rules were never applied.** With `declarativeNetRequestWithHostAccess` every rule, block rules included, needs host permission for the request URL; KickAlert had none for the ad domains, so `ruleset_ads` matched nothing (verified in Chromium: a kick.com control rule blocked, doubleclick/googlesyndication loaded; with host access added both were blocked). The ad domains are now `optional_host_permissions`; they are requested inside the click that turns Ad Blocking on (the confirmation shows a note first), and the permission guide offers them after an update to users who already had Ad Blocking on. `initiatorDomains: kick.com` keeps the rules Kick-only; `media` and `other` request types added. Same approach as MoKick
- **Black screen at stream end:** Kick opens a black postroll layer and closes it only on `ADS_MANAGER_LOADED` or `AD_ERROR`. The IMA stub's `requestAds` now answers asynchronously with `AD_ERROR` (1009 / VAST 303) to its listeners, as the real SDK does on no fill (PureKick 10.24 does the same). CSS hide kept as a backstop
- **Bot score:** chat modes (slow mode + interval, subscriber-only) are read from `/api/v2/channels/{slug}` when a channel starts being tracked (30 min cache in storage.local); live `ChatroomUpdatedEvent` still wins. Subscriber-only and slow-mode multipliers are combined. The misleading "MoKick formula" comment now describes the real calculation
- **Raid:** viewer count, raider and message also read from a nested `message` object
- **Worker fallback:** `/api/v2/channels` request has a 2.5 s timeout; the ad-free master is prefetched only after the worker sees an ad master (no wasted request when the page-level swap works); the ad monitor skips polls while the tab is hidden
- **Real-time:** explicit PSH-13 warning if Kick stops offering Pusher. Kick's Centrifugo server rejects extension origins (tested 14.10.2026), so no Centrifugo fallback
- 5 new strings × 14 languages (proofread); Release History bullets; privacy policy and README list the optional ad-domain permission

## v2.5.81 - Bot score on Firefox, permission guide

- **Bot score on Firefox.** Until now Firefox ran the chat connection in raid-only mode and never computed bot scores (`syncBotTracker`: `raidOnly = !enabled || !hasOffscreen`). Firefox now computes and stores scores exactly like Chrome; BotTracker runs in the background page, scoring goes through the existing local `BotTrackerHost` path. Verified against live Kick chat (152 messages/min, 117 chatters → score stored)
- **Permission guide after updates.** Firefox does not ask for or grant host permissions added in an update (Firefox bug 1893232), and Chrome users can withhold site access. After an update the popup now shows only the site permissions that are off (kick.com required; web.kick.com and ws-us2.pusher.com recommended), one step each: why it is needed, what happens when it is off, and a switch that opens the browser's own permission prompt (`permissions.request`, inside the click). Finish shows "Thank you" or the permissions still off, then closes after 3 seconds; skipped permissions leave a small reminder band above the channel list (closable). If Firefox closes the popup while the prompt is open, the next popup opening continues. All texts in 14 languages, proofread by a separate reviewer
- Background reacts to newly granted permissions: web.kick.com → asks Kick for the current Pusher key right away; ws-us2.pusher.com (Firefox) → reconnects immediately
- BotTracker no longer logs "Shutdown" on every check when it was not running
- What's New banner and Release History (v2.5.81, v2.5.79, v2.5.77) in 14 languages

## v2.5.80 - Firefox: requests through the open Kick tab work again

- Firefox: the content script relays API requests through an open kick.com tab ("Plan C", used when background requests are blocked by Cloudflare). Copying the response headers with `headers.entries()` threw "is not iterable" in Firefox, so every relayed request failed and fell back to the background request. Headers are now read with `forEach` (with a per-header fallback). Chrome was not affected
- Confirmed on Firefox: with the `ws-us2.pusher.com` permission off the real-time connection does not come up; with it on it connects. The permission is needed

## v2.5.79 - No double scrollbar in the popup

- Settings: the hidden radio inputs of the anomaly alert options were `position: absolute` without a positioned parent, so they escaped the Settings scroll area and stretched the popup page by about 2,300 px. The popup showed a second (outer) scrollbar and a long empty area below the footer (reported on Firefox). `.options-body` and `.opt-radio-row` are now positioned
- The channel list area had a fixed 480 px height; with the What's New or "channel alerts off" banner visible the popup grew past its 600 px limit and showed an outer scrollbar (Chat tab, long channel lists). The list now shrinks to the space left under the header and banners (240 to 480 px) and follows banner changes
- Store links (Rate, Source) detect Firefox with `getBrowserInfo` as well; the Firefox manifest also carries a `service_worker` key, so the old check alone was not reliable
- Release History: v2.5.79 entry

## v2.5.78 - Store release: real-time alerts work again after Kick's Pusher change

- **Cause:** Kick shut down the Pusher app KickAlert connected to (`32cbd69e4b950bf97679`). Every connection was rejected with `4001 App key not in this cluster`, so instant live alerts, raid alerts and chat-based bot scores stopped (live alerts still arrived through the regular check, about 1 to 1.5 minutes late). Kick's own website now asks `web.kick.com/api/v1/realtime/connection` which app to use
- New `src/pusher-config.js` (`KAPusherCfg`): one shared Pusher key/cluster for the offscreen LiveTracker, BotTracker and the Firefox Pusher client
- Background asks Kick for the current app (same request body as Kick's web client, random one-time id, no cookies), caches it for 12 hours (30 minutes after a failure) and falls back to the last good key, then to the built-in key `34bf7a0ff419a2a775b9`. The key reaches the offscreen document with every sync message
- On a permanent Pusher error (4000-4099) trackers no longer retry every 30 seconds: they report it, the background asks Kick again (at most every 10 minutes) and resends the key if it changed; the same key is retried after 15 minutes. The warning is written once per key instead of on every retry
- When the key changes, connections are rebuilt and subscriptions restored; old sockets can no longer trigger reconnects after a restart
- `html/offscreen.html`: added `<meta charset="UTF-8">` (Turkish characters in offscreen warnings were garbled, e.g. "kalÃ±cÃ±")
- New host permission `https://web.kick.com/*`. Chrome asks users to approve it after the update
- Privacy policy and README updated; What's New banner and Release History (v2.5.78, v2.5.77, v2.5.76) in 14 languages

## v2.5.77 - Store release: accurate category and title change alerts

- Category/title change alerts are now compared with the value you were last told about, not with the previous check. Previously a change made during the 5-minute wait after an alert was silently dropped, and a single inconsistent reading from Kick's followed-channels endpoint (the old category coming back for one check) produced a reversed alert such as "Just Chatting → Arkheron" while the stream was actually in Just Chatting
- A new category or title must be seen in two consecutive checks (at least 20 seconds apart) before it is announced; a one-off reading that flips back is ignored. This adds one check interval of delay (about 1 to 1.5 minutes with default settings)
- A change confirmed during the 5-minute wait is no longer lost: it is announced when the wait ends, unless the channel went back to the announced value in the meantime
- Changes that happen while Do Not Disturb, a channel mute or notifications-off is active are not delivered later as stale news; turning on change alerts in the middle of a stream does not announce older changes
- A category alert still covers a simultaneous title change (one alert, as before)
- Test panel: channel events scenario follows the two-reading flow; the change tracking table shows the announced value and any pending candidate
- Store release. What's New banner and Release History updated in all 14 languages (v2.5.77 entry added; v2.5.76 and v2.5.67 kept, v2.5.46 dropped)

## v2.5.76 - Confirmation buttons fit in every language

- Confirmation dialog buttons (Enable Ad Blocking, Reset Everything, Apply to all channels) no longer overflow in longer languages: the fixed button height was removed, text wraps cleanly, and when a label does not fit on one line the two buttons are stacked full width (primary on top). Measured in all 14 languages; previously 9 labels overflowed (English, German, French, Russian, Japanese, Korean, Czech, Slovak)
- Release History: v2.5.76 entry

## v2.5.75 - Store release: ad blocking works again, quieter start for new users

- Store release covering v2.5.68 → v2.5.74 (see the entries below)
- Ad diagnostics collector address built in (sharing still off by default)
- What's New banner and Release History updated in all 14 languages

## v2.5.74 - Channel alerts off on new installs, apply to all channels, ad diagnostics

- New installs: channel alerts start off ("No notification"). A one-time banner explains how to turn on channels from the bell on their card or all at once in Options. Updating users keep their current behaviour exactly ("Silent notification" default as before)
- Options → Notification Settings: "Default channel alert" (used by channels without their own bell setting and by newly followed channels), "Apply to all channels" with confirmation and a 24-hour Undo, plus a pointer to Do Not Disturb for silencing only at certain hours
- With the default set to "No notification", channel-specific choices you made still work: per-channel auto-open and channel alerts (category change, stream end, raid) keep firing; a mute chosen from a channel's bell (or "Apply to all → No notification") still silences everything for that channel
- Importing an older settings file or pulling cloud data from an older device keeps its original meaning (silent notification default)
- Ad blocking: console lines are colour-coded with their ADB code; ad breaks and unknown stream markers are kept in a small local log (test panel → Ad diagnostics: copy, download, clear)
- Optional, off-by-default "Share ad diagnostics" (Options → Ad Blocking): sends a cleaned technical summary (no channel names, addresses or account data) to the developer's Google Apps Script. Firefox asks for the "technical and interaction data" permission. Privacy policy updated
- `#EXT-X-TWITCH-LIVE-SEQUENCE` (seen after ad breaks) is a known marker and no longer raises a diagnostic warning

## v2.5.73 - Turkish ad format confirmed and recognised

- First live ad break caught in Turkey (03.10): Kick's ads arrive as Amazon IVS stitched ads (DATERANGE classes `live-video-net-stitched-ad-break-start` and `live-video-net-stitched-ad-creative-start`, with `#EXT-X-DISCONTINUITY`). The player stayed on the ad-free stream and the watcher logged ADB-12
- These markers are now known: they no longer raise the ADB-16 diagnostic warning, and the ADB-12 line names the exact ad marker

## v2.5.72 - Server assignment marker marked as known

- The `live-video-net-assignment` DATERANGE seen once per channel in Turkey was confirmed from its full line (serving id, node, cluster) to be a server assignment, not an ad; it no longer triggers the ADB-16 diagnostic warning

## v2.5.71 - Fuller diagnostic samples

- Diagnostic samples of the ad watcher now keep DATERANGE lines in full (segment addresses stay shortened), so the attributes of an unknown marker can be read from `window.__ka_ab_adMonSamples`

## v2.5.70 - Ad watcher diagnostics

- The live ad watcher now reports its own health: `window.__ka_ab_adMonStatus()` in the page console shows checks, successes, errors, address refreshes, caught ad breaks and any new markers; a summary line (ADB-15) is logged about every 10 minutes
- Any tag or DATERANGE class not seen in normal Kick live playlists is logged once (ADB-16) and a short excerpt is kept in `window.__ka_ab_adMonSamples`, so an ad format Kick uses in a specific region can be identified without watching the ad
- Ad detection now also checks IVS prefetch lines (long dna parameter, foreign host)

## v2.5.69 - Ad break detection for live streams

- Since the player now opens the ad-free stream from the start, ads never reach it, so nothing showed that an ad had been blocked. A lightweight watcher now checks only the text playlist of Kick's ad-carrying stream every 10 seconds (no video is downloaded) and logs "ad break started, blocked" (ADB-12) and "ad break ended" (ADB-13) in the console and the test panel activity log
- The watcher refreshes Kick's 10-minute stream address automatically, stops when you leave the channel or turn ad blocking off, and never touches playback

## v2.5.68 - Live ad blocking adapted to Kick's October change

- Kick started returning live stream addresses that carry server-side ad parameters (MediaTailor) again. The ad-free address is now swapped in at page level, before the player even sees the playback response, so the player opens the ad-free stream from the start. The earlier player-worker swap stays as a backup
- Safety: the swap is applied only when both addresses point to the same stream (identical path, only the token differs); on any error or after 2.5 seconds the original response is used and playback continues
- Past broadcasts: Kick's new MediaTailor VOD session is redirected to the ad-free original recording after verifying it is a real video manifest
- The player worker no longer swaps a stream that is already ad-free, so the blocked-ads counter is not counted twice

## v2.5.67 - Store release: per-channel alerts, watch time and fixes

- Store release covering v2.5.48 → v2.5.66 (see the entries below)
- What's New banner and Release History updated in all 14 languages

## v2.5.66 - Cloud Sync no longer undoes imports or loses large settings

- With Cloud Sync on, importing a settings file (and "Reset to defaults" / "Undo import") only changed this device; the old copy in your browser account came back on the next browser start and silently reverted the imported settings, including per-channel alerts, sound modes, favourites and auto-open channels. These actions now update the cloud copy too
- Browser sync allows at most 8 KB per setting. A setting over the limit (for example channel alerts with filters on very many channels) failed to sync silently, and on the next browser start the older cloud copy overwrote the newer one on this device. Such settings are now kept on this device and never overwritten, the other settings still sync, and Settings → Cloud Sync shows which setting is too large
- A setting that could not be written to the cloud (offline, rate limit) is retried automatically and is not overwritten by the cloud copy in the meantime

## v2.5.65 - Critical: Windows sound and buttons on Chrome 148+

- Root cause of the Windows notification sound playing with extension sounds found and fixed. Since Chrome 148, Chrome also exposes the `browser` namespace that the extension used to detect Firefox, so on current Chrome it treated itself as Firefox: notifications (live alerts, channel events, chat tag/streamer messages) were created without the "silent" flag and without the Open / Mute buttons. Firefox is now detected with a Firefox-only API, so in "Extension sounds" mode Windows no longer adds its own sound, and the notification buttons are back
- The note about turning off the Windows sound in system settings is now shown only in Firefox, which cannot request silent notifications

## v2.5.64 - Windows sound option for channel event alerts

- Channel event sounds now have five choices: Soft drop, Light chime, Tick (extension sound, system sound off), Windows notification sound (only the system sound, no extension sound) and Silent (no sound at all). The Windows option has its own Test button that sends a sample notification
- Silent now also asks the system for a silent notification; Do Not Disturb "Mute sounds" and a channel's "silent" setting silence the Windows option too
- Added a note in Settings: if Windows still plays its own sound with an extension sound or Silent, turn off "Play a sound when a notification arrives" for the browser in Windows notification settings (Firefox cannot request silent notifications at all)

## v2.5.63 - Quieter sound for channel event alerts

- Category/title change, stream ended and raid alerts no longer use the system (Windows) notification sound, which was louder than the live alert. They now have their own quieter sound, chosen in Settings → Channel event sounds: Soft drop (default), Light chime, Tick or Silent, with a separate volume slider and a Test button
- The event sound follows Do Not Disturb ("Mute sounds") and a channel's "silent" sound setting; muted channels still get no event alerts at all
- The new sounds are original, generated for KickAlert (no third-party audio), about 5 dB quieter than the live alert before the volume slider

## v2.5.62 - No error after extension updates

- After the extension was updated or reloaded, kick.com tabs that were already open kept the old page script, which reported "Extension context invalidated" in chrome://extensions → Errors (seen on channel pages with ad blocking logs). The old script now notices the extension was replaced and stops quietly. Refreshing those tabs loads the new version as before

## v2.5.61 - Developer test panel

- Internal test panel redesigned (tabs, live flow, log filter/copy) and extended with checks for every feature added since v2.5.48: per-channel change / stream-end / raid alerts, channel filters, watch time, review prompt conditions, raid listener status, settings integrity and all 14 languages. No change for users

## v2.5.60 - Category/title change alerts actually track

- Category and title change alerts never fired, and the channel alerts window kept saying "Tracking starts when the channel goes live" even for channels that had been live for hours. The followed-channels list Kick returns has no stream start time, and the tracker skipped every channel without one. Channels are now tracked as long as they are seen live; the start time is fetched once per stream only for channels with change or stream-end alerts on, so stream-ended alerts also show the stream length more reliably

## v2.5.59 - Tracking status line readable

- The "Now: category · checked Xm ago" line in the channel alerts window was cut off with "…"; it now wraps and is slightly larger

## v2.5.58 - Stream-end details, raid viewer count, change-alert checks

- Stream ended alerts arrived without length or title ("-"): the category/title tracker removed a channel's last info (start time, title) the moment it went offline, just before the stream-end check looked for it. That info is now kept for 3 hours after a channel goes offline, so the alert shows "Streamed for 2h 5m · title" again. If nothing is known, the category (or Kick.com) is shown instead of "-"
- Raid alerts could show "? viewers": Kick sends two events per raid and one may have no viewer count. The first event now waits 4 seconds and both are merged into a single notification
- Category/title change alerts: comparisons were skipped when the last fresh check was more than 15 minutes old (e.g. after Cloudflare blocks); now 60 minutes, the same-stream check still prevents mix-ups. The channel alerts window now shows what the extension last saw for that channel ("Now: Just Chatting · checked 3m ago"), and each check is logged (CHG-05…CHG-08) in the background console

## v2.5.57 - Card buttons always fit

- Following cards: with channel groups defined a card has six buttons, and in the two-column popup the last one (favourite star) was cut off. The buttons are now one group, slightly tighter, and fit on one line in the usual popup width; if a card is ever too narrow, the whole group moves to a second line instead of being cut
- The new channel-alerts icon used a different icon class and rendered larger than the others; all card icons are now the same size (the group icon too)

## v2.5.56 - Large preview on hover

- Hovering a channel preview image for a moment shows it large with the title and category. Uses the image already loaded (no extra request); only when Channel Preview Images is on

## v2.5.55 - Watch time and weekly summary

- New: counts how long you watch each channel while a Kick tab is playing (VOD/clip pages and silent background tabs are not counted; the same channel in two tabs is counted once). Stored only on this device, kept for 35 days
- History tab shows the last 7 days: total, change vs. the 7 days before, and the top 3 channels
- Can be turned off in Settings → Additional Features → Watch time (on by default)

## v2.5.54 - Raid alerts (opt-in per channel)

- New per-channel option: notification when another streamer raids a followed channel, e.g. "Mithrain raided Eray · with 842 viewers", plus a History entry
- Uses Kick's StreamHostEvent / StreamHostedEvent on the channel's chatroom through the existing bot-detection connection; if bot detection is off, only channels with raid alerts on are listened to (no scoring). The raw event is logged as RAID-00 so the field names can be checked against a real raid
- One raid notification per channel per 10 minutes (the two events Kick sends for one raid never produce two notifications)
- Firefox: the chat connection module is now loaded in the background in raid-only mode (no bot scores on Firefox, same as before)

## v2.5.53 - Stream ended alerts (opt-in per channel)

- New per-channel option: notification when a stream ends, with how long it lasted, plus a History entry
- Two-stage confirmation: a Pusher end event or fresh API data only makes the channel a candidate; the alert goes out when fresh API data still shows it offline about 2.5 minutes later. Fallback (cached) data never counts as an end, a channel that comes back cancels the candidate, and nothing is sent retroactively after the browser was closed

## v2.5.52 - Review request for active users only

- A one-line request to leave a store review, shown only when all of these are true: used for at least 7 days, at least one channel preference set, at least one setting changed, popup opened at least 10 times, at least 3 live notifications received
- "Maybe later" waits 21 days; shown at most twice; "Leave a review" or × never shows it again. Never shown together with the What's New banner. Stored only on this device

## v2.5.51 - Stronger live ad-block fallback

- Clarification: live streams already switch to Kick's own ad-free (ads-opt-out) playlist since v2.3.18; that stays the primary method
- New third fallback adapted from Kick Ad Blocker - AI Chat: Amazon IVS labels every segment's source ("live" for real content). Segments with a different source (and their ad init segment) are removed, which also catches ad breaks without SCTE-35 CUE-OUT markers. Only applied when the playlist uses these labels and real content remains

## v2.5.50 - Per-channel category / keyword filter

- New per-channel filter: notify only if the category is one of a list and/or the title contains one of your words. Applies to the notification, sound and auto-launch; the stream is still logged in History with a "Filtered" tag
- Matching ignores case and accents and handles Turkish İ/ı ("İSTANBUL" matches "istanbul"); category suggestions come from the channels you follow
- If Kick's live event arrives without a category and a category filter is set, the category is looked up for that channel only; if it is still unknown, the notification is not blocked

## v2.5.49 - Channel alerts window and category / title change alerts

- New button on channel cards (tune icon) opens a per-channel alerts window; everything in it is off by default and the button turns green when something is set
- New per-channel option: notification when a live channel switches category or changes its title. Only with fresh API data, only within the same stream session, both old and new values must be present, at most one change alert per channel per 5 minutes

## v2.5.48 - Settings no longer cut off in longer languages

- Settings groups were measured once when opened and kept that pixel height; switching language (or any text that grew later) pushed the bottom of a group out of view, e.g. the "Reset Everything" button in German and Japanese. Groups now only use a fixed height during the open/close animation and grow freely with their content afterwards
- Text written by the popup itself now follows a language switch right away: last backup line, custom sound status, History day headings, anomaly sensitivity labels ("Warn" / "Alert")
- Translated the remaining fixed English text: Settings title, "Source Code" and "Rate Extension" links, the Auto / Guard header pills, the "Sort:" label and the "sec" unit, in all 14 languages
- Japanese: auto-launch is now "自動オープン" instead of "自動入場"

## v2.5.47 - Two small fixes found while refreshing the store images

- Tab labels no longer get clipped when a counter is shown next to a long label (e.g. "Notification History"); each tab now takes the width its label needs and long translations wrap instead of being cut off
- The viewer trend window showed its time span in Turkish ("29dk", "1s 20dk") in every language; it now uses the same "29m" / "1h 20m" format as the channel cards

## v2.5.46 - Visual refresh

A restyle of the popup. Every existing feature, setting, id and class that the
code depends on was kept; the new look is a separate design layer at the end of
`popup.css` plus a handful of small, isolated script changes.

### Fonts & privacy
- Fonts (Geist, Geist Mono) and Material Icons are now bundled inside the extension (`fonts/`, `css/fonts.css`) instead of being loaded from fonts.googleapis.com on every popup open. Icon names no longer appear as plain text ("play_arrow", "settings") on slow or offline connections, and the popup, backup page and multi-stream page make no requests to Google anymore. The content security policy no longer allows Google Fonts. Material Icons ship as the full font files (subsetting strips the ligature tables and breaks icons)
- Replaced the one icon the bundled font doesn't have ("monitoring", viewer anomaly detection) with "query_stats"

### Look & feel
- Design tokens: one type scale, three corner radii, a spacing scale and semantic colours (success / warning / danger / info) for both themes, replacing roughly 20 hard-coded colours
- Header: Auto and Guard are status pills with a dot instead of an ON/OFF block; Refresh, Multi, Options and Kick are icon buttons on the right (tooltips unchanged)
- Tabs are a segmented control with counters: live channels on Following, new notifications on History (cleared when you open the tab)
- Channel cards: live ring around the avatar, category as a chip, monospace numbers, lighter action buttons
- Auto-launch: "Live" and "Offline" section labels (hidden while searching if a section has no matches)
- History: single column grouped into cards; identical notifications from the same channel within 15 minutes are merged into one row with a "×2" marker; the "-" placeholder for a missing category is no longer shown; new entries get a dot
- Chat tab: filters grouped under Filters / Highlight / Notifications, each row with an icon and a description that stays visible
- Settings: flat rows inside one card per group instead of nested cards; every checkbox is now the same switch as the rest (a CSS selector typo meant these were rendering as unstyled browser checkboxes); radio groups are segmented controls
- New "System" theme option that follows the OS light/dark setting
- Sound-mode icons: speaker icons for main / secondary / silent, and a crossed-out bell for "no notification" (previously a red block icon that looked like an error)
- Skeleton cards while the channel list loads, and an icon on empty states
- Visible keyboard focus everywhere, and animations are turned off when the OS "reduce motion" setting is on

## v2.5.45 - Critical: Cloud Sync silently reverting Chat tab settings

### Cloud Sync / Storage
- **Root cause found and fixed for a real data-loss bug**: users with Cloud Sync enabled could see their Chat tab settings (filters, tag notification, etc.) silently revert to an old or default state hours later, with zero interaction. Cause: `setChatSettings`/`updateChatSetting` wrote straight to local storage without ever refreshing the cloud copy, so the cloud side stayed stale (often empty). Meanwhile, every service-worker wake-up (roughly once a minute, driven by the periodic live-check alarm) unconditionally re-pulled from the cloud and overwrote local storage with that stale copy - no merge, no timestamp check. Other settings (favorites, channel groups, etc.) were unaffected because they already pushed to the cloud on every change.
- Fix has two parts: (1) Chat tab settings now mirror to `chrome.storage.sync` immediately on every write, exactly like other synced settings; (2) the automatic cloud pull no longer runs on routine background wake-ups - it now only runs on a genuine new session (browser start or extension install/update), which is the only time it was ever meant to run.
- Fixed the same class of bug for the Chat tab's on/off switch (`setChatIntegrationEnabled`), which had the identical direct-write bypass.
- Also fixed a small inconsistency: the Chat tab's content-script default settings object used a different default emoji-spam threshold (10) than the popup's (5) - unified to 5.

## v2.5.44 - Store listing refresh

### Store listing
- Rewrote the extension name and short summary (shown as the Chrome Web Store title/summary, sourced from manifest.json) across all 14 supported languages to lead with "Kick.com" and the core value proposition, while keeping the brand's tone
- No code changes in this release

## v2.5.x - Ad-block hardening, VOD improvements, settings redesign

### Storage / data integrity
- Fixed the same lost-update race found in the Chat tab's settings across the rest of the extension: favorite channels, per-channel sound mode, channel groups, the auto-open list, the chatroom/channel ID cache, bot scores, and notification history all updated their shared storage entry by reading it, changing one field, and writing the whole thing back - if two of these fired close together (rapid-clicking multiple favorite stars, opening two Kick tabs at once, several followed channels going live together) the slower write could silently overwrite the faster one's change with stale data. All of these now go through the same per-key write queue as the Chat tab fix, so concurrent updates to the same storage entry can no longer clobber each other

### Chat integration
- Fixed the Chat tab's Kick username field (used for @mention detection) silently failing to save if you typed it and then clicked away or closed the browser within half a second - the save was debounced by 500ms, and closing the extension popup destroys that pending timer along with the unsaved value. It's now also flushed immediately when the popup loses focus or closes, in addition to the debounced save while typing
- Fixed a rare but real data-loss bug in the Chat tab: any two settings changed in quick succession (e.g. typing your username right after toggling a filter, or clicking two toggles fast) could race against each other, since each save read-modified-wrote the whole chat settings object independently - the slower one could silently overwrite the faster one's change with stale data. All chat-tab settings writes are now serialized so this can no longer happen
- Adapted three settings from Mo'Kick's more granular notification options, kept summarized: an independent "show a notification popup" toggle (separate from sound - you can now have sound without a popup, a silent popup, both, or neither, with the message still highlighted in chat either way), and "smart mode" now also detects when Kick's own chat panel itself is hidden (theater/fullscreen), not just tab-hidden or scrolled
- Skipped Mo'Kick's "covered by another element" condition - it's specific to their own injected overlay UI and has no equivalent in our architecture
- Repositioned the "Chat Notification Sound" section right after the main Notification Settings (previously separated by Do Not Disturb) and rebuilt it to match the rest of Settings exactly: a toggle switch in the section header (identical to Do Not Disturb's), a standard checkbox for the "smart mode" sub-option, and the same disabled-state styling used throughout - the whole section now visually grays out until a chat notification is enabled in the Chat tab
- Moved the tag/reply/streamer-message sound settings ("also play a sound", "smart mode") out of the Chat tab into a dedicated "Chat Notification Sound" section under Settings → Notifications & Monitoring - the Chat tab now only has the on/off switches. The new section is visually grayed out until at least one of the two notifications is enabled in the Chat tab
- Added a dedicated toggle to choose whether tag/reply/streamer-message notifications play a sound or stay a silent popup only - off by default is no longer possible without this control, and turning it off now also silences the system notification itself (previously the OS's own default sound could still play even with the extension's sound skipped)
- Fixed tag/reply/streamer-message notifications not firing while actively watching live chat (not scrolled up) - Kick recycles existing chat DOM elements for new messages in that state, and we were treating all recycled elements as "not new," silently skipping notifications for them
- Fixed tag/reply/streamer-message notifications playing both Windows' own notification sound and our custom mention sound at the same time - the system sound is now correctly silenced when the extension's own sound is set to play (matching how the main "went live" notifications already worked)
- Added an optional "smart" mode for the mention/reply/streamer-message sound: play it only when you're not actively watching (tab hidden or chat scrolled up), instead of always - off by default, no change to existing behavior unless enabled
- Added reply notifications: when someone replies to your message using Kick's own reply feature, you now get notified the same way as an @mention - previously only direct @username mentions triggered a notification
- Tag/mention and broadcaster-message notifications now play a distinct sound (borrowed from Mo'Kick's default mention sound) instead of relying on the system's default notification sound alone

### Ad blocking
- Fixed a critical bug where DOM-based ad hiding never had any visual effect: the CSS rule was added to the extension's own popup stylesheet, which is never loaded on kick.com pages at all - the hiding rule now injects directly into the page itself
- Fixed a second issue where visible ad elements were only hidden when our own network-level ad detection had fired; when ad blocking succeeds at the network level (as intended), that signal never fires, leaving Kick's own ad UI on screen - visible ad-element hiding is now independent of that signal
- Added an initial scan when ad blocking is enabled, to catch ad UI already present on the page rather than only reacting to later DOM changes
- Broadened ad-element detection to also catch test IDs like "ima-ad-controls" that don't start with "ad-" but contain it as a distinct segment (without falsely matching unrelated IDs like "upload-progress" or "load-more")
- Added a GPT/IMA SDK stub that prevents ad requests at the source, before Kick's own ad scripts load
- Added segment-level HLS ad filtering (SCTE-35 markers), independent of the master-manifest swap
- Added a host-based fallback filter for VOD-stitched ads when no SCTE-35 marker is present
- Added detection and removal of Kick's own "black slate" placeholder overlay that briefly appears during stream-end transitions
- Added a confirmation dialog before enabling ad blocking, explaining the experimental nature and risks
- VOD ad-free source lookup: added a fast path that derives the source directly from the video thumbnail URL, a time budget (2.5s) so the lookup never stalls playback, multi-channel-safe caching, and a tight/loose duration-matching fallback
- Fixed a defensive edge case where a stream ending mid-ad-break could leave the player stuck instead of transitioning to offline
- Fixed a Worker-wrapping regression that risked crashing the video player's own Worker under certain conditions; reverted to the safer synchronous-fetch approach
- Loosened an overly strict lock on `window.google` that could have interfered with unrelated page scripts
- Scoped ad-domain network rules to kick.com only (previously applied browser-wide)
- Replaced a broad, always-on DOM observer with lightweight, event-driven navigation detection to reduce overhead during high-DOM-churn moments (e.g. stream transitions)
- All ad-blocking log output now also appears directly in the page's own DevTools console, not just the extension's background console

### Localization
- Full line-by-line audit: read every one of the 251 strings in all 14 languages (not a sample) after the previous pass still missed things
- Found a systemic Title Case leak in French, Spanish, and Portuguese (English "Auto Launch"-style capitalization carried over into feature titles where these languages only capitalize the first word) - fixed 22 strings across the three languages
- Korean: three strings used the second-person pronoun "당신" (you), which reads distant/unnatural in Korean UI copy where it's normally dropped or replaced with a polite address term - reworded
- Korean, German, Czech: caught three more formal/informal register slips that the previous regex-based pass missed because they were verb conjugations, not the pronoun itself (e.g. German "Aktiviere" vs "Aktivieren Sie")
- German, French, Spanish, Portuguese, Italian, Arabic: fixed six instances where "Following" (the tab name) was left untranslated or unspecified in a string that referenced it
- Italian: fixed a notification title with reversed word order ("Ti ha risposto $1" → "$1 ti ha risposto") inconsistent with its sibling notification strings
- Russian: fixed a wrong part of speech ("ЭКСПЕРИМЕНТ", a noun, used for the English adjective "EXPERIMENTAL")
- All languages: removed a redundant release-history bullet that restated the same fact twice, sourced from the English original itself
- Reviewed all 13 remaining languages the same way as Turkish (word order, calque phrasing, formal/informal consistency), not just for correctness but for how a native speaker would actually write it
- Fixed a redundant release-history bullet (the same "popup/sound independence" fact was stated twice) - this existed in the English source itself and had propagated into all 13 translations; merged into one line everywhere, including the source
- Korean: `chatFilterModeDesc` had no verb conjugation at all (noun-form fragments strung together, a literal word-for-word artifact) - rewritten as a complete, natural sentence
- German: `chatFilterModeDesc` used "überfahren" for "hover" - the wrong verb (it normally means "to run over/collide with"); replaced with "darüberfahren". `thumbnailsWarning`'s "was...birgt, dass" clause was restructured for a more natural flow
- Russian: fixed a formal/informal (вы/ты) inconsistency within the same release-history paragraph
- Reworked the Turkish translation for natural phrasing - several strings had followed English word order too closely (verb placement, "için" clause order, compound sentences that read as calques rather than natural Turkish), and the formal/informal address (siz/sen) wasn't consistent with the app's own casual tone (its own tagline addresses the user as "sen"). About 20 strings rewritten, mostly in error messages, confirmation dialogs, and the release history
- Fixed formal/informal address inconsistency: newer strings (Backup & Restore, Chat Notifications, Release History) had been written in a different register than the rest of each language - Czech (8 strings ty→vy), German (9 strings du→Sie), French (1 string tu→vous), Russian (1 string ты→вы), and Chinese (7 strings 您→你) were standardized to match the majority register already used throughout each language. Spanish, Portuguese, Italian, Slovak, Japanese, Korean, and Arabic were already internally consistent
- Added Slovak (sk) as a new supported language - all 251 strings translated
- Audited all languages for structural and semantic correctness: found and fixed ~19 strings across 12 languages that had never been translated (left as English) since the anomaly-detection/card-view features were added; fixed a Japanese terminology inconsistency (two different translations for "Auto Launch"), a Chinese mistranslation (a statistics term used out of context), and a French gender-agreement error
- Backfilled the "What's New" release history with everything from v2.5.21 through v2.5.30 that had gone unrecorded (reply notifications, independent popup/sound toggles, smart sound mode, the recycled-DOM-node and Windows-sound-clash fixes) - it only had the ad-blocking and settings-redesign entries before
- Added Backup & Restore: export all settings to a file, or import them back - useful when reinstalling without Cloud Sync
- Backup & Restore now shows when you last backed up, offers a one-time "Undo Last Change" safety net after any import or reset, and includes a "Reset to Defaults" option
- Settings page reorganized into four collapsible categories: General, Notifications & Monitoring, Additional Features, Account & Sync
- Added a settings search box with live filtering and match highlighting
- Added a one-time "what's new" banner shown after updates, plus a permanent "What's New" link in Settings to revisit it anytime
- Clarified the empty-state message shown to users who haven't followed any channels yet
- Simplified the bot-detection score explanation, with the technical formula tucked behind a "how is this calculated?" link
- Added a visual "Experimental" badge to the Ad Blocking setting
- Fixed a bug where enabling Ad Blocking's description could cause other settings in the same group to become invisible
- Fixed a display glitch in the bot-score badge on channel thumbnails
- Fixed the "What's New" settings link not responding to clicks

### Interface
- Fixed the Backup & Restore page showing raw icon names ("download", "upload", "undo") as text instead of icons - the page was missing the font `<link>` tags that popup.html has; it only linked the CSS, not the icon font itself
- Export/Import now open in a small borderless popup window (via chrome.windows.create) instead of a full browser tab - it works around the same Firefox popup-closing issue, but no longer feels like navigating away to a webpage. No new permission needed
- Simplified the Backup & Restore description into two short sentences instead of one long run-on sentence, in all 14 languages
- Fixed a logical contradiction: the Import confirmation said "this cannot be undone" while the same screen has an "Undo Last Change" button that does exactly that - now matches the wording already used on the Reset confirmation ("cannot be undone, but you can undo it once right after")
- Backfilled the "What's New" release history again - v2.5.30 (independent popup/sound toggles, chat-panel-hidden detection) through v2.5.33 (Slovak language, translation quality pass) had gone unrecorded

### Firefox
- Fixed the new Backup & Restore page saying "Imported!/Restored! Reloading..." without actually reloading - the message was carried over from the old popup flow but the reload call itself was dropped when the UI moved to its own tab, leaving stale info (last backup time, Undo button visibility) on screen after a successful import or undo
- Fixed Export/Import Settings silently doing nothing on Firefox: opening a native file picker (or a download) from inside an extension's toolbar popup causes Firefox to close the popup immediately (Mozilla Bugzilla #1658694, #1292701) - so the file was never actually selected, and settings appeared to import successfully on Chrome but not take effect at all on Firefox. Export/Import now open in their own tab (html/backup.html), which isn't subject to this behavior
- Added proper error handling to the underlying storage read/write calls (storage.js) - a quota or permission failure during import now surfaces a clear error message instead of the operation silently hanging
- Fixed a missing-dependency load order issue in `background.scripts`
- Removed an invalid `offscreen` permission from the Firefox manifest

## v2.4.0 - Channel Previews & Ad Blocking (published)

- Added Channel Preview Images (thumbnails) in the Following list
- Added Ad Blocking (experimental) for Kick live streams and VODs
- Added Bot Detection scoring for viewer counts
- Various chat integration and notification refinements carried over from v2.3.x

## v2.3.0 - Chat Integration

- Added the Chat tab: bot/spam/duplicate/keyword filtering, favorites, and mentions directly in the popup
- Added Do Not Disturb scheduling
- Added viewer anomaly detection (sudden spikes/drops)

---

*For the complete, unabridged commit history, see the repository's commit log.*
