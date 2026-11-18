package com.irfanfrizki.telemetry.bridge

import android.app.Activity
import android.app.AppOpsManager
import android.content.Context
import android.content.Intent
import android.os.Process
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

@CapacitorPlugin(
    name = "TelemetryBridge",
    permissions = [
        Permission(strings = ["android.permission.ACCESS_FINE_LOCATION", "android.permission.ACCESS_COARSE_LOCATION"], alias = "location"),
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
        TelemetryService.start(context, config)
        call.resolve()
    }

    @PluginMethod
    fun stopServer(call: PluginCall) {
        TelemetryService.stop(context)
        call.resolve()
    }

    @PluginMethod
    fun getServerStatus(call: PluginCall) {
        val result = JSObject()
        result.put("running", TelemetryService.isRunning())
        result.put("wsUrl", TelemetryService.getWsUrl() ?: "")
        call.resolve(result)
    }

    @PluginMethod
    fun getData(call: PluginCall) {
        val data = TelemetryService.getData()
        if (data != null) {
            try {
                call.resolve(JSObject.fromJSONObject(data))
            } catch (e: Exception) {
                call.reject("Failed to read data: ${e.message}")
            }
        } else {
            call.reject("No data available")
        }
    }

    @PluginMethod
    fun getWsUrl(call: PluginCall) {
        val result = JSObject()
        result.put("url", TelemetryService.getWsUrl() ?: "")
        call.resolve(result)
    }

    /**
     * Overrides Plugin.requestPermissions so that the JS call returns a simple
     * { location, usageStats, notifications } map and also opens the Usage Access
     * settings screen (usage stats cannot be granted via a runtime dialog).
     */
    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        requestPermissionForAliases(arrayOf("location", "notifications"), call, "permissionsCallback")
    }

    @PermissionCallback
    private fun permissionsCallback(call: PluginCall) {
        val usageGranted = checkUsageStatsPermission()
        if (!usageGranted) {
            launchUsageAccessSettings(activity)
        }
        val result = JSObject()
        result.put("location", getPermissionState("location") == PermissionState.GRANTED)
        result.put("usageStats", usageGranted)
        result.put("notifications", getPermissionState("notifications") == PermissionState.GRANTED)
        call.resolve(result)
    }

    @PluginMethod
    fun hasUsageStatsPermission(call: PluginCall) {
        val result = JSObject()
        result.put("granted", checkUsageStatsPermission())
        call.resolve(result)
    }

    @PluginMethod
    fun openUsageAccessSettings(call: PluginCall) {
        launchUsageAccessSettings(activity)
        call.resolve()
    }

    private fun checkUsageStatsPermission(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = appOps.checkOpNoThrow(
            AppOpsManager.OPSTR_GET_USAGE_STATS,
            Process.myUid(),
            context.packageName
        )
        return mode == AppOpsManager.MODE_ALLOWED
    }

    private fun launchUsageAccessSettings(activity: Activity?) {
        activity?.startActivity(
            Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
    }
}
