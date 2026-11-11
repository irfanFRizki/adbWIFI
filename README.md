# adbWIFI — ADB WiFi Monitor

**Current version: 0.4.0 — Midnight Pro 2.0** (release preparation; not yet published)

See [CHANGELOG.md](CHANGELOG.md) for changes.

Aplikasi Android untuk memantau HP yang terhubung ke WiFi router **OpenWrt**. Router menjalankan layanan **hpmon** (ping, ARP, dan ADB ke tiap HP), lalu aplikasi membaca hasilnya lewat API HTTP/JSON.

```
[Aplikasi Android] --HTTP+JSON--> [uhttpd CGI di OpenWrt] --> adb shell / ping / ARP ke tiap HP
```

## Fitur

- Daftar HP yang dipantau: status online (ping dari router), status ADB, baterai, layar, model dan versi Android, WiFi (SSID dan kekuatan sinyal), latensi, lama hidup.
- Trafik tiap HP: total unduh/unggah sejak boot dan **kecepatan** (dihitung dari selisih dua sampel).
- Nama HP mengikuti **hostname di router** (static lease / Hostnames / DHCP).
- Ikon dan badge **charger** saat HP mengisi. Di layar detail (ketuk kartu): sumber charger, arus (bila dibaca Android), suhu, tegangan, rata-rata pemakaian baterai beserta perkiraan sisa waktu, dan aplikasi yang sedang aktif.
- Detail langsung dari HP (lewat ADB): pemakaian RAM, CPU, dan daftar aplikasi pihak ketiga (dengan pencarian).
- **Tambah dan hapus IP** yang dipantau langsung dari aplikasi.
- **Tiga URL**: LAN, Tailscale, dan Cloudflare (HTTPS, domain sendiri). Aplikasi memakai URL yang terakhir berhasil lebih dulu dan otomatis pindah bila tidak terjangkau.
- Banner peringatan bila router tidak terjangkau atau data di router berhenti diperbarui.

## Cara pakai

1. Pasang layanan hpmon di router (lihat [`router/`](router/README.md)) dan siapkan token API.
2. Unduh APK dari halaman [Releases](../../releases) (atau dari *Artifacts* di tab Actions), lalu pasang.
3. Buka aplikasi → **Pengaturan**: isi URL 1 (LAN, mis. `192.168.7.1:8091`), token API, dan (opsional) URL 2 Tailscale dan URL 3 Cloudflare. Tekan **Tes koneksi**, lalu **Simpan**.
4. Tekan **+** untuk menambah IP HP yang ingin dipantau.

### Mengaktifkan ADB di HP

- **Android 11+**: Opsi Pengembang → *Wireless Debugging* → aktif. Lakukan *pairing* sekali dari router (`adb pair IP:PORT_PAIRING`), lalu pakai **IP:port yang tampil di layar Wireless Debugging** (bukan port pairing) sebagai port ADB target. Port ini dapat berubah saat WiFi tersambung ulang.
- **Android 10 ke bawah**: sambungkan USB ke komputer sekali, jalankan `adb tcpip 5555`. Port 5555 hilang saat HP restart.

HP yang ADB-nya belum terhubung tetap tampil dengan data dari router (online, latensi, MAC); data baterai dan lainnya muncul setelah ADB tersambung.

## Membangun APK

APK dibuild otomatis oleh **GitHub Actions** (`.github/workflows/build-apk.yml`); tidak ada rahasia atau keystore yang perlu diatur manual.

- Push ke `main` → APK tersedia sebagai *artifact* workflow.
- Push tag `vX.Y.Z` (mis. `git tag v0.1.0 && git push --tags`) → APK dilampirkan ke **Release**, dan nomor versi diambil dari tag.

Folder `android/` dibuat ulang oleh CI di setiap build (`npx cap add android` + `scripts/patch-android.js`), jadi tidak di-commit.

## Pengembangan

```bash
npm install
npm test          # uji logika + klien API terhadap server tiruan (test/mock-server.js)
npm run check     # cek sintaks JS
```

Antarmuka ada di `www/` (HTML/CSS/JS biasa, tanpa framework). Logika murni berada di `www/lib.js` agar bisa diuji dengan Node. Dokumentasi API ada di [`docs/API.md`](docs/API.md).

## Keamanan

- API memakai **HTTP biasa** (tanpa TLS) dengan token Bearer, jadi token dan data tidak terenkripsi di jaringan. Pakai hanya di LAN tepercaya atau lewat Tailscale; jangan buka API ke internet.
- Token disimpan di penyimpanan privat aplikasi (Capacitor Preferences). Jangan menaruh token di repo, log, atau tangkapan layar.
- Firewall router harus tetap menolak akses dari WAN, dan port ADB tidak boleh terbuka ke internet.
- Keystore di `ci/adbwifi.keystore` bersifat **publik** (ada di repo) dan hanya dimaksudkan agar APK hasil CI memiliki tanda tangan yang konsisten untuk dipasang sendiri. Jangan dipakai untuk distribusi publik, misalnya Play Store.

## Lisensi

[MIT](LICENSE)
