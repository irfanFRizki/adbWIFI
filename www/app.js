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

  // ===== DOM refs =====
  const els = {
    // top
    pulse: $('#pulse'),
    banner: $('#banner'),
    btnRefresh: $('#btnRefresh'),
    btnSettings: $('#btnSettings'),
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
        const data = JSON.parse(ev.data);
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

  // ===== Copy JSON =====
  async function copyJson() {
    try {
      await navigator.clipboard.writeText(els.rawJson.textContent);
      showToast('JSON disalin');
    } catch (_) {
      showToast('Gagal salin', true);
    }
  }

  // ===== Event bindings =====
  els.btnSettings.addEventListener('click', () => { populateSettings(); openLayer(els.layerSettings); });
  els.btnRefresh.addEventListener('click', () => nativeGetData().then(render));
  els.formSettings.addEventListener('submit', onSaveSettings);
  els.tokenToggle.addEventListener('click', onTokenToggle);
  els.btnStartServer.addEventListener('click', onStartServer);
  els.btnStopServer.addEventListener('click', onStopServer);
  els.btnCopyJson.addEventListener('click', copyJson);

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

    // check server status
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
  }

  init();
})();