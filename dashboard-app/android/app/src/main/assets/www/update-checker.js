/* ============================================================
   update-checker.js — Cek & pasang update APK Dashboard dari
   GitHub Releases (repo PUBLIC) lewat jembatan native Android.

   Native (MainActivity -> UpdateBridge) menyediakan:
     AndroidUpdate.currentVersion()
     AndroidUpdate.checkUpdate()
     AndroidUpdate.downloadAndInstall(url, version, fileName)
   Native melapor balik ke window._onUpdateStatus(status):
     { state: 'checking'|'update-available'|'downloading'|'up-to-date'|'error',
       phase, message, progress, version, latestVersion, currentVersion, downloadUrl }
   UI (app.js) boleh memasang window.onUpdateStatusUI(status) untuk ikut mendengar.
   ============================================================ */
(function () {
  function nativeBridge() {
    return (typeof window.AndroidUpdate !== 'undefined') ? window.AndroidUpdate : null;
  }

  // Versi terpasang = versionName APK (sumber tepercaya), fallback ke version.js.
  (function resolveVersion() {
    var v = '';
    try { var b = nativeBridge(); if (b && b.currentVersion) v = String(b.currentVersion() || ''); } catch (e) {}
    if (!v && window.APP_VERSION && String(window.APP_VERSION).indexOf('__APP') === -1) v = window.APP_VERSION;
    window.APP_CURRENT_VERSION = v || '?';
  })();

  var silent = false;     // true untuk cek otomatis saat start (tanpa banner error)
  var lastVersion = '';

  function notifyUI(status) {
    if (typeof window.onUpdateStatusUI === 'function') {
      try { window.onUpdateStatusUI(status); } catch (e) {}
    }
  }

  function removeBanner() {
    var el = document.getElementById('apkUpdateBanner');
    if (el) el.remove();
  }

  function makeBanner(background, html) {
    removeBanner();
    var el = document.createElement('div');
    el.id = 'apkUpdateBanner';
    el.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:' + background + ';color:#fff;padding:12px 16px;' +
      'display:flex;align-items:center;justify-content:space-between;gap:10px;' +
      'font:13px system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.2);';
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  }

  function showUpdateBanner(version, downloadUrl) {
    var el = makeBanner('#1d4ed8',
      '<span style="flex:1;min-width:0;">Update v' + version + ' tersedia</span>' +
      '<button id="apkUpdateBtn" style="background:#fff;color:#1d4ed8;border:none;' +
      'padding:8px 14px;border-radius:6px;font-weight:600;flex-shrink:0;">Install</button>');
    document.getElementById('apkUpdateBtn').addEventListener('click', function () {
      var bridge = nativeBridge();
      if (!bridge) return;
      silent = false; // setelah user menekan Install, semua error harus terlihat
      bridge.downloadAndInstall(downloadUrl, version, 'TelemetryDashboard-v' + version + '.apk');
      el.querySelector('span').textContent = 'Mengunduh update v' + version + '…';
      var btn = document.getElementById('apkUpdateBtn');
      if (btn) btn.remove();
    });
  }

  function showProgressBanner(pct, version) {
    var el = document.getElementById('apkUpdateBanner');
    if (!el) el = makeBanner('#1d4ed8', '<span style="flex:1;min-width:0;"></span>');
    var span = el.querySelector('span');
    if (span) span.textContent = 'Mengunduh update v' + version + '… ' + pct + '%';
  }

  function showErrorBanner(message) {
    makeBanner('#b91c1c',
      '<span style="flex:1;min-width:0;">Update gagal: ' + message + '</span>' +
      '<button id="apkRetryBtn" style="background:#fff;color:#b91c1c;border:none;' +
      'padding:8px 14px;border-radius:6px;font-weight:600;flex-shrink:0;">Coba Lagi</button>');
    document.getElementById('apkRetryBtn').addEventListener('click', function () {
      removeBanner();
      checkForUpdate(false);
    });
  }

  function checkForUpdate(isSilent) {
    silent = !!isSilent;
    var bridge = nativeBridge();
    if (!bridge) {
      notifyUI({ state: 'error', phase: 'cek-versi',
        message: 'Cek update hanya berjalan di dalam APK, bukan browser.' });
      return;
    }
    notifyUI({ state: 'checking' });
    removeBanner();
    try {
      bridge.checkUpdate();
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      notifyUI({ state: 'error', phase: 'cek-versi', message: msg });
      if (!silent) showErrorBanner(msg);
    }
  }

  // Dipanggil native (evaluateJavascript) untuk melapor status.
  window._onUpdateStatus = function (status) {
    status = status || {};
    switch (status.state) {
      case 'up-to-date':
        removeBanner();
        break;
      case 'update-available':
        lastVersion = status.version || status.latestVersion || '';
        showUpdateBanner(lastVersion, status.downloadUrl);
        break;
      case 'downloading':
        showProgressBanner(status.progress || 0, lastVersion);
        break;
      case 'error':
        // Cek otomatis saat start: jangan ganggu user kalau cuma gagal cek.
        if (!silent || status.phase === 'download' || status.phase === 'install') {
          showErrorBanner(status.message || 'kesalahan tidak diketahui');
        }
        break;
    }
    notifyUI(status);
  };

  window.checkForTelemetryUpdate = checkForUpdate;
})();
