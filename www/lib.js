/**
 * Telemetry Server — pure logic (no DOM).
 * Loads before app.js in index.html.
 */

const TelemetryLib = (() => {
  'use strict';

  // ===== Util =====
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const throttle = (fn, ms) => { let last = 0; return (...a) => { const now = Date.now(); if (now - last >= ms) { last = now; fn(...a); } }; };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ===== Storage keys =====
  const STORAGE = {
    PORT: 'ts.port',
    WS_PORT: 'ts.wsPort',
    TOKEN: 'ts.token',
    BIND_ALL: 'ts.bindAll',
    INTERVAL: 'ts.interval',
    SERVER_RUNNING: 'ts.serverRunning',
    LAST_DATA: 'ts.lastData',
    WS_URL: 'ts.wsUrl',
  };

  // ===== Capacitor bridge (native) =====
  let CapacitorRef = null;
  let Preferences = null;
  let Network = null;
  let App = null;
  let NativeBridge = null;

  async function initCapacitor() {
    if (typeof window !== 'undefined' && window.Capacitor) {
      CapacitorRef = window.Capacitor;
      try {
        const modPrefs = await import('@capacitor/preferences');
        Preferences = modPrefs.Preferences;
      } catch (_) { /* ignore */ }
      try {
        const modNet = await import('@capacitor/network');
        Network = modNet.Network;
      } catch (_) { /* ignore */ }
      try {
        const modApp = await import('@capacitor/app');
        App = modApp.App;
      } catch (_) { /* ignore */ }

      // Try to get native plugin from Capacitor.Plugins first, then register
      try {
        if (CapacitorRef.Plugins && CapacitorRef.Plugins.TelemetryBridge) {
          NativeBridge = CapacitorRef.Plugins.TelemetryBridge;
        } else if (CapacitorRef.registerPlugin) {
          NativeBridge = CapacitorRef.registerPlugin('TelemetryBridge');
        }
      } catch (_) { /* ignore */ }
    }
    return !!CapacitorRef;
  }

  // ===== Preferences wrapper =====
  async function prefGet(key, fallback = null) {
    if (Preferences) {
      try {
        const { value } = await Preferences.get({ key });
        return value ?? fallback;
      } catch (_) {}
    }
    try { return localStorage.getItem(key) ?? fallback; } catch (_) { return fallback; }
  }

  async function prefSet(key, value) {
    if (Preferences) {
      try { await Preferences.set({ key, value: String(value) }); return; } catch (_) {}
    }
    try { localStorage.setItem(key, String(value)); } catch (_) {}
  }

  async function prefRemove(key) {
    if (Preferences) {
      try { await Preferences.remove({ key }); return; } catch (_) {}
    }
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // ===== Settings =====
  const defaults = {
    port: 8080,
    wsPort: 8081,
    token: '',
    bindAll: '1',
    interval: '2',
  };

  async function loadSettings() {
    const s = {};
    for (const [k, def] of Object.entries(defaults)) {
      const stored = await prefGet(STORAGE[k.toUpperCase()] || `ts.${k}`, def);
      s[k] = stored;
    }
    return s;
  }

  async function saveSettings(s) {
    for (const [k, v] of Object.entries(s)) {
      const key = STORAGE[k.toUpperCase()] || `ts.${k}`;
      await prefSet(key, v);
    }
  }

  // ===== Native calls =====
  async function nativeStartServer(cfg) {
    if (NativeBridge && NativeBridge.startServer) {
      try { return await NativeBridge.startServer(cfg); } catch (e) { return { success: false, error: e.message || String(e) }; }
    }
    return { success: false, error: 'Native bridge not available' };
  }

  async function nativeStopServer() {
    if (NativeBridge && NativeBridge.stopServer) {
      try { return await NativeBridge.stopServer(); } catch (e) { return { success: false, error: e.message || String(e) }; }
    }
    return { success: false, error: 'Native bridge not available' };
  }

  async function nativeGetServerStatus() {
    if (NativeBridge && NativeBridge.getServerStatus) {
      try { return await NativeBridge.getServerStatus(); } catch (_) {}
    }
    return { running: false };
  }

  async function nativeGetData() {
    if (NativeBridge && NativeBridge.getData) {
      try { return await NativeBridge.getData(); } catch (_) {}
    }
    return null;
  }

  async function nativeGetWsUrl() {
    if (NativeBridge && NativeBridge.getWsUrl) {
      try { return await NativeBridge.getWsUrl(); } catch (_) {}
    }
    return null;
  }

  async function nativeRequestPermissions() {
    if (NativeBridge && NativeBridge.requestPermissions) {
      try { return await NativeBridge.requestPermissions(); } catch (_) {}
    }
    return { granted: [] };
  }

  // ===== Data parsing / formatting =====
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || isNaN(bytes)) return '—';
    const units = ['B','KB','MB','GB','TB'];
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

  function chipClassForStatus(status) {
    if (!status) return '';
    if (status === 'connected' || status === 'running' || status === 'ok' || status === 'charging') return 'ok';
    if (status === 'warning' || status === 'discharging' || status === 'low' || status === 'warn') return 'warn';
    if (status === 'error' || status === 'disconnected' || status === 'critical' || status === 'err') return 'err';
    return '';
  }

  // ===== WebSocket client (fallback if native WS not used) =====
  let ws = null;
  let wsReconnectTimer = null;
  let wsListeners = new Set();
  let currentWsUrl = null;

  function wsConnect(url) {
    if (!url) return;
    currentWsUrl = url;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    try {
      ws = new WebSocket(url);
      ws.onopen = () => { wsListeners.forEach(cb => cb({ type: 'open' })); };
      ws.onmessage = (e) => { wsListeners.forEach(cb => cb({ type: 'message', data: e.data })); };
      ws.onerror = (e) => { wsListeners.forEach(cb => cb({ type: 'error', error: e })); };
      ws.onclose = () => { wsListeners.forEach(cb => cb({ type: 'close' })); scheduleReconnect(); };
    } catch (e) {
      wsListeners.forEach(cb => cb({ type: 'error', error: e }));
      scheduleReconnect();
    }
  }

  function scheduleReconnect() {
    if (wsReconnectTimer) return;
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      if (currentWsUrl) wsConnect(currentWsUrl);
    }, 3000);
  }

  function wsDisconnect() {
    currentWsUrl = null;
    if (wsReconnectTimer) { clearTimeout(wsReconnectTimer); wsReconnectTimer = null; }
    if (ws) { try { ws.close(); } catch (_) {} ws = null; }
  }

  function wsOn(listener) { wsListeners.add(listener); return () => wsListeners.delete(listener); }
  function wsSend(data) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data)); }

  // ===== Export =====
  return {
    $, $$, debounce, throttle, clamp,
    formatBytes, formatMs, formatUptime, formatSignal, chipClassForStatus,
    STORAGE, initCapacitor, loadSettings, saveSettings, prefGet, prefSet,
    nativeStartServer, nativeStopServer, nativeGetServerStatus, nativeGetData, nativeGetWsUrl, nativeRequestPermissions,
    wsConnect, wsDisconnect, wsOn, wsSend,
  };
})();

// Expose globally for app.js
window.TelemetryLib = TelemetryLib;