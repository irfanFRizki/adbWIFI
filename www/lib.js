/* HPLib — logika murni (tanpa DOM) supaya bisa diuji dengan Node.
 * Dipakai oleh app.js di WebView dan oleh test/ di Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HPLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_PATH = '/cgi-bin/hpmon/index.sh';

  /* ---------- validasi & format ---------- */

  function isValidIPv4(ip) {
    if (typeof ip !== 'string') return false;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim());
    if (!m) return false;
    for (var i = 1; i <= 4; i++) if (Number(m[i]) > 255) return false;
    return true;
  }

  function isValidPort(p) {
    var n = Number(p);
    return Number.isInteger(n) && n >= 1 && n <= 65535;
  }

  /* "192.168.7.1" -> "http://192.168.7.1/cgi-bin/hpmon/index.sh"
   * Alamat lengkap dipertahankan; akhiran /status atau /targets dibuang. */
  function normalizeBaseUrl(input) {
    var s = String(input == null ? '' : input).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/(status|targets)(\/[^?#]*)?$/i, '');
    var u;
    try { u = new URL(s); } catch (e) { return ''; }
    if (!u.hostname) return '';
    if (u.pathname === '/' || u.pathname === '') s = s.replace(/\/+$/, '') + DEFAULT_PATH;
    return s;
  }

  function escapeHtml(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatBytes(n) {
    if (n === null || n === undefined || isNaN(n)) return '—';
    var units = ['B', 'KB', 'MB', 'GB', 'TB'];
    var i = 0, v = Number(n);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    var digits = i === 0 ? 0 : (v >= 100 ? 0 : (v >= 10 ? 1 : 2));
    return v.toFixed(digits) + ' ' + units[i];
  }

  function formatRate(bps) {
    if (bps === null || bps === undefined || isNaN(bps)) return '—';
    return formatBytes(bps) + '/s';
  }

  function formatUptime(sec) {
    if (sec === null || sec === undefined || isNaN(sec)) return '—';
    sec = Math.floor(Number(sec));
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    if (d > 0) return d + ' hari ' + h + ' jam';
    if (h > 0) return h + ' jam ' + m + ' mnt';
    return m + ' mnt';
  }

  function formatAge(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '—';
    seconds = Math.max(0, Math.floor(seconds));
    if (seconds < 60) return seconds + ' dtk';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' mnt';
    return Math.floor(seconds / 3600) + ' jam';
  }

  /* "146.039 ms" -> 146 ; "" -> null */
  function parseLatency(str) {
    if (str === null || str === undefined || str === '') return null;
    var n = parseFloat(String(str));
    return isNaN(n) ? null : Math.round(n);
  }

  /* RSSI dBm -> 0..4 batang */
  function wifiBars(rssi) {
    if (typeof rssi !== 'number' || isNaN(rssi)) return 0;
    if (rssi >= -55) return 4;
    if (rssi >= -65) return 3;
    if (rssi >= -75) return 2;
    return 1;
  }

  /* ---------- nama, baterai, aplikasi aktif ---------- */

  /* Nama tampil: hostname dari router lebih diutamakan, lalu nama target, lalu IP. */
  function displayName(dev) {
    var h = dev && typeof dev.hostname === 'string' ? dev.hostname.trim() : '';
    if (h) return h;
    var n = dev && typeof dev.nama === 'string' ? dev.nama.trim() : '';
    return n || (dev && dev.ip) || '';
  }

  /* Nama target ditampilkan sebagai keterangan bila berbeda dari nama tampil. */
  function altName(dev) {
    var d = displayName(dev);
    var n = dev && typeof dev.nama === 'string' ? dev.nama.trim() : '';
    return n && n !== d ? n : '';
  }

  var CHARGE_SOURCE = { ac: 'Charger (AC)', usb: 'USB', wireless: 'Nirkabel' };
  function chargeSourceText(src) { return CHARGE_SOURCE[src] || ''; }

  function isCharging(dev) { return !!(dev && dev.adb && dev.adb.status === 'connected' && dev.adb.charging === true); }

  function formatTemp(c) {
    if (typeof c !== 'number' || isNaN(c)) return '—';
    return c.toFixed(1) + ' °C';
  }
  /* 'ok' < 42 °C, 'warm' 42–44.9, 'hot' >= 45 */
  function tempLevel(c) {
    if (typeof c !== 'number' || isNaN(c)) return '';
    if (c >= 45) return 'hot';
    if (c >= 42) return 'warm';
    return 'ok';
  }

  function formatVoltage(mv) {
    if (typeof mv !== 'number' || isNaN(mv)) return '—';
    return (Math.round(mv / 10) / 100).toFixed(2) + ' V';
  }

  /* Konvensi router: positif = mengisi, negatif = dipakai. */
  function formatCurrent(ma) {
    if (typeof ma !== 'number' || isNaN(ma)) return '—';
    var abs = Math.abs(Math.round(ma));
    return (ma > 0 ? '+' : (ma < 0 ? '−' : '')) + abs + ' mA';
  }

  function formatDrain(pctPerHour) {
    if (typeof pctPerHour !== 'number' || isNaN(pctPerHour)) return '—';
    return pctPerHour.toFixed(1) + ' %/jam';
  }

  /* Perkiraan sisa waktu dari rata-rata pemakaian: "±6 jam 30 mnt" */
  function estimateRemaining(level, pctPerHour) {
    var lv = Number(level);
    if (isNaN(lv) || typeof pctPerHour !== 'number' || pctPerHour <= 0.05) return null;
    var mins = Math.round(lv / pctPerHour * 60);
    if (mins > 99 * 60) return null;
    var h = Math.floor(mins / 60), m = mins % 60;
    return '±' + (h > 0 ? h + ' jam ' : '') + m + ' mnt';
  }

  /* foreground_app bisa ada di adb.* (cache) atau detail.* (live). Hasil: {text, pkg} atau null. */
  function foregroundApp(dev) {
    var fa = null;
    if (dev && dev.detail && dev.detail.foreground_app) fa = dev.detail.foreground_app;
    else if (dev && dev.adb && dev.adb.foreground_app) fa = dev.adb.foreground_app;
    if (!fa || (!fa.package && !fa.label)) return null;
    return { text: fa.label || fa.package, pkg: fa.package || null };
  }

  /* ---------- kecepatan dari selisih sampel rx/tx ---------- */

  function computeRate(prev, cur) {
    if (!prev || !cur) return null;
    var dt = cur.ts - prev.ts;
    if (dt <= 0) return null;
    var drx = cur.rx - prev.rx;
    var dtx = cur.tx - prev.tx;
    if (drx < 0 || dtx < 0) return null; // counter reset (HP reboot)
    return { rx: drx / dt, tx: dtx / dt };
  }

  /* store[ip] = {prev, cur, rate}. Sampel baru hanya dihitung kalau rxtx_ts berubah. */
  function updateSample(store, dev) {
    var s = store[dev.ip] || (store[dev.ip] = { prev: null, cur: null, rate: null });
    if (!dev.rxtx_available || dev.rx_bytes == null || dev.tx_bytes == null || dev.rxtx_ts == null) {
      s.prev = null; s.cur = null; s.rate = null;
      return null;
    }
    var sample = { rx: dev.rx_bytes, tx: dev.tx_bytes, ts: dev.rxtx_ts };
    if (s.cur && s.cur.ts === sample.ts) return s.rate;
    s.prev = s.cur;
    s.cur = sample;
    s.rate = computeRate(s.prev, s.cur);
    return s.rate;
  }

  /* ---------- klien API ---------- */

  function ApiError(kind, message, status, code) {
    this.name = 'ApiError';
    this.kind = kind;       // 'config' | 'network' | 'auth' | 'http'
    this.message = message;
    this.status = status || 0;
    this.code = code || null;
  }
  ApiError.prototype = Object.create(Error.prototype);
  ApiError.prototype.constructor = ApiError;

  var ERROR_TEXT = {
    unauthorized: 'Token salah atau belum diisi.',
    not_found: 'Data tidak ditemukan di router.',
    invalid_ip: 'Format IP tidak valid.',
    invalid_port: 'Port ADB tidak valid (1–65535).',
    invalid_json: 'Permintaan tidak dapat dibaca router.',
    ip_duplicate: 'IP ini sudah terdaftar.',
    method_not_allowed: 'Metode tidak didukung router.',
    detail_requires_ip: 'Detail butuh IP perangkat.'
  };

  function errorMessage(err) {
    if (!err) return 'Terjadi kesalahan.';
    if (err.kind === 'config') return err.message;
    if (err.kind === 'network') return 'Router tidak terjangkau (' + (err.message || 'jaringan') + '). Cek WiFi/Tailscale dan URL.';
    if (err.code && ERROR_TEXT[err.code]) return ERROR_TEXT[err.code];
    if (err.kind === 'auth') return ERROR_TEXT.unauthorized;
    return err.message || 'Terjadi kesalahan.';
  }

  function parseBody(data) {
    if (typeof data !== 'string') return data;
    try { return JSON.parse(data); } catch (e) { return data; }
  }

  /* opts.getSettings() -> { urls: [url1, url2], token }
   * opts.transport(req) -> Promise<{status, data}>   req: {url, method, headers, body, timeout} */
  function createApi(opts) {
    var lastGood = ''; // URL yang terakhir berhasil: dicoba lebih dulu agar tidak menunggu URL mati satu per satu

    function request(method, path, body, timeoutMs) {
      var st = opts.getSettings();
      var bases = (st.urls || []).map(normalizeBaseUrl).filter(Boolean)
        .filter(function (b, i, arr) { return arr.indexOf(b) === i; });
      if (!bases.length) return Promise.reject(new ApiError('config', 'URL API belum diatur.'));
      if (lastGood && bases.indexOf(lastGood) > 0) {
        bases = [lastGood].concat(bases.filter(function (b) { return b !== lastGood; }));
      }
      if (!st.token) return Promise.reject(new ApiError('config', 'Token belum diatur.'));

      var headers = { 'Authorization': 'Bearer ' + st.token, 'Accept': 'application/json' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      var lastErr = null;
      var chain = Promise.resolve();
      var result = null;

      bases.forEach(function (base) {
        chain = chain.then(function () {
          if (result) return;
          return Promise.resolve()
            .then(function () {
              return opts.transport({ url: base + path, method: method, headers: headers, body: body, timeout: timeoutMs });
            })
            .then(function (res) {
              var data = parseBody(res.data);
              if (res.status >= 200 && res.status < 300) { result = { data: data, base: base }; lastGood = base; return; }
              // Router menjawab (walau galat HTTP): URL ini terjangkau.
              lastGood = base;
              var code = data && typeof data === 'object' ? data.error : null;
              // Kesalahan HTTP berarti router menjawab: jangan coba URL cadangan.
              throw new ApiError(res.status === 401 ? 'auth' : 'http', code || ('HTTP ' + res.status), res.status, code);
            })
            .catch(function (e) {
              if (e instanceof ApiError && e.kind !== 'network') throw e;
              lastErr = (e instanceof ApiError) ? e : new ApiError('network', (e && e.message) || 'gagal terhubung');
            });
        });
      });

      return chain.then(function () {
        if (result) return result;
        throw lastErr || new ApiError('network', 'gagal terhubung');
      });
    }

    return {
      request: request,
      status: function () {
        return request('GET', '/status', undefined, 15000).then(function (r) {
          var d = r.data || {};
          return { timestamp: d.timestamp || null, devices: Array.isArray(d.devices) ? d.devices : [], base: r.base };
        });
      },
      detail: function (ip) {
        return request('GET', '/status?ip=' + encodeURIComponent(ip) + '&detail=1', undefined, 20000)
          .then(function (r) { return r.data; });
      },
      targets: function () {
        return request('GET', '/targets', undefined, 15000).then(function (r) { return r.data; });
      },
      addTarget: function (t) {
        return request('POST', '/targets/add', { ip: t.ip, nama: t.nama, port_adb: Number(t.port_adb) }, 15000)
          .then(function (r) { return r.data; });
      },
      deleteTarget: function (ip) {
        return request('POST', '/targets/delete', { ip: ip }, 15000).then(function (r) { return r.data; });
      }
    };
  }

  /* Transport fetch (browser / Node). Di aplikasi native dipakai CapacitorHttp (lihat app.js). */
  function fetchTransport(req) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, req.timeout || 15000) : null;
    return fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (t) { return { status: res.status, data: t }; });
    }).then(function (out) { clearTimeout(timer); return out; },
      function (e) { clearTimeout(timer); throw (e && e.name === 'AbortError') ? new Error('waktu habis') : e; });
  }

  return {
    DEFAULT_PATH: DEFAULT_PATH,
    isValidIPv4: isValidIPv4,
    isValidPort: isValidPort,
    normalizeBaseUrl: normalizeBaseUrl,
    escapeHtml: escapeHtml,
    formatBytes: formatBytes,
    formatRate: formatRate,
    formatUptime: formatUptime,
    formatAge: formatAge,
    parseLatency: parseLatency,
    wifiBars: wifiBars,
    displayName: displayName,
    altName: altName,
    chargeSourceText: chargeSourceText,
    isCharging: isCharging,
    formatTemp: formatTemp,
    tempLevel: tempLevel,
    formatVoltage: formatVoltage,
    formatCurrent: formatCurrent,
    formatDrain: formatDrain,
    estimateRemaining: estimateRemaining,
    foregroundApp: foregroundApp,
    computeRate: computeRate,
    updateSample: updateSample,
    ApiError: ApiError,
    errorMessage: errorMessage,
    createApi: createApi,
    fetchTransport: fetchTransport
  };
});
