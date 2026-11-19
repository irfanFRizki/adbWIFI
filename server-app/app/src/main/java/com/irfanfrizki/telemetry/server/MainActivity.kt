package com.irfanfrizki.telemetry.server

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.Manifest
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import androidx.appcompat.app.AlertDialog
import androidx.core.app.ActivityCompat
import android.net.ConnectivityManager
import android.net.NetworkInfo
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Bundle
import android.text.TextUtils
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.edit
import com.google.android.material.checkbox.MaterialCheckBox
import com.google.android.material.textfield.TextInputEditText
import com.irfanfrizki.telemetry.server.RootManager
import com.irfanfrizki.telemetry.server.RootFeatures
import com.irfanfrizki.telemetry.server.UpdateChecker

class MainActivity : AppCompatActivity() {

    companion object {
        private const val REQ_BASIC = 101
        private const val REQ_BG = 102
    }

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
    private lateinit var tvPermStatus: TextView
    private lateinit var btnPermissions: Button
    private lateinit var tvVersion: TextView
    private lateinit var tvUpdateStatus: TextView
    private lateinit var btnCheckUpdate: Button
    private lateinit var updateChecker: UpdateChecker
    private var latestRelease: UpdateChecker.Release? = null

    // Root features UI
    private lateinit var cardRootFeatures: com.google.android.material.card.MaterialCardView
    private lateinit var tvRootStatus: TextView
    private lateinit var llRootFeatures: LinearLayout
    private lateinit var btnApplyRootFeatures: Button
    private var rootFeatureCheckBoxes: MutableMap<String, MaterialCheckBox> = mutableMapOf()

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
        tvPermStatus = findViewById(R.id.tvPermStatus)
        btnPermissions = findViewById(R.id.btnPermissions)
        tvVersion = findViewById(R.id.tvVersion)
        tvUpdateStatus = findViewById(R.id.tvUpdateStatus)
        btnCheckUpdate = findViewById(R.id.btnCheckUpdate)
        updateChecker = UpdateChecker(this) { message -> tvUpdateStatus.text = message }
        tvVersion.text = getString(R.string.version_label, updateChecker.currentVersion())

        // Root features views
        cardRootFeatures = findViewById(R.id.cardRootFeatures)
        tvRootStatus = findViewById(R.id.tvRootStatus)
        llRootFeatures = findViewById(R.id.llRootFeatures)
        btnApplyRootFeatures = findViewById(R.id.btnApplyRootFeatures)
        buildRootFeatureCheckboxes()

        loadSettings()
        updateUI()

