#!/bin/sh
# hpmon daemon v2 - updates /tmp/hpmon_cache.json every INTERVAL seconds
# rx/tx per device via ADB /proc/net/dev (wlan0) when adb connected; nft forward hook
# terbukti tidak mengukur trafik HP LAN/bridge (lihat HANDOFF.md). rxtx_source jujur.

TARGETS_FILE="/etc/hpmon/targets.json"
CACHE_FILE="/tmp/hpmon_cache.json"
INTERVAL=60
ADB_TIMEOUT=5
ADB_CMD_TIMEOUT=8

log() {
  logger -t hpmon-daemon "$@"
}

# Atomic write helper: tulis ke file sementara lalu mv
atomic_write() {
  local file="$1"; shift
  local tmp="${file}.tmp.$$"
  cat > "$tmp" && mv "$tmp" "$file"
}

# Jalankan perintah ADB dengan batas waktu tanpa GNU timeout (tidak tersedia di BusyBox).
# Early-exit: keluar begitu proses selesai (tidak selalu menunggu penuh ADB_CMD_TIMEOUT).
adb_run() {
  local addr="$1"; shift
  local outfile="/tmp/hpmon_adb_out.$$"
  local apid waited=0
  adb -s "$addr" shell "$@" >"$outfile" 2>/dev/null &
  apid=$!
  while kill -0 "$apid" 2>/dev/null; do
    if [ "$waited" -ge "$ADB_CMD_TIMEOUT" ]; then
      kill "$apid" 2>/dev/null
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$apid" 2>/dev/null
  cat "$outfile" 2>/dev/null | tr -d '\r'
  rm -f "$outfile"
}

# Ambil rx/tx wlan0 kumulatif (sejak HP boot) via ADB. Output JSON fragment per device.
# rxtx_source:"adb"|null, rxtx_ts epoch detik saat ambil, rxtx_available true/false.
get_adb_rxtx() {
  local addr="$1"
  local ts devline rx tx
  ts=$(date +%s)
  devline=$(adb_run "$addr" cat /proc/net/dev | grep -E 'wlan0:' | head -1)
  if [ -n "$devline" ]; then
    rx=$(echo "$devline" | awk -F: '{print $2}' | awk '{print $1}')
    tx=$(echo "$devline" | awk -F: '{print $2}' | awk '{print $9}')
    if echo "$rx$tx" | grep -qE '^[0-9]+$' && [ -n "$rx" ] && [ -n "$tx" ]; then
      printf '"rx_bytes":%s,"tx_bytes":%s,"rxtx_source":"adb","rxtx_ts":%s,"rxtx_available":true' "$rx" "$tx" "$ts"
      return
    fi
  fi
  printf '"rx_bytes":null,"tx_bytes":null,"rxtx_source":null,"rxtx_ts":null,"rxtx_available":false'
}

# Get router-side data for an IP (non-blocking-ish; ping timeout 1s)
get_router_data() {
  local ip="$1"
  local online="false"
  local latency=""
  local mac=""
  local conns=0

  if ping -c1 -W1 "$ip" >/dev/null 2>&1; then
    online="true"
    latency=$(ping -c3 -W1 "$ip" 2>/dev/null | grep avg | awk -F'/' '{print $5}')
  fi

  mac=$(ip neigh show "$ip" 2>/dev/null | awk '{print $5}' | head -1)
  [ -z "$mac" ] && mac=$(cat /proc/net/arp 2>/dev/null | grep "$ip" | awk '{print $4}' | head -1)
  [ -z "$mac" ] && mac="00:00:00:00:00:00"

  conns=$(grep "$ip" /proc/net/nf_conntrack 2>/dev/null | wc -l | tr -d ' ')

  printf '{"online":%s,"latency":"%s","mac":"%s","connections":%s}' \
    "$online" "$latency" "$mac" "${conns:-0}"
}

