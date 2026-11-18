package com.irfanfrizki.telemetry.server

import android.app.Application
import android.content.Context

class TelemetryApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        @JvmStatic
        fun getContext(): Context? = instance?.applicationContext

        private var instance: TelemetryApplication? = null
    }
}