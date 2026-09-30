# Changelog

All notable changes to KickAlert are documented here. Entries are grouped by
meaningful milestone rather than every internal build — small consecutive
patch versions with no user-facing change are folded into the entry that
follows them.

## v2.5.67 — Store release: per-channel alerts, watch time and fixes

- Store release covering v2.5.48 → v2.5.66 (see the entries below)
- What's New banner and Release History updated in all 14 languages

## v2.5.66 — Cloud Sync no longer undoes imports or loses large settings

- With Cloud Sync on, importing a settings file (and "Reset to defaults" / "Undo import") only changed this device; the old copy in your browser account came back on the next browser start and silently reverted the imported settings, including per-channel alerts, sound modes, favourites and auto-open channels. These actions now update the cloud copy too
- Browser sync allows at most 8 KB per setting. A setting over the limit (for example channel alerts with filters on very many channels) failed to sync silently, and on the next browser start the older cloud copy overwrote the newer one on this device. Such settings are now kept on this device and never overwritten, the other settings still sync, and Settings → Cloud Sync shows which setting is too large
- A setting that could not be written to the cloud (offline, rate limit) is retried automatically and is not overwritten by the cloud copy in the meantime

## v2.5.65 — Critical: Windows sound and buttons on Chrome 148+

- Root cause of the Windows notification sound playing with extension sounds found and fixed. Since Chrome 148, Chrome also exposes the `browser` namespace that the extension used to detect Firefox, so on current Chrome it treated itself as Firefox: notifications (live alerts, channel events, chat tag/streamer messages) were created without the "silent" flag and without the Open / Mute buttons. Firefox is now detected with a Firefox-only API, so in "Extension sounds" mode Windows no longer adds its own sound, and the notification buttons are back
- The note about turning off the Windows sound in system settings is now shown only in Firefox, which cannot request silent notifications

## v2.5.64 — Windows sound option for channel event alerts

- Channel event sounds now have five choices: Soft drop, Light chime, Tick (extension sound, system sound off), Windows notification sound (only the system sound, no extension sound) and Silent (no sound at all). The Windows option has its own Test button that sends a sample notification
- Silent now also asks the system for a silent notification; Do Not Disturb "Mute sounds" and a channel's "silent" setting silence the Windows option too
- Added a note in Settings: if Windows still plays its own sound with an extension sound or Silent, turn off "Play a sound when a notification arrives" for the browser in Windows notification settings (Firefox cannot request silent notifications at all)

## v2.5.63 — Quieter sound for channel event alerts

- Category/title change, stream ended and raid alerts no longer use the system (Windows) notification sound, which was louder than the live alert. They now have their own quieter sound, chosen in Settings → Channel event sounds: Soft drop (default), Light chime, Tick or Silent, with a separate volume slider and a Test button
- The event sound follows Do Not Disturb ("Mute sounds") and a channel's "silent" sound setting; muted channels still get no event alerts at all
- The new sounds are original, generated for KickAlert (no third-party audio), about 5 dB quieter than the live alert before the volume slider

## v2.5.62 — No error after extension updates

- After the extension was updated or reloaded, kick.com tabs that were already open kept the old page script, which reported "Extension context invalidated" in chrome://extensions → Errors (seen on channel pages with ad blocking logs). The old script now notices the extension was replaced and stops quietly. Refreshing those tabs loads the new version as before

## v2.5.61 — Developer test panel

- Internal test panel redesigned (tabs, live flow, log filter/copy) and extended with checks for every feature added since v2.5.48: per-channel change / stream-end / raid alerts, channel filters, watch time, review prompt conditions, raid listener status, settings integrity and all 14 languages. No change for users

## v2.5.60 — Category/title change alerts actually track

- Category and title change alerts never fired, and the channel alerts window kept saying "Tracking starts when the channel goes live" even for channels that had been live for hours. The followed-channels list Kick returns has no stream start time, and the tracker skipped every channel without one. Channels are now tracked as long as they are seen live; the start time is fetched once per stream only for channels with change or stream-end alerts on, so stream-ended alerts also show the stream length more reliably

## v2.5.59 — Tracking status line readable

- The "Now: category · checked Xm ago" line in the channel alerts window was cut off with "…"; it now wraps and is slightly larger

## v2.5.58 — Stream-end details, raid viewer count, change-alert checks

