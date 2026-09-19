# Changelog

All notable changes to KickAlert are documented here. Entries are grouped by
meaningful milestone rather than every internal build — small consecutive
patch versions with no user-facing change are folded into the entry that
follows them.

## v2.5.x — Ad-block hardening, VOD improvements, settings redesign

### Chat integration
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

### Interface
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

### Firefox
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
