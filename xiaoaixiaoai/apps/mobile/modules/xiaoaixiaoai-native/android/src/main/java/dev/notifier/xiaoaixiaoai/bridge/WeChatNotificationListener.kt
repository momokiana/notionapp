package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.os.Build
import android.os.Bundle
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
    val isSummary = (flags and Notification.FLAG_GROUP_SUMMARY) != 0
    if ((flags and Notification.FLAG_ONGOING_EVENT) != 0) return

    val prefs = Prefs(this)
    if (!prefs.ledgerEnabled || prefs.ledgerPairing() == null) return

    val extras = notification.extras ?: return
    val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()
    val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()
    val bigText = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()
    val textLines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)
      ?.mapNotNull { it?.toString()?.trim()?.takeIf { line -> line.isNotEmpty() } }
      .orEmpty()
    val messagingLines = extractMessagingLines(extras)
    val multiLines = if (messagingLines.size >= textLines.size) messagingLines else textLines

    if (isSummary && multiLines.isEmpty()) return

    val bestBody = if (!bigText.isNullOrBlank() && bigText.length >= (text?.length ?: 0)) bigText else text
    val collapsedCount = maxOf(
      WeChatBillParser.extractCollapsedCount(text),
      WeChatBillParser.extractCollapsedCount(bigText),
      multiLines.size.coerceAtLeast(1),
    )

    val candidateLines = if (multiLines.isNotEmpty()) {
      multiLines.map { WeChatBillParser.stripCollapsedPrefix(it) }.filter { it.isNotEmpty() }
    } else {
      val single = bestBody?.let { WeChatBillParser.stripCollapsedPrefix(it) }?.takeIf { it.isNotEmpty() }
      if (single != null) listOf(single) else emptyList()
    }
    if (candidateLines.isEmpty()) return

    val ts = sbn.postTime.takeIf { it > 0L } ?: System.currentTimeMillis()
    val cardKey = if (isSummary) "summary:${sbn.key}" else sbn.key
    val newLines = prefs.consumeWeChatCardLines(cardKey, ts, candidateLines, collapsedCount)
    if (newLines.isEmpty()) return

    val parsedEntries = ArrayList<Pair<ParsedWeChatBill, String>>()
    for ((idx, item) in newLines.withIndex()) {
      val extraNote = if (item.collapsedHintCount > 1) {
        "（微信折叠了${item.collapsedHintCount}条消息中的最新一笔）"
      } else null
      val parsed = WeChatBillParser.parse(title, item.text, extraNote) ?: continue
      val childSig = "sig:${parsed.direction}:${parsed.amountCents}:${WeChatBillParser.stripCollapsedPrefix(item.text)}"
      if (isSummary) {
        // Group summary only backfills lines whose child notification was missed by the OS.
        if (!prefs.rememberWeChatTx(childSig, ts)) continue
      } else if (item.countDelta <= 0) {
        prefs.rememberWeChatTx(childSig, ts)
      } else {
        // Distinct incremented folded count (e.g. [1条] -> [2条] back-to-back identical ¥5.00 bills): always record.
        prefs.rememberWeChatTx("$childSig:c$collapsedCount:$idx", ts)
      }
      val externalId = "wc-$ts-c$collapsedCount-$idx-${parsed.direction}-${parsed.amountCents}-${(cardKey + ":" + item.text).hashCode().toUInt()}"
      parsedEntries.add(parsed to externalId)
    }
    if (parsedEntries.isEmpty()) return

    val ctx = applicationContext
    executor.execute {
      val pm = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager
      val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "xiaoaixiaoai:ledger")?.apply {
        setReferenceCounted(false)
        acquire(6_000L)
      }
      try {
        for ((parsed, externalId) in parsedEntries) {
          LedgerSync.submitOrQueue(ctx, parsed, externalId, ts)
        }
      } finally {
        try { if (wl?.isHeld == true) wl.release() } catch (_: Throwable) {}
      }
    }
  }

  private fun extractMessagingLines(extras: Bundle): List<String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return emptyList()
    val raw = try {
      @Suppress("DEPRECATION")
      extras.getParcelableArray(Notification.EXTRA_MESSAGES)
    } catch (_: Throwable) {
      null
    } ?: return emptyList()
    val out = ArrayList<String>(raw.size)
    for (entry in raw) {
      val b = entry as? Bundle ?: continue
      val t = b.getCharSequence("text")?.toString()?.trim()
      if (!t.isNullOrEmpty()) out.add(t)
    }
    return out
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification?) {
    if (sbn == null || sbn.packageName != WECHAT_PACKAGE) return
    val flags = sbn.notification?.flags ?: 0
    val cardKey = if ((flags and Notification.FLAG_GROUP_SUMMARY) != 0) "summary:${sbn.key}" else sbn.key
    Prefs(this).forgetWeChatCard(cardKey)
  }

  override fun onDestroy() {
    executor.shutdownNow()
    super.onDestroy()
  }

  companion object {
    const val WECHAT_PACKAGE = "com.tencent.mm"
  }
}