- Stream ended alerts arrived without length or title ("-"): the category/title tracker removed a channel's last info (start time, title) the moment it went offline, just before the stream-end check looked for it. That info is now kept for 3 hours after a channel goes offline, so the alert shows "Streamed for 2h 5m · title" again. If nothing is known, the category (or Kick.com) is shown instead of "-"
- Raid alerts could show "? viewers": Kick sends two events per raid and one may have no viewer count. The first event now waits 4 seconds and both are merged into a single notification
- Category/title change alerts: comparisons were skipped when the last fresh check was more than 15 minutes old (e.g. after Cloudflare blocks); now 60 minutes, the same-stream check still prevents mix-ups. The channel alerts window now shows what the extension last saw for that channel ("Now: Just Chatting · checked 3m ago"), and each check is logged (CHG-05…CHG-08) in the background console

## v2.5.57 — Card buttons always fit

- Following cards: with channel groups defined a card has six buttons, and in the two-column popup the last one (favourite star) was cut off. The buttons are now one group, slightly tighter, and fit on one line in the usual popup width; if a card is ever too narrow, the whole group moves to a second line instead of being cut
- The new channel-alerts icon used a different icon class and rendered larger than the others; all card icons are now the same size (the group icon too)

## v2.5.56 — Large preview on hover

- Hovering a channel preview image for a moment shows it large with the title and category. Uses the image already loaded (no extra request); only when Channel Preview Images is on

## v2.5.55 — Watch time and weekly summary

- New: counts how long you watch each channel while a Kick tab is playing (VOD/clip pages and silent background tabs are not counted; the same channel in two tabs is counted once). Stored only on this device, kept for 35 days
- History tab shows the last 7 days: total, change vs. the 7 days before, and the top 3 channels
- Can be turned off in Settings → Additional Features → Watch time (on by default)

## v2.5.54 — Raid alerts (opt-in per channel)

- New per-channel option: notification when another streamer raids a followed channel, e.g. "Mithrain raided Eray · with 842 viewers", plus a History entry
- Uses Kick's StreamHostEvent / StreamHostedEvent on the channel's chatroom through the existing bot-detection connection; if bot detection is off, only channels with raid alerts on are listened to (no scoring). The raw event is logged as RAID-00 so the field names can be checked against a real raid
- One raid notification per channel per 10 minutes (the two events Kick sends for one raid never produce two notifications)
- Firefox: the chat connection module is now loaded in the background in raid-only mode (no bot scores on Firefox, same as before)

## v2.5.53 — Stream ended alerts (opt-in per channel)

- New per-channel option: notification when a stream ends, with how long it lasted, plus a History entry
- Two-stage confirmation: a Pusher end event or fresh API data only makes the channel a candidate; the alert goes out when fresh API data still shows it offline about 2.5 minutes later. Fallback (cached) data never counts as an end, a channel that comes back cancels the candidate, and nothing is sent retroactively after the browser was closed

## v2.5.52 — Review request for active users only

- A one-line request to leave a store review, shown only when all of these are true: used for at least 7 days, at least one channel preference set, at least one setting changed, popup opened at least 10 times, at least 3 live notifications received
- "Maybe later" waits 21 days; shown at most twice; "Leave a review" or × never shows it again. Never shown together with the What's New banner. Stored only on this device

## v2.5.51 — Stronger live ad-block fallback

- Clarification: live streams already switch to Kick's own ad-free (ads-opt-out) playlist since v2.3.18; that stays the primary method
- New third fallback adapted from Kick Ad Blocker – AI Chat: Amazon IVS labels every segment's source ("live" for real content). Segments with a different source (and their ad init segment) are removed, which also catches ad breaks without SCTE-35 CUE-OUT markers. Only applied when the playlist uses these labels and real content remains

## v2.5.50 — Per-channel category / keyword filter

- New per-channel filter: notify only if the category is one of a list and/or the title contains one of your words. Applies to the notification, sound and auto-launch; the stream is still logged in History with a "Filtered" tag
- Matching ignores case and accents and handles Turkish İ/ı ("İSTANBUL" matches "istanbul"); category suggestions come from the channels you follow
- If Kick's live event arrives without a category and a category filter is set, the category is looked up for that channel only; if it is still unknown, the notification is not blocked

## v2.5.49 — Channel alerts window and category / title change alerts

- New button on channel cards (tune icon) opens a per-channel alerts window; everything in it is off by default and the button turns green when something is set
- New per-channel option: notification when a live channel switches category or changes its title. Only with fresh API data, only within the same stream session, both old and new values must be present, at most one change alert per channel per 5 minutes

