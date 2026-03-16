/**
 * KickAlert - Content Script
 * Auto-unmute functionality for kick.com.
 * © 2025 Segelferd. All rights reserved.
 */

(async function () {
  const result = await chrome.storage.local.get('autoUnmute');
  if (!result.autoUnmute) return;

  const observer = new MutationObserver(() => {
    const video = document.querySelector('video');
    if (video && video.muted) {
      video.muted = false;
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => observer.disconnect(), 30000);
})();
