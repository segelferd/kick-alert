(function() {
  const KEY = 'Temmuz2014';
  const params = new URLSearchParams(window.location.search);
  if (params.get('key') !== KEY) {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.innerHTML = '<div style="color:#222;padding:40px;">404</div>';
    });
    throw new Error('Access denied');
  }
})();

const isFF = navigator.userAgent.toLowerCase().includes('firefox');

const log = (msg, type) => {
  const box = document.getElementById('log');
  if (!box) return;
  const line = document.createElement('div');
  line.className = type || '';
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
};

async function updateStatus() {
  try {
    const settings = await Storage.getAnomalySettings();
    const showNotif = await Storage.getShowNotification();
    const soundMode = await Storage.getSoundMode();
    const volume = await Storage.getSoundVolume();
    const dndActive = await Storage.isDndActive();
    document.getElementById('status-row').innerHTML =
      '<div class="status-pill">Tarayıcı: <span>' + (isFF ? '🦊 Firefox' : '🟢 Chrome') + '</span></div>' +
      '<div class="status-pill">Bildirim: <span>' + (showNotif ? '✓ Açık' : '✗ Kapalı') + '</span></div>' +
      '<div class="status-pill">Ses: <span>' + soundMode + ' %' + volume + '</span></div>' +
      '<div class="status-pill">Anomali: <span>' + (settings.enabled ? '✓ Açık' : '✗ Kapalı') + '</span></div>' +
      '<div class="status-pill">DND: <span>' + (dndActive ? '🔴 Aktif' : '⚪ Kapalı') + '</span></div>';
  } catch(e) { log('Status error: ' + e.message, 'err'); }
}

async function updateThresholds() {
  try {
    const s = await Storage.getAnomalySettings();
    const SPIKE = { min:{warn:25,alert:75}, avg:{warn:50,alert:150}, max:{warn:75,alert:250} };
    const DROP  = { min:{warn:10,alert:20}, avg:{warn:20,alert:35},  max:{warn:30,alert:50}  };
    const sp = s.spikeSensitivity || 'avg';
    const dp = s.dropSensitivity  || 'avg';
    const el = document.getElementById('thresh-display');
    if (!el) return;
    el.innerHTML =
      '<table class="thresh-table"><thead><tr><th></th><th>Warn</th><th>Alert</th><th>Mod</th></tr></thead><tbody>' +
      '<tr><td>Artış</td><td style="color:#f0a500">+' + SPIKE[sp].warn + '%</td><td style="color:#e74c3c">+' + SPIKE[sp].alert + '%</td><td>' + sp + '</td></tr>' +
      '<tr><td>Düşüş</td><td style="color:#f0a500">-' + DROP[dp].warn  + '%</td><td style="color:#e74c3c">-' + DROP[dp].alert  + '%</td><td>' + dp + '</td></tr>' +
      '</tbody></table>';
  } catch(e) { log('Threshold error: ' + e.message, 'err'); }
}

async function updateDnd() {
  try {
    const enabled = await Storage.getDndEnabled();
    const start   = await Storage.getDndStart();
    const end     = await Storage.getDndEnd();
    const active  = await Storage.isDndActive();
    const muteN   = await Storage.getDndMuteNotif();
    const muteS   = await Storage.getDndMuteSound();
    const muteA   = await Storage.getDndMuteAutolaunch();
    const el = document.getElementById('dnd-display');
    if (!el) return;
    if (!enabled) { el.innerHTML = '<span style="color:#555">DND kapalı</span>'; return; }
    el.innerHTML =
      'Saat: <b>' + start + ' – ' + end + '</b> · Şu an: <b style="color:' + (active ? '#e74c3c' : '#53FC18') + '">' + (active ? 'Aktif' : 'Pasif') + '</b><br>' +
      'Bildirim sustur: <b>' + (muteN ? '✓' : '✗') + '</b> · Ses sustur: <b>' + (muteS ? '✓' : '✗') + '</b> · Auto-launch sustur: <b>' + (muteA ? '✓' : '✗') + '</b>';
  } catch(e) { log('DND error: ' + e.message, 'err'); }
}

