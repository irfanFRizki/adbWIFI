/* ============================================================
   update-checker.js — Cek & pasang update APK Dashboard dari
   GitHub Releases (repo PUBLIC), lewat jembatan native Android.

   Jembatan native (dipasang MainActivity):
     window.AndroidUpdate.checkUpdate()
     window.AndroidUpdate.downloadAndInstall(url, version, fileName)

   Native melapor status balik ke window._onUpdateStatus(status):
     { state: 'checking'|'update-available'|'downloading'|
              'up-to-date'|'error',
       phase, message, progress, version, latestVersion,
       currentVersion, downloadUrl }
   ============================================================ */
(function () {
  var CURRENT_VERSION =
    (window.APP_VERSION && String(window.APP_VERSION).indexOf('__APP') === -1)
      ? window.APP_VERSION
      : '__APP_VERSION__';
  window.APP_CURRENT_VERSION = CURRENT_VERSION;

  function nativeBridge() {
    return (typeof window.AndroidUpdate !== 'undefined') ? window.AndroidUpdate : null;
  }

  function report(status) {
    if (typeof window._onUpdateStatus === 'function') {
      try { window._onUpdateStatus(status); } catch (e) {}
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
      var fileName = 'TelemetryDashboard-v' + version + '.apk';
      bridge.downloadAndInstall(downloadUrl, version, fileName);
      el.querySelector('span').textContent = 'Mengunduh update v' + version + '…';
    });
  }

  function showProgressBanner(pct, version) {
    var el = document.getElementById('apkUpdateBanner');
    if (!el) {
      el = makeBanner('#1d4ed8',
        '<span style="flex:1;min-width:0;">Mengunduh update v' + version + '…</span>');
    }
    var span = el.querySelector('span');
    if (span) span.textContent = 'Mengunduh update v' + version + '… ' + pct + '%';
  }

  function showErrorBanner(message, onRetryClick) {
    var el = makeBanner('#b91c1c',
      '<span style="flex:1;min-width:0;">Cek update gagal: ' + message + '</span>' +
      '<button id="apkRetryBtn" style="background:#fff;color:#b91c1c;border:none;' +
      'padding:8px 14px;border-radius:6px;font-weight:600;flex-shrink:0;">Coba Lagi</button>');
    document.getElementById('apkRetryBtn').addEventListener('click', function () {
      removeBanner();
      onRetryClick();
    });
  }

  function checkForUpdate() {
    var bridge = nativeBridge();
    if (!bridge) {
      report({ state: 'error', phase: 'cek-versi',
        message: 'Cek update hanya berjalan di dalam APK, bukan browser.' });
      return;
    }
    report({ state: 'checking' });
    removeBanner();
    try {
      bridge.checkUpdate();
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      report({ state: 'error', phase: 'cek-versi', message: msg });
      showErrorBanner(msg, checkForUpdate);
    }
  }

  // Handler status dari native
  var lastVersion = '';
  window._onUpdateStatus = function (status) {
    status = status || {};
    switch (status.state) {
      case 'checking':
        break;

      case 'up-to-date':
        removeBanner();
        report(status);
        break;

      case 'update-available':
        lastVersion = status.version || status.latestVersion || '';
        report(status);
        showUpdateBanner(lastVersion, status.downloadUrl);
        break;

      case 'downloading':
        showProgressBanner(status.progress || 0, lastVersion);
        report(status);
        break;

      case 'error':
        report(status);
        showErrorBanner(status.message || 'kesalahan tidak diketahui', checkForUpdate);
        break;

      default:
        report(status);
    }
  };

  window.checkForTelemetryUpdate = checkForUpdate;
})();
