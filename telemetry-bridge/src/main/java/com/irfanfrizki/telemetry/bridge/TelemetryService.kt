package com.irfanfrizki.telemetry.bridge

import android.app.*
import android.content.*
import android.content.pm.*
import android.net.*
import android.os.*
import android.util.*
import android.webkit.MimeTypeMap
import com.getcapacitor.Plugin
import fi.iki.elonen.NanoHTTPD
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.io.*
import java.net.*
import java.util.concurrent.*

class TelemetryService : Service() {

    companion object {
        private const val TAG = "TelemetryService"
        private const val CHANNEL_ID = "telemetry_server_channel"
        private const val NOTIF_ID = 1001
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

        fun stop(context: Context) {
            sContext = context
            val intent = Intent(context, TelemetryService::class.java)
            intent.action = "STOP_SERVER"
            context.stopService(intent)
            synchronized(sMutex) {
                sServer?.stop()
                sServer = null
            }
            sService?.stopForeground(true)
        }

        fun isRunning(): Boolean {
            synchronized(sMutex) {
                return sServer != null && sServer!!.isRunning()
            }
        }

        fun getWsUrl(): String? {
            synchronized(sMutex) {
                return sServer?.let { "ws://${it.localAddress}:${it.wsPort}/live" }
            }
        }

        fun getData(): JSONObject? {
            return sCollector?.collect()
        }
    }

    private val collector by lazy { DataCollector(this) }
    private var broadcastFuture: ScheduledFuture<*>? = null

