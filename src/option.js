/**
 * KickAlert - Options Page Script
 * © 2025 Segelferd. All rights reserved.
 */

document.addEventListener('DOMContentLoaded', async () => {
  applyI18n();
  await loadSettings();
  setupListeners();
});

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const sub = el.getAttribute('data-i18n-sub');
    el.textContent = chrome.i18n.getMessage(key, sub ? [sub] : undefined) || key;
  });
  document.querySelectorAll('[data-i18n-html]').forEach(el => {
    const key = el.getAttribute('data-i18n-html');
    el.innerHTML = chrome.i18n.getMessage(key) || key;
  });
}

async function loadSettings() {
  el('auto-unmute').checked = await Storage.getAutoUnmute();
  el('reset-suspend').checked = await Storage.getResetSuspendOnRestart();
  el('show-offline').checked = await Storage.getShowOfflineChannels();
  el('show-notification').checked = await Storage.getShowNotification();
  el('only-switch').checked = await Storage.getOnlySwitchChannels();
  el('silent-others').checked = await Storage.getSilentForOthers();
  el('auto-refresh').checked = await Storage.getAutoRefreshPopup();

  const vol = await Storage.getSoundVolume();
  el('volume-slider').value = vol;
  el('volume-value').textContent = vol;
  updateSliderFill(el('volume-slider'));

  const interval = await Storage.getCheckInterval();
  el('interval-slider').value = interval;
  el('interval-value').textContent = interval;
  updateSliderFill(el('interval-slider'));

  updateSilentVisibility();
  await updateSoundStatus('main');
  await updateSoundStatus('sub');
}

function setupListeners() {
  bind('auto-unmute', v => Storage.setAutoUnmute(v));
  bind('reset-suspend', v => Storage.setResetSuspendOnRestart(v));
  bind('show-offline', v => Storage.setShowOfflineChannels(v));
  bind('show-notification', v => Storage.setShowNotification(v));
  bind('only-switch', v => { Storage.setOnlySwitchChannels(v); updateSilentVisibility(); });
  bind('silent-others', v => Storage.setSilentForOthers(v));
  bind('auto-refresh', v => Storage.setAutoRefreshPopup(v));

  const volSlider = el('volume-slider');
  volSlider.addEventListener('input', () => {
    el('volume-value').textContent = volSlider.value;
    updateSliderFill(volSlider);
  });
  volSlider.addEventListener('change', () => Storage.setSoundVolume(+volSlider.value));
  updateSliderFill(volSlider);

  const intSlider = el('interval-slider');
  intSlider.addEventListener('input', () => {
    el('interval-value').textContent = intSlider.value;
    updateSliderFill(intSlider);
  });
  intSlider.addEventListener('change', () => Storage.setCheckInterval(+intSlider.value));
  updateSliderFill(intSlider);

  el('test-sound').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType: 'NEW_LIVE_MAIN' });
  });

  setupSound('main');
  setupSound('sub');
}

function bind(id, fn) {
  el(id).addEventListener('change', e => fn(e.target.checked));
}

function updateSilentVisibility() {
  const on = el('only-switch').checked;
  el('silent-row').style.opacity = on ? '1' : '0.4';
  el('silent-others').disabled = !on;
}

function setupSound(type) {
  const file = el(`${type}-sound-file`);
  const test = el(`${type}-sound-test`);
  const clear = el(`${type}-sound-clear`);

  file.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) {
      setStatus(type, chrome.i18n.getMessage('customSoundStatusErrorTooLarge', [(f.size / 1048576).toFixed(1)]));
      return;
    }
    try {
      const url = await toDataUrl(f);
      await Storage.setCustomSoundFile(type, f.name, url);
      await updateSoundStatus(type);
    } catch { setStatus(type, chrome.i18n.getMessage('customSoundStatusErrorSave')); }
  });

  test.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType: type === 'main' ? 'NEW_LIVE_MAIN' : 'NEW_LIVE_SUB' });
  });

  clear.addEventListener('click', async () => {
    await Storage.clearCustomSoundFile(type);
    file.value = '';
    await updateSoundStatus(type);
  });
}

async function updateSoundStatus(type) {
  const data = await Storage.getCustomSoundFile(type);
  setStatus(type, data?.fileName || chrome.i18n.getMessage('customSoundStatusUnset'));
}

function setStatus(type, text) { el(`${type}-sound-status`).textContent = text; }

/**
 * Update slider track fill color - green portion shows progress
 */
function updateSliderFill(slider) {
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const val = parseFloat(slider.value) || 0;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, #53FC18 0%, #53FC18 ${pct}%, #3a3a3e ${pct}%, #3a3a3e 100%)`;
}

function toDataUrl(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

function el(id) { return document.getElementById(id); }
