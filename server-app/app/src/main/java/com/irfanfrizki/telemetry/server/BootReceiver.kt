package com.irfanfrizki.telemetry.server

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            Log.d("TelemetryServer", "Boot completed, checking autostart")
            val prefs = context.getSharedPreferences("telemetry_server", Context.MODE_PRIVATE)
            if (prefs.getBoolean("auto_start", true)) {
                // Same keys and defaults as MainActivity
                val port = prefs.getString("http_port", "8080")?.toIntOrNull() ?: 8080
                val wsPort = prefs.getString("ws_port", "8765")?.toIntOrNull() ?: 8765
                val token = prefs.getString("auth_token", "") ?: ""
                val interval = prefs.getString("update_interval", "5")?.toIntOrNull() ?: 5
                TelemetryService.start(context, port, wsPort, token, interval)
            }
        }
    }
}
