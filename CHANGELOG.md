# Changelog

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
