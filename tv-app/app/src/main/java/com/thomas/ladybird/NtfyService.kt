package com.thomas.ladybird

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject

/** One parsed `message` event off the ntfy JSON stream. */
data class NtfyMessage(
    val id: String,
    val title: String,
    val message: String,
    val priority: Int,
    val attachmentUrl: String?,
)

/**
 * The always-on ntfy subscriber: a foreground service holding one streaming
 * GET to <ntfy_url>/<topics>/json. Reconnects with backoff after any drop
 * (network loss, TV sleep, server restart) and resumes with since=<last id>
 * so nothing that arrived in the gap is missed. keepalive/open events are
 * ignored; message events become overlay banners.
 */
class NtfyService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var streamJob: Job? = null

    @Volatile
    private var activeCall: Call? = null

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        // The subscription never stops talking (keepalives every ~45s), so no read ceiling.
        .readTimeout(0, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val connectivity by lazy { getSystemService(ConnectivityManager::class.java) }
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // The blocking read can sit on a dead socket for minutes; cutting
            // the call makes the loop reconnect now that there is a network.
            Log.i(TAG, "network available - nudging the ntfy stream")
            activeCall?.cancel()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL, "Ladybird alert stream", NotificationManager.IMPORTANCE_MIN),
        )
        val note = Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentTitle("Ladybird is listening for alerts")
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTE_ID, note)
        }
        connectivity.registerDefaultNetworkCallback(networkCallback)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Every start re-reads config, so a re-provisioned ntfy_url/topics takes
        // effect by just relaunching the activity.
        streamJob?.cancel()
        activeCall?.cancel()
        streamJob = scope.launch { streamForever() }
        return START_STICKY
    }

    override fun onDestroy() {
        connectivity.unregisterNetworkCallback(networkCallback)
        activeCall?.cancel()
        scope.cancel()
        super.onDestroy()
    }

    private suspend fun streamForever() {
        val config = ConfigStore.load(this)
        val base = config.ntfyUrl?.trimEnd('/')
        val topics = config.ntfyTopics?.trim()?.trim(',')
        if (base.isNullOrBlank() || topics.isNullOrBlank()) {
            Log.w(TAG, "ntfy not configured (ntfy_url + ntfy_topics) - stream idle")
            return
        }

        var backoffMs = 2_000L
        while (scope.isActive) {
            val since = ConfigStore.lastId(this)
            val url = buildString {
                append(base).append('/').append(topics).append("/json")
                if (since != null) append("?since=").append(since)
            }
            try {
                val request = Request.Builder().url(url).apply {
                    config.ntfyToken?.takeIf { it.isNotBlank() }?.let { header("Authorization", "Bearer $it") }
                }.build()
                val call = client.newCall(request)
                activeCall = call
                call.execute().use { response ->
                    if (!response.isSuccessful) throw IOException("ntfy answered ${response.code}")
                    Log.i(TAG, "ntfy stream open: $base/$topics (since=${since ?: "now"})")
                    backoffMs = 2_000L
                    val source = response.body?.source() ?: throw IOException("ntfy stream had no body")
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        handleLine(line)
                    }
                }
                throw IOException("ntfy stream ended")
            } catch (cause: Exception) {
                if (!scope.isActive) return
                Log.w(TAG, "ntfy stream dropped (${cause.message}) - retrying in ${backoffMs / 1000}s")
            } finally {
                activeCall = null
            }
            delay(backoffMs)
            backoffMs = (backoffMs * 2).coerceAtMost(60_000L)
        }
    }

    private fun handleLine(line: String) {
        if (line.isBlank()) return
        val json = try {
            JSONObject(line)
        } catch (_: Exception) {
            return
        }
        // open / keepalive / poll_request carry no content; only messages matter.
        if (json.optString("event") != "message") return

        val id = json.optString("id")
        if (id.isNotEmpty()) ConfigStore.setLastId(this, id)

        val message = NtfyMessage(
            id = id,
            title = json.optString("title").ifEmpty { json.optString("topic") },
            message = json.optString("message"),
            priority = json.optInt("priority", 3),
            attachmentUrl = json.optJSONObject("attachment")?.optString("url")?.takeIf { it.isNotBlank() },
        )
        Log.i(TAG, "ntfy message id=${message.id} priority=${message.priority} title=${message.title}")
        OverlayController.show(this, client, message)
    }

    companion object {
        private const val CHANNEL = "ntfy"
        private const val NOTE_ID = 1

        fun start(context: Context) {
            context.startForegroundService(Intent(context, NtfyService::class.java))
        }
    }
}