async function sendNotif(title, message, isSilent, withButtons) {
  const id = 'ka-test-' + Date.now();
  const avatarInput = document.getElementById('notif-avatar');
  const avatarUrl = (avatarInput && avatarInput.value.trim()) || chrome.runtime.getURL('icons/icon128.png');
  const opts = { type: 'basic', iconUrl: avatarUrl, title: title, message: message };
  if (!isFF) {
    opts.silent = !!isSilent;
    if (withButtons) opts.buttons = [{ title: 'Aç' }, { title: 'Sustur' }];
  }
  chrome.notifications.create(id, opts, function(nid) {
    if (chrome.runtime.lastError) {
      log('Bildirim hatası: ' + chrome.runtime.lastError.message, 'err');
    } else {
      log('✓ Bildirim: ' + nid, 'ok');
    }
  });
}

async function testNotification() {
  const user  = document.getElementById('notif-user').value  || 'TestYayıncı';
  const title = document.getElementById('notif-title').value || 'Test yayını';
  const cat   = document.getElementById('notif-cat').value   || '';
  const sound = document.getElementById('notif-sound').value;
  const delay = parseInt(document.getElementById('notif-delay').value) || 0;
  const isSilent = (sound !== 'windows');
  if (delay > 0) {
    log('Bildirim ' + delay + ' sn sonra gönderilecek...', 'warn');
    await new Promise(r => setTimeout(r, delay * 1000));
  }
  await sendNotif(user + ' yayına başladı', title + (cat ? ' · ' + cat : ''), isSilent, true);
  if (sound === 'extension') await playTestSound('NEW_LIVE_MAIN');
}

async function testSpikeNotif() {
  const user = document.getElementById('anom-user').value || 'TestYayıncı';
  const pct  = document.getElementById('anom-spike-pct').value || '120';
  await sendNotif(user + ' — Şüpheli İzleyici Artışı', '↑ Test · 3.5K → 7.7K (+' + pct + '%)', false, false);
}

async function testDropNotif() {
  const user = document.getElementById('anom-user').value || 'TestYayıncı';
  const pct  = document.getElementById('anom-drop-pct').value || '45';
  await sendNotif(user + ' — Şüpheli İzleyici Düşüşü', '↓ Test · 7.7K → 4.2K (-' + pct + '%)', false, false);
}

async function playTestSound(type) {
  try {
    if (!isFF) {
      chrome.runtime.sendMessage({ type: 'PLAY_TEST_SOUND', soundType: type });
      log('✓ Ses: ' + type, 'ok');
    } else {
      const volume = (await Storage.getSoundVolume()) / 100;
      const customFile = await Storage.getCustomSoundFile(type === 'NEW_LIVE_MAIN' ? 'main' : 'sub');
      const paths = {
        NEW_LIVE_MAIN: chrome.runtime.getURL('sounds/new_live_main.mp3'),
        NEW_LIVE_SUB:  chrome.runtime.getURL('sounds/new_live_sub.mp3'),
      };
      const audio = new Audio((customFile && customFile.dataUrl) || paths[type]);
      audio.volume = volume;
      await audio.play();
      log('✓ Ses çalındı: ' + type, 'ok');
    }
  } catch(e) { log('Ses hatası: ' + e.message, 'err'); }
}

async function checkApi() {
  const slug = document.getElementById('api-slug').value.trim();
  if (!slug) { log('Slug boş', 'err'); return; }
  log('API sorgulanıyor: ' + slug + '...', 'info');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'GET_CHANNEL_LIVE_DETAILS', slug });
    if (result && result.details) {
      const d = result.details;
      log('startTime: ' + (d.startTime || 'null'), 'ok');
      log('thumbnail: ' + (d.thumbnailUrl ? d.thumbnailUrl.substring(0,60) + '...' : 'yok'), 'info');
    } else {
      const t = await chrome.runtime.sendMessage({ type: 'GET_CHANNEL_START_TIME', slug });
      log('startTime (fallback): ' + (t && t.startTime ? t.startTime : 'null'), t && t.startTime ? 'ok' : 'warn');
    }
  } catch(e) { log('API hatası: ' + e.message, 'err'); }
}

