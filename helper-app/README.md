# adbwifi-helper

APK kecil **tanpa UI, tanpa izin khusus**, yang di-install sekali di tiap **HP yang
dipantau** (bukan di HP kontroler tempat APK adbWIFI utama berjalan).

## Kenapa ini perlu

`/sys/class/power_supply/battery/current_now` (sumber `adb.current_ma` di API) sering
ditolak dengan `Permission denied` lewat `adb shell` di Android 10 ke atas, meskipun mode
filenya `-r--r--r--` (bisa dibaca dunia) — pembatasannya dari kebijakan SELinux terhadap
domain `shell`, bukan izin POSIX biasa. Tidak ada cara aman menembus ini lewat `adb shell`
tanpa root.

Aplikasi Android biasa (bukan proses `shell`) bisa membaca nilai yang sama lewat API resmi
`BatteryManager.getIntProperty(BATTERY_PROPERTY_CURRENT_NOW)` — ini yang dipakai aplikasi
seperti AccuBattery. Helper ini hanya membungkus pemanggilan API itu supaya hasilnya bisa
diambil balik lewat ADB.

## Cara kerja

1. `CurrentReceiver` — satu-satunya komponen di APK ini — menunggu broadcast eksplisit:
   ```
   com.irfanfrizki.adbwifihelper.READ_CURRENT
   ```
2. Saat dipicu, baca `BATTERY_PROPERTY_CURRENT_NOW`/`_AVERAGE` (µA), tulis ke
   `getExternalFilesDir()/current.json` — path app-specific, **tidak butuh**
   `WRITE_EXTERNAL_STORAGE`, dan tetap bisa dibaca `adb shell cat` biasa karena shell
   sudah punya grup `sdcard_rw`.
3. Backend (`hpmon-daemon-v2.sh`) memicu lewat:
   ```sh
   adb -s <addr> shell am broadcast -n com.irfanfrizki.adbwifihelper/.CurrentReceiver \
     -a com.irfanfrizki.adbwifihelper.READ_CURRENT
   ```
   lalu setelah jeda singkat, baca:
   ```sh
   adb -s <addr> shell cat /sdcard/Android/data/com.irfanfrizki.adbwifihelper/files/current.json
   ```
   Ini hanya dipanggil sebagai **fallback** — kalau `current_now` sysfs berhasil dibaca,
   helper ini tidak pernah dipanggil sama sekali.

Helper ini **tidak membaca/mengirim data apa pun lewat jaringan**; hanya menulis satu file
JSON kecil lokal di HP itu sendiri, dibaca lewat ADB yang memang sudah terhubung ke HP
tersebut untuk kebutuhan monitoring proyek ini.

## Pemasangan (sekali per HP yang dipantau)

```sh
adb -s <ip>:5555 install -r adbwifi-helper.apk
```

APK diambil dari artifact/release CI (`adbwifi-helper-apk` / `adbwifi-helper.apk` pada tag
`v*`), sama seperti APK utama.

Setelah terpasang, tidak perlu dibuka manual (tidak ada ikon launcher — ini memang
disengaja, lihat `AndroidManifest.xml`). Backend otomatis memakainya sebagai fallback pada
siklus polling berikutnya, tanpa konfigurasi tambahan.

Kalau belum di-install di suatu HP, perilaku `current_ma` tetap sama seperti sebelum fitur
ini ada (`null`/`current_available:false` bila sysfs ditolak) — aman dipasang bertahap, satu
HP dulu untuk diuji.

## Lokasi dan pemakaian hari ini (v0.10.0+)

Dua komponen tambahan, dipakai fitur "Lokasi" dan "Pemakaian hari ini" di aplikasi utama:

- **`LocationReceiver` + `LocationFetchService`** — dipicu lewat broadcast
  `READ_LOCATION`. Menampilkan **notifikasi** "adbWIFI: mengambil lokasi..." selama proses
  (tidak diam-diam), minta satu titik lokasi (GPS kalau menyala, kalau tidak lewat
  jaringan), tulis ke `location.json`, lalu berhenti sendiri — **tidak melacak lokasi terus-
  menerus**, hanya saat diminta dari aplikasi kontroler.
- **`UsageReceiver`** — dipicu lewat broadcast `READ_USAGE`. Query lokal cepat (riwayat
  pemakaian hari ini), tulis ke `usage.json`.

Keduanya butuh izin yang **tidak bisa muncul lewat dialog biasa** (tidak ada Activity di APK
ini). Diberikan sekali per HP lewat ADB, **tanpa perlu menyentuh HP-nya sama sekali**:

```sh
adb -s <ip>:5555 shell pm grant com.irfanfrizki.adbwifihelper android.permission.ACCESS_FINE_LOCATION
adb -s <ip>:5555 shell appops set com.irfanfrizki.adbwifihelper GET_USAGE_STATS allow
```

Tanpa langkah ini: `/location` menjawab `403 location_permission_denied`, `/usage` menjawab
`403 usage_access_denied` — pesan jelas, bukan diam-diam gagal.

Catatan:
- Lokasi **on-demand saja**, sesuai desain — tidak butuh izin lokasi latar
  (`ACCESS_BACKGROUND_LOCATION`), hanya izin lokasi biasa di atas.
- Waktu layar menyala (`screen_on_ms` di `/usage`) hanya tersedia di Android 9 ke atas (API
  event yang dipakai belum ada di versi lebih lama) — di SM-P355 (Android 7.1.1) akan
  tampil `null`. Daftar 5 aplikasi teratas tetap berjalan di semua versi.
- Transparansi lokasi dan pemakaian: siapa pun yang memegang HP ini akan melihat notifikasi
  singkat tiap kali lokasi diminta. Tidak ada pelacakan tersembunyi di belakangnya.

## Build lokal (opsional)

Proyek Gradle native biasa (bukan Capacitor), dibangun otomatis di CI (job `build-helper`
pada `.github/workflows/build-apk.yml`). Untuk build manual perlu Android SDK terpasang:

```sh
cd helper-app
gradle assembleRelease
# hasil: app/build/outputs/apk/release/app-release.apk
```
