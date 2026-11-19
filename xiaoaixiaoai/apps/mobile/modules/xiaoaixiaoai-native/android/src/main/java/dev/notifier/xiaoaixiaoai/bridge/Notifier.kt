package dev.notifier.xiaoaixiaoai.bridge

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// Android settings are bound to these IDs; changing them would discard notification preferences.
const val ALERT_CHANNEL = "pocket_alerts"
const val STATUS_CHANNEL = "pocket_status"

fun ensureChannels(ctx: Context) {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
  val nm = ctx.getSystemService(NotificationManager::class.java)
  if (nm.getNotificationChannel(ALERT_CHANNEL) == null) {
    nm.createNotificationChannel(
      NotificationChannel(ALERT_CHANNEL, "agent 提醒", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "agent 在等你、跑完了，以及你让助理设的提醒"
        enableVibration(true)
      },
    )
  }
  if (nm.getNotificationChannel(STATUS_CHANNEL) == null) {
    nm.createNotificationChannel(
      NotificationChannel(STATUS_CHANNEL, "后台在线", NotificationManager.IMPORTANCE_MIN).apply {
        description = "保持和服务器的连接，提醒才能及时到达"
        setShowBadge(false)
      },
    )
  }
}

/** Opens the app on the assistant (deep link handled by expo-router). */
fun openAppIntent(ctx: Context, path: String = "assistant"): PendingIntent {
  val i = Intent(Intent.ACTION_VIEW, Uri.parse("xiaoaixiaoai://$path")).apply {
    setPackage(ctx.packageName)
    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
  }
  return PendingIntent.getActivity(ctx, path.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

/**
 * Keeps /v1/notify open and turns notices into phone notifications. It is a
 * separate socket from the app's main one, so the two never replace each other.
 */
class Notifier(private val ctx: Context) {
  private val prefs = Prefs(ctx)
  private val main = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder()
    .pingInterval(30, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .connectTimeout(15, TimeUnit.SECONDS)
    .build()
  private var ws: WebSocket? = null
  private var running = false
  private var backoff = 2_000L
  private var target: Prefs.Pairing? = null
  @Volatile var connected = false
    private set
  private val retry = Runnable { connect() }
  private var netCallback: ConnectivityManager.NetworkCallback? = null

  fun start() {
    if (running && target?.let(prefs::matches) == true) return
    stop()
    target = prefs.pairing() ?: return
    running = true
    connect()
    watchNetwork()
  }

  fun stop() {
    running = false
    target = null
    main.removeCallbacks(retry)
    try { ws?.close(1000, "bye") } catch (_: Throwable) {}
    ws = null
    connected = false
    netCallback?.let {
      try { ctx.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Throwable) {}
    }
    netCallback = null
  }

  private fun watchNetwork() {
    if (netCallback != null) return
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        main.post {
          if (running && !connected) {
            main.removeCallbacks(retry)
            backoff = 2_000L
            connect()
          }
        }
      }
    }
    try {
      ctx.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(cb)
      netCallback = cb
    } catch (_: Throwable) {}
  }

  private fun connect() {
    val pair = target ?: return
    if (!running) return
    val since = prefs.since(pair) ?: return
    try { ws?.cancel() } catch (_: Throwable) {}
    // The token rides in a header: a URL ends up in reverse-proxy access logs.
    val req = Request.Builder().url(wsUrl(pair.server, "/v1/notify") + "?since=" + since).header("Authorization", "Bearer ${pair.token}").build()
    ws = client.newWebSocket(req, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        main.post {
          if (!current(webSocket, pair)) return@post
          connected = true
          backoff = 2_000L
          XiaoaiBus.emit("onNotifier", mapOf("connected" to true))
        }
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        val o = try { JSONObject(text) } catch (_: Throwable) { return }
        when (o.optString("type")) {
          "hello" -> main.post {
            if (current(webSocket, pair)) prefs.seedCursor(pair, since)
          }
          "notice" -> {
            val n = o.optJSONObject("notice") ?: return
            main.post { if (current(webSocket, pair)) handle(pair, n) }
          }
        }
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        lost(webSocket, response?.code == 401)
      }

      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(1000, null)
        if (code == 4001 || code == 4401) lost(webSocket, true)
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        lost(webSocket, code == 4001 || code == 4401)
      }
    })
  }

  private fun current(socket: WebSocket, pair: Prefs.Pairing): Boolean =
    running && socket === ws && target === pair && prefs.matches(pair)

  private fun lost(socket: WebSocket, revoked: Boolean) {
    main.post {
      val pair = target ?: return@post
      if (!current(socket, pair)) return@post
      connected = false
      XiaoaiBus.emit("onNotifier", mapOf("connected" to false))
      if (revoked) {
        // The phone was removed from the relay: stop instead of retrying forever.
        prefs.revoke(pair)
        stop()
        XiaoaiService.sync(ctx)
        return@post
      }
      main.removeCallbacks(retry)
      main.postDelayed(retry, backoff)
      backoff = minOf(backoff * 2, 60_000L)
    }
  }

  private fun handle(pair: Prefs.Pairing, n: JSONObject) {
    val id = n.optString("id")
    val ts = n.optLong("ts")
    if (id.isEmpty() || id.length > 128 || id.contains(',') || ts <= 0 || !prefs.remember(pair, id, ts)) return
    XiaoaiBus.emit("onNotice", mapOf("json" to n.toString()))
    if (!prefs.kinds.contains(n.optString("kind")) || !prefs.matches(pair)) return
    val task = n.optJSONObject("runtimeTask")
    val host = task?.optString("hostId")
    val session = task?.optString("sessionId")
    val path = if (host != null && session != null && RUNTIME_ID.matches(host) && RUNTIME_ID.matches(session)) {
      "dsh-task?host=${Uri.encode(host)}&session=${Uri.encode(session)}"
    } else "assistant"
    post(ctx, id, n.optString("title"), n.optString("body"), path)
  }
}

private val RUNTIME_ID = Regex("[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}")

fun post(ctx: Context, id: String, title: String, body: String, path: String = "assistant") {
  ensureChannels(ctx)
  val nm = NotificationManagerCompat.from(ctx)
  if (!nm.areNotificationsEnabled()) return
  val icon = ctx.applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info
  val n = NotificationCompat.Builder(ctx, ALERT_CHANNEL)
    .setSmallIcon(notificationIcon(ctx, icon))
    .setContentTitle(title)
    .setContentText(body)
    .setStyle(NotificationCompat.BigTextStyle().bigText(body))
    .setPriority(NotificationCompat.PRIORITY_HIGH)
    .setCategory(NotificationCompat.CATEGORY_REMINDER)
    .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
    .setAutoCancel(true)
    .setContentIntent(openAppIntent(ctx, path))
    .build()
  try {
    nm.notify(id.hashCode(), n)
  } catch (_: SecurityException) {
    // POST_NOTIFICATIONS was revoked; nothing to show.
  }
}

/** Status bar icons must be a white silhouette. */
@Suppress("UNUSED_PARAMETER")
fun notificationIcon(ctx: Context, fallback: Int): Int = R.drawable.xiaoaixiaoai_notification
