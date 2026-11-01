package dev.notifier.app

import java.net.HttpURLConnection
import java.net.URI
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

val wire = Json { ignoreUnknownKeys = true; encodeDefaults = true }
@Serializable data class Action(val id: String, val label: String, val type: String)
@Serializable data class Interaction(val id: String, val version: Long, val actions: List<Action>)
@Serializable data class ReadState(val version: Long = 0, val unread: Boolean = true)
@Serializable data class NotificationDelivery(val id: String, val version: Long, val platform_state: String, val device_received_at: String? = null, val notification_posted_at: String? = null)
@Serializable data class Event(
    val id: String, val title: String, val body: String, val source_id: String,
    val event_version: Long, val interaction_version: Long, val interaction: Interaction? = null,
    val reserved_response_id: String? = null, val disposition: String, val expires_at: String,
    val updated_at: String, val read_state: ReadState = ReadState(), val can_respond: Boolean = false,
    val delivery_state: String = "not_observed", val verification: String = "not_verified",
    val notification_delivery: NotificationDelivery? = null, val previous_notification_delivery: NotificationDelivery? = null
)
@Serializable data class Page<T>(val items: List<T>, val next_after: String? = null)
@Serializable data class History(val seq: Long, val kind: String, val created_at: String, val data: JsonObject)
@Serializable class Connection private constructor(val base: String, val token: String, private val binding_namespace: String? = null) {
    constructor(base: String, token: String) : this(base, token, null)
    init { require(binding_namespace == null || credentialPattern.matches(binding_namespace)) { "本机连接绑定损坏，不能自动重置" } }
    val namespace: String get() = binding_namespace ?: credentialDigest("$base\n$token")
    // Manual copies never carry an inherited binding. Only the verified transition below may create one.
    fun copy(base: String = this.base, token: String = this.token): Connection = Connection(base, token)
    override fun equals(other: Any?): Boolean = other is Connection && base == other.base && token == other.token && binding_namespace == other.binding_namespace
    override fun hashCode(): Int = 31 * (31 * base.hashCode() + token.hashCode()) + (binding_namespace?.hashCode() ?: 0)
    override fun toString(): String = "Connection(base=$base, token=REDACTED)"
    companion object {
        internal fun afterVerifiedRotation(previous: Connection, replacement: String, before: ManagedDevice, current: ManagedDevice, requestId: String, proof: CredentialTransition): Connection {
            before.validate(); current.validate()
            require(!before.revoked && !current.revoked && credentialPattern.matches(replacement) && replacement != previous.token && deviceIdPattern.matches(requestId)) { "原轮换意图或凭据格式不匹配" }
            require(current.store_id == before.store_id && current.device_id == before.device_id && current.owner_id == before.owner_id && current.credential_version == before.credential_version + 1 && proof.store_id == before.store_id && proof.device_id == before.device_id && proof.owner_id == before.owner_id && proof.request_id == requestId && proof.previous_credential_hash == credentialDigest(previous.token) && proof.replacement_credential_hash == credentialDigest(replacement) && proof.previous_credential_version == before.credential_version && proof.credential_version == current.credential_version) { "原轮换关联不匹配，保留原凭据与未决提交" }
            return Connection(previous.base, replacement, previous.namespace)
        }
        fun parse(base: String, token: String, debug: Boolean): Connection {
            val u = URI(base.trim().trimEnd('/'))
            require(u.userInfo == null && u.query == null && u.fragment == null && u.host != null && u.port != 0) { "地址不能包含账号、查询参数或片段" }
            require(u.rawPath.isNullOrEmpty() || u.rawPath == "/") { "请填写服务根地址，不含路径" }
            val local = u.host in listOf("localhost", "127.0.0.1", "[::1]", "::1")
            require(u.scheme == "https" || (debug && local && u.scheme == "http")) { "请使用 HTTPS；调试版仅允许回环 HTTP" }
            require(token.matches(Regex("[a-f0-9]{64}"))) { "凭据应为 64 位小写十六进制用户 token" }
            return Connection(u.toASCIIString().trimEnd('/'), token)
        }
    }
}
class ApiFailure(val status: Int, val code: String) : Exception("请求被拒绝：$code ($status)")
interface Transport { fun call(connection: Connection, method: String, path: String, body: String? = null): String }
// Pages contain <=50 fixed-schema records. T001 snapshots have <20,000 string code points;
// T003 correlated receipts keep the total below 24,000 (<=6 UTF-8 JSON bytes per point).
// 50 * (24,000*6 + 8,192 fixed keys/structure bytes) + envelope <7.3 MiB; 8 MiB stays bounded.
const val MAX_PAGE_RESPONSE_BYTES = 8 * 1024 * 1024
class HttpTransport : Transport {
    override fun call(connection: Connection, method: String, path: String, body: String?): String {
        require(path.startsWith("/v1/"))
        val c = URI(connection.base + path).toURL().openConnection() as HttpURLConnection
        try {
            c.instanceFollowRedirects = false; c.connectTimeout = 10_000; c.readTimeout = 15_000
            c.requestMethod = method; c.setRequestProperty("Authorization", "Bearer ${connection.token}")
            if (body != null) {
                c.doOutput = true; c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = c.responseCode
            val stream = if (status in 200..299) c.inputStream else c.errorStream
            val bytes = stream?.use { input ->
                val out = java.io.ByteArrayOutputStream()
                val chunk = ByteArray(8192)
                while (out.size() <= MAX_PAGE_RESPONSE_BYTES) {
                    val n = input.read(chunk, 0, minOf(chunk.size, MAX_PAGE_RESPONSE_BYTES + 1 - out.size()))
                    if (n < 0) break
                    out.write(chunk, 0, n)
                }
                out.toByteArray()
            } ?: byteArrayOf()
            require(bytes.size <= MAX_PAGE_RESPONSE_BYTES) { "服务响应超出限额" }
            val result = bytes.toString(Charsets.UTF_8)
            if (status != 200) {
                val code = runCatching { wire.parseToJsonElement(result).jsonObject["error"]!!.jsonObject["code"]!!.jsonPrimitive.content }.getOrDefault("HTTP_ERROR")
                throw ApiFailure(status, code.takeIf { it.matches(Regex("[A-Z][A-Z0-9_]{0,79}")) } ?: "HTTP_ERROR")
            }
            return result
        } finally { c.disconnect() }
    }
}
@Serializable data class Pending(val namespace: String, val id: String, val path: String, val body: String, val response: Boolean, val uncertain: Boolean = false, val draft: ResponseDraft? = null)
@Serializable data class LocalState(val connection: Connection? = null, val pending: Pending? = null, val device: ManagedDevice? = null, val auth_intent: AuthIntent? = null, val drafts: List<ResponseDraft> = emptyList(), val templates: List<ReplyTemplate> = emptyList())
interface StateStore { fun load(): LocalState; fun save(state: LocalState) }

/** A single durable write slot. Persist before sending, including the uncertainty marker. */
class Ledger(private val storage: StateStore, private val transport: Transport) {
    fun state(): LocalState = synchronized(ConnectionGate.monitor) { storage.load() }
    fun connect(connection: Connection, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        val old = state(); checkConnectionSnapshot(old, expected)
        check(old.auth_intent == null) { "有未决身份操作，须对账原请求；不能切换连接" }
        val next = old.connection?.takeIf { it.base == connection.base && it.token == connection.token } ?: Connection(connection.base, connection.token)
        check(old.pending == null || old.connection == next) { "有未知提交，须先在原连接对账；不能切换连接" }
        storage.save(old.copy(connection = next, device = old.device.takeIf { next == old.connection }))
    }
    fun disconnect(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(state(), expected)
        check(state().pending == null && state().auth_intent == null) { "有未知提交或身份操作，不能删除原连接" }
        storage.save(state().copy(connection = null, device = null))
    }
    private fun writable() { val state = state(); check(state.auth_intent == null && state.device?.revoked != true) { "请先对账原身份操作；已撤销的连接不能提交新写入" } }
    private fun connection() = state().connection ?: error("请先设置连接")
    fun events(after: String? = null): Page<Event> = wire.decodeFromString(transport.call(connection(), "GET", "/v1/events?limit=50&after=${cursor(after)}"))
    fun event(id: String): Event = wire.decodeFromString(transport.call(connection(), "GET", "/v1/events/${safe(id)}"))
    fun history(id: String, after: String? = null): Page<History> = wire.decodeFromString(transport.call(connection(), "GET", "/v1/events/${safe(id)}/history?limit=50&after=${cursor(after)}"))
    fun response(id: String): JsonObject = wire.parseToJsonElement(transport.call(connection(), "GET", "/v1/responses/${safe(id)}")).jsonObject
    fun read(event: Event, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)): Unit = synchronized(ConnectionGate.monitor) { checkConnectionSnapshot(state(), expected); writable(); transport.call(connection(), "PUT", "/v1/events/${safe(event.id)}/read-state", "{\"event_version\":${event.event_version}}"); Unit }
    fun respond(event: Event, action: Action, text: String, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(state(), expected); writable()
        begin(responsePending(event, action, text))
    }
    fun submitDraft(confirmation: DraftConfirmation, expected: ConnectionSnapshot, stillConfirmed: () -> Boolean = { true }) = synchronized(ConnectionGate.monitor) {
        val old = state(); checkConnectionSnapshot(old, expected); writable(); originalDraft(old, confirmation.draft)
        check(old.pending == null) { "请先对账未决提交" }
        val latest = event(confirmation.draft.event_id)
        checkConnectionSnapshot(state(), expected); originalDraft(state(), confirmation.draft)
        draftTarget(confirmation.draft, latest)
        check(latest == confirmation.current) { "在线事件已变化，未提交；请重新联网核对并确认" }
        check(stillConfirmed()) { "确认已因离页或切到后台失效，草稿保留；请重新核对" }
        begin(responsePending(latest, confirmation.draft.action, confirmation.draft.text, confirmation.draft))
    }
    private fun responsePending(event: Event, action: Action, text: String, draft: ResponseDraft? = null): Pending {
        check(event.can_respond) { "当前卡片不能回应，请刷新" }
        require(text.codePointCount(0, text.length) <= 4000 && (action.type != "text" || text.isNotBlank())) { "文字不能为空，且不能超过 4000 字符" }
        val interaction = event.interaction ?: error("无交互")
        require(interaction.actions.contains(action))
        val id = UUID.randomUUID().toString()
        val body = buildJsonObject {
            put("response_id", id); put("event_version", event.event_version); put("interaction_id", interaction.id)
            put("interaction_version", interaction.version); put("action_id", action.id); put("text", text)
        }.toString()
        return Pending(connection().namespace, id, "/v1/events/${safe(event.id)}/responses", body, true, draft = draft)
    }
    fun decide(event: Event, disposition: String, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(state(), expected); writable()
        require(disposition in listOf("open", "paused", "completed", "not_tracking"))
        val id = UUID.randomUUID().toString()
        val body = buildJsonObject { put("request_id", id); put("expected_event_version", event.event_version); put("disposition", disposition) }.toString()
        begin(Pending(connection().namespace, id, "/v1/events/${safe(event.id)}/disposition", body, false))
    }
    private fun begin(p: Pending) {
        val old = state()
        check(old.pending == null) { "请先对账未决提交" }
        p.draft?.let { originalDraft(old, it) }
        val next = old.copy(pending = p, drafts = old.drafts.filterNot { it.id == p.draft?.id })
        checkedLocalBytes(next)
        // Removal and original write intent are ONE AtomicFile commit, before any POST.
        storage.save(next)
        send(p, first = true)
    }
    private fun resolved(restoreDraft: Boolean = false) {
        val old = state(); val draft = old.pending?.draft.takeIf { restoreDraft }
        val next = old.copy(pending = null, drafts = if (draft == null) old.drafts else old.drafts + draft)
        checkedLocalBytes(next); storage.save(next)
    }
    private fun send(p: Pending, first: Boolean) {
        check(p.namespace == connection().namespace)
        // If killed after this durable write, a later refusal cannot erase the unknown operation.
        storage.save(state().copy(pending = p.copy(uncertain = true)))
        try {
            val receipt = wire.parseToJsonElement(transport.call(connection(), "POST", p.path, p.body)).jsonObject
            check(receipt[if (p.response) "response_id" else "event_id"]?.jsonPrimitive?.content == if (p.response) p.id else p.path.split('/')[3]) { "回执关联不匹配，保留未知提交" }
            resolved()
        } catch (e: ApiFailure) {
            if (first && !p.uncertain && e.status in listOf(409, 410, 422) && e.code in setOf("EVENT_VERSION_CONFLICT", "INTERACTION_VERSION_CONFLICT", "ACTION_ALREADY_RESERVED", "SOURCE_READ_ONLY", "EVENT_CLOSED", "ACTION_EXPIRED", "INVALID_INPUT")) resolved(restoreDraft = true)
            throw e
        }
    }
    fun recover(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace), expectedId: String? = storage.load().pending?.id): Unit = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(state(), expected); writable()
        val p = state().pending ?: return@synchronized
        check(p.id == expectedId) { "原未决提交已改变，不能替另一个请求重放" }
        check(p.namespace == connection().namespace) { "须恢复原连接才能对账" }
        if (p.response) {
            try {
                val found = response(p.id)
                check(found["id"]?.jsonPrimitive?.content == p.id && found["event_id"]?.jsonPrimitive?.content == p.path.split('/')[3]) { "回应对账关联不匹配" }
                resolved(); return@synchronized
            } catch (e: ApiFailure) { if (e.status != 404) throw e }
        }
        send(p, first = false)
    }
    private fun safe(id: String): String { require(id.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}"))); return id }
    private fun cursor(after: String?): String { val s = after ?: "0"; require(s.matches(Regex("[0-9]{1,16}"))); return s }
}
