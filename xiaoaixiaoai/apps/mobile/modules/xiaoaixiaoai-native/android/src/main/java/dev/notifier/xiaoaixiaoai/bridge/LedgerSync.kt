package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max

/**
 * Uploads WeChat notification-captured transactions to the relay with idempotent `externalId`
 * and falls back cleanly to cached snapshot math when offline, flushing the queue once connected.
 */
object LedgerSync {
  private val client = OkHttpClient.Builder()
    .connectTimeout(6, TimeUnit.SECONDS)
    .readTimeout(8, TimeUnit.SECONDS)
    .writeTimeout(6, TimeUnit.SECONDS)
    .build()
  private val JSON_TYPE = "application/json; charset=utf-8".toMediaType()

  fun submitOrQueue(ctx: Context, bill: ParsedWeChatBill, externalId: String, ts: Long) {
    val prefs = Prefs(ctx)
    val pair = prefs.ledgerPairing() ?: return
    val payload = JSONObject().apply {
      put("direction", bill.direction)
      put("amountCents", bill.amountCents)
      put("title", bill.title)
      if (!bill.note.isNullOrEmpty()) put("note", bill.note)
      put("source", "wechat_notify")
      put("externalId", externalId)
      put("ts", ts)
    }

    val synced = postTransaction(pair, payload)
    if (synced != null) {
      val dup = synced.optBoolean("duplicate", false)
      val state = synced.optJSONObject("state")
      if (state != null) prefs.setLedgerSnapshot(state.toString())
      if (!dup) {
        val alert = synced.optJSONObject("alert")
        val title = alert?.optString("title")?.takeIf { it.isNotEmpty() } ?: fallbackTitle(bill)
        val body = alert?.optString("body")?.takeIf { it.isNotEmpty() } ?: "已同步账单记录。"
        post(ctx, "ledger-$externalId", title, body, "ledger")
        XiaoaiBus.emit("onLedgerUpdated", emptyMap())
      }
      flushPending(ctx)
      return
    }

    // Offline fallback: persist idempotently for later sync AND alert using optimistic cached math.
    prefs.enqueuePendingLedger(payload)
    val offlineAlert = applyOptimisticCacheAndFormatAlert(prefs, bill, ts)
    post(ctx, "ledger-$externalId", offlineAlert.first, offlineAlert.second, "ledger")
    XiaoaiBus.emit("onLedgerUpdated", emptyMap())
  }

  fun flushPending(ctx: Context) {
    val prefs = Prefs(ctx)
    val pair = prefs.ledgerPairing() ?: return
    val queued = prefs.drainPendingLedger()
    if (queued.isEmpty()) return
    val remaining = mutableListOf<JSONObject>()
    var uploadedAny = false
    for (item in queued) {
      val res = postTransaction(pair, item)
      if (res != null) {
        uploadedAny = true
        val state = res.optJSONObject("state")
        if (state != null) prefs.setLedgerSnapshot(state.toString())
      } else {
        remaining.add(item)
      }
    }
    if (remaining.isNotEmpty()) prefs.restorePendingLedger(remaining)
    if (uploadedAny) XiaoaiBus.emit("onLedgerUpdated", emptyMap())
  }

