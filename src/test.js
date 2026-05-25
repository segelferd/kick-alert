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
    // v2.3.1 redesign: Eski #status-row kaldırıldı (Health Header onun yerini aldı).
    // Bu fonksiyon eski yapı için sessizce no-op olur — yine de bilgileri logla.
    const row = document.getElementById('status-row');
    if (row) {
      row.innerHTML =
        '<div class="status-pill">Tarayıcı: <span>' + (isFF ? '🦊 Firefox' : '🟢 Chrome') + '</span></div>' +
        '<div class="status-pill">Bildirim: <span>' + (showNotif ? '✓ Açık' : '✗ Kapalı') + '</span></div>' +
        '<div class="status-pill">Ses: <span>' + soundMode + ' %' + volume + '</span></div>' +
        '<div class="status-pill">Anomali: <span>' + (settings.enabled ? '✓ Açık' : '✗ Kapalı') + '</span></div>' +
        '<div class="status-pill">DND: <span>' + (dndActive ? '🔴 Aktif' : '⚪ Kapalı') + '</span></div>';
    }
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

// v2.3.1 Plan F: Pusher WebSocket sağlık kontrolü.
// Offscreen LiveTracker'ın bağlı olup olmadığını, kaç kanal takip ettiğini,
// kaç event aldığını ve channel_id cache durumunu raporlar.
async function checkPusher() {
  try {
    log('── Plan F (Pusher WebSocket) sağlık kontrolü ──', 'info');

    // 1) Pusher state (offscreen LiveTracker veya Firefox SW Pusher)
    const resp = await chrome.runtime.sendMessage({ type: 'GET_PUSHER_STATE' });
    if (!resp || !resp.success) {
      log('✗ Pusher state alınamadı: ' + (resp?.error || 'yanıt yok'), 'err');
    } else {
      const mode = resp.mode || '?';
      const st = resp.state || {};
      log('Mod: ' + mode + (mode === 'offscreen' ? ' (WebSocket offscreen\'de)' : ' (WebSocket SW\'de)'), 'info');
      log((st.connected ? '✓' : '✗') + ' WebSocket bağlı: ' + !!st.connected, st.connected ? 'ok' : 'err');
      log('Takip edilen kanal (subscribe): ' + (st.trackedCount ?? '?'), 'info');
      if (st.subscribedCount != null) log('Aktif subscription: ' + st.subscribedCount, 'info');
      if (st.stats) {
        log('İstatistik — bağlantı: ' + (st.stats.connects ?? 0) +
            ', canlı event: ' + (st.stats.liveEvents ?? 0) +
            ', offline event: ' + (st.stats.offlineEvents ?? 0) +
            ', toplam mesaj: ' + (st.stats.messages ?? 0), 'info');
      }
    }

    // 2) channel_id cache durumu (Plan F'in yakıtı)
    const cache = await Storage.getChannelIdCache();
    const cacheKeys = Object.keys(cache || {});
    log('channel_id cache: ' + cacheKeys.length + ' kanal', cacheKeys.length > 0 ? 'ok' : 'warn');

    // 2b) SW-tarafı Plan F durumu (_pusherLiveSlugs — Pusher'ın canlı bildiği kanallar)
    if (resp?.swState) {
      const sw = resp.swState;
      log('Pusher-canlı işaretli kanal (_pusherLiveSlugs): ' + (sw.pusherLiveCount ?? 0),
          'info');
      if (sw.pusherLiveCount > 0) {
        log('  → ' + (sw.pusherLiveSlugs || []).slice(0, 10).join(', '), 'info');
      }
    }

    // 3) Takip edilen kanallardan kaçının channel_id'si eksik?
    const channels = await new Promise(r => chrome.storage.local.get('_cachedChannels', r));
    const followed = (channels._cachedChannels || []).map(c => c.channelSlug).filter(Boolean);
    if (followed.length > 0) {
      const missing = followed.filter(s => !(s in (cache || {})));
      log('Takip edilen: ' + followed.length + ', channel_id eksik: ' + missing.length,
          missing.length === 0 ? 'ok' : 'warn');
      if (missing.length > 0) {
        log('  Eksik kanallar (Pusher dinleyemiyor): ' + missing.slice(0, 10).join(', ') +
            (missing.length > 10 ? ' ...' : ''), 'warn');
        log('  → Bu kanalların sayfasını ziyaret edersen channel_id otomatik toplanır', 'info');
      }
    }

    // 4) Genel sağlık yorumu
    if (resp?.success && resp.state?.connected && cacheKeys.length > 0) {
      log('✓ Plan F sağlıklı — Pusher bağlı, channel_id cache dolu', 'ok');
    } else if (resp?.success && !resp.state?.connected) {
      log('⚠ Pusher bağlı değil — polling yedeğe düşülmüş olabilir (403 riski)', 'warn');
    }

    // 5) E2E fonksiyonel test — bildirim akışı çalışıyor mu? (dryRun: state kirletmez)
    log('── Plan F bildirim akışı testi (dryRun) ──', 'info');
    const e2e = await chrome.runtime.sendMessage({ type: 'PUSHER_E2E_TEST', dryRun: true });
    if (e2e?.results) {
      for (const r of e2e.results) {
        log('  [' + r.step + '] ' + r.detail, r.status === 'error' ? 'err' : (r.status === 'warn' ? 'warn' : 'ok'));
      }
    } else {
      log('  E2E testi yanıt vermedi', 'warn');
    }
    log('İpucu: Gerçek bildirim testi için konsola: chrome.runtime.sendMessage({type:\'PUSHER_E2E_TEST\'}) — dryRun olmadan bildirim gönderir', 'info');
  } catch(e) {
    log('Plan F kontrol hatası: ' + e.message, 'err');
  }
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
  // v2.3.1 redesign: Bu fonksiyon artık doğrudan çağrılmıyor — Senaryo 3 (📺 Yayın Algılama)
  // SCENARIOS.detection üzerinden E2E_TEST mesajını atıyor. Eski kodu defansif tutuyoruz.
  const slug = document.getElementById('e2e-slug')?.value?.trim() || undefined;
  const box = document.getElementById('e2e-results');
  if (!box) { log('E2E: eski UI elementleri yok, runScenario("detection") kullan', 'err'); return; }
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
  // v2.3.1 redesign: Aynı şekilde ölü kod, defansif tutuluyor.
  const slug = document.getElementById('e2e-slug')?.value?.trim();
  if (!slug) { log('Slug gerekli — zorla bildirim testi için kanal adı girin', 'err'); return; }
  const box = document.getElementById('e2e-results');
  if (!box) { log('E2EForce: eski UI elementleri yok', 'err'); return; }
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

  // v2.3.1 redesign: TÜM eski button listener'ları opsiyonel zincirli (?.).
  // Bazı butonlar yeni UI'da yok (btn-e2e, btn-e2e-force, btn-api-check, btn-api-token —
  // bunların yerine senaryo kartları geçti), eski varsayılı kod buralarda null hatası
  // verirse tüm init kırılıyordu. ?. ile sessiz no-op olur.
  document.getElementById('btn-e2e')?.addEventListener('click', runE2E);
  document.getElementById('btn-e2e-force')?.addEventListener('click', runE2EForce);
  document.getElementById('btn-notif')?.addEventListener('click', testNotification);
  document.getElementById('btn-spike')?.addEventListener('click', testSpikeNotif);
  document.getElementById('btn-drop')?.addEventListener('click', testDropNotif);
  document.getElementById('btn-sound-main')?.addEventListener('click', function() { playTestSound('NEW_LIVE_MAIN'); });
  document.getElementById('btn-sound-sub')?.addEventListener('click', function() { playTestSound('NEW_LIVE_SUB'); });
  document.getElementById('btn-api-check')?.addEventListener('click', checkApi);
  document.getElementById('btn-api-token')?.addEventListener('click', checkToken);
  document.getElementById('btn-launch-trigger')?.addEventListener('click', simulateLaunch);
  document.getElementById('btn-tab-guard')?.addEventListener('click', testTabGuard);
  document.getElementById('btn-state')?.addEventListener('click', checkState);
  document.getElementById('btn-live')?.addEventListener('click', checkLive);
  document.getElementById('btn-pusher')?.addEventListener('click', checkPusher);
  document.getElementById('btn-viewer-hist')?.addEventListener('click', checkViewerHistory);
  document.getElementById('btn-clear')?.addEventListener('click', clearLiveSlugs);
  document.getElementById('btn-clear-vh')?.addEventListener('click', clearViewerHistory);

  // Chat notification tests (v1.9.10)
  document.getElementById('btn-chat-tag')?.addEventListener('click', testChatTagNotif);
  document.getElementById('btn-chat-broadcaster')?.addEventListener('click', testChatBroadcasterNotif);
  document.getElementById('btn-chat-dump')?.addEventListener('click', dumpChatSettings);

  // ═══════════════════════════════════════════════════════════════════════════
  // v2.3.1 Diagnostic Panel — Initialize
  // ═══════════════════════════════════════════════════════════════════════════
  initDiagnosticPanel();
});

