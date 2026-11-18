/* ============================================================
   update-checker.js — Auto-update dari GitHub Releases (repo PUBLIC).
   Versi ini melapor error PER TAHAP (bukan satu pesan generik),
   pakai timeout eksplisit + retry, dan punya tombol "Coba Lagi"
   di banner. Status dilapor ke window._onUpdateStatus(status)
   dengan bentuk:
     { state: 'checking'|'downloading'|'up-to-date'|'update-ready'|'error',
       phase: 'cek-versi'|'download'|'simpan-file'|'install' (khusus error),
       message: '<pesan asli, kalau state error>',
       latestVersion, currentVersion (kalau relevan) }
   ============================================================ */
(function () {
  // GANTI dua baris ini sesuai repo Anda setelah dibuat di GitHub:
  var GITHUB_OWNER = 'irfanFRizki';
  var GITHUB_REPO = 'adbWIFI';

  // Diisi otomatis oleh GitHub Actions saat build (lihat workflow),
  // jangan diedit manual. Sumber utama: version.js (dimuat lebih dulu);
  // fallback ke placeholder __APP_VERSION__ kalau version.js belum diinjeksi.
  var CURRENT_VERSION =
    (window.APP_VERSION && String(window.APP_VERSION).indexOf('__APP') === -1)
      ? window.APP_VERSION
      : '__APP_VERSION__';
  window.APP_CURRENT_VERSION = CURRENT_VERSION; // dibaca tab "Tentang Aplikasi"

  var STORAGE_KEY_VERSION = 'telemetry_downloaded_version';
  var STORAGE_KEY_PATH = 'telemetry_downloaded_path';
  var API_URL =
    'https://api.github.com/repos/' + GITHUB_OWNER + '/' + GITHUB_REPO + '/releases/latest';

  function isNative() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  }

  // Bandingkan versi model "1.2.3" / "v1.2.3". Return true kalau `a` > `b`.
  function isNewerVersion(a, b) {
    var clean = function (v) {
      return String(v).replace(/^v/i, '').split('.').map(function (n) {
        return parseInt(n, 10) || 0;
      });
    };
    var pa = clean(a);
    var pb = clean(b);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }

  // Lapor status ke pendengar luar (tab Tentang Aplikasi), kalau ada.
  function report(status) {
    if (typeof window._onUpdateStatus === 'function') {
      try { window._onUpdateStatus(status); } catch (e) {}
    }
  }

  // fetch() dengan timeout eksplisit (fetch bawaan tidak ada timeout,
  // jadi kalau server lambat/hang, request bisa menggantung tanpa kabar).
  function fetchWithTimeout(url, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    return fetch(url, { signal: controller.signal }).finally(function () {
      clearTimeout(timer);
    });
  }

  // Coba fetch dengan timeout 15 detik, kalau timeout/abort, retry sekali
  // dengan timeout 30 detik sebelum benar-benar menyerah.
  async function fetchWithRetry(url) {
    try {
      return await fetchWithTimeout(url, 15000);
    } catch (err) {
      if (err.name === 'AbortError') {
        // Timeout pertama — retry sekali dengan waktu lebih longgar.
        return await fetchWithTimeout(url, 30000);
      }
      throw err;
    }
  }

  function describeFetchError(err, phase) {
    if (err.name === 'AbortError') {
      return { phase: phase, message: 'Server tidak merespon dalam waktu wajar (timeout). Coba lagi beberapa saat.' };
    }
    return { phase: phase, message: (err && err.message) ? err.message : String(err) };
  }

  function showUpdateBanner(onInstallClick) {
    if (document.getElementById('apkUpdateBanner')) return;
    var el = document.createElement('div');
    el.id = 'apkUpdateBanner';
    el.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:#1d4ed8;color:#fff;padding:12px 16px;' +
      'display:flex;align-items:center;justify-content:space-between;' +
      'font:14px system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.2);';
    el.innerHTML =
      '<span>Update baru tersedia</span>' +
      '<button id="apkUpdateBtn" style="background:#fff;color:#1d4ed8;border:none;' +
      'padding:8px 14px;border-radius:6px;font-weight:600;">Install Sekarang</button>';
    document.body.appendChild(el);
    document.getElementById('apkUpdateBtn').addEventListener('click', onInstallClick);
  }

  function removeBanner() {
    var el = document.getElementById('apkUpdateBanner');
    if (el) el.remove();
  }

  function showErrorBanner(message, onRetryClick) {
    removeBanner();
    var el = document.createElement('div');
    el.id = 'apkUpdateBanner';
    el.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:99999;' +
      'background:#b91c1c;color:#fff;padding:12px 16px;' +
      'display:flex;align-items:center;justify-content:space-between;gap:10px;' +
      'font:13px system-ui,sans-serif;box-shadow:0 -2px 10px rgba(0,0,0,.2);';
    el.innerHTML =
      '<span style="flex:1;min-width:0;">Cek update gagal: ' + message + '</span>' +
      '<button id="apkRetryBtn" style="background:#fff;color:#b91c1c;border:none;' +
      'padding:8px 14px;border-radius:6px;font-weight:600;flex-shrink:0;">Coba Lagi</button>';
    document.body.appendChild(el);
    document.getElementById('apkRetryBtn').addEventListener('click', function () {
      removeBanner();
      onRetryClick();
    });
  }

  async function downloadApk(downloadUrl, versionTag) {
    var Filesystem = window.Capacitor.Plugins.Filesystem;
    var fileName = 'update-' + versionTag.replace(/[^a-zA-Z0-9.\-]/g, '') + '.apk';
    var result;
    try {
      // Filesystem.downloadFile() download langsung lewat native (bukan fetch()
      // di WebView), jadi tidak kena batasan CORS / blob dari browser sama sekali.
      result = await Filesystem.downloadFile({
        url: downloadUrl,
        path: fileName,
        directory: 'CACHE',
      });
    } catch (err) {
      var e = new Error('Gagal download APK: ' + (err.message || err));
      e.phase = 'download';
      throw e;
    }

    var uri = (result && (result.path || result.uri)) || '';
    if (!uri) {
      var e2 = new Error('Download selesai tapi lokasi file tidak diketahui.');
      e2.phase = 'download';
      throw e2;
    }
    uri = uri.replace('file://', '');

    localStorage.setItem(STORAGE_KEY_VERSION, versionTag);
    localStorage.setItem(STORAGE_KEY_PATH, uri);
    return uri;
  }

  async function installDownloaded(path) {
    try {
      var ApkInstaller = window.Capacitor.Plugins.ApkInstaller;
      var canInstall = await ApkInstaller.canInstall();
      if (!canInstall.value) {
        await ApkInstaller.requestInstallPermission();
        // Beri kesempatan user aktifkan izin, lalu tap banner/tombol lagi untuk lanjut.
        return;
      }
      await ApkInstaller.install({ path: path });
    } catch (err) {
      report({ state: 'error', phase: 'install', message: err.message || String(err) });
      showErrorBanner('gagal buka installer (' + (err.message || err) + ')', function () {
        installDownloaded(path);
      });
    }
  }
  window._installDownloadedUpdate = function () {
    var path = localStorage.getItem(STORAGE_KEY_PATH);
    if (path) installDownloaded(path);
  };

  async function checkForUpdate() {
    if (!isNative()) {
      report({ state: 'error', phase: 'cek-versi', message: 'Cek update hanya berjalan di dalam APK, bukan browser.' });
      return;
    }

    report({ state: 'checking' });
    removeBanner();

    // ---- Tahap 1: cek versi terbaru ke GitHub API ----
    var res;
    try {
      res = await fetchWithRetry(API_URL);
    } catch (err) {
      var d = describeFetchError(err, 'cek-versi');
      report({ state: 'error', phase: d.phase, message: d.message });
      showErrorBanner(d.message, checkForUpdate);
      return;
    }

    if (!res.ok) {
      report({ state: 'error', phase: 'cek-versi', message: 'GitHub API ' + res.status + ' ' + res.statusText });
      showErrorBanner('GitHub API ' + res.status + ' ' + res.statusText, checkForUpdate);
      return;
    }

    var data;
    try {
      data = await res.json();
    } catch (err) {
      report({ state: 'error', phase: 'cek-versi', message: 'Gagal parse JSON respons GitHub' });
      showErrorBanner('Gagal parse JSON respons GitHub', checkForUpdate);
      return;
    }

    var latestTag = data.tag_name || data.name || '';
    var latestVersion = String(latestTag).replace(/^v/i, '');

    if (!isNewerVersion(latestVersion, CURRENT_VERSION)) {
      report({ state: 'up-to-date', latestVersion: latestVersion, currentVersion: CURRENT_VERSION });
      return;
    }

    // ---- Tahap 2: cari asset APK dashboard di release ----
    var assets = data.assets || [];
    var apkAsset = null;
    for (var i = 0; i < assets.length; i++) {
      var name = assets[i].name || '';
      if (name.toLowerCase().indexOf('dashboard') !== -1 && name.toLowerCase().endsWith('.apk')) {
        apkAsset = assets[i];
        break;
      }
    }
    if (!apkAsset) {
      report({ state: 'error', phase: 'cek-versi', message: 'Asset APK dashboard tidak ditemukan di release.' });
      showErrorBanner('Asset APK dashboard tidak ditemukan di release.', checkForUpdate);
      return;
    }

    var downloadUrl = apkAsset.browser_download_url;
    report({ state: 'downloading', latestVersion: latestVersion, currentVersion: CURRENT_VERSION });

    // ---- Tahap 3: download APK ----
    var fileUri;
    try {
      fileUri = await downloadApk(downloadUrl, latestVersion);
    } catch (err) {
      report({ state: 'error', phase: err.phase || 'download', message: err.message || String(err) });
      showErrorBanner(err.message || String(err), checkForUpdate);
      return;
    }

    report({ state: 'update-ready', latestVersion: latestVersion, currentVersion: CURRENT_VERSION, path: fileUri });

    // ---- Tahap 4: tampilkan banner install ----
    showUpdateBanner(function () {
      installDownloaded(fileUri);
    });
  }

  // Jalankan cek saat aplikasi siap (bisa dipanggil ulang manual via console)
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkForUpdate);
    } else {
      checkForUpdate();
    }
  }

  // Ekspos fungsi untuk pemanggilan manual (mis. dari tab Settings)
  window.checkForTelemetryUpdate = checkForUpdate;
})();