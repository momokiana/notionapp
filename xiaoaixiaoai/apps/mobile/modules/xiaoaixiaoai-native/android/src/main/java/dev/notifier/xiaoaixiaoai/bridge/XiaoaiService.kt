package dev.notifier.xiaoaixiaoai.bridge

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

private const val STATUS_ID = 4201
private const val KEEPALIVE_REQ = 4202
private const val KEEPALIVE_INTERVAL_MS = 4 * 60_000L

/**
 * Foreground service that keeps the alert channel open while the app is closed,
 * and hosts voice calls so they continue with the screen off.
 */
class XiaoaiService : Service() {
  companion object {
    const val ACTION_SYNC = "dev.notifier.xiaoaixiaoai.bridge.SYNC"
    const val ACTION_CALL = "dev.notifier.xiaoaixiaoai.bridge.CALL"
    const val ACTION_HANGUP = "dev.notifier.xiaoaixiaoai.bridge.HANGUP"
    const val ACTION_KEEPALIVE = "dev.notifier.xiaoaixiaoai.bridge.KEEPALIVE"

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
      ACTION_KEEPALIVE -> {
        foreground(call = VoiceCall.current != null)
        val pm = getSystemService(Context.POWER_SERVICE) as? PowerManager
        val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xiaoaixiaoai:keepalive")?.apply {
          setReferenceCounted(false)
          acquire(4_000L)
        }
        try {
          refresh(keepalive = true)
        } finally {
          try { if (wl?.isHeld == true) wl.release() } catch (_: Throwable) {}
        }
      }
      else -> {
        // Every startForegroundService() must be answered with startForeground(), even if we stop right after.
        foreground(call = VoiceCall.current != null)
        refresh(keepalive = false)
      }
    }
    return START_STICKY
  }

  private fun onCallEnded() {
    android.os.Handler(mainLooper).post { refresh() }
  }

  /** Notifier on or off per settings; the service ends when nothing needs it. */
  private fun refresh(keepalive: Boolean = false) {
    val p = Prefs(this)
    if (p.ledgerEnabled && p.ledgerPairing() != null) {
      Thread({ LedgerSync.flushPending(applicationContext) }, "ledger-flush").start()
    }
    if (p.notify && !p.token.isNullOrEmpty()) {
      foreground(call = VoiceCall.current != null)
      val n = notifier ?: Notifier(applicationContext).also { notifier = it }
      if (keepalive) n.ensureAlive() else n.start()
      scheduleKeepalive(this, KEEPALIVE_INTERVAL_MS)
    } else {
      cancelKeepalive(this)
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
      .setSilent(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
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
      b.setContentTitle("${name}在线").setContentText("agent 需要你或跑完时会提醒你").setPriority(NotificationCompat.PRIORITY_LOW)
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

  override fun onTaskRemoved(rootIntent: Intent?) {
    val p = Prefs(this)
    if (p.notify && !p.token.isNullOrEmpty()) {
      scheduleKeepalive(this, 1_500L)
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    val p = Prefs(this)
    if (!p.notify || p.token.isNullOrEmpty()) cancelKeepalive(this)
    notifier?.stop()
    notifier = null
    VoiceCall.current?.end("后台服务停止了")
    super.onDestroy()
  }

  private fun keepaliveIntent(ctx: Context): PendingIntent {
    val i = Intent(ctx, XiaoaiService::class.java).setAction(ACTION_KEEPALIVE)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(ctx, KEEPALIVE_REQ, i, flags)
    } else {
      PendingIntent.getService(ctx, KEEPALIVE_REQ, i, flags)
    }
  }

  private fun scheduleKeepalive(ctx: Context, delayMs: Long) {
    val am = ctx.getSystemService(AlarmManager::class.java) ?: return
    val triggerAt = SystemClock.elapsedRealtime() + delayMs
    val pi = keepaliveIntent(ctx)
    try {
      am.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pi)
    } catch (_: Throwable) {}
  }

  private fun cancelKeepalive(ctx: Context) {
    val am = ctx.getSystemService(AlarmManager::class.java) ?: return
    try { am.cancel(keepaliveIntent(ctx)) } catch (_: Throwable) {}
  }
}

/** Brings the alert channel back after a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val p = Prefs(context)
    if (p.ledgerEnabled && p.ledgerPairing() != null) {
      Thread({ LedgerSync.flushPending(context.applicationContext) }, "ledger-boot-flush").start()
    }
    if (p.notify) {
      try {
        XiaoaiService.sync(context)
      } catch (_: Throwable) {
        // Some systems refuse a background start here; the app restarts it when opened.
      }
    }
  }
}