// ═══════════════════════════════════════════════════════════════════════════════
// v2.3.1 DIAGNOSTIC PANEL FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

const dlog = (msg, type) => {
  // v2.3.1 redesign: Ayrı diag-log artık yok; tek log kutusuna yaz.
  // Geriye dönük uyumluluk için fonksiyon kalsın, davranışı log()'a yönlendir.
  const box = document.getElementById('diag-log') || document.getElementById('log');
  if (!box) return;
  const t = new Date().toLocaleTimeString();
  const cls = type || 'info';
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = `[${t}] ${msg}`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  // Trim to last 100 entries
  while (box.children.length > 100) box.removeChild(box.firstChild);
};

const fmtMs = (ms) => {
  if (!ms || ms < 0) return '0s';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return Math.round(ms / 1000) + 's';
  return Math.round(ms / 60000) + 'm';
};

const fmtBytes = (b) => {
  if (!b) return '0 B';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(2) + ' MB';
};

const fmtTimestamp = (ts) => {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString();
};

// ─── API Test ───
async function diagApiTest() {
  dlog('📡 API testi başlatılıyor...', 'info');
  const result = await chrome.runtime.sendMessage({ type: 'RUN_API_TEST' });
  const box = document.getElementById('diag-api-result');
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ Hata: ${result?.error || 'bilinmiyor'}</span>`;
    dlog(`API test FAIL: ${result?.error}`, 'err');
    return;
  }
  const statusColor = result.status === 200 ? '#53FC18' : '#e74c3c';
  box.innerHTML = `
    <div>Status: <span style="color:${statusColor};font-weight:600;">${result.status}</span> · Süre: ${result.elapsedMs}ms · Kanal sayısı: ${result.channelCount}</div>
    <div style="color:#666;font-size:10px;margin-top:4px;">${new Date().toLocaleTimeString()} · /api/v2/channels/followed</div>
  `;
  dlog(`API test: ${result.status} (${result.elapsedMs}ms, ${result.channelCount} kanal)`, result.status === 200 ? 'ok' : 'err');
  refreshDiagStatus();
}

// ─── Rate Test ───
async function diagRateTest() {
  dlog('📡 Rate test başladı (5 istek × 5sn)...', 'info');
  const box = document.getElementById('diag-api-result');
  box.innerHTML = '<span style="color:#888;">Çalışıyor... ~25 saniye sürer</span>';

  const result = await chrome.runtime.sendMessage({ type: 'RUN_RATE_TEST', count: 5, delayMs: 5000 });
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ Hata: ${result?.error}</span>`;
    return;
  }
  const okPct = Math.round((result.okCount / result.total) * 100);
  const color = okPct === 100 ? '#53FC18' : okPct >= 60 ? '#f0a500' : '#e74c3c';
  let detail = result.results.map(r =>
    `<div>Test ${r.i}: <span style="color:${r.status === 200 ? '#53FC18' : '#e74c3c'}">${r.status || 'FAIL'}</span> (${r.elapsedMs}ms)</div>`
  ).join('');
  box.innerHTML = `
    <div style="color:${color};font-weight:600;">Başarı: ${result.okCount}/${result.total} (${okPct}%)</div>
    <div style="margin-top:6px;font-size:10px;">${detail}</div>
  `;
  dlog(`Rate test sonucu: ${result.okCount}/${result.total} OK (${okPct}%)`, okPct === 100 ? 'ok' : 'warn');
}

