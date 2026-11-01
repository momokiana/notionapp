package dev.notifier.app

import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

const val MAX_CACHE_BYTES = 32 * 1024 * 1024
const val MAX_CACHED_EVENTS = 1000
const val MAX_CACHED_HISTORY = 1000
@Serializable data class CachedEvent(val event: Event, val observed_at: String)
@Serializable data class CachedHistory(val items: List<History>, val next_after: String?, val observed_at: String)
@Serializable data class CachedReceipt(val response: JsonObject, val observed_at: String)
@Serializable data class InboxCache(
    val format: Int = 1, val namespace: String = "", val list_ids: List<String> = emptyList(),
    val scanned_at: String? = null, val events: Map<String, CachedEvent> = emptyMap(),
    val histories: Map<String, CachedHistory> = emptyMap(), val receipts: Map<String, CachedReceipt> = emptyMap()
)
interface InboxVault { fun load(): InboxCache; fun save(cache: InboxCache) }
class InboxCacheReadFailure(cause: Exception) : IllegalStateException("离线内容缓存不可读，可能损坏、超限或密钥不可用。原文件已保留，连接和未决提交未重置。", cause)

/** Cache is a read model, never an authority or an outbound write queue. */
class OfflineInbox(private val ledger: Ledger, private val vault: InboxVault, private val now: () -> String = { Instant.now().toString() }) {
    // Only this owner writes content. Push workers intentionally do not share this cache.
    private val lock get() = cacheMonitor
    private fun namespace() = ledger.state().connection?.namespace ?: error("请先设置连接")
    fun snapshot(): InboxCache = synchronized(lock) { val ns = namespace(); load(ns) }
    private fun load(ns: String): InboxCache {
        val cache = vault.load(); validate(cache)
        return if (cache.namespace == ns) cache else InboxCache(namespace = ns)
    }
    fun reset() = synchronized(lock) { vault.save(InboxCache(namespace = ledger.state().connection?.namespace ?: "")) }
    private fun save(ns: String, cache: InboxCache): InboxCache {
        check(namespace() == ns) { "连接已改变，未应用迟到同步" }
        validate(cache)
        check(wire.encodeToString(InboxCache.serializer(), cache).toByteArray(Charsets.UTF_8).size <= MAX_CACHE_BYTES - 28) { "本机内容缓存已满，原缓存保留；未完成同步" }
        vault.save(cache); return cache
    }
    fun refresh(): InboxCache = synchronized(lock) {
        val ns = namespace(); val old = load(ns)
        val found = linkedMapOf<String, CachedEvent>(); var cursor: String? = null; var size = 0
        do {
            val page = ledger.events(cursor)
            check(page.items.size <= 50) { "事件分页超限" }
            val stamp = now()
            page.items.forEach { event ->
                check(event.id !in found) { "事件分页重复，未完成同步" }
                check(found.size < MAX_CACHED_EVENTS) { "事件超过1000条缓存上限，原缓存保留" }
                check(event.event_version >= (old.events[event.id]?.event?.event_version ?: 0)) { "服务事件版本倒退，原缓存保留" }
                size += wire.encodeToString(Event.serializer(), event).toByteArray(Charsets.UTF_8).size
                check(size <= MAX_CACHE_BYTES - 28) { "本机内容缓存容量不足，原缓存保留" }
                found[event.id] = CachedEvent(event, stamp)
            }
            cursor = nextCursor(cursor, page.next_after, page.items.isEmpty())
        } while (cursor != null)
        save(ns, old.copy(list_ids = found.keys.toList(), scanned_at = now(), events = found,
            histories = old.histories.filterKeys { it in found },
            receipts = old.receipts.filter { (id, r) -> found[id]?.event?.reserved_response_id == r.response["id"]?.jsonPrimitive?.content }))
    }
    fun refreshEvent(id: String): CachedEvent = synchronized(lock) {
        val ns = namespace(); val old = load(ns); val event = ledger.event(id)
        check(event.id == id && event.event_version >= (old.events[id]?.event?.event_version ?: 0)) { "详情关联不匹配或版本倒退" }
        check(id in old.events || old.events.size < MAX_CACHED_EVENTS) { "本机事件缓存已满" }
        val value = CachedEvent(event, now())
        val receipts = old.receipts.filter { (key, r) -> key != id || event.reserved_response_id == r.response["id"]?.jsonPrimitive?.content }
        save(ns, old.copy(events = old.events + (id to value), receipts = receipts)); value
    }
    /** Re-read at least the previously loaded prefix before atomically replacing it. */
    fun refreshHistory(id: String): CachedHistory = synchronized(lock) {
        val ns = namespace(); val old = load(ns); check(id in old.events)
        val count = maxOf(50, old.histories[id]?.items?.size ?: 0)
        val items = mutableListOf<History>(); var cursor: String? = null; var size = 0
        do {
            val page = ledger.history(id, cursor)
            check(page.items.size <= 50)
            validateHistory(id, items.lastOrNull()?.seq ?: 0, page.items)
            items += page.items; check(items.size <= MAX_CACHED_HISTORY) { "历史超过1000条缓存上限" }
            size += wire.encodeToString(Page.serializer(History.serializer()), page).toByteArray(Charsets.UTF_8).size
            check(size <= MAX_CACHE_BYTES - 28) { "历史缓存容量不足，原缓存保留" }
            cursor = historyCursor(cursor, page)
        } while (cursor != null && items.size < count)
        check(items.take(old.histories[id]?.items?.size ?: 0) == (old.histories[id]?.items ?: emptyList<History>())) { "历史缺失或改变，原已加载历史保留" }
        val cached = CachedHistory(items, cursor, now())
        save(ns, old.copy(histories = old.histories + (id to cached))); cached
    }
    fun moreHistory(id: String): CachedHistory = synchronized(lock) {
        val ns = namespace(); val old = load(ns); val prior = old.histories[id] ?: error("请先刷新历史")
        val cursor = prior.next_after ?: return@synchronized prior
        val page = ledger.history(id, cursor); check(page.items.size <= 50)
        validateHistory(id, prior.items.lastOrNull()?.seq ?: 0, page.items)
        val combined = prior.items + page.items; check(combined.size <= MAX_CACHED_HISTORY) { "历史超过1000条缓存上限，原历史保留" }
        // Prior prefix keeps its earlier observation time; this timestamp never claims that prefix was refreshed.
        val result = CachedHistory(combined, historyCursor(cursor, page), prior.observed_at)
        save(ns, old.copy(histories = old.histories + (id to result))); result
    }
    fun refreshReceipt(id: String): CachedReceipt? = synchronized(lock) {
        val ns = namespace(); val old = load(ns); val event = old.events[id]?.event ?: error("请先刷新详情")
        val responseId = event.reserved_response_id ?: return@synchronized null
        val response = ledger.response(responseId)
        check(response["id"]?.jsonPrimitive?.content == responseId && response["event_id"]?.jsonPrimitive?.content == id) { "回应回执关联不匹配，原缓存保留" }
        val result = CachedReceipt(response, now()); save(ns, old.copy(receipts = old.receipts + (id to result))); result
    }
    companion object {
        // A cancelled ViewModel may still have blocking IO in flight while a new owner starts.
        // Serialize complete cache transactions across ALL owners, not just one Composable/model.
        private val cacheMonitor = Any()
        private val idPattern = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
        private fun nextCursor(previous: String?, next: String?, empty: Boolean): String? {
            if (next == null) return null
            check(!empty && next.matches(Regex("[0-9]{1,16}")) && next.toLong() > (previous?.toLong() ?: 0)) { "分页游标未前进，原缓存保留" }
            return next
        }
        private fun historyCursor(previous: String?, page: Page<History>): String? {
            val next = nextCursor(previous, page.next_after, page.items.isEmpty())
            check(next == null || next.toLong() == page.items.last().seq) { "历史游标关联不匹配" }
            return next
        }
        private fun validateHistory(eventId: String, after: Long, items: List<History>) {
            var seq = after
            items.forEach { history ->
                check(history.seq > seq) { "历史分页乱序或重复" }; seq = history.seq
                fun binding(field: String) {
                    if (field !in history.data) return
                    val value = history.data[field] as? JsonPrimitive
                    check(value?.isString == true && value.content == eventId) { "历史事件关联不匹配，原缓存保留" }
                }
                // Snapshot id is an EVENT id; response_saved.id is instead a RESPONSE id.
                // Other actual kinds (e.g. user_disposition) have no embedded event id.
                if (history.kind in setOf("event_created", "progress", "source_result_reported")) binding("id")
                binding("event_id")
            }
        }
        fun validate(cache: InboxCache) {
            check(cache.format == 1 && (cache.namespace.isEmpty() || cache.namespace.matches(Regex("[a-f0-9]{64}")))) { "内容缓存格式不支持" }
            check(cache.events.size <= MAX_CACHED_EVENTS && cache.list_ids.size <= MAX_CACHED_EVENTS && cache.list_ids.distinct().size == cache.list_ids.size)
            check(cache.list_ids.all { it in cache.events })
            cache.scanned_at?.let { Instant.parse(it) }
            cache.events.forEach { (id, value) -> check(id.matches(idPattern) && value.event.id == id && value.event.event_version > 0); Instant.parse(value.observed_at) }
            cache.histories.forEach { (id, history) ->
                check(id in cache.events && history.items.size <= MAX_CACHED_HISTORY); validateHistory(id, 0, history.items); Instant.parse(history.observed_at)
                history.next_after?.let { check(it.matches(Regex("[0-9]{1,16}")) && it.toLong() == history.items.lastOrNull()?.seq) }
            }
            cache.receipts.forEach { (id, r) ->
                check(id in cache.events && r.response["event_id"]?.jsonPrimitive?.content == id && r.response["id"]?.jsonPrimitive?.content == cache.events[id]?.event?.reserved_response_id)
                Instant.parse(r.observed_at)
            }
        }
    }
}

fun filterInbox(events: List<Event>, source: String?, unread: Boolean, actionable: Boolean): List<Event> = events.filter {
    (source == null || it.source_id == source) && (!unread || it.read_state.unread) && (!actionable || it.can_respond)
}
