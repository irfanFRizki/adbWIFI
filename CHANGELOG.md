# Changelog

## v0.8.0

- UI: beranda diganti jadi **"Fokus Satu HP"** dan seluruh aplikasi memakai tema gelap.
  Satu HP tampil penuh (cincin baterai, model, status mengisi, layar, WiFi, latensi),
  HP lain dipilih lewat chip di atas (titik hijau = online + ADB, kuning = online tanpa
  ADB, abu = offline; pilihan terakhir diingat). Enam petak metrik: suhu, tegangan, arus,
  sisa waktu, RAM, CPU; di bawahnya kecepatan dan total trafik, aplikasi aktif, dan
  tombol ke lembar detail (screenshot, optimasi, daftar aplikasi, hapus target) yang tidak berubah.
- Tombol **Segarkan HP ini** (POST /refresh untuk IP terpilih, lalu RAM/CPU dari
  `/status?detail=1`) dan toggle **Auto N dtk** (menyala/mati, diingat; interval tetap dari
  Pengaturan). RAM/CPU hanya diambil untuk HP terpilih (saat dipilih, saat pertama
  terhubung, dan saat tombol ditekan) karena butuh ±8 dtk lewat ADB.
- Animasi CSS: kartu masuk bertahap, cincin baterai terisi, titik status berdenyut, ikon
  refresh berputar saat memuat. Animasi masuk hanya dimainkan saat HP dipilih/pertama
  kali tampil (tidak diulang tiap polling) dan dimatikan oleh `prefers-reduced-motion`.
- `HPLib.ramUsage()` (+ tes) menghitung pemakaian RAM dari `detail.ram`.
- Fix kecil: interval 10 detik di Pengaturan sekarang ikut tersimpan saat aplikasi dibuka ulang.

## v0.7.0

- Fitur: **arus baterai (`current_ma`) untuk HP Android 10+ yang sysfs-nya diblokir**.
  `/sys/class/power_supply/battery/current_now` sering `Permission denied` lewat `adb shell`
  di Android 10+ (dikonfirmasi lewat audit: Redmi Note 7/Android 10 ditolak, Samsung
  SM-P355/Android 7.1.1 bisa dibaca) — ternyata ini kebijakan SELinux terhadap domain
  `shell`, bukan izin file POSIX (file tetap `-r--r--r--` di kedua perangkat), jadi tidak
  ada cara aman menembusnya lewat ADB shell biasa tanpa root.
- Ditambahkan `helper-app/` — APK terpisah, kecil, tanpa UI dan tanpa izin khusus, yang
  di-install manual sekali per HP **yang dipantau** (bukan HP kontroler). Satu-satunya
  komponennya adalah `BroadcastReceiver` yang membaca
  `BatteryManager.getIntProperty(BATTERY_PROPERTY_CURRENT_NOW/_AVERAGE)` — API resmi yang
  dipakai aplikasi seperti AccuBattery, berjalan sebagai proses aplikasi biasa sehingga
  tidak terkena pembatasan SELinux yang sama dengan proses `shell` — lalu menulis hasilnya
  ke `getExternalFilesDir()/current.json` (tidak butuh `WRITE_EXTERNAL_STORAGE`, tetap bisa
  dibaca `adb shell cat` karena shell sudah di grup `sdcard_rw`).
- `hpmon-daemon-v2.sh`: bila baca `current_now` sysfs gagal, coba fallback memicu helper
  lewat `adb shell am broadcast -n <pkg>/.CurrentReceiver -a <pkg>.READ_CURRENT`, tunggu
  sebentar, lalu baca file hasilnya. Aman untuk HP yang belum pasang helper-nya: broadcast
  tanpa receiver cocok = no-op, file tidak ada, `current_ma` tetap `null` seperti sebelum
  fitur ini ada — jadi bisa dipasang bertahap, satu HP dulu untuk diuji.
- CI: job baru `build-helper` di `build-apk.yml` membangun `helper-app/` (proyek Gradle
  native, bukan Capacitor) jadi `adbwifi-helper.apk`, diunggah sebagai artifact dan
  dilampirkan ke GitHub Release saat tag `v*` — terpisah dari APK utama karena memang APK
  yang berbeda, dipasang di perangkat yang berbeda.
- Fix UI: label "mengisi"/"dipakai" di sebelah nilai Arus sekarang mengikuti status
  `charging` (dari `dumpsys battery`, independen dan sudah terbukti andal), bukan tanda
  (+/-) `current_ma`. Dipicu oleh temuan nyata: pada satu HP (Redmi Note 7, diuji lewat
  Termux:API sebagai pembanding independen di luar helper-app ini) arus tercatat **positif
  saat discharging dan negatif saat charging** — kebalikan dari konvensi yang sebelumnya
  diasumsikan di kode ini (dan juga kebalikan dari dokumentasi resmi `BatteryManager`).
  Konvensi tanda ternyata tidak seragam antar vendor/perangkat, jadi UI tidak lagi
  menebak arah dari tanda angka mentahnya — nilai mentah (dengan tanda apa adanya) tetap
  ditampilkan untuk transparansi, tapi label kata-kata tidak lagi bergantung padanya.