// ─── Manuel session refresh ───
async function diagManualRefresh() {
  dlog('🔄 Manuel session refresh çağrılıyor...', 'info');
  const result = await chrome.runtime.sendMessage({ type: 'MANUAL_SESSION_REFRESH' });
  const box = document.getElementById('diag-api-result');
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ ${result?.error}</span>`;
    dlog(`Refresh FAIL: ${result?.error}`, 'err');
    return;
  }
  const color = result.refreshed ? '#53FC18' : '#f0a500';
  box.innerHTML = `<span style="color:${color};">Refresh ${result.refreshed ? '✅ başarılı' : '⚠ başarısız'} (${result.elapsedMs}ms)</span>`;
  dlog(`Session refresh: ${result.refreshed ? 'OK' : 'FAIL'} (${result.elapsedMs}ms)`, result.refreshed ? 'ok' : 'warn');
}

// ─── Backoff durumu ───
async function diagBackoffStatus() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_BACKOFF_STATUS' });
  const box = document.getElementById('diag-backoff-result');
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ ${result?.error}</span>`;
    return;
  }
  const lines = [];
  if (result.active) {
    lines.push(`<span style="color:#e74c3c;">🔴 BACKOFF AKTIF — ${fmtMs(result.remainingMs)} kaldı</span>`);
  } else {
    lines.push(`<span style="color:#53FC18;">✅ Backoff temiz</span>`);
  }
  if (result.lastBackoffDuration) {
    lines.push(`<div style="color:#888;">Son backoff süresi: ${fmtMs(result.lastBackoffDuration)}</div>`);
  }
  if (result.lastBackoffEndTime) {
    lines.push(`<div style="color:#888;">Son backoff bitiş: ${fmtTimestamp(result.lastBackoffEndTime)}</div>`);
  }
  if (result.lastSessionRefreshAt) {
    lines.push(`<div style="color:#888;">Son session refresh: ${fmtTimestamp(result.lastSessionRefreshAt)}</div>`);
  }
  if (result.lastAuthWarnAt) {
    lines.push(`<div style="color:#888;">Son 403 uyarısı: ${fmtTimestamp(result.lastAuthWarnAt)}</div>`);
  }
  box.innerHTML = lines.join('');
  dlog(`Backoff durumu: ${result.active ? 'AKTIF (' + fmtMs(result.remainingMs) + ')' : 'temiz'}`, result.active ? 'warn' : 'ok');
  refreshDiagStatus();
}

// ─── Backoff temizle ───
async function diagClearBackoff() {
  const result = await chrome.runtime.sendMessage({ type: 'RESET_BACKOFF' });
  if (result?.success) {
    dlog('✅ Backoff sıfırlandı', 'ok');
    diagBackoffStatus();
  } else {
    dlog('❌ Backoff sıfırlama başarısız', 'err');
  }
}

// ─── Force re-check ───
async function diagForceRecheck() {
  dlog('⚡ Force re-check başlatılıyor...', 'info');
  const result = await chrome.runtime.sendMessage({ type: 'FORCE_RECHECK' });
  if (result?.success) {
    dlog('✅ Re-check tamamlandı', 'ok');
    setTimeout(() => refreshDiagStatus(), 500);
  } else {
    dlog(`❌ Re-check hatası: ${result?.error}`, 'err');
  }
}

