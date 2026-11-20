package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.os.PowerManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.app.Notification
import java.util.concurrent.Executors

/**
 * Listens exclusively to WeChat (`com.tencent.mm`) system notifications when the user explicitly
 * enables the WeChat ledger plugin. Casual friend chats are never read or persisted.
 */
class WeChatNotificationListener : NotificationListenerService() {
  private val executor = Executors.newSingleThreadExecutor()

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null || sbn.packageName != WECHAT_PACKAGE) return
    val notification = sbn.notification ?: return
    val flags = notification.flags
    if ((flags and Notification.FLAG_GROUP_SUMMARY) != 0) return
    if ((flags and Notification.FLAG_ONGOING_EVENT) != 0) return

    val prefs = Prefs(this)
    if (!prefs.ledgerEnabled || prefs.pairing() == null) return

    val extras = notification.extras ?: return
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
    val bestBody = if (!bigText.isNullOrBlank() && bigText.length >= (text?.length ?: 0)) bigText else text

    val parsed = WeChatBillParser.parse(title, bestBody) ?: return
    val bucket = (sbn.postTime.takeIf { it > 0L } ?: System.currentTimeMillis()) / 30_000L
    val dedupKey = "${parsed.direction}:${parsed.amountCents}:${parsed.title}:$bucket"
    val ts = sbn.postTime.takeIf { it > 0L } ?: System.currentTimeMillis()
    if (!prefs.rememberWeChatTx(dedupKey, ts)) return

    val externalId = "wc-${bucket}-${parsed.direction}-${parsed.amountCents}-${dedupKey.hashCode().toUInt()}"
    val ctx = applicationContext
    executor.execute {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xiaoaixiaoai:ledger")?.apply {
        setReferenceCounted(false)
        acquire(6_000L)
      }
      try {
        LedgerSync.submitOrQueue(ctx, parsed, externalId, ts)
      } finally {
        try { if (wl?.isHeld == true) wl.release() } catch (_: Throwable) {}
      }
    }
  }

  override fun onDestroy() {
    executor.shutdownNow()
    super.onDestroy()
  }

  companion object {
    const val WECHAT_PACKAGE = "com.tencent.mm"
  }
}
