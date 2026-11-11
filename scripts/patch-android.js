#!/usr/bin/env node
/* Menyesuaikan proyek Android hasil `npx cap add android` (folder android/ tidak di-commit):
 *  1. izinkan lalu lintas HTTP biasa (API router memakai http://)
 *  2. tanda tangan rilis memakai ci/adbwifi.keystore (kunci tetap, jadi APK bisa di-update menimpa versi lama)
 *  3. versionName / versionCode
 * Env: APP_VERSION (mis. 1.2.3, boleh kosong), RUN_NUMBER (untuk versionCode).
 * Gagal dengan jelas (exit 1) bila templat Capacitor berubah dan pola tidak ditemukan. */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const gradlePath = path.join(root, 'android', 'app', 'build.gradle');
const manifestPath = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

function fail(msg) { console.error('patch-android: ' + msg); process.exit(1); }
function read(p) { if (!fs.existsSync(p)) fail('berkas tidak ada: ' + p + ' (jalankan `npx cap add android` dulu)'); return fs.readFileSync(p, 'utf8'); }

const version = (process.env.APP_VERSION || '').replace(/^v/, '').trim();
if (version && !/^\d+(\.\d+){0,3}([-+][\w.]+)?$/.test(version)) fail('APP_VERSION tidak valid: ' + version);
const run = parseInt(process.env.RUN_NUMBER || '1', 10);
const versionCode = Number.isInteger(run) && run > 0 ? run : 1;
const versionName = version || ('0.0.' + versionCode);

/* ---- build.gradle ---- */
let g = read(gradlePath);

if (!/versionCode\s+\d+/.test(g) || !/versionName\s+"[^"]*"/.test(g)) fail('versionCode/versionName tidak ditemukan di build.gradle');
g = g.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode)
     .replace(/versionName\s+"[^"]*"/, 'versionName "' + versionName + '"');

if (!/signingConfigs\.release/.test(g)) {
  const re = /(\n\s*)buildTypes\s*\{(\s*)release\s*\{/;
  if (!re.test(g)) fail('blok buildTypes { release { ... } } tidak ditemukan di build.gradle');
  g = g.replace(re, function (_m, ind, ws) {
    return ind + 'signingConfigs {' +
      ind + '    release {' +
      ind + "        storeFile rootProject.file('../ci/adbwifi.keystore')" +
      ind + "        storePassword 'adbwifi-ci'" +
      ind + "        keyAlias 'adbwifi'" +
      ind + "        keyPassword 'adbwifi-ci'" +
      ind + '    }' +
      ind + '}' +
      ind + 'buildTypes {' + ws + 'release {' + ws + '    signingConfig signingConfigs.release';
  });
}
fs.writeFileSync(gradlePath, g);

/* ---- AndroidManifest.xml ---- */
let m = read(manifestPath);
if (!/android:usesCleartextTraffic=/.test(m)) {
  if (!/<application\b/.test(m)) fail('tag <application> tidak ditemukan di AndroidManifest.xml');
  m = m.replace(/<application\b/, '<application\n        android:usesCleartextTraffic="true"');
}
fs.writeFileSync(manifestPath, m);

/* ---- www/version.js (dibaca layar Pengaturan). versionName sudah divalidasi, aman ditulis ke JS ---- */
fs.writeFileSync(path.join(root, 'www', 'version.js'), "window.APP_VERSION = '" + versionName + "';\n");


/* ---- ikon aplikasi adbWIFI (adaptive icon Android 8+) ----
 * Dibuat saat CI karena folder android/ sengaja tidak disimpan di repo. */
const resDir = path.join(root, 'android', 'app', 'src', 'main', 'res');
const mipmapDir = path.join(resDir, 'mipmap-anydpi-v26');
fs.mkdirSync(mipmapDir, { recursive: true });
const iconForegroundPath = path.join(resDir, 'drawable', 'ic_adbwifi_foreground.xml');
fs.mkdirSync(path.dirname(iconForegroundPath), { recursive: true });
const iconForeground = `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108">
    <path android:fillColor="#10172B" android:pathData="M54,5 C81,5 103,27 103,54 C103,81 81,103 54,103 C27,103 5,81 5,54 C5,27 27,5 54,5 Z"/>
    <path android:strokeColor="#7568FF" android:strokeWidth="5" android:strokeLineCap="round" android:fillColor="#00000000" android:pathData="M27,39 C42,24 66,24 81,39"/>
    <path android:strokeColor="#4B8CFF" android:strokeWidth="5" android:strokeLineCap="round" android:fillColor="#00000000" android:pathData="M35,49 C46,38 62,38 73,49"/>
    <path android:strokeColor="#4CE0ED" android:strokeWidth="5" android:strokeLineCap="round" android:fillColor="#00000000" android:pathData="M43,59 C49,53 59,53 65,59"/>
    <path android:strokeColor="#F2F5FF" android:strokeWidth="4" android:fillColor="#00000000" android:pathData="M42,64 L66,64 Q70,64 70,69 L70,88 Q70,92 66,92 L42,92 Q38,92 38,88 L38,69 Q38,64 42,64 Z"/>
    <path android:strokeColor="#7D8CFF" android:strokeWidth="2.5" android:strokeLineCap="round" android:pathData="M48,86 L60,86"/>
</vector>`;
fs.writeFileSync(iconForegroundPath, iconForeground);
fs.writeFileSync(path.join(mipmapDir, 'ic_launcher.xml'), `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/adbwifi_icon_background"/>
    <foreground android:drawable="@drawable/ic_adbwifi_foreground"/>
</adaptive-icon>`);
const valuesDir = path.join(resDir, 'values');
fs.mkdirSync(valuesDir, { recursive: true });
fs.writeFileSync(path.join(valuesDir, 'adbwifi_colors.xml'), `<resources><color name="adbwifi_icon_background">#080B18</color></resources>`);
let manifest = read(manifestPath);
manifest = manifest.replace(/android:icon="@[^"]+"/, 'android:icon="@mipmap/ic_launcher"');
manifest = manifest.replace(/android:roundIcon="@[^"]+"/, 'android:roundIcon="@mipmap/ic_launcher"');
fs.writeFileSync(manifestPath, manifest);

console.log('patch-android: OK (versionName ' + versionName + ', versionCode ' + versionCode + ')');
