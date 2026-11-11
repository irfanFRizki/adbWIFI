# adbWIFI — Midnight Pro 2.0 Design Specification

**Status:** Design specification / implementation baseline  
**Scope:** Full dashboard redesign  
**Branch:** `design/midnight-pro-2.0`  
**Visual direction:** Midnight Pro 2.0  
**Layout:** Responsive multi-page dashboard with collapsible sidebar  
**Important:** This document defines the intended UI/UX. It does not claim that implementation or QA has already been completed.

## 1. Goals

Redesign the complete adbWIFI web dashboard, not merely its colors. The redesign covers information architecture, navigation, page layouts, reusable components, responsive behavior, loading/error/empty states, and visual styling.

The redesign must preserve existing monitoring and connectivity behavior. Existing API contracts and Android/ADB workflows take priority over visual changes.

## 2. Non-goals and safety boundaries

- Do not expose Wireless ADB ports to the public internet.
- Do not move ADB pairing or device communication to Cloudflare.
- Do not replace or remove existing API endpoints without a documented compatibility plan and tests.
- Do not invent metrics or display sample values as live data.
- Do not add destructive device actions (uninstall, force-stop, reboot, etc.) unless the existing backend explicitly supports them and the action is separately reviewed.
- Do not store API tokens in URLs, logs, screenshots, or plain visible text.
- Do not silently remove LAN, Tailscale, Cloudflare URL configuration or automatic fallback behavior.

## 3. Design principles

1. **Clarity first:** status and actionable information must be immediately scannable.
2. **Consistent components:** cards, tables, badges, dialogs, fields, and buttons share one design system.
3. **Progressive detail:** dashboard summary first; deeper diagnostics on device detail pages.
4. **Responsive by default:** core tasks remain usable on desktop, tablet, and mobile.
5. **Honest telemetry:** unavailable, stale, or unsupported data is explicitly labeled.
6. **Accessible contrast:** text and status indicators must remain legible; never rely on color alone.

## 4. Visual design system

### 4.1 Palette

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#080D1C` | Main application background |
| `--surface` | `#111A30` | Cards and panels |
| `--surface-raised` | `#17233D` | Elevated panels, menus |
| `--primary` | `#1769FF` | Primary actions and active navigation |
| `--cyan` | `#22D3EE` | Data visualization and highlights |
| `--violet` | `#8B5CF6` | Secondary series and accents |
| `--success` | `#16C784` | Online / healthy |
| `--warning` | `#F5B942` | Warning / degraded |
| `--danger` | `#F05265` | Offline / error |
| `--text` | `#F4F7FF` | Primary text |
| `--muted` | `#9AA9C4` | Secondary text |
| `--border` | `#263451` | Dividers and card outlines |

Use subtle gradients sparingly. Glow effects are reserved for active or important states, not every card.

### 4.2 Typography and shape

- Preferred typeface: Inter, with system sans-serif fallback.
- Page title: 24–30 px desktop; 22–26 px mobile.
- Section title: 16–18 px.
- Body: 14–15 px; metadata: 12–13 px.
- Card radius: 12–16 px; controls: 8–10 px.
- Use consistent spacing based on a 4 px scale.
- Icons should use one consistent outline family and consistent stroke weight.

### 4.3 Status treatment

Every status includes text plus a visual marker:
- Online: green dot + “Online”.
- Offline: red dot + “Offline”.
- ADB connected: green/blue badge + “ADB Connected”.
- ADB error: amber/red badge + “ADB Error”.
- Connecting: blue animated indicator + “Connecting”.
- Stale data: muted badge + “Data lama”.
- Unavailable: neutral “N/A” or “Tidak tersedia”.

## 5. Information architecture

Primary navigation:
1. Dashboard
2. Perangkat
3. Aplikasi
4. Log Aktivitas
5. Pengaturan
6. Tentang

Desktop uses a collapsible left sidebar. Tablet uses a compact icon sidebar where practical. Mobile uses a drawer or compact navigation pattern with a clear active-page indicator.

Global header:
- Sidebar toggle
- Page title/breadcrumb
- Global search if supported by the available data
- Server/API connection indicator
- Last-updated timestamp
- Manual refresh
- User/profile area only if the current application has a real identity/session concept

Do not introduce fake user accounts or notification counts.

