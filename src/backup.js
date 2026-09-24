// v2.5.38: Ayarları Dışa/İçe Aktar mantığı — artık popup içinde DEĞİL, kendi
// sekmesinde çalışıyor. Neden: Firefox, bir extension popup'ı içinde
// <input type="file"> veya indirme diyaloğu açıldığında popup'ı otomatik
// kapatıyor (Mozilla Bugzilla #1658694, #1292701) — bu, "İçe Aktar"a
// tıklandığında dosya seçilse bile 'change' olayının hiç tetiklenmemesine,
// yani ayarların sessizce hiç yüklenmemesine yol açıyordu. Bu sayfa
// chrome.tabs.create ile bir SEKME olarak açıldığı için bu sorunu yaşamaz.
// Mantığın kendisi (exportSettingsToObject / importSettingsFromObject /
// vs.) storage.js'te ve DEĞİŞMEDİ; sadece DOM/UI bu yeni sayfaya taşındı.

document.addEventListener('DOMContentLoaded', async () => {
  await Utils.initI18n();
  // v2.5.38: applyOptionsI18n() (popup.js'te) sadece #options-panel/#chat-panel
  // içindeki [data-i18n] elementlerini hedefliyor — bu sayfada o konteynerler
  // yok, o yüzden burada TÜM sayfayı tarayan basit, bağımsız bir sürüm var.
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) el.textContent = Utils.i18n(key) || el.textContent;
  });
  const verEl = document.getElementById('opt-app-version');
  if (verEl) verEl.textContent = 'KickAlert v' + chrome.runtime.getManifest().version;

  const exportBtn = document.getElementById('opt-export-settings');
  const importBtn = document.getElementById('opt-import-settings');
  const importFileInput = document.getElementById('opt-import-file-input');
  const importExportStatus = document.getElementById('opt-import-export-status');
  const restoreWrap = document.getElementById('opt-restore-snapshot-wrap');
  const restoreBtn = document.getElementById('opt-restore-snapshot');
  const lastExportInfo = document.getElementById('opt-last-export-info');

  function showStatus(text, isError) {
    if (!importExportStatus) return;
    importExportStatus.textContent = text;
    importExportStatus.style.color = isError ? 'var(--red, #e05252)' : 'var(--accent)';
  }

  async function refreshLastExportInfo() {
    if (!lastExportInfo) return;
    const ts = await getLastExportTimestamp();
    if (!ts) {
      lastExportInfo.textContent = Utils.i18n('lastExportNever') || 'No backup taken yet';
      return;
    }
    const days = Math.floor((Date.now() - ts) / 86400000);
    lastExportInfo.textContent = days <= 0
      ? (Utils.i18n('lastExportToday') || 'Last backup: today')
      : (Utils.i18n('lastExportDaysAgo') || `Last backup: ${days} days ago`).replace('$1', days);
  }

  async function refreshRestoreVisibility() {
    if (!restoreWrap) return;
    restoreWrap.style.display = (await hasPreChangeSnapshot()) ? 'block' : 'none';
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const exportObj = await exportSettingsToObject();
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const dateStr = new Date().toISOString().slice(0, 10);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kickalert-settings-${dateStr}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        showStatus(Utils.i18n('exportSettingsSuccess') || 'Downloaded!', false);
        refreshLastExportInfo();
      } catch (e) {
        showStatus(Utils.i18n('exportSettingsFail') || 'Export failed', true);
      }
    });
  }

  let pendingImportObj = null;
  if (importBtn && importFileInput) {
    importBtn.addEventListener('click', () => importFileInput.click());
    importFileInput.addEventListener('change', async () => {
      const file = importFileInput.files[0];
      importFileInput.value = '';
      if (!file) return;
      try {
        const text = await file.text();
        const parsed = JSON.parse(text);
        if (!parsed || parsed.kickAlertSettingsExport !== true) {
          showStatus(Utils.i18n('importSettingsInvalid') || 'Not a valid KickAlert settings file', true);
          return;
        }
        pendingImportObj = parsed;
        document.getElementById('import-confirm-modal').style.display = 'flex';
      } catch (e) {
        showStatus(Utils.i18n('importSettingsInvalid') || 'Not a valid KickAlert settings file', true);
      }
    });
  }
  document.getElementById('import-confirm-cancel')?.addEventListener('click', () => {
    pendingImportObj = null;
    document.getElementById('import-confirm-modal').style.display = 'none';
  });
  document.getElementById('import-confirm-modal')?.querySelector('.confirm-modal-backdrop')?.addEventListener('click', () => {
    pendingImportObj = null;
    document.getElementById('import-confirm-modal').style.display = 'none';
  });
  document.getElementById('import-confirm-accept')?.addEventListener('click', async () => {
    document.getElementById('import-confirm-modal').style.display = 'none';
    if (!pendingImportObj) return;
    // v2.5.38: storage.local.set() bir kota/izin hatası fırlatırsa artık
    // sessizce takılıp kalmıyor — result her durumda dönüyor ve hata
    // burada da açıkça yakalanıp kullanıcıya gösteriliyor.
    let result;
    try {
      result = await importSettingsFromObject(pendingImportObj);
    } catch (e) {
      result = { ok: false, error: e && e.message ? e.message : 'UNKNOWN' };
    }
    pendingImportObj = null;
    if (result.ok) {
      showStatus(Utils.i18n('importSettingsSuccess') || 'Imported! Reloading...', false);
      // v2.5.39: Metin "Yenileniyor..." diyordu ama kod bunu hiç YAPMIYORDU —
      // kullanıcı mesajı gördükten sonra sayfa sürüp gidiyordu, bu da
      // "yenileniyor" derken hiçbir şey olmuyormuş gibi kafa karıştırıyordu.
      // Şimdi mesajı okuyacak kadar bekleyip GERÇEKTEN yeniliyoruz — bu da
      // "Son yedek" bilgisini ve "Geri Al" butonunun görünürlüğünü tazeler.
      setTimeout(() => location.reload(), 1400);
    } else {
      showStatus((Utils.i18n('importSettingsFail') || 'Import failed — file may be corrupted') + (result.error ? ` (${result.error})` : ''), true);
    }
  });

  restoreBtn?.addEventListener('click', async () => {
    const result = await restorePreChangeSnapshot();
    if (result.ok) {
      showStatus(Utils.i18n('restoreSnapshotSuccess') || 'Restored! Reloading...', false);
      setTimeout(() => location.reload(), 1400);
    } else {
      showStatus(Utils.i18n('restoreSnapshotFail') || 'Nothing to restore', true);
    }
  });

  refreshLastExportInfo();
  refreshRestoreVisibility();
});
