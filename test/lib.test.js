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
  } finally {
    server.close();
  }
});