## 6. Page specifications

### 6.1 Dashboard

Purpose: give an at-a-glance view of monitoring health.

Summary cards (only when backed by actual API data):
- Total monitored devices
- Online devices
- Offline devices
- ADB-connected devices
- Traffic summary for a clearly labeled time range

Main content:
- Download/upload traffic chart with a time-range selector only if historical data exists.
- Active/recent device list with model/name, status, battery, temperature, Wi-Fi signal, and ADB state when available.
- Recent activity feed if event data exists.
- Server/system resource panel only if the backend provides those metrics.

Interactions:
- Clicking a summary card opens the device list with the corresponding filter.
- Clicking a device opens its detail page/modal.
- Refresh uses the existing refresh/data-fetch mechanism.
- Show the last successful update and stale-data warning.

### 6.2 Perangkat

Purpose: manage monitored device entries and inspect their current state.

Features:
- Search by supported fields (device name, IP, MAC, model).
- Filters for online/offline and ADB state.
- Sort by name, status, battery, or temperature where values exist.
- Add device using the existing add-device flow.
- Open details.
- Remove device with confirmation using the existing remove-device flow.

Suggested desktop columns:
- Device (name/model)
- IP address
- Online status
- ADB status
- Battery
- Temperature
- Wi-Fi signal
- Actions

On narrow screens, render compact device cards instead of forcing a wide table.

### 6.3 Detail Perangkat

Purpose: show diagnostics for one selected device.

Identity section:
- Device name/model
- Android version
- IP and MAC where available
- Online state and last-seen time
- ADB connection state
- Wi-Fi SSID/RSSI where available

Diagnostic sections/tabs:
- Ringkasan
- Sistem
- Jaringan
- Aplikasi
- Log

Metrics may include battery percentage, charging state, voltage, current, battery temperature, CPU, RAM, uptime, foreground app, latency, network rates/totals, and screen state—but only if the existing API supplies them. Unsupported fields must be omitted or shown as unavailable, never fabricated.

### 6.4 Aplikasi

Purpose: inspect installed applications returned by the existing service.

Features:
- Search and filter applications.
- Show app icon/name and package identifier.
- Show size/version only if available from the API.
- Separate user/system apps only if the source data identifies the category.
- App detail view for available metadata.

Do not add uninstall, force-stop, launch, or permission-management controls unless supported by existing backend capabilities and separately approved.

### 6.5 Log Aktivitas

Purpose: provide a readable event history.

Features:
- Search and filter by device, event type, and time where supported.
- Table/timeline with timestamp, device, event, and details.
- Pagination or incremental loading for large result sets.
- Clear empty and error states.

Do not fabricate events or claim persistent history if the backend only exposes current-session events.

### 6.6 Pengaturan

Group existing configuration into clear sections:
- Connection endpoints: LAN, Tailscale, Cloudflare.
- API authentication: Bearer token, masked by default.
- Cloudflare-related configuration that the current app actually supports.
- Automatic refresh interval.
- Appearance preferences only if persisted by the application.
- Connection diagnostics and last successful endpoint.

Preserve existing endpoint fallback order/behavior unless the current implementation is intentionally changed with tests. Never expose secrets in logs or URLs.

### 6.7 Tentang

Show actual application/dashboard version, service status, repository/documentation links, and support information when those values are known. Do not hard-code a version that can become stale.

## 7. Shared components

Build reusable components for:
- App shell and sidebar
- Header and breadcrumbs
- Summary/stat cards
- Device status badge
- Device row/card
- Metric tile
- Traffic chart
- Activity item/table
- Search input and filter controls
- Form fields and endpoint editor
- Confirmation dialog
- Toast/inline alert
- Loading skeleton
- Empty state
- Error state
- Stale-data indicator

All interactive controls must be wired to real behavior. No decorative button should imply an action that does not exist.

## 8. Modal and form requirements

- Add-device modal: retain current supported inputs and validation.
- Remove-device confirmation: identify the selected device clearly and require explicit confirmation.
- Connection settings: validate endpoint format and preserve existing values unless the user saves changes.
- Token field: masked by default; show/hide control must not copy or log the token.
- Error dialogs: explain which operation failed and offer a safe retry when appropriate.

Use existing form semantics and API error handling wherever possible.

