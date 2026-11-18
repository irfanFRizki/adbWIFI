package com.irfanfrizki.telemetry.server

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.net.ConnectivityManager
import android.net.NetworkInfo
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Bundle
import android.text.TextUtils
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.textfield.TextInputEditText

class MainActivity : AppCompatActivity() {

    private lateinit var tvStatus: TextView
    private lateinit var tvLocalIp: TextView
    private lateinit var tvWsUrl: TextView
    private lateinit var btnCopyWsUrl: Button
    private lateinit var btnStart: Button
    private lateinit var btnStop: Button
    private lateinit var btnSave: Button
    private lateinit var etPort: TextInputEditText
    private lateinit var etWsPort: TextInputEditText
    private lateinit var etToken: TextInputEditText
    private lateinit var etInterval: TextInputEditText
    private lateinit var cbBindAll: MaterialCheckBox

    private val prefs: SharedPreferences by lazy {
        getSharedPreferences("telemetry_server", Context.MODE_PRIVATE)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        tvStatus = findViewById(R.id.tvStatus)
        tvLocalIp = findViewById(R.id.tvLocalIp)
        tvWsUrl = findViewById(R.id.tvWsUrl)
        btnCopyWsUrl = findViewById(R.id.btnCopyWsUrl)
        btnStart = findViewById(R.id.btnStart)
        btnStop = findViewById(R.id.btnStop)
        btnSave = findViewById(R.id.btnSave)
        etPort = findViewById(R.id.etPort)
        etWsPort = findViewById(R.id.etWsPort)
        etToken = findViewById(R.id.etToken)
        etInterval = findViewById(R.id.etInterval)
        cbBindAll = findViewById(R.id.cbBindAll)

        loadSettings()
        updateUI()

        btnStart.setOnClickListener { startServer() }
        btnStop.setOnClickListener { stopServer() }
        btnSave.setOnClickListener { saveSettings() }
        btnCopyWsUrl.setOnClickListener { copyWsUrl() }
    }

    private fun loadSettings() {
        etPort.setText(prefs.getString("http_port", "8080").toString())
        etWsPort.setText(prefs.getString("ws_port", "8765").toString())
        etToken.setText(prefs.getString("auth_token", ""))
        etInterval.setText(prefs.getString("update_interval", "5").toString())
        cbBindAll.isChecked = prefs.getBoolean("bind_all", true)
    }

    private fun saveSettings() {
        val port = etPort.text.toString().toIntOrNull() ?: 8080
        val wsPort = etWsPort.text.toString().toIntOrNull() ?: 8765
        val token = etToken.text.toString()
        val interval = etInterval.text.toString().toIntOrNull() ?: 5

        prefs.edit {
            putString("http_port", port.toString())
            putString("ws_port", wsPort.toString())
            putString("auth_token", token)
            putString("update_interval", interval.toString())
            putBoolean("bind_all", cbBindAll.isChecked)
        }
        Toast.makeText(this, getString(R.string.saved), Toast.LENGTH_SHORT).show()
    }

    private fun startServer() {
        val port = etPort.text.toString().toIntOrNull() ?: 8080
        val wsPort = etWsPort.text.toString().toIntOrNull() ?: 8765
        val token = etToken.text.toString()
        val interval = etInterval.text.toString().toIntOrNull() ?: 5

        TelemetryService.start(this, port, wsPort, token, interval)
        updateUI()
    }

    private fun stopServer() {
        TelemetryService.stop(this)
        updateUI()
    }

    private fun updateUI() {
        val running = TelemetryService.isRunning()
        tvStatus.text = if (running) getString(R.string.server_running) else getString(R.string.server_stopped)
        tvStatus.setTextColor(if (running) android.graphics.Color.GREEN else android.graphics.Color.RED)

        btnStart.isEnabled = !running
        btnStop.isEnabled = running

        val ip = getLocalIpAddress()
        tvLocalIp.text = "${getString(R.string.local_ip)}: $ip"
        tvWsUrl.text = if (running && ip != null) "ws://$ip:${getWsPort()}/ws" else getString(R.string.ws_url)
    }

    private fun copyWsUrl() {
        val url = tvWsUrl.text.toString()
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        val clip = android.content.ClipData.newPlainText("ws_url", url)
        clipboard.setPrimaryClip(clip)
        Toast.makeText(this, getString(R.string.copied), Toast.LENGTH_SHORT).show()
    }

    private fun getLocalIpAddress(): String? {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val ni = cm.activeNetworkInfo ?: return null
        if (!ni.isConnected) return null

        val wm = getSystemService(Context.WIFI_SERVICE) as WifiManager
        val wifiInfo = wm.connectionInfo
        val ipInt = wifiInfo.ipAddress
        return if (ipInt != 0) {
            (ipInt and 0xFF).toString() + "." +
                    ((ipInt shr 8) and 0xFF).toString() + "." +
                    ((ipInt shr 16) and 0xFF).toString() + "." +
                    ((ipInt shr 24) and 0xFF).toString()
        } else null
    }

    private fun getWsPort(): String {
        return prefs.getString("ws_port", "8765")!!
    }
}