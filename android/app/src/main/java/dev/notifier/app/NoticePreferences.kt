package dev.notifier.app

import java.time.LocalTime
import kotlinx.serialization.Serializable

@Serializable data class NoticePreferences(
    val format: Int = 1, val enabled: Boolean = true, val lock_screen: String = "secret",
    val quiet_enabled: Boolean = false, val quiet_start: Int = 22 * 60, val quiet_end: Int = 8 * 60,
    val muted_sources: Map<String, Set<String>> = emptyMap()
) {
    fun validate() {
        require(format == 1 && lock_screen in setOf("secret", "generic")) { "通知偏好格式不支持" }
        require(quiet_start in 0..1439 && quiet_end in 0..1439 && quiet_start != quiet_end) { "静默起止须是不同的有效时间" }
        require(muted_sources.size <= 32 && muted_sources.values.sumOf { it.size } <= 1000) { "静默来源设置已达容量上限" }
        muted_sources.forEach { (namespace, ids) ->
            require(namespace.matches(Regex("[a-f0-9]{64}")) && ids.size <= 200)
            require(ids.all { it.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")) })
        }
    }
    /** Evaluated at the actual notify boundary using the current local clock/timezone. */
    fun suppression(namespace: String, source: String, local: LocalTime = LocalTime.now()): String? {
        validate()
        if (!enabled) return "app_disabled"
        if (source in (muted_sources[namespace] ?: emptySet())) return "source_muted"
        val minute = local.hour * 60 + local.minute
        val quiet = if (quiet_start < quiet_end) minute >= quiet_start && minute < quiet_end else minute >= quiet_start || minute < quiet_end
        return if (quiet_enabled && quiet) "quiet_hours" else null
    }
    companion object {
        fun parseTime(value: String): Int {
            require(value.matches(Regex("(?:[01][0-9]|2[0-3]):[0-5][0-9]"))) { "请按24小时HH:mm填写时间" }
            return value.substring(0, 2).toInt() * 60 + value.substring(3).toInt()
        }
        fun displayTime(minute: Int) = "%02d:%02d".format(java.util.Locale.ROOT, minute / 60, minute % 60)
    }
}

/** Preference commit/cancellation and the complete OS posting transaction use the SAME order. */
fun localNoticeStatus(eventId: String, delivery: NotificationDelivery, observation: DeviceObservation?): String? {
    val item = observation ?: return null
    if (item.envelope.event_id != eventId || item.envelope.delivery_id != delivery.id || item.envelope.event_version != delivery.version) return null
    val prefix = "本机原投递 v${delivery.version}："
    if (item.posting_unknown) return prefix + "OS请求效果未知，保留原记录，不重试提醒。"
    if (item.posted) return prefix + "已请求系统提醒，不证明用户看见或听见。"
    val reason = when (item.suppression) { "app_disabled" -> "本机总开关关闭"; "source_muted" -> "当前连接来源静默"; "quiet_hours" -> "本机静默时段"; else -> null }
    if (reason != null) return prefix + "因${reason}未请求OS（当时观察到事件v${item.suppressed_at_version}）；此版本不补发，不代表事件从未提醒。"
    return prefix + "已记录接收，尚无OS请求结果；权限/渠道或当时状态可能限制，请检查设置。"
}

object NoticeGate { val monitor = Any() }
interface NoticeVault { fun load(): NoticePreferences; fun save(value: NoticePreferences) }

fun postWithNoticePreferences(vault: NoticeVault, records: PushRecords, namespace: String, payload: PushEnvelope, event: Event,
    permitted: () -> Boolean, localTime: () -> LocalTime = { LocalTime.now() }, notify: (NoticePreferences) -> Unit
): DeviceObservation = synchronized(NoticeGate.monitor) {
    val preferences = vault.load().also { it.validate() }
    val reason = preferences.suppression(namespace, event.source_id, localTime())
    if (reason != null) records.suppress(payload, event, reason)
    else records.post(payload, event, permitted) { notify(preferences) }
}
