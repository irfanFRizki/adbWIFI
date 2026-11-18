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
                val intent = Intent(context, TelemetryService::class.java)
                intent.action = TelemetryService.ACTION_START
                context.startForegroundService(intent)
            }
        }
    }
}