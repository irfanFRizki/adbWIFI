# Telemetry Server & Dashboard

Two APKs for remote Android monitoring:

- **TelemetryServer (APK 1)** — Install on **HP Target** (device to be monitored). Runs foreground service with HTTP + WebSocket server, collects sensor data.
- **TelemetryDashboard (APK 2)** — Install on **HP Pantau** (monitoring device). WebView dashboard that connects to Server APK via WebSocket.

No ADB, no root, no router configuration required.

## Features

- **HTTP API** — REST endpoints for battery, location, system (RAM/CPU), network, app usage
- **WebSocket** — Real-time push at `/ws/live` (auto-reconnect)
- **Foreground Service** — Runs persistently, survives reboots
- **Visual Dashboard** — Dark/light theme, live cards for each metric
- **Token Auth** — Bearer token or query param `?token=`
- **Auto-start on Boot** — Starts automatically after device reboot
- **Tailscale / LAN / VPN support** — Works across networks

## APK 1: TelemetryServer (HP Target)

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/data` | All telemetry data combined |
| `GET /api/battery` | Battery level, status, temp, voltage, current |
| `GET /api/location` | GPS/Network location (lat, lon, accuracy, altitude) |
| `GET /api/system` | RAM usage, CPU load, screen state, uptime |
| `GET /api/network` | WiFi SSID, local IP, RSSI, BSSID |
| `GET /api/apps` | Foreground apps (usage stats) |
| `GET /status` | Server health check |
| `WS /ws/live` | Real-time telemetry push |

### WebSocket Protocol

```json
// Client → Server
{"type": "ping"}
{"type": "data"}

// Server → Client (on connect and every interval)
{"type": "telemetry", "data": { ... }}
{"type": "pong", "ts": 1234567890}
```

### Permissions Required

- Location (GPS + WiFi SSID)
- Usage Stats (app list)
- Notification (Android 13+)
- Foreground Service Data Sync

## APK 2: TelemetryDashboard (HP Pantau)

- Pure WebView app — no native sensor access
- Connects to Server via `ws://IP_SERVER:PORT/ws`
- Settings: Server IP, HTTP Port, Bearer Token
- Auto-reconnect with exponential backoff
- Works over LAN, Tailscale, VPN

## Build

### GitHub Actions (Recommended)

Push a tag `v*` to trigger automated build for both APKs:

```bash
git tag -a v2.0.0 -m "v2.0.0 - Two APK architecture"
git push origin v2.0.0
```

Release artifacts:
- `TelemetryServer-vX.Y.Z.apk` — HP Target
- `TelemetryDashboard-vX.Y.Z.apk` — HP Pantau

### Local Build (requires Gradle 8.9+, JDK 21)

```bash
# Server APK
cd server-app && gradle assembleRelease

# Dashboard APK
cd dashboard-app/android && gradle assembleRelease
```

APKs output:
- `server-app/app/build/outputs/apk/release/app-release-unsigned.apk`
- `dashboard-app/android/app/build/outputs/apk/release/app-release-unsigned.apk`

## Architecture

```
┌─────────────────────────────┐         WebSocket (ws://IP:PORT/ws)         ┌─────────────────────────────┐
│        HP TARGET            │  ◄──────────────────────────────────────►  │       HP PANTAU             │
│  ┌───────────────────────┐  │                                           │  ┌───────────────────────┐  │
│  │  TelemetryServer APK  │  │  Real-time telemetry push every N sec    │  │  TelemetryDashboard   │  │
│  │  ┌─────────────────┐  │  │  HTTP API for instant data                │  │  APK (WebView)        │  │
│  │  │ Foreground Svc  │  │  │  Token auth (Bearer / ?token=)            │  │  ┌─────────────────┐  │
│  │  │  ┌───────────┐  │  │  │                                           │  │  │ WebView + JS    │  │
│  │  │  │ NanoHTTPD │  │  │  │                                           │  │  │ Dashboard UI    │  │
│  │  │  │ + WS      │  │  │  │                                           │  │  └─────────────────┘  │  │
│  │  │  │ DataColl  │  │  │  │                                           │  └───────────────────────┘  │
│  │  │  └───────────┘  │  │  │                                           └─────────────────────────────┘
│  │  └─────────────────┘  │  │
│  └───────────────────────┘  │
└─────────────────────────────┘
```

## Security

- Token stored in Android SharedPreferences (Keystore-backed on supported devices)
- Cleartext HTTP/WS allowed for LAN/VPN
- No external dependencies — fully local communication

## License

MIT