async function checkToken() {
  try {
    const cookies = await new Promise(r => chrome.cookies.getAll({ domain: 'kick.com' }, r));
    if (!cookies || cookies.length === 0) {
      log('kick.com cookie yok — Kick\'e giriş yapılmamış', 'err');
      return;
    }
    const session = cookies.find(c => c.name === 'session_token' || c.name === 'token');
    if (session) {
      log('✓ Token bulundu: ' + session.name + ' (' + session.value.substring(0,20) + '...)', 'ok');
    } else {
      log('Cookie var (' + cookies.length + ') ama session_token yok. Mevcut: ' + cookies.map(c => c.name).join(', '), 'warn');
    }
  } catch(e) { log('Cookie hatası: ' + e.message, 'err'); }
}

async function simulateLaunch() {
  const slug = document.getElementById('launch-slug').value.trim();
  if (!slug) { log('Slug boş', 'err'); return; }
  try {
    const d = await new Promise(r => chrome.storage.local.get('_liveSlugs', r));
    const slugs = (d._liveSlugs || []).filter(s => s !== slug);
    await new Promise(r => chrome.storage.local.set({ _liveSlugs: slugs }, r));
    log('✓ ' + slug + ' liveSlugs\'tan çıkarıldı — bir sonraki check (60sn) yeni yayın olarak işler', 'warn');
    log('Auto-launch açıksa sekme açılacak, bildirim gelecek', 'info');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function testTabGuard() {
  const slug = document.getElementById('launch-slug').value.trim() || 'kick.com';
  try {
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    const found = tabs.filter(t => (t.url || '').includes(slug));
    if (found.length > 0) {
      log('Tab guard DEVREYİ GİRER — ' + slug + ' zaten ' + found.length + ' sekmede açık', 'warn');
    } else {
      log('Tab guard devreye girmez — ' + slug + ' hiçbir sekmede açık değil', 'ok');
    }
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function checkState() {
  try {
    const local = await new Promise(r => chrome.storage.local.get(null, r));
    const sync  = await new Promise(r => chrome.storage.sync.get(null, r));
    log('LOCAL (' + Object.keys(local).length + '): ' + Object.keys(local).join(', '), 'info');
    log('SYNC (' + Object.keys(sync).length + '): ' + (Object.keys(sync).join(', ') || 'boş'), 'info');
    const autoOpen = local.autoOpenChannels || {};
    log('Auto-launch kanallar: ' + (Object.keys(autoOpen).join(', ') || 'yok'), 'info');
    const notifEnabled = await Storage.getShowNotification();
    log('Bildirim açık: ' + notifEnabled, notifEnabled ? 'ok' : 'warn');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function checkLive() {
  try {
    const d = await new Promise(r => chrome.storage.local.get(['_liveSlugs','_notifiedLives'], r));
    log('liveSlugs (' + (d._liveSlugs||[]).length + '): ' + ((d._liveSlugs||[]).join(', ') || 'boş'), 'info');
    log('notifiedLives: ' + Object.keys(d._notifiedLives||{}).length + ' kayıt', 'info');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function checkViewerHistory() {
  try {
    const d = await new Promise(r => chrome.storage.local.get('viewerHistory', r));
    const vh = d.viewerHistory || {};
    const keys = Object.keys(vh);
    log('viewerHistory — ' + keys.length + ' kanal:', 'info');
    keys.slice(0, 10).forEach(slug => {
      const rec = vh[slug];
      const cur = (rec.current || []).length;
      const past = (rec.pastAvgs || []).length;
      const peak = rec.streamPeak || '-';
      const valley = rec.streamValley || '-';
      log('  ' + slug + ': current=' + cur + ' past=' + past + ' peak=' + peak + ' valley=' + valley, 'info');
    });
    if (keys.length > 10) log('  ... ve ' + (keys.length - 10) + ' kanal daha', 'info');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function clearLiveSlugs() {
  try {
    await new Promise(r => chrome.storage.local.set({ _liveSlugs: [], _notifiedLives: {} }, r));
    log('✓ liveSlugs ve notifiedLives sıfırlandı', 'warn');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

async function clearViewerHistory() {
  try {
    await new Promise(r => chrome.storage.local.set({ viewerHistory: {} }, r));
    log('✓ viewerHistory temizlendi', 'warn');
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

// ─── E2E Test — Gerçek Akış Simülasyonu ───

function renderE2EResults(results) {
  const box = document.getElementById('e2e-results');
  if (!box) return;
  const icons = { ok: '✅', warn: '⚠️', error: '❌', running: '⏳' };
  const colors = { ok: '#53FC18', warn: '#f0a500', error: '#e74c3c', running: '#5ba4f5' };
  box.innerHTML = results.map(r =>
    `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid #1a1a1a;color:${colors[r.status] || '#888'}">` +
    `${icons[r.status] || '•'} <b>${r.step}</b> — ${r.detail}</div>`
  ).join('');
}

async function runE2E() {
  const slug = document.getElementById('e2e-slug').value.trim() || undefined;
  const box = document.getElementById('e2e-results');
  box.innerHTML = '<div style="color:#5ba4f5;font-size:11px;">⏳ Test çalışıyor — API sorgulanıyor...</div>';
  log('E2E test başlatıldı' + (slug ? ': ' + slug : ' (tüm kanallar)'), 'info');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'E2E_TEST', slug });
    if (result && result.results) {
      renderE2EResults(result.results);
      result.results.forEach(r => log(`[E2E] ${r.step}: ${r.detail}`, r.status === 'error' ? 'err' : r.status));
    } else {
      log('E2E test yanıt alınamadı', 'err');
      box.innerHTML = '<div style="color:#e74c3c;font-size:11px;">❌ Yanıt alınamadı</div>';
    }
  } catch(e) {
    log('E2E hata: ' + e.message, 'err');
    box.innerHTML = '<div style="color:#e74c3c;font-size:11px;">❌ ' + e.message + '</div>';
  }
}

async function runE2EForce() {
  const slug = document.getElementById('e2e-slug').value.trim();
  if (!slug) { log('Slug gerekli — zorla bildirim testi için kanal adı girin', 'err'); return; }
  const box = document.getElementById('e2e-results');
  box.innerHTML = '<div style="color:#5ba4f5;font-size:11px;">⏳ Zorla bildirim testi — ' + slug + ' liveSlugs\'tan çıkarılıyor...</div>';
  log('Zorla bildirim testi: ' + slug, 'warn');
  try {
    // 1. liveSlugs'tan kanalı çıkar
    const d = await new Promise(r => chrome.storage.local.get('_liveSlugs', r));
    const slugs = (d._liveSlugs || []).filter(s => s !== slug);
    await new Promise(r => chrome.storage.local.set({ _liveSlugs: slugs }, r));
    log(slug + ' liveSlugs\'tan çıkarıldı', 'ok');

    // 2. Kısa bekle sonra E2E testi çalıştır
    await new Promise(r => setTimeout(r, 500));
    const result = await chrome.runtime.sendMessage({ type: 'E2E_TEST', slug });
    if (result && result.results) {
      renderE2EResults(result.results);
      result.results.forEach(r => log(`[E2E] ${r.step}: ${r.detail}`, r.status === 'error' ? 'err' : r.status));
      log('⚡ Bir sonraki alarm (30sn) bu kanal için bildirim gönderecek', 'warn');
    }
  } catch(e) { log('Hata: ' + e.message, 'err'); }
}

// ─── Chat Notification Tests (v1.9.10) ───

async function testChatTagNotif() {
  const fromUser = document.getElementById('chat-test-user').value.trim() || 'TestKullanici';
  const channel  = document.getElementById('chat-test-channel').value.trim() || 'testkanal';
  const message  = document.getElementById('chat-test-msg').value.trim() || '@test mesaj';
  log('Tag bildirimi gönderiliyor: ' + fromUser + ' → @' + channel, 'info');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CHAT_TAG_NOTIFICATION',
      fromUser: fromUser,
      channel: channel,
      message: message,
    });
    if (result && result.success) log('✓ Tag bildirimi gönderildi', 'ok');
    else log('✗ Tag bildirimi başarısız: ' + ((result && result.error) || 'bilinmeyen hata'), 'err');
  } catch (e) {
    log('Tag bildirimi hatası: ' + e.message, 'err');
  }
}

async function testChatBroadcasterNotif() {
  const channel = document.getElementById('chat-test-channel').value.trim() || 'testkanal';
  const message = document.getElementById('chat-test-msg').value.trim() || 'Yayıncı mesajı test';
  log('Yayıncı bildirimi gönderiliyor: ' + channel, 'info');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'CHAT_BROADCASTER_NOTIFICATION',
      fromUser: channel,
      channel: channel,
      message: message,
    });
    if (result && result.success) log('✓ Yayıncı bildirimi gönderildi', 'ok');
    else log('✗ Yayıncı bildirimi başarısız: ' + ((result && result.error) || 'bilinmeyen hata'), 'err');
  } catch (e) {
    log('Yayıncı bildirimi hatası: ' + e.message, 'err');
  }
}

async function dumpChatSettings() {
  try {
    const s = await Storage.getChatSettings();
    const enabled = await Storage.getChatIntegrationEnabled();
    log('Chat Integration: ' + (enabled ? 'AÇIK' : 'KAPALI'), enabled ? 'ok' : 'warn');
    log('Ayarlar: ' + JSON.stringify(s, null, 2), 'info');
  } catch(e) { log('Dump hatası: ' + e.message, 'err'); }
}

document.addEventListener('DOMContentLoaded', async function() {
  await Utils.initI18n();
  await updateStatus();
  await updateThresholds();
  await updateDnd();

  document.getElementById('btn-e2e').addEventListener('click', runE2E);
  document.getElementById('btn-e2e-force').addEventListener('click', runE2EForce);
  document.getElementById('btn-notif').addEventListener('click', testNotification);
  document.getElementById('btn-spike').addEventListener('click', testSpikeNotif);
  document.getElementById('btn-drop').addEventListener('click', testDropNotif);
  document.getElementById('btn-sound-main').addEventListener('click', function() { playTestSound('NEW_LIVE_MAIN'); });
  document.getElementById('btn-sound-sub').addEventListener('click', function() { playTestSound('NEW_LIVE_SUB'); });
  document.getElementById('btn-api-check').addEventListener('click', checkApi);
  document.getElementById('btn-api-token').addEventListener('click', checkToken);
  document.getElementById('btn-launch-trigger').addEventListener('click', simulateLaunch);
  document.getElementById('btn-tab-guard').addEventListener('click', testTabGuard);
  document.getElementById('btn-state').addEventListener('click', checkState);
  document.getElementById('btn-live').addEventListener('click', checkLive);
  document.getElementById('btn-viewer-hist').addEventListener('click', checkViewerHistory);
  document.getElementById('btn-clear').addEventListener('click', clearLiveSlugs);
  document.getElementById('btn-clear-vh').addEventListener('click', clearViewerHistory);

  // Chat notification tests (v1.9.10)
  document.getElementById('btn-chat-tag')?.addEventListener('click', testChatTagNotif);
  document.getElementById('btn-chat-broadcaster')?.addEventListener('click', testChatBroadcasterNotif);
  document.getElementById('btn-chat-dump')?.addEventListener('click', dumpChatSettings);
});