// ─── Cookie tablosu ───
async function diagCookies(silent = false) {
  const result = await chrome.runtime.sendMessage({ type: 'GET_COOKIES' });
  const box = document.getElementById('diag-cookies-table');
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ ${result?.error}</span>`;
    return;
  }
  if (!result.cookies.length) {
    box.innerHTML = '<span style="color:#888;">Cookie bulunamadı (Kick.com\'a giriş yapılmamış olabilir)</span>';
    return;
  }
  const now = Date.now();
  const rows = result.cookies.map(c => {
    let expStr = 'session';
    let expColor = '#888';
    if (c.expires) {
      const remainingMs = c.expires - now;
      if (remainingMs < 0) {
        expStr = '⚠ EXPIRED';
        expColor = '#e74c3c';
      } else if (remainingMs < 30 * 60 * 1000) {
        expStr = '⚠ ' + fmtMs(remainingMs);
        expColor = '#f0a500';
      } else {
        expStr = new Date(c.expires).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
      }
    }
    const flags = [];
    if (c.httpOnly) flags.push('HttpOnly');
    if (c.secure) flags.push('Secure');
    return `<tr>
      <td style="color:${c.name.startsWith('__cf') || c.name === 'cf_clearance' ? '#f0a500' : '#aaa'};">${c.name}</td>
      <td>${c.length}</td>
      <td style="color:${expColor};">${expStr}</td>
      <td style="color:#666;font-size:10px;">${flags.join(', ')}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <table class="thresh-table" style="width:100%;">
      <thead>
        <tr><th>Cookie</th><th>Boyut</th><th>Süre</th><th>Bayraklar</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="color:#666;font-size:10px;margin-top:6px;">${result.cookies.length} cookie</div>
  `;
  // v2.3.1 fix: Periyodik çağrılarda (her 60sn) log yazmasın — sadece manuel butonda
  if (!silent) dlog(`${result.cookies.length} cookie listelendi`, 'info');
}

// ─── Canlı kanal tablosu (anomaly) ───
async function diagChannels() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_ANOMALY_TABLE' });
  const box = document.getElementById('diag-channels-table');
  if (!result?.success) {
    box.innerHTML = `<span style="color:#e74c3c;">❌ ${result?.error}</span>`;
    return;
  }
  if (!result.channels.length) {
    box.innerHTML = '<span style="color:#888;">Canlı kanal yok</span>';
    return;
  }
  const rows = result.channels.map(c => {
    const rocColor = c.roc > 30 ? '#53FC18' : c.roc < -30 ? '#e74c3c' : '#aaa';
    return `<tr>
      <td>${c.user || c.slug}</td>
      <td><strong style="color:#5ba4f5;">${c.viewers?.toLocaleString('tr-TR') || '—'}</strong></td>
      <td style="color:${rocColor};">${c.roc != null ? c.roc + '%' : '—'}</td>
      <td>${c.valley?.toLocaleString('tr-TR') || '—'}</td>
      <td>${c.peak?.toLocaleString('tr-TR') || '—'}</td>
      <td style="color:#666;">${c.ageMin != null ? c.ageMin + 'd' : '—'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <table class="thresh-table" style="width:100%;">
      <thead>
        <tr><th>Kanal</th><th>İzleyici</th><th>ROC</th><th>Valley</th><th>Peak</th><th>Yaş</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="color:#666;font-size:10px;margin-top:6px;">${result.channels.length} canlı kanal</div>
  `;
  dlog(`${result.channels.length} canlı kanal listelendi`, 'info');
}

// ─── Bot skorları ───
async function diagBotScores() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_BOT_SCORES' });
  const box = document.getElementById('diag-channels-table');
  if (!result?.scores) {
    box.innerHTML = '<span style="color:#888;">Bot skorları henüz hazır değil (yeterli veri yok)</span>';
    dlog('Bot skorları boş', 'warn');
    return;
  }
  const slugs = Object.keys(result.scores);
  if (!slugs.length) {
    box.innerHTML = '<span style="color:#888;">Bot skoru kaydı yok</span>';
    return;
  }
  const rows = slugs.map(slug => {
    const s = result.scores[slug];
    const score = s?.score ?? null;
    const color = score > 70 ? '#e74c3c' : score > 40 ? '#f0a500' : '#53FC18';
    return `<tr>
      <td>${slug}</td>
      <td style="color:${color};font-weight:600;">${score != null ? score + '%' : '—'}</td>
      <td style="color:#888;font-size:10px;">${s?.lastUpdate ? fmtTimestamp(s.lastUpdate) : '—'}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `
    <table class="thresh-table" style="width:100%;">
      <thead><tr><th>Kanal</th><th>Bot Skoru</th><th>Son güncelleme</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div style="color:#666;font-size:10px;margin-top:6px;">${slugs.length} kanal skorlu</div>
  `;
  dlog(`${slugs.length} bot skoru listelendi`, 'info');
}

// ─── Hızlı ayar — interval değiştir ───
async function diagSetInterval() {
  const sec = parseInt(document.getElementById('diag-interval-select').value);
  await chrome.storage.local.set({ checkInterval: sec });
  dlog(`✅ Check aralığı ${sec} sn olarak ayarlandı`, 'ok');
  setTimeout(() => refreshDiagStatus(), 500);
}

// ─── Eklentiyi yeniden başlat ───
async function diagReloadExt() {
  if (!confirm('Eklenti yeniden başlatılacak. Devam?')) return;
  dlog('🔁 Eklenti yeniden başlatılıyor...', 'warn');
  setTimeout(() => chrome.runtime.reload(), 500);
}

// ─── Sağlık motoru: Tüm verileri toplayıp tek bir karar üretir ───
//
// evaluateHealth(data) çıktısı:
//   {
//     status: 'healthy' | 'warning' | 'critical',
//     statusText: 'SAĞLIKLI' | 'DİKKAT' | 'SORUN',
//     icon: '🟢' | '🟡' | '🔴',
//     issues: [{tab: 'tani'|'api'|'kanallar'|'ayarlar', severity: 'warn'|'crit', message: '...'}],
//     suggestion: 'Önerilen aksiyon...' | null
//   }
function evaluateHealth(data) {
  const issues = [];
  // ─── Critical kurallar ───
  if (data.dnr && !data.dnr.staticRulesetActive) {
    issues.push({ tab: 'api', severity: 'crit',
      message: 'Origin override (DNR) PASİF — 403 yağmuru gelebilir' });
  }
  if (data.stats && data.stats.requests >= 5 && data.stats.successRate !== null && data.stats.successRate < 50) {
    issues.push({ tab: 'tani', severity: 'crit',
      message: `Başarı oranı kritik düşük (${data.stats.successRate}%) — son 5dk'da ${data.stats.failures} hata` });
  }
  if (data.diag && !data.diag.alarm) {
    issues.push({ tab: 'ayarlar', severity: 'crit',
      message: 'Ana alarm zamanlanmamış — eklenti istek atmıyor' });
  }
  if (data.stats && data.stats.failures >= 5) {
    issues.push({ tab: 'tani', severity: 'crit',
      message: `Son 5dk'da ${data.stats.failures} hata — 401/403 yağmuru aktif` });
  }

  // ─── Warning kurallar ───
  if (data.backoff && data.backoff.active) {
    const mins = Math.round((data.backoff.remainingMs || 0) / 60000);
    if (mins >= 10) {
      issues.push({ tab: 'tani', severity: 'crit',
        message: `Backoff zinciri yükseliyor (${mins} dk kaldı) — Cloudflare baskısı yüksek` });
    } else {
      issues.push({ tab: 'tani', severity: 'warn',
        message: `Backoff aktif (${mins} dk kaldı) — istekler geçici askıda` });
    }
  }
  if (data.stats && data.stats.failures >= 2 && data.stats.failures < 5) {
    issues.push({ tab: 'tani', severity: 'warn',
      message: `Son 5dk'da ${data.stats.failures} hata — M4 yavaşlatma tetikli` });
  }
  if (data.stats && data.stats.slowModeActive) {
    issues.push({ tab: 'tani', severity: 'warn',
      message: `Yavaşlatma modu aktif (aralık ${data.stats.effectiveSecs}sn'ye yükseldi)` });
  }
  if (data.cookies) {
    const cfClear = data.cookies.find(c => c.name === 'cf_clearance');
    const cfBm = data.cookies.find(c => c.name === '__cf_bm');
    if (data.stats && data.stats.failures > 0 && !cfClear) {
      issues.push({ tab: 'api', severity: 'warn',
        message: 'cf_clearance cookie eksik (hata varken) — Cloudflare challenge eksiği' });
    }
    // Backend GET_COOKIES döndürürken expires alanını ms cinsinden veriyor
    if (cfBm && cfBm.expires) {
      const remainingMin = (cfBm.expires - Date.now()) / 60000;
      if (remainingMin > 0 && remainingMin < 5) {
        issues.push({ tab: 'api', severity: 'warn',
          message: `__cf_bm cookie ${Math.round(remainingMin)} dk içinde expire olacak` });
      }
    }
  }
  // v2.3.1: 60sn altı uyarısı kaldırıldı. Patron 30sn'yi bilerek kullanıyor,
  // M4 yavaşlatma sorun çıkınca zaten devreye giriyor. Sürekli 'DİKKAT' göstermesi
  // gerçek sorun sinyalini boğuyordu.

  // Plan C — Hata varken proxy kapalıysa kullanıcıya çözüm yolu sun
  if (data.stats && data.stats.failures >= 2 && data.stats.proxyAvailable === false) {
    issues.push({ tab: 'tani', severity: 'warn',
      message: 'Plan C proxy kapalı — kick.com sekmesi açık tutarsan API çağrıları o sekmeden geçer (Cloudflare baskısı kırılır)' });
  }

  // ─── v2.3.1 Plan F (Pusher WebSocket) sağlık kuralları ───
  if (data.pusher && data.pusher.state) {
    const ps = data.pusher.state;
    if (!ps.connected) {
      // Pusher kopuk. Eğer aynı anda 403 baskısı varsa KRİTİK (gerçekten körüz):
      // polling 403 alıyor + Pusher de yok = yeni yayın bildirimi gelmeyebilir.
      const apiStruggling = data.stats && data.stats.failures >= 2;
      issues.push({ tab: 'tani', severity: apiStruggling ? 'crit' : 'warn',
        message: apiStruggling
          ? 'Plan F (Pusher) bağlı DEĞİL + API 403 alıyor — yeni yayın bildirimi kaçabilir!'
          : 'Plan F (Pusher) bağlı değil — şu an polling yedekte, ama 403 gelirse risk' });
    } else if (ps.trackedCount === 0) {
      issues.push({ tab: 'tani', severity: 'warn',
        message: 'Plan F bağlı ama 0 kanal dinliyor — channel_id cache boş olabilir (kanal sayfalarını ziyaret et)' });
    }
  } else if (data.pusher === null) {
    // GET_PUSHER_STATE yanıt vermedi — offscreen/SW Pusher erişilemiyor olabilir
    issues.push({ tab: 'tani', severity: 'warn',
      message: 'Plan F durumu okunamadı — Pusher modülü yanıt vermiyor olabilir' });
  }

  // ─── Karar ───
  const hasCrit = issues.some(i => i.severity === 'crit');
  const hasWarn = issues.some(i => i.severity === 'warn');

  let status, statusText, icon, suggestion;
  if (hasCrit) {
    status = 'critical'; statusText = 'SORUN'; icon = '🔴';
  } else if (hasWarn) {
    status = 'warning'; statusText = 'DİKKAT'; icon = '🟡';
  } else {
    status = 'healthy'; statusText = 'SAĞLIKLI'; icon = '🟢';
  }

  // Öneri motoru — en yüksek öncelikli sorun için somut aksiyon
  if (issues.length > 0) {
    const top = issues.find(i => i.severity === 'crit') || issues[0];
    if (top.message.includes('DNR')) {
      suggestion = 'rules.json yüklü değil. Eklentiyi yeniden yükle (chrome://extensions → Reload).';
    } else if (top.message.includes('Backoff zinciri')) {
      suggestion = 'Backoff sıfırla butonuna bas, sonra Manuel Refresh dene. Sorun sürerse 5 dk bekle.';
    } else if (top.message.includes('Backoff aktif')) {
      suggestion = 'Backoff bitmesini bekle veya manuel olarak sıfırla (test amaçlı).';
    } else if (top.message.includes('alarm zamanlanmamış')) {
      suggestion = 'Eklentiyi yeniden başlat — Ayarlar sekmesindeki "Eklentiyi Yeniden Başlat" butonu.';
    } else if (top.message.includes('cf_clearance')) {
      suggestion = 'kick.com sekmesinde manuel olarak gezin (CF challenge\'ı çözmek için), sonra Manuel Refresh.';
    } else if (top.message.includes('cf_bm')) {
      suggestion = 'Otomatik proactive_25min refresh yakında çalışacak; manuel refresh isteğe bağlı.';
    } else if (top.message.includes('yağmuru') || top.message.includes('kritik düşük')) {
      suggestion = 'Cloudflare baskısı altındasın. Backoff sıfırla → 5x Rate Test çalıştır → sonuca göre kararla.';
    } else if (top.message.includes('yavaşlatma yakın')) {
      suggestion = 'Failure 3+ olunca aralık otomatik 2x\'e çıkacak. Şu an izle; manuel müdahale gerekmiyor.';
    } else if (top.message.includes('Aralık')) {
      suggestion = 'Ayarlar → Check Aralığı → 60 sn\'ye yükselt.';
    } else if (top.message.includes('Plan C proxy')) {
      suggestion = 'Cloudflare baskısı varsa kick.com sekmesini açık tut — API çağrıları o sekmeden geçer, 403 baskısı kırılır.';
    } else {
      suggestion = 'Yukarıdaki sorun(lar)ı incele. Sorunlu sekme(ler) sekme barında işaretli.';
    }
  } else {
    suggestion = null;
  }

  return { status, statusText, icon, issues, suggestion };
}

// ─── Health header'ı ekrana yansıt ───
function renderHealthHeader(health, data) {
  const header = document.getElementById('health-header');
  const statusEl = document.getElementById('health-status');
  const iconEl = document.getElementById('health-icon');
  const textEl = document.getElementById('health-text');
  const issuesEl = document.getElementById('health-issues');
  const issuesList = document.getElementById('health-issues-list');
  const sugEl = document.getElementById('health-suggestion');

  if (!header || !statusEl) return;

  // Renk sınıfını uygula
  ['healthy', 'warning', 'critical'].forEach(c => {
    header.classList.remove(c);
    statusEl.classList.remove(c);
  });
  header.classList.add(health.status);
  statusEl.classList.add(health.status);

  iconEl.textContent = health.icon;
  textEl.textContent = health.statusText;

  // Metric değerleri
  const setMetric = (id, value, level) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = value;
    const parent = el.parentElement;
    if (parent) {
      parent.classList.remove('ok', 'warn', 'fail');
      if (level) parent.classList.add(level);
    }
  };
  if (data.stats) {
    const rate = data.stats.successRate;
    setMetric('m-success',
      rate === null ? '—' : (rate + '%'),
      rate === null ? null : (rate >= 90 ? 'ok' : rate >= 50 ? 'warn' : 'fail'));
    setMetric('m-failures',
      data.stats.failures + '',
      data.stats.failures === 0 ? 'ok' : data.stats.failures < 2 ? null : data.stats.failures < 5 ? 'warn' : 'fail');
    const mode = getModeLabel(data.stats);
    setMetric('m-mode', mode.short, mode.color === 'warn' ? 'warn' : 'ok');
    setMetric('m-interval', (data.stats.effectiveSecs || 0) + 'sn', null);
    // Plan C — proxy durumu
    if (data.stats.proxyAvailable) {
      setMetric('m-proxy', '🛡️ Aktif', 'ok');
    } else {
      setMetric('m-proxy', '⚠ SW', null); // 'warn' değil — sadece bilgi rengi
    }
  }
  if (data.backoff) {
    setMetric('m-backoff',
      data.backoff.active ? ('🔴 ' + fmtMs(data.backoff.remainingMs || 0)) : 'yok',
      data.backoff.active ? 'fail' : 'ok');
  }

  // v2.3.1 Plan F — Pusher WebSocket durumu
  if (data.pusher && data.pusher.state) {
    const ps = data.pusher.state;
    if (ps.connected) {
      setMetric('m-pusher', '🟢 ' + (ps.trackedCount ?? 0), 'ok');
    } else {
      setMetric('m-pusher', '🔴 kopuk', 'fail');
    }
  } else {
    setMetric('m-pusher', '—', null);
  }

  // Issue listesi
  if (health.issues.length > 0) {
    issuesEl.classList.add('show');
    issuesEl.classList.remove('warning', 'critical');
    issuesEl.classList.add(health.status === 'critical' ? 'critical' : 'warning');
    issuesList.innerHTML = health.issues
      .map(i => `<li>${i.severity === 'crit' ? '🔴' : '🟡'} ${i.message}</li>`)
      .join('');
    if (health.suggestion) {
      sugEl.innerHTML = '<strong>💡 Öneri:</strong> ' + health.suggestion;
      sugEl.style.display = 'block';
    } else {
      sugEl.style.display = 'none';
    }
  } else {
    issuesEl.classList.remove('show');
  }

  // Sekmelere uyarı noktası koy
  const tabIssues = {};
  health.issues.forEach(i => {
    const sev = tabIssues[i.tab] || 'warn';
    tabIssues[i.tab] = (i.severity === 'crit' || sev === 'crit') ? 'crit' : 'warn';
  });
  ['tani', 'api', 'kanallar', 'ayarlar'].forEach(tab => {
    const dot = document.getElementById('dot-' + tab);
    if (!dot) return;
    dot.classList.remove('warn', 'crit');
    if (tabIssues[tab]) dot.classList.add(tabIssues[tab]);
  });
}

