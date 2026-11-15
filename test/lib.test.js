'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../www/lib.js');
const mock = require('./mock-server.js');

test('validasi IP dan port', () => {
  assert.equal(L.isValidIPv4('192.168.7.177'), true);
  assert.equal(L.isValidIPv4('192.168.7.256'), false);
  assert.equal(L.isValidIPv4('192.168.7'), false);
  assert.equal(L.isValidIPv4('abc'), false);
  assert.equal(L.isValidPort(5555), true);
  assert.equal(L.isValidPort('37123'), true);
  assert.equal(L.isValidPort(0), false);
  assert.equal(L.isValidPort(70000), false);
  assert.equal(L.isValidPort('x'), false);
});

test('normalizeBaseUrl', () => {
  const full = 'http://192.168.7.1/cgi-bin/hpmon/index.sh';
  assert.equal(L.normalizeBaseUrl('192.168.7.1'), full);
  assert.equal(L.normalizeBaseUrl('http://192.168.7.1/'), full);
  assert.equal(L.normalizeBaseUrl(full + '/status'), full);
  assert.equal(L.normalizeBaseUrl(full + '/targets/add'), full);
  assert.equal(L.normalizeBaseUrl(full + '/'), full);
  assert.equal(L.normalizeBaseUrl(''), '');
  assert.equal(L.normalizeBaseUrl('http://'), '');
  assert.equal(L.normalizeBaseUrl('100.64.0.5:8080'), 'http://100.64.0.5:8080' + L.DEFAULT_PATH);
});

