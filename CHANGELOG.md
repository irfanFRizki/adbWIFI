# Changelog

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
