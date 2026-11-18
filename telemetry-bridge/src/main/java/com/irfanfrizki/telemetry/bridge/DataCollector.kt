package com.irfanfrizki.telemetry.bridge

import android.app.ActivityManager
import android.app.AppOpsManager
import android.app.usage.UsageStats
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkInfo
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.BatteryManager
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.net.NetworkInterface
import java.util.*
import java.util.concurrent.TimeUnit

class DataCollector(private val context: Context) {

    private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager?
    private val batteryReceiver: BroadcastReceiver? = null

    fun collect(): JSONObject {
        return try {
            JSONObject().apply {
                put("timestamp", System.currentTimeMillis())
                put("battery", collectBattery())
                put("location", collectLocation())
                put("system", collectSystem())
                put("network", collectNetwork())
                put("apps", collectApps())
            }
        } catch (e: Exception) {
            Log.e("DataCollector", "Error collecting data", e)
            JSONObject().put("error", e.message)
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
        val currentUa = intent?.getIntExtra(BatteryManager.EXTRA_CURRENT_NOW, -1) ?: -1
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
            put("currentMa", if (currentUa > 0) currentUa / 1000 else -1)
            put("technology", technology)
            put("plugType", plugType)
            put("pluggedAc", plugType and BatteryManager.BATTERY_PLUGGED_AC != 0)
            put("pluggedUsb", plugType and BatteryManager.BATTERY_PLUGGED_USB != 0)
            put("pluggedWireless", plugType and BatteryManager.BATTERY_PLUGGED_WIRELESS != 0)
        }
    }

    private fun collectLocation(): JSONObject {
        val lm = context.getSystemService(Context.LOCATION_SERVICE) as android.location.LocationManager?
        if (lm == null) return JSONObject().put("error", "LocationManager not available")

        var last: android.location.Location? = null
        try {
            val providers = lm.allProviders
            for (provider in providers) {
                if (provider == android.location.LocationManager.GPS_PROVIDER ||
                    provider == android.location.LocationManager.NETWORK_PROVIDER ||
                    provider == android.location.LocationManager.PASSIVE_PROVIDER) {
                    val perm = android.content.pm.PackageManager.PERMISSION_GRANTED
                    val fine = context.checkSelfPermission(android.Manifest.permission.ACCESS_FINE_LOCATION)
                    val coarse = context.checkSelfPermission(android.Manifest.permission.ACCESS_COARSE_LOCATION)
                    if (fine == perm || coarse == perm) {
                        val loc = lm.getLastKnownLocation(provider)
                        if (loc != null && (last == null || loc.time > last.time)) {
                            last = loc
                        }
                    }
                }
            }
        } catch (e: SecurityException) {
            return JSONObject().put("error", "Location permission denied")
        }

        return if (last != null) {
            JSONObject().apply {
                put("lat", last.latitude)
                put("lon", last.longitude)
                put("accuracy", last.accuracy)
                put("altitude", last.altitude)
                put("speed", last.speed)
                put("provider", last.provider)
                put("timestamp", last.time)
            }
        } else {
            JSONObject().put("error", "No location available")
        }
    }

    private fun collectSystem(): JSONObject {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager?
        val memInfo = ActivityManager.MemoryInfo()
        am?.getMemoryInfo(memInfo)

        var cpuLoad = 0.0
        try {
            cpuLoad = readCpuUsage()
        } catch (_: Exception) {}

        val screenOn = try {
            val pm = context.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager?
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pm?.isScreenEnabled ?: false
            else pm?.isInteractive ?: false
        } catch (_: Exception) {
            false
        }

        val uptime = SystemClock.elapsedRealtime()

        return JSONObject().apply {
            put("ramTotal", memInfo.totalMem.toLong())
            put("ramAvail", memInfo.availMem.toLong())
            put("ramUsed", (memInfo.totalMem - memInfo.availMem).toLong())
            put("cpuLoad", cpuLoad * 100.0)
            put("screenOn", screenOn)
            put("uptime", uptime)
            put("model", Build.MODEL)
            put("manufacturer", Build.MANUFACTURER)
            put("androidVersion", Build.VERSION.RELEASE)
            put("sdkInt", Build.VERSION.SDK_INT)
            put("cpuCores", Runtime.getRuntime().availableProcessors())
        }
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

    private fun collectApps(): JSONArray {
        val arr = JSONArray()
        val pm = context.packageManager

        try {
            val usageStatsManager = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager?
            if (usageStatsManager == null) return arr

            val endTime = System.currentTimeMillis()
            val beginTime = endTime - TimeUnit.DAYS.toMillis(1)
            val stats = usageStatsManager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, beginTime, endTime)
            if (stats != null) {
                val sorted = stats.sortedByDescending { it.lastTimeUsed }
                for (us in sorted.take(15)) {
                    try {
                        val appInfo = pm.getApplicationInfo(us.packageName, 0)
                        val name = pm.getApplicationLabel(appInfo).toString()
                        if (!name.isBlank() && us.lastTimeUsed > 0) {
                            arr.put(JSONObject().apply {
                                put("package", us.packageName)
                                put("name", name)
                                put("lastTimeUsed", us.lastTimeUsed)
                                put("totalTimeInForeground", us.totalTimeInForeground)
                            })
                        }
                    } catch (_: PackageManager.NameNotFoundException) {}
                }
            }
        } catch (e: SecurityException) {
            Log.w("DataCollector", "UsageStats permission denied")
        }

        return arr
    }

    private fun readCpuUsage(): Double {
        return try {
            val stat1 = File("/proc/stat").readText()
            val parts1 = stat1.lines().first().split("\\s+".toRegex()).drop(1).map { it.toLong() }
            val idle1 = parts1[3] + parts1[4]
            val total1 = parts1.sum()
            Thread.sleep(200)
            val stat2 = File("/proc/stat").readText()
            val parts2 = stat2.lines().first().split("\\s+".toRegex()).drop(1).map { it.toLong() }
            val idle2 = parts2[3] + parts2[4]
            val total2 = parts2.sum()
            val idleDelta = idle2 - idle1
            val totalDelta = total2 - total1
            if (totalDelta == 0) 0.0 else 1.0 - (idleDelta.toDouble() / totalDelta)
        } catch (_: Exception) {
            0.0
        }
    }
}