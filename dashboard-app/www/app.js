/**
 * Telemetry Server — UI logic.
 * Depends on TelemetryLib (lib.js) loaded first.
 */

(async () => {
  'use strict';

  const T = window.TelemetryLib;
  if (!T) { console.error('TelemetryLib not loaded'); return; }

  const { $, $$, debounce, throttle, clamp,
          formatBytes, formatMs, formatUptime, formatSignal, chipClassForStatus,
          initCapacitor, loadSettings, saveSettings,
          nativeStartServer, nativeStopServer, nativeGetServerStatus, nativeGetData, nativeGetWsUrl, nativeRequestPermissions,
          wsConnect, wsDisconnect, wsOn, wsSend } = T;

  // ===== State =====
  let settings = {};
  let serverRunning = false;
  let wsUrl = null;
  let wsUnsub = null;
  let deviceServers = {}; // { deviceId: { name, port, wsPort, token, bindAll, interval } }
  let currentDeviceId = null;
  let currentDevice = null;
  let devices = [];
  let isMultiDeviceMode = false;

  // ===== DOM refs =====
  const els = {
    // top
    pulse: $('#pulse'),
    banner: $('#banner'),
    btnRefresh: $('#btnRefresh'),
    btnSettings: $('#btnSettings'),
    btnCheckUpdate: $('#btnCheckUpdate'),
    btnManageDevices: $('#btnManageDevices'),
    deviceSelector: $('#deviceSelector'),
    
    // cards
    layerDevices: $('#layerDevices'),
    formAddDevice: $('#formAddDevice'),
    devicesList: $('#devicesList'),
    addDevName: $('#addDevName'),
    addDevHost: $('#addDevHost'),
    addDevPort: $('#addDevPort'),
    addDevWsPort: $('#addDevWsPort'),
    addDevToken: $('#addDevToken'),
    addDevTokenToggle: $('#addDevTokenToggle'),
    // cards
    chipBatStatus: $('#chipBatStatus'),
    valBatLevel: $('#valBatLevel'),
    valBatTemp: $('#valBatTemp'),
    valBatVolt: $('#valBatVolt'),
    valBatCurr: $('#valBatCurr'),
    barBat: $('#barBat'),
    footBat: $('#footBat'),

    chipLoc: $('#chipLoc'),
    valLat: $('#valLat'),
    valLon: $('#valLon'),
    valAcc: $('#valAcc'),
    valAlt: $('#valAlt'),
    valProv: $('#valProv'),
    footLoc: $('#footLoc'),

    chipSys: $('#chipSys'),
    valRam: $('#valRam'),
    valCpu: $('#valCpu'),
    valScreen: $('#valScreen'),
    barRam: $('#barRam'),
    barCpu: $('#barCpu'),
    footSys: $('#footSys'),

    chipNet: $('#chipNet'),
    valWifi: $('#valWifi'),
    valIp: $('#valIp'),
    valRssi: $('#valRssi'),
    footNet: $('#footNet'),

    chipApps: $('#chipApps'),
    listApps: $('#listApps'),
    footApps: $('#footApps'),

    rawJson: $('#rawJson'),
    btnToggleRaw: $('#btnToggleRaw'),
    btnCopyJson: $('#btnCopyJson'),

    // settings layer
    layerSettings: $('#layerSettings'),
    formSettings: $('#formSettings'),
    verLabel: $('#verLabel'),
    setPort: $('#setPort'),
    setWsPort: $('#setWsPort'),
    setToken: $('#setToken'),
    setBind: $('#setBind'),
    setInterval: $('#setInterval'),
    setMsg: $('#setMsg'),
    tokenToggle: $('#tokenToggle'),
    btnStartServer: $('#btnStartServer'),
    btnStopServer: $('#btnStopServer'),
    btnQuickConnect: $('#btnQuickConnect'),
    btnQuickConnectGo: $('#btnQuickConnectGo'),
    layerQuickConnect: $('#layerQuickConnect'),
    qcHost: $('#qcHost'),
    qcWsPort: $('#qcWsPort'),
    qcToken: $('#qcToken'),
    qcTokenToggle: $('#qcTokenToggle'),

    // detail layer
    layerDetail: $('#layerDetail'),
    dTitle: $('#dTitle'),
    dSub: $('#dSub'),
    dBody: $('#dBody'),

    toast: $('#toast'),
  };

  // ===== Helpers =====
  function showBanner(msg, type = 'info') {
    els.banner.textContent = msg;
    els.banner.className = `banner ${type}`;
    els.banner.classList.remove('hidden');
    setTimeout(() => els.banner.classList.add('hidden'), 4000);
  }

  function showToast(msg, err = false) {
    els.toast.textContent = msg;
    els.toast.className = `toast ${err ? 'err' : ''}`;
    els.toast.classList.remove('hidden');
    setTimeout(() => els.toast.classList.add('hidden'), 3000);
  }

  function openLayer(layer) { layer.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeLayer(layer) { layer.classList.add('hidden'); document.body.style.overflow = ''; }

  function setChip(el, text, status) {
    el.textContent = text || '—';
    el.className = `chip ${chipClassForStatus(status) || ''}`;
  }

  function renderApps(apps) {
    if (!apps || !apps.length) {
      els.listApps.innerHTML = '';
      els.footApps.textContent = 'Tidak ada aplikasi foreground';
      return;
    }
    els.listApps.innerHTML = apps.map(a => `
      <li>
        <span class="app-icon">${(a.name || a.package || '?')[0].toUpperCase()}</span>
        <div class="app-info">
          <div class="app-name">${a.name || a.package}</div>
          <div class="app-pkg">${a.package}</div>
        </div>
        <span class="app-time">${a.lastTimeUsed ? formatMs(Date.now() - a.lastTimeUsed) + ' yang lalu' : '—'}</span>
      </li>
    `).join('');
    els.footApps.textContent = `${apps.length} aplikasi`;
  }

  function updateRawJson(data) {
    els.rawJson.textContent = JSON.stringify(data, null, 2);
  }

  // ===== Data rendering =====
  function render(data) {
    if (!data) return;

    // Battery
    if (data.battery) {
      const b = data.battery;
      const level = b.level ?? 0;
      const status = b.charging ? 'charging' : (level <= 15 ? 'low' : 'ok');
      setChip(els.chipBatStatus, b.charging ? 'Mengisi' : 'Discharging', status);
      els.valBatLevel.textContent = level;
      els.barBat.style.width = `${clamp(level, 0, 100)}%`;
      els.barBat.className = level <= 15 ? 'low' : (level <= 40 ? 'mid' : '');
      els.valBatTemp.textContent = b.temp ? `${b.temp.toFixed(1)}°C` : '—';
      els.valBatVolt.textContent = b.voltageMv ? `${(b.voltageMv / 1000).toFixed(2)}V` : '—';
      els.valBatCurr.textContent = b.currentMa ? `${b.currentMa}mA` : '—';
      els.footBat.textContent = `Health: ${b.health || '—'} • Tech: ${b.technology || '—'} • Updated: ${new Date(b.timestamp || Date.now()).toLocaleTimeString()}`;
    }

    // Location
    if (data.location) {
      const l = data.location;
      setChip(els.chipLoc, l.provider || 'GPS', l.accuracy <= 20 ? 'ok' : 'warn');
      els.valLat.textContent = l.lat ? l.lat.toFixed(6) : '—';
      els.valLon.textContent = l.lon ? l.lon.toFixed(6) : '—';
      els.valAcc.textContent = l.accuracy ? `±${l.accuracy}m` : '—';
      els.valAlt.textContent = l.altitude ? `${l.altitude.toFixed(1)}m` : '—';
      els.valProv.textContent = l.provider || '—';
      els.footLoc.textContent = `Speed: ${l.speed ? l.speed.toFixed(1) + ' m/s' : '—'} • Updated: ${new Date(l.timestamp || Date.now()).toLocaleTimeString()}`;
    } else {
      setChip(els.chipLoc, 'Tidak tersedia', 'err');
      els.valLat.textContent = els.valLon.textContent = '—';
    }

    // System
    if (data.system) {
      const s = data.system;
      setChip(els.chipSys, s.screenOn ? 'Screen ON' : 'Screen OFF', s.screenOn ? 'ok' : '');
      const ramUsed = s.ramTotal - (s.ramAvail || 0);
      const ramPct = s.ramTotal ? Math.round((ramUsed / s.ramTotal) * 100) : 0;
      const cpuPct = Math.round(s.cpuLoad || 0);
      els.valRam.textContent = `${formatBytes(ramUsed)} / ${formatBytes(s.ramTotal)}`;
      els.valCpu.textContent = `${cpuPct}%`;
      els.valScreen.textContent = s.screenOn ? 'ON' : 'OFF';
      els.barRam.style.width = `${clamp(ramPct, 0, 100)}%`;
      els.barRam.className = ramPct > 85 ? 'low' : (ramPct > 60 ? 'mid' : '');
      els.barCpu.style.width = `${clamp(cpuPct, 0, 100)}%`;
      els.barCpu.className = cpuPct > 85 ? 'low' : (cpuPct > 60 ? 'mid' : '');
      els.footSys.textContent = `Model: ${s.model || '—'} • Android: ${s.androidVersion || '—'} • Uptime: ${formatUptime(s.uptime)}`;
    }

    // Network
    if (data.network) {
      const n = data.network;
      setChip(els.chipNet, n.wifiSsid || 'No WiFi', n.wifiSsid ? 'ok' : 'warn');
      els.valWifi.textContent = n.wifiSsid || '—';
      els.valIp.textContent = n.ipLocal || '—';
      els.valRssi.textContent = n.rssi ? `${n.rssi} dBm (${formatSignal(n.rssi)})` : '—';
      els.footNet.textContent = `BSSID: ${n.bssid || '—'} • Public IP: ${n.ipPublic || '—'}`;
    }

    // Apps
    if (data.apps) {
      renderApps(data.apps);
    }

    // Raw JSON
    updateRawJson(data);
  }

  // ===== Settings layer =====
  function populateSettings() {
    els.setPort.value = settings.port || 8080;
    els.setWsPort.value = settings.wsPort || 8081;
    els.setToken.value = settings.token || '';
    els.setBind.value = settings.bindAll || '1';
    els.setInterval.value = settings.interval || '2';
    els.verLabel.textContent = `v${window.APP_VERSION || '1.0.0'} • ${window.APP_ID || 'com.irfanfrizki.telemetry'}`;
    updateServerButtons();
  }

  function updateServerButtons() {
    els.btnStartServer.disabled = serverRunning;
    els.btnStopServer.disabled = !serverRunning;
  }

  async function onStartServer() {
    const cfg = {
      port: parseInt(els.setPort.value, 10),
      wsPort: parseInt(els.setWsPort.value, 10),
      token: els.setToken.value,
      bindAll: els.setBind.value === '1',
      intervalSec: parseInt(els.setInterval.value, 10),
    };
    const res = await nativeStartServer(cfg);
    if (res.success) {
      serverRunning = true;
      updateServerButtons();
      showBanner('Server started', 'ok');
      await refreshWsUrl();
    } else {
      showBanner(`Gagal start: ${res.error || 'unknown'}`, 'err');
    }
  }

  async function onStopServer() {
    const res = await nativeStopServer();
    if (res.success) {
      serverRunning = false;
      updateServerButtons();
      showBanner('Server stopped', 'warn');
      wsDisconnect();
      wsUrl = null;
    } else {
      showBanner(`Gagal stop: ${res.error || 'unknown'}`, 'err');
    }
  }

  async function refreshWsUrl() {
    const res = await nativeGetWsUrl();
    if (res && res.url) {
      wsUrl = res.url;
      if (wsUnsub) wsUnsub();
      wsUnsub = wsOn(handleWsMessage);
      wsConnect(wsUrl);
    }
  }

  function handleWsMessage(ev) {
    if (ev.type === 'message') {
      try {
        const parsed = JSON.parse(ev.data);
        // Handle telemetry envelope: { type: "telemetry", data: { ... } }
        const data = (parsed && parsed.type === 'telemetry' && parsed.data) ? parsed.data : parsed;
        render(data);
      } catch (_) {}
    } else if (ev.type === 'open') {
      console.log('WS connected');
    } else if (ev.type === 'close') {
      console.log('WS closed, will reconnect');
    }
  }

  async function onSaveSettings(e) {
    e.preventDefault();
    const newSettings = {
      port: parseInt(els.setPort.value, 10),
      wsPort: parseInt(els.setWsPort.value, 10),
      token: els.setToken.value,
      bindAll: els.setBind.value,
      interval: els.setInterval.value,
    };
    // basic validation
    if (newSettings.port < 1024 || newSettings.port > 65535) { showToast('Port HTTP tidak valid', true); return; }
    if (newSettings.wsPort < 1024 || newSettings.wsPort > 65535) { showToast('Port WS tidak valid', true); return; }
    if (newSettings.port === newSettings.wsPort) { showToast('Port HTTP dan WS harus beda', true); return; }
    await saveSettings(newSettings);
    settings = newSettings;
    showToast('Pengaturan disimpan');
    closeLayer(els.layerSettings);
    if (serverRunning) {
      // restart server with new config
      await onStopServer();
      await onStartServer();
    }
  }

  function onTokenToggle() {
    const isPwd = els.setToken.type === 'password';
    els.setToken.type = isPwd ? 'text' : 'password';
    els.tokenToggle.textContent = isPwd ? 'Sembunyikan' : 'Lihat';
  }

  // ===== Detail layer =====
  function openDetail(title, subtitle, html) {
    els.dTitle.textContent = title;
    els.dSub.textContent = subtitle;
    els.dBody.innerHTML = html;
    openLayer(els.layerDetail);
  }

  // ===== Device Management =====
  const DEVICES_STORAGE_KEY = 'telemetry_devices';
  const CURRENT_DEVICE_STORAGE_KEY = 'telemetry_current_device';

  async function loadDevices() {
    try {
      const stored = await T.prefGet(DEVICES_STORAGE_KEY, null);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          devices = parsed;
        }
      }
    } catch (_) {}
    // Load current device selection
    try {
      currentDeviceId = await T.prefGet(CURRENT_DEVICE_STORAGE_KEY, null);
    } catch (_) {}
  }

  async function saveDevices() {
    await T.prefSet(DEVICES_STORAGE_KEY, JSON.stringify(devices));
  }

  function renderDevicesList() {
    if (!els.devicesList) return;
    if (!devices.length) {
      els.devicesList.innerHTML = '<p class="hint">Belum ada perangkat. Tambah server telemetry di bawah.</p>';
      return;
    }
    els.devicesList.innerHTML = devices.map((dev, idx) => {
      const isCurrent = dev.id === currentDeviceId;
      return `
        <div class="device-entry">
          <div class="device-meta">
            <strong>${dev.name}</strong>
            <small>${dev.host}:${dev.port} / WS ${dev.wsPort} ${dev.token ? '• Token' : ''}</small>
          </div>
          <div class="device-controls">
            ${isCurrent ? '<span class="chip ok">Aktif</span>' : ''}
            ${!isCurrent ? `<button class="btn ghost small" data-dev-select="${dev.id}">Pilih</button>` : ''}
            <button class="btn ghost small" data-dev-delete="${dev.id}">Hapus</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function renderDeviceSelector() {
    if (!els.deviceSelector) return;
    if (!devices.length) {
      els.deviceSelector.style.display = 'none';
      return;
    }
    els.deviceSelector.style.display = 'block';
    els.deviceSelector.innerHTML = devices.map(dev =>
      `<option value="${dev.id}" ${dev.id === currentDeviceId ? 'selected' : ''}>${dev.name}</option>`
    ).join('');
  }

  async function selectDevice(deviceId) {
    const dev = devices.find(d => d.id === deviceId);
    if (!dev) return;
    currentDeviceId = deviceId;
    currentDevice = dev;
    await T.prefSet(CURRENT_DEVICE_STORAGE_KEY, deviceId);
    renderDeviceSelector();
    renderDevicesList();
    // Update WS URL and reconnect
    wsUrl = `ws://${dev.host}:${dev.wsPort}${dev.token ? '?token=' + encodeURIComponent(dev.token) : ''}`;
    if (wsUnsub) wsUnsub();
    wsUnsub = T.wsOn(handleWsMessage);
    T.wsConnect(wsUrl);
    showBanner(`Terhubung ke ${dev.name}`, 'ok');
  }

  function openDevicesLayer() {
    renderDevicesList();
    openLayer(els.layerDevices);
  }

  async function onAddDevice(e) {
    e.preventDefault();
    const name = els.addDevName.value.trim();
    const host = els.addDevHost.value.trim();
    const port = parseInt(els.addDevPort.value, 10);
    const wsPort = parseInt(els.addDevWsPort.value, 10);
    const token = els.addDevToken.value.trim();
    if (!name || !host || isNaN(port) || isNaN(wsPort)) {
      showToast('Isi semua kolom wajib', true);
      return;
    }
    if (port < 1024 || port > 65535 || wsPort < 1024 || wsPort > 65535) {
      showToast('Port tidak valid (1024-65535)', true);
      return;
    }
    if (port === wsPort) {
      showToast('Port HTTP dan WS harus berbeda', true);
      return;
    }
    const newDev = {
      id: 'dev_' + Date.now(),
      name,
      host,
      port,
      wsPort,
      token,
    };
    devices.push(newDev);
    await saveDevices();
    renderDevicesList();
    renderDeviceSelector();
    // clear form
    els.addDevName.value = '';
    els.addDevHost.value = '';
    els.addDevPort.value = '8080';
    els.addDevWsPort.value = '8081';
    els.addDevToken.value = '';
    showToast('Perangkat ditambahkan');
  }

  async function onDeleteDevice(deviceId) {
    if (!confirm('Hapus perangkat ini?')) return;
    devices = devices.filter(d => d.id !== deviceId);
    await saveDevices();
    if (currentDeviceId === deviceId) {
      currentDeviceId = devices[0]?.id || null;
      currentDevice = devices[0] || null;
      await T.prefSet(CURRENT_DEVICE_STORAGE_KEY, currentDeviceId);
      if (currentDevice) {
        wsUrl = `ws://${currentDevice.host}:${currentDevice.wsPort}${currentDevice.token ? '?token=' + encodeURIComponent(currentDevice.token) : ''}`;
        if (wsUnsub) wsUnsub();
        wsUnsub = T.wsOn(handleWsMessage);
        T.wsConnect(wsUrl);
      } else {
        T.wsDisconnect();
        wsUrl = null;
      }
    }
    renderDevicesList();
    renderDeviceSelector();
    showToast('Perangkat dihapus');
  }

  function onTokenToggleAdd() {
    const isPwd = els.addDevToken.type === 'password';
    els.addDevToken.type = isPwd ? 'text' : 'password';
    els.addDevTokenToggle.textContent = isPwd ? 'Sembunyikan' : 'Lihat';
  }

  async function onQuickConnect() {
    const host = els.qcHost.value.trim();
    const wsPort = parseInt(els.qcWsPort.value, 10);
    const token = els.qcToken.value.trim();
    if (!host || !Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) {
      showToast('Isi IP server dan port WebSocket yang valid', true);
      return;
    }
    const url = `ws://${host}:${wsPort}${token ? '?token=' + encodeURIComponent(token) : ''}`;
    wsUrl = url;
    if (wsUnsub) wsUnsub();
    wsUnsub = T.wsOn(handleWsMessage);
    T.wsConnect(url);
    showBanner(`Mencoba terhubung ke ${host}:${wsPort}`, 'warn');
    closeLayer(els.layerQuickConnect);
  }

  function toggleQuickConnectToken() {
    const isPwd = els.qcToken.type === 'password';
    els.qcToken.type = isPwd ? 'text' : 'password';
    els.qcTokenToggle.textContent = isPwd ? 'Sembunyikan' : 'Lihat';
  }

  function openQuickConnect() {
    els.qcHost.value = currentDevice?.host || '';
    els.qcWsPort.value = String(currentDevice?.wsPort || 8765);
    els.qcToken.value = currentDevice?.token || '';
    closeLayer(els.layerSettings);
    openLayer(els.layerQuickConnect);
  }

  async function saveQuickConnect() {
    const host = els.qcHost.value.trim();
    const wsPort = parseInt(els.qcWsPort.value, 10);
    const token = els.qcToken.value.trim();
    if (!host || !Number.isInteger(wsPort) || wsPort < 1 || wsPort > 65535) return;
    let dev = devices.find(d => d.host === host && d.wsPort === wsPort);
    if (!dev) {
      dev = { id: 'dev_' + Date.now(), name: host, host, port: settings.port || 8080, wsPort, token };
      devices.push(dev);
    } else {
      dev.token = token;
    }
    currentDevice = dev;
    currentDeviceId = dev.id;
    await saveDevices();
    await T.prefSet(CURRENT_DEVICE_STORAGE_KEY, currentDeviceId);
    renderDeviceSelector();
    renderDevicesList();
  }

  async function onQuickConnectGo() {
    await saveQuickConnect();
    await onQuickConnect();
  }

  els.btnQuickConnect.addEventListener('click', openQuickConnect);
  els.btnQuickConnectGo.addEventListener('click', onQuickConnectGo);
  els.qcTokenToggle.addEventListener('click', toggleQuickConnectToken);
  els.btnQuickConnect.style.display = 'inline-flex';
  els.btnQuickConnectGo.addEventListener('click', (e) => e.preventDefault());
  els.btnQuickConnectGo.closest('.sheet').addEventListener('submit', (e) => e.preventDefault());
  els.layerQuickConnect.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); onQuickConnectGo(); }
  });
  els.layerQuickConnect = document.getElementById('layerQuickConnect');
  els.qcHost = document.getElementById('qcHost');
  els.qcWsPort = document.getElementById('qcWsPort');
  els.qcToken = document.getElementById('qcToken');
  els.qcTokenToggle = document.getElementById('qcTokenToggle');
  els.btnQuickConnect = document.getElementById('btnQuickConnect');
  els.btnQuickConnectGo = document.getElementById('btnQuickConnectGo');

  function _bindQuickConnect() {}

  // ===== Copy JSON =====
  async function copyJson() {
    try {
      await navigator.clipboard.writeText(els.rawJson.textContent);
      showToast('JSON disalin');
    } catch (_) {
      // fallback: pilih teks lalu perintah copy (WebView lama sering blokir clipboard API)
      try {
        const range = document.createRange();
        range.selectNodeContents(els.rawJson);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        document.execCommand('copy');
        sel.removeAllRanges();
        showToast('JSON disalin');
      } catch (__) {
        showToast('Gagal salin', true);
      }
    }
  }

  async function onCheckUpdate() {
    if (typeof window.checkForTelemetryUpdate === 'function') {
      showToast('Memeriksa update…');
      try {
        await window.checkForTelemetryUpdate();
      } catch (e) {
        showToast('Gagal cek update: ' + (e.message || e), true);
      }
    } else {
      showToast('Update checker tidak tersedia', true);
    }
  }

  // ===== Toggle raw JSON =====
  function toggleRaw() {
    const hidden = els.rawJson.classList.toggle('hidden');
    els.btnToggleRaw.textContent = hidden ? 'Tampilkan' : 'Sembunyikan';
    if (!hidden) els.rawJson.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ===== Event bindings =====
  els.btnSettings.addEventListener('click', () => { populateSettings(); openLayer(els.layerSettings); });
  els.btnManageDevices.addEventListener('click', () => { closeLayer(els.layerSettings); openDevicesLayer(); });
  els.deviceSelector.addEventListener('dblclick', openDevicesLayer);
  els.btnManageDevices.style.display = 'inline-flex';
  els.deviceSelector.title = 'Pilih perangkat; buka Pengaturan untuk mengelola daftar';
  els.btnRefresh.addEventListener('click', () => nativeGetData().then(render));
  els.formSettings.addEventListener('submit', onSaveSettings);
  els.tokenToggle.addEventListener('click', onTokenToggle);
  els.btnStartServer.addEventListener('click', onStartServer);
  els.btnStopServer.addEventListener('click', onStopServer);
  els.btnToggleRaw.addEventListener('click', toggleRaw);
  els.btnCopyJson.addEventListener('click', copyJson);
  els.btnCheckUpdate.addEventListener('click', onCheckUpdate);

  // Device management bindings
  els.deviceSelector.addEventListener('change', (e) => selectDevice(e.target.value));
  els.formAddDevice.addEventListener('submit', onAddDevice);
  els.addDevTokenToggle.addEventListener('click', onTokenToggleAdd);
  // delegate for device list buttons
  els.devicesList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dev-select]');
    if (btn) { selectDevice(btn.dataset.devSelect); return; }
    const delBtn = e.target.closest('[data-dev-delete]');
    if (delBtn) { onDeleteDevice(delBtn.dataset.devDelete); }
  });

  // close layers on scrim click
  $$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.closest('.layer');
      if (layer) closeLayer(layer);
    });
  });

  // ===== Init =====
  async function init() {
    await initCapacitor();
    settings = await loadSettings();

    // load devices and connect
    await loadDevices();
    renderDeviceSelector();
    if (currentDeviceId) {
      await selectDevice(currentDeviceId);
    }

    // check server status (local server, not remote devices)
    const status = await nativeGetServerStatus();
    serverRunning = status.running || false;
    if (serverRunning) {
      await refreshWsUrl();
    }
    updateServerButtons();

    // initial data
    const data = await nativeGetData();
    if (data) render(data);

    // request permissions
    await nativeRequestPermissions();

    // refresh data periodically (fallback if WS not working)
    setInterval(() => {
      nativeGetData().then(render).catch(() => {});
    }, Math.max(5000, (parseInt(settings.interval, 10) || 2) * 1000));

    // version display
    if (window.APP_VERSION) {
      console.log(`Telemetry Server v${window.APP_VERSION} ready`);
    }

    // auto-update checker (after Capacitor ready)
    if (typeof window.checkForTelemetryUpdate === 'function') {
      try {
        window.checkForTelemetryUpdate();
      } catch (e) {
        console.warn('Update checker error:', e);
      }
    }
  }

  init();
})();