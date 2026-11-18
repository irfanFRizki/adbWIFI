package com.irfanfrizki.telemetry.bridge

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.Settings
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import org.json.JSONObject

@CapacitorPlugin(
    name = "TelemetryBridge",
    permissions = [
        Permission(strings = ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"], alias = "location"),
        Permission(strings = ["android.permission.PACKAGE_USAGE_STATS"], alias = "usageStats"),
        Permission(strings = ["android.permission.POST_NOTIFICATIONS"], alias = "notifications"),
    ]
)
class TelemetryBridgePlugin : Plugin() {

    override fun load() {
        // Bridge is stateless; service lifecycle managed by TelemetryService
    }

    @PluginMethod
    fun startServer(call: PluginCall) {
        val config = JSONObject().apply {
            put("port", call.getInt("port", 8080))
            put("wsPort", call.getInt("wsPort", 8081))
            put("token", call.getString("token", ""))
            put("bindAll", call.getBoolean("bindAll", true))
            put("intervalSec", call.getInt("intervalSec", 2))
        }
        TelemetryService.start(getContext(), config)
        call.resolve()
    }

    @PluginMethod
    fun stopServer(call: PluginCall) {
        TelemetryService.stop(getContext())
        call.resolve()
    }

    @PluginMethod
    fun getServerStatus(call: PluginCall) {
        val running = TelemetryService.isRunning()
        val wsUrl = TelemetryService.getWsUrl()
        call.resolve(JSONObject().apply {
            put("running", running)
            put("wsUrl", wsUrl ?: "")
        })
    }

    @PluginMethod
    fun getData(call: PluginCall) {
        val data = TelemetryService.getData()
        if (data != null) {
            call.resolve(data)
        } else {
            call.reject("No data available")
        }
    }

    @PluginMethod
    fun getWsUrl(call: PluginCall) {
        call.resolve(JSONObject().put("url", TelemetryService.getWsUrl() ?: ""))
    }

    @PluginMethod
    fun requestPermissions(call: PluginCall) {
        val results = JSONObject()
        val activity = getActivity()

        // Location
        val locGranted = requestPermission("location", 1001)
        results.put("location", locGranted)

        // Usage stats requires settings screen
        val usageGranted = hasUsageStatsPermission()
        if (!usageGranted) {
            openUsageAccessSettings(activity)
        }
        results.put("usageStats", usageGranted)

        // Notifications
        val notifGranted = requestPermission("notifications", 1002)
        results.put("notifications", notifGranted)

        call.resolve(results)
    }

    @PluginMethod
    fun hasUsageStatsPermission(call: PluginCall) {
        call.resolve(JSONObject().put("granted", hasUsageStatsPermission()))
    }

    @PluginMethod
    fun openUsageAccessSettings(call: PluginCall) {
        val activity = getActivity()
        openUsageAccessSettings(activity)
        call.resolve()
    }

    private fun hasUsageStatsPermission(): Boolean {
        val appOps = getContext().getSystemService(android.content.Context.APP_OPS_SERVICE) as android.app.AppOpsManager
        val mode = appOps.checkOpNoThrow(
            android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
            android.os.Process.myUid(),
            getContext().packageName
        )
        return mode == android.app.AppOpsManager.MODE_ALLOWED
    }

    private fun openUsageAccessSettings(activity: Activity?) {
        activity?.startActivity(
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}