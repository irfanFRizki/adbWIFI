package com.irfanfrizki.telemetry.server

import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.io.File
import java.util.concurrent.TimeUnit

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

    /**
     * Cek status root untuk Magisk modern.
     * JANGAN cek File.exists() pada path su — Magisk menyembunyikannya dari app non-root.
     * Eksekusi "su -c id" langsung, itulah yang memicu dialog izin Magisk.
     */
    private fun computeRootStatus(context: Context): RootStatus {
        val output = executeRootCommandBlocking("id")
        val hasRootAccess = output?.contains("uid=0") == true

        val isMagisk = try {
            context.packageManager.getPackageInfo("com.topjohnwu.magisk", 0)
            true
        } catch (_: Exception) {
            File("/data/adb/magisk").exists() || File("/magisk").exists()
        }

        return when {
            isMagisk && hasRootAccess -> RootStatus.MAGISK_GRANTED
            isMagisk -> RootStatus.MAGISK_DENIED
            hasRootAccess -> RootStatus.GENERIC_SU
            else -> RootStatus.NONE
        }
    }

    /**
     * Jalankan perintah root lewat "su -c" di thread IO dengan timeout.
     * Output dibaca di thread terpisah supaya waitFor() tidak deadlock saat
     * Magisk menahan proses untuk menampilkan dialog izin.
     */
    private fun executeRootCommandBlocking(cmd: String): String? {
        return try {
            val process = Runtime.getRuntime().exec(arrayOf("su", "-c", cmd))

            val output = StringBuilder()
            val reader = BufferedReader(InputStreamReader(process.inputStream))
            val readerThread = Thread {
                try {
                    var line: String?
                    while (reader.readLine().also { line = it } != null) {
                        output.append(line).append('\n')
                    }
                } catch (_: Exception) {
                }
            }
            readerThread.start()

            val finished = process.waitFor(SU_TIMEOUT_MS, TimeUnit.MILLISECONDS)
            if (!finished) {
                process.destroyForcibly()
                Log.w(TAG, "su -c timeout: $cmd")
                return null
            }

            readerThread.join(200)

            if (process.exitValue() != 0) {
                val err = process.errorStream.bufferedReader().use { it.readText() }
                Log.w(TAG, "su -c exit ${process.exitValue()}: $cmd, err: $err")
                return null
            }

            output.toString().trim()
        } catch (e: Exception) {
            Log.w(TAG, "su -c failed: $cmd", e)
            null
        }
    }

    /** Jalankan banyak perintah root sekaligus (satu su session), return map cmd->output. */
    fun executeRootCommands(cmds: Array<String>): Map<String, String?> {
        val script = cmds.joinToString("\n")
        val output = executeRootCommandBlocking(script)
        if (output == null) return cmds.associateWith { null }
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
        val output = executeRootCommandBlocking("screencap -p")
        return output?.let { android.util.Base64.encodeToString(it.toByteArray(), android.util.Base64.NO_WRAP) }
    }

    /** Baris agregat "cpu ..." dari /proc/stat via root (app biasa diblokir SELinux di Android 8+). */
    fun readProcStatLineRoot(): String? =
        executeRootCommandBlocking("head -n 1 /proc/stat")?.lineSequence()?.firstOrNull { it.startsWith("cpu ") }

    /** Aplikasi foreground akurat via dumpsys window/activity. */
    fun getForegroundApp(): JSONObject? {
        val output = executeRootCommandBlocking("dumpsys window windows | grep -E 'mCurrentFocus|mFocusedApp' | head -1")
        val output2 = executeRootCommandBlocking("dumpsys activity top | grep -E 'ACTIVITY|Package' | head -3")
        val combined = "${output ?: ""}\n${output2 ?: ""}".trim()
        return if (combined.isNotBlank()) {
            JSONObject().put("raw", combined)
        } else null
    }

    /** UI dump (teks di layar) via uiautomator. */
    fun getUiDump(): String? {
        val tmpFile = "/data/local/tmp/uidump.xml"
        val cmd = "rm -f $tmpFile; uiautomator dump $tmpFile; cat $tmpFile"
        return executeRootCommandBlocking(cmd)
    }

    /** Daftar proses lengkap dengan RAM/CPU per aplikasi. */
    fun getProcessList(): JSONArray {
        val output = executeRootCommandBlocking("ps -A -o pid,ppid,user,pcpu,pmem,comm,args | head -50")
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
        val output = executeRootCommandBlocking("dumpsys meminfo $pkg")
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
            // voltage_now umumnya dalam µV (mis. 3818388); beberapa perangkat sudah mV
            voltageNow?.toLongOrNull()?.let { put("voltageMv", if (it > 100_000L) it / 1000 else it) }
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
            val c = temp?.toDoubleOrNull()?.div(1000.0)
            // Lewati sensor virtual/tidak valid (mis. "soc" = 0, level threshold pmi632-*-lvl*, nilai negatif)
            if (c != null && c > 0.5 && c < 150 && type?.contains("-lvl") != true) {
                arr.put(JSONObject().apply {
                    put("zone", zone.name)
                    put("type", type ?: "unknown")
                    put("tempC", Math.round(c * 10) / 10.0)
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
                    val parts = line.trim().split(Regex("\\s+"))
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
        val output = executeRootCommandBlocking("cat /proc/net/arp")
        val arr = JSONArray()
        output?.lines()?.drop(1)?.forEach { line ->
            val parts = line.trim().split(Regex("\\s+"))
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
        val output = executeRootCommandBlocking("cat /data/misc/wifi/WifiConfigStore.xml 2>/dev/null | grep -A2 -B2 'PreSharedKey'")
        val arr = JSONArray()
        output?.let { arr.put(JSONObject().put("raw", it)) }
        return arr
    }

    /** Statistik data per aplikasi (UID-based) via /proc/net/xt_qtaguid/stats. */
    fun getUidNetworkStats(): JSONArray {
        val output = executeRootCommandBlocking("cat /proc/net/xt_qtaguid/stats 2>/dev/null | head -30")
        val arr = JSONArray()
        output?.lines()?.drop(1)?.forEach { line ->
            val parts = line.trim().split(Regex("\\s+"))
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

    /** Riwayat panggilan. */
    fun getCallLog(): JSONArray {
        val output = executeRootCommandBlocking("content query --uri content://call_log/calls --projection number,date,duration,type,name --sort 'date DESC' | head -20")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.isNotBlank()) arr.put(line.trim())
        }
        return arr
    }

    /** SMS. */
    fun getSms(): JSONArray {
        val output = executeRootCommandBlocking("content query --uri content://sms --projection address,date,body,type --sort 'date DESC' | head -20")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.isNotBlank()) arr.put(line.trim())
        }
        return arr
    }

    /** Daftar aplikasi + ukuran data. */
    fun getInstalledAppsWithSize(): JSONArray {
        val output = executeRootCommandBlocking("pm list packages -s -U | head -30")
        val arr = JSONArray()
        output?.lines()?.forEach { line ->
            if (line.startsWith("package:")) {
                val pkg = line.substringAfter("package:")
                val sizeOut = executeRootCommandBlocking("du -sh /data/data/$pkg 2>/dev/null | cut -f1")
                arr.put(JSONObject().apply {
                    put("package", pkg)
                    put("dataSize", sizeOut ?: "unknown")
                })
            }
        }
        return arr
    }

    /** Kontrol jarak jauh: input tap/swipe/keyevent/text, am start/force-stop, pm grant/revoke, dll. */
    fun executeControl(action: String, extra: String = "", value: String = "", args: JSONObject = JSONObject()): Boolean {
        return when (action) {
            "tap" -> executeRootCommandBlocking("input tap ${args.optInt("x")} ${args.optInt("y")}") != null
            "swipe" -> executeRootCommandBlocking("input swipe ${args.optInt("x1")} ${args.optInt("y1")} ${args.optInt("x2")} ${args.optInt("y2")} ${args.optInt("duration", 300)}") != null
            "keyevent" -> executeRootCommandBlocking("input keyevent ${args.optInt("keycode")}") != null
            "text" -> executeRootCommandBlocking("input text ${args.optString("text").replace(" ", "%s")}") != null
            "start" -> executeRootCommandBlocking("am start -n $extra") != null
            "force-stop" -> executeRootCommandBlocking("am force-stop $extra") != null
            "grant" -> executeRootCommandBlocking("pm grant $extra ${args.optString("perm")}") != null
            "revoke" -> executeRootCommandBlocking("pm revoke $extra ${args.optString("perm")}") != null
            "clear" -> executeRootCommandBlocking("pm clear $extra") != null
            "screen_on" -> executeRootCommandBlocking("input keyevent KEYCODE_WAKEUP") != null
            "screen_off" -> executeRootCommandBlocking("input keyevent KEYCODE_SLEEP") != null
            "wifi" -> executeRootCommandBlocking("svc wifi ${value.lowercase()}") != null
            "airplane" -> executeRootCommandBlocking("settings put global airplane_mode_on ${if (value == "on") 1 else 0}; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${value == "on"}") != null
            "brightness" -> executeRootCommandBlocking("settings put system screen_brightness $value") != null
            "volume" -> executeRootCommandBlocking("media volume --stream 3 --set $value") != null
            "reboot" -> executeRootCommandBlocking("reboot") != null
            "adb_wifi_on" -> executeRootCommandBlocking("setprop service.adb.tcp.port 5555; stop adbd; start adbd") != null
            "adb_wifi_off" -> executeRootCommandBlocking("setprop service.adb.tcp.port -1; stop adbd; start adbd") != null
            else -> false
        }
    }

    // ===== Helper =====

    private fun readSysFile(path: String): String? {
        val direct = try {
            File(path).readText().trim().takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
        if (direct != null) return direct
        // Android 14+ SELinux: banyak node /sys (mis. power_supply) tidak terbaca app biasa -> baca via root
        return try {
            executeRootCommandBlocking("cat $path 2>/dev/null")?.trim()?.takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }

    private fun readProcStat(): Pair<Long, Long>? {
        return try {
            val line = File("/proc/stat").readText().lines().firstOrNull() ?: return null
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size >= 5) {
                val user = parts[1].toLongOrNull() ?: 0L
                val nice = parts[2].toLongOrNull() ?: 0L
                val system = parts[3].toLongOrNull() ?: 0L
                val idle = parts[4].toLongOrNull() ?: 0L
                val iowait = parts.getOrNull(5)?.toLongOrNull() ?: 0L
                val irq = parts.getOrNull(6)?.toLongOrNull() ?: 0L
                val softirq = parts.getOrNull(7)?.toLongOrNull() ?: 0L
                val steal = parts.getOrNull(8)?.toLongOrNull() ?: 0L
                val total = user + nice + system + idle + iowait + irq + softirq + steal
                total to idle
            } else null
        } catch (_: Exception) {
            null
        }
    }

    /** Kirim input (tap, swipe, keyevent, text). */
    fun sendInput(cmd: String): Boolean {
        return executeRootCommandBlocking("input $cmd") != null
    }

    /** Kontrol aplikasi (am start, am force-stop, pm grant/revoke). */
    fun controlApp(action: String, pkg: String, extra: String = ""): Boolean {
        return when (action) {
            "start" -> executeRootCommandBlocking("am start -n $extra") != null
            "force-stop" -> executeRootCommandBlocking("am force-stop $pkg") != null
            "grant" -> executeRootCommandBlocking("pm grant $pkg $extra") != null
            "revoke" -> executeRootCommandBlocking("pm revoke $pkg $extra") != null
            "clear" -> executeRootCommandBlocking("pm clear $pkg") != null
            else -> false
        }
    }

    /** Kontrol sistem: screen, wifi, airplane, brightness, volume, reboot. */
    fun controlSystem(action: String, value: String = ""): Boolean {
        return when (action) {
            "screen_on" -> executeRootCommandBlocking("input keyevent KEYCODE_WAKEUP") != null
            "screen_off" -> executeRootCommandBlocking("input keyevent KEYCODE_SLEEP") != null
            "wifi" -> executeRootCommandBlocking("svc wifi ${value.lowercase()}") != null
            "airplane" -> executeRootCommandBlocking("settings put global airplane_mode_on ${if (value == "on") 1 else 0}; am broadcast -a android.intent.action.AIRPLANE_MODE --ez state ${value == "on"}") != null
            "brightness" -> executeRootCommandBlocking("settings put system screen_brightness $value") != null
            "volume" -> executeRootCommandBlocking("media volume --stream 3 --set $value") != null
            "reboot" -> executeRootCommandBlocking("reboot") != null
            "adb_wifi_on" -> executeRootCommandBlocking("setprop service.adb.tcp.port 5555; stop adbd; start adbd") != null
            "adb_wifi_off" -> executeRootCommandBlocking("setprop service.adb.tcp.port -1; stop adbd; start adbd") != null
            else -> false
        }
    }

    private fun parseHexAddr(hex: String): String {
        return try {
            val parts = hex.split(":")
            if (parts.size != 2) return hex
            val ip = parts[0].let { java.lang.Long.parseLong(it, 16) }
            val port = parts[1].let { java.lang.Integer.parseInt(it, 16) }
            val octets = (3 downTo 0).map { (ip shr (it * 8)) and 0xFF }.joinToString(".")
            "$octets:$port"
        } catch (_: Exception) {
            hex
        }
    }
}
