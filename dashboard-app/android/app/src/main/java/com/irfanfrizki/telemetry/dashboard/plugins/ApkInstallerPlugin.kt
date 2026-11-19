package com.irfanfrizki.telemetry.dashboard.plugins

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File

@CapacitorPlugin(name = "ApkInstaller")
class ApkInstallerPlugin : Plugin() {
    @PluginMethod
    fun canInstall(call: PluginCall) {
        val result = JSObject()
        result.put("value", Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
            activity.packageManager.canRequestPackageInstalls())
        call.resolve(result)
    }

    @PluginMethod
    fun requestInstallPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.packageManager.canRequestPackageInstalls()) {
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${activity.packageName}"))
            activity.startActivity(intent)
        }
        call.resolve()
    }

    @PluginMethod
    fun install(call: PluginCall) {
        val rawPath = call.getString("path")
        if (rawPath.isNullOrBlank()) {
            call.reject("Path APK kosong")
            return
        }
        val file = File(rawPath)
        if (!file.exists() || !file.isFile) {
            call.reject("File APK tidak ditemukan: $rawPath")
            return
        }
        try {
            val uri = FileProvider.getUriForFile(activity,
                "${activity.packageName}.fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("Gagal membuka installer", e)
        }
    }
}
