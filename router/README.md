# Sisi router (OpenWrt)

Folder ini disediakan untuk skrip layanan **hpmon** yang berjalan di router (Raspberry Pi 4, OpenWrt). Skrip belum ditambahkan ke repo; saat ditambahkan, susunannya sebagai berikut.

| Berkas di repo | Lokasi di router | Fungsi |
|----------------|------------------|--------|
| `hpmon-cgi-index.sh` | `/www/cgi-bin/hpmon/index.sh` | API (CGI) — lihat [`docs/API.md`](../docs/API.md) |
| `hpmon-daemon-v2.sh` | `/root/hpmon/hpmon-daemon-v2.sh` | Daemon: ping + ADB tiap target, menulis `/tmp/hpmon_cache.json` tiap ±60 detik |
| `hpmon-watchdog.sh` | `/root/hpmon/hpmon-watchdog.sh` | Dijalankan cron tiap 5 menit; memulai ulang layanan bila cache basi atau CGI tidak membalas |
| `hpmon.initd` | `/etc/init.d/hpmon` | Service procd (auto-start, respawn) |
| `targets.example.json` | `/etc/hpmon/targets.json` | Daftar target (contoh) |

Token API disimpan di `/etc/hpmon/token` (mode 600) dan **tidak boleh** dimasukkan ke repo.

Persyaratan: `adb`, `jq`, `curl`, `uhttpd` dengan dukungan CGI, dan `cron`. Firewall zona WAN tetap menolak (REJECT) akses masuk.
