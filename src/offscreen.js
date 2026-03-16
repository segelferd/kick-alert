/**
 * KickAlert - Offscreen Document
 * Audio playback and service worker keep-alive.
 * © 2025 Segelferd. All rights reserved.
 */

const SoundPaths = {
  DEFAULT: '../sounds/new_live_sub.mp3',
  NEW_LIVE_MAIN: '../sounds/new_live_main.mp3',
  NEW_LIVE_SUB: '../sounds/new_live_sub.mp3',
};

setInterval(async () => {
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage('keepAlive');
  } catch {}
}, 20000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.messageType !== 'PLAY_SOUND') return false;
  const { sound, volume, customSoundFile } = msg.options;
  const src = customSoundFile || SoundPaths[sound] || SoundPaths.DEFAULT;
  const audio = new Audio(src);
  audio.volume = typeof volume === 'number' ? volume : 1;
  audio.play().catch(e => console.error('[KickAlert] Audio error:', e));
  return false;
});