## v0.6.2

- Fix: `/screenshot` gagal diam-diam (HTTP 200, body kosong 1 byte) untuk HP dengan
  screenshot besar (layar aktif, resolusi tinggi — reproduksi nyata di Redmi Note 7
  1080x2340). Penyebab: `jq -n --arg b64 "$B64" ...` dieksekusi lewat `execve()`, dan
  Linux membatasi satu argumen command-line maksimal 128KB (`MAX_ARG_STRLEN`, terpisah
  dari `ARG_MAX` total) — base64 PNG yang lebih besar dari itu membuat `jq` gagal exec
  dengan "Argument list too long" (exit 126), tapi exit code ini tidak pernah dicek
  sebelumnya, jadi `BODY` tetap string kosong dan `STATUS` tetap default "200 OK".
  Diverifikasi dengan reproduksi payload 400KB: pendekatan lama gagal exit 126 persis
  seperti ini; pendekatan baru (konkatenasi string shell, tanpa exec) menghasilkan
  JSON valid. Fix: rakit JSON lewat konkatenasi shell langsung, bukan `jq --arg` —
  base64 hanya berisi karakter yang aman dipakai langsung dalam string JSON tanpa
  escaping (A-Z/a-z/0-9/+//=), jadi aman tanpa jq sama sekali untuk bagian ini.

## v0.6.1

- Fix: `/optimize` mengembalikan `top_apps` kosong karena `dumpsys meminfo` penuh
  terukur butuh ~7.7 detik secara alami di salah satu HP (Samsung SM-P355), melebihi
  budget 6 detik `adb_t()` yang dipakai bersama endpoint lain — output dibunuh
  sebelum sempat ditulis utuh. Ditambahkan `adb_t_opt()` dengan budget kustom
  (20 detik) khusus untuk panggilan ini, tidak mengubah `adb_t()`/`ADB_T=6` yang
  dipakai endpoint lain. Timeout klien `api.optimize()` dinaikkan dari 20 ke 40 detik
  mengikuti budget server yang baru.
- Dikonfirmasi lewat pengujian langsung di Pi: `dumpsys meminfo` HP_TAB selesai alami
  dalam 7,733 detik (255 baris, 10.450 byte), baris "Total PSS by process:" ada di
  baris ke-4 — bukti bahwa isinya valid, hanya soal waktu tempuh.

## v0.6.0

- Fitur **Screenshot**: tombol di layar detail perangkat mengambil tangkapan layar HP lewat
  `adb exec-out screencap -p` (endpoint baru `GET /screenshot?ip=`). Ditunda manual (bukan
  otomatis) karena salah satu unit (Redmi Note 7) terukur ~89 detik; timeout APK digenerosikan
  ke 130 detik dan timeout router ke 120 detik. Hasil dikirim sebagai PNG base64 dalam JSON
  (bukan biner mentah) supaya lewat jalur transport yang sama dengan request lain.
- Fitur **Optimasi**: tombol "Cek performa" menampilkan RAM terpakai, CPU%, dan 5 proses
  pemakai RAM terbesar (endpoint baru `GET /optimize?ip=`). Parser menerima dua format
  `dumpsys meminfo` yang ditemukan saat audit ("Total PSS by process" dan "Total RSS by
  process" — yang kedua muncul di salah satu unit Redmi 8A).
- Kedua fitur diaktifkan untuk semua perangkat yang ADB-nya sudah tersambung — tidak ada
  toggle per-perangkat terpisah, sesuai keputusan pemilik bahwa pemasangan monitoring per HP
  sudah menjadi keputusan sadar sebelumnya.
- `router/hpmon-cgi-index.sh` di repo ini adalah referensi; deployment ke Pi yang sebenarnya
  tetap lewat proses terpisah (lihat catatan audit — status sinkronisasi skrip live di Pi
  belum terverifikasi penuh).

## v0.5.0

- Desain ulang tampilan (dashboard, kartu perangkat, lembar pengaturan/tambah/detail) ke gaya
  Material You: palet ungu terang, kartu membulat besar, badge status sebagai chip.
  Hanya `www/style.css` dan judul di `www/index.html` yang berubah — struktur HTML, ID elemen,
  dan seluruh logika di `www/app.js`/`www/lib.js` tetap sama seperti v0.3.1.
- Riwayat commit `main` dikembalikan ke titik sebelum redesign "Midnight Pro" (v0.4.0–v0.4.1)
  karena hasilnya dinilai tidak sesuai; v0.5.0 melanjutkan dari v0.3.1.
