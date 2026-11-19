package com.irfanfrizki.telemetry.server

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONObject

/**
 * Persisted root feature toggles. The dashboard reads these flags via /api/data -> root.features
 * and only renders root cards/actions the server owner has approved.
 */
object RootFeatures {
    private const val PREFS = "telemetry_root_features"

    // Keys must match the dashboard's feature ids exactly.
    val ALL = listOf(
        "screenshot",     // screenshot via screencap -p
        "foreground_app", // active app via dumpsys
        "ui_dump",        // screen text via uiautomator
        "process_list",   // full process list with CPU/RAM
        "battery_detail", // current_now, cycle_count, health
        "thermal",        // every thermal zone
        "cpu_detail",     // per-core freq, governor, GPU
        "network_detail", // /proc/net/tcp*, ARP table
        "data_usage",     // per-app data stats
        "remote_control", // input tap/swipe/text, app + system control
        "sensitive_data", // call log, SMS, app data size
        "wifi_passwords"  // saved WiFi passwords
    )

    // Defaults: useful, low-risk features on; sensitive/control off until explicitly approved.
    private val DEFAULTS = mapOf(
        "screenshot" to true,
        "foreground_app" to true,
        "ui_dump" to false,
        "process_list" to true,
        "battery_detail" to true,
        "thermal" to true,
        "cpu_detail" to true,
        "network_detail" to true,
        "data_usage" to false,
        "remote_control" to false,
        "sensitive_data" to false,
        "wifi_passwords" to false
    )

    private fun prefs(ctx: Context): SharedPreferences =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun isEnabled(ctx: Context, key: String): Boolean =
        prefs(ctx).getBoolean(key, DEFAULTS[key] ?: false)

    fun setEnabled(ctx: Context, key: String, value: Boolean) {
        prefs(ctx).edit().putBoolean(key, value).apply()
    }

    fun toJson(ctx: Context): JSONObject = JSONObject().apply {
        ALL.forEach { put(it, isEnabled(ctx, it)) }
    }

    fun anyEnabled(ctx: Context): Boolean = ALL.any { isEnabled(ctx, it) }

    fun label(key: String): String = when (key) {
        "screenshot" -> "Screenshot berkala"
        "foreground_app" -> "Aplikasi aktif (dumpsys)"
        "ui_dump" -> "Teks di layar (uiautomator)"
        "process_list" -> "Daftar proses + CPU/RAM"
        "battery_detail" -> "Detail baterai (arus, siklus, kesehatan)"
        "thermal" -> "Suhu semua sensor"
        "cpu_detail" -> "CPU per core + governor + GPU"
        "network_detail" -> "Koneksi aktif + tabel ARP"
        "data_usage" -> "Statistik data per aplikasi"
        "remote_control" -> "Kontrol jarak jauh (input, app, sistem)"
        "sensitive_data" -> "Data sensitif (panggilan, SMS, ukuran app)"
        "wifi_passwords" -> "Password WiFi tersimpan"
        else -> key
    }
}