// ─── Tanı sekmesindeki büyük stat kartlarını güncelle ───
//
// v2.3.1: Mod rozeti M4 (failure-based slow) + M5 (peak hour) iki kaynaktan beslenir.
// Helper fonksiyonu tek noktadan etiket üretir.
function getModeLabel(stats) {
  if (!stats) return { text: '—', color: 'ok', short: '—' };
  if (stats.slowModeActive) {
    return { text: '🐢 Yavaşlatma (M4)', color: 'warn', short: '🐢 Yavaş' };
  }
  if (stats.peakModeActive) {
    return { text: '🌙 Peak saat (M5)', color: 'warn', short: '🌙 Peak' };
  }
  return { text: '✓ Normal', color: 'ok', short: '✓ Normal' };
}

function renderBigStats(data) {
  const setBig = (id, value, sub, level) => {
    const card = document.getElementById(id);
    const valEl = document.getElementById(id + '-val');
    const subEl = document.getElementById(id + '-sub');
    if (!card || !valEl) return;
    valEl.textContent = value;
    if (subEl && sub !== undefined) subEl.textContent = sub;
    card.classList.remove('ok', 'warn', 'fail');
    if (level) card.classList.add(level);
  };

  if (data.stats) {
    const r = data.stats.successRate;
    setBig('bs-rate',
      r === null ? '—' : (r + '%'),
      undefined,
      r === null ? null : r >= 90 ? 'ok' : r >= 50 ? 'warn' : 'fail');
    setBig('bs-failures',
      data.stats.failures + '',
      data.stats.requests > 0 ? `${data.stats.requests} istekten` : 'henüz istek yok',
      data.stats.failures === 0 ? 'ok' : data.stats.failures < 2 ? null : data.stats.failures < 5 ? 'warn' : 'fail');
    const modeForCard = getModeLabel(data.stats);
    setBig('bs-interval',
      (data.stats.effectiveSecs || 0) + 'sn',
      data.stats.slowModeActive ? '🐢 yavaşlatma (M4)' :
      data.stats.peakModeActive ? '🌙 peak saat (M5)' : 'normal',
      modeForCard.color === 'warn' ? 'warn' : 'ok');
  }
  if (data.backoff) {
    if (data.backoff.active) {
      const mins = Math.round((data.backoff.remainingMs || 0) / 60000);
      setBig('bs-backoff',
        fmtMs(data.backoff.remainingMs || 0),
        mins >= 10 ? 'kritik' : 'aktif',
        mins >= 10 ? 'fail' : 'warn');
    } else {
      setBig('bs-backoff', 'yok', 'temiz', 'ok');
    }
  }
}

