#!/bin/sh
# hpmon CGI API - uhttpd
# GET  /                  -> full cache
# GET  /status            -> full cache
# GET  /status?ip=<ip>    -> single device (404 JSON if unknown)
# GET  /status?ip=<ip>&detail=1 -> single device full detail
# GET  /targets           -> targets list
# POST /targets/add       -> add target
# POST /targets/delete    -> delete target
# OPTIONS                 -> 204 preflight
TOKEN_FILE="/etc/hpmon/token"
CACHE_FILE="/tmp/hpmon_cache.json"
TARGETS_FILE="/etc/hpmon/targets.json"
METHOD="${REQUEST_METHOD:-GET}"
PATH_INFO="${PATH_INFO:-/}"
PATH_INFO=$(printf '%s' "$PATH_INFO" | sed 's|^/hpmon||; s|^/||')
[ -z "$PATH_INFO" ] && PATH_INFO="/"
case "$PATH_INFO" in /*) ;; *) PATH_INFO="/$PATH_INFO" ;; esac
QUERY="${QUERY_STRING:-}"

# Bounded ADB call without GNU timeout: adb_t <addr> <args...> ; max ADB_T seconds, early exit
adb_t() {
  local addr="$1"; shift
  local outfile="/tmp/hpmon_cgi_adb_$$"
  local apid waited=0
  adb -s "$addr" shell "$@" >"$outfile" 2>/dev/null &
  apid=$!
  while kill -0 "$apid" 2>/dev/null; do
    [ "$waited" -ge "$ADB_T" ] && { kill "$apid" 2>/dev/null; break; }
    sleep 1; waited=$((waited + 1))
  done
  wait "$apid" 2>/dev/null
  cat "$outfile" 2>/dev/null | tr -d '\r'
  rm -f "$outfile"
}

url_decode() { printf '%s' "$1" | sed 's/+/ /g; s/%20/ /g'; }
qs_get() { local _v; _v=$(printf '%s' "$QUERY" | tr '&' '\n' | sed -n "s/^$1=//p" | head -1); url_decode "$_v"; }

STATUS="200 OK"
BODY='{"error":"not_found"}'
EXPECTED=$(cat "$TOKEN_FILE" 2>/dev/null)
AUTH="${HTTP_AUTHORIZATION:-}"
ADB_T=6

if [ "$METHOD" = OPTIONS ]; then
  STATUS="204 No Content"; BODY=''
elif [ "$AUTH" != "Bearer $EXPECTED" ]; then
  STATUS="401 Unauthorized"; BODY='{"error":"unauthorized"}'
else
  case "$PATH_INFO" in
    /targets)
      if [ -f "$TARGETS_FILE" ]; then BODY=$(cat "$TARGETS_FILE"); else BODY='[]'; fi
      ;;
    /status|/)
      if [ -f "$CACHE_FILE" ]; then CACHE=$(cat "$CACHE_FILE"); else CACHE='{"timestamp":null,"devices":[]}'; fi
      IP=$(qs_get ip)
      DETAIL=$(qs_get detail)
      if [ -n "$IP" ]; then
        DEV=$(printf '%s' "$CACHE" | jq -c --arg ip "$IP" '(.devices // [])[] | select(.ip==$ip)' 2>/dev/null)
        if [ -n "$DEV" ]; then
          if [ "$DETAIL" = "1" ]; then
            # ?detail=1 requires ?ip= - already satisfied here
            ADB_STATUS=$(printf '%s' "$DEV" | jq -r '.adb.status // "unreachable"' 2>/dev/null)
            if [ "$ADB_STATUS" = "connected" ]; then
              ADB_PORT=$(printf '%s' "$DEV" | jq -r '.port_adb // 5555' 2>/dev/null)
              ADB_ADDR="${IP}:${ADB_PORT}"
              # Fetch detail directly from HP (non-cached) with bounded timeouts
              APPS=$(adb_t "$ADB_ADDR" pm list packages -3 2>/dev/null | sed 's/^package://' | grep -v '^$' | jq -R . | jq -s .)
              [ -z "$APPS" ] && APPS="[]"
              # RAM: total/available KB from /proc/meminfo
              MEMINFO=$(adb_t "$ADB_ADDR" cat /proc/meminfo 2>/dev/null)
              RAM_TOTAL=$(printf '%s\n' "$MEMINFO" | grep '^MemTotal:' | awk '{print $2}')
              RAM_AVAIL=$(printf '%s\n' "$MEMINFO" | grep '^MemAvailable:' | awk '{print $2}')
              [ -z "$RAM_AVAIL" ] && RAM_AVAIL=$(printf '%s\n' "$MEMINFO" | grep '^MemFree:' | awk '{print $2}')
              # CPU: read /proc/stat twice with 1s sleep, single adb call
              STAT=$(adb_t "$ADB_ADDR" 'head -1 /proc/stat; sleep 1; head -1 /proc/stat' 2>/dev/null)
              CPU_PCT="null"
              if [ -n "$STAT" ]; then
                L1=$(printf '%s\n' "$STAT" | sed -n '1p')
                L2=$(printf '%s\n' "$STAT" | sed -n '2p')
                if [ -n "$L1" ] && [ -n "$L2" ]; then
                  T1=$(printf '%s\n' "$L1" | awk '{print $2+$3+$4+$5+$6+$7+$8+$9}')
                  I1=$(printf '%s\n' "$L1" | awk '{print $5+$6}')
                  T2=$(printf '%s\n' "$L2" | awk '{print $2+$3+$4+$5+$6+$7+$8+$9}')
                  I2=$(printf '%s\n' "$L2" | awk '{print $5+$6}')
                  DT=$((T2 - T1)); DI=$((I2 - I1))
                  if [ "$DT" -gt 0 ] 2>/dev/null; then
                    CPU_PCT=$(awk -v dt="$DT" -v di="$DI" 'BEGIN{printf "%.1f", 100.0*(1.0 - di/dt)}')
                  fi
                fi
              fi
              BODY=$(printf '%s' "$DEV" | jq -c --argjson apps "$APPS" --arg ram_total "${RAM_TOTAL:-0}" --arg ram_avail "${RAM_AVAIL:-0}" --arg cpu_pct "$CPU_PCT" '. + {detail: {apps: $apps, ram: {total_kb: ($ram_total|tonumber), available_kb: ($ram_avail|tonumber)}, cpu_percent: (if $cpu_pct=="null" then null else ($cpu_pct|tonumber) end)}}')
            else
              BODY=$(printf '%s' "$DEV" | jq -c '. + {detail: null}')
            fi
          else
            BODY="$DEV"
          fi
        else
          STATUS="404 Not Found"; BODY="{\"error\":\"not_found\",\"ip\":\"$IP\"}"
        fi
      else
        if [ "$DETAIL" = "1" ]; then
          STATUS="400 Bad Request"; BODY='{"error":"detail_requires_ip"}'
        else
          BODY="$CACHE"
        fi
      fi
      ;;
    /targets/add|/targets/delete)
      if [ "$METHOD" != POST ]; then
        STATUS="405 Method Not Allowed"; BODY='{"error":"method_not_allowed"}'
      else
        DATA=$(cat)
        if ! printf '%s' "$DATA" | jq -e 'type == "object"' >/dev/null 2>&1; then
          STATUS="400 Bad Request"; BODY='{"error":"invalid_json"}'
        else
          IP=$(printf '%s' "$DATA" | jq -r '.ip // empty' 2>/dev/null)
          if ! printf '%s\n' "$IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || ! printf '%s\n' "$IP" | awk -F. '{for(i=1;i<=4;i++) if($i<0 || $i>255) exit 1}'; then
            STATUS="400 Bad Request"; BODY='{"error":"invalid_ip"}'
          elif [ "$PATH_INFO" = /targets/delete ]; then
            if ! jq -e --arg ip "$IP" 'any(.[]; .ip==$ip)' "$TARGETS_FILE" >/dev/null 2>&1; then
              STATUS="404 Not Found"; BODY='{"error":"not_found"}'
            else
              cp "$TARGETS_FILE" "$TARGETS_FILE.bak.$(date +%Y%m%d-%H%M%S)" || { STATUS="500 Internal Server Error"; BODY='{"error":"backup_failed"}'; }
              if [ "$STATUS" = "200 OK" ]; then
                TMP="$TARGETS_FILE.tmp.$$"
                if jq --arg ip "$IP" 'map(select(.ip!=$ip))' "$TARGETS_FILE" > "$TMP" && mv "$TMP" "$TARGETS_FILE"; then BODY='{"ok":true}'; else rm -f "$TMP"; STATUS="500 Internal Server Error"; BODY='{"error":"write_failed"}'; fi
              fi
            fi
          else
            NAME=$(printf '%s' "$DATA" | jq -r '.nama // empty' 2>/dev/null); [ -n "$NAME" ] || NAME="$IP"
            PORT=$(printf '%s' "$DATA" | jq -r '.port_adb // 5555' 2>/dev/null)
            if ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$' || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
              STATUS="400 Bad Request"; BODY='{"error":"invalid_port"}'
            elif jq -e --arg ip "$IP" 'any(.[]; .ip==$ip)' "$TARGETS_FILE" >/dev/null 2>&1; then
              STATUS="409 Conflict"; BODY='{"error":"ip_duplicate"}'
            else
              cp "$TARGETS_FILE" "$TARGETS_FILE.bak.$(date +%Y%m%d-%H%M%S)" || { STATUS="500 Internal Server Error"; BODY='{"error":"backup_failed"}'; }
              if [ "$STATUS" = "200 OK" ]; then
                TMP="$TARGETS_FILE.tmp.$$"
                if jq --arg ip "$IP" --arg nama "$NAME" --argjson port "$PORT" '. + [{ip:$ip,nama:$nama,port_adb:$port}]' "$TARGETS_FILE" > "$TMP" && mv "$TMP" "$TARGETS_FILE"; then BODY='{"ok":true}'; else rm -f "$TMP"; STATUS="500 Internal Server Error"; BODY='{"error":"write_failed"}'; fi
              fi
            fi
          fi
        fi
      fi
      ;;
    *) STATUS="404 Not Found"; BODY='{"error":"not_found"}' ;;
  esac
fi

printf 'Status: %s\r\n' "$STATUS"
printf 'Access-Control-Allow-Origin: *\r\n'
printf 'Access-Control-Allow-Headers: Authorization, Content-Type\r\n'
printf 'Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n'
printf 'Content-Type: application/json\r\n'
printf 'Cache-Control: no-store\r\n\r\n'
printf '%s\n' "$BODY"
