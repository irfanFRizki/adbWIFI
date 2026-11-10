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

console.log('patch-android: OK (versionName ' + versionName + ', versionCode ' + versionCode + ')');
