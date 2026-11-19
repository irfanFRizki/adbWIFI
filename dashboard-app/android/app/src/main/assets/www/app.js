/**
 * Telemetry Dashboard — remote monitoring client.
 * Connects to Telemetry Server (APK 1) via WebSocket. No native bridge needed.
 */

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ===== State =====
  let ws = null;
  let wsReconnectTimer = null;
  let serverUrl = '';
  let reconnectAttempts = 0;
  let lastWsError = false;
  const maxReconnect = 12;

  // ===== DOM refs =====
  const els = {
    pulse: $('#pulse'),
    banner: $('#banner'),
    btnSettings: $('#btnSettings'),
    btnRefresh: $('#btnRefresh'),

    chipBatStatus: $('#chipBatStatus'),
    cardBattery: $('#cardBattery'),
    bolt: $('#bolt'),
    valStreet: $('#valStreet'),
    lblRam: $('#lblRam'),
    lblCpu: $('#lblCpu'),
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

    layerSettings: $('#layerSettings'),
    formSettings: $('#formSettings'),
    verLabel: $('#verLabel'),
    setServerIp: $('#setServerIp'),
    setPort: $('#setPort'),
    setToken: $('#setToken'),
    setMsg: $('#setMsg'),
    tokenToggle: $('#tokenToggle'),

    layerDetail: $('#layerDetail'),
    dTitle: $('#dTitle'),
    dSub: $('#dSub'),
    dBody: $('#dBody'),

    toast: $('#toast'),
  };

  // ===== Helpers =====
  function showBanner(msg, type = 'info') {
    if (!els.banner) return;
    els.banner.textContent = msg;
    els.banner.className = `banner ${type}`;
    els.banner.classList.remove('hidden');
    setTimeout(() => els.banner.classList.add('hidden'), 4000);
  }

  function showToast(msg, err = false) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = `toast ${err ? 'err' : ''}`;
    els.toast.classList.remove('hidden');
    setTimeout(() => els.toast.classList.add('hidden'), 3000);
  }

  function openLayer(layer) { if (!layer) return; layer.classList.remove('hidden'); document.body.style.overflow = 'hidden'; }
  function closeLayer(layer) { if (!layer) return; layer.classList.add('hidden'); document.body.style.overflow = ''; }

  function setChip(el, text, status) {
    if (!el) return;
    el.textContent = text || '—';
    el.className = `chip ${status || ''}`;
  }

  function setPulse(state) {
    if (!els.pulse) return;
    els.pulse.className = `pulse ${state}`;
  }

  // ===== Formatting =====
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = Number(bytes);
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function formatMs(ms) {
    if (!ms || ms < 0) return '—';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}j ${m % 60}m`;
    if (m > 0) return `${m}m ${s % 60}d`;
    return `${s}d`;
  }

  function formatUptime(ms) {
    if (!ms || ms < 0) return '—';
    const sec = Math.floor(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const parts = [];
    if (d) parts.push(`${d}h`);
    if (h) parts.push(`${h}j`);
    if (m) parts.push(`${m}m`);
    if (s || !parts.length) parts.push(`${s}d`);
    return parts.join(' ');
  }

  function formatSignal(rssi) {
    if (rssi === null || rssi === undefined) return '—';
    if (rssi >= -50) return 'Sangat baik';
    if (rssi >= -60) return 'Baik';
    if (rssi >= -70) return 'Cukup';
    if (rssi >= -80) return 'Lemah';
    return 'Sangat lemah';
  }

  // ===== Rendering =====
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderApps(apps, perms) {
    if (!els.listApps) return;
    if (perms && perms.usage === false) {
      els.listApps.innerHTML = '';
      setChip(els.chipApps, 'Izin belum diberikan', 'warn');
      if (els.footApps) els.footApps.textContent = 'Di HP Target: buka aplikasi Server, tekan "Beri Izin", lalu aktifkan Akses Penggunaan untuk Telemetry Server.';
      return;
    }
    if (!apps || !apps.length) {
      els.listApps.innerHTML = '';
      setChip(els.chipApps, '—', '');
      if (els.footApps) els.footApps.textContent = 'Belum ada data aplikasi (HP Target mungkin belum dipakai).';
      return;
    }
    const fg = apps.find((a) => a.foreground);
    setChip(els.chipApps, fg ? (fg.name || fg.package) : 'Tidak ada yang terbuka', fg ? 'ok' : '');
    els.listApps.innerHTML = apps.map((a) => `
      <li class="${a.foreground ? 'is-fg' : ''}">
        <span class="app-icon">${esc((a.name || a.package || '?')[0].toUpperCase())}</span>
        <div class="app-info">
          <div class="app-name">${esc(a.name || a.package)}${a.foreground ? '<span class="app-live">AKTIF</span>' : ''}</div>
          <div class="app-pkg">${esc(a.package)}</div>
        </div>
        <span class="app-time">${a.foreground ? 'sekarang' : (a.lastTimeUsed ? formatMs(Date.now() - a.lastTimeUsed) + ' lalu' : '—')}</span>
      </li>
    `).join('');
    if (els.footApps) els.footApps.textContent = fg ? `Sedang dibuka: ${fg.name || fg.package}` : `${apps.length} aplikasi terakhir dipakai`;
  }

  // ----- Nama jalan (reverse geocoding OpenStreetMap/Nominatim, perlu internet di HP Pantau) -----
  let geo = { lat: null, lon: null, at: 0, text: '' };
  let geoBusy = false;

  function distM(lat1, lon1, lat2, lon2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  function formatAddress(j) {
    const a = (j && j.address) || {};
    const road = a.road || a.pedestrian || a.path || a.residential || a.footway || a.highway || '';
    const street = road ? (a.house_number ? `${road} No. ${a.house_number}` : road) : '';
    const area = a.neighbourhood || a.quarter || a.hamlet || '';
    const kel = a.suburb || a.village || a.city_district || '';
    const city = a.city || a.town || a.municipality || a.county || a.state_district || '';
    const parts = [street, area, kel, city].filter(Boolean);
    const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
    if (uniq.length) return uniq.join(', ');
    return (j && (j.name || j.display_name) ? String(j.name || j.display_name).split(',').slice(0, 3).join(',').trim() : '');
  }

  async function updateStreet(lat, lon) {
    if (!els.valStreet || lat == null || lon == null) return;
    if (geo.text) { els.valStreet.textContent = geo.text; els.valStreet.classList.remove('dim'); }
    if (geoBusy) return;
    const since = Date.now() - geo.at;
    const moved = geo.lat == null ? Infinity : distM(geo.lat, geo.lon, lat, lon);
    const need = (geo.lat == null && since >= 10000) || (geo.lat != null && moved >= 30 && since >= 5000);
    if (!need) return;

    geoBusy = true;
    geo.at = Date.now();
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=id&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = formatAddress(await res.json());
      geo = { lat, lon, at: Date.now(), text };
      els.valStreet.textContent = text || 'Nama jalan tidak ditemukan';
      els.valStreet.classList.toggle('dim', !text);
    } catch (_) {
      if (!geo.text) {
        els.valStreet.textContent = 'Nama jalan belum tersedia (HP Pantau perlu internet)';
        els.valStreet.classList.add('dim');
      }
    } finally {
      if (timer) clearTimeout(timer);
      geoBusy = false;
    }
  }

  let lastGoodLoc = null;

  function render(data) {
    if (!data) return;

    if (data.battery) {
      const b = data.battery;
      const level = b.level ?? 0;
      const isCharging = b.status === 'charging'; // animasi hanya saat benar-benar mengisi
      const chipKind = isCharging ? 'charging' : (level <= 15 ? 'low' : 'ok');
      setChip(els.chipBatStatus, b.status === 'full' ? 'Penuh' : (isCharging ? 'Mengisi' : 'Discharging'), chipKind);
      if (els.valBatLevel) els.valBatLevel.textContent = level;
      if (els.bolt) els.bolt.classList.toggle('on', isCharging);
      if (els.cardBattery) els.cardBattery.classList.toggle('is-charging', isCharging);
      if (els.barBat) {
        els.barBat.style.width = `${clamp(level, 0, 100)}%`;
        els.barBat.className = [isCharging ? 'charging' : '', level <= 15 ? 'low' : (level <= 40 ? 'mid' : '')].filter(Boolean).join(' ');
      }
      if (els.valBatTemp) els.valBatTemp.textContent = b.temp ? `${Number(b.temp).toFixed(1)}°C` : '—';
      if (els.valBatVolt) els.valBatVolt.textContent = b.voltageMv ? `${(b.voltageMv / 1000).toFixed(2)}V` : '—';
      if (els.valBatCurr) els.valBatCurr.textContent = b.currentMa != null ? `${b.currentMa > 0 ? '+' : ''}${b.currentMa}mA` : '—';
      if (els.footBat) els.footBat.textContent = `Health: ${b.health || '—'} • Tech: ${b.technology || '—'} • ${new Date(data.timestamp || Date.now()).toLocaleTimeString()}`;
    }

    if (data.location) {
      const l = data.location;
      if (l.lat == null || l.lon == null) {
        // Server melaporkan error/tunggu (izin, GPS mati, belum ada fix). Jangan hapus data terakhir.
        setChip(els.chipLoc, lastGoodLoc ? 'Lokasi lama' : 'Menunggu', 'warn');
        if (els.footLoc) els.footLoc.textContent = l.error || 'Lokasi tidak tersedia';
        if (!lastGoodLoc) {
          if (els.valLat) els.valLat.textContent = '—';
          if (els.valLon) els.valLon.textContent = '—';
          if (els.valStreet) { els.valStreet.textContent = l.error || 'Menunggu lokasi...'; els.valStreet.classList.add('dim'); }
        }
      } else {
        lastGoodLoc = l;
        const stale = l.stale || (l.ageMs != null && l.ageMs > 60000);
        setChip(els.chipLoc, stale ? 'Lama' : (l.provider || 'GPS'), stale ? 'warn' : ((l.accuracy || 999) <= 30 ? 'ok' : 'warn'));
        if (els.valLat) els.valLat.textContent = Number(l.lat).toFixed(6);
        if (els.valLon) els.valLon.textContent = Number(l.lon).toFixed(6);
        if (els.valAcc) els.valAcc.textContent = l.accuracy ? `±${Math.round(l.accuracy)}m` : '—';
        if (els.valAlt) els.valAlt.textContent = l.altitude ? `${Number(l.altitude).toFixed(0)}m` : '—';
        if (els.valProv) els.valProv.textContent = l.provider || '—';
        const kmh = l.speed ? `${(Number(l.speed) * 3.6).toFixed(0)} km/j` : '0 km/j';
        const age = l.ageMs != null ? `diperbarui ${formatMs(l.ageMs)} lalu` : new Date(l.timestamp || Date.now()).toLocaleTimeString();
        if (els.footLoc) els.footLoc.textContent = `Kecepatan: ${kmh} • ${age}`;
        updateStreet(Number(l.lat), Number(l.lon));
      }
    } else {
      setChip(els.chipLoc, 'Tidak tersedia', 'err');
      if (els.valLat) els.valLat.textContent = '—';
      if (els.valLon) els.valLon.textContent = '—';
    }

    if (data.system) {
      const s = data.system;
      setChip(els.chipSys, s.screenOn ? 'Screen ON' : 'Screen OFF', s.screenOn ? 'ok' : '');
      const ramUsed = s.ramUsed != null ? s.ramUsed : (s.ramTotal || 0) - (s.ramAvail || 0);
      const ramPct = s.ramPct != null ? s.ramPct : (s.ramTotal ? Math.round((ramUsed / s.ramTotal) * 100) : 0);
      // Server lama mengirim cpuLoad=0 tanpa cpuSource: anggap tidak tersedia
      const cpuKnown = s.cpuLoad != null && s.cpuLoad >= 0 && !(s.cpuSource === undefined && s.cpuLoad === 0) && s.cpuSource !== 'none';
      const cpuPct = cpuKnown ? Math.round(s.cpuLoad) : 0;
      const approx = (s.cpuSource === 'freq' || s.cpuSource === 'load') ? '≈' : '';
      if (els.valRam) els.valRam.textContent = `RAM ${ramPct}% (${formatBytes(ramUsed)} / ${formatBytes(s.ramTotal)})`;
      if (els.valCpu) els.valCpu.textContent = cpuKnown ? `CPU ${approx}${cpuPct}%` : 'CPU n/a';
      if (els.valScreen) els.valScreen.textContent = s.screenOn ? 'ON' : 'OFF';
      if (els.lblRam) els.lblRam.textContent = `RAM ${ramPct}%`;
      if (els.lblCpu) els.lblCpu.textContent = cpuKnown ? `CPU ${approx}${cpuPct}%${s.cpuCores ? ' • ' + s.cpuCores + ' core' : ''}` : 'CPU tidak tersedia';
      if (els.barRam) {
        els.barRam.style.width = `${clamp(ramPct, 0, 100)}%`;
        els.barRam.className = ramPct > 85 ? 'low' : (ramPct > 60 ? 'mid' : '');
      }
      if (els.barCpu) {
        els.barCpu.style.width = `${clamp(cpuPct, 0, 100)}%`;
        els.barCpu.className = cpuPct > 85 ? 'low' : (cpuPct > 60 ? 'mid' : '');
      }
      if (els.footSys) {
        const cpuNote = {
          freq: ' • CPU: perkiraan dari frekuensi (sering menempel tinggi).',
          load: ' • CPU: perkiraan dari rata-rata beban 1 menit (kurang realtime).',
          none: ' • CPU: tidak bisa dibaca di HP ini.',
        }[s.cpuSource] || '';
        const hint = (s.cpuSource === 'freq' || s.cpuSource === 'load' || s.cpuSource === 'none')
          ? ' Untuk CPU akurat jalankan sekali: adb shell pm grant com.irfanfrizki.telemetry.server android.permission.DUMP' : '';
        els.footSys.textContent = `Model: ${s.model || '—'} • Android: ${s.androidVersion || '—'} • Uptime: ${formatUptime(s.uptime)}${cpuNote}${hint}`;
      }
    }

    if (data.network) {
      const n = data.network;
      setChip(els.chipNet, n.wifiSsid || 'No WiFi', n.wifiSsid ? 'ok' : 'warn');
      if (els.valWifi) els.valWifi.textContent = n.wifiSsid || '—';
      if (els.valIp) els.valIp.textContent = n.ipLocal || '—';
      if (els.valRssi) els.valRssi.textContent = n.rssi ? `${n.rssi} dBm (${formatSignal(n.rssi)})` : '—';
      if (els.footNet) els.footNet.textContent = `BSSID: ${n.bssid || '—'} • Public IP: ${n.ipPublic || '—'}`;
    }

    if (data.apps) renderApps(data.apps, data.permissions);

    if (els.rawJson) els.rawJson.textContent = JSON.stringify(data, null, 2);
  }

  // ===== WebSocket =====
  function wsConnect(url) {
    if (!url) return;
    serverUrl = url;
    setPulse('connecting');

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      try { ws.close(); } catch (_) {}
    }

    try {
      const sock = new WebSocket(url);
      ws = sock;

      sock.onopen = () => {
        if (ws !== sock) return;
        setPulse('connected');
        reconnectAttempts = 0;
        showBanner('Terhubung ke server', 'ok');
      };

      sock.onmessage = (e) => {
        if (ws !== sock) return;
        try {
          const msg = JSON.parse(e.data);
          render(msg.type === 'telemetry' ? msg.data : msg);
        } catch (_) {}
      };

      sock.onerror = () => { lastWsError = true; };

      sock.onclose = () => {
        if (ws !== sock) return; // koneksi lama yang sudah diganti
        setPulse('disconnected');
        if (serverUrl) {
          const shown = serverUrl.replace(/\?token=.*$/, '');
          showBanner(`Tidak bisa terhubung ke ${shown}. Pastikan server berjalan, port WebSocket benar, dan satu jaringan. Mencoba lagi...`, 'err');
        }
        scheduleReconnect();
      };
    } catch (err) {
      setPulse('disconnected');
      showBanner(`URL tidak valid: ${err && err.message ? err.message : err}`, 'err');
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    if (reconnectAttempts >= maxReconnect) {
      showBanner('Gagal terhubung. Periksa IP server.', 'err');
      return;
    }
    const delay = Math.min(2000 * Math.pow(1.6, reconnectAttempts), 30000);
    reconnectAttempts++;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (serverUrl) wsConnect(serverUrl);
    }, delay);
  }

  function wsDisconnect() {
    serverUrl = '';
    reconnectAttempts = 0;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
    setPulse('disconnected');
  }

  // ===== Settings =====
  function loadSettings() {
    try {
      const saved = localStorage.getItem('dashboard_settings');
      if (saved) { const o = JSON.parse(saved); return { serverIp: o.serverIp || '', wsPort: o.wsPort || '8765', token: o.token || '' }; }
    } catch (_) {}
    return { serverIp: '', wsPort: '8765', token: '' };
  }

  function saveSettings(s) {
    try { localStorage.setItem('dashboard_settings', JSON.stringify(s)); } catch (_) {}
  }

  function populateSettings() {
    const s = loadSettings();
    if (els.setServerIp) els.setServerIp.value = s.serverIp || '';
    if (els.setPort) els.setPort.value = s.wsPort || '8765';
    if (els.setToken) els.setToken.value = s.token || '';
    if (els.verLabel) els.verLabel.textContent = `v${window.APP_CURRENT_VERSION || window.APP_VERSION || '?'} • ${window.APP_ID || 'com.irfanfrizki.telemetry.dashboard'}`;
  }

  function buildWsUrl(ip, port, token) {
    if (!ip || !port) return null;
    let url = `ws://${ip}:${port}/ws`;
    if (token) url += `?token=${encodeURIComponent(token)}`;
    return url;
  }

  function onConnect() {
    const ip = els.setServerIp ? els.setServerIp.value.trim() : '';
    const port = els.setPort ? els.setPort.value.trim() : '8765';
    const token = els.setToken ? els.setToken.value.trim() : '';

    if (!ip) { showToast('IP server wajib diisi', true); return; }
    const p = parseInt(port, 10);
    if (isNaN(p) || p < 1 || p > 65535) { showToast('Port tidak valid', true); return; }

    saveSettings({ serverIp: ip, wsPort: String(p), token });

    wsDisconnect();
    showBanner(`Menghubungkan ke ${ip}:${p} ...`, 'warn');
    wsConnect(buildWsUrl(ip, p, token));
    closeLayer(els.layerSettings);
  }

  // ===== Event bindings =====
  if (els.btnSettings) els.btnSettings.addEventListener('click', () => { populateSettings(); openLayer(els.layerSettings); });
  if (els.btnRefresh) els.btnRefresh.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch (_) {}
    } else {
      const s = loadSettings();
      const url = buildWsUrl(s.serverIp, s.wsPort, s.token);
      if (url) wsConnect(url); else { populateSettings(); openLayer(els.layerSettings); }
    }
  });
  // ===== Update APK (jembatan native lewat update-checker.js) =====
  const updEls = { status: $('#updStatus'), btn: $('#btnCheckUpdate') };
  function setUpdStatus(text) { if (updEls.status) updEls.status.value = text; }
  window.onUpdateStatusUI = (st) => {
    st = st || {};
    switch (st.state) {
      case 'checking': setUpdStatus('Memeriksa...'); break;
      case 'up-to-date': setUpdStatus(`Terbaru (v${st.currentVersion || window.APP_CURRENT_VERSION})`); break;
      case 'update-available': setUpdStatus(`Update v${st.version} tersedia`); break;
      case 'downloading': setUpdStatus(`Mengunduh ${st.progress || 0}%`); break;
      case 'error': setUpdStatus('Gagal: ' + (st.message || 'kesalahan')); break;
    }
  };
  if (updEls.btn) updEls.btn.addEventListener('click', () => {
    if (typeof window.checkForTelemetryUpdate === 'function') window.checkForTelemetryUpdate(false);
  });

  if (els.formSettings) els.formSettings.addEventListener('submit', (e) => { e.preventDefault(); onConnect(); });
  if (els.btnCopyJson) els.btnCopyJson.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(els.rawJson ? els.rawJson.textContent : '');
      showToast('JSON disalin');
    } catch (_) { showToast('Gagal salin', true); }
  });
  if (els.tokenToggle) els.tokenToggle.addEventListener('click', () => {
    if (!els.setToken) return;
    const isPwd = els.setToken.type === 'password';
    els.setToken.type = isPwd ? 'text' : 'password';
    els.tokenToggle.textContent = isPwd ? 'Sembunyikan' : 'Lihat';
  });

  $$('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => {
      const layer = btn.closest('.layer');
      if (layer) closeLayer(layer);
    });
  });

  // ===== Init =====
  function init() {
    populateSettings();
    const s = loadSettings();
    if (s.serverIp) {
      const url = buildWsUrl(s.serverIp, s.wsPort, s.token);
      if (url) wsConnect(url);
    } else {
      openLayer(els.layerSettings);
    }
  }

  init();

  // Cek update otomatis (senyap: tidak menampilkan banner error bila offline).
  setTimeout(() => {
    if (typeof window.checkForTelemetryUpdate === 'function') window.checkForTelemetryUpdate(true);
  }, 3000);
})();