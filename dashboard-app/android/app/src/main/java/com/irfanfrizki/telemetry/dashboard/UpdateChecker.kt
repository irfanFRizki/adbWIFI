package com.irfanfrizki.telemetry.dashboard

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Pengecek update APK Dashboard dari GitHub Releases (repo PUBLIC). */
class UpdateChecker(
    private val activity: Activity,
    private val onStatus: (String) -> Unit
) {
    data class Release(
        val version: String,
        val downloadUrl: String,
        val notes: String
    )

    private val main = Handler(Looper.getMainLooper())
    private val apiUrl = "https://api.github.com/repos/irfanFRizki/adbWIFI/releases/latest"

    fun currentVersion(): String = try {
        activity.packageManager
            .getPackageInfo(activity.packageName, 0)
            .versionName ?: "0"
    } catch (_: Exception) {
        "0"
    }

    /** Cek update di background thread. */
    fun check(silent: Boolean, onResult: (Release?) -> Unit) {
        Thread {
            try {
                val release = fetchLatest()
                main.post { onResult(release) }
            } catch (e: Exception) {
                if (!silent) {
                    main.post { onStatus("Gagal cek update: ${e.message ?: "kesalahan jaringan"}") }
                }
                main.post { onResult(null) }
            }
        }.start()
    }

    private fun fetchLatest(): Release? {
        val conn = (URL(apiUrl).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15000
            readTimeout = 15000
            requestMethod = "GET"
            setRequestProperty("Accept", "application/vnd.github+json")
            setRequestProperty("User-Agent", "TelemetryDashboard-Android")
        }
        try {
            if (conn.responseCode !in 200..299) {
                throw IllegalStateException("HTTP ${conn.responseCode}")
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(body)
            val notes = root.optString("body", "")
            val assets = root.optJSONArray("assets") ?: return null

            var best: Release? = null
            for (i in 0 until assets.length()) {
                val asset = assets.getJSONObject(i)
                val name = asset.optString("name")
                // Asset Dashboard: "TelemetryDashboard-vX.Y.Z.apk"
                if (!name.startsWith("TelemetryDashboard-v") || !name.endsWith(".apk")) continue
                val version = name.removePrefix("TelemetryDashboard-v").removeSuffix(".apk")
                val url = asset.optString("browser_download_url")
                if (url.isBlank()) continue
                if (best == null || compareVersions(version, best!!.version) > 0) {
                    best = Release(version, url, notes)
                }
            }
            return best
        } finally {
            conn.disconnect()
        }
    }

    fun isNewer(remote: String): Boolean = compareVersions(remote, currentVersion()) > 0

    private fun compareVersions(a: String, b: String): Int {
        val pa = a.split(".").map { it.toIntOrNull() ?: 0 }
        val pb = b.split(".").map { it.toIntOrNull() ?: 0 }
        val n = maxOf(pa.size, pb.size)
        for (i in 0 until n) {
            val va = pa.getOrElse(i) { 0 }
            val vb = pb.getOrElse(i) { 0 }
            if (va != vb) return va.compareTo(vb)
        }
        return 0
    }

    /** Unduh APK ke cache eksternal, panggil onDone dengan file lokal. */
    fun download(release: Release, onProgress: (Int) -> Unit, onDone: (File?) -> Unit) {
        Thread {
            var file: File? = null
            try {
                val dir = File(activity.getExternalFilesDir(null), "updates").apply { mkdirs() }
                dir.listFiles()?.forEach { it.delete() }
                val target = File(dir, "TelemetryDashboard-v${release.version}.apk")

                val conn = (URL(release.downloadUrl).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20000
                    readTimeout = 60000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "TelemetryDashboard-Android")
                }
                if (conn.responseCode !in 200..299) {
                    throw IllegalStateException("HTTP ${conn.responseCode}")
                }
                val total = conn.contentLengthLong
                var read = 0L
                var lastPct = -1

                conn.inputStream.use { input ->
                    FileOutputStream(target).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            read += n
                            if (total > 0) {
                                val pct = ((read * 100) / total).toInt()
                                if (pct != lastPct) {
                                    lastPct = pct
                                    main.post { onProgress(pct) }
                                }
                            }
                        }
                        out.flush()
                    }
                }
                conn.disconnect()
                file = target
            } catch (e: Exception) {
                main.post { onStatus("Gagal unduh: ${e.message ?: "kesalahan jaringan"}") }
                file = null
            } finally {
                val result = file
                main.post { onDone(result) }
            }
        }.start()
    }

    /** Pasang APK. Return false kalau izin "install unknown apps" belum diberikan. */
    fun install(apk: File): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()
        ) {
            onStatus("Izinkan pemasangan aplikasi dari Telemetry Dashboard")
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}")
                    )
                )
            } catch (_: Exception) {
                activity.startActivity(Intent(Settings.ACTION_SECURITY_SETTINGS))
            }
            return false
        }

        val uri = FileProvider.getUriForFile(
            activity,
            "${activity.packageName}.fileprovider",
            apk
        )
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        activity.startActivity(intent)
        return true
    }
}