  private fun postTransaction(pair: Prefs.Pairing, body: JSONObject): JSONObject? {
    val base = pair.server.trimEnd('/')
    val req = Request.Builder()
      .url("$base/v1/ledger/transactions")
      .header("Authorization", "Bearer ${pair.token}")
      .post(body.toString().toRequestBody(JSON_TYPE))
      .build()
    return try {
      client.newCall(req).execute().use { resp ->
        if (!resp.isSuccessful) return null
        val raw = resp.body?.string() ?: return null
        JSONObject(raw)
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun fallbackTitle(bill: ParsedWeChatBill): String {
    val yuan = formatYuan(bill.amountCents)
    return if (bill.direction == "income") "微信收款 $yuan 元" else "微信支出 $yuan 元"
  }

  private fun applyOptimisticCacheAndFormatAlert(prefs: Prefs, bill: ParsedWeChatBill, ts: Long): Pair<String, String> {
    val amt = formatYuan(bill.amountCents)
    val raw = prefs.ledgerSnapshot ?: return fallbackTitle(bill) to "「${bill.title}」已暂存，连网后同步。"
    return try {
      val root = JSONObject(raw)
      val cfg = root.optJSONObject("config") ?: return fallbackTitle(bill) to "「${bill.title}」已暂存。"
      if (!cfg.has("balanceCents") || cfg.isNull("balanceCents")) {
        return fallbackTitle(bill) to "「${bill.title}」已暂存（设置微信余额后可实时计算每日限额）。"
      }
      val cal = Calendar.getInstance().apply { timeInMillis = ts }
      val daysInMonth = cal.getActualMaximum(Calendar.DAY_OF_MONTH)
      val day = cal.get(Calendar.DAY_OF_MONTH)
      val daysLeftInclusive = max(1, daysInMonth - day + 1)
      val daysLeftAfter = max(0, daysInMonth - day)

      val delta = if (bill.direction == "income") bill.amountCents else -bill.amountCents
      val newBalance = cfg.getLong("balanceCents") + delta
      cfg.put("balanceCents", newBalance)

      val plan = root.optJSONObject("plan")
      val savingsGoal = cfg.optLong("savingsGoalCents", 0L)
      val unpaidFixed = plan?.optLong("unpaidFixedCents", 0L) ?: 0L
      val prevTodayDisc = plan?.optLong("todayDiscretionaryExpenseCents", 0L) ?: 0L
      val newTodayDisc = if (bill.direction == "expense") prevTodayDisc + bill.amountCents else prevTodayDisc

      val spendableNow = newBalance - unpaidFixed - savingsGoal
      val spendableStartToday = spendableNow + newTodayDisc
      val todayLimit = max(0L, floor(spendableStartToday.toDouble() / daysLeftInclusive).toLong())
      val todayRemaining = todayLimit - newTodayDisc
      if (plan != null) {
        plan.put("balanceCents", newBalance)
        plan.put("todayDiscretionaryExpenseCents", newTodayDisc)
        plan.put("spendableNowCents", spendableNow)
        plan.put("todayLimitCents", todayLimit)
        plan.put("todayRemainingCents", todayRemaining)
      }
      prefs.setLedgerSnapshot(root.toString())

      val balStr = formatYuan(newBalance)
      if (bill.direction == "income") {
        val quota = if (todayRemaining >= 0) "今天还能用 ${formatYuan(todayRemaining)} 元" else "今日仍超出 ${formatYuan(-todayRemaining)} 元"
        "微信收款 $amt 元" to "「${bill.title}」已入账（离线暂存），当前余额约 $balStr 元，$quota。"
      } else if (todayRemaining < 0) {
        val over = formatYuan(-todayRemaining)
        if (daysLeftAfter > 0) {
          val nextDaily = formatYuan(max(0L, floor(max(0L, spendableNow).toDouble() / daysLeftAfter).toLong()))
          "今日超支 $over 元" to "刚支出 $amt 元（${bill.title}），当前余额约 $balStr 元。已按剩余 $daysLeftAfter 天重算：明天起每天最多用 $nextDaily 元。"
        } else {
          "今日超支 $over 元" to "刚支出 $amt 元（${bill.title}），已是本月最后一天，当前余额约 $balStr 元。"
        }
      } else {
        "微信支出 $amt 元" to "「${bill.title}」已记账（离线暂存），当前余额约 $balStr 元，今天还能用 ${formatYuan(todayRemaining)} 元。"
      }
    } catch (_: Throwable) {
      fallbackTitle(bill) to "「${bill.title}」已暂存，连网后同步。"
    }
  }

  private fun formatYuan(cents: Long): String {
    val neg = if (cents < 0) "-" else ""
    val absCents = abs(cents)
    val whole = absCents / 100
    val rem = absCents % 100
    return if (rem == 0L) "$neg$whole" else "$neg$whole.${rem.toString().padStart(2, '0')}"
  }
}
