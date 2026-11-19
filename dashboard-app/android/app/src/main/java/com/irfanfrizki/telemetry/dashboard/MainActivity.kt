package com.irfanfrizki.telemetry.dashboard

import android.os.Bundle
import com.getcapacitor.BridgeActivity
import com.irfanfrizki.telemetry.dashboard.plugins.ApkInstallerPlugin

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(ApkInstallerPlugin::class.java)
        super.onCreate(savedInstanceState)
    }
}