test('format angka', () => {
  assert.equal(L.formatBytes(null), '—');
  assert.equal(L.formatBytes(0), '0 B');
  assert.equal(L.formatBytes(1536), '1.50 KB');
  assert.equal(L.formatBytes(4014889816), '3.74 GB');
  assert.equal(L.formatRate(2048), '2.00 KB/s');
  assert.equal(L.formatRate(null), '—');
  assert.equal(L.formatUptime(248518), '2 hari 21 jam');
  assert.equal(L.formatUptime(3700), '1 jam 1 mnt');
  assert.equal(L.formatUptime(null), '—');
  assert.equal(L.parseLatency('146.039 ms'), 146);
  assert.equal(L.parseLatency(''), null);
  assert.equal(L.wifiBars(-30), 4);
  assert.equal(L.wifiBars(-70), 2);
  assert.equal(L.wifiBars(-90), 1);
  assert.equal(L.wifiBars(null), 0);
  assert.equal(L.escapeHtml('<b a="1">&\'</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&#39;&lt;/b&gt;');
});

test('nama, baterai, dan aplikasi aktif', () => {
  assert.equal(L.displayName({ ip: '1.1.1.1', nama: 'HP-1', hostname: 'HP_AQILLA' }), 'HP_AQILLA');
  assert.equal(L.displayName({ ip: '1.1.1.1', nama: 'HP-1', hostname: null }), 'HP-1');
  assert.equal(L.displayName({ ip: '1.1.1.1', nama: '  ', hostname: ' ' }), '1.1.1.1');
  assert.equal(L.altName({ ip: '1.1.1.1', nama: 'HP-1', hostname: 'HP_AQILLA' }), 'HP-1');
  assert.equal(L.altName({ ip: '1.1.1.1', nama: 'HP-1', hostname: 'HP-1' }), '');
  assert.equal(L.altName({ ip: '1.1.1.1', nama: 'HP-1', hostname: null }), '');

  assert.equal(L.isCharging({ adb: { status: 'connected', charging: true } }), true);
  assert.equal(L.isCharging({ adb: { status: 'connected', charging: false } }), false);
  assert.equal(L.isCharging({ adb: { status: 'connected', charging: null } }), false);
  assert.equal(L.isCharging({ adb: { status: 'unreachable', charging: true } }), false);
  assert.equal(L.chargeSourceText('ac'), 'Charger (AC)');
  assert.equal(L.chargeSourceText('wireless'), 'Nirkabel');
  assert.equal(L.chargeSourceText(null), '');

  assert.equal(L.formatTemp(44), '44.0 °C');
  assert.equal(L.formatTemp(null), '—');
  assert.equal(L.tempLevel(36), 'ok');
  assert.equal(L.tempLevel(44), 'warm');
  assert.equal(L.tempLevel(45), 'hot');
  assert.equal(L.tempLevel(null), '');
  assert.equal(L.formatVoltage(3965), '3.97 V');
  assert.equal(L.formatVoltage(null), '—');
  assert.equal(L.formatCurrent(850), '+850 mA');
  assert.equal(L.formatCurrent(-312.6), '−313 mA');
  assert.equal(L.formatCurrent(0), '0 mA');
  assert.equal(L.formatCurrent(null), '—');
  assert.equal(L.formatDrain(6.52), '6.5 %/jam');
  assert.equal(L.formatDrain(null), '—');
  assert.equal(L.estimateRemaining(65, 10), '±6 jam 30 mnt');
  assert.equal(L.estimateRemaining('65', 0), null);
  assert.equal(L.estimateRemaining(65, null), null);
  assert.equal(L.estimateRemaining(50, 20), '±2 jam 30 mnt');

  assert.equal(L.foregroundApp({ adb: { foreground_app: { package: null, label: null } } }), null);
  assert.deepEqual(L.foregroundApp({ adb: { foreground_app: { package: 'org.telegram.messenger', label: 'Telegram' } } }),
    { text: 'Telegram', pkg: 'org.telegram.messenger' });
  assert.deepEqual(L.foregroundApp({ adb: { foreground_app: { package: 'com.x.y', label: null } } }), { text: 'com.x.y', pkg: 'com.x.y' });
  // detail (live) menang atas cache
  assert.deepEqual(L.foregroundApp({ adb: { foreground_app: { package: 'a.b', label: null } }, detail: { foreground_app: { package: 'c.d', label: 'D' } } }),
    { text: 'D', pkg: 'c.d' });
  assert.equal(L.foregroundApp({ adb: {} }), null);
});

test('kecepatan rx/tx dari selisih sampel', () => {
  const store = {};
  const dev = (rx, tx, ts) => ({ ip: '1.1.1.1', rx_bytes: rx, tx_bytes: tx, rxtx_ts: ts, rxtx_available: true });
  assert.equal(L.updateSample(store, dev(1000, 500, 100)), null);          // sampel pertama
  assert.equal(L.updateSample(store, dev(1000, 500, 100)), null);          // sampel sama: tidak berubah
  const r = L.updateSample(store, dev(7000, 2500, 160));                   // 60 detik kemudian
  assert.deepEqual(r, { rx: 100, tx: 33.333333333333336 });
  assert.deepEqual(L.updateSample(store, dev(7000, 2500, 160)), r);        // sampel sama: laju dipertahankan
  assert.equal(L.updateSample(store, dev(10, 10, 220)), null);             // counter reset (HP reboot)
  assert.equal(L.updateSample(store, { ip: '1.1.1.1', rx_bytes: null, rxtx_available: false }), null);
  assert.equal(store['1.1.1.1'].cur, null);                                // riwayat dibuang
});

test('header kunci hanya untuk URL Cloudflare dan opsional', async () => {
  const seen = [];
  const settings = { urls: ['http://lan.example', 'http://tail.example', 'https://cf.example/cgi-bin/hpmon/index.sh'], token: 'dummy-token', cfkey: 'dummy-key' };
  const api = L.createApi({
    getSettings: () => settings,
    transport: async (req) => { seen.push(req); return { status: 200, data: JSON.stringify({ timestamp: 1, devices: [] }) }; }
  });
  await api.status();
  assert.equal(seen[0].url, 'http://lan.example/cgi-bin/hpmon/index.sh/status');
  assert.equal(seen[0].headers['X-Adbwifi-Key'], undefined);
  settings.urls[0] = 'https://cf.example/cgi-bin/hpmon/index.sh';
  settings.cfkey = 'dummy-key';
  await api.status();
  assert.equal(seen[1].headers['X-Adbwifi-Key'], 'dummy-key');
  settings.cfkey = '';
  await api.status();
  assert.equal(seen[2].headers['X-Adbwifi-Key'], undefined);
});

test('klien API terhadap server tiruan', async () => {
  const { server, port, state } = await mock.start(0);
  try {
    const base = 'http://127.0.0.1:' + port;
    let settings = { urls: [base, ''], token: mock.TOKEN };
    const api = L.createApi({ getSettings: () => settings, transport: L.fetchTransport });

    const s = await api.status();
    assert.equal(s.devices.length, 2);
    assert.equal(s.devices[0].adb.status, 'connected');
    assert.equal(s.devices[1].rxtx_available, false);

    const d = await api.detail('192.168.7.177');
    assert.equal(d.detail.cpu_percent, 38.2);
    const d2 = await api.detail('192.168.7.245');
    assert.equal(d2.detail, null);
    await assert.rejects(api.detail('192.168.7.250'), (e) => e.status === 404 && e.code === 'not_found');

    assert.deepEqual(await api.addTarget({ ip: '192.168.7.188', nama: 'HP-188', port_adb: '5555' }), { ok: true });
    assert.equal(state.targets.length, 3);
    assert.equal(state.targets[2].port_adb, 5555);
    await assert.rejects(api.addTarget({ ip: '192.168.7.188', nama: 'x', port_adb: 5555 }),
      (e) => e.status === 409 && L.errorMessage(e) === 'IP ini sudah terdaftar.');
    await assert.rejects(api.addTarget({ ip: '999.1.1.1', nama: 'x', port_adb: 5555 }),
      (e) => e.status === 400 || e.code === 'invalid_ip');
    assert.deepEqual(await api.deleteTarget('192.168.7.188'), { ok: true });
    assert.equal(state.targets.length, 2);
    await assert.rejects(api.deleteTarget('192.168.7.188'), (e) => e.status === 404);

    const shot = await api.screenshot('192.168.7.177');
    assert.equal(shot.ok, true);
    assert.equal(shot.png_base64, 'iVBORw0KGgo=');
    await assert.rejects(api.screenshot('192.168.7.245'), (e) => e.status === 409 && e.code === 'adb_not_connected');

    const optim = await api.optimize('192.168.7.177');
    assert.equal(optim.ok, true);
    assert.equal(optim.top_apps.length, 2);
    assert.equal(optim.top_apps[0].kb, 58315);

    settings = { urls: [base, ''], token: 'salah' };
    await assert.rejects(api.status(), (e) => e.kind === 'auth' && L.errorMessage(e) === 'Token salah atau belum diisi.');
    settings = { urls: [], token: mock.TOKEN };
    await assert.rejects(api.status(), (e) => e.kind === 'config');
    settings = { urls: [base], token: '' };
    await assert.rejects(api.status(), (e) => e.kind === 'config');

    // URL cadangan dipakai bila URL utama tidak terjangkau
    settings = { urls: ['http://127.0.0.1:1', base], token: mock.TOKEN };
    const viaBackup = await api.status();
    assert.equal(viaBackup.devices.length, 2);
    assert.equal(viaBackup.base, L.normalizeBaseUrl(base));
    // Semua URL mati -> kesalahan jaringan
    settings = { urls: ['http://127.0.0.1:1'], token: mock.TOKEN };
    await assert.rejects(api.status(), (e) => e.kind === 'network');

    // Tiga URL: URL yang terakhir berhasil dicoba lebih dulu, dan URL ganda dibuang
    const calls = [];
    const spyApi = L.createApi({
      getSettings: () => settings,
      transport: (req) => { calls.push(req.url.split('/cgi-bin')[0]); return L.fetchTransport(req); }
    });
    settings = { urls: ['http://127.0.0.1:1', 'http://127.0.0.1:2', base], token: mock.TOKEN };
    await spyApi.status();
    assert.deepEqual(calls, ['http://127.0.0.1:1', 'http://127.0.0.1:2', base]);   // pertama kali: urutan pengaturan
    calls.length = 0;
    await spyApi.status();
    assert.deepEqual(calls, [base]);                                               // berikutnya: langsung URL yang tadi berhasil
    calls.length = 0;
    settings = { urls: [base, base, 'http://127.0.0.1:1'], token: mock.TOKEN };
    await spyApi.status();
    assert.deepEqual(calls, [base]);                                               // ganda dibuang
    // URL yang tadi berhasil mati -> jatuh ke URL lain
    calls.length = 0;
    settings = { urls: ['http://127.0.0.1:1', base], token: mock.TOKEN };
    server.close();
    await assert.rejects(spyApi.status(), (e) => e.kind === 'network');
    assert.deepEqual(calls, [base, 'http://127.0.0.1:1']);
  } finally {
    server.close();
  }
});

test('pemakaian RAM dari detail.ram', () => {
  const r = L.ramUsage({ total_kb: 3826256, available_kb: 1501140 });
  assert.equal(r.pct, 61);
  assert.equal(r.usedKb, 3826256 - 1501140);
  assert.equal(r.freeKb, 1501140);
  assert.equal(L.ramUsage(null), null);
  assert.equal(L.ramUsage({ total_kb: 0, available_kb: 10 }), null);
  assert.equal(L.ramUsage({ total_kb: 1000, available_kb: 'x' }), null);
  assert.equal(L.ramUsage({ total_kb: 1000, available_kb: 2000 }).pct, 0);
});

test('liveStep: CPU, jaringan, RAM dari counter mentah', () => {
  const st = L.createLiveState();
  const mk = (up, total, idle, rx, tx) => ({ up, cpu: { total, idle }, ram: { total_kb: 4000000, available_kb: 1000000 },
    net: { rx, tx }, ping_ms: 3, battery: { level: 50 }, current: {} });
  const a = L.liveStep(st, mk(100, 1000, 800, 0, 0));
  assert.equal(a.cpu, null); // sampel pertama belum bisa dihitung
  assert.equal(a.rx, null);
  assert.equal(a.ram.pct, 75);
  const b = L.liveStep(st, mk(102, 1200, 900, 200000, 20000));
  assert.equal(b.cpu, 50);   // dT=200, dI=100
  assert.equal(b.rx, 100000); // 200000 B / 2 dtk (uptime HP)
  assert.equal(b.tx, 10000);
  // HP reboot: uptime & counter mundur -> null, bukan angka negatif
  const c = L.liveStep(st, mk(5, 50, 40, 10, 10));
  assert.equal(c.cpu, null); assert.equal(c.rx, null);
  // selisih uptime terlalu besar (>30 dtk) tidak dipakai
  const d = L.liveStep(st, mk(100, 500, 400, 5000, 5000));
  assert.equal(d.cpu, null);
});

test('liveStep: arus dari sysfs, perkiraan charge counter, lalu cache', () => {
  const st = L.createLiveState();
  const mk = (up, cc, ma, cache) => ({ up, cpu: { total: up, idle: 0 }, battery: { charge_counter_uah: cc },
    current: { ma: ma === undefined ? null : ma, cache_ma: cache === undefined ? null : cache, cache_source: 'estimate' } });
  assert.deepEqual(L.liveStep(st, mk(100, 2000000)).current, null); // belum ada dasar
  assert.deepEqual(L.liveStep(st, mk(102, 2000000, undefined, 900)).current, { ma: 900, source: 'estimate' }); // cache
  const e = L.liveStep(st, mk(112, 2000800)).current; // 800 uAh dalam 12 dtk
  assert.equal(e.source, 'estimate'); assert.equal(Math.round(e.ma), 240);
  assert.equal(Math.round(L.liveStep(st, mk(114, 2000800)).current.ma), 240); // dipertahankan sampai counter berubah
  assert.equal(L.liveStep(st, mk(400, 2000800, undefined, 900)).current.ma, 900); // basi >180 dtk -> cache
  assert.deepEqual(L.liveStep(st, mk(402, 2000800, -300)).current, { ma: -300, source: 'sysfs' }); // sysfs menang
  // selisih counter < 1 mA tidak ditampilkan sebagai 0
  const s2 = L.createLiveState();
  L.liveStep(s2, mk(100, 1000000)); 
  assert.equal(L.liveStep(s2, mk(200, 1000001)).current, null);
});

test('loadLevel dan api.live ke mock server', async () => {
  assert.equal(L.loadLevel(10), 'ok'); assert.equal(L.loadLevel(60), 'warm');
  assert.equal(L.loadLevel(85), 'hot'); assert.equal(L.loadLevel(null), '');
  const { server, port, state } = await mock.start(0);
  const base = 'http://127.0.0.1:' + port;
  try {
    const api = L.createApi({ getSettings: () => ({ urls: [base], token: mock.TOKEN }), transport: L.fetchTransport });
    const r = await api.live('192.168.7.177', true);
    assert.equal(r.ok, true); assert.equal(r.slow.foreground.label, 'WhatsApp');
    const r2 = await api.live('192.168.7.177', false);
    assert.equal(r2.slow, null);
    state.liveBusy = true;
    await assert.rejects(api.live('192.168.7.177'), (e) => e.code === 'busy' && e.status === 429);
    state.liveBusy = false; state.liveTimeout = true;
    await assert.rejects(api.live('192.168.7.177'), (e) => e.code === 'adb_timeout' && /tidak merespons/.test(L.errorMessage(e)));
    await assert.rejects(api.live('1.2.3.4'), (e) => e.code === 'not_found');
  } finally { server.close(); }
});
