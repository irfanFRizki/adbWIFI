package com.irfanfrizki.telemetry.server

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import fi.iki.elonen.NanoHTTPD
import fi.iki.elonen.NanoHTTPD.IHTTPSession
import fi.iki.elonen.NanoHTTPD.Response
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.Collections
import java.util.HashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

import com.irfanfrizki.telemetry.server.RootManager
import com.irfanfrizki.telemetry.server.RootFeatures

class TelemetryService : Service() {

    companion object {
        private const val TAG = "TelemetryService"
        private const val CHANNEL_ID = "telemetry_server_channel"
        private const val NOTIF_ID = 1001
        private const val MIME_JSON = "application/json"
        private var sContext: Context? = null
        private var sService: TelemetryService? = null
        private var sServer: TelemetryServer? = null
        private var sCollector: DataCollector? = null
        private val sMutex = Any()

        fun context(): Context? = sContext

        fun start(context: Context, config: JSONObject) {
            sContext = context
            val intent = Intent(context, TelemetryService::class.java).apply {
                putExtra("config", config.toString())
                action = "START_SERVER"
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun start(context: Context, port: Int, wsPort: Int, token: String, intervalSec: Int) {
            sContext = context
            val config = JSONObject().apply {
                put("port", port)
                put("wsPort", wsPort)
                put("token", token)
                put("bindAll", true)
                put("intervalSec", intervalSec)
            }
            val intent = Intent(context, TelemetryService::class.java).apply {
                putExtra("config", config.toString())
                action = "START_SERVER"
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            sContext = context
            val intent = Intent(context, TelemetryService::class.java)
            intent.action = "STOP_SERVER"
            context.stopService(intent)
            synchronized(sMutex) {
                sServer?.stopAll()
                sServer = null
            }
            sService?.stopForeground(true)
        }

        fun isRunning(): Boolean {
            synchronized(sMutex) {
                return sServer?.isRunning() == true
            }
        }

        fun getWsUrl(): String? {
            synchronized(sMutex) {
                return sServer?.let { "ws://${it.localAddress.hostAddress}:${it.wsPort}/live" }
            }
        }

        fun getData(): JSONObject? {
            return sCollector?.collect()
        }
    }

    private val collector by lazy { DataCollector(this) }

    override fun onCreate() {
        super.onCreate()
        sContext = applicationContext
        sService = this
        sCollector = collector
        Log.i(TAG, "TelemetryService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "START_SERVER" -> {
                val configStr = intent.getStringExtra("config") ?: "{}"
                try {
                    startForegroundServiceWithConfig(JSONObject(configStr))
                } catch (e: Exception) {
                    Log.e(TAG, "Invalid config", e)
                }
            }
            "STOP_SERVER" -> {
                stopSelf()
            }
        }
        return START_STICKY
    }

    private fun startForegroundServiceWithConfig(config: JSONObject) {
        val port = config.optInt("port", 8080)
        val wsPort = config.optInt("wsPort", 8081)
        val token = config.optString("token", "")
        val bindAll = config.optBoolean("bindAll", true)
        val intervalSec = config.optInt("intervalSec", 2).coerceAtLeast(1)

        val inetAddr = if (bindAll) InetAddress.getByName("0.0.0.0") else InetAddress.getLoopbackAddress()

        try {
            // Foreground notification must be shown promptly after startForegroundService().
            createNotificationChannel()
            enterForeground(buildNotification(inetAddr, port, wsPort))

            synchronized(sMutex) {
                sServer?.stopAll()
                sServer = TelemetryServer(port, wsPort, inetAddr, token, collector, intervalSec)
                sServer!!.startAll()
            collector.startLocationUpdates()
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start server", e)
            stopSelf()
        }
    }

    /** Foreground service bertipe dataSync (+ location jika izin lokasi ada) supaya lokasi tetap jalan di background. */
    private fun enterForeground(notif: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            if (Perms.hasLocation(this)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            try {
                startForeground(NOTIF_ID, notif, type)
            } catch (e: SecurityException) {
                Log.w(TAG, "FGS location type refused, fallback to dataSync: ${e.message}")
                startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
            }
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "Telemetry Server", NotificationManager.IMPORTANCE_LOW)
            channel.description = "Server telemetry berjalan di background"
            channel.enableLights(false)
            channel.enableVibration(false)
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(addr: InetAddress, port: Int, wsPort: Int): Notification {
        val intent = Intent(this, TelemetryService::class.java).apply { action = "STOP_SERVER" }
        val pendingIntent = PendingIntent.getService(
            this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val ipStr = addr.hostAddress
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Telemetry Server")
            .setContentText("HTTP/WS: $ipStr:$port / $wsPort")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        try { collector.stopLocationUpdates() } catch (_: Exception) {}
        synchronized(sMutex) {
            sServer?.stopAll()
            sServer = null
        }
        sService = null
        Log.i(TAG, "TelemetryService destroyed")
        super.onDestroy()
    }

    class TelemetryServer(
        val httpPort: Int,
        val wsPort: Int,
        private val bindAddr: InetAddress,
        private val token: String,
        private val collector: DataCollector,
        private val intervalSec: Int
    ) : NanoHTTPD(bindAddr.hostAddress, httpPort) {

        val localAddress: InetAddress
            get() = bindAddr

        private val startTime = System.currentTimeMillis()
        private val clients: MutableSet<WebSocket> = Collections.synchronizedSet(mutableSetOf<WebSocket>())
        private val executor = Executors.newSingleThreadScheduledExecutor()
        private var broadcastFuture: ScheduledFuture<*>? = null

        private val wsServer: WebSocketServer = object : WebSocketServer(
            InetSocketAddress(bindAddr, wsPort)
        ) {
            override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
                if (!authenticated(handshake)) {
                    conn.close(4001, "Unauthorized")
                    return
                }
                clients.add(conn)
                Log.d(TAG, "WS client connected: ${conn.remoteSocketAddress}")
                conn.send(JSONObject().put("type", "telemetry").put("data", collector.collect()).toString())
            }

            override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
                clients.remove(conn)
                Log.d(TAG, "WS client disconnected: $reason")
            }

            override fun onMessage(conn: WebSocket, message: String) {
                try {
                    val req = JSONObject(message)
                    when (req.optString("type", "")) {
                        "ping" -> conn.send(
                            JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString()
                        )
                        "data" -> conn.send(
                            JSONObject().put("type", "telemetry").put("data", collector.collect()).toString()
                        )
                        else -> conn.send(JSONObject().put("type", "error").put("msg", "unknown type").toString())
                    }
                } catch (e: Exception) {
                    conn.send(JSONObject().put("type", "error").put("msg", e.message ?: "error").toString())
                }
            }

            override fun onError(conn: WebSocket?, ex: Exception) {
                Log.e(TAG, "WS error", ex)
            }

            override fun onStart() {
                Log.i(TAG, "WebSocket server started on $wsPort")
            }
        }

        fun isRunning(): Boolean = isAlive

        /** Starts HTTP + WebSocket servers and the periodic broadcast. */
        fun startAll() {
            try {
                start(SOCKET_READ_TIMEOUT, false)
                wsServer.start()
                Log.i(TAG, "Server started on ${bindAddr.hostAddress}:$httpPort")
                broadcastFuture = executor.scheduleAtFixedRate({
                    try {
                        val snapshot = synchronized(clients) { clients.toList() }
                        if (snapshot.isNotEmpty()) {
                            val msg = JSONObject().put("type", "telemetry").put("data", collector.collect()).toString()
                            for (c in snapshot) {
                                try { c.send(msg) } catch (_: Exception) {}
                            }
                        }
                    } catch (e: Exception) {
                        Log.e(TAG, "Broadcast error", e)
                    }
                }, intervalSec.toLong(), intervalSec.toLong(), TimeUnit.SECONDS)
            } catch (e: IOException) {
                Log.e(TAG, "Server error", e)
            }
        }

        /** Stops HTTP + WebSocket servers and the periodic broadcast. */
        fun stopAll() {
            broadcastFuture?.cancel(false)
            try { stop() } catch (_: Exception) {}
            try { wsServer.stop() } catch (_: Exception) {}
            executor.shutdown()
        }

        private fun authenticated(handshake: ClientHandshake): Boolean {
            if (token.isEmpty()) return true
            val auth = handshake.getFieldValue("Authorization") ?: ""
            if (auth.startsWith("Bearer ") && auth.substring(7) == token) return true
            // Browsers/WebView cannot set headers on WebSocket: accept ?token=... in the URL
            val query = handshake.resourceDescriptor?.substringAfter('?', "") ?: ""
            val tokenParam = query.split('&')
                .firstOrNull { it.startsWith("token=") }
                ?.substringAfter("token=")
                ?.let { java.net.URLDecoder.decode(it, "UTF-8") } ?: ""
            return tokenParam == token
        }

        private fun jsonResponse(status: Response.IStatus, body: String): Response =
            withCors(newFixedLengthResponse(status, MIME_JSON, body))

        private fun withCors(resp: Response): Response {
            resp.addHeader("Access-Control-Allow-Origin", "*")
            resp.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            resp.addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
            return resp
        }

        /** POST /api/root/control — remote control for rooted devices. Body: {"action":"tap","args":{...}} */
        private fun handleRootControl(session: IHTTPSession): Response {
            return try {
                val map = HashMap<String, String>()
                session.parseBody(map)
                val body = map["postData"] ?: "{}"
                val req = JSONObject(body)
                val action = req.optString("action", "")
                val pkg = req.optString("package", "")
                val extra = req.optString("extra", "")
                val value = req.optString("value", "")
                val args = req.optJSONObject("args") ?: JSONObject()
                if (!checkRootFeature("remote_control")) return rootDenied("remote_control")
                if (!RootManager.getRootInfo(sContext).optBoolean("hasAccess")) {
                    return jsonResponse(Response.Status.FORBIDDEN, JSONObject().put("error", "root access unavailable").toString())
                }

                val result = JSONObject()
                when (action) {
                    // Input control
                    "tap" -> result.put("ok", RootManager.sendInput("tap ${args.optInt("x")} ${args.optInt("y")}"))
                    "swipe" -> result.put("ok", RootManager.sendInput(
                        "swipe ${args.optInt("x1")} ${args.optInt("y1")} ${args.optInt("x2")} ${args.optInt("y2")} ${args.optInt("duration", 300)}"
                    ))
                    "keyevent" -> result.put("ok", RootManager.sendInput("keyevent ${args.optString("key")}"))
                    "text" -> result.put("ok", RootManager.sendInput("text '${args.optString("text").replace("'", "\\'")}'"))
                    // App control
                    "app_start", "app_force_stop", "app_grant", "app_revoke", "app_clear" ->
                        result.put("ok", RootManager.controlApp(action.removePrefix("app_").replace("_", "-"), pkg, extra))
                    // System control
                    "screen_on", "screen_off", "wifi", "airplane", "brightness", "volume", "reboot", "adb_wifi_on", "adb_wifi_off" ->
                        result.put("ok", RootManager.controlSystem(action, value))
                    else -> result.put("error", "unknown action")
                }
                jsonResponse(Response.Status.OK, result.toString())
            } catch (e: Exception) {
                jsonResponse(Response.Status.BAD_REQUEST, JSONObject().put("error", e.message ?: "bad request").toString())
            }
        }

        override fun serve(session: IHTTPSession): Response {
            val method = session.method.name
            val headers = session.headers ?: emptyMap<String, String>()
            val parms = session.parameters ?: emptyMap<String, List<String>>()

            // CORS preflight is answered without auth
            if (method == "OPTIONS") {
                return jsonResponse(Response.Status.OK, "{}")
            }

            // Auth check
            if (token.isNotEmpty()) {
                val authHeader = headers["authorization"] ?: ""
                val tokenParam = parms["token"]?.firstOrNull() ?: ""
                val authorized = (authHeader.startsWith("Bearer ") && authHeader.substring(7) == token) ||
                        tokenParam == token
                if (!authorized) {
                    return jsonResponse(
                        Response.Status.UNAUTHORIZED,
                        JSONObject().put("error", "unauthorized").toString()
                    )
                }
            }

            if (method != "GET") {
                // POST /api/root/control — remote control for rooted devices
                if (method == "POST") {
                    val path = session.uri?.substringBefore('?') ?: "/"
                    if (path == "/api/root/control") {
                        return handleRootControl(session)
                    }
                    if (path == "/api/root/features/update") {
                        return try {
                            val ctx = sContext ?: return rootDenied("remote_control")
                            val map = HashMap<String, String>()
                            session.parseBody(map)
                            val body = map["postData"] ?: "{}"
                            val req = JSONObject(body)
                            val toggles = req.optJSONObject("toggles") ?: JSONObject()
                            toggles.keys().forEach { key ->
                                RootFeatures.setEnabled(ctx, key, toggles.optBoolean(key, false))
                            }
                            jsonResponse(Response.Status.OK, JSONObject().put("ok", true).toString())
                        } catch (e: Exception) {
                            jsonResponse(Response.Status.BAD_REQUEST, JSONObject().put("error", e.message ?: "bad request").toString())
                        }
                    }
                }
                return jsonResponse(Response.Status.METHOD_NOT_ALLOWED, "{}")
            }

            val path = session.uri?.substringBefore('?') ?: "/"

            if (path == "/" || path == "/index.html") {
                val html = """
                    <html><head><title>Telemetry Server</title>
                    <style>body{font-family:sans-serif;padding:20px}code{background:#f4f4f4;padding:2px 4px}</style>
                    </head><body>
                    <h1>Telemetry Server</h1>
                    <p>Endpoints:</p>
                    <ul>
                        <li><code>/api/data</code> - All telemetry</li>
                        <li><code>/api/battery</code> - Battery info</li>
                        <li><code>/api/location</code> - Location</li>
                        <li><code>/api/system</code> - RAM/CPU</li>
                        <li><code>/api/network</code> - Network</li>
                        <li><code>/api/apps</code> - Foreground apps</li>
                    </ul>
                    <p>WebSocket: <code>ws://${bindAddr.hostAddress}:$wsPort/live</code></p>
                    <p>Server uptime: ${(System.currentTimeMillis() - startTime) / 1000}s</p>
                    </body></html>
                """.trimIndent()
                return withCors(newFixedLengthResponse(Response.Status.OK, MIME_HTML, html))
            }

            val path = session.uri?.substringBefore('?') ?: "/"

            val rootFeature = when (path) {
                "/api/root/screenshot" -> "screenshot"
                "/api/root/fgapp" -> "foreground_app"
                "/api/root/uidump" -> "ui_dump"
                "/api/root/proclist" -> "process_list"
                "/api/root/netconn", "/api/root/arp" -> "network_detail"
                "/api/root/uidstats" -> "data_usage"
                "/api/root/calllog", "/api/root/sms", "/api/root/appsizes" -> "sensitive_data"
                "/api/root/battery" -> "battery_detail"
                "/api/root/thermal" -> "thermal"
                "/api/root/cpu", "/api/root/gpu" -> "cpu_detail"
                else -> null
            }
            if (rootFeature != null && !checkRootFeature(rootFeature)) {
                return rootDenied(rootFeature)
            }

            val responseJson: JSONObject? = when (path) {
                "/api/data", "/api/all" -> collector.collect()
                "/api/battery" -> collector.collect().optJSONObject("battery")
                "/api/location" -> collector.collect().optJSONObject("location")
                "/api/system" -> collector.collect().optJSONObject("system")
                "/api/network" -> collector.collect().optJSONObject("network")
                "/api/apps" -> collector.collect().optJSONArray("apps")?.let { JSONObject().put("apps", it) }
                "/api/root/status" -> collector.collect().optJSONObject("root") ?: JSONObject().put("available", false)
                "/api/root/features" -> JSONObject().put("features", RootFeatures.toJson(sContext))
                "/api/root/features/update" -> JSONObject().put("error", "Use POST /api/root/features/update")
                "/api/root/screenshot" -> JSONObject().apply {
                    val b64 = RootManager.takeScreenshot()
                    put("screenshot", b64 ?: JSONObject.NULL)
                    put("ok", b64 != null)
                }
                "/api/root/fgapp" -> RootManager.getForegroundApp()
                "/api/root/uidump" -> RootManager.getUiDump()?.let { JSONObject().put("uidump", it) }
                "/api/root/proclist" -> RootManager.getProcessList().let { JSONObject().put("procs", it) }
                "/api/root/netconn" -> JSONObject().put("connections", RootManager.getNetworkConnections())
                "/api/root/arp" -> JSONObject().put("arp", RootManager.getArpTable())
                "/api/root/uidstats" -> JSONObject().put("stats", RootManager.getUidNetworkStats())
                "/api/root/calllog" -> JSONObject().put("calls", RootManager.getCallLog())
                "/api/root/sms" -> JSONObject().put("messages", RootManager.getSms())
                "/api/root/appsizes" -> JSONObject().put("apps", RootManager.getInstalledAppsWithSize())
                "/api/root/battery" -> RootManager.getBatteryCurrent()
                "/api/root/thermal" -> JSONObject().put("thermal", RootManager.getThermalSensors())
                "/api/root/cpu" -> RootManager.getCpuDetails()
                "/api/root/gpu" -> JSONObject().put("gpu", RootManager.getGpuFreq())
                "/status" -> JSONObject().put("status", "ok").put("uptime", System.currentTimeMillis() - startTime)
                else -> null
            }

            return if (responseJson != null) {
                jsonResponse(Response.Status.OK, responseJson.toString(2))
            } else {
                jsonResponse(Response.Status.NOT_FOUND, JSONObject().put("error", "not found").toString())
            }
        }

        private fun checkRootFeature(feature: String): Boolean {
            return try {
                val ctx = sContext ?: return false
                RootFeatures.isEnabled(ctx, feature)
            } catch (_: Exception) {
                false
            }
        }

        private fun rootDenied(feature: String): Response = jsonResponse(
            Response.Status.FORBIDDEN,
            JSONObject().put("error", "Root feature '$feature' not enabled on server").toString()
        )

        companion object {
            private const val TAG = "TelemetryServer"
            private const val MIME_JSON = "application/json"
        }
    }
}
