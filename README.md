# Telemetry Server

Android Telemetry Server — expose sensor data via local HTTP + WebSocket server. No ADB, no root, no router configuration required.

## Features

- **HTTP API** — REST endpoints for battery, location, system (RAM/CPU), network, app usage
- **WebSocket** — Real-time push at `/ws/live` (auto-reconnect)
- **Foreground Service** — Runs persistently, survives reboots
- **Visual Dashboard** — Dark/light theme, live cards for each metric
- **Token Auth** — Bearer token or query param `?token=`
- **Auto-start on Boot** — Starts automatically after device reboot
- **Three URL Fallback** — LAN IP, Tailscale, Cloudflare Tunnel (configured in app)

## API Endpoints

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

## WebSocket Protocol

```json
// Client → Server
{"type": "ping"}
{"type": "data"}

// Server → Client (on connect and every interval)
{"type": "telemetry", "data": { ... }}
{"type": "pong", "ts": 1234567890}
```

## Requirements

- Android 8.0+ (API 26)
- Location permission (for GPS + WiFi SSID)
- Usage Stats permission (for app list)
- Notification permission (Android 13+)

## Build

```bash
npm ci
npx cap add android
npx cap sync android
cd android && ./gradlew assembleRelease
```

## GitHub Actions

Push a tag `v*` to trigger automated build and release.

## Security

- Token stored in Android Keystore-backed Preferences
- Cleartext HTTP allowed for LAN (Capacitor `cleartext: true`)
- No external dependencies — fully local

## Architecture

```
┌─────────────────────────────────────┐
│        Capacitor Web App (www/)     │
│   Dashboard UI + Settings + Config  │
└───────────────┬─────────────────────┘
                │ Capacitor Bridge (TelemetryBridge)
                ▼
┌─────────────────────────────────────┐
│      Kotlin Foreground Service      │
│  ┌──────────────┐  ┌─────────────┐  │
│  │ NanoWSD HTTP │  │ DataCollector│ │
│  │ + WebSocket  │  │ (Sensors)   │  │
│  └──────────────┘  └─────────────┘  │
└─────────────────────────────────────┘
```

## License

MIT