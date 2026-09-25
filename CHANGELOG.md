# Changelog

All notable changes to KickAlert are documented here. Entries are grouped by
meaningful milestone rather than every internal build — small consecutive
patch versions with no user-facing change are folded into the entry that
follows them.

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