# Get ADB data for a device with auto-detect and reconnect (non-blocking pada unreachable:
# adb connect dibatasi ADB_TIMEOUT). Port ADB TIDAK diubah logikanya; hanya auto-update
# targets.json bila device terdeteksi di port berbeda (perilaku v2 yang ada).
get_adb_data() {
  local ip="$1"
  local port="$2"
  local addr="${ip}:${port}"
  local adb_status="unreachable"
  local adb_error=""
  local detected_port=""
  local wifi_ssid=""
  local wifi_rssi=""
  local battery=""
  local model=""
  local android=""
  local screen=""
  local uptime=""
  local dev_entry found_state dev_state any_entry any_port apid

  # Cari entri ip:port aktif di `adb devices -l`
  dev_entry=$(adb devices -l 2>/dev/null | grep "^${ip}:" | head -1)
  if [ -n "$dev_entry" ]; then
    detected_port=$(echo "$dev_entry" | awk '{print $1}' | cut -d: -f2)
    found_state=$(echo "$dev_entry" | awk '{print $2}')

    if [ -n "$detected_port" ] && [ "$detected_port" != "$port" ]; then
      log "Updating port_adb for $ip from $port to $detected_port"
      tmpf=$(mktemp)
      jq --arg ip "$ip" --argjson newport "$detected_port" \
        'map(if .ip==$ip then .port_adb=$newport else . end)' \
        "$TARGETS_FILE" > "$tmpf" && mv "$tmpf" "$TARGETS_FILE"
      port="$detected_port"
      addr="${ip}:${port}"
    fi

    case "$found_state" in
      device) adb_status="connected" ;;
      unauthorized) adb_status="unauthorized"; adb_error="unauthorized" ;;
      offline) adb_status="offline"; adb_error="offline" ;;
      *) adb_status="$found_state"; adb_error="$found_state" ;;
    esac
  else
    # Unreachable/baru: coba connect dibatasi waktu (tidak blocking siklus)
    log "Attempting adb connect to $addr"
    adb connect "$addr" >/dev/null 2>&1 &
    apid=$!
    sleep "$ADB_TIMEOUT"
    if kill -0 "$apid" 2>/dev/null; then
      kill "$apid" 2>/dev/null
      wait "$apid" 2>/dev/null
    fi

    dev_state=$(adb devices 2>/dev/null | grep "^${addr}" | awk '{print $2}')
    case "$dev_state" in
      device) adb_status="connected" ;;
      unauthorized) adb_status="unauthorized"; adb_error="unauthorized" ;;
      offline) adb_status="offline"; adb_error="offline" ;;
      "")
        any_entry=$(adb devices 2>/dev/null | grep "^${ip}:" | head -1)
        if [ -n "$any_entry" ]; then
          any_port=$(echo "$any_entry" | awk '{print $1}' | cut -d: -f2)
          adb_status="port_salah"
          adb_error="device on port $any_port, expected $port"
        else
          adb_status="unreachable"
          adb_error="connection refused or timeout"
        fi
        ;;
      *) adb_status="$dev_state"; adb_error="$dev_state" ;;
    esac
  fi

  if [ "$adb_status" = "connected" ]; then
    battery=$(adb_run "$addr" dumpsys battery 2>/dev/null | grep level | awk '{print $2}' | tr -d '\r')
    model=$(adb_run "$addr" getprop ro.product.model 2>/dev/null | tr -d '\r\n')
    android=$(adb_run "$addr" getprop ro.build.version.release 2>/dev/null | tr -d '\r\n')
    screen=$(adb_run "$addr" dumpsys power 2>/dev/null | grep "mWakefulness=" | awk -F'=' '{print $2}' | tr -d '\r\n')
    uptime=$(adb_run "$addr" cat /proc/uptime 2>/dev/null | awk '{print int($1)}' | tr -d '\r')

    wifi_line=$(adb_run "$addr" dumpsys wifi 2>/dev/null | grep "mWifiInfo SSID:" | head -1 | tr -d '\r')
    wifi_ssid=$(printf '%s\n' "$wifi_line" | awk -F'SSID: ' '{print $2}' | awk -F',' '{print $1}' | sed 's/^"//;s/"$//')
    raw_rssi=$(printf '%s\n' "$wifi_line" | sed -n 's/.*RSSI: *\(-\{0,1\}[0-9][0-9]*\).*/\1/p')
    if echo "$raw_rssi" | grep -qE '^-?[0-9]+$'; then
      wifi_rssi="$raw_rssi"
    else
      wifi_rssi="null"
    fi
  fi

  printf '{"status":"%s"' "$adb_status"
  [ -n "$adb_error" ] && printf ',"error":"%s"' "$adb_error"
  [ -n "$detected_port" ] && printf ',"port_terdeteksi":%s' "$detected_port"
  if [ "$adb_status" = "connected" ]; then
    printf ',"battery":"%s","model":"%s","android":"%s","screen":"%s","uptime":%s,"wifi_ssid":"%s","wifi_rssi":%s' \
      "${battery:-}" "${model:-}" "${android:-}" "${screen:-}" "${uptime:-0}" "${wifi_ssid:-}" "${wifi_rssi:-null}"
  fi
  printf '}'
}

