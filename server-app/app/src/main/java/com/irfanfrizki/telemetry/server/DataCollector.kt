package com.irfanfrizki.telemetry.server

import android.app.ActivityManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.concurrent.TimeUnit

class DataCollector(private val context: Context) {

    companion object {
        private const val TAG = "DataCollector"
    }

    // ---- Lokasi realtime (listener) ----
    @Volatile private var lastLocation: Location? = null
    private var locationRegistered = false

    private val locationListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            val cur = lastLocation
            if (cur == null || isBetter(location, cur)) lastLocation = location
        }
        override fun onProviderEnabled(provider: String) {}
        override fun onProviderDisabled(provider: String) {}
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    }

    private fun isBetter(n: Location, c: Location): Boolean {
        val dt = n.time - c.time
        if (dt > 10_000) return true
        if (dt < -10_000) return false
        return n.accuracy <= c.accuracy || (n.provider == c.provider && dt >= 0)
    }

    /** Mulai menerima update lokasi tiap ~1 detik. Aman dipanggil berulang. */
    @Synchronized
    fun startLocationUpdates() {
        if (locationRegistered || !Perms.hasLocation(context)) return
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager? ?: return
        var any = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            try {
                if (lm.allProviders.contains(provider)) {
                    lm.requestLocationUpdates(provider, 1000L, 0f, locationListener, Looper.getMainLooper())
                    any = true
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "Location $provider denied: ${e.message}")
            } catch (e: Exception) {
                Log.w(TAG, "Location $provider failed: ${e.message}")
            }
        }
        locationRegistered = any
    }

    @Synchronized
    fun stopLocationUpdates() {
        try {
            val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager?
            lm?.removeUpdates(locationListener)
        } catch (_: Exception) {}
        locationRegistered = false
    }

    fun collect(): JSONObject {
        return try {
            JSONObject().apply {
                put("timestamp", System.currentTimeMillis())
                put("battery", collectBattery())
                put("location", collectLocation())
                put("system", collectSystem())
                put("network", collectNetwork())
                put("apps", collectApps())
                put("permissions", JSONObject().apply {
                    put("location", Perms.hasLocation(context))
                    put("usage", Perms.hasUsageAccess(context))
                })
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error collecting data", e)
            JSONObject().put("error", e.message ?: "error")
        }
    }

    private fun collectBattery(): JSONObject {
        val filter = IntentFilter(Intent.ACTION_BATTERY_CHANGED)
        val intent = context.registerReceiver(null, filter)

        val level = intent?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1) ?: -1
        val scale = intent?.getIntExtra(BatteryManager.EXTRA_SCALE, -1) ?: -1
        val pct = if (level >= 0 && scale > 0) (level * 100 / scale) else -1
        val status = intent?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val health = intent?.getIntExtra(BatteryManager.EXTRA_HEALTH, -1) ?: -1
        val tempTenths = intent?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) ?: 0
        val voltageMv = intent?.getIntExtra(BatteryManager.EXTRA_VOLTAGE, 0) ?: 0
        val currentMa = readCurrentMa()
        val technology = intent?.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY) ?: "—"
        val plugType = intent?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0

        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING || status == BatteryManager.BATTERY_STATUS_FULL

        return JSONObject().apply {
            put("level", pct)
            put("status", when (status) {
                BatteryManager.BATTERY_STATUS_CHARGING -> "charging"
                BatteryManager.BATTERY_STATUS_DISCHARGING -> "discharging"
                BatteryManager.BATTERY_STATUS_FULL -> "full"
                BatteryManager.BATTERY_STATUS_NOT_CHARGING -> "not_charging"
                else -> "unknown"
            })
            put("charging", charging)
            put("health", when (health) {
                BatteryManager.BATTERY_HEALTH_GOOD -> "good"
                BatteryManager.BATTERY_HEALTH_DEAD -> "dead"
                BatteryManager.BATTERY_HEALTH_OVERHEAT -> "overheat"
                BatteryManager.BATTERY_HEALTH_OVER_VOLTAGE -> "over_voltage"
                BatteryManager.BATTERY_HEALTH_UNSPECIFIED_FAILURE -> "failure"
                BatteryManager.BATTERY_HEALTH_COLD -> "cold"
                else -> "unknown"
            })
            put("temp", tempTenths / 10.0)
            put("voltageMv", voltageMv)
            // Signed mA: positive = charging in on most devices, negative = discharging; null if unsupported
            put("currentMa", currentMa ?: JSONObject.NULL)
            put("technology", technology)
            put("plugType", plugType)
            put("pluggedAc", plugType and BatteryManager.BATTERY_PLUGGED_AC != 0)
            put("pluggedUsb", plugType and BatteryManager.BATTERY_PLUGGED_USB != 0)
            put("pluggedWireless", plugType and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0)
        }
    }

    /**
     * Battery current in mA via BatteryManager properties (there is no EXTRA_CURRENT_NOW in the
     * sticky battery intent). Drivers report µA on most devices but mA on some; normalise.
     */
    private fun readCurrentMa(): Int? {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager? ?: return null
        var raw = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW)
        if (raw == 0 || raw == Int.MIN_VALUE) {
            raw = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CURRENT_AVERAGE)
        }
        if (raw == 0 || raw == Int.MIN_VALUE) return null
        return if (kotlin.math.abs(raw) >= 20000) raw / 1000 else raw
    }

    private fun collectLocation(): JSONObject {
        if (!Perms.hasLocation(context)) {
            return JSONObject().put("error", "Izin lokasi belum diberikan di HP Target")
        }
        startLocationUpdates() // lazy: jika izin baru diberikan setelah server berjalan

        val lm = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager?
            ?: return JSONObject().put("error", "LocationManager tidak tersedia")

        var loc: Location? = lastLocation
        if (loc == null) {
            try {
                for (p in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
                    val l = try { lm.getLastKnownLocation(p) } catch (_: IllegalArgumentException) { null }
                    if (l != null && (loc == null || l.time > loc.time)) loc = l
                }
            } catch (e: SecurityException) {
                return JSONObject().put("error", "Izin lokasi ditolak")
            }
        }

        if (loc == null) {
            val enabled = try {
                lm.isProviderEnabled(LocationManager.GPS_PROVIDER) || lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
            } catch (_: Exception) { true }
            return JSONObject().put(
                "error",
                if (!enabled) "Layanan lokasi (GPS) mati di HP Target" else "Menunggu sinyal lokasi..."
            )
        }

        val age = (System.currentTimeMillis() - loc.time).coerceAtLeast(0L)
        return JSONObject().apply {
            put("lat", loc.latitude)
            put("lon", loc.longitude)
            put("accuracy", loc.accuracy.toDouble())
            put("altitude", loc.altitude)
            put("speed", loc.speed.toDouble())
            put("provider", loc.provider ?: "")
            put("timestamp", loc.time)
            put("ageMs", age)
            put("stale", age > 60_000L)
        }
    }

    private fun collectSystem(): JSONObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
        val memInfo = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(memInfo)

        sampleCpu()

        val screenOn = try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager?
            pm?.isInteractive ?: false
        } catch (_: Exception) {
            false
        }

        val total = memInfo.totalMem
        val used = total - memInfo.availMem
        val ramPct = if (total > 0) Math.round(used * 100.0 / total).toInt() else 0

        return JSONObject().apply {
            put("ramTotal", total)
            put("ramAvail", memInfo.availMem)
            put("ramUsed", used)
            put("ramPct", ramPct)
            put("cpuLoad", cpuPct)          // persen 0..100, -1 = tidak tersedia
            put("cpuSource", cpuSource)     // "proc" (akurat) | "freq" (perkiraan) | "none"
            put("screenOn", screenOn)
            put("uptime", SystemClock.elapsedRealtime())
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("cpuCores", Runtime.getRuntime().availableProcessors())
        }
    }

    // ---- CPU ----
    private var prevTotal = 0L
    private var prevIdle = 0L
    private var cpuPct = -1.0
    private var cpuSource = "none"
    private var cpuAt = 0L

    /**
     * Android 8+ melarang aplikasi membaca /proc/stat, jadi dicoba dulu (akurat),
     * dan jika gagal diperkirakan dari frekuensi CPU saat ini vs min/max (perkiraan).
     * Tidak ada sleep: beban dihitung dari selisih dua pemanggilan berurutan.
     */
    @Synchronized
    private fun sampleCpu() {
        val now = SystemClock.elapsedRealtime()
        if (now - cpuAt < 500 && cpuSource != "none") return
        cpuAt = now

        val proc = readProcStat()
        if (proc != null) {
            val (total, idle) = proc
            if (prevTotal > 0 && total > prevTotal) {
                val dT = total - prevTotal
                val dI = idle - prevIdle
                cpuPct = ((1.0 - dI.toDouble() / dT) * 100.0).coerceIn(0.0, 100.0)
                cpuSource = "proc"
                prevTotal = total; prevIdle = idle
                return
            }
            prevTotal = total; prevIdle = idle
        }

        val f = readFreqLoad()
        if (f != null) {
            cpuPct = f; cpuSource = "freq"
        } else if (cpuSource != "proc") {
            cpuPct = -1.0; cpuSource = "none"
        }
    }

    private fun readProcStat(): Pair<Long, Long>? {
        return try {
            val line = File("/proc/stat").bufferedReader().use { it.readLine() } ?: return null
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 5 || parts[0] != "cpu") return null
            val nums = parts.drop(1).take(8).map { it.toLong() }
            val idle = nums[3] + nums.getOrElse(4) { 0L }
            Pair(nums.sum(), idle)
        } catch (_: Exception) {
            null
        }
    }

    private fun readLongFile(path: String): Long? =
        try { File(path).readText().trim().toLong() } catch (_: Exception) { null }

    private fun readFreqLoad(): Double? {
        var sum = 0.0
        var n = 0
        for (i in 0 until Runtime.getRuntime().availableProcessors()) {
            val base = "/sys/devices/system/cpu/cpu$i/cpufreq/"
            val cur = readLongFile(base + "scaling_cur_freq") ?: continue
            val max = readLongFile(base + "cpuinfo_max_freq") ?: readLongFile(base + "scaling_max_freq") ?: continue
            val min = readLongFile(base + "cpuinfo_min_freq") ?: 0L
            if (max <= min) continue
            sum += ((cur - min).toDouble() / (max - min)).coerceIn(0.0, 1.0)
            n++
        }
        return if (n > 0) sum / n * 100.0 else null
    }

    private fun collectNetwork(): JSONObject {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager?
        val wifiManager = context.getSystemService(Context.WIFI_SERVICE) as WifiManager?
        val info = wifiManager?.connectionInfo

        var ipLocal = "—"
        var rssi = -1
        var bssid = "—"
        var ssid = "—"

        if (info != null) {
            val ipInt = info.ipAddress
            if (ipInt != 0) {
                ipLocal = "${(ipInt and 0xFF)}.${(ipInt shr 8 and 0xFF)}.${(ipInt shr 16 and 0xFF)}.${(ipInt shr 24 and 0xFF)}"
            }
            rssi = info.rssi
            bssid = info.bssid ?: "—"
            ssid = info.ssid.replace("\"", "")
        }

        // Also try to get IPv4 via NetworkInterface for non-wifi
        if (ipLocal == "—") {
            try {
                val interfaces = NetworkInterface.getNetworkInterfaces()
                while (interfaces.hasMoreElements()) {
                    val ni = interfaces.nextElement()
                    if (!ni.isLoopback && ni.isUp) {
                        val addresses = ni.inetAddresses
                        while (addresses.hasMoreElements()) {
                            val addr = addresses.nextElement()
                            if (addr is Inet4Address && !addr.isLoopbackAddress) {
                                ipLocal = addr.hostAddress
                                break
                            }
                        }
                    }
                }
            } catch (_: Exception) {}
        }

        val networkInfo = cm?.activeNetworkInfo
        val networkType = when (networkInfo?.type) {
            ConnectivityManager.TYPE_WIFI -> "WIFI"
            ConnectivityManager.TYPE_MOBILE -> "MOBILE"
            ConnectivityManager.TYPE_ETHERNET -> "ETHERNET"
            else -> networkInfo?.typeName ?: "—"
        }

        return JSONObject().apply {
            put("wifiSsid", if (networkInfo?.type == ConnectivityManager.TYPE_WIFI) ssid else "—")
            put("ipLocal", ipLocal)
            put("ipPublic", "unknown")
            put("rssi", rssi)
            put("bssid", bssid)
            put("networkType", networkType)
            put("isConnected", networkInfo?.isConnected ?: false)
        }
    }

    private var appsCache = JSONArray()
    private var appsCacheAt = 0L

    /**
     * Aplikasi yang sedang di layar (dari UsageEvents) + aplikasi yang baru dipakai.
     * Butuh izin "Akses Penggunaan" dan QUERY_ALL_PACKAGES (Android 11+ menyembunyikan app lain).
     */
    @Synchronized
    @Suppress("DEPRECATION")
    private fun collectApps(): JSONArray {
        val now = System.currentTimeMillis()
        if (now - appsCacheAt < 1500) return appsCache
        appsCacheAt = now

        val arr = JSONArray()
        if (!Perms.hasUsageAccess(context)) {
            appsCache = arr
            return arr
        }

        try {
            val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager?
            if (usm == null) { appsCache = arr; return arr }
            val pm = context.packageManager

            // 1) Aplikasi foreground saat ini: event terakhir RESUMED tanpa PAUSED sesudahnya
            var fgPkg: String? = null
            val seen = HashMap<String, Long>()
            val events = usm.queryEvents(now - TimeUnit.MINUTES.toMillis(30), now)
            val ev = UsageEvents.Event()
            while (events.hasNextEvent()) {
                events.getNextEvent(ev)
                when (ev.eventType) {
                    UsageEvents.Event.MOVE_TO_FOREGROUND -> { fgPkg = ev.packageName; seen[ev.packageName] = ev.timeStamp }
                    UsageEvents.Event.MOVE_TO_BACKGROUND -> {
                        if (fgPkg == ev.packageName) fgPkg = null
                        seen[ev.packageName] = ev.timeStamp
                    }
                }
            }

            // 2) Statistik harian untuk daftar "baru dipakai"
            val stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - TimeUnit.DAYS.toMillis(1), now)
            val fgTime = HashMap<String, Long>()
            if (stats != null) {
                for (us in stats) {
                    if (us.lastTimeUsed > 0) {
                        seen[us.packageName] = maxOf(seen[us.packageName] ?: 0L, us.lastTimeUsed)
                        fgTime[us.packageName] = us.totalTimeInForeground
                    }
                }
            }

            val ordered = seen.entries
                .filter { it.key != context.packageName || it.key == fgPkg }
                .sortedWith(compareByDescending<Map.Entry<String, Long>> { it.key == fgPkg }.thenByDescending { it.value })

            for ((pkg, last) in ordered) {
                if (arr.length() >= 12) break
                val name = try {
                    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
                } catch (_: Exception) { pkg }
                if (name.isBlank()) continue
                arr.put(JSONObject().apply {
                    put("package", pkg)
                    put("name", name)
                    put("foreground", pkg == fgPkg)
                    put("lastTimeUsed", if (pkg == fgPkg) now else last)
                    put("totalTimeInForeground", fgTime[pkg] ?: 0L)
                })
            }
        } catch (e: SecurityException) {
            Log.w(TAG, "UsageStats permission denied")
        } catch (e: Exception) {
            Log.w(TAG, "collectApps failed: ${e.message}")
        }

        appsCache = arr
        return arr
    }
}