## v2.5.48 — Settings no longer cut off in longer languages

- Settings groups were measured once when opened and kept that pixel height; switching language (or any text that grew later) pushed the bottom of a group out of view, e.g. the "Reset Everything" button in German and Japanese. Groups now only use a fixed height during the open/close animation and grow freely with their content afterwards
- Text written by the popup itself now follows a language switch right away: last backup line, custom sound status, History day headings, anomaly sensitivity labels ("Warn" / "Alert")
- Translated the remaining fixed English text: Settings title, "Source Code" and "Rate Extension" links, the Auto / Guard header pills, the "Sort:" label and the "sec" unit, in all 14 languages
- Japanese: auto-launch is now "自動オープン" instead of "自動入場"

## v2.5.47 — Two small fixes found while refreshing the store images

- Tab labels no longer get clipped when a counter is shown next to a long label (e.g. "Notification History"); each tab now takes the width its label needs and long translations wrap instead of being cut off
- The viewer trend window showed its time span in Turkish ("29dk", "1s 20dk") in every language; it now uses the same "29m" / "1h 20m" format as the channel cards

## v2.5.46 — Visual refresh

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

## v2.5.45 — Critical: Cloud Sync silently reverting Chat tab settings

### Cloud Sync / Storage
- **Root cause found and fixed for a real data-loss bug**: users with Cloud Sync enabled could see their Chat tab settings (filters, tag notification, etc.) silently revert to an old or default state hours later, with zero interaction. Cause: `setChatSettings`/`updateChatSetting` wrote straight to local storage without ever refreshing the cloud copy, so the cloud side stayed stale (often empty). Meanwhile, every service-worker wake-up (roughly once a minute, driven by the periodic live-check alarm) unconditionally re-pulled from the cloud and overwrote local storage with that stale copy — no merge, no timestamp check. Other settings (favorites, channel groups, etc.) were unaffected because they already pushed to the cloud on every change.
- Fix has two parts: (1) Chat tab settings now mirror to `chrome.storage.sync` immediately on every write, exactly like other synced settings; (2) the automatic cloud pull no longer runs on routine background wake-ups — it now only runs on a genuine new session (browser start or extension install/update), which is the only time it was ever meant to run.
- Fixed the same class of bug for the Chat tab's on/off switch (`setChatIntegrationEnabled`), which had the identical direct-write bypass.
- Also fixed a small inconsistency: the Chat tab's content-script default settings object used a different default emoji-spam threshold (10) than the popup's (5) — unified to 5.

## v2.5.44 — Store listing refresh

### Store listing
- Rewrote the extension name and short summary (shown as the Chrome Web Store title/summary, sourced from manifest.json) across all 14 supported languages to lead with "Kick.com" and the core value proposition, while keeping the brand's tone
- No code changes in this release

## v2.5.x — Ad-block hardening, VOD improvements, settings redesign

### Storage / data integrity
- Fixed the same lost-update race found in the Chat tab's settings across the rest of the extension: favorite channels, per-channel sound mode, channel groups, the auto-open list, the chatroom/channel ID cache, bot scores, and notification history all updated their shared storage entry by reading it, changing one field, and writing the whole thing back — if two of these fired close together (rapid-clicking multiple favorite stars, opening two Kick tabs at once, several followed channels going live together) the slower write could silently overwrite the faster one's change with stale data. All of these now go through the same per-key write queue as the Chat tab fix, so concurrent updates to the same storage entry can no longer clobber each other

