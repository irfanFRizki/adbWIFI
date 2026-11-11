# Changelog

## [0.4.1] - 2026-11-11

Perbaikan tampilan Midnight Pro 2.0 (v0.4.0 belum pernah ditandai/dirilis; rilis berikutnya adalah v0.4.1).

### Fixed
- Ikon tampil sebagai bentuk hitam solid / tak terlihat: sprite SVG berupa garis outline tetapi CSS tidak punya aturan `fill`/`stroke`. Ditambah aturan `use { fill: none; stroke: currentColor }`.
- Konten terdorong ±260px ke kanan dan terpotong di layar HP: grid `.app-shell` tetap menyisakan kolom sidebar padahal sidebar sudah overlay. Di layar ≤1024px grid kini satu kolom; saat sidebar desktop diciutkan, kolom ikut menyempit.
- Ikon kartu statistik berukuran 300×150 menutupi kartu dan warnanya menyatu dengan latar: diberi ukuran 22px dan ubin berwarna (biru, hijau, merah, cyan).
- Badge "ADB connected" tanpa gaya (`badge-info` dipakai JS tetapi tidak ada di CSS) dan menjorok keluar kartu perangkat.
- Kotak pencarian mengerut di layar HP (`flex: 1` pada kolom).
- Grid konten (`1fr`) melebar mengikuti teks `nowrap` sehingga kartu meluber; diganti `minmax(0, 1fr)`.
- Variabel CSS `--muted` tidak terdefinisi (sekarang `--text-muted`).

### Added
- `test/ui-css.test.js`: tes pengaman (tanpa browser) agar variabel CSS tak terdefinisi, aturan stroke ikon, layout satu kolom di HP, kelas badge tanpa gaya, dan grid `1fr` polos tertangkap di CI.

### Changed
- `npm test` kini menjalankan `test/lib.test.js` dan `test/ui-css.test.js`.
- Versi `package.json`/`package-lock.json` menjadi 0.4.1. Nomor versi di APK hanya disuntikkan CI untuk push tag `v*` (build dari `main` bertanda `0.0.<nomor run>`).

## [0.4.0] - 2026-11-11

### Added
- Midnight Pro 2.0 dark dashboard with responsive navigation and summary cards.
- Device list/detail views, search and status filters, app listing, session activity logs, and settings/about screens.
- Clearer stale-data indication, loading/error messages, and live device detail retrieval through the existing API.

### Changed
- Updated frontend version metadata and package metadata to 0.4.0.
- Redesigned app shell, forms, cards, status badges, and responsive layouts.

### Security and compatibility
- Existing hpmon API contract and Bearer authentication remain in use; no new backend endpoint or public ADB exposure was added.
- Bearer credentials remain stored via the existing Preferences/local storage mechanism and are not repopulated into the settings form; an empty password field preserves the saved token.
- APK build, real Android hardware ADB, and release pipeline remain to be verified before tagging.
