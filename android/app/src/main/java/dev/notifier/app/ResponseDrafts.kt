package dev.notifier.app

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

const val MAX_RESPONSE_DRAFTS = 8
const val MAX_REPLY_TEMPLATES = 12
const val MAX_LOCAL_STATE_BYTES = 128 * 1024

@Serializable data class ResponseDraft(
    val id: String, val namespace: String, val event_id: String, val source_id: String,
    val event_version: Long, val interaction_id: String, val interaction_version: Long,
    val action: Action, val title: String, val expires_at: String, val text: String, val saved_at: String
)
@Serializable data class ReplyTemplate(val id: String, val title: String, val text: String)
/** Ephemeral preview only. Never serialized or used as a queued permission. */
data class DraftConfirmation(val draft: ResponseDraft, val current: Event)

/** A late read cannot resurrect a preview invalidated by navigation or lifecycle. */
class DraftReviewGate {
    private val generation = java.util.concurrent.atomic.AtomicLong()
    fun invalidate() { generation.incrementAndGet() }
    fun ticket(): Long = generation.get()
    fun accepts(ticket: Long): Boolean = generation.get() == ticket
}

internal fun boundedText(text: String, max: Int) = text.codePointCount(0, text.length) <= max
internal fun validateDraft(d: ResponseDraft) {
    val id = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
    require(listOf(d.id, d.event_id, d.source_id, d.interaction_id, d.action.id).all { id.matches(it) } &&
        d.namespace.matches(Regex("[a-f0-9]{64}")) && d.event_version > 0 && d.interaction_version > 0 &&
        d.action.type in setOf("button", "text") && d.action.label.isNotBlank() && boundedText(d.action.label, 100) &&
        d.title.isNotBlank() && boundedText(d.title, 200) && boundedText(d.text, 4000) &&
        (if (d.action.type == "text") d.text.isNotBlank() else d.text.isEmpty())) { "草稿结构或文字不合法，原状态保留" }
    Instant.parse(d.expires_at); Instant.parse(d.saved_at)
}
internal fun validateWorkspace(state: LocalState) {
    require(state.drafts.size + (if (state.pending?.draft == null) 0 else 1) <= MAX_RESPONSE_DRAFTS && state.drafts.map { it.id }.distinct().size == state.drafts.size) { "本机草稿已满，最多8份；请先处理或删除未发送草稿" }
    state.drafts.forEach(::validateDraft)
    state.pending?.draft?.let { d ->
        validateDraft(d)
        val pending = state.pending
        require(pending.response && pending.namespace == d.namespace && pending.path == "/v1/events/${d.event_id}/responses" && state.drafts.none { it.id == d.id }) { "草稿与原未决请求重复或不匹配，停止新操作" }
        val body = wire.parseToJsonElement(pending.body).jsonObject
        require(body["response_id"]?.jsonPrimitive?.content == pending.id && body["interaction_id"]?.jsonPrimitive?.content == d.interaction_id && body["interaction_version"]?.jsonPrimitive?.long == d.interaction_version && body["action_id"]?.jsonPrimitive?.content == d.action.id && body["text"]?.jsonPrimitive?.content == d.text) { "原草稿恢复材料与请求不匹配" }
    }
    require(state.templates.size <= MAX_REPLY_TEMPLATES && state.templates.map { it.id }.distinct().size == state.templates.size) { "快捷回复最多12条，原设置保留" }
    state.templates.forEach {
        require(it.id.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")) && it.title.isNotBlank() && boundedText(it.title, 40) && it.text.isNotBlank() && boundedText(it.text, 1000)) { "快捷回复标题1至40字符，正文1至1000字符" }
    }
}
internal fun checkedLocalBytes(state: LocalState): ByteArray {
    validateWorkspace(state)
    return wire.encodeToString(LocalState.serializer(), state).toByteArray(Charsets.UTF_8).also {
        check(it.size <= MAX_LOCAL_STATE_BYTES - 28) { "本机原子状态达到128KiB容量上限，原状态保留；请处理未发送草稿或缩短模板" }
    }
}
internal fun originalDraft(state: LocalState, draft: ResponseDraft): ResponseDraft {
    check(state.connection?.namespace == draft.namespace && state.drafts.singleOrNull { it.id == draft.id } == draft) { "连接或原草稿已改变，请重新选择；未采用迟到操作" }
    return draft
}
internal fun draftTarget(d: ResponseDraft, e: Event) {
    validateDraft(d)
    check(e.id == d.event_id && e.source_id == d.source_id && e.event_version >= d.event_version) { "原事件关联或版本已改变，草稿保留" }
    check(e.interaction?.id == d.interaction_id && e.interaction.version == d.interaction_version && e.interaction_version == d.interaction_version && e.interaction.actions.contains(d.action)) { "问题或动作已改变，不能自动改绑；请阅读当前问题后另存草稿" }
    check(e.can_respond && e.reserved_response_id == null && e.disposition == "open" && Instant.parse(e.expires_at).isAfter(Instant.now())) { "当前不可回应或已过期，草稿保留" }
}

/** Local editing shares the complete identity/write transaction gate. It never performs a remote write. */
class ResponseDrafts(private val storage: StateStore, private val ledger: Ledger, private val now: () -> String = { Instant.now().toString() }) {
    private fun save(state: LocalState) { checkedLocalBytes(state); storage.save(state) }
    fun create(event: Event, action: Action, text: String, expected: ConnectionSnapshot): ResponseDraft = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected)
        val ns = state.connection?.namespace ?: error("请先设置连接")
        val interaction = event.interaction ?: error("该缓存没有交互，不能准备草稿")
        require(interaction.actions.contains(action) && event.interaction_version == interaction.version)
        val draft = ResponseDraft(UUID.randomUUID().toString(), ns, event.id, event.source_id, event.event_version, interaction.id, interaction.version, action, event.title, event.expires_at, text, now())
        validateDraft(draft); save(state.copy(drafts = state.drafts + draft)); draft
    }
    fun edit(draft: ResponseDraft, text: String, expected: ConnectionSnapshot) = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected); originalDraft(state, draft)
        val replacement = draft.copy(text = text, saved_at = now()); validateDraft(replacement)
        save(state.copy(drafts = state.drafts.map { if (it.id == draft.id) replacement else it }))
    }
    fun delete(draft: ResponseDraft, expected: ConnectionSnapshot) = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected); originalDraft(state, draft)
        save(state.copy(drafts = state.drafts.filterNot { it.id == draft.id }))
    }
    fun deleteIsolated(expected: ConnectionSnapshot, original: List<ResponseDraft>) = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected)
        val isolated = state.drafts.filter { it.namespace != state.connection?.namespace }
        check(isolated == original) { "隔离草稿已改变，请重新确认删除" }
        save(state.copy(drafts = state.drafts.filter { it.namespace == state.connection?.namespace }))
    }
    fun template(previous: ReplyTemplate?, title: String, text: String, expected: ConnectionSnapshot) = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected)
        check(previous == null || state.templates.singleOrNull { it.id == previous.id } == previous) { "原快捷回复已改变" }
        val value = ReplyTemplate(previous?.id ?: UUID.randomUUID().toString(), title, text)
        save(state.copy(templates = if (previous == null) state.templates + value else state.templates.map { if (it.id == previous.id) value else it }))
    }
    fun deleteTemplate(previous: ReplyTemplate, expected: ConnectionSnapshot) = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected)
        check(state.templates.singleOrNull { it.id == previous.id } == previous) { "原快捷回复已改变" }
        save(state.copy(templates = state.templates.filterNot { it.id == previous.id }))
    }
    fun prepare(draft: ResponseDraft, expected: ConnectionSnapshot): DraftConfirmation = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected); originalDraft(state, draft)
        check(state.pending == null && state.auth_intent == null && state.device?.revoked != true) { "请先对账原未决请求或身份操作，已撤销连接不能提交" }
        val event = ledger.event(draft.event_id)
        val after = storage.load(); checkConnectionSnapshot(after, expected); originalDraft(after, draft)
        draftTarget(draft, event); DraftConfirmation(draft, event)
    }
}

fun appendReplyText(existing: String, template: String): String {
    val combined = if (existing.isEmpty()) template else "$existing\n$template"
    require(boundedText(combined, 4000)) { "追加后超过4000字符，原文字未改变" }
    return combined
}
