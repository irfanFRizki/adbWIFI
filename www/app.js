/* ADB WiFi Monitor — UI. Logika murni ada di lib.js (HPLib). */
(function () {
  'use strict';

  var L = window.HPLib;
  var esc = L.escapeHtml;
  function $(sel) { return document.querySelector(sel); }

  var STALE_MS = 180000; // data router dianggap basi bila timestamp tak berubah 3 menit

  var state = {
    settings: { url1: '', url2: '', token: '', interval: 30 },
    devices: [],
    serverTs: null,
    tsChangedAt: 0,
    fetchedAt: 0,
    error: null,
    samples: {},
    detailIp: null
  };
  var inflight = false;
  var timer = null;
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
      connectTimeout: 8000,
      readTimeout: req.timeout || 15000,
      responseType: 'text'
    }).then(function (r) { return { status: r.status, data: r.data }; });
  }
  function transport(req) { return isNative() ? nativeTransport(req) : L.fetchTransport(req); }

  var api = L.createApi({
    getSettings: function () { return { urls: [state.settings.url1, state.settings.url2], token: state.settings.token }; },
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
    } else if (state.devices.length && Date.now() - state.tsChangedAt > STALE_MS) {
      msg = 'Data di router tidak diperbarui lebih dari ' + L.formatAge((Date.now() - state.tsChangedAt) / 1000) + '. Layanan hpmon di router mungkin berhenti.';
      cls += ' warn';
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
  function screenText(s) {
    if (s === 'Awake') return 'Menyala';
    if (s === 'Asleep') return 'Tidur';
    if (s === 'Dozing') return 'Doze';
    return s ? esc(s) : '—';
  }

  function metricsHtml(dev) {
    var r = dev.router || {}, a = dev.adb || {};
    var lat = L.parseLatency(r.latency);
    var latHtml = lat === null ? '—' : lat + ' ms';
    var h = '<div class="metrics">';

    if (a.status === 'connected') {
      var bat = a.battery === undefined || a.battery === null || a.battery === '' ? null : Number(a.battery);
      h += metric('Baterai', bat === null || isNaN(bat) ? '—' : (bat + '%' + bar(bat)));
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

  /* ---------- daftar ---------- */

  function cardHtml(dev) {
    var r = dev.router || {}, a = dev.adb || {};
    var online = !!r.online, conn = a.status === 'connected';
    var cls = 'card' + (online ? ' on' : '') + (online && !conn ? ' noadb' : '') + (state.error ? ' stale' : '');
    return '<article class="' + cls + '" data-ip="' + esc(dev.ip) + '">' +
      '<div class="card-head"><div><h2>' + esc(dev.nama || dev.ip) + '</h2><p class="mono sub">' + esc(dev.ip) + ':' + esc(dev.port_adb) + '</p></div>' +
      '<div class="badges">' + badge(online ? 'ONLINE' : 'OFFLINE', online ? 'good' : 'bad') +
      badge(conn ? 'ADB' : 'NO ADB', conn ? 'good' : (online ? 'warn' : '')) + '</div></div>' +
      metricsHtml(dev) + noteHtml(dev) + '</article>';
  }

  function renderSummary() {
    var d = state.devices;
    var on = d.filter(function (x) { return x.router && x.router.online; }).length;
    var adb = d.filter(function (x) { return x.adb && x.adb.status === 'connected'; }).length;
    function stat(cls, n, label) { return '<div class="stat ' + cls + '"><b>' + n + '</b><span>' + label + '</span></div>'; }
    $('#summary').innerHTML = stat('', d.length, 'Target') + stat('g', on, 'Online') + stat('c', adb, 'ADB');
  }

  function renderList() {
    var el = $('#list');
    if (!state.devices.length) {
      el.innerHTML = '<div class="empty">' + (configured()
        ? (state.error ? 'Belum ada data.' : 'Belum ada target. Tekan + untuk menambah IP HP yang ingin dipantau.')
        : 'Isi URL router dan token di pengaturan untuk mulai memantau.') + '</div>';
      return;
    }
    el.innerHTML = state.devices.map(cardHtml).join('');
  }

  function renderPulse() {
    var p = $('#pulse');
    p.className = 'pulse' + (state.error ? ' bad' : (state.devices.length ? ' ok' : ''));
  }

  function renderAll() {
    renderBanner();
    renderSummary();
    renderList();
    renderPulse();
    if (state.detailIp) {
      var dev = findDev(state.detailIp);
      var top = $('#dBasic');
      if (dev && top) top.innerHTML = metricsHtml(dev) + noteHtml(dev);
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
    }
    renderAll();
  }

  function startPolling() {
    stopPolling();
    var sec = Number(state.settings.interval) || 30;
    timer = setInterval(function () { if (!document.hidden) refresh(false); }, sec * 1000);
  }
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Date.now() - state.fetchedAt > 5000) refresh(false);
  });

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
    var h = '<div id="dBasic">' + metricsHtml(dev) + noteHtml(dev) + '</div>';
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
    $('#dTitle').textContent = dev.nama || dev.ip;
    $('#dSub').textContent = dev.ip + ':' + dev.port_adb;
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

  $('#dReload').addEventListener('click', loadDetail);

  $('#dDelete').addEventListener('click', async function () {
    var ip = state.detailIp;
    var dev = ip && findDev(ip);
    if (!dev) return;
    if (!window.confirm('Hapus ' + (dev.nama || dev.ip) + ' (' + dev.ip + ') dari daftar pantauan?')) return;
    try {
      await api.deleteTarget(ip);
      toast('Target dihapus.');
      backLayer();
      refresh(false);
    } catch (e) {
      toast(L.errorMessage(e), true);
    }
  });

  $('#list').addEventListener('click', function (e) {
    var card = e.target.closest ? e.target.closest('.card') : null;
    if (card) openDetail(card.getAttribute('data-ip'));
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
    $('#setToken').value = state.settings.token;
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
    var token = $('#setToken').value.trim();
    if (!url1) return { error: 'URL API utama belum diisi atau tidak valid.' };
    if (raw2 && !url2) return { error: 'URL cadangan tidak valid.' };
    if (!token) return { error: 'Token API belum diisi.' };
    return { value: { url1: url1, url2: url2, token: token, interval: Number($('#setInterval').value) || 30 } };
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
      getSettings: function () { return { urls: [f.value.url1, f.value.url2], token: f.value.token }; },
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
      storeSet('url1', f.value.url1), storeSet('url2', f.value.url2),
      storeSet('token', f.value.token), storeSet('interval', f.value.interval)
    ]);
    state.devices = [];
    state.samples = {};
    state.error = null;
    state.tsChangedAt = 0;
    toast('Pengaturan disimpan.');
    backLayer();
    startPolling();
    refresh(true);
  });

  /* ---------- mulai ---------- */

  async function init() {
    var v = await Promise.all([storeGet('url1'), storeGet('url2'), storeGet('token'), storeGet('interval')]);
    state.settings = {
      url1: v[0] || '', url2: v[1] || '', token: v[2] || '',
      interval: [15, 30, 60].indexOf(Number(v[3])) !== -1 ? Number(v[3]) : 30
    };
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
