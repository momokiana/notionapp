package dev.notifier.app

import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val runtimeStates = setOf("running", "paused", "blocked", "unknown")
private val runtimeReasons = mapOf(
    "running" to setOf("RUNTIME_INITIALIZED", "RUNTIME_LOOP_OBSERVED", "MODEL_PERMISSION_DISABLED"),
    "paused" to setOf("SOURCE_PAUSED_EXPLICIT"),
    "blocked" to setOf("ORIGINAL_MODEL_RUN_UNRESOLVED", "MODEL_REQUEST_BUDGET_EXHAUSTED", "SOURCE_AUTHORIZATION_CHANGED", "RUNTIME_UNAVAILABLE", "RUNTIME_STOPPING"),
    "unknown" to setOf("RUNTIME_NOT_OBSERVED")
)
@Serializable data class SourceRuntimeObservation(
    val event_id: String, val event_version: Long, val source_id: String, val source_epoch: String,
    val state: String, val model_permission_configured: Boolean, val reason_code: String, val observed_at: String
) {
    companion object {
        fun parse(raw: String, event: Event): SourceRuntimeObservation = try {
            require(raw.toByteArray(Charsets.UTF_8).size <= 4096)
            val value = wire.parseToJsonElement(raw).jsonObject
            require(value.keys == setOf("event_id", "event_version", "source_id", "source_epoch", "state", "model_permission_configured", "reason_code", "observed_at"))
            for (key in listOf("event_id", "source_id", "source_epoch", "state", "reason_code", "observed_at")) require(value[key]?.jsonPrimitive?.isString == true)
            require(value["event_version"]?.jsonPrimitive?.let { !it.isString && it.longOrNull != null } == true)
            require(value["model_permission_configured"]?.jsonPrimitive?.let { !it.isString && it.booleanOrNull != null } == true)
            val result = wire.decodeFromString<SourceRuntimeObservation>(raw)
            require(result.event_id == event.id && result.event_version == event.event_version && result.source_id == event.source_id && deviceIdPattern.matches(result.source_epoch))
            require(result.state in runtimeStates && result.reason_code in runtimeReasons.getValue(result.state))
            require(result.reason_code != "MODEL_PERMISSION_DISABLED" || !result.model_permission_configured)
            require(result.observed_at.length <= 35); Instant.parse(result.observed_at)
            result
        } catch (_: Exception) { error("来源运行观察格式或关联不匹配；未修改原提交或内容缓存") }
    }
}
data class SourceRuntimeRead(val observation: SourceRuntimeObservation? = null, val unavailable: Boolean = false)

/** Event/epoch association is verified by the authoritative server, without changing the persistent Event/cache format. */
class SourceRuntimeClient(private val storage: StateStore, private val transport: Transport) {
    fun read(event: Event, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)): SourceRuntimeRead {
        val connection = synchronized(ConnectionGate.monitor) { val state = storage.load(); checkConnectionSnapshot(state, expected); state.connection ?: error("请先设置连接") }
        require(deviceIdPattern.matches(event.id) && deviceIdPattern.matches(event.source_id) && event.event_version in 1..9_007_199_254_740_991L)
        val result = try {
            SourceRuntimeRead(SourceRuntimeObservation.parse(transport.call(connection, "GET", "/v1/source-runtime/${event.source_id}?event_id=${event.id}&event_version=${event.event_version}"), event))
        } catch (e: ApiFailure) { if (e.status == 404) SourceRuntimeRead(unavailable = true) else throw e }
        synchronized(ConnectionGate.monitor) { checkConnectionSnapshot(storage.load(), expected) }
        return result
    }
}

fun sourceRuntimeText(read: SourceRuntimeRead?): String {
    val value = read?.observation ?: return if (read?.unavailable == true) "来源运行：服务未提供此事件原来源的可见观察；不代表来源已停止。" else "来源运行：未观察到当前状态；缓存不是运行资格证明。"
    val mode = when (value.state) {
        "paused" -> "来源已显式暂停处理。合法回应仍可先保存等待，不代表来源已收件。"
        "running" -> "来源处理循环已启动。每次输入仍会核验资格，不保证可立即处理。"
        "blocked" -> "来源处理当前受阻。保留原请求核验，不换会话或重复提交。"
        else -> "来源运行状态未知，不能据此推断已处理。"
    }
    val permission = if (value.model_permission_configured) "模型许可配置允许，不等于当前授权或预算可用。" else "模型调用许可未启用。"
    return "$mode\n$permission\n观察：${value.observed_at} · ${value.reason_code}"
}
