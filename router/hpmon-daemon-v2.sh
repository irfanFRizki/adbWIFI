#!/bin/sh
# hpmon daemon v2 - updates /tmp/hpmon_cache.json every INTERVAL seconds
# rx/tx per device via ADB /proc/net/dev (wlan0) when adb connected; nft forward hook
# terbukti tidak mengukur trafik HP LAN/bridge (lihat HANDOFF.md). rxtx_source jujur.

TARGETS_FILE="/etc/hpmon/targets.json"
CACHE_FILE="/tmp/hpmon_cache.json"
INTERVAL=60
ADB_TIMEOUT=5
ADB_CMD_TIMEOUT=8
# Package APK helper opsional (lihat helper-app/), dipasang manual sekali per HP via
# `adb install` untuk baca arus baterai lewat BatteryManager API saat sysfs diblokir.
HELPER_PKG="com.irfanfrizki.adbwifihelper"

log() {
  logger -t hpmon-daemon "$@"
}

# Escape string agar aman disisipkan ke dalam JSON (BusyBox-compatible, tanpa jq).
# Menghindari cache rusak bila SSID/model/nama mengandung " \ atau karakter kontrol.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r/\\r/g' | tr -d '\n'
}

# Atomic write helper: tulis ke file sementara lalu mv
atomic_write() {
  local file="$1"; shift
  local tmp="${file}.tmp.$$"
  # flock:hindari race antara daemon write dan CGI read (cache rusak bila setengah ditulis)
  exec 9>"$file.lock"
  flock 9
  cat > "$tmp" && mv "$tmp" "$file"
  exec 9>&-
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

# Resolve hostname for IP (refreshed each cycle). Returns "hostname|source" or "null|"
# Sources: static_lease (uci dhcp @host), domain_record (uci dhcp @domain or /etc/hosts), dhcp_leases (/tmp/dhcp.leases)
get_hostname_for_ip() {
  local ip="$1" hn="" src=""
  # (1) static lease uci show dhcp (host.name)
  local sec
  for sec in $(uci show dhcp 2>/dev/null | sed -n 's/^dhcp\.@host\[\([0-9]*\)\]=host/\1/p'); do
    local hip hname
    hip=$(uci -q get dhcp.@host[$sec].ip 2>/dev/null)
    hname=$(uci -q get dhcp.@host[$sec].name 2>/dev/null)
    if [ "$hip" = "$ip" ] && [ -n "$hname" ]; then hn="$hname"; src="static_lease"; break; fi
  done
  # (2) domain record uci dhcp.@domain and /etc/hosts
  if [ -z "$hn" ]; then
    for sec in $(uci show dhcp 2>/dev/null | sed -n 's/^dhcp\.@domain\[\([0-9]*\)\]=domain/\1/p'); do
      local dip dname
      dip=$(uci -q get dhcp.@domain[$sec].ip 2>/dev/null)
      dname=$(uci -q get dhcp.@domain[$sec].name 2>/dev/null)
      if [ "$dip" = "$ip" ] && [ -n "$dname" ]; then hn="$dname"; src="domain_record"; break; fi
    done
  fi
  if [ -z "$hn" ] && [ -f /etc/hosts ]; then
    hn=$(awk -v ip="$ip" '$1==ip {print $2; exit}' /etc/hosts 2>/dev/null)
    [ -n "$hn" ] && src="hosts"
  fi
  # (3) /tmp/dhcp.leases (expiry mac ip hostname clientid)
  if [ -z "$hn" ] && [ -f /tmp/dhcp.leases ]; then
    hn=$(awk -v ip="$ip" '$3==ip && $4!="*" {print $4; exit}' /tmp/dhcp.leases 2>/dev/null)
    [ -n "$hn" ] && src="dhcp_leases"
  fi
  if [ -n "$hn" ]; then
    printf '%s|%s' "$hn" "$src"
  else
    printf 'null|'
  fi
}

# Get router-side data for an IP (non-blocking-ish; ping timeout 1s)
get_router_data() {
  local ip="$1"
  local online="false"
  local latency=""
  local mac=""
  local conns=0

  ping_result=$(ping -c2 -W1 "$ip" 2>/dev/null)
  if [ $? -eq 0 ]; then
    online="true"
    latency=$(printf '%s\n' "$ping_result" | grep avg | awk -F'/' '{print $5}')
  fi

  mac=$(ip neigh show "$ip" 2>/dev/null | awk '{print $5}' | head -1)
  [ -z "$mac" ] && mac=$(cat /proc/net/arp 2>/dev/null | grep "$ip" | awk '{print $4}' | head -1)
  [ -z "$mac" ] && mac="00:00:00:00:00:00"

  conns=$(grep "$ip" /proc/net/nf_conntrack 2>/dev/null | wc -l | tr -d ' ')

  printf '{"online":%s,"latency":"%s","mac":"%s","connections":%s}' \
    "$online" "$latency" "$mac" "${conns:-0}"
}

# Battery history and extended fields (Fase B)
BATTERY_HIST="/tmp/hpmon_battery_hist"
APP_LABELS="/etc/hpmon/app-labels.json"

# Update battery history and compute avg_drain_pct_per_hour (3h window, samples >=30min apart)
# Args: ip level charging_bool now_ts
# Prints: avg_drain_pct_per_hour (number or null)
compute_avg_drain() {
  local ip="$1" level="$2" charging="$3" now="$4"
  local hist="$BATTERY_HIST"
  [ -f "$hist" ] || touch "$hist"
  # append if level is numeric
  if echo "$level" | grep -qE '^[0-9]+$'; then
    printf '%s\t%s\t%s\t%s\n' "$ip" "$now" "$level" "$charging" >> "$hist"
  fi
  # prune >6h
  local tmpf=$(mktemp)
  awk -v now="$now" -v ip="$ip" '{if (now - $2 <= 21600) print $0}' "$hist" > "$tmpf" 2>/dev/null && mv "$tmpf" "$hist"
  # compute from last 3h, non-charging samples only
  awk -v ip="$ip" -v now="$now" '
    $1==ip && (now-$2)<=10800 && $4=="false" && $3 ~ /^[0-9]+$/ { t[++n]=$2; l[n]=$3 }
    END {
      if (n < 2) { print "null"; exit }
      # find oldest and newest with >=30min span
      min_i=1; max_i=1
      for(i=1;i<=n;i++){ if(t[i]<t[min_i]) min_i=i; if(t[i]>t[max_i]) max_i=i }
      span = t[max_i]-t[min_i]
      if (span < 1800) { print "null"; exit }
      drop = l[min_i]-l[max_i]
      if (drop <= 0) { print "null"; exit }
      hours = span/3600.0
      printf "%.2f", drop/hours
    }' "$hist" 2>/dev/null || echo "null"
}

# Get ADB data for a device with auto-detect and reconnect (non-blocking pada unreachable:
# adb connect dibatasi ADB_TIMEOUT). Port ADB TIDAK diubah logikanya; hanya auto-update
# targets.json bila device terdeteksi di port berbeda (perilaku v2 yang ada).
get_adb_data() {
  local ip="$1"
  local port="$2"
  local adb_devices_out="${3:-}"
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
  # Fase B extras
  local charging="null" charge_source="null" temp_c="null" voltage_mv="null"
  local current_ma="null" current_available="false" avg_drain_pct_per_hour="null"
  local fg_pkg="null" fg_label="null"

  [ -z "$adb_devices_out" ] && adb_devices_out=$(adb devices -l 2>/dev/null)
  dev_entry=$(printf '%s\n' "$adb_devices_out" | grep "^${ip}:" | head -1)
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

    dev_state=$(printf '%s\n' "$adb_devices_out" | grep "^${addr}" | awk '{print $2}')
    case "$dev_state" in
      device) adb_status="connected" ;;
      unauthorized) adb_status="unauthorized"; adb_error="unauthorized" ;;
      offline) adb_status="offline"; adb_error="offline" ;;
      "")
        any_entry=$(printf '%s\n' "$adb_devices_out" | grep "^${ip}:" | head -1)
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
    # single dumpsys battery for level + extended fields
    bat_dump=$(adb_run "$addr" dumpsys battery 2>/dev/null | tr -d '\r')
    battery=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*level:/{print $2; exit}')
    local ac_p usb_p wl_p btemp bvolt
    ac_p=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*AC powered:/{print $3; exit}')
    usb_p=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*USB powered:/{print $3; exit}')
    wl_p=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*Wireless powered:/{print $3; exit}')
    btemp=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*temperature:/{print $2; exit}')
    bvolt=$(printf '%s\n' "$bat_dump" | awk '/^[[:space:]]*voltage:/{print $2; exit}')
    if [ "$ac_p" = "true" ] || [ "$usb_p" = "true" ] || [ "$wl_p" = "true" ]; then
      charging="true"
    elif [ "$ac_p" = "false" ] || [ "$usb_p" = "false" ]; then
      charging="false"
    fi
    if [ "$ac_p" = "true" ]; then charge_source="\"ac\""
    elif [ "$usb_p" = "true" ]; then charge_source="\"usb\""
    elif [ "$wl_p" = "true" ]; then charge_source="\"wireless\""
    else charge_source="null"; fi
    if echo "$btemp" | grep -qE '^-?[0-9]+$'; then temp_c=$(awk "BEGIN{printf \"%.1f\", $btemp/10}"); else temp_c="null"; fi
    if echo "$bvolt" | grep -qE '^[0-9]+$'; then voltage_mv="$bvolt"; else voltage_mv="null"; fi
    # current_now: µA -> mA, keep sign. Konvensi: + mengisi, - dipakai (umum di banyak kernel; nilai mentah dipertahankan arahnya).
    local cnow
    cnow=$(adb_run "$addr" cat /sys/class/power_supply/battery/current_now 2>/dev/null | tr -d '\r\n')
    if echo "$cnow" | grep -qE '^-?[0-9]+$'; then
      current_ma=$(awk "BEGIN{printf \"%.3f\", $cnow/1000}")
      current_available="true"
    else
      # sysfs ditolak (umum di Android 10+ karena SELinux membatasi domain shell,
      # terlepas dari mode file -- lihat CHANGELOG v0.7.0). Coba lewat helper app
      # (BatteryManager API, berjalan sebagai proses aplikasi biasa, tidak kena
      # batasan yang sama) kalau sudah terpasang di HP ini. Aman di HP yang BELUM
      # pasang helper-nya: broadcast tanpa receiver cocok = no-op, file tidak ada,
      # current_ma tetap "null" seperti sebelumnya.
      current_ma="null"; current_available="false"
      adb_run "$addr" am broadcast -n "$HELPER_PKG/.CurrentReceiver" -a "$HELPER_PKG.READ_CURRENT" >/dev/null 2>&1
      sleep 1
      local hjson hnow
      hjson=$(adb_run "$addr" cat "/sdcard/Android/data/$HELPER_PKG/files/current.json" 2>/dev/null | tr -d '\r')
      # awk match(), bukan sed \{m,n\}, supaya tidak bergantung pada dukungan interval
      # regex di BusyBox sed. Pola butuh digit setelah ":" -- kalau nilainya "null"
      # (properti tidak didukung HP), tidak match dan hnow tetap kosong (fallback aman).
      hnow=$(echo "$hjson" | awk 'match($0, /"current_now_ua":-?[0-9]+/) { s = substr($0, RSTART, RLENGTH); sub(/.*:/, "", s); print s }')
      if [ -n "$hnow" ]; then
        current_ma=$(awk "BEGIN{printf \"%.3f\", $hnow/1000}")
        current_available="true"
      fi
    fi
    # avg drain
    local now_ts; now_ts=$(date +%s)
    avg_drain_pct_per_hour=$(compute_avg_drain "$ip" "$battery" "$charging" "$now_ts")

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

    # foreground app from mCurrentFocus (null if screen off/locked/unreadable)
    if [ "$screen" != "Awake" ]; then
      fg_pkg="null"; fg_label="null"
    else
      local focus_line pkg_raw
      focus_line=$(adb_run "$addr" dumpsys window 2>/dev/null | grep mCurrentFocus | head -1 | tr -d '\r')
      # format: mCurrentFocus=Window{... u0 com.pkg/com.pkg.Activity}
      pkg_raw=$(printf '%s\n' "$focus_line" | sed -n 's/.* u[0-9][0-9]* \([^ /}][^ /}]*\)\/.*/\1/p')
      if [ -z "$pkg_raw" ]; then
        pkg_raw=$(printf '%s\n' "$focus_line" | sed -n 's/.* \([^ /}][^ /}]*\)\/.*/\1/p')
      fi
      if [ -n "$pkg_raw" ] && [ "$pkg_raw" != "null" ]; then
        fg_pkg="\"$pkg_raw\""
        if [ -f "$APP_LABELS" ]; then
          local lbl
          lbl=$(jq -r --arg p "$pkg_raw" '.[$p] // empty' "$APP_LABELS" 2>/dev/null)
          if [ -n "$lbl" ]; then fg_label="\"$lbl\""; else fg_label="null"; fi
        else
          fg_label="null"
        fi
      else
        fg_pkg="null"; fg_label="null"
      fi
    fi
  fi

  printf '{"status":"%s"' "$adb_status"
  [ -n "$adb_error" ] && printf ',"error":"%s"' "$adb_error"
  [ -n "$detected_port" ] && printf ',"port_terdeteksi":%s' "$detected_port"
  if [ "$adb_status" = "connected" ]; then
    # existing fields preserved (nilai string di-escape agar aman untuk JSON)
    model_j=$(json_escape "${model:-}"); android_j=$(json_escape "${android:-}")
    screen_j=$(json_escape "${screen:-}"); wifi_ssid_j=$(json_escape "${wifi_ssid:-}")
    printf ',"battery":"%s","model":"%s","android":"%s","screen":"%s","uptime":%s,"wifi_ssid":"%s","wifi_rssi":%s' \
      "${battery:-}" "$model_j" "$android_j" "$screen_j" "${uptime:-0}" "$wifi_ssid_j" "${wifi_rssi:-null}"
    # Fase B new fields in adb object
    printf ',"charging":%s,"charge_source":%s,"temp_c":%s,"voltage_mv":%s,"current_ma":%s,"current_available":%s,"avg_drain_pct_per_hour":%s' \
      "$charging" "$charge_source" "$temp_c" "$voltage_mv" "$current_ma" "$current_available" "$avg_drain_pct_per_hour"
    printf ',"foreground_app":{"package":%s,"label":%s}' "$fg_pkg" "$fg_label"
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
  adb_devices_snapshot=$(adb devices -l 2>/dev/null)

  while [ $i -lt $count ]; do
    ip=$(jq -r ".[$i].ip" "$TARGETS_FILE")
    nama=$(jq -r ".[$i].nama" "$TARGETS_FILE")
    port=$(jq -r ".[$i].port_adb" "$TARGETS_FILE")

    [ $first -eq 0 ] && result="$result,"
    first=0

    router_data=$(get_router_data "$ip")
    adb_data=$(get_adb_data "$ip" "$port" "$adb_devices_snapshot")
    hn_info=$(get_hostname_for_ip "$ip")
    hostname_val=$(printf '%s' "$hn_info" | cut -d'|' -f1)
    hostname_src=$(printf '%s' "$hn_info" | cut -d'|' -f2-)

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

    if [ "$hostname_val" = "null" ]; then hn_json="null"; else hn_json="\"$(json_escape "$hostname_val")\""; fi; nama_j=$(json_escape "$nama"); result="${result}{\"ip\":\"$ip\",\"nama\":\"$nama_j\",\"hostname\":$hn_json,\"port_adb\":$port,\"router\":$router_data,\"adb\":$adb_data,${rxtx_data}}"
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
cleanup() { rm -f "$PIDFILE" /tmp/hpmon_adb_out.$$ /tmp/hpmon_cgi_adb_$$; }
trap cleanup EXIT INT TERM

log "Starting hpmon daemon v2 (interval=${INTERVAL}s)"

adb start-server >/dev/null 2>&1

while true; do
  update_cache
  sleep $INTERVAL
done