// ─── Status pills + sistem bilgisi yenile (yeniden yazıldı) ───
async function refreshDiagStatus() {
  // Bütün veri kaynaklarını paralel topla
  const [bo, st, dnr, stats, cookieResp, pusher] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_BACKOFF_STATUS' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'GET_DIAG_STATS' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'GET_DNR_RULES' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'GET_RECENT_API_STATS', windowMin: 5 }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'GET_COOKIES' }).catch(() => null),
    chrome.runtime.sendMessage({ type: 'GET_PUSHER_STATE' }).catch(() => null),
  ]);

  const data = {
    backoff: (bo?.success) ? bo : null,
    diag:    (st?.success) ? st : null,
    dnr:     (dnr?.success) ? dnr : null,
    stats:   (stats?.success) ? stats : null,
    cookies: (cookieResp?.success) ? cookieResp.cookies : null,
    pusher:  (pusher?.success) ? pusher : null, // v2.3.1 Plan F sağlık verisi
  };

  // ─── Detaylı son 5dk paneli (Tanı sekmesi alt blok) ───
  if (data.stats) {
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText('stat-req', data.stats.requests);
    setText('stat-ok', data.stats.successes);
    setText('stat-fail', data.stats.failures);
    setText('stat-rate', data.stats.successRate === null ? '—' : (data.stats.successRate + '%'));
    setText('stat-jitter-avg', data.stats.jitterSamples > 0 ? (data.stats.avgJitterMs + ' ms') : '—');
    setText('stat-jitter-max', data.stats.jitterSamples > 0 ? (data.stats.maxJitterMs + ' ms') : '—');
    setText('stat-effective-secs', (data.stats.effectiveSecs || 0) + ' sn');

    const modeEl = document.getElementById('diag-stats-mode');
    if (modeEl) {
      const mode = getModeLabel(data.stats);
      modeEl.textContent = mode.text;
      modeEl.style.color = mode.color === 'warn' ? '#f0a500' : '#53FC18';
    }
    const rateEl = document.getElementById('stat-rate');
    if (rateEl && data.stats.successRate !== null) {
      if (data.stats.successRate >= 90) rateEl.style.color = '#53FC18';
      else if (data.stats.successRate >= 50) rateEl.style.color = '#f0a500';
      else rateEl.style.color = '#FF6B6B';
    }
  }

  // ─── Sistem bilgisi (Ayarlar sekmesi) ───
  if (data.diag) {
    const intervalSelect = document.getElementById('diag-interval-select');
    if (intervalSelect && [30,45,60,90,120].includes(data.diag.checkInterval)) {
      intervalSelect.value = data.diag.checkInterval;
    }
    const sysInfo = document.getElementById('diag-system-info');
    if (sysInfo) {
      sysInfo.innerHTML = `
        <div>Versiyon: <span style="color:#ccc;">${chrome.runtime.getManifest().version}</span></div>
        <div>Tarayıcı: <span style="color:#ccc;">${isFF ? 'Firefox' : 'Chrome'}</span></div>
        <div>Aralık: <span style="color:#ccc;">${data.diag.checkInterval} sn</span></div>
        <div>Cache: <span style="color:#ccc;">${data.diag.ramCacheSize} (${data.diag.ramLiveCount} canlı)</span></div>
        <div>Storage: <span style="color:#ccc;">${fmtBytes(data.diag.storageBytes)}</span></div>
        <div>Alarm sıradaki: <span style="color:#ccc;">${data.diag.alarm ? fmtMs(Math.max(0, data.diag.alarm.scheduledTime - Date.now())) : '—'}</span></div>
        <div>Session refresh: <span style="color:#ccc;">${data.diag.sessionRefreshAlarm ? 'her ' + Math.round(data.diag.sessionRefreshAlarm.periodInMinutes) + ' dk' : '—'}</span></div>
      `;
    }
  }

  // ─── DNR durum kartı (API & Cookie sekmesi) ───
  const dnrDetail = document.getElementById('dnr-status-detail');
  if (dnrDetail) {
    if (data.dnr) {
      dnrDetail.innerHTML = `
        <div>Static ruleset: <span style="color:${data.dnr.staticRulesetActive ? '#53FC18' : '#FF6B6B'};font-weight:600;">
          ${data.dnr.staticRulesetActive ? '✅ Aktif (Origin override aktif)' : '⚠ PASİF'}</span></div>
        <div>Dynamic rules: <span style="color:#ccc;">${data.dnr.dynamicRulesCount || 0}</span></div>
        <div style="font-size:10px;color:#666;margin-top:6px;">
          rules.json kick.com isteklerine zorla "Origin: https://kick.com" header'ı ekler.
          Pasif olursa Cloudflare 403 yağmuru gelir.
        </div>
      `;
    } else {
      dnrDetail.innerHTML = '<span style="color:#FF6B6B;">DNR bilgisi alınamadı</span>';
    }
  }

  // ─── Tanı sekmesi büyük stat kartları ───
  renderBigStats(data);

  // ─── Sağlık motorunu çalıştır ve header'ı çiz ───
  const health = evaluateHealth(data);
  renderHealthHeader(health, data);
}