/** Jembatan JavaScript <-> Native untuk update APK.
 *  Dipasang ke WebView via webView.addJavascriptInterface(UpdateBridge(webView, this), "AndroidUpdate").
 *  JS memanggil: AndroidUpdate.checkUpdate(), AndroidUpdate.downloadAndInstall(url, version, fileName). */
class UpdateBridge(
    private val webView: WebView,
    private val activity: Activity
) {
    private val checker = UpdateChecker(activity) { msg ->
        // Lapor status ke JS via evaluateJavascript
        val js = "typeof window._onUpdateStatus === 'function' && window._onUpdateStatus("
            + JSONObject().put("state", "error").put("message", msg).toString() + ")"
        webView.post { webView.evaluateJavascript(js, null) }
    }

    @JavascriptInterface
    fun checkUpdate() {
        checker.check(silent = false) { release ->
            if (release == null) {
                postStatus("error", "cek-versi", "Tidak ada update tersedia atau gagal mengambil rilis.")
                return@check
            }
            if (!checker.isNewer(release.version)) {
                postStatus("up-to-date", "cek-versi", "Versi terpasang sudah terbaru (v${checker.currentVersion()})",
                    JSONObject().put("latestVersion", release.version).put("currentVersion", checker.currentVersion()))
                return@check
            }
            postStatus("update-available", "cek-versi", "Update tersedia v${release.version}",
                JSONObject().put("downloadUrl", release.downloadUrl)
                    .put("version", release.version)
                    .put("notes", release.notes))
        }
    }

    @JavascriptInterface
    fun downloadAndInstall(url: String, version: String, fileName: String) {
        // Unduh APK ke cache
        val dir = File(activity.getExternalFilesDir(null), "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val target = File(dir, fileName)

        val webViewRef = webView
        Thread {
            var downloaded: File? = null
            try {
                val conn = (URL(url).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 20000
                    readTimeout = 60000
                    instanceFollowRedirects = true
                    setRequestProperty("User-Agent", "TelemetryDashboard-Android")
                }
                if (conn.responseCode !in 200..299) {
                    throw IllegalStateException("HTTP ${conn.responseCode}")
                }
                val total = conn.contentLengthLong
                var read = 0L
                var lastPct = -1

                conn.inputStream.use { input ->
                    FileOutputStream(target).use { out ->
                        val buf = ByteArray(64 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n <= 0) break
                            out.write(buf, 0, n)
                            read += n
                            if (total > 0) {
                                val pct = ((read * 100) / total).toInt()
                                if (pct != lastPct) {
                                    lastPct = pct
                                    webViewRef.post {
                                        webViewRef.evaluateJavascript(
                                            "typeof window._onUpdateStatus === 'function' && window._onUpdateStatus("
                                                + JSONObject().put("state", "downloading").put("progress", pct).toString() + ")", null)
                                    }
                                }
                            }
                        }
                        out.flush()
                    }
                }
                conn.disconnect()
                downloaded = target
            } catch (e: Exception) {
                webViewRef.post {
                    webViewRef.evaluateJavascript(
                        "typeof window._onUpdateStatus === 'function' && window._onUpdateStatus("
                            + JSONObject().put("state", "error").put("phase", "download")
                            .put("message", "Gagal unduh: ${e.message ?: "kesalahan jaringan"}").toString() + ")", null)
                }
                return@Thread
            }

            // Buka installer
            webViewRef.post {
                val ok = checker.install(downloaded!!)
                if (!ok) {
                    webViewRef.evaluateJavascript(
                        "typeof window._onUpdateStatus === 'function' && window._onUpdateStatus("
                            + JSONObject().put("state", "error").put("phase", "install")
                            .put("message", "Izinkan pemasangan dari sumber tidak dikenal").toString() + ")", null)
                }
            }
        }.start()
    }

    private fun postStatus(state: String, phase: String, message: String, extra: JSONObject? = null) {
        val obj = JSONObject().put("state", state).put("phase", phase).put("message", message)
        extra?.keys()?.forEach { key -> obj.put(key, extra.get(key)) }
        val js = "typeof window._onUpdateStatus === 'function' && window._onUpdateStatus($obj)"
        webView.post { webView.evaluateJavascript(js, null) }
    }
}