### Chat integration
- Fixed the Chat tab's Kick username field (used for @mention detection) silently failing to save if you typed it and then clicked away or closed the browser within half a second — the save was debounced by 500ms, and closing the extension popup destroys that pending timer along with the unsaved value. It's now also flushed immediately when the popup loses focus or closes, in addition to the debounced save while typing
- Fixed a rare but real data-loss bug in the Chat tab: any two settings changed in quick succession (e.g. typing your username right after toggling a filter, or clicking two toggles fast) could race against each other, since each save read-modified-wrote the whole chat settings object independently — the slower one could silently overwrite the faster one's change with stale data. All chat-tab settings writes are now serialized so this can no longer happen
- Adapted three settings from Mo'Kick's more granular notification options, kept summarized: an independent "show a notification popup" toggle (separate from sound — you can now have sound without a popup, a silent popup, both, or neither, with the message still highlighted in chat either way), and "smart mode" now also detects when Kick's own chat panel itself is hidden (theater/fullscreen), not just tab-hidden or scrolled
- Skipped Mo'Kick's "covered by another element" condition — it's specific to their own injected overlay UI and has no equivalent in our architecture
- Repositioned the "Chat Notification Sound" section right after the main Notification Settings (previously separated by Do Not Disturb) and rebuilt it to match the rest of Settings exactly: a toggle switch in the section header (identical to Do Not Disturb's), a standard checkbox for the "smart mode" sub-option, and the same disabled-state styling used throughout — the whole section now visually grays out until a chat notification is enabled in the Chat tab
- Moved the tag/reply/streamer-message sound settings ("also play a sound", "smart mode") out of the Chat tab into a dedicated "Chat Notification Sound" section under Settings → Notifications & Monitoring — the Chat tab now only has the on/off switches. The new section is visually grayed out until at least one of the two notifications is enabled in the Chat tab
- Added a dedicated toggle to choose whether tag/reply/streamer-message notifications play a sound or stay a silent popup only — off by default is no longer possible without this control, and turning it off now also silences the system notification itself (previously the OS's own default sound could still play even with the extension's sound skipped)
- Fixed tag/reply/streamer-message notifications not firing while actively watching live chat (not scrolled up) — Kick recycles existing chat DOM elements for new messages in that state, and we were treating all recycled elements as "not new," silently skipping notifications for them
- Fixed tag/reply/streamer-message notifications playing both Windows' own notification sound and our custom mention sound at the same time — the system sound is now correctly silenced when the extension's own sound is set to play (matching how the main "went live" notifications already worked)
- Added an optional "smart" mode for the mention/reply/streamer-message sound: play it only when you're not actively watching (tab hidden or chat scrolled up), instead of always — off by default, no change to existing behavior unless enabled
- Added reply notifications: when someone replies to your message using Kick's own reply feature, you now get notified the same way as an @mention — previously only direct @username mentions triggered a notification
- Tag/mention and broadcaster-message notifications now play a distinct sound (borrowed from Mo'Kick's default mention sound) instead of relying on the system's default notification sound alone

### Ad blocking
- Fixed a critical bug where DOM-based ad hiding never had any visual effect: the CSS rule was added to the extension's own popup stylesheet, which is never loaded on kick.com pages at all — the hiding rule now injects directly into the page itself
- Fixed a second issue where visible ad elements were only hidden when our own network-level ad detection had fired; when ad blocking succeeds at the network level (as intended), that signal never fires, leaving Kick's own ad UI on screen — visible ad-element hiding is now independent of that signal
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
- Found a systemic Title Case leak in French, Spanish, and Portuguese (English "Auto Launch"-style capitalization carried over into feature titles where these languages only capitalize the first word) — fixed 22 strings across the three languages
- Korean: three strings used the second-person pronoun "당신" (you), which reads distant/unnatural in Korean UI copy where it's normally dropped or replaced with a polite address term — reworded
- Korean, German, Czech: caught three more formal/informal register slips that the previous regex-based pass missed because they were verb conjugations, not the pronoun itself (e.g. German "Aktiviere" vs "Aktivieren Sie")
- German, French, Spanish, Portuguese, Italian, Arabic: fixed six instances where "Following" (the tab name) was left untranslated or unspecified in a string that referenced it
- Italian: fixed a notification title with reversed word order ("Ti ha risposto $1" → "$1 ti ha risposto") inconsistent with its sibling notification strings
- Russian: fixed a wrong part of speech ("ЭКСПЕРИМЕНТ", a noun, used for the English adjective "EXPERIMENTAL")
- All languages: removed a redundant release-history bullet that restated the same fact twice, sourced from the English original itself
- Reviewed all 13 remaining languages the same way as Turkish (word order, calque phrasing, formal/informal consistency), not just for correctness but for how a native speaker would actually write it
- Fixed a redundant release-history bullet (the same "popup/sound independence" fact was stated twice) — this existed in the English source itself and had propagated into all 13 translations; merged into one line everywhere, including the source
- Korean: `chatFilterModeDesc` had no verb conjugation at all (noun-form fragments strung together, a literal word-for-word artifact) — rewritten as a complete, natural sentence
- German: `chatFilterModeDesc` used "überfahren" for "hover" — the wrong verb (it normally means "to run over/collide with"); replaced with "darüberfahren". `thumbnailsWarning`'s "was...birgt, dass" clause was restructured for a more natural flow
- Russian: fixed a formal/informal (вы/ты) inconsistency within the same release-history paragraph
- Reworked the Turkish translation for natural phrasing — several strings had followed English word order too closely (verb placement, "için" clause order, compound sentences that read as calques rather than natural Turkish), and the formal/informal address (siz/sen) wasn't consistent with the app's own casual tone (its own tagline addresses the user as "sen"). About 20 strings rewritten, mostly in error messages, confirmation dialogs, and the release history
- Fixed formal/informal address inconsistency: newer strings (Backup & Restore, Chat Notifications, Release History) had been written in a different register than the rest of each language — Czech (8 strings ty→vy), German (9 strings du→Sie), French (1 string tu→vous), Russian (1 string ты→вы), and Chinese (7 strings 您→你) were standardized to match the majority register already used throughout each language. Spanish, Portuguese, Italian, Slovak, Japanese, Korean, and Arabic were already internally consistent
- Added Slovak (sk) as a new supported language — all 251 strings translated
- Audited all languages for structural and semantic correctness: found and fixed ~19 strings across 12 languages that had never been translated (left as English) since the anomaly-detection/card-view features were added; fixed a Japanese terminology inconsistency (two different translations for "Auto Launch"), a Chinese mistranslation (a statistics term used out of context), and a French gender-agreement error
- Backfilled the "What's New" release history with everything from v2.5.21 through v2.5.30 that had gone unrecorded (reply notifications, independent popup/sound toggles, smart sound mode, the recycled-DOM-node and Windows-sound-clash fixes) — it only had the ad-blocking and settings-redesign entries before
- Added Backup & Restore: export all settings to a file, or import them back — useful when reinstalling without Cloud Sync
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
- Fixed the Backup & Restore page showing raw icon names ("download", "upload", "undo") as text instead of icons — the page was missing the font `<link>` tags that popup.html has; it only linked the CSS, not the icon font itself
- Export/Import now open in a small borderless popup window (via chrome.windows.create) instead of a full browser tab — it works around the same Firefox popup-closing issue, but no longer feels like navigating away to a webpage. No new permission needed
- Simplified the Backup & Restore description into two short sentences instead of one long run-on sentence, in all 14 languages
- Fixed a logical contradiction: the Import confirmation said "this cannot be undone" while the same screen has an "Undo Last Change" button that does exactly that — now matches the wording already used on the Reset confirmation ("cannot be undone, but you can undo it once right after")
- Backfilled the "What's New" release history again — v2.5.30 (independent popup/sound toggles, chat-panel-hidden detection) through v2.5.33 (Slovak language, translation quality pass) had gone unrecorded

### Firefox
- Fixed the new Backup & Restore page saying "Imported!/Restored! Reloading..." without actually reloading — the message was carried over from the old popup flow but the reload call itself was dropped when the UI moved to its own tab, leaving stale info (last backup time, Undo button visibility) on screen after a successful import or undo
- Fixed Export/Import Settings silently doing nothing on Firefox: opening a native file picker (or a download) from inside an extension's toolbar popup causes Firefox to close the popup immediately (Mozilla Bugzilla #1658694, #1292701) — so the file was never actually selected, and settings appeared to import successfully on Chrome but not take effect at all on Firefox. Export/Import now open in their own tab (html/backup.html), which isn't subject to this behavior
- Added proper error handling to the underlying storage read/write calls (storage.js) — a quota or permission failure during import now surfaces a clear error message instead of the operation silently hanging
- Fixed a missing-dependency load order issue in `background.scripts`
- Removed an invalid `offscreen` permission from the Firefox manifest

## v2.4.0 — Channel Previews & Ad Blocking (published)

- Added Channel Preview Images (thumbnails) in the Following list
- Added Ad Blocking (experimental) for Kick live streams and VODs
- Added Bot Detection scoring for viewer counts
- Various chat integration and notification refinements carried over from v2.3.x

## v2.3.0 — Chat Integration

- Added the Chat tab: bot/spam/duplicate/keyword filtering, favorites, and mentions directly in the popup
- Added Do Not Disturb scheduling
- Added viewer anomaly detection (sudden spikes/drops)

---

*For the complete, unabridged commit history, see the repository's commit log.*