    override fun onCreate() {
        super.onCreate()
        sContext = applicationContext
        sService = this
        sCollector = collector
        Log.i(TAG, "TelemetryService created")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        when (action) {
            "START_SERVER" -> {
                val configStr = intent?.getStringExtra("config") ?: "{}"
                try {
                    val config = JSONObject(configStr)
                    startForegroundServiceWithConfig(config)
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
        val intervalSec = config.optInt("intervalSec", 2)

        val inetAddr = if (bindAll) InetAddress.getByName("0.0.0.0") else InetAddress.getLoopbackAddress()

        try {
            synchronized(sMutex) {
                sServer?.stop()
                sServer = TelemetryServer(port, wsPort, inetAddr, token, collector, intervalSec)
                sServer!!.start()
            }
            createNotificationChannel()
            val server = sServer!!
            startForeground(NOTIF_ID, buildNotification(server.localAddress, port, wsPort))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start server", e)
            stopSelf()
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
        val pendingIntent = PendingIntent.getService(this, 0, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        val ipStr = addr.hostAddress
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("Telemetry Server")
            .setContentText("HTTP/WS: $ipStr:$port / $wsPort")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setOngoing(true)
            .setContentIntent(pendingIntent)
            .setPriority(Notification.PRIORITY_LOW)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        synchronized(sMutex) {
            sServer?.stop()
            sServer = null
        }
        broadcastFuture?.cancel(false)
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
                val data = collector.collect()
                if (data != null) {
                    conn.send(JSONObject().put("type", "telemetry").put("data", data).toString())
                }
            }
            override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
                clients.remove(conn)
                Log.d(TAG, "WS client disconnected: $reason")
            }
            override fun onMessage(conn: WebSocket, message: String) {
                try {
                    val req = JSONObject(message)
                    val type = req.optString("type", "")
                    when (type) {
                        "ping" -> conn.send(JSONObject().put("type", "pong").put("ts", System.currentTimeMillis()).toString())
                        "data" -> {
                            val data = collector.collect()
                            if (data != null) {
                                conn.send(JSONObject().put("type", "telemetry").put("data", data).toString())
                            }
                        }
                        else -> conn.send(JSONObject().put("type", "error").put("msg", "unknown type").toString())
                    }
                } catch (e: Exception) {
                    conn.send(JSONObject().put("type", "error").put("msg", e.message).toString())
                }
            }
            override fun onError(conn: WebSocket?, ex: Exception) {
                Log.e(TAG, "WS error", ex)
            }
            override fun onStart() {
                Log.i(TAG, "WebSocket server started on $wsPort")
            }
        }

        private val clients = Collections.synchronizedSet(mutableSetOf<WebSocket>())
        private val executor = Executors.newSingleThreadScheduledExecutor()
        private var broadcastFuture: ScheduledFuture<*>? = null

        init {
        }

        fun start() {
            try {
                this.start(NanoHTTPD.SOCKET_READ_TIMEOUT, false)
                wsServer.start()
                Log.i(TAG, "Server started on ${bindAddr.hostAddress}:$httpPort")
                val finalInterval = intervalSec
                broadcastFuture = executor.scheduleAtFixedRate({
                    val data = collector.collect()
                    if (data != null && clients.isNotEmpty()) {
                        val msg = JSONObject().put("type", "telemetry").put("data", data).toString()
                        clients.forEach { it.send(msg) }
                    }
                }, finalInterval.toLong(), finalInterval.toLong(), TimeUnit.SECONDS)
            } catch (e: IOException) {
                Log.e(TAG, "Server error", e)
            }
        }

        fun stop() {
            broadcastFuture?.cancel(false)
            try { super.stop() } catch (_: Exception) {}
            try { wsServer.stop() } catch (_: Exception) {}
            executor.shutdown()
        }

        private fun authenticated(handshake: ClientHandshake): Boolean {
            if (token.isEmpty()) return true
            val auth = handshake.getFieldValue("Authorization")
            return auth.startsWith("Bearer ") && auth.substring(7) == token
        }

        private fun authenticatedHeaders(headers: Map<String, List<String>>): Boolean {
            if (token.isEmpty()) return true
            val auth = headers["Authorization"]?.firstOrNull() ?: headers["authorization"]?.firstOrNull() ?: ""
            return auth.startsWith("Bearer ") && auth.substring(7) == token
        }

        override fun run() {
            // NanoHTTPD.start() runs the accept loop internally; this thread is just used for naming.
        }

        override fun serve(session: NanoHTTPD.IHTTPSession): NanoHTTPD.Response {
                    val uri = session.uri ?: "/"
                    val method = session.method.name
                    val headers = session.headers ?: mapOf()
                    val parms = session.parameters ?: mapOf()

                    // Auth check
                    if (token.isNotEmpty()) {
                        val authHeader = headers["authorization"] ?: headers["Authorization"] ?: ""
                        val tokenParam = parms["token"]?.firstOrNull() ?: ""
                        val authorized = (authHeader.startsWith("Bearer ") && authHeader.substring(7) == token) || tokenParam == token
                        if (!authorized) {
                            return newFixedLengthResponse(
                                NanoHTTPD.Response.Status.UNAUTHORIZED, NanoHTTPD.MIME_JSON,
                                JSONObject().put("error", "unauthorized").toString()
                            )
                        }
                    }

                    // CORS headers
                    val cors = mapOf(
                        "Access-Control-Allow-Origin" to "*",
                        "Access-Control-Allow-Methods" to "GET, POST, OPTIONS",
                        "Access-Control-Allow-Headers" to "Authorization, Content-Type"
                    )

                    if (method == "OPTIONS") {
                        return newFixedLengthResponse(NanoHTTPD.Response.Status.OK, NanoHTTPD.MIME_JSON, "{}", cors)
                    }

                    if (method != "GET") {
                        return newFixedLengthResponse(
                            NanoHTTPD.Response.Status.METHOD_NOT_ALLOWED, NanoHTTPD.MIME_JSON, "{}", cors
                        )
                    }

                    val path = uri.substringBefore('?')
                    val responseJson: JSONObject?

                    responseJson = when (path) {
                        "/", "/index.html" -> null
                        "/api/data", "/api/all" -> collector.collect()
                        "/api/battery" -> collector.collect()?.optJSONObject("battery")
                        "/api/location" -> collector.collect()?.optJSONObject("location")
                        "/api/system" -> collector.collect()?.optJSONObject("system")
                        "/api/network" -> collector.collect()?.optJSONObject("network")
                        "/api/apps" -> collector.collect()?.optJSONArray("apps")?.let { JSONObject().put("apps", it) }
                        "/status" -> JSONObject().put("status", "ok").put("uptime", System.currentTimeMillis())
                        else -> null
                    }

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
                            <p>WebSocket: <code>ws://$bindAddr:$wsPort/live</code></p>
                            <p>Server uptime: ${(System.currentTimeMillis() - startTime) / 1000}s</p>
                            </body></html>
                        """.trimIndent()
                        return newFixedLengthResponse(NanoHTTPD.Response.Status.OK, NanoHTTPD.MIME_HTML, html, cors)
                    }

                    return if (responseJson != null) {
                        newFixedLengthResponse(NanoHTTPD.Response.Status.OK, NanoHTTPD.MIME_JSON, responseJson.toString(2), cors)
                    } else {
                        newFixedLengthResponse(NanoHTTPD.Response.Status.NOT_FOUND, NanoHTTPD.MIME_JSON, JSONObject().put("error", "not found").toString(), cors)
                    }
                }

                private val startTime = System.currentTimeMillis()
    }
}