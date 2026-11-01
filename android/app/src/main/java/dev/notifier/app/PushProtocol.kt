package dev.notifier.app

import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable data class PushEnvelope(val event_id: String, val event_version: Long, val delivery_id: String, val nonce: String) {
    val fingerprint: String get() = java.security.MessageDigest.getInstance("SHA-256").digest(wire.encodeToString(serializer(), this).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    fun verifyReceipt(receipt: JsonObject) {
        require(receipt["delivery_id"]?.jsonPrimitive?.content == delivery_id && receipt["event_id"]?.jsonPrimitive?.content == event_id && receipt["event_version"]?.jsonPrimitive?.long == event_version && receipt["state"]?.jsonPrimitive?.content == "device_received") { "设备回执与推送引用不匹配" }
    }
    companion object {
        fun parse(bytes: ByteArray): PushEnvelope {
            require(bytes.size <= 4096)
            val value = wire.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
            require(value.keys == setOf("event_id", "event_version", "delivery_id", "nonce"))
            require(listOf("event_id", "delivery_id", "nonce").all { (value[it] as? JsonPrimitive)?.isString == true })
            require((value["event_version"] as? JsonPrimitive)?.isString == false)
            val result = wire.decodeFromJsonElement<PushEnvelope>(value)
            val id = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
            require(result.event_id.matches(id) && result.delivery_id.matches(id) && result.event_version in 1..9_007_199_254_740_991L && result.nonce.matches(Regex("[a-f0-9]{64}")))
            return result
        }
    }
}
@Serializable data class RegistrationRequest(val registration_id: String, val expected_generation: Long, val endpoint: String?)
@Serializable data class DeviceObservation(val envelope: PushEnvelope, val posting_unknown: Boolean = false, val posted: Boolean = false, val suppression: String? = null, val suppressed_at_version: Long? = null)
@Serializable data class PushAccount(
    val endpoint: String? = null, val revision: Long = 0, val status: String = "尚未注册推送",
    val registered_id: String? = null, val registration: RegistrationRequest? = null,
    val deliveries: Map<String, DeviceObservation> = emptyMap(), val watermarks: Map<String, Long> = emptyMap()
)
@Serializable data class PushDatabase(val accounts: Map<String, PushAccount> = emptyMap())
interface PushVault { fun load(): PushDatabase; fun save(state: PushDatabase) }
private object PushLock { val monitor = Any() }

/** All writers share one process lock; each connection keeps its own durable version/receipt ledger. */
class PushRecords(private val vault: PushVault, private val namespace: String) {
    init { require(namespace.matches(Regex("[a-f0-9]{64}"))) }
    fun snapshot(): PushAccount = synchronized(PushLock.monitor) { vault.load().accounts[namespace] ?: PushAccount() }
    fun update(transform: (PushAccount) -> PushAccount): PushAccount = synchronized(PushLock.monitor) {
        val db = vault.load(); val next = transform(db.accounts[namespace] ?: PushAccount())
        vault.save(db.copy(accounts = db.accounts + (namespace to next))); next
    }
    fun endpoint(endpoint: String?) = update { old ->
        if (old.endpoint == endpoint && old.revision > 0) old.copy(status = "等待服务端登记")
        else old.copy(endpoint = endpoint, revision = old.revision + 1, registration = null, registered_id = null, status = "等待服务端登记")
    }
    fun received(payload: PushEnvelope): DeviceObservation {
        var observed: DeviceObservation? = null
        update { state ->
            val prior = state.deliveries[payload.delivery_id]
            require(prior == null || prior.envelope == payload) { "重复投递关联不一致" }
            observed = prior ?: DeviceObservation(payload)
            state.copy(deliveries = state.deliveries + (payload.delivery_id to observed!!))
        }
        return observed!!
    }
    /** Reserve BEFORE notify. A crash in the OS window sacrifices a retry rather than causing a second alert. */
    fun post(payload: PushEnvelope, event: Event, permitted: () -> Boolean, notify: () -> Unit): DeviceObservation = synchronized(PushLock.monitor) {
        val state = snapshot(); val observed = state.deliveries[payload.delivery_id] ?: error("先持久保存设备接收")
        require(observed.envelope == payload && event.id == payload.event_id && event.event_version >= payload.event_version)
        if (observed.posted || observed.posting_unknown || observed.suppression != null || event.disposition != "open" || (state.watermarks[event.id] ?: 0) >= event.event_version || !permitted()) return@synchronized observed
        update { it.copy(watermarks = it.watermarks + (event.id to event.event_version), deliveries = it.deliveries + (payload.delivery_id to observed.copy(posting_unknown = true))) }
        notify()
        val posted = observed.copy(posting_unknown = false, posted = true)
        update { it.copy(deliveries = it.deliveries + (payload.delivery_id to posted)) }; posted
    }
    /** A deliberate local mute is a durable non-posting decision, never a posted receipt.
     * Observe the current version so duplicates/new delivery IDs cannot replay a muted card later. */
    fun suppress(payload: PushEnvelope, event: Event, reason: String): DeviceObservation = synchronized(PushLock.monitor) {
        require(reason in setOf("app_disabled", "source_muted", "quiet_hours"))
        val state = snapshot(); val observed = state.deliveries[payload.delivery_id] ?: error("先持久保存设备接收")
        require(observed.envelope == payload && event.id == payload.event_id && event.event_version >= payload.event_version)
        if (observed.posted || observed.posting_unknown || observed.suppression != null) return@synchronized observed
        val suppressed = observed.copy(suppression = reason, suppressed_at_version = event.event_version)
        update { it.copy(watermarks = it.watermarks + (event.id to maxOf(it.watermarks[event.id] ?: 0, event.event_version)), deliveries = it.deliveries + (payload.delivery_id to suppressed)) }
        suppressed
    }
    /** A repeated endpoint callback/retry is not a new endpoint generation; reconcile a known original operation. */
    fun confirmRegistration(revision: Long, remoteId: String?, registered: Boolean): Boolean = synchronized(PushLock.monitor) {
        val state = snapshot(); if (state.revision != revision) return@synchronized false
        val known = state.registration?.registration_id ?: state.registered_id
        if (known == null || known != remoteId || registered != (state.endpoint != null)) return@synchronized false
        update { it.copy(registered_id = known, registration = null, status = if (registered) "端点已登记，仍需真机验证后台/锁屏" else "推送端点已停用") }
        true
    }
    fun registration(revision: Long, generation: Long): RegistrationRequest? = synchronized(PushLock.monitor) {
        val state = snapshot(); if (state.revision != revision) return@synchronized null
        state.registration?.let { return@synchronized it }
        val request = RegistrationRequest(UUID.randomUUID().toString(), generation, state.endpoint)
        update { it.copy(registration = request) }; request
    }
}
