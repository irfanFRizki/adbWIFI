/* Server tiruan API hpmon (sesuai perilaku yang sudah diuji di router).
 * Hanya untuk pengujian; token uji bukan token asli. */
'use strict';
const http = require('http');

const TOKEN = 'test-token';
const BASE = '/cgi-bin/hpmon/index.sh';

function makeState() {
  return {
    targets: [
      { ip: '192.168.7.177', nama: 'HP-177', port_adb: 5555 },
      { ip: '192.168.7.245', nama: 'HP-245', port_adb: 5555 }
    ],
    hostnames: { '192.168.7.177': 'HP_AQILLA', '192.168.7.245': 'HP_IRFAN' },
    adbOverride: {} // ip -> bagian objek adb yang menimpa nilai bawaan (untuk uji kasus khusus)
  };
}

function deviceFor(t, now, state) {
  const hostname = (state.hostnames || {})[t.ip] || null;
  if (t.ip === '192.168.7.177') {
    return {
      ip: t.ip, nama: t.nama, hostname, port_adb: t.port_adb,
      router: { online: true, latency: '146.039 ms', mac: '20:34:fb:d3:f7:ca', connections: 14 },
      adb: Object.assign({
        status: 'connected', port_terdeteksi: 5555, battery: '68', model: 'Redmi Note 7', android: '10', screen: 'Asleep',
        uptime: 248518, wifi_ssid: 'IRFAN', wifi_rssi: -30,
        charging: true, charge_source: 'ac', temp_c: 44.0, voltage_mv: 3965, current_ma: 850, current_available: true,
        avg_drain_pct_per_hour: 6.5, foreground_app: { package: null, label: null }
      }, (state.adbOverride || {})[t.ip] || {}),
      rx_bytes: 4014889816, tx_bytes: 1059967337, rxtx_source: 'adb', rxtx_ts: now, rxtx_available: true
    };
  }
  return {
    ip: t.ip, nama: t.nama, hostname, port_adb: t.port_adb,
    router: { online: false, latency: '', mac: '9e:e8:9b:00:86:e2', connections: 36 },
    adb: { status: 'unreachable', error: 'connection refused or timeout' },
    rx_bytes: null, tx_bytes: null, rxtx_source: null, rxtx_ts: null, rxtx_available: false
  };
}

function start(port) {
  const state = makeState();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (!url.pathname.startsWith(BASE)) return send(404, { error: 'not_found' });
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return send(401, { error: 'unauthorized' });
    const route = url.pathname.slice(BASE.length) || '/';
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const now = Math.floor(Date.now() / 1000);
      if (route === '/status' && req.method === 'GET') {
        const ip = url.searchParams.get('ip');
        const detail = url.searchParams.get('detail');
        if (detail && !ip) return send(400, { error: 'detail_requires_ip' });
        if (ip) {
          const t = state.targets.find((x) => x.ip === ip);
          if (!t) return send(404, { error: 'not_found', ip });
          const d = deviceFor(t, now, state);
          if (detail) {
            d.detail = d.adb.status === 'connected'
              ? { apps: ['com.example.one', 'com.example.two'], ram: { total_kb: 3826256, available_kb: 1501140 }, cpu_percent: 38.2,
                  foreground_app: state.foreground || { package: null, label: null } }
              : null;
          }
          return send(200, d);
        }
        return send(200, { timestamp: now, devices: state.targets.map((t) => deviceFor(t, now, state)) });
      }
      if (route === '/targets' && req.method === 'GET') return send(200, state.targets);
      if (route === '/targets/add' || route === '/targets/delete') {
        if (req.method !== 'POST') return send(405, { error: 'method_not_allowed' });
        let body;
        try { body = JSON.parse(raw); } catch (e) { return send(400, { error: 'invalid_json' }); }
        const octets = String(body.ip || '').split('.');
        if (octets.length !== 4 || octets.some((o) => !/^\d{1,3}$/.test(o) || Number(o) > 255)) return send(400, { error: 'invalid_ip' });
        if (route === '/targets/add') {
          if (state.targets.some((x) => x.ip === body.ip)) return send(409, { error: 'ip_duplicate' });
          state.targets.push({ ip: body.ip, nama: body.nama || body.ip, port_adb: body.port_adb || 5555 });
          return send(200, { ok: true });
        }
        const i = state.targets.findIndex((x) => x.ip === body.ip);
        if (i < 0) return send(404, { error: 'not_found' });
        state.targets.splice(i, 1);
        return send(200, { ok: true });
      }
      return send(404, { error: 'not_found' });
    });
  });
  return new Promise((resolve) => server.listen(port || 0, '127.0.0.1', () => resolve({ server, port: server.address().port, state })));
}

module.exports = { start, TOKEN, BASE };