update_cache() {
  timestamp=$(date +%s)
  result='{"timestamp":'$timestamp',"devices":['
  first=1

  if [ ! -f "$TARGETS_FILE" ]; then
    log "ERROR: targets.json not found"
    echo '{"error":"targets.json not found"}' > "$CACHE_FILE"
    return
  fi

  count=$(jq -r 'length' "$TARGETS_FILE")
  i=0

  while [ $i -lt $count ]; do
    ip=$(jq -r ".[$i].ip" "$TARGETS_FILE")
    nama=$(jq -r ".[$i].nama" "$TARGETS_FILE")
    port=$(jq -r ".[$i].port_adb" "$TARGETS_FILE")

    [ $first -eq 0 ] && result="$result,"
    first=0

    router_data=$(get_router_data "$ip")
    adb_data=$(get_adb_data "$ip" "$port")

    # rxtx level device: hanya bila ADB connected. Unreachable TIDAK blocking siklus.
    adb_status=$(printf '%s' "$adb_data" | jq -r '.status' 2>/dev/null)
    if [ "$adb_status" = "connected" ]; then
      # Pakai port terdeteksi bila ada (port_adb asli tidak diubah secara destruktif selain auto-update v2)
      use_port=$(printf '%s' "$adb_data" | jq -r '.port_terdeteksi // empty' 2>/dev/null)
      [ -z "$use_port" ] && use_port="$port"
      rxtx_data=$(get_adb_rxtx "${ip}:${use_port}")
    else
      rxtx_data='"rx_bytes":null,"tx_bytes":null,"rxtx_source":null,"rxtx_ts":null,"rxtx_available":false'
    fi

    result="${result}{\"ip\":\"$ip\",\"nama\":\"$nama\",\"port_adb\":$port,\"router\":$router_data,\"adb\":$adb_data,${rxtx_data}}"
    i=$((i+1))
  done

  result="${result}]}"
  atomic_write "$CACHE_FILE" <<EOF
$result
EOF
  log "Cache updated: $count devices"
}

PIDFILE="/var/run/hpmon-daemon-v2.pid"
if [ -f "$PIDFILE" ]; then
  oldpid=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$oldpid" ] && kill -0 "$oldpid" 2>/dev/null; then
    log "another instance already running (pid $oldpid), exiting"
    exit 0
  fi
fi
echo $$ > "$PIDFILE"

log "Starting hpmon daemon v2 (interval=${INTERVAL}s)"

adb start-server >/dev/null 2>&1

while true; do
  update_cache
  sleep $INTERVAL
done
