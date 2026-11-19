package dev.notifier.xiaoaixiaoai.bridge

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

private const val STATUS_ID = 4201

/**
 * Foreground service that keeps the alert channel open while the app is closed,
 * and hosts voice calls so they continue with the screen off.
 */
class XiaoaiService : Service() {
  companion object {
    const val ACTION_SYNC = "dev.notifier.xiaoaixiaoai.bridge.SYNC"
    const val ACTION_CALL = "dev.notifier.xiaoaixiaoai.bridge.CALL"
    const val ACTION_HANGUP = "dev.notifier.xiaoaixiaoai.bridge.HANGUP"

    @Volatile var notifier: Notifier? = null

    fun sync(ctx: Context) {
      val p = Prefs(ctx)
      if (!p.notify && VoiceCall.current == null) {
        ctx.stopService(Intent(ctx, XiaoaiService::class.java))
        return
      }
      ContextCompat.startForegroundService(ctx, Intent(ctx, XiaoaiService::class.java).setAction(ACTION_SYNC))
    }

    fun startCall(ctx: Context, server: String, token: String) {
      ContextCompat.startForegroundService(
        ctx,
        Intent(ctx, XiaoaiService::class.java).setAction(ACTION_CALL).putExtra("server", server).putExtra("token", token),
      )
    }

    fun hangup(ctx: Context) {
      VoiceCall.current?.hangup()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    ensureChannels(this)
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CALL -> {
        val server = intent.getStringExtra("server")
        val token = intent.getStringExtra("token")
        // The microphone type must be claimed before the call opens the mic.
        foreground(call = true)
        if (!server.isNullOrEmpty() && !token.isNullOrEmpty() && VoiceCall.current == null) {
          VoiceCall(applicationContext, server, token) { onCallEnded() }.start()
        }
      }
      ACTION_HANGUP -> VoiceCall.current?.hangup()
      else -> {
        // Every startForegroundService() must be answered with startForeground(), even if we stop right after.
        foreground(call = VoiceCall.current != null)
        refresh()
      }
    }
    return START_STICKY
  }

  private fun onCallEnded() {
    android.os.Handler(mainLooper).post { refresh() }
  }

  /** Notifier on or off per settings; the service ends when nothing needs it. */
  private fun refresh() {
    val p = Prefs(this)
    if (p.notify && !p.token.isNullOrEmpty()) {
      foreground(call = VoiceCall.current != null)
      val n = notifier ?: Notifier(applicationContext).also { notifier = it }
      n.start()
    } else {
      notifier?.stop()
      if (VoiceCall.current == null) {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
      } else {
        foreground(call = true)
      }
    }
  }

  private fun foreground(call: Boolean) {
    val name = Prefs(this).assistantName
    val icon = notificationIcon(this, applicationInfo.icon.takeIf { it != 0 } ?: android.R.drawable.ic_dialog_info)
    val b = NotificationCompat.Builder(this, STATUS_CHANNEL)
      .setSmallIcon(icon)
      .setOngoing(true)
      .setShowWhen(false)
      .setContentIntent(openAppIntent(this))
    if (call) {
      val hang = PendingIntent.getService(
        this,
        1,
        Intent(this, XiaoaiService::class.java).setAction(ACTION_HANGUP),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
      b.setContentTitle("正在和${name}通话").setContentText("点这里回到通话").setCategory(NotificationCompat.CATEGORY_CALL)
        .setPriority(NotificationCompat.PRIORITY_LOW)
        .addAction(0, "挂断", hang)
    } else {
      b.setContentTitle("${name}在线").setContentText("agent 需要你或跑完时会提醒你").setPriority(NotificationCompat.PRIORITY_MIN)
    }
    val notification: Notification = b.build()
    var type = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
      if (call) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    } else if (call && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    ServiceCompat.startForeground(this, STATUS_ID, notification, type)
  }

  override fun onDestroy() {
    notifier?.stop()
    notifier = null
    VoiceCall.current?.end("后台服务停止了")
    super.onDestroy()
  }
}

/** Brings the alert channel back after a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (Prefs(context).notify) {
      try {
        XiaoaiService.sync(context)
      } catch (_: Throwable) {
        // Some systems refuse a background start here; the app restarts it when opened.
      }
    }
  }
}
