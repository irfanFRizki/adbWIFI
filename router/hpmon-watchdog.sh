#!/bin/sh
# HPMon watchdog — dijalankan oleh cron tiap 5 menit.
# Pemicu: (1) cache /tmp/hpmon_cache.json lebih tua dari 3 menit, atau
#         (2) curl -s -m 5 http://127.0.0.1/cgi-bin/hpmon/index.sh/status
#             (dengan token) tidak mengembalikan JSON valid.
# Tindakan: restart service hpmon + logger. Jika adb hang > N detik,
#           jalankan adb kill-server && adb start-server.
set -e

CACHE_FILE="/tmp/hpmon_cache.json"
TOKEN_FILE="/etc/hpmon/token"
CGI_URL="http://127.0.0.1/cgi-bin/hpmon/index.sh/status"
MAX_CACHE_AGE=180          # 3 menit (detik)
CGI_TIMEOUT=5
ADB_HANG_TIMEOUT=15        # detik
ADB_ADDR="192.168.7.177:5555"
NOW=$(date +%s)

# --- 1. Cek usia cache ---
if [ -f "$CACHE_FILE" ]; then
  MTIME=$(stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
  AGE=$((NOW - MTIME))
else
  AGE=9999
fi
if [ "$AGE" -gt "$MAX_CACHE_AGE" ]; then
  logger -t hpmon-watchdog "cache age ${AGE}s > ${MAX_CACHE_AGE}s; restarting hpmon"
  /etc/init.d/hpmon restart 2>/dev/null || true
  exit 0
fi

# --- 2. Cek CGI balas JSON valid (port 80 dan port khusus 8091) ---
TOKEN=$(cat "$TOKEN_FILE" 2>/dev/null)
if [ -z "$TOKEN" ]; then
  logger -t hpmon-watchdog "token file missing; skipping CGI check"
  exit 0
fi
RESP=$(curl -s -m "$CGI_TIMEOUT" -H "Authorization: Bearer $TOKEN" "$CGI_URL" 2>/dev/null || true)
if [ -z "$RESP" ] || ! printf '%s' "$RESP" | jq -e . >/dev/null 2>&1; then
  logger -t hpmon-watchdog "CGI :80 not responding / invalid JSON; restarting hpmon"
  /etc/init.d/hpmon restart 2>/dev/null || true
  exit 0
fi

# Cek uhttpd hpmon (port 8091)
RESP_8091=$(curl -s -m "$CGI_TIMEOUT" -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8091/cgi-bin/hpmon/index.sh/status" 2>/dev/null || true)
if [ -z "$RESP_8091" ] || ! printf '%s' "$RESP_8091" | jq -e . >/dev/null 2>&1; then
  logger -t hpmon-watchdog "hpmon-uhttpd :8091 not responding; restarting hpmon-uhttpd"
  /etc/init.d/hpmon-uhttpd restart 2>/dev/null || true
fi

# Cek cloudflared proses berjalan
if ! pgrep -f "cloudflared" >/dev/null 2>&1; then
  logger -t hpmon-watchdog "cloudflared process down; restarting cloudflared"
  /etc/init.d/cloudflared restart 2>/dev/null || true
fi

# --- 3. Cek adb hang (non-blocking, bounded) ---
ADB_OUT_FILE="/tmp/hpmon_adb_ping_$$"
adb -s "$ADB_ADDR" shell 'echo alive' >"$ADB_OUT_FILE" 2>/dev/null &
APID=$!
WAITED=0
while kill -0 "$APID" 2>/dev/null; do
  if [ "$WAITED" -ge "$ADB_HANG_TIMEOUT" ]; then
    logger -t hpmon-watchdog "adb hang > ${ADB_HANG_TIMEOUT}s; kill-server + start-server"
    kill "$APID" 2>/dev/null || true
    adb kill-server 2>/dev/null || true
    sleep 1
    adb start-server 2>/dev/null || true
    break
  fi
  sleep 1
  WAITED=$((WAITED + 1))
done
wait "$APID" 2>/dev/null || true
rm -f "$ADB_OUT_FILE"

exit 0