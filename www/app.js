/* ADB WiFi Monitor — UI. Logika murni ada di lib.js (HPLib). */
(function () {
  'use strict';

  var L = window.HPLib;
  var esc = L.escapeHtml;
  function $(sel) { return document.querySelector(sel); }

  var STALE_MS = 180000; // data router dianggap basi bila timestamp tak berubah 3 menit

  var state = {
    settings: { url1: '', url2: '', url3: '', token: '', cfkey: '', interval: 30 },
    devices: [],
    serverTs: null,
    tsChangedAt: 0,
    fetchedAt: 0,
    error: null,
    samples: {},
    detailIp: null,
    selectedIp: null,   // HP yang tampil di layar fokus
    live: {},           // ip -> { status: loading|ok|error, detail, err, at } (RAM/CPU dari ADB)
    auto: true,         // segarkan otomatis
    busyIp: null,       // IP yang sedang disegarkan lewat tombol
    enter: true,        // mainkan animasi masuk pada render berikutnya
    enterUntil: 0,      // render ulang ditunda sampai animasi masuk selesai
    tools: {}           // ip -> { shot: {status,res,err}, optim: {status,res,err} }
  };
  var inflight = false;
  var timer = null;
  var fastTimer = null;
  var fastEnd = 0;
  var resumeQueued = false;
  var detailSeq = 0;
  var detailApps = [];
  var toastTimer = null;

  /* ---------- penyimpanan (Preferences native, cadangan localStorage) ---------- */

  function prefs() {
    var C = window.Capacitor;
    return C && C.Plugins && C.Plugins.Preferences ? C.Plugins.Preferences : null;
  }
  async function storeGet(key) {
    var p = prefs();
    if (p) { try { var r = await p.get({ key: key }); return r.value; } catch (e) { /* jatuh ke localStorage */ } }
    try { return window.localStorage.getItem(key); } catch (e2) { return null; }
  }
  async function storeSet(key, val) {
    var p = prefs();
    if (p) { try { await p.set({ key: key, value: String(val) }); return; } catch (e) { /* jatuh ke localStorage */ } }
    try { window.localStorage.setItem(key, String(val)); } catch (e2) { /* abaikan */ }
  }

  /* ---------- transport HTTP ---------- */

  function isNative() {
    var C = window.Capacitor;
    return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform() &&
      C.Plugins && C.Plugins.CapacitorHttp);
  }
  function nativeTransport(req) {
    return window.Capacitor.Plugins.CapacitorHttp.request({
      url: req.url,
      method: req.method,
      headers: req.headers,
      data: req.body,
      connectTimeout: 5000,
      readTimeout: req.timeout || 15000,
      responseType: 'text'
    }).then(function (r) { return { status: r.status, data: r.data }; });
  }
  function transport(req) { return isNative() ? nativeTransport(req) : L.fetchTransport(req); }

  var api = L.createApi({
    getSettings: function () { return { urls: [state.settings.url1, state.settings.url2, state.settings.url3], token: state.settings.token, cfkey: state.settings.cfkey }; },
    transport: transport
  });

  /* ---------- lapisan (modal) dengan tombol Kembali Android ---------- */

  var layers = [];
  function openLayer(id) {
    $('#' + id).classList.remove('hidden');
    layers.push(id);
    try { window.history.pushState({ layer: id }, ''); } catch (e) { /* abaikan */ }
  }
  function backLayer() { if (layers.length) window.history.back(); }
  window.addEventListener('popstate', function () {
    var id = layers.pop();
    if (!id) return;
    $('#' + id).classList.add('hidden');
    if (id === 'layerDetail') { state.detailIp = null; detailSeq++; }
  });
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('[data-close]')) backLayer();
  });

  /* ---------- toast & banner ---------- */

  function toast(msg, isErr) {
    var el = $('#toast');
    el.textContent = msg;
    el.className = 'toast' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.add('hidden'); }, 3200);
  }

  function configured() { return !!(state.settings.url1 && state.settings.token); }

  function renderBanner() {
    var el = $('#banner');
    var msg = '', cls = 'banner';
    if (!configured()) {
      msg = 'Belum diatur. Buka pengaturan (ikon gerigi) untuk mengisi URL router dan token.';
      cls += ' warn';
    } else if (state.error) {
      msg = L.errorMessage(state.error);
      if (state.devices.length) msg += ' Menampilkan data terakhir (' + L.formatAge((Date.now() - state.fetchedAt) / 1000) + ' lalu).';
    } else if (state.devices.length && state.serverTs) {
      var ageSec = Math.max(0, Math.floor(Date.now() / 1000 - Number(state.serverTs)));
      msg = 'Diperbarui ' + L.formatAge(ageSec) + ' lalu';
      if (ageSec * 1000 > STALE_MS) {
        msg += '. Data di router mungkin basi.';
        cls += ' warn';
      } else {
        cls += ' ok';
      }
    }
    el.className = msg ? cls : 'banner hidden';
    el.textContent = msg;
  }

  /* ---------- potongan HTML ---------- */

  function badge(text, kind) { return '<span class="badge ' + (kind || '') + '">' + esc(text) + '</span>'; }
  function metric(label, html, wide) {
    return '<div class="m' + (wide ? ' wide' : '') + '"><label>' + esc(label) + '</label><div>' + html + '</div></div>';
  }
  function bar(pct, extra) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    var cls = extra || (pct >= 50 ? '' : (pct >= 20 ? 'mid' : 'low'));
    return '<div class="bar"><i class="' + cls + '" style="width:' + pct + '%"></i></div>';
  }
  function wifiIcon(bars) {
    var h = '<span class="wifi">';
    for (var i = 1; i <= 4; i++) h += '<i class="' + (i <= bars ? 'on' : '') + '"></i>';
    return h + '</span>';
  }
  var BOLT = '<svg class="bolt" viewBox="0 0 9 12" aria-hidden="true"><path d="M5.5 0L0 7h3.5L3 12l6-7.5H5.5z"/></svg>';

  function batteryHtml(dev) {
    var a = dev.adb || {};
    if (a.status !== 'connected') return '';
    var bat = a.battery === undefined || a.battery === null || a.battery === '' ? null : Number(a.battery);
    if (bat !== null && isNaN(bat)) bat = null;
    var chg = L.isCharging(dev);
    var h = '<div class="sec"><h3>Baterai</h3><div class="hero">' + (chg ? BOLT : '') +
      '<b>' + (bat === null ? '—' : bat + '%') + '</b><span>' +
      (chg ? 'Mengisi' + (L.chargeSourceText(a.charge_source) ? ' · ' + esc(L.chargeSourceText(a.charge_source)) : '') :
        (a.charging === false ? 'Tidak mengisi' : '')) + '</span></div>' +
      (bat === null ? '' : bar(bat)) + '<div class="kv" style="margin-top:12px">';
    // Label mengisi/dipakai sengaja TIDAK dari tanda current_ma: konvensi tanda beda-beda
    // per vendor/HP (terkonfirmasi -- lihat CHANGELOG v0.7.0), jadi ikut status charging
    // yang sudah independen dan lebih andal (dumpsys battery), bukan menebak dari tanda.
    h += metric('Arus', typeof a.current_ma === 'number' ? esc(L.formatCurrent(a.current_ma)) +
      ' <span class="sub">' + (chg ? 'mengisi' : 'dipakai') + '</span>' :
      '<span class="unavail">Tidak tersedia (dibatasi Android)</span>');
    h += metric('Suhu', '<span class="temp-' + (L.tempLevel(a.temp_c) || 'ok') + '">' + esc(L.formatTemp(a.temp_c)) + '</span>');
    h += metric('Tegangan', esc(L.formatVoltage(a.voltage_mv)));
    if (chg) {
      h += metric('Pemakaian rata-rata', '<span class="unavail">Tidak dihitung saat mengisi</span>');
    } else if (typeof a.avg_drain_pct_per_hour === 'number') {
      var rem = L.estimateRemaining(bat, a.avg_drain_pct_per_hour);
      h += metric('Pemakaian rata-rata', esc(L.formatDrain(a.avg_drain_pct_per_hour)) + (rem ? ' <span class="sub">sisa ' + esc(rem) + '</span>' : ''));
    } else {
      h += metric('Pemakaian rata-rata', '<span class="unavail">Mengumpulkan data (butuh ±30 menit tanpa mengisi)</span>');
    }
    return h + '</div></div>';
  }

  function foregroundHtml(dev) {
    var fg = L.foregroundApp(dev);
    var a = dev.adb || {};
    if (fg) return esc(fg.text) + (fg.pkg && fg.pkg !== fg.text ? '<div class="sub mono" style="margin-top:2px">' + esc(fg.pkg) + '</div>' : '');
    if (a.screen === 'Asleep') return '<span class="unavail">Layar mati</span>';
    return '<span class="unavail">Tidak terdeteksi</span>';
  }

  function screenText(s) {
    if (s === 'Awake') return 'Menyala';
    if (s === 'Asleep') return 'Tidur';
    if (s === 'Dozing') return 'Doze';
    return s ? esc(s) : '—';
  }

  function metricsHtml(dev, inDetail) {
    var r = dev.router || {}, a = dev.adb || {};
    var lat = L.parseLatency(r.latency);
    var latHtml = lat === null ? '—' : lat + ' ms';
    var h = '<div class="metrics">';

    if (a.status === 'connected') {
      var bat = a.battery === undefined || a.battery === null || a.battery === '' ? null : Number(a.battery);
      if (!inDetail) h += metric('Baterai', (L.isCharging(dev) ? BOLT : '') + (bat === null || isNaN(bat) ? '—' : (bat + '%' + bar(bat))));
      h += metric('Layar', screenText(a.screen));
      h += metric('Perangkat', esc((a.model || '—') + (a.android ? ' · Android ' + a.android : '')), true);
      var rssi = typeof a.wifi_rssi === 'number' ? a.wifi_rssi : null;
      h += metric('WiFi', wifiIcon(L.wifiBars(rssi)) + esc(a.wifi_ssid || '—') + (rssi === null ? '' : ' · ' + rssi + ' dBm'), true);
      h += metric('Latensi', latHtml);
      h += metric('Aktif sejak boot', L.formatUptime(a.uptime));
      if (dev.rxtx_available) {
        var rate = (state.samples[dev.ip] || {}).rate;
        h += metric('Kecepatan', rate
          ? '<span class="dl">&#8595; ' + L.formatRate(rate.rx) + '</span> <span class="ul">&#8593; ' + L.formatRate(rate.tx) + '</span>'
          : '<span class="sub">menunggu sampel…</span>');
        h += metric('Total sejak boot', '<span class="dl">&#8595; ' + L.formatBytes(dev.rx_bytes) + '</span> <span class="ul">&#8593; ' + L.formatBytes(dev.tx_bytes) + '</span>');
      }
      if (r.online) h += metric('Koneksi di router', String(r.connections == null ? '—' : r.connections));
    } else {
      h += metric('Latensi', latHtml);
      h += metric('Koneksi di router', r.online ? String(r.connections == null ? '—' : r.connections) : '—');
      h += metric('MAC', esc(r.mac || '—'), true);
    }
    return h + '</div>';
  }

  function noteHtml(dev) {
    var r = dev.router || {}, a = dev.adb || {};
    if (a.status === 'connected') return '';
    if (r.online) {
      return '<p class="note">Router melihat HP ini, tetapi ADB belum terhubung. Aktifkan Wireless Debugging di HP, lalu pastikan port-nya sama dengan yang tersimpan (' + esc(dev.port_adb) + ').</p>';
    }
    return '<p class="note">HP tidak terjangkau dari router (mati, di luar jaringan ini, atau IP berubah).</p>';
  }

  /* ---------- fokus satu HP ---------- */

  var RING_C = 276.5; // keliling cincin r=44
  var ICON_REFRESH = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>';

  function statusKind(dev) {
    var r = dev.router || {}, a = dev.adb || {};
    if (r.online && a.status === 'connected') return 'ok';
    if (r.online) return 'warn';
    return 'off';
  }

  function selectedDev() {
    var d = state.selectedIp ? findDev(state.selectedIp) : null;
    if (!d && state.devices.length) { d = state.devices[0]; state.selectedIp = d.ip; }
    return d;
  }

  function batteryLevel(dev) {
    var a = dev.adb || {};
    if (a.status !== 'connected' || a.battery === undefined || a.battery === null || a.battery === '') return null;
    var n = Number(a.battery);
    return isNaN(n) ? null : n;
  }

  function renderChips() {
    var el = $('#chips');
    if (!state.devices.length) { el.innerHTML = ''; return; }
    var sel = selectedDev();
    el.innerHTML = state.devices.map(function (dev) {
      var k = statusKind(dev), on = !!sel && sel.ip === dev.ip;
      return '<button type="button" class="chip' + (on ? ' on' : '') + '" data-chip="' + esc(dev.ip) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' +
        '<span class="dot ' + k + (k === 'ok' ? ' live' : '') + '"></span>' + esc(L.displayName(dev)) + '</button>';
    }).join('');
  }

  function ringHtml(bat, chg) {
    var head = '<svg class="ring" width="104" height="104" viewBox="0 0 104 104" role="img" aria-label="' +
      (bat === null ? 'Baterai tidak diketahui' : 'Baterai ' + bat + ' persen') + '">';
    if (bat === null) {
      return head + '<circle class="ring-empty" cx="52" cy="52" r="44"/><text class="ring-text" x="52" y="60" text-anchor="middle">&#8212;</text></svg>';
    }
    var dash = Math.round(Math.max(0, Math.min(100, bat)) / 100 * RING_C * 10) / 10;
    var cls = chg ? 'chg' : (bat >= 50 ? '' : (bat >= 20 ? 'mid' : 'low'));
    return head + '<circle class="ring-track" cx="52" cy="52" r="44"/>' +
      '<circle class="ring-fill ' + cls + '" cx="52" cy="52" r="44" transform="rotate(-90 52 52)" style="--dash:' + dash + ';stroke-dasharray:' + dash + ' ' + RING_C + '"/>' +
      '<text class="ring-text" x="52" y="60" text-anchor="middle">' + bat + '%</text></svg>';
  }

  function heroHtml(dev) {
    var r = dev.router || {}, a = dev.adb || {};
    var conn = a.status === 'connected';
    var chg = L.isCharging(dev);
    var lat = L.parseLatency(r.latency);
    var latText = lat === null ? '—' : lat + ' ms';
    var h = '<section class="hero-card">' + ringHtml(batteryLevel(dev), chg) + '<div class="hero-info">';
    if (conn) {
      var rssi = typeof a.wifi_rssi === 'number' ? a.wifi_rssi : null;
      var src = L.chargeSourceText(a.charge_source);
      h += '<h2>' + esc(a.model || L.displayName(dev)) + '</h2>' +
        '<p>' + esc(L.displayName(dev)) + (a.android ? ' · Android ' + esc(a.android) : '') + '</p>' +
        '<p class="mono">' + esc(dev.ip) + ':' + esc(dev.port_adb) + '</p>' +
        '<p class="strong">' + (chg ? BOLT + 'Mengisi' + (src ? ' · ' + esc(src) : '') : (a.charging === false ? 'Tidak mengisi' : '')) +
        ((chg || a.charging === false) ? ' · ' : '') + 'Layar ' + screenText(a.screen).toLowerCase() + '</p>' +
        '<p>' + wifiIcon(L.wifiBars(rssi)) + esc(a.wifi_ssid || '—') + (rssi === null ? '' : ' · ' + rssi + ' dBm') + ' · ' + esc(latText) + '</p>';
    } else {
      h += '<h2>' + esc(L.displayName(dev)) + '</h2>' +
        '<p class="mono">' + esc(dev.ip) + ':' + esc(dev.port_adb) + '</p>' +
        (L.altName(dev) ? '<p>' + esc(L.altName(dev)) + '</p>' : '') +
        '<p class="strong">' + (r.online ? 'Online · ADB belum tersambung' : 'Offline') + '</p>' +
        (r.online ? '<p>Latensi ' + esc(latText) + '</p>' : '');
    }
    return h + '</div></section>';
  }

  function tile(label, valueHtml, subHtml, none) {
    return '<div class="tile"><label>' + esc(label) + '</label><b' + (none ? ' class="none"' : '') + '>' + valueHtml + '</b>' +
      (subHtml ? '<small>' + subHtml + '</small>' : '') + '</div>';
  }

  function tilesHtml(dev) {
    var a = dev.adb || {};
    var chg = L.isCharging(dev);
    var bat = batteryLevel(dev);
    var live = state.live[dev.ip];
    var detail = live && live.detail ? live.detail : null;
    var t = '';

    t += typeof a.temp_c === 'number'
      ? tile('Suhu', '<span class="temp-' + (L.tempLevel(a.temp_c) || 'ok') + '">' + esc(L.formatTemp(a.temp_c)) + '</span>', 'Baterai')
      : tile('Suhu', '&#8212;', 'Baterai', true);
    t += typeof a.voltage_mv === 'number'
      ? tile('Tegangan', esc(L.formatVoltage(a.voltage_mv)), esc(a.voltage_mv) + ' mV')
      : tile('Tegangan', '&#8212;', 'Baterai', true);
    // Label mengisi/dipakai mengikuti status charging, bukan tanda current_ma (lihat CHANGELOG v0.7.0).
    t += typeof a.current_ma === 'number'
      ? tile('Arus', esc(L.formatCurrent(a.current_ma)), chg ? 'mengisi' : 'dipakai')
      : tile('Arus', '&#8212;', 'Dibatasi Android', true);
    if (chg) {
      t += tile('Sisa waktu', '&#8212;', 'Sedang mengisi', true);
    } else if (typeof a.avg_drain_pct_per_hour === 'number') {
      var rem = L.estimateRemaining(bat, a.avg_drain_pct_per_hour);
      t += tile('Sisa waktu', rem ? esc(rem) : '&#8212;', esc(L.formatDrain(a.avg_drain_pct_per_hour)), !rem);
    } else {
      t += tile('Sisa waktu', '&#8212;', 'Data belum cukup', true);
    }

    var loading = live && live.status === 'loading';
    var ru = detail ? L.ramUsage(detail.ram) : null;
    if (ru) {
      t += tile('RAM terpakai', ru.pct + '%', esc(L.formatBytes(ru.freeKb * 1024)) + ' bebas dari ' + esc(L.formatBytes(ru.totalKb * 1024)));
    } else {
      t += tile('RAM terpakai', loading ? '&#8230;' : '&#8212;', loading ? 'Memuat lewat ADB' : (live && live.status === 'error' ? 'Gagal memuat' : 'Tekan Segarkan'), true);
    }
    var cpu = detail ? detail.cpu_percent : null;
    if (typeof cpu === 'number') {
      t += tile('CPU', cpu + '%', 'Sampel 1 detik');
    } else {
      t += tile('CPU', loading ? '&#8230;' : '&#8212;', loading ? 'Memuat lewat ADB' : (live && live.status === 'error' ? 'Gagal memuat' : 'Tekan Segarkan'), true);
    }
    return '<div class="tiles">' + t + '</div>';
  }

  function trafficHtml(dev) {
    if (!dev.rxtx_available) return '<div class="traffic"><div class="now"><span class="sub">Trafik tidak tersedia</span></div></div>';
    var rate = (state.samples[dev.ip] || {}).rate;
    var now = rate
      ? '<span class="dl">&#8595; ' + L.formatRate(rate.rx) + '</span> · <span class="ul">&#8593; ' + L.formatRate(rate.tx) + '</span>'
      : '<span class="sub">menunggu sampel…</span>';
    return '<div class="traffic"><div class="now">' + now + '</div><div class="tot">' +
      '<span class="dl">&#8595; ' + L.formatBytes(dev.rx_bytes) + '</span> · <span class="ul">&#8593; ' + L.formatBytes(dev.tx_bytes) + '</span><br>sejak boot</div></div>';
  }

  var deferTimer = null;
  function renderFocus(force) {
    var el = $('#focus');
    var dev = selectedDev();
    if (!dev) {
      el.className = 'focus';
      el.innerHTML = '<div class="empty">' + (configured()
        ? (state.error ? 'Belum ada data.' : 'Belum ada target. Tekan + untuk menambah IP HP yang ingin dipantau.')
        : 'Isi URL router dan token di pengaturan untuk mulai memantau.') + '</div>';
      return;
    }
    var enter = state.enter;
    // Selama animasi masuk berjalan, render ulang (polling, RAM/CPU datang) ditunda sampai animasi selesai
    // supaya animasinya tidak terpotong. Aksi pengguna memakai force.
    var left = state.enterUntil - Date.now();
    if (!enter && !force && left > 0) {
      if (!deferTimer) deferTimer = setTimeout(function () { deferTimer = null; renderFocus(); }, left + 20);
      return;
    }
    state.enter = false;
    if (enter) state.enterUntil = Date.now() + 1400;
    el.className = 'focus' + (state.error ? ' stale' : '') + (enter ? ' enter' : '');
    var conn = dev.adb && dev.adb.status === 'connected';
    var busy = state.busyIp === dev.ip;
    var sec = Number(state.settings.interval) || 30;
    var h = heroHtml(dev);
    h += '<div class="actions"><button type="button" class="btn-refresh' + (busy ? ' busy' : '') + '" data-act="refresh"' + (busy ? ' disabled' : '') + '>' +
      ICON_REFRESH + 'Segarkan HP ini</button>' +
      '<button type="button" class="btn-auto" data-act="auto" aria-pressed="' + (state.auto ? 'true' : 'false') + '">' +
      (state.auto ? 'Auto ' + sec + ' dtk' : 'Auto mati') + '</button></div>';
    if (conn) {
      h += tilesHtml(dev) + trafficHtml(dev);
      var live = state.live[dev.ip];
      h += '<div class="panel"><label>Aplikasi aktif</label><div class="val">' +
        foregroundHtml(Object.assign({}, dev, { detail: live && live.detail ? live.detail : undefined })) + '</div></div>';
    } else {
      h += '<div class="panel">' + metricsHtml(dev, true) + noteHtml(dev) + '</div>';
    }
    if (conn) h += toolsHtml(dev.ip);
    el.innerHTML = h;
  }

  /* RAM/CPU datang dari /status?detail=1 (±8 dtk via ADB): hanya untuk HP terpilih,
     saat dipilih, saat pertama kali terhubung, dan saat tombol Segarkan ditekan. */
  function liveNeeded(ip, mode) {
    var dev = findDev(ip);
    if (!dev || !dev.adb || dev.adb.status !== 'connected') return false;
    var lv = state.live[ip];
    if (lv && lv.status === 'loading') return false;
    if (mode === 'force' || !lv) return true;
    if (mode === 'select') return Date.now() - lv.at > 120000;
    return false;
  }

  async function loadLive(ip) {
    var prev = state.live[ip];
    state.live[ip] = { status: 'loading', detail: prev ? prev.detail : null, at: Date.now() };
    try {
      var res = await api.detail(ip);
      state.live[ip] = { status: 'ok', detail: res && res.detail ? res.detail : null, at: Date.now() };
    } catch (e) {
      state.live[ip] = { status: 'error', detail: state.live[ip].detail, err: L.errorMessage(e), at: Date.now() };
    }
    if (state.selectedIp === ip) renderFocus();
  }

  function selectDevice(ip) {
    if (!findDev(ip) || ip === state.selectedIp) return;
    state.selectedIp = ip;
    storeSet('sel', ip);
    state.enter = true;
    if (liveNeeded(ip, 'select')) loadLive(ip); // set status loading secara sinkron sebelum render
    renderChips();
    renderFocus();
    var chip = document.querySelector('.chip.on');
    if (chip && chip.scrollIntoView) { try { chip.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' }); } catch (e) { /* abaikan */ } }
  }

  async function focusRefresh() {
    var ip = state.selectedIp;
    if (!ip || state.busyIp) return;
    state.busyIp = ip;
    renderFocus(true);
    try {
      await refreshIp(ip, null);
      if (findDev(ip) && liveNeeded(ip, 'force')) {
        var p = loadLive(ip);
        renderFocus(true);
        await p;
      }
    } finally {
      state.busyIp = null;
      renderFocus(true);
    }
  }

  function toggleAuto() {
    state.auto = !state.auto;
    storeSet('auto', state.auto ? '1' : '0');
    if (state.auto) {
      startPolling();
      refresh(false);
    } else {
      stopPolling();
      if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
      fastEnd = 0;
    }
    renderFocus(true);
  }

  function renderPulse() {
    var p = $('#pulse');
    p.className = 'pulse' + (state.error ? ' bad' : (state.devices.length ? ' ok' : ''));
  }

  function renderAll() {
    renderBanner();
    renderChips();
    renderFocus();
    renderPulse();
    if (state.detailIp) {
      var dev = findDev(state.detailIp);
      var top = $('#dBasic');
      if (dev && top) top.innerHTML = metricsHtml(dev, true) + noteHtml(dev);
      var bt = $('#dBattery');
      if (dev && bt) bt.innerHTML = batteryHtml(dev);
    }
  }

  function findDev(ip) {
    for (var i = 0; i < state.devices.length; i++) if (state.devices[i].ip === ip) return state.devices[i];
    return null;
  }

  /* ---------- polling ---------- */

  function setSpin(on) { $('#btnRefresh').classList.toggle('spin', on); }

  async function refresh(manual) {
    if (inflight) return;
    if (!configured()) { renderAll(); return; }
    inflight = true;
    setSpin(true);
    try {
      var res = await api.status();
      if (res.timestamp !== state.serverTs || !state.tsChangedAt) state.tsChangedAt = Date.now();
      state.devices = res.devices;
      state.serverTs = res.timestamp;
      state.fetchedAt = Date.now();
      state.error = null;
      var seen = {};
      state.devices.forEach(function (d) { seen[d.ip] = true; L.updateSample(state.samples, d); });
      Object.keys(state.samples).forEach(function (ip) { if (!seen[ip]) delete state.samples[ip]; });
    } catch (e) {
      state.error = e;
      if (manual) toast(L.errorMessage(e), true);
    } finally {
      inflight = false;
      setSpin(false);
      // Resume yang datang saat request berjalan jangan sampai hilang.
      if (resumeQueued) { resumeQueued = false; resumeCycle(); }
    }
    // Tandai "memuat" RAM/CPU sebelum render supaya hanya ada satu render (animasi masuk tidak terpotong).
    var sd = selectedDev();
    if (sd && liveNeeded(sd.ip, 'poll')) loadLive(sd.ip);
    renderAll();
  }

  /* Segarkan satu perangkat via POST /refresh {ip}. */
  async function refreshIp(ip, triggerEl) {
    var card = triggerEl ? triggerEl.closest('.card') : null;
    if (card) card.classList.add('refreshing');
    try {
      var res = await api.refreshIp(ip);
      var dev = findDev(ip);
      if (dev && res && typeof res === 'object') {
        Object.keys(res).forEach(function (k) { dev[k] = res[k]; });
        dev.ip = ip;
      }
      renderAll();
      toast('Diperbarui: ' + ip);
    } catch (e) {
      var msg = L.errorMessage(e);
      if (/404|not_found/i.test(msg)) {
        toast('Router merespons 404 untuk ' + ip + ', segarkan semua.');
        refresh(false);
      } else {
        toast('Gagal segarkan ' + ip + ': ' + msg, true);
      }
    } finally {
      if (card) card.classList.remove('refreshing');
    }
  }

  function startPolling() {
    stopPolling();
    if (!state.auto) return;
    if (Date.now() >= fastEnd) {
      var sec = Number(state.settings.interval) || 30;
      timer = setInterval(function () { if (!document.hidden) refresh(false); }, sec * 1000);
    }
  }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }
  function startFastPolling() {
    if (Date.now() >= fastEnd) return;
    if (fastTimer) { clearInterval(fastTimer); fastTimer = null; }
    fastTimer = setInterval(function () {
      if (document.hidden) return;
      if (Date.now() >= fastEnd) {
        clearInterval(fastTimer); fastTimer = null;
        startPolling();
        return;
      }
      refresh(false);
    }, 5000);
  }
  function resumeCycle() {
    if (inflight) { resumeQueued = true; return; }
    if (!configured() || document.hidden) return;
    stopPolling();
    if (state.auto) fastEnd = Date.now() + 60000;
    refresh(false);
    if (state.auto) startFastPolling();
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Date.now() - state.fetchedAt > 5000) resumeCycle();
  });
  window.addEventListener('focus', function () {
    if (!document.hidden && Date.now() - state.fetchedAt > 5000) resumeCycle();
  });
  window.addEventListener('pageshow', function () {
    if (!document.hidden && Date.now() - state.fetchedAt > 5000) resumeCycle();
  });
  // Native app resume via @capacitor/app; fallback DOM events di atas.
  try {
    var C = window.Capacitor;
    if (C && C.Plugins && C.Plugins.App) {
      C.Plugins.App.addListener('appStateChange', function (info) {
        if (info && info.isActive) resumeCycle();
      });
    }
  } catch (e) { /* @capacitor/app tidak tersedia di web, fallback DOM di atas */ }

  /* ---------- detail perangkat ---------- */

  function renderApps(filter) {
    var f = (filter || '').trim().toLowerCase();
    var list = f ? detailApps.filter(function (a) { return a.toLowerCase().indexOf(f) !== -1; }) : detailApps;
    var box = $('#dApps');
    if (!box) return;
    box.innerHTML = list.length ? list.map(function (a) { return '<div>' + esc(a) + '</div>'; }).join('')
      : '<div>Tidak ada yang cocok.</div>';
    var c = $('#dAppCount');
    if (c) c.textContent = list.length + ' dari ' + detailApps.length + ' aplikasi';
  }

  function detailHtml(dev, detail, mode) {
    var h = '<div id="dBasic">' + metricsHtml(dev, true) + noteHtml(dev) + '</div><div id="dBattery">' + batteryHtml(dev) + '</div>';
    if (mode === 'none') return h;
    h += '<div class="sec"><h3>Detail langsung dari HP</h3><div id="dLive">';
    if (mode === 'loading') {
      h += '<div class="skeleton"></div><div class="skeleton" style="width:70%"></div><div class="skeleton" style="width:85%"></div>' +
        '<p class="sub">Mengambil lewat ADB, bisa sampai ±10 detik…</p>';
    } else if (mode === 'error') {
      h += '<p class="form-error">' + esc(detail) + '</p>';
    } else if (!detail) {
      h += '<p class="note">Detail tidak tersedia karena ADB tidak terhubung.</p>';
    } else {
      var ram = detail.ram || {};
      var total = Number(ram.total_kb), avail = Number(ram.available_kb);
      var used = total > 0 && !isNaN(avail) ? total - avail : null;
      var usedPct = used !== null ? Math.round(used / total * 100) : null;
      h += '<div class="metrics">';
      h += metric('RAM terpakai', usedPct === null ? '—' :
        (L.formatBytes(used * 1024) + ' / ' + L.formatBytes(total * 1024) + ' (' + usedPct + '%)' +
          bar(100 - usedPct, usedPct >= 85 ? 'low' : (usedPct >= 70 ? 'mid' : 'cy'))), true);
      var cpu = detail.cpu_percent;
      h += metric('CPU', cpu === null || cpu === undefined ? '—' :
        (cpu + '%' + bar(100 - cpu, cpu >= 85 ? 'low' : (cpu >= 60 ? 'mid' : 'cy'))), true);
      h += metric('Aplikasi aktif', foregroundHtml(Object.assign({}, dev, { detail: detail })), true);
      h += '</div>';
    }
    h += '</div></div>';
    if (mode === 'ok' && detail && Array.isArray(detail.apps)) {
      h += '<div class="sec"><h3>Aplikasi pihak ketiga</h3>' +
        '<input class="search" id="dSearch" placeholder="Cari nama paket" autocapitalize="off" spellcheck="false">' +
        '<p class="sub" id="dAppCount" style="margin-top:6px"></p><div class="apps" id="dApps"></div></div>';
    }
    return h;
  }

  function openDetail(ip) {
    var dev = findDev(ip);
    if (!dev) return;
    state.detailIp = ip;
    $('#dTitle').textContent = L.displayName(dev);
    $('#dSub').textContent = dev.ip + ':' + dev.port_adb + (L.altName(dev) ? ' · ' + L.altName(dev) : '');
    openLayer('layerDetail');
    loadDetail();
  }

  async function loadDetail() {
    var ip = state.detailIp;
    var dev = ip && findDev(ip);
    if (!dev) return;
    var seq = ++detailSeq;
    var connected = dev.adb && dev.adb.status === 'connected';
    $('#dBody').innerHTML = detailHtml(dev, null, connected ? 'loading' : 'none');
    if (!connected) return;
    try {
      var res = await api.detail(ip);
      if (seq !== detailSeq || state.detailIp !== ip) return;
      var fresh = findDev(ip) || dev;
      detailApps = res && res.detail && Array.isArray(res.detail.apps) ? res.detail.apps.slice().sort() : [];
      $('#dBody').innerHTML = detailHtml(fresh, res ? res.detail : null, res && res.detail ? 'ok' : 'null');
      if (detailApps.length) {
        renderApps('');
        $('#dSearch').addEventListener('input', function (e) { renderApps(e.target.value); });
      }
    } catch (e) {
      if (seq !== detailSeq || state.detailIp !== ip) return;
      $('#dBody').innerHTML = detailHtml(dev, L.errorMessage(e), 'error');
    }
  }

  /* ---------- screenshot & cek performa (tombol di layar utama, manual) ---------- */

  var ICON_SHOT = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/></svg>';
  var ICON_PERF = '<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/></svg>';

  function toolState(ip, kind) {
    var t = state.tools[ip];
    return t && t[kind] ? t[kind] : null;
  }

  function toolsHtml(ip) {
    var sh = toolState(ip, 'shot'), op = toolState(ip, 'optim');
    var shBusy = !!sh && sh.status === 'loading', opBusy = !!op && op.status === 'loading';
    var h = '<div class="tools">' +
      '<button type="button" class="btn-tool' + (shBusy ? ' busy' : '') + '" data-act="shot"' + (shBusy ? ' disabled' : '') + '>' + ICON_SHOT + 'Screenshot</button>' +
      '<button type="button" class="btn-tool' + (opBusy ? ' busy' : '') + '" data-act="optim"' + (opBusy ? ' disabled' : '') + '>' + ICON_PERF + 'Cek performa</button></div>';
    if (sh) h += '<div class="panel result">' + shotResultHtml(sh) + '</div>';
    if (op) h += '<div class="panel result">' + optimResultHtml(op) + '</div>';
    return h;
  }

  function shotResultHtml(t) {
    var h = '<label>Screenshot</label>';
    if (t.status === 'loading') {
      return h + '<div class="skeleton"></div><div class="skeleton" style="width:60%"></div>' +
        '<p class="sub">Mengambil screenshot lewat ADB, bisa sampai ±2 menit…</p>';
    }
    if (t.status === 'error') return h + '<p class="form-error">' + esc(t.err) + '</p>';
    var res = t.res;
    return h + '<img class="shot-img" alt="Screenshot HP" src="data:image/png;base64,' + res.png_base64 + '">' +
      '<p class="sub" style="margin-top:8px">' + esc(L.formatBytes(res.bytes)) + ' · ' + esc(res.seconds) + ' dtk</p>';
  }

  function optimResultHtml(t) {
    var h = '<label>Cek performa</label>';
    if (t.status === 'loading') {
      return h + '<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>' +
        '<p class="sub">Membaca RAM/CPU lewat ADB…</p>';
    }
    if (t.status === 'error') return h + '<p class="form-error">' + esc(t.err) + '</p>';
    var res = t.res;
    var ru = L.ramUsage(res.ram);
    h += '<div class="metrics" style="margin-top:8px">';
    h += metric('RAM terpakai', ru === null ? '—' :
      (L.formatBytes(ru.usedKb * 1024) + ' / ' + L.formatBytes(ru.totalKb * 1024) + ' (' + ru.pct + '%)' +
        bar(100 - ru.pct, ru.pct >= 85 ? 'low' : (ru.pct >= 70 ? 'mid' : 'cy'))), true);
    var cpu = res.cpu_percent;
    h += metric('CPU', cpu === null || cpu === undefined ? '—' :
      (cpu + '%' + bar(100 - cpu, cpu >= 85 ? 'low' : (cpu >= 60 ? 'mid' : 'cy'))), true);
    h += '</div>';
    if (Array.isArray(res.top_apps) && res.top_apps.length) {
      h += '<p class="sub" style="margin-top:10px">Proses pemakai RAM terbesar</p><div class="apps">';
      res.top_apps.forEach(function (a) {
        h += '<div>' + esc(L.formatBytes(Number(a.kb) * 1024)) + ' — ' + esc(a.label) + '</div>';
      });
      h += '</div>';
    }
    return h;
  }

  async function runTool(kind) {
    var ip = state.selectedIp;
    var dev = ip && findDev(ip);
    if (!dev || !dev.adb || dev.adb.status !== 'connected') return;
    var cur = toolState(ip, kind);
    if (cur && cur.status === 'loading') return;
    var t = state.tools[ip] || (state.tools[ip] = {});
    var seq = ((cur && cur.seq) || 0) + 1;
    t[kind] = { status: 'loading', seq: seq };
    renderFocus(true);
    var result;
    try {
      var res = kind === 'shot' ? await api.screenshot(ip) : await api.optimize(ip);
      var ok = kind === 'shot' ? (res && res.ok && res.png_base64) : (res && res.ok);
      result = ok ? { status: 'ok', res: res, seq: seq }
        : { status: 'error', err: kind === 'shot' ? 'Gagal mengambil screenshot.' : 'Gagal mengambil data performa.', seq: seq };
    } catch (e) {
      result = { status: 'error', err: L.errorMessage(e), seq: seq };
    }
    var now = toolState(ip, kind);
    if (!now || now.seq !== seq) return;
    state.tools[ip][kind] = result;
    if (state.selectedIp === ip) renderFocus(true);
  }

  // Tahan lama pada chip HP membuka lembar detail (detail lengkap, daftar aplikasi, hapus target).
  var pressTimer = null, pressFired = false;
  function chipPress(e) {
    var c = e.target.closest ? e.target.closest('[data-chip]') : null;
    if (!c) return;
    pressFired = false;
    clearTimeout(pressTimer);
    pressTimer = setTimeout(function () {
      pressFired = true;
      var ip = c.getAttribute('data-chip');
      if (ip && findDev(ip)) openDetail(ip);
    }, 600);
  }
  function chipRelease() { clearTimeout(pressTimer); }
  $('#chips').addEventListener('touchstart', chipPress, { passive: true });
  $('#chips').addEventListener('mousedown', chipPress);
  ['touchend', 'touchmove', 'touchcancel', 'mouseup', 'mouseleave'].forEach(function (n) {
    $('#chips').addEventListener(n, chipRelease, { passive: true });
  });
  $('#chips').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  $('#dReload').addEventListener('click', loadDetail);
  $('#dRefreshIp').addEventListener('click', function (e) {
    var ip = state.detailIp;
    if (ip) refreshIp(ip, e.currentTarget);
  });

  $('#dDelete').addEventListener('click', async function () {
    var ip = state.detailIp;
    var dev = ip && findDev(ip);
    if (!dev) return;
    if (!window.confirm('Hapus ' + L.displayName(dev) + ' (' + dev.ip + ') dari daftar pantauan?')) return;
    try {
      await api.deleteTarget(ip);
      toast('Target dihapus.');
      backLayer();
      refresh(false);
    } catch (e) {
      toast(L.errorMessage(e), true);
    }
  });

  $('#focus').addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!t) return;
    var act = t.getAttribute('data-act');
    if (act === 'refresh') focusRefresh();
    else if (act === 'auto') toggleAuto();
    else if (act === 'shot') runTool('shot');
    else if (act === 'optim') runTool('optim');
  });

  $('#chips').addEventListener('click', function (e) {
    var c = e.target.closest ? e.target.closest('[data-chip]') : null;
    if (pressFired) { pressFired = false; return; }
    if (c) selectDevice(c.getAttribute('data-chip'));
  });

  /* ---------- tambah IP ---------- */

  function showFormError(id, msg, ok) {
    var el = $(id);
    el.textContent = msg;
    el.className = 'form-error' + (ok ? ' ok' : '') + (msg ? '' : ' hidden');
  }

  $('#fab').addEventListener('click', function () {
    if (!configured()) { openSettings(true); return; }
    $('#addIp').value = '';
    $('#addNama').value = '';
    $('#addPort').value = '5555';
    showFormError('#addError', '');
    openLayer('layerAdd');
    setTimeout(function () { $('#addIp').focus(); }, 250);
  });

  $('#formAdd').addEventListener('submit', async function (e) {
    e.preventDefault();
    var ip = $('#addIp').value.trim();
    var nama = $('#addNama').value.trim() || ip;
    var port = $('#addPort').value.trim() || '5555';
    if (!L.isValidIPv4(ip)) return showFormError('#addError', 'Format IP tidak valid (contoh 192.168.7.188).');
    if (!L.isValidPort(port)) return showFormError('#addError', 'Port ADB harus angka 1–65535.');
    var btn = $('#addSubmit');
    btn.disabled = true;
    showFormError('#addError', '');
    try {
      await api.addTarget({ ip: ip, nama: nama, port_adb: Number(port) });
      toast('Ditambahkan: ' + nama);
      backLayer();
      refresh(false);
    } catch (err) {
      showFormError('#addError', L.errorMessage(err));
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- pengaturan ---------- */

  function openSettings(first) {
    $('#setUrl1').value = state.settings.url1;
    $('#setUrl2').value = state.settings.url2;
    $('#setUrl3').value = state.settings.url3;
    $('#setToken').value = state.settings.token;
    $('#setCfKey').value = state.settings.cfkey || '';
    $('#setToken').type = 'password';
    $('#tokenToggle').textContent = 'Lihat';
    $('#setInterval').value = String(state.settings.interval);
    showFormError('#setMsg', first ? 'Isi URL router dan token API dulu, lalu simpan.' : '', false);
    if (!first) $('#setMsg').classList.add('hidden');
    openLayer('layerSettings');
  }

  function readSettingsForm() {
    var url1 = L.normalizeBaseUrl($('#setUrl1').value);
    var raw2 = $('#setUrl2').value.trim();
    var url2 = raw2 ? L.normalizeBaseUrl(raw2) : '';
    var raw3 = $('#setUrl3').value.trim();
    var url3 = raw3 ? L.normalizeBaseUrl(raw3) : '';
    var token = $('#setToken').value.trim();
    var cfkey = $('#setCfKey').value.trim();
    if (!url1) return { error: 'URL API utama belum diisi atau tidak valid.' };
    if (raw2 && !url2) return { error: 'URL 2 (Tailscale) tidak valid.' };
    if (raw3 && !url3) return { error: 'URL 3 (Cloudflare) tidak valid.' };
    if (!token) return { error: 'Token API belum diisi.' };
    return { value: { url1: url1, url2: url2, url3: url3, token: token, cfkey: cfkey, interval: Number($('#setInterval').value) || 30 } };
  }

  $('#btnSettings').addEventListener('click', function () { openSettings(false); });
  $('#btnRefresh').addEventListener('click', function () { refresh(true); });
  $('#tokenToggle').addEventListener('click', function () {
    var inp = $('#setToken');
    var show = inp.type === 'password';
    inp.type = show ? 'text' : 'password';
    $('#tokenToggle').textContent = show ? 'Sembunyi' : 'Lihat';
  });

  $('#setTest').addEventListener('click', async function () {
    var f = readSettingsForm();
    if (f.error) return showFormError('#setMsg', f.error);
    var tmp = L.createApi({
      getSettings: function () { return { urls: [f.value.url1, f.value.url2, f.value.url3], token: f.value.token, cfkey: f.value.cfkey }; },
      transport: transport
    });
    showFormError('#setMsg', 'Menguji koneksi…', true);
    try {
      var r = await tmp.status();
      showFormError('#setMsg', 'Terhubung (' + r.base + '). ' + r.devices.length + ' target terbaca.', true);
    } catch (e) {
      showFormError('#setMsg', L.errorMessage(e));
    }
  });

  $('#formSettings').addEventListener('submit', async function (e) {
    e.preventDefault();
    var f = readSettingsForm();
    if (f.error) return showFormError('#setMsg', f.error);
    state.settings = f.value;
    await Promise.all([
      storeSet('url1', f.value.url1), storeSet('url2', f.value.url2), storeSet('url3', f.value.url3),
      storeSet('token', f.value.token), storeSet('cfkey', f.value.cfkey), storeSet('interval', f.value.interval)
    ]);
    state.devices = [];
    state.samples = {};
    state.live = {};
    state.tools = {};
    state.error = null;
    state.tsChangedAt = 0;
    toast('Pengaturan disimpan.');
    backLayer();
    startPolling();
    refresh(true);
  });

  /* ---------- mulai ---------- */

  async function init() {
    var v = await Promise.all([storeGet('url1'), storeGet('url2'), storeGet('token'), storeGet('interval'), storeGet('url3'), storeGet('cfkey'), storeGet('sel'), storeGet('auto')]);
    state.settings = {
      url1: v[0] || '', url2: v[1] || '', url3: v[4] || '', token: v[2] || '', cfkey: v[5] || '',
      interval: [10, 15, 30, 60].indexOf(Number(v[3])) !== -1 ? Number(v[3]) : 30
    };
    state.selectedIp = v[6] || null;
    state.auto = v[7] !== '0';
    $('#verLabel').textContent = 'v' + (window.APP_VERSION || 'dev');
    renderAll();
    if (configured()) {
      refresh(false);
      startPolling();
    } else {
      openSettings(true);
    }
  }

  init();
})();
