package com.irfanfrizki.telemetry.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.util.Log
import org.json.JSONObject

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if (action == "android.intent.action.BOOT_COMPLETED" ||
            action == "android.intent.action.QUICKBOOT_POWERON" ||
            action == "android.intent.action.MY_PACKAGE_REPLACED") {

            Log.i("BootReceiver", "Boot/replace detected, starting TelemetryService")

            val component = android.content.ComponentName(context, TelemetryService::class.java)
            context.packageManager.setComponentEnabledSetting(
                component, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP
            )

            val intentService = Intent(context, TelemetryService::class.java)
            intentService.action = "START_SERVER"
            intentService.putExtra("config", JSONObject().apply {
                put("port", 8080)
                put("wsPort", 8081)
                put("token", "")
                put("bindAll", true)
                put("intervalSec", 2)
            }.toString())

            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                context.startForegroundService(intentService)
            } else {
                context.startService(intentService)
            }
        }
    }
}