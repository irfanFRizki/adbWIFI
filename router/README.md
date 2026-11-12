# Sisi router (OpenWrt)

Folder ini berisi skrip layanan **hpmon** yang berjalan di router (Raspberry Pi 4, OpenWrt).

| Berkas di repo | Lokasi di router | Fungsi |
|----------------|------------------|--------|
| `hpmon-cgi-index.sh` | `/www/cgi-bin/hpmon/index.sh` | API (CGI) — lihat [`docs/API.md`](../docs/API.md) |
| `hpmon-daemon-v2.sh` | `/root/hpmon/hpmon-daemon-v2.sh` | Daemon: ping + ADB tiap target, menulis `/tmp/hpmon_cache.json` tiap ±60 detik |
| `hpmon-watchdog.sh` | `/root/hpmon/hpmon-watchdog.sh` | Dijalankan cron tiap 5 menit; memulai ulang layanan bila cache basi atau CGI/uhttpd 8091/cloudflared tidak membalas |
| `hpmon.initd` | `/etc/init.d/hpmon` | Service procd untuk daemon (auto-start, respawn) |
| `hpmon-uhttpd.initd` | `/etc/init.d/hpmon-uhttpd` | Instance uhttpd khusus hpmon di port 8091 (auto-start, respawn) |
| `targets.example.json` | `/etc/hpmon/targets.json` | Daftar target (contoh, ganti dengan IP LAN asli) |
| `app-labels.example.json` | `/etc/hpmon/app-labels.json` | Pemetaan package → label untuk `foreground_app` |

## Catatan

- **Port 8091:** uhttpd dedicated untuk hpmon berjalan di port 8091 (terpisah dari uhttpd 8079-8087), tanpa LuCI/ubus. Bind ke IP LAN router, `127.0.0.1`, dan IP Tailscale (bukan `0.0.0.0`). Instance `hpmon-uhttpd` melayani root `www-public` yang hanya berisi symlink ke CGI hpmon.
- **Hostname:** field `hostname` (string|null) per device di `/status` diperbarui tiap siklus, urutan sumber: (1) static lease UCI `dhcp.@host[*].name`, (2) host/domain record UCI `dhcp.@domain[*]` dan `/etc/hosts`, (3) hostname di `/tmp/dhcp.leases`, selain itu `null`. Field `nama` lama tidak diubah.
- **Data baterai & aplikasi aktif:** objek `adb` menambah `charging`, `charge_source`, `temp_c`, `voltage_mv`, `current_ma`/`current_available`, `avg_drain_pct_per_hour`; detail (`?detail=1`) menambah `foreground_app {package, label}`. Data tak tersedia = `null`.
- **`current_ma` di HP Android 10+:** `/sys/class/power_supply/battery/current_now` sering `Permission denied` lewat ADB shell (SELinux membatasi domain shell, bukan sekadar mode file — lihat CHANGELOG v0.7.0). Daemon otomatis fallback ke `helper-app` (lihat [`../helper-app/README.md`](../helper-app/README.md)) bila APK kecil itu sudah di-`adb install` di HP yang dipantau; kalau belum, perilakunya sama seperti sebelumnya (`null`/`false`).
- **Watchdog:** `hpmon-watchdog.sh` memeriksa CGI, instance uhttpd hpmon (8091), dan proses cloudflared; memulai ulang komponen yang tidak merespons.

## Setup instance uhttpd 8091 (tanpa rahasia)

1. Buat root publik khusus hpmon dan symlink CGI saja:
   ```sh
   mkdir -p /root/hpmon/www-public/cgi-bin
   ln -s /www/cgi-bin/hpmon /root/hpmon/www-public/cgi-bin/hpmon
   ```
2. Salin `hpmon-uhttpd.initd` ke `/etc/init.d/hpmon-uhttpd`, sesuaikan bind address (LAN, loopback, Tailscale) bila perlu, lalu:
   ```sh
   chmod +x /etc/init.d/hpmon-uhttpd
   /etc/init.d/hpmon-uhttpd enable
   /etc/init.d/hpmon-uhttpd start
   ```

## Contoh ingress Cloudflare (placeholder)

Tambahkan public hostname di Cloudflare Zero Trust (Tunnels → *tunnel-anda* → Public hostnames) atau di config lokal bila memakai mode file:

```yaml
ingress:
  - hostname: hpmon.example.com
    service: http://127.0.0.1:8091
  - service: http_status:404
```

Token API disimpan di `/etc/hpmon/token` (mode 600) dan **tidak boleh** dimasukkan ke repo. Jangan menaruh ID/kredensial tunnel Cloudflare di repo.

Persyaratan: `adb`, `jq`, `curl`, `uhttpd` dengan dukungan CGI, dan `cron`. Firewall zona WAN tetap menolak (REJECT) akses masuk.