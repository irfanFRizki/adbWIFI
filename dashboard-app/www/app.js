/**
 * Telemetry Dashboard — remote monitoring client.
 * Terhubung ke banyak Telemetry Server (APK 1) sekaligus lewat WebSocket.
 * Setiap HP Target punya koneksi sendiri; kartu di bawah menampilkan HP yang dipilih,
 * sedangkan deretan kartu perangkat di atas merangkum semua HP.
 */

(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ===== Konstanta & state =====
  const LS_DEVICES = 'dashboard_devices';
  const LS_SELECTED = 'dashboard_selected';
  const LS_RAW_HIDDEN = 'dashboard_raw_hidden';
  const LS_OLD = 'dashboard_settings'; // format lama (satu server) — dimigrasi otomatis
  const STALE_MS = 20000;              // tanpa pesan selama ini → tampil "Tertunda"
  const MAX_DEVICES = 12;

  let devices = [];          // [{ id, name, ip, port, token }]
  let selectedId = null;
  let editingId = null;      // id perangkat yang sedang diedit di form (null = tambah baru)
  const conns = new Map();   // id -> state koneksi & data terakhir

  // ===== DOM refs =====
  const els = {
    pulse: $('#pulse'),
    banner: $('#banner'),
    btnSettings: $('#btnSettings'),
    btnRefresh: $('#btnRefresh'),

    devStrip: $('#devStrip'),
    devHeading: $('#devHeading'),

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

    chipBgApps: $('#chipBgApps'),
    listBgApps: $('#listBgApps'),
    footBgApps: $('#footBgApps'),

    rawJson: $('#rawJson'),
    rawHidden: $('#rawHidden'),
    btnCopyJson: $('#btnCopyJson'),
    btnToggleRaw: $('#btnToggleRaw'),

    layerSettings: $('#layerSettings'),
    formSettings: $('#formSettings'),
    verLabel: $('#verLabel'),
    deviceList: $('#deviceList'),
    formTitle: $('#formTitle'),
    setName: $('#setName'),
    setServerIp: $('#setServerIp'),
    setPort: $('#setPort'),
    setToken: $('#setToken'),
    setMsg: $('#setMsg'),
    tokenToggle: $('#tokenToggle'),
    btnSaveDevice: $('#btnSaveDevice'),
    btnCancelEdit: $('#btnCancelEdit'),

    layerDetail: $('#layerDetail'),
    dTitle: $('#dTitle'),
    dSub: $('#dSub'),
    dBody: $('#dBody'),

    toast: $('#toast'),
  };

  // ===== Helpers =====
  let bannerTimer = null;
  function showBanner(msg, type = 'info') {
    if (!els.banner) return;
    els.banner.textContent = msg;
    els.banner.className = `banner ${type}`;
    els.banner.classList.remove('hidden');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => els.banner.classList.add('hidden'), 4000);
  }

  let toastTimer = null;
  function showToast(msg, err = false) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.className = `toast ${err ? 'err' : ''}`;
    els.toast.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 3000);
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

  function renderBackgroundApps(apps, perms) {
    if (!els.listBgApps) return;
    if (perms && perms.usage === false) {
      els.listBgApps.innerHTML = '';
      setChip(els.chipBgApps, 'Izin belum diberikan', 'warn');
      if (els.footBgApps) els.footBgApps.textContent = 'Di HP Target: buka aplikasi Server, tekan "Beri Izin", lalu aktifkan Akses Penggunaan untuk Telemetry Server.';
      return;
    }
    if (!apps || !apps.length) {
      els.listBgApps.innerHTML = '';
      setChip(els.chipBgApps, '—', '');
      if (els.footBgApps) els.footBgApps.textContent = 'Tidak ada aplikasi yang berpindah ke latar belakang baru-baru ini.';
      return;
    }
    setChip(els.chipBgApps, `${apps.length} aplikasi`, 'ok');
    els.listBgApps.innerHTML = apps.map((a) => `
      <li>
        <span class="app-icon">${esc((a.name || a.package || '?')[0].toUpperCase())}</span>
        <div class="app-info">
          <div class="app-name">${esc(a.name || a.package)}</div>
          <div class="app-pkg">${esc(a.package)}</div>
        </div>
        <span class="app-time">${a.minutesAgo} menit lalu</span>
      </li>
    `).join('');
    if (els.footBgApps) els.footBgApps.textContent = `${apps.length} aplikasi berjalan di latar belakang`;
  }

  // ----- Nama jalan (reverse geocoding OpenStreetMap/Nominatim, perlu internet di HP Pantau) -----
  // Hanya dijalankan untuk HP yang sedang dipilih, jadi kebijakan Nominatim (±1 permintaan/detik) tetap aman.
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

  async function updateStreet(c, lat, lon) {
    if (!els.valStreet || lat == null || lon == null) return;
    const isSel = () => c.id === selectedId;
    const geo = c.geo;
    if (geo.text && isSel()) { els.valStreet.textContent = geo.text; els.valStreet.classList.remove('dim'); }
    if (c.geoBusy) return;
    const since = Date.now() - geo.at;
    const moved = geo.lat == null ? Infinity : distM(geo.lat, geo.lon, lat, lon);
    const need = (geo.lat == null && since >= 10000) || (geo.lat != null && moved >= 30 && since >= 5000);
    if (!need) return;

    c.geoBusy = true;
    geo.at = Date.now();
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), 8000) : null;
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&addressdetails=1&zoom=18&accept-language=id&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      const res = await fetch(url, ctl ? { signal: ctl.signal } : undefined);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = formatAddress(await res.json());
      c.geo = { lat, lon, at: Date.now(), text };
      if (isSel()) {
        els.valStreet.textContent = text || 'Nama jalan tidak ditemukan';
        els.valStreet.classList.toggle('dim', !text);
      }
    } catch (_) {
      if (!c.geo.text && isSel()) {
        els.valStreet.textContent = 'Nama jalan belum tersedia (HP Pantau perlu internet)';
        els.valStreet.classList.add('dim');
      }
    } finally {
      if (timer) clearTimeout(timer);
      c.geoBusy = false;
    }
  }

  // Kosongkan semua kartu (dipakai saat berpindah HP supaya tidak ada sisa data HP sebelumnya).
  function resetView() {
    const dash = (el) => { if (el) el.textContent = '—'; };
    [els.valBatLevel, els.valBatTemp, els.valBatVolt, els.valBatCurr, els.valLat, els.valLon, els.valAcc, els.valAlt,
      els.valProv, els.valRam, els.valCpu, els.valScreen, els.valWifi, els.valIp, els.valRssi].forEach(dash);
    ['chipBatStatus', 'chipLoc', 'chipSys', 'chipNet', 'chipApps'].forEach((k) => setChip(els[k], '—', ''));
    ['chipBatStatus', 'chipLoc', 'chipSys', 'chipNet', 'chipApps', 'chipBgApps'].forEach((k) => setChip(els[k], '—', ''));
    [els.footBat, els.footLoc, els.footSys, els.footNet].forEach((el) => { if (el) el.textContent = ''; });
    if (els.footApps) els.footApps.textContent = 'Menunggu data dari server...';
    if (els.footBgApps) els.footBgApps.textContent = 'Menunggu data dari server...';
    if (els.listApps) els.listApps.innerHTML = '';
    if (els.listBgApps) els.listBgApps.innerHTML = '';
    if (els.lblRam) els.lblRam.textContent = 'RAM';
    if (els.lblCpu) els.lblCpu.textContent = 'CPU';
    [els.barBat, els.barRam, els.barCpu].forEach((el) => { if (el) { el.style.width = '0%'; el.className = ''; } });
    if (els.bolt) els.bolt.classList.remove('on');
    if (els.cardBattery) els.cardBattery.classList.remove('is-charging');
    if (els.valStreet) { els.valStreet.textContent = 'Menunggu lokasi...'; els.valStreet.classList.add('dim'); }
    if (els.rawJson) els.rawJson.textContent = '—';
  }

  function paintLoc(l) {
    if (els.valLat) els.valLat.textContent = Number(l.lat).toFixed(6);
    if (els.valLon) els.valLon.textContent = Number(l.lon).toFixed(6);
    if (els.valAcc) els.valAcc.textContent = l.accuracy ? `±${Math.round(l.accuracy)}m` : '—';
    if (els.valAlt) els.valAlt.textContent = l.altitude ? `${Number(l.altitude).toFixed(0)}m` : '—';
    if (els.valProv) els.valProv.textContent = l.provider || '—';
  }

  // Gambar data satu HP ke kartu-kartu. `c` = state koneksi HP tersebut.
  function render(data, c) {
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
        setChip(els.chipLoc, c.lastGoodLoc ? 'Lokasi lama' : 'Menunggu', 'warn');
        if (els.footLoc) els.footLoc.textContent = l.error || 'Lokasi tidak tersedia';
        if (c.lastGoodLoc) {
          paintLoc(c.lastGoodLoc);
          if (c.geo.text && els.valStreet) { els.valStreet.textContent = c.geo.text; els.valStreet.classList.remove('dim'); }
        } else {
          if (els.valLat) els.valLat.textContent = '—';
          if (els.valLon) els.valLon.textContent = '—';
          if (els.valStreet) { els.valStreet.textContent = l.error || 'Menunggu lokasi...'; els.valStreet.classList.add('dim'); }
        }
      } else {
        c.lastGoodLoc = l;
        const stale = l.stale || (l.ageMs != null && l.ageMs > 60000);
        setChip(els.chipLoc, stale ? 'Lama' : (l.provider || 'GPS'), stale ? 'warn' : ((l.accuracy || 999) <= 30 ? 'ok' : 'warn'));
        paintLoc(l);
        const kmh = l.speed ? `${(Number(l.speed) * 3.6).toFixed(0)} km/j` : '0 km/j';
        const age = l.ageMs != null ? `diperbarui ${formatMs(l.ageMs)} lalu` : new Date(l.timestamp || Date.now()).toLocaleTimeString();
        if (els.footLoc) els.footLoc.textContent = `Kecepatan: ${kmh} • ${age}`;
        updateStreet(c, Number(l.lat), Number(l.lon));
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

    if (data.backgroundApps) renderBackgroundApps(data.backgroundApps, data.permissions);

    renderRaw();
  }

  // ===== Data mentah: sembunyikan / tampilkan, salin tetap jalan =====
  // Sumber data untuk "Salin" adalah data terakhir HP yang dipilih (bukan isi elemen di layar),
  // jadi tetap berfungsi walau panel disembunyikan.
  let rawHidden = true;

  function loadRawHidden() {
    try { const v = localStorage.getItem(LS_RAW_HIDDEN); if (v !== null) return v === '1'; } catch (_) {}
    return true; // bawaan: disembunyikan
  }

  function rawText() {
    const c = conns.get(selectedId);
    return c && c.data ? JSON.stringify(c.data, null, 2) : '';
  }

  function renderRaw() {
    if (els.rawJson) {
      els.rawJson.classList.toggle('hidden', rawHidden);
      if (!rawHidden) els.rawJson.textContent = rawText() || '—'; // saat tersembunyi tidak perlu dirender
    }
    if (els.rawHidden) els.rawHidden.classList.toggle('hidden', !rawHidden);
    if (els.btnToggleRaw) {
      els.btnToggleRaw.textContent = rawHidden ? 'Tampilkan' : 'Sembunyikan';
      els.btnToggleRaw.setAttribute('aria-expanded', rawHidden ? 'false' : 'true');
    }
  }

  function setRawHidden(v) {
    rawHidden = v;
    try { localStorage.setItem(LS_RAW_HIDDEN, v ? '1' : '0'); } catch (_) {}
    renderRaw();
  }

  // WebView memuat dari file:// (bukan secure context) → navigator.clipboard sering tidak ada. Pakai cadangan execCommand.
  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext !== false) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* lanjut ke cadangan */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return !!ok;
    } catch (_) { return false; }
  }

  // ===== Penyimpanan daftar perangkat =====
  function newId() { return 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function normDevice(o) {
    if (!o || typeof o !== 'object' || !o.ip) return null;
    const port = parseInt(o.port, 10);
    return {
      id: typeof o.id === 'string' && o.id ? o.id : newId(),
      name: String(o.name || '').trim(),
      ip: String(o.ip).trim(),
      port: port >= 1 && port <= 65535 ? port : 8765,
      token: String(o.token || ''),
    };
  }

  function loadDevices() {
    let list = [];
    try {
      const raw = localStorage.getItem(LS_DEVICES);
      if (raw) list = (JSON.parse(raw) || []).map(normDevice).filter(Boolean);
    } catch (_) {}
    if (!list.length) {
      // Migrasi dari pengaturan lama (satu server)
      try {
        const old = JSON.parse(localStorage.getItem(LS_OLD) || 'null');
        if (old && old.serverIp) list = [normDevice({ ip: old.serverIp, port: old.wsPort || 8765, token: old.token || '' })];
      } catch (_) {}
      if (list.length) saveDevices(list);
    }
    return list;
  }

  function saveDevices(list = devices) {
    try { localStorage.setItem(LS_DEVICES, JSON.stringify(list)); } catch (_) {}
  }

  function saveSelected() {
    try { if (selectedId) localStorage.setItem(LS_SELECTED, selectedId); else localStorage.removeItem(LS_SELECTED); } catch (_) {}
  }

  const getDev = (id) => devices.find((d) => d.id === id);

  function deviceLabel(d) {
    const c = conns.get(d.id);
    const model = c && c.data && c.data.system && c.data.system.model;
    return d.name || model || d.ip;
  }

  function buildWsUrl(ip, port, token) {
    if (!ip || !port) return null;
    let url = `ws://${ip}:${port}/ws`;
    if (token) url += `?token=${encodeURIComponent(token)}`;
    return url;
  }

  // ===== Koneksi WebSocket per perangkat =====
  function makeConn(id) {
    return {
      id, ws: null, timer: null, attempts: 0, state: 'idle', data: null, lastSeen: 0,
      lastGoodLoc: null, geo: { lat: null, lon: null, at: 0, text: '' }, geoBusy: false,
    };
  }

  function closeSock(c) {
    const s = c.ws;
    c.ws = null; // handler lama berhenti bereaksi karena c.ws !== sock
    if (s) { try { s.close(); } catch (_) {} }
  }

  function connectDevice(id) {
    const dev = getDev(id);
    if (!dev) return;
    let c = conns.get(id);
    if (!c) { c = makeConn(id); conns.set(id, c); }
    clearTimeout(c.timer); c.timer = null;
    closeSock(c);

    const url = buildWsUrl(dev.ip, dev.port, dev.token);
    if (!url) { c.state = 'disconnected'; refreshUi(id); return; }
    c.state = 'connecting';
    refreshUi(id);

    try {
      const sock = new WebSocket(url);
      c.ws = sock;

      sock.onopen = () => {
        if (c.ws !== sock) return;
        c.state = 'connected';
        c.attempts = 0;
        c.lastSeen = Date.now();
        refreshUi(id);
        if (id === selectedId) showBanner(`Terhubung ke ${deviceLabel(dev)}`, 'ok');
      };

      sock.onmessage = (e) => {
        if (c.ws !== sock) return;
        let msg;
        try { msg = JSON.parse(e.data); } catch (_) { return; }
        c.lastSeen = Date.now();
        if (!msg || msg.type === 'pong' || msg.type === 'error') { scheduleStrip(); return; }
        const data = msg.type === 'telemetry' ? msg.data : msg;
        if (!data || typeof data !== 'object') return;
        c.data = data;
        if (data.location && data.location.lat != null && data.location.lon != null) c.lastGoodLoc = data.location;
        if (id === selectedId) render(data, c);
        scheduleStrip();
      };

      sock.onerror = () => { /* detail ditangani di onclose */ };

      sock.onclose = () => {
        if (c.ws !== sock) return; // koneksi lama yang sudah diganti
        c.ws = null;
        c.state = 'disconnected';
        refreshUi(id);
        if (id === selectedId) {
          showBanner(`Tidak bisa terhubung ke ${deviceLabel(dev)} (${dev.ip}:${dev.port}). Pastikan server berjalan, port benar, dan satu jaringan. Mencoba lagi...`, 'err');
        }
        scheduleReconnect(id);
      };
    } catch (err) {
      c.state = 'disconnected';
      refreshUi(id);
      if (id === selectedId) showBanner(`URL tidak valid: ${err && err.message ? err.message : err}`, 'err');
      scheduleReconnect(id);
    }
  }

  // Terus mencoba (maks. 30 dtk antar percobaan) agar HP yang sempat mati otomatis tersambung lagi.
  function scheduleReconnect(id) {
    const c = conns.get(id);
    if (!c || c.timer || !getDev(id)) return;
    const delay = Math.min(2000 * Math.pow(1.6, Math.min(c.attempts, 8)), 30000);
    c.attempts++;
    c.timer = setTimeout(() => { c.timer = null; if (getDev(id)) connectDevice(id); }, delay);
  }

  function disconnectDevice(id) {
    const c = conns.get(id);
    if (!c) return;
    clearTimeout(c.timer); c.timer = null;
    closeSock(c);
    conns.delete(id);
  }

  function connectAll() { devices.forEach((d) => connectDevice(d.id)); }

  // ===== UI perangkat: deretan kartu + judul =====
  function statusOf(c) {
    if (!c || c.state === 'idle') return { cls: 'off', text: '—' };
    if (c.state === 'connecting') return { cls: 'wait', text: 'Menghubungkan' };
    if (c.state === 'connected') {
      return Date.now() - c.lastSeen > STALE_MS ? { cls: 'wait', text: 'Tertunda' } : { cls: 'on', text: 'Online' };
    }
    return { cls: 'off', text: 'Offline' };
  }

  let stripTimer = null;
  function scheduleStrip() {
    if (stripTimer) return;
    stripTimer = setTimeout(() => { stripTimer = null; renderStrip(); }, 400);
  }

  function renderStrip() {
    if (!els.devStrip) return;
    const cards = devices.map((d) => {
      const c = conns.get(d.id);
      const st = statusOf(c);
      const data = c && c.data;
      const b = data && data.battery;
      const bat = b && b.level != null ? `${b.level}%${b.status === 'charging' ? ' ⚡' : ''}` : '—';
      const fg = data && Array.isArray(data.apps) ? data.apps.find((a) => a.foreground) : null;
      const sub = fg ? (fg.name || fg.package) : (c && c.state === 'connected' ? (data && data.system && data.system.screenOn === false ? 'Layar mati' : 'Tidak ada app aktif') : d.ip);
      const low = b && b.level != null && b.level <= 15 && b.status !== 'charging';
      return `<button type="button" class="dev ${d.id === selectedId ? 'sel' : ''}" data-id="${esc(d.id)}" aria-pressed="${d.id === selectedId}">
        <span class="dev-top"><span class="dot ${st.cls}" title="${esc(st.text)}"></span><span class="dev-name">${esc(deviceLabel(d))}</span><span class="dev-bat ${low ? 'low' : ''}">${esc(bat)}</span></span>
        <span class="dev-sub">${esc(st.text)} • ${esc(sub)}</span>
      </button>`;
    }).join('');
    els.devStrip.innerHTML = cards + '<button type="button" class="dev add" id="btnAddDev" aria-label="Tambah HP">+<span>Tambah HP</span></button>';

    const sel = getDev(selectedId);
    if (els.devHeading) {
      els.devHeading.textContent = sel ? `${deviceLabel(sel)} • ${sel.ip}:${sel.port}` : 'Belum ada HP — tambahkan lewat tombol +';
    }
  }

  function updatePulse() {
    const c = conns.get(selectedId);
    const st = c ? c.state : 'disconnected';
    setPulse(st === 'connected' ? 'connected' : (st === 'connecting' ? 'connecting' : 'disconnected'));
  }

  // Dipanggil saat status koneksi satu perangkat berubah.
  function refreshUi(id) {
    renderStrip();
    if (id === selectedId) updatePulse();
  }

  function selectDevice(id) {
    if (!getDev(id)) return;
    selectedId = id;
    saveSelected();
    resetView();
    renderStrip();
    updatePulse();
    const c = conns.get(id);
    if (c && c.data) render(c.data, c); else renderRaw();
  }

  // ===== Pengaturan: kelola perangkat =====
  function renderDeviceList() {
    if (!els.deviceList) return;
    if (!devices.length) {
      els.deviceList.innerHTML = '<p class="hint" style="margin:0 0 12px">Belum ada HP. Isi form di bawah untuk menambahkan.</p>';
      return;
    }
    els.deviceList.innerHTML = devices.map((d) => {
      const st = statusOf(conns.get(d.id));
      return `<div class="dev-row" data-id="${esc(d.id)}">
        <span class="dot ${st.cls}" title="${esc(st.text)}"></span>
        <div class="dev-row-info"><div class="dev-row-name">${esc(deviceLabel(d))}</div><div class="dev-row-addr mono">${esc(d.ip)}:${esc(d.port)} • ${esc(st.text)}</div></div>
        <button type="button" class="btn ghost small" data-act="edit">Ubah</button>
        <button type="button" class="btn ghost small danger-text" data-act="del">Hapus</button>
      </div>`;
    }).join('');
  }

  function setFormMsg(msg) {
    if (!els.setMsg) return;
    els.setMsg.textContent = msg || '';
    els.setMsg.classList.toggle('hidden', !msg);
  }

  function fillForm(d) {
    editingId = d ? d.id : null;
    if (els.setName) els.setName.value = d ? d.name : '';
    if (els.setServerIp) els.setServerIp.value = d ? d.ip : '';
    if (els.setPort) els.setPort.value = d ? String(d.port) : '8765';
    if (els.setToken) els.setToken.value = d ? d.token : '';
    if (els.formTitle) els.formTitle.textContent = d ? `Ubah: ${deviceLabel(d)}` : 'Tambah HP Target';
    if (els.btnSaveDevice) els.btnSaveDevice.textContent = d ? 'Simpan perubahan' : 'Tambah & Hubungkan';
    if (els.btnCancelEdit) els.btnCancelEdit.classList.toggle('hidden', !d);
    setFormMsg('');
  }

  function openSettings(editId) {
    if (els.verLabel) els.verLabel.textContent = `v${window.APP_CURRENT_VERSION || window.APP_VERSION || '?'} • ${window.APP_ID || 'com.irfanfrizki.telemetry.dashboard'}`;
    renderDeviceList();
    fillForm(editId ? getDev(editId) : null);
    openLayer(els.layerSettings);
  }

  function onSaveDevice() {
    const name = els.setName ? els.setName.value.trim() : '';
    const ip = els.setServerIp ? els.setServerIp.value.trim() : '';
    const port = parseInt(els.setPort ? els.setPort.value.trim() : '8765', 10);
    const token = els.setToken ? els.setToken.value.trim() : '';

    if (!ip) { setFormMsg('IP server wajib diisi'); return; }
    if (isNaN(port) || port < 1 || port > 65535) { setFormMsg('Port tidak valid'); return; }
    if (devices.some((d) => d.id !== editingId && d.ip === ip && d.port === port)) { setFormMsg('HP dengan IP dan port ini sudah ada'); return; }

    let id;
    if (editingId && getDev(editingId)) {
      id = editingId;
      Object.assign(getDev(id), { name, ip, port, token });
    } else {
      if (devices.length >= MAX_DEVICES) { setFormMsg(`Maksimal ${MAX_DEVICES} HP`); return; }
      id = newId();
      devices.push({ id, name, ip, port, token });
    }
    saveDevices();
    const c = conns.get(id);
    if (c) { c.data = null; c.lastGoodLoc = null; c.geo = { lat: null, lon: null, at: 0, text: '' }; c.attempts = 0; }
    connectDevice(id);
    showBanner(`Menghubungkan ke ${name || ip}:${port} ...`, 'warn');
    selectDevice(id);
    closeLayer(els.layerSettings);
  }

  let delArm = { id: null, timer: null };
  function onDeleteDevice(id, btn) {
    if (delArm.id !== id) {
      // Ketuk pertama: minta konfirmasi (tanpa dialog bawaan, tidak andal di WebView)
      clearTimeout(delArm.timer);
      delArm = { id, timer: setTimeout(() => { delArm = { id: null, timer: null }; renderDeviceList(); }, 3000) };
      if (btn) { btn.textContent = 'Yakin?'; btn.classList.add('armed'); }
      return;
    }
    clearTimeout(delArm.timer); delArm = { id: null, timer: null };
    disconnectDevice(id);
    devices = devices.filter((d) => d.id !== id);
    saveDevices();
    if (editingId === id) fillForm(null);
    if (selectedId === id) {
      selectedId = devices.length ? devices[0].id : null;
      saveSelected();
      resetView();
      const c = selectedId && conns.get(selectedId);
      if (c && c.data) render(c.data, c);
      updatePulse();
    }
    renderStrip();
    renderRaw();
    renderDeviceList();
  }

  // ===== Event bindings =====
  if (els.btnSettings) els.btnSettings.addEventListener('click', () => openSettings());

  if (els.btnRefresh) els.btnRefresh.addEventListener('click', () => {
    if (!devices.length) { openSettings(); return; }
    const c = conns.get(selectedId);
    if (c && c.ws && c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(JSON.stringify({ type: 'data' })); } catch (_) {} // minta data terbaru sekarang juga
    } else if (selectedId) {
      if (c) c.attempts = 0;
      connectDevice(selectedId);
    }
  });

  if (els.devStrip) els.devStrip.addEventListener('click', (e) => {
    const add = e.target.closest('#btnAddDev');
    if (add) { openSettings(); return; }
    const card = e.target.closest('.dev[data-id]');
    if (card) selectDevice(card.getAttribute('data-id'));
  });

  if (els.deviceList) els.deviceList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    const row = e.target.closest('.dev-row');
    if (!btn || !row) return;
    const id = row.getAttribute('data-id');
    if (btn.getAttribute('data-act') === 'edit') fillForm(getDev(id));
    else onDeleteDevice(id, btn);
  });

  if (els.btnCancelEdit) els.btnCancelEdit.addEventListener('click', () => fillForm(null));

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

  if (els.formSettings) els.formSettings.addEventListener('submit', (e) => { e.preventDefault(); onSaveDevice(); });

  if (els.btnToggleRaw) els.btnToggleRaw.addEventListener('click', () => setRawHidden(!rawHidden));
  if (els.btnCopyJson) els.btnCopyJson.addEventListener('click', async () => {
    const text = rawText();
    if (!text) { showToast('Belum ada data untuk disalin', true); return; }
    showToast((await copyText(text)) ? 'JSON disalin' : 'Gagal salin', false);
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
    rawHidden = loadRawHidden();
    devices = loadDevices();
    let sel = null;
    try { sel = localStorage.getItem(LS_SELECTED); } catch (_) {}
    selectedId = getDev(sel) ? sel : (devices[0] && devices[0].id) || null;

    resetView();
    renderStrip();
    renderRaw();
    if (devices.length) {
      connectAll();
      updatePulse();
    } else {
      setPulse('disconnected');
      openSettings();
    }
    // Segarkan status "Tertunda" & label waktu tanpa menunggu pesan baru
    setInterval(renderStrip, 5000);
  }

  init();

  // Cek update otomatis (senyap: tidak menampilkan banner error bila offline).
  setTimeout(() => {
    if (typeof window.checkForTelemetryUpdate === 'function') window.checkForTelemetryUpdate(true);
  }, 3000);
})();