        btnStart.setOnClickListener { startServer() }
        btnStop.setOnClickListener { stopServer() }
        btnSave.setOnClickListener { saveSettings() }
        btnCopyWsUrl.setOnClickListener { copyWsUrl() }
        btnPermissions.setOnClickListener { requestBasicPermissions() }
        btnCheckUpdate.setOnClickListener { checkForUpdate(manual = true) }
        checkForUpdate(manual = false)
    }

    private fun buildRootFeatureCheckboxes() {
        llRootFeatures.removeAllViews()
        rootFeatureCheckBoxes.clear()

        val ctx = this
        RootFeatures.ALL.forEach { key ->
            val cb = MaterialCheckBox(ctx).apply {
                text = RootFeatures.label(key)
                isChecked = RootFeatures.isEnabled(ctx, key)
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { setMargins(0, 8, 0, 8) }
            }
            rootFeatureCheckBoxes[key] = cb
            llRootFeatures.addView(cb)
        }

        btnApplyRootFeatures.setOnClickListener {
            rootFeatureCheckBoxes.forEach { (key, cb) ->
                RootFeatures.setEnabled(ctx, key, cb.isChecked)
            }
            Toast.makeText(this, "Root features disimpan", Toast.LENGTH_SHORT).show()
            if (TelemetryService.isRunning()) {
                RootManager.forceRecheck(this)
            }
        }
    }

    private fun updateRootFeaturesUI() {
        val status = RootManager.checkRootStatus(this)
        val hasRootAccess = status == RootManager.RootStatus.MAGISK_GRANTED || status == RootManager.RootStatus.GENERIC_SU

        if (hasRootAccess) {
            cardRootFeatures.visibility = View.VISIBLE
            val magisk = status == RootManager.RootStatus.MAGISK_GRANTED
            val label = if (magisk) "Magisk ✔" else "Generic su ✔"
            tvRootStatus.text = "Root: $label | ${RootFeatures.ALL.count { RootFeatures.isEnabled(this, it) }} fitur aktif"
            rootFeatureCheckBoxes.forEach { (key, cb) ->
                cb.isChecked = RootFeatures.isEnabled(this, key)
            }
        } else {
            cardRootFeatures.visibility = View.GONE
            tvRootStatus.text = "Root: tidak terdeteksi"
        }
    }

    override fun onResume() {
        super.onResume()
        updatePermStatus()
        updateUI()
        updateRootFeaturesUI()
    }


    private fun checkForUpdate(manual: Boolean) {
        if (manual) {
            btnCheckUpdate.isEnabled = false
            btnCheckUpdate.text = getString(R.string.checking_update)
            tvUpdateStatus.text = ""
        }
        updateChecker.check(silent = !manual) { release ->
            btnCheckUpdate.isEnabled = true
            btnCheckUpdate.text = getString(R.string.check_update)
            if (release == null) {
                if (manual && tvUpdateStatus.text.isNullOrBlank()) {
                    tvUpdateStatus.text = getString(R.string.update_error, "rili tidak ditemukan atau tidak dapat diakses")
                }
                return@check
            }
            if (!updateChecker.isNewer(release.version)) {
                if (manual) tvUpdateStatus.text = getString(R.string.up_to_date, updateChecker.currentVersion())
                return@check
            }
            latestRelease = release
            showUpdateAvailable(release)
        }
    }

    private fun showUpdateAvailable(release: UpdateChecker.Release) {
        tvUpdateStatus.text = getString(R.string.update_available, release.version)
        AlertDialog.Builder(this)
            .setTitle("Update Telemetry Server tersedia")
            .setMessage("Versi terpasang: v${updateChecker.currentVersion()}\nVersi terbaru: v${release.version}" +
                if (release.notes.isNotBlank()) "\n\n${release.notes.take(1200)}" else "")
            .setPositiveButton(getString(R.string.download_update)) { _, _ -> downloadAndInstall(release) }
            .setNegativeButton("Nanti", null)
            .show()
    }

    private fun downloadAndInstall(release: UpdateChecker.Release) {
        btnCheckUpdate.isEnabled = false
        updateChecker.download(release, { percent ->
            btnCheckUpdate.text = getString(R.string.downloading, percent)
        }) { apk ->
            btnCheckUpdate.isEnabled = true
            btnCheckUpdate.text = getString(R.string.check_update)
            if (apk == null || !apk.exists()) {
                tvUpdateStatus.text = getString(R.string.update_error, "unduhan gagal")
                return@download
            }
            tvUpdateStatus.text = "Unduhan selesai"
            try {
                val started = updateChecker.install(apk)
                if (!started) tvUpdateStatus.text = getString(R.string.install_permission)
            } catch (e: Exception) {
                tvUpdateStatus.text = getString(R.string.update_error, e.message ?: "gagal membuka pemasang")
            }
        }
    }

    // ===== Izin: lokasi -> lokasi latar belakang -> akses penggunaan =====
    private fun updatePermStatus() {
        val loc = Perms.hasLocation(this)
        val bg = Perms.hasBackgroundLocation(this)
        val usage = Perms.hasUsageAccess(this)
        fun mark(ok: Boolean) = if (ok) "✔" else "✘"
        tvPermStatus.text = "Lokasi: ${mark(loc)}   Lokasi di background: ${mark(bg)}   Akses Penggunaan (app aktif): ${mark(usage)}"
        btnPermissions.isEnabled = !(loc && bg && usage)
    }

    private fun requestBasicPermissions() {
        val need = mutableListOf<String>()
        if (!Perms.hasFineLocation(this)) {
            need += Manifest.permission.ACCESS_FINE_LOCATION
            need += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= 33 &&
            ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need += Manifest.permission.POST_NOTIFICATIONS
        }
        if (need.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, need.toTypedArray(), REQ_BASIC)
        } else {
            askBackgroundLocation()
        }
    }

    private fun askBackgroundLocation() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && Perms.hasLocation(this) && !Perms.hasBackgroundLocation(this)) {
            AlertDialog.Builder(this)
                .setTitle("Lokasi di background")
                .setMessage("Agar lokasi tetap terkirim saat aplikasi tidak dibuka, pilih \"Izinkan sepanjang waktu\" pada layar berikutnya.")
                .setPositiveButton("Lanjut") { _, _ ->
                    ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), REQ_BG)
                }
                .setNegativeButton("Lewati") { _, _ -> askUsageAccess() }
                .show()
        } else {
            askUsageAccess()
        }
    }

    private fun askUsageAccess() {
        if (!Perms.hasUsageAccess(this)) {
            AlertDialog.Builder(this)
                .setTitle("Akses Penggunaan")
                .setMessage("Untuk menampilkan aplikasi yang sedang aktif, aktifkan \"Telemetry Server\" di layar Akses Penggunaan berikutnya.")
                .setPositiveButton("Buka Pengaturan") { _, _ ->
                    try {
                        startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
                    } catch (_: Exception) {
                        Toast.makeText(this, "Buka Pengaturan > Akses penggunaan secara manual", Toast.LENGTH_LONG).show()
                    }
                }
                .setNegativeButton("Nanti", null)
                .show()
        }
        updatePermStatus()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        updatePermStatus()
        when (requestCode) {
            REQ_BASIC -> askBackgroundLocation()
            REQ_BG -> askUsageAccess()
        }
    }

    private fun loadSettings() {
        etPort.setText(prefs.getString("http_port", "8080").toString())
        etWsPort.setText(prefs.getString("ws_port", "8765").toString())
        etToken.setText(prefs.getString("auth_token", ""))
        etInterval.setText(prefs.getString("update_interval", "1").toString())
        cbBindAll.isChecked = prefs.getBoolean("bind_all", true)
    }

    private fun saveSettings() {
        val port = etPort.text.toString().toIntOrNull() ?: 8080
        val wsPort = etWsPort.text.toString().toIntOrNull() ?: 8765
        val token = etToken.text.toString()
        val interval = etInterval.text.toString().toIntOrNull() ?: 1

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
        val interval = etInterval.text.toString().toIntOrNull() ?: 1

        // Keamanan: bind ke semua interface tanpa token = siapa pun di jaringan bisa baca telemetri
        if (cbBindAll.isChecked && token.isBlank()) {
            Toast.makeText(this, "Isi Auth Token dulu (wajib saat Bind to All Interfaces aktif)", Toast.LENGTH_LONG).show()
            etToken.requestFocus()
            return
        }

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