package com.irfanfrizki.telemetry.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

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
            startForeground(NOTIF_ID, buildNotification(inetAddr, port, wsPort))

            synchronized(sMutex) {
                sServer?.stopAll()
                sServer = TelemetryServer(port, wsPort, inetAddr, token, collector, intervalSec)
                sServer!!.startAll()
            }
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
            return auth.startsWith("Bearer ") && auth.substring(7) == token
        }

        private fun jsonResponse(status: Response.IStatus, body: String): Response =
            withCors(newFixedLengthResponse(status, MIME_JSON, body))

        private fun withCors(resp: Response): Response {
            resp.addHeader("Access-Control-Allow-Origin", "*")
            resp.addHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            resp.addHeader("Access-Control-Allow-Headers", "Authorization, Content-Type")
            return resp
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

            val responseJson: JSONObject? = when (path) {
                "/api/data", "/api/all" -> collector.collect()
                "/api/battery" -> collector.collect().optJSONObject("battery")
                "/api/location" -> collector.collect().optJSONObject("location")
                "/api/system" -> collector.collect().optJSONObject("system")
                "/api/network" -> collector.collect().optJSONObject("network")
                "/api/apps" -> collector.collect().optJSONArray("apps")?.let { JSONObject().put("apps", it) }
                "/status" -> JSONObject().put("status", "ok").put("uptime", System.currentTimeMillis() - startTime)
                else -> null
            }

            return if (responseJson != null) {
                jsonResponse(Response.Status.OK, responseJson.toString(2))
            } else {
                jsonResponse(Response.Status.NOT_FOUND, JSONObject().put("error", "not found").toString())
            }
        }

        companion object {
            private const val TAG = "TelemetryServer"
            private const val MIME_JSON = "application/json"
        }
    }
}