// ═══════════════════════════════════════════════════════════════════════════
// v2.3.1 — SENARYO ORKESTRATÖRÜ
// ═══════════════════════════════════════════════════════════════════════════
//
// 5 senaryo karta bağlı. Her biri backend'e mesaj atar, dönen results dizisini
// canlı checklist olarak çizer. Çift tıklamayı engelle, "running" lock'u tut.
// ───────────────────────────────────────────────────────────────────────────

const SCENARIOS = {
  health: {
    title: '🩺 Sağlık Kontrolü',
    msgType: 'RUN_SCENARIO_HEALTH',
    description: 'Bağlantı, auth, hız, cookie ve alarm sağlığını ardışık ölçüyor.',
    payload: () => ({}),
  },
  notification: {
    title: '🔔 Bildirim Pipeline',
    msgType: 'RUN_SCENARIO_NOTIFICATION',
    description: 'Bildirim, ses, DND, anomali ayarlarını uçtan uca test ediyor.',
    payload: () => ({}),
  },
  detection: {
    title: '📺 Yayın Algılama',
    msgType: 'E2E_TEST', // Mevcut E2E_TEST handler'ı
    description: 'Gerçek API ile "yayına geçti" akışını simüle ediyor.',
    payload: () => {
      const slug = document.getElementById('detection-slug')?.value?.trim();
      return slug ? { slug } : {};
    },
  },
  recovery: {
    title: '🛡️ Geri Kurtarma',
    msgType: 'RUN_SCENARIO_RECOVERY',
    description: 'Backoff ve recovery mekanizmasını canlı test ediyor.',
    payload: () => ({}),
  },
  pressure: {
    title: '🔥 Cloudflare Baskı Testi',
    msgType: 'RUN_SCENARIO_PRESSURE',
    description: '10 ardışık istek atıyor (50sn) — Plan B değerlendirmesi.',
    payload: () => ({}),
  },
};

let _scenarioRunning = false;

function getStepIcon(status) {
  switch (status) {
    case 'ok': return '✅';
    case 'warn': return '⚠️';
    case 'error': return '❌';
    case 'running': return '⏳';
    default: return '•';
  }
}
function getStepClass(status) {
  switch (status) {
    case 'ok': return 'ok';
    case 'warn': return 'warn';
    case 'error': return 'error';
    case 'running': return 'running';
    default: return '';
  }
}

function renderFlowPanel(scenarioKey, results, isComplete, totalMs) {
  const panel = document.getElementById('flow-panel');
  if (!panel) return;
  const sc = SCENARIOS[scenarioKey];
  panel.classList.remove('idle');

  // Özet sayımı
  const okCount = results.filter(r => r.status === 'ok').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const errCount = results.filter(r => r.status === 'error').length;
  const runCount = results.filter(r => r.status === 'running').length;

  let summaryClass = 'success';
  let summaryText;
  if (!isComplete) {
    summaryClass = 'warn';
    summaryText = `⏳ Çalışıyor — ${results.length} adım`;
  } else if (errCount > 0) {
    summaryClass = 'fail';
    summaryText = `❌ ${errCount} hata · ${okCount} OK${warnCount ? ' · ' + warnCount + ' uyarı' : ''}`;
  } else if (warnCount > 0) {
    summaryClass = 'warn';
    summaryText = `⚠ ${warnCount} uyarı · ${okCount} OK`;
  } else {
    summaryClass = 'success';
    summaryText = `✅ Tüm adımlar OK (${okCount}/${results.length})`;
  }
  if (totalMs) summaryText += ` · ${(totalMs/1000).toFixed(1)}sn`;

  const stepsHtml = results.map(r => `
    <div class="flow-step ${getStepClass(r.status)}">
      <span class="icon">${getStepIcon(r.status)}</span>
      <span class="step-name">${escapeHtml(r.step)}</span>
      <span class="step-detail">${escapeHtml(r.detail || '')}</span>
    </div>
  `).join('');

  panel.innerHTML = `
    <div class="flow-header">
      <span class="flow-title">${sc.title}</span>
      <span class="flow-summary ${summaryClass}">${summaryText}</span>
    </div>
    <div class="flow-steps">${stepsHtml}</div>
  `;
}

