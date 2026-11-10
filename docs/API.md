# API hpmon

API ini disajikan router OpenWrt lewat uhttpd CGI. Semua contoh memakai `<TOKEN>` sebagai pengganti token asli. Jangan menulis token asli di repo.

Seluruh endpoint di bawah sudah diuji dengan `curl` di router.

## Dasar

- URL dasar: `http://<IP-ROUTER>/cgi-bin/hpmon/index.sh` (HTTP biasa, port 80).
- Header wajib di setiap request: `Authorization: Bearer <TOKEN>`.
- Body POST: JSON dengan `Content-Type: application/json`.
- Semua respons berformat JSON. Kesalahan berbentuk `{"error":"<kode>"}` dengan kode status HTTP yang sesuai.
- Cache data di router diperbarui sekitar tiap **60 detik**.

## Endpoint

### `GET /status`
Semua target (dari cache).

```json
{
  "timestamp": 1794271037,
  "devices": [
    {
      "ip": "192.168.7.177", "nama": "HP-177", "port_adb": 5555,
      "router": { "online": true, "latency": "146.039 ms", "mac": "20:34:fb:d3:f7:ca", "connections": 14 },
      "adb": { "status": "connected", "port_terdeteksi": 5555, "battery": "68", "model": "Redmi Note 7",
               "android": "10", "screen": "Asleep", "uptime": 248518, "wifi_ssid": "IRFAN", "wifi_rssi": -30 },
      "rx_bytes": 4014889816, "tx_bytes": 1059967337, "rxtx_source": "adb", "rxtx_ts": 1794271108, "rxtx_available": true
    },
    {
      "ip": "192.168.7.245", "nama": "HP-245", "port_adb": 5555,
      "router": { "online": false, "latency": "", "mac": "9e:e8:9b:00:86:e2", "connections": 36 },
      "adb": { "status": "unreachable", "error": "connection refused or timeout" },
      "rx_bytes": null, "tx_bytes": null, "rxtx_source": null, "rxtx_ts": null, "rxtx_available": false
    }
  ]
}
```

### `GET /status?ip=<ip>`
Satu target dari cache (objek yang sama dengan elemen `devices`). IP yang tidak terdaftar → `404 {"error":"not_found","ip":"..."}`.

### `GET /status?ip=<ip>&detail=1`
Seperti di atas, ditambah objek `detail` yang diambil **langsung dari HP lewat ADB** (bukan dari cache; ±8 detik).

```json
{ "...": "...", "detail": {
    "apps": ["com.example.app"],
    "ram": { "total_kb": 3826256, "available_kb": 1501140 },
    "cpu_percent": 38.2 } }
```

- `detail` bernilai `null` bila ADB target tidak terhubung.
- `detail=1` tanpa `ip` → `400 {"error":"detail_requires_ip"}`.

### `GET /targets`
Daftar konfigurasi target.

```json
[ { "ip": "192.168.7.177", "nama": "HP-177", "port_adb": 5555 } ]
```

### `POST /targets/add`
Menambah target. Body: `{"ip":"192.168.7.188","nama":"HP-188","port_adb":5555}`. Berhasil → `{"ok":true}`.

- `400` → `invalid_json`, `invalid_ip`, `invalid_port`
- `409` → `ip_duplicate`

### `POST /targets/delete`
Menghapus target. Body: `{"ip":"192.168.7.188"}`. Berhasil → `{"ok":true}`.

- `400` → `invalid_json`, `invalid_ip`
- `404` → `not_found`

## Kode status

| Kode | Arti |
|------|------|
| 200 | Berhasil |
| 400 | Body atau parameter tidak valid |
| 401 | Token kosong atau salah (`unauthorized`) |
| 404 | Endpoint atau IP tidak dikenal (`not_found`) |
| 405 | Metode HTTP salah (`method_not_allowed`) |
| 409 | IP sudah terdaftar (`ip_duplicate`) |

## Skema data

| Field | Tipe | Null | Keterangan |
|-------|------|------|------------|
| `timestamp` | integer | tidak | Epoch detik saat cache dibuat |
| `ip`, `nama` | string | tidak | Alamat IPv4 dan label target |
| `port_adb` | integer | tidak | Port ADB yang tersimpan |
| `router.online` | boolean | tidak | Hasil ping dari router |
| `router.latency` | string | tidak | Mis. `"146.039 ms"`; `""` bila offline |
| `router.mac` | string | tidak | MAC dari tabel ARP router (HP dengan MAC privat acak bisa berubah-ubah) |
| `router.connections` | integer | tidak | Jumlah sesi conntrack; **hanya bermakna jika `online` = true** (sisa sesi lama bisa tertinggal saat HP mati) |
| `adb.status` | string | tidak | `"connected"` atau `"unreachable"` |
| `adb.error` | string | ya | Ada saat `unreachable` |
| `adb.port_terdeteksi` | integer | ya | Port ADB yang sedang terhubung |
| `adb.battery` | string | ya | Persen baterai, mis. `"68"` |
| `adb.model`, `adb.android`, `adb.screen` | string | ya | Model, versi Android, `"Awake"` / `"Asleep"` |
| `adb.uptime` | integer | ya | Detik sejak HP boot |
| `adb.wifi_ssid` | string | ya | SSID yang tersambung |
| `adb.wifi_rssi` | integer | ya | Sinyal dalam dBm (negatif) |
| `rx_bytes`, `tx_bytes` | integer | ya | Byte **kumulatif sejak HP boot** (wlan0 HP, via ADB), bukan laju |
| `rxtx_source` | string | ya | `"adb"` atau `null` |
| `rxtx_ts` | integer | ya | Epoch detik saat rx/tx diambil |
| `rxtx_available` | boolean | tidak | `true` bila `rx_bytes`/`tx_bytes` terisi |
| `detail.apps` | string[] | tidak | Nama paket aplikasi pihak ketiga |
| `detail.ram.total_kb`, `available_kb` | integer | tidak | RAM HP dalam KB |
| `detail.cpu_percent` | number | ya | Pemakaian CPU, selisih sampel 1 detik |

Kecepatan unduh/unggah dihitung klien dari selisih dua sampel `rx_bytes`/`tx_bytes` yang `rxtx_ts`-nya berbeda; bila counter turun (HP reboot), hasilnya dibuang.

## Saran untuk klien

- Polling `GET /status` tiap 30–60 detik. Timeout 15 detik untuk `/status`, 20 detik untuk `?detail=1`.
- Jangan menganggap sub-field `adb.*` ada saat `adb.status` bukan `connected`.
- API memakai HTTP biasa, jadi aplikasi Android perlu mengizinkan *cleartext traffic*.
