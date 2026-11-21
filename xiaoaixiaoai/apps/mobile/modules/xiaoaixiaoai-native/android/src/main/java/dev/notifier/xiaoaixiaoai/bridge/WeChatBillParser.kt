package dev.notifier.xiaoaixiaoai.bridge

import java.math.BigDecimal

/** Parsed transaction extracted locally from a WeChat payment/receipt notification. */
data class ParsedWeChatBill(
  val direction: String, // "expense" | "income"
  val amountCents: Long,
  val title: String,
  val note: String?,
)

object WeChatBillParser {
  private val PAYMENT_TITLES = listOf("微信支付", "微信收款", "微信收款助手", "微信红包")
  private val IGNORE_PATTERNS = listOf(
    "免密支付提醒",
    "额度提醒",
    "账单已生成",
    "开通成功",
    "到期提醒",
    "积分变动",
    "安全验证",
    "登录确认",
    "请你确认收款",
    "待收款",
    "即将扣费",
    "退款申请",
  )

  private val INCOME_HINTS = listOf(
    "微信支付收款",
    "收款助手",
    "收款到账",
    "已收钱",
    "收到转账",
    "收到红包",
    "已存入零钱",
    "已退回",
    "退款到账",
    "赞赏",
    "收款",
    "入账",
  )

  private val EXPENSE_HINTS = listOf(
    "已支付",
    "成功付款",
    "扫二维码付款",
    "支付成功",
    "付款成功",
    "付款给",
    "向.+付款",
    "转账给",
    "消费",
    "扣款",
    "自动续费",
    "免密支付",
    "支付金额",
    "发出红包",
    "付款",
  )

  private val AMOUNT_YUAN = Regex("""(?:[￥¥]|人民币)?\s*(\d{1,7}(?:\.\d{1,2})?)\s*元""")
  private val AMOUNT_SYMBOL = Regex("""[￥¥]\s*(\d{1,7}(?:\.\d{1,2})?)""")
  private val PAYEE_PREFIX = Regex("""(?:收款方|付款方|商户|来自|向)[：:\s]*([^\n，,。；;￥¥]{1,28}?)(?=\s*(?:付款|已支付|支付成功|支付|收款|转账|消费|[￥¥]|\d+(?:\.\d+)?元|$))""")
  private val COLLAPSED_PREFIX = Regex("""^\s*\[(\d+)条\]\s*""")

  fun extractCollapsedCount(raw: String?): Int {
    if (raw.isNullOrBlank()) return 1
    val m = COLLAPSED_PREFIX.find(raw) ?: return 1
    return m.groupValues[1].toIntOrNull()?.coerceAtLeast(1) ?: 1
  }

  fun stripCollapsedPrefix(raw: String): String = raw.replace(COLLAPSED_PREFIX, "").trim()

  fun parse(titleRaw: String?, bodyRaw: String?, extraNote: String? = null): ParsedWeChatBill? {
    val title = stripCollapsedPrefix(titleRaw?.trim().orEmpty())
    val body = stripCollapsedPrefix(bodyRaw?.trim().orEmpty())
    if (title.isEmpty() && body.isEmpty()) return null

    val combined = "$title $body"
    val isPaymentChannel = PAYMENT_TITLES.any { title.contains(it) || body.startsWith(it) || combined.contains(it) }
    val hasExplicitAction = INCOME_HINTS.any { combined.contains(it) } || EXPENSE_HINTS.any {
      if (it.contains(".+")) Regex(it).containsMatchIn(combined) else combined.contains(it)
    }
    if (!isPaymentChannel && !hasExplicitAction) return null
    if (!isPaymentChannel && !combined.contains("微信") && !combined.contains("零钱") && !combined.contains("收款") && !combined.contains("付款")) {
      // Avoid matching casual friend chats such as "给我 50 元"
      return null
    }
    if (IGNORE_PATTERNS.any { combined.contains(it) }) return null

    val direction = when {
      INCOME_HINTS.any { combined.contains(it) } -> "income"
      EXPENSE_HINTS.any { if (it.contains(".+")) Regex(it).containsMatchIn(combined) else combined.contains(it) } -> "expense"
      else -> return null
    }

    val amountCents = extractAmountCents(body) ?: extractAmountCents(title) ?: return null
    if (amountCents <= 0L || amountCents > 50_000_000L) return null

    val merchant = extractLabel(title, body, direction)
    val baseNote = body.replace('\n', ' ').trim().take(100).takeIf { it.isNotEmpty() && it != merchant }
    val note = listOfNotNull(baseNote, extraNote?.takeIf { it.isNotBlank() }).joinToString(" ").take(140).ifEmpty { null }
    return ParsedWeChatBill(direction = direction, amountCents = amountCents, title = merchant, note = note)
  }

  private fun extractAmountCents(text: String): Long? {
    val m = AMOUNT_YUAN.find(text) ?: AMOUNT_SYMBOL.find(text) ?: return null
    val num = m.groupValues[1]
    return try {
      val bd = BigDecimal(num)
      bd.movePointRight(2).longValueExact()
    } catch (_: Throwable) {
      null
    }
  }

  private fun extractLabel(title: String, body: String, direction: String): String {
    val payeeMatch = PAYEE_PREFIX.find(body)
    if (payeeMatch != null) {
      val picked = payeeMatch.groupValues[1].trim()
      if (picked.isNotEmpty() && !picked.startsWith("微信支付")) return picked.take(40)
    }
    if (title.isNotEmpty() && PAYMENT_TITLES.none { it == title }) {
      return title.take(40)
    }
    return if (direction == "income") "微信收款" else "微信消费"
  }
}