function escapeHtml(str) {
  if (typeof str !== 'string') str = String(str ?? '');
  return str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function setCardState(scenarioKey, state) {
  const card = document.querySelector(`.scenario-card[data-scenario="${scenarioKey}"]`);
  if (!card) return;
  card.classList.remove('running', 'success', 'warn', 'fail');
  if (state) card.classList.add(state);
}

function setCardResult(scenarioKey, summary) {
  const card = document.querySelector(`.scenario-card[data-scenario="${scenarioKey}"]`);
  if (!card) return;
  const resultEl = card.querySelector('.scenario-result');
  if (resultEl) resultEl.textContent = summary;
}

async function runScenario(scenarioKey) {
  if (_scenarioRunning) {
    dlog('⏳ Bir senaryo zaten çalışıyor — bekleyin', 'warn');
    return;
  }
  const sc = SCENARIOS[scenarioKey];
  if (!sc) return;

  _scenarioRunning = true;

  // Tüm kartları kilitle, çalışan kartı işaretle
  document.querySelectorAll('.scenario-card').forEach(c => {
    c.style.pointerEvents = 'none';
    c.style.opacity = '0.5';
  });
  const activeCard = document.querySelector(`.scenario-card[data-scenario="${scenarioKey}"]`);
  if (activeCard) {
    activeCard.style.opacity = '1';
    activeCard.classList.remove('success', 'warn', 'fail');
    activeCard.classList.add('running');
  }

  // Boş checklist göster — backend yanıtı sırasında "çalışıyor" durumu
  renderFlowPanel(scenarioKey, [{ step: sc.title, status: 'running', detail: 'Backend çağrısı yapılıyor...' }], false);
  dlog(`▶ Senaryo başlatıldı: ${sc.title}`, 'info');

  try {
    const payload = { type: sc.msgType, ...sc.payload() };
    const response = await chrome.runtime.sendMessage(payload);

    if (!response) {
      throw new Error('Backend yanıt vermedi');
    }

    const results = response.results || [];
    const totalMs = response.totalMs;

    renderFlowPanel(scenarioKey, results, true, totalMs);

    // Kart sonuç durumu
    const errCount = results.filter(r => r.status === 'error').length;
    const warnCount = results.filter(r => r.status === 'warn').length;
    const okCount = results.filter(r => r.status === 'ok').length;
    if (errCount > 0) {
      setCardState(scenarioKey, 'fail');
      setCardResult(scenarioKey, `❌ ${errCount} hata`);
    } else if (warnCount > 0) {
      setCardState(scenarioKey, 'warn');
      setCardResult(scenarioKey, `⚠ ${warnCount} uyarı, ${okCount} OK`);
    } else {
      setCardState(scenarioKey, 'success');
      setCardResult(scenarioKey, `✅ ${okCount}/${results.length} OK`);
    }

    dlog(`✓ Senaryo bitti: ${sc.title} — ${okCount} OK, ${warnCount} uyarı, ${errCount} hata`,
         errCount > 0 ? 'err' : warnCount > 0 ? 'warn' : 'ok');

    // Senaryo tamamlanınca sağlık header'ı yenile
    refreshDiagStatus();
  } catch (e) {
    renderFlowPanel(scenarioKey, [
      { step: sc.title, status: 'error', detail: 'Hata: ' + e.message }
    ], true, 0);
    setCardState(scenarioKey, 'fail');
    setCardResult(scenarioKey, '❌ Hata');
    dlog(`✗ Senaryo hatası: ${e.message}`, 'err');
  } finally {
    _scenarioRunning = false;
    document.querySelectorAll('.scenario-card').forEach(c => {
      c.style.pointerEvents = '';
      c.style.opacity = '';
    });
    if (activeCard) activeCard.classList.remove('running');
  }
}

// ─── Initialize Diagnostic Panel ───
function initDiagnosticPanel() {
  // Buton bağlantıları (Detaylı Aletler içinde)
  document.getElementById('btn-diag-api')?.addEventListener('click', diagApiTest);
  document.getElementById('btn-diag-rate')?.addEventListener('click', diagRateTest);
  document.getElementById('btn-diag-refresh-session')?.addEventListener('click', diagManualRefresh);
  document.getElementById('btn-diag-backoff-status')?.addEventListener('click', diagBackoffStatus);
  document.getElementById('btn-diag-clear-backoff')?.addEventListener('click', diagClearBackoff);
  document.getElementById('btn-diag-force-recheck')?.addEventListener('click', diagForceRecheck);
  document.getElementById('btn-diag-cookies')?.addEventListener('click', diagCookies);
  document.getElementById('btn-diag-channels')?.addEventListener('click', diagChannels);
  document.getElementById('btn-diag-bot-scores')?.addEventListener('click', diagBotScores);
  document.getElementById('btn-diag-set-interval')?.addEventListener('click', diagSetInterval);
  document.getElementById('btn-diag-reload-ext')?.addEventListener('click', diagReloadExt);

  // Health header tek-tık yenileme: hem stats hem cookies
  document.getElementById('btn-health-refresh')?.addEventListener('click', async () => {
    await refreshDiagStatus();
    await diagCookies();
    dlog('🔄 Sağlık paneli yenilendi', 'info');
  });

  // ─── SENARYO KART CLICK HANDLER'I ───
  document.querySelectorAll('.scenario-card').forEach(card => {
    card.addEventListener('click', (e) => {
      // Input alanına tıklandıysa senaryo başlatma (slug input'u için)
      if (e.target.tagName === 'INPUT') return;
      const key = card.getAttribute('data-scenario');
      if (key) runScenario(key);
    });
  });

  // İlk yükleme
  refreshDiagStatus();
  diagCookies(true); // silent — health motorunun cookie verisine ihtiyacı var, log gürültüsü yapmasın

  // Otomatik yenileme: 5 saniyede bir health refresh
  setInterval(() => refreshDiagStatus(), 5000);
  // Cookie tablosu daha az sık (her 60 sn) — chrome.cookies API daha pahalı, silent
  setInterval(() => diagCookies(true), 60000);

  dlog('🩺 Test paneli hazır — bir senaryo karta tıklayarak otomatik test başlat', 'ok');
}
