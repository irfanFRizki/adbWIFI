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

## Build lokal (opsional)

Proyek Gradle native biasa (bukan Capacitor), dibangun otomatis di CI (job `build-helper`
pada `.github/workflows/build-apk.yml`). Untuk build manual perlu Android SDK terpasang:

```sh
cd helper-app
gradle assembleRelease
# hasil: app/build/outputs/apk/release/app-release.apk
```
