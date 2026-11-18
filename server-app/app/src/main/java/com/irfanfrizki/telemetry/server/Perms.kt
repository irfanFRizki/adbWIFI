package com.irfanfrizki.telemetry.server

import android.Manifest
import android.app.AppOpsManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Process
import androidx.core.content.ContextCompat

/** Helper pengecekan izin, dipakai oleh MainActivity dan DataCollector. */
object Perms {
    private fun granted(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    fun hasFineLocation(ctx: Context): Boolean = granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasLocation(ctx: Context): Boolean =
        hasFineLocation(ctx) || granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)

    /** "Izinkan sepanjang waktu" (Android 10+). Di bawah itu otomatis dianggap ada. */
    fun hasBackgroundLocation(ctx: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.Q ||
            granted(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)

    @Suppress("DEPRECATION")
    fun hasUsageAccess(ctx: Context): Boolean {
        return try {
            val appOps = ctx.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            val mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), ctx.packageName
            )
            if (mode == AppOpsManager.MODE_DEFAULT) {
                // Beberapa ROM (mis. MIUI) mengembalikan MODE_DEFAULT padahal izin sudah diberikan
                ctx.checkCallingOrSelfPermission(Manifest.permission.PACKAGE_USAGE_STATS) ==
                    PackageManager.PERMISSION_GRANTED
            } else {
                mode == AppOpsManager.MODE_ALLOWED
            }
        } catch (_: Exception) {
            false
        }
    }
}