## 9. Responsive behavior

Suggested breakpoints:
- Desktop: 1200 px and above — full sidebar and multi-column layout.
- Tablet: 768–1199 px — compact sidebar and reduced card columns.
- Mobile: 390–767 px — drawer navigation, single-column cards, compact charts.
- Small mobile: below 390 px — prioritize status and key actions; allow chart horizontal scrolling only when necessary.

Do not hide critical status, add/remove, refresh, or device-detail actions on mobile.

## 10. Data and API compatibility contract

Before implementation, audit the current source and document:
- Existing API endpoints and request methods.
- Response schemas and optional fields.
- Authentication headers and token handling.
- Polling/refresh cadence and cancellation behavior.
- Error, timeout, and stale-data behavior.
- LAN/Tailscale/Cloudflare endpoint fallback.
- Device add/remove operations.
- Wireless ADB pairing and connection lifecycle.

The frontend redesign should primarily change presentation and navigation. Keep data access in the existing library/service layer (currently identified as `www/lib.js`) rather than duplicating API logic in page components. Preserve the existing API contract unless a separately reviewed migration is necessary.

### Security and topology

The intended topology remains:
- Android target devices stay at home.
- Wireless ADB communication remains on the trusted local network.
- The local monitoring service collects device information and serves the existing API.
- Remote browser access reaches the dashboard through the protected Cloudflare path.
- Tailscale and LAN access remain available according to the current configuration.

Cloudflare access must not become a public ADB transport. Keep ADB ports blocked from WAN. Retain Bearer-token authentication and apply the current access-control model.

## 11. Accessibility and usability

- Maintain sufficient contrast for text and controls.
- Provide visible keyboard focus.
- Use semantic headings, buttons, labels, and table headers.
- Provide text labels alongside status colors/icons.
- Respect reduced-motion preferences.
- Ensure dialogs are keyboard-operable and return focus appropriately.
- Avoid tiny tap targets on mobile.

## 12. QA and acceptance criteria

The following checklist is a test plan. A checked item should mean the behavior was actually exercised and passed; checking this document alone is not proof of a successful test.

- [ ] All pages use the Midnight Pro 2.0 design system consistently.
- [ ] Dashboard displays live API data, not mock values.
- [ ] Add and remove device flows work.
- [ ] Online/offline and ADB states are accurate.
- [ ] Battery, temperature, Wi-Fi, CPU/RAM and other telemetry render correctly when supplied.
- [ ] Download/upload traffic renders correctly and labels its time range.
- [ ] Application list and activity log work.
- [ ] LAN, Tailscale, and Cloudflare endpoint settings are preserved and usable.
- [ ] Endpoint fallback and server-unreachable/stale-data states work.
- [ ] API token remains protected and authentication works.
- [ ] Desktop, tablet, and mobile layouts are tested.
- [ ] Android APK build and GitHub Actions remain healthy if app assets/build inputs are affected.
- [ ] No ADB port is exposed to the public internet.
- [ ] No existing feature has been removed without explicit approval.

For each test, record environment, steps, expected result, actual result, and evidence (screenshot/log) in the pull request.

## 13. Implementation sequence

1. Audit current default branch, source tree, API docs, and all existing UI interactions.
2. Create a baseline inventory of existing features and endpoint contracts.
3. Implement design tokens and shared components.
4. Implement app shell/navigation and dashboard.
5. Implement device list and device detail.
6. Implement apps, activity log, settings, and about pages.
7. Implement responsive behavior and accessibility.
8. Integrate existing data layer and verify all interactions.
9. Run lint/build/tests available in the repository and manually test endpoint/ADB workflows.
10. Attach desktop/mobile screenshots and QA evidence to a pull request for review.

## 14. Pull request deliverables

- Summary of UI/UX changes.
- Files changed and rationale.
- Before/after screenshots for every page.
- Mobile screenshots.
- API compatibility notes.
- QA checklist with actual results.
- Build and workflow results.
- Explicit statement of any unsupported metrics or deferred features.

## 15. Reference mockup

The approved direction is a premium dark navy interface with blue/cyan primary accents, violet secondary accents, clear status colors, rounded panels, restrained glow, a collapsible sidebar, and responsive page layouts. The concept mockup is illustrative; actual content and values must come from the live adbWIFI service.
