package dev.notifier.app

import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

const val MAX_CACHE_BYTES = 32 * 1024 * 1024
const val MAX_WINDOW_EVENTS = 1000
const val MAX_CACHED_EVENTS = 1001
const val MAX_CACHED_HISTORY = 1000
const val MAX_WINDOW_ANCHORS = 64
@Serializable data class CachedEvent(val event: Event, val observed_at: String)
@Serializable data class CachedHistory(
    val items: List<History>, val next_after: String?, val observed_at: String,
    val from_after: String = "0", val previous_ranges: List<String> = emptyList()
)
@Serializable data class CachedReceipt(val response: JsonObject, val observed_at: String)
@Serializable data class InboxCache(
    val format: Int = 1, val namespace: String = "", val list_ids: List<String> = emptyList(),
    val scanned_at: String? = null, val events: Map<String, CachedEvent> = emptyMap(),
    val histories: Map<String, CachedHistory> = emptyMap(), val receipts: Map<String, CachedReceipt> = emptyMap(),
    val range_after: String = "0", val range_next: String? = null, val previous_ranges: List<String> = emptyList()
)
interface InboxVault { fun load(): InboxCache; fun save(cache: InboxCache) }
class InboxCacheReadFailure(cause: Exception) : IllegalStateException("离线内容缓存不可读，可能损坏、超限或密钥不可用。原文件已保留，连接和未决提交未重置。", cause)
data class InboxView(val cache: InboxCache, val bytes: Int, val token: String)
enum class CacheChange { NEXT, PREVIOUS, FIRST, CLEAR_HISTORY, CLEAR_EXTERNAL, CLEAR_ALL }
enum class HistoryWindow { NEXT, PREVIOUS, FIRST }

/** Read model only. Every cache transaction uses cacheMonitor -> ConnectionGate, never the reverse. */
class OfflineInbox(private val ledger: Ledger, private val vault: InboxVault, private val now: () -> String = { Instant.now().toString() }) {
    private val lock get() = cacheMonitor
    private fun currentNamespace() = ledger.state().connection?.namespace ?: ""
    private fun namespace() = currentNamespace().also { check(it.isNotEmpty()) { "请先设置连接" } }
    fun snapshot(): InboxCache = synchronized(lock) { load(namespace()) }
    private fun read(): InboxCache = try { vault.load().also { validate(it) } } catch (e: InboxCacheReadFailure) { throw e } catch (e: Exception) { throw InboxCacheReadFailure(e) }
    private fun load(ns: String): InboxCache = read().let { if (it.namespace == ns) it else InboxCache(namespace = ns) }
    // Also used by connect/disconnect/pair. Even those paths must not overwrite an unreadable old file.
    fun reset() = synchronized(lock) {
        val ns = currentNamespace(); read()
        synchronized(ConnectionGate.monitor) {
            check(currentNamespace() == ns) { "连接已改变，未应用迟到清理" }
            vault.save(InboxCache(namespace = ns))
        }
    }
    private fun save(ns: String, cache: InboxCache): InboxCache = synchronized(ConnectionGate.monitor) {
        check(namespace() == ns && cache.namespace == ns) { "连接已改变，未应用迟到同步" }
        validate(cache)
        check(fits(cache)) { "本机内容缓存已满，原内容保留；请明确清理历史或更换缓存区间" }
        vault.save(cache); cache
    }
    fun refresh(): InboxCache = synchronized(lock) { val old = load(namespace()); scan(old, old, automatic = true) }
    private fun <T> readBound(ns: String, action: () -> T): T = synchronized(ConnectionGate.monitor) {
        check(namespace() == ns) { "连接已改变，未请求另一个身份的缓存页" }
        val result = action()
        check(namespace() == ns) { "连接已改变，未采用迟到缓存页" }
        result
    }

    private fun scan(old: InboxCache, base: InboxCache, automatic: Boolean): InboxCache {
        val ns = base.namespace
        val oldList = old.list_ids.toSet()
        // Legacy format1 permits MANY external details. Keep all of them readable; do not impose a new decrypt-time single-slot rule.
        val outside = if (automatic) old.events.filterKeys { it !in oldList } else emptyMap()
        var found: Map<String, CachedEvent> = linkedMapOf()
        var cursor = base.range_after
        var accepted: InboxCache? = null
        while (true) {
            val page = readBound(ns) { ledger.events(cursor) }
            check(page.items.size <= 50) { "事件分页超限" }
            val next = nextCursor(cursor, page.next_after, page.items.isEmpty())
            val stamp = now()
            val candidateEvents = LinkedHashMap(found)
            page.items.forEach { event ->
                check(event.id !in candidateEvents) { "事件分页重复，未完成同步" }
                check(event.event_version >= (old.events[event.id]?.event?.event_version ?: 0)) { "服务事件版本倒退，原缓存保留" }
                candidateEvents[event.id] = CachedEvent(event, stamp)
            }
            val all = outside + candidateEvents
            val candidate = base.copy(list_ids = candidateEvents.keys.toList(), scanned_at = stamp, events = all,
                histories = base.histories.filterKeys { it in all },
                receipts = base.receipts.filter { (id, r) -> all[id]?.event?.reserved_response_id == r.response["id"]?.jsonPrimitive?.content }, range_next = next)
            if (candidate.list_ids.size > MAX_WINDOW_EVENTS || candidate.events.size > MAX_CACHED_EVENTS || !fits(candidate)) {
                check(accepted != null && found.isNotEmpty()) { "第一页与已有资料超过缓存容量，原内容保留；请先明确清理" }
                // The rejected page is NOT consumed: accepted.range_next is exactly its input cursor.
                break
            }
            validate(candidate)
            found = candidateEvents; accepted = candidate
            if (next == null || found.size == MAX_WINDOW_EVENTS) break
            cursor = next
        }
        val result = accepted ?: error("未完成缓存区间扫描")
        check(!automatic || result.range_next == null || old.list_ids.all { it in found }) { "容量边界不能缩短原已缓存列表，原内容保留；请明确换区间或清理后重试" }
        return save(ns, result)
    }
    fun change(change: CacheChange, expectedToken: String): InboxCache = synchronized(lock) {
        val ns = namespace(); val old = confirmed(ns, expectedToken)
        when (change) {
            CacheChange.NEXT, CacheChange.PREVIOUS, CacheChange.FIRST -> {
                val (after, previous) = when (change) {
                    CacheChange.NEXT -> (old.range_next ?: error("当前没有已知后续区间")) to (old.previous_ranges + old.range_after).takeLast(MAX_WINDOW_ANCHORS)
                    CacheChange.PREVIOUS -> (old.previous_ranges.lastOrNull() ?: error("没有保留的上一缓存区间，可回到最早")) to old.previous_ranges.dropLast(1)
                    else -> "0" to emptyList()
                }
                scan(old, InboxCache(namespace = ns, range_after = after, previous_ranges = previous), automatic = false)
            }
            CacheChange.CLEAR_HISTORY -> save(ns, old.copy(histories = emptyMap(), receipts = emptyMap()))
            CacheChange.CLEAR_EXTERNAL -> {
                val kept = old.list_ids.toSet()
                save(ns, old.copy(events = old.events.filterKeys { it in kept }, histories = old.histories.filterKeys { it in kept }, receipts = old.receipts.filterKeys { it in kept }))
            }
            CacheChange.CLEAR_ALL -> save(ns, InboxCache(namespace = ns))
        }
    }
    private fun confirmed(ns: String, token: String): InboxCache {
        val old = load(ns)
        check(old.namespace == ns && inspect(old).token == token) { "缓存或连接已改变，请重新确认；没有清理新内容" }
        return old
    }
    fun refreshEvent(id: String): CachedEvent = synchronized(lock) {
        val ns = namespace(); val old = load(ns)
        check(id in old.events || old.events.keys.count { it !in old.list_ids } < 1) { "列表外详情槽已占用（含旧版保留资料），请在容量设置明确清理后再打开另一事件" }
        check(id in old.events || old.events.size < MAX_CACHED_EVENTS) { "本机事件缓存已满" }
        val event = readBound(ns) { ledger.event(id) }
        check(event.id == id && event.event_version >= (old.events[id]?.event?.event_version ?: 0)) { "详情关联不匹配或版本倒退" }
        val value = CachedEvent(event, now())
        val receipts = old.receipts.filter { (key, r) -> key != id || event.reserved_response_id == r.response["id"]?.jsonPrimitive?.content }
        save(ns, old.copy(events = old.events + (id to value), receipts = receipts)); value
    }
    /** Re-read the current history range, at least its previously loaded immutable prefix. */
    fun refreshHistory(id: String): CachedHistory = synchronized(lock) {
        val ns = namespace(); val old = load(ns); check(id in old.events)
        val prior = old.histories[id]
        val count = maxOf(50, prior?.items?.size ?: 0)
        val after = prior?.from_after ?: "0"
        val items = mutableListOf<History>(); var cursor = after
        var next: String?
        do {
            val page = readBound(ns) { ledger.history(id, cursor) }; check(page.items.size <= 50)
            validateHistory(id, items.lastOrNull()?.seq ?: number(after), page.items)
            items += page.items; check(items.size <= MAX_CACHED_HISTORY) { "历史区间超过1000条，请明确查看后续历史区间" }
            next = historyCursor(cursor, page)
            val candidate = CachedHistory(items.toList(), next, now(), after, prior?.previous_ranges ?: emptyList())
            check(fits(old.copy(histories = old.histories + (id to candidate)))) { "历史缓存容量不足，原区间保留；可明确清理或更换区间" }
            if (next == null) break
            cursor = next
        } while (items.size < count)
        check(items.take(prior?.items?.size ?: 0) == (prior?.items ?: emptyList<History>())) { "历史缺失或改变，原已加载历史保留" }
        val cached = CachedHistory(items.toList(), next, now(), after, prior?.previous_ranges ?: emptyList())
        save(ns, old.copy(histories = old.histories + (id to cached))); cached
    }
    fun moreHistory(id: String): CachedHistory = synchronized(lock) {
        val ns = namespace(); val old = load(ns); val prior = old.histories[id] ?: error("请先刷新历史")
        val cursor = prior.next_after ?: return@synchronized prior
        val page = readBound(ns) { ledger.history(id, cursor) }; check(page.items.size <= 50)
        validateHistory(id, prior.items.lastOrNull()?.seq ?: number(prior.from_after), page.items)
        val combined = prior.items + page.items; check(combined.size <= MAX_CACHED_HISTORY) { "本历史区间已满，原前缀保留；请明确查看后续历史区间" }
        // An append does not claim the retained prefix was freshly observed.
        val result = prior.copy(items = combined, next_after = historyCursor(cursor, page))
        save(ns, old.copy(histories = old.histories + (id to result))); result
    }
    fun historyWindow(id: String, change: HistoryWindow, expectedToken: String): CachedHistory = synchronized(lock) {
        val ns = namespace(); val old = confirmed(ns, expectedToken); check(id in old.events)
        val prior = old.histories[id] ?: error("请先刷新历史")
        val (after, previous) = when (change) {
            HistoryWindow.NEXT -> (prior.next_after ?: error("没有已知后续历史")) to (prior.previous_ranges + prior.from_after).takeLast(MAX_WINDOW_ANCHORS)
            HistoryWindow.PREVIOUS -> (prior.previous_ranges.lastOrNull() ?: error("没有保留的上一历史区间，可回到最早")) to prior.previous_ranges.dropLast(1)
            HistoryWindow.FIRST -> "0" to emptyList()
        }
        val page = readBound(ns) { ledger.history(id, after) }; check(page.items.size <= 50)
        validateHistory(id, number(after), page.items)
        val result = CachedHistory(page.items, historyCursor(after, page), now(), after, previous)
        save(ns, old.copy(histories = old.histories + (id to result))); result
    }
    fun refreshReceipt(id: String): CachedReceipt? = synchronized(lock) {
        val ns = namespace(); val old = load(ns); val event = old.events[id]?.event ?: error("请先刷新详情")
        val responseId = event.reserved_response_id ?: return@synchronized null
        val response = readBound(ns) { ledger.response(responseId) }
        check(response["id"]?.jsonPrimitive?.content == responseId && response["event_id"]?.jsonPrimitive?.content == id) { "回应回执关联不匹配，原缓存保留" }
        val result = CachedReceipt(response, now()); save(ns, old.copy(receipts = old.receipts + (id to result))); result
    }
    companion object {
        private val cacheMonitor = Any()
        private val idPattern = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
        private fun encoded(cache: InboxCache) = wire.encodeToString(InboxCache.serializer(), cache).toByteArray(Charsets.UTF_8)
        private fun fits(cache: InboxCache) = encoded(cache).size <= MAX_CACHE_BYTES - 28
        fun inspect(cache: InboxCache): InboxView {
            validate(cache)
            val bytes = encoded(cache)
            return InboxView(cache, bytes.size + 28, java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        }
        private fun number(value: String): Long {
            check(value.matches(Regex("[0-9]{1,16}"))) { "缓存区间游标格式不合法" }
            return value.toLong().also { check(it <= 9007199254740991L) { "缓存区间游标超限" } }
        }
        private fun anchors(after: String, previous: List<String>) {
            val start = number(after)
            check(previous.size <= MAX_WINDOW_ANCHORS) { "缓存导航锚点超限" }
            var last = -1L
            previous.forEach { check(number(it) > last && number(it) < start) { "缓存导航锚点未前进" }; last = number(it) }
        }
        private fun nextCursor(previous: String, next: String?, empty: Boolean): String? {
            if (next == null) return null
            check(!empty && number(next) > number(previous)) { "分页游标未前进，原缓存保留" }
            return next
        }
        private fun historyCursor(previous: String, page: Page<History>): String? {
            val next = nextCursor(previous, page.next_after, page.items.isEmpty())
            check(next == null || number(next) == page.items.last().seq) { "历史游标关联不匹配" }
            return next
        }
        private fun validateHistory(eventId: String, after: Long, items: List<History>) {
            var seq = after
            items.forEach { history ->
                check(history.seq > seq && history.seq <= 9007199254740991L) { "历史分页乱序或重复" }; seq = history.seq
                fun binding(field: String) {
                    if (field !in history.data) return
                    val value = history.data[field] as? JsonPrimitive
                    check(value?.isString == true && value.content == eventId) { "历史事件关联不匹配，原缓存保留" }
                }
                if (history.kind in setOf("event_created", "progress", "source_result_reported")) binding("id")
                binding("event_id")
            }
        }
        fun validate(cache: InboxCache) {
            check(cache.format == 1 && (cache.namespace.isEmpty() || cache.namespace.matches(Regex("[a-f0-9]{64}")))) { "内容缓存格式不支持" }
            check(cache.events.size <= MAX_CACHED_EVENTS && cache.list_ids.size <= MAX_WINDOW_EVENTS && cache.list_ids.distinct().size == cache.list_ids.size)
            check(cache.list_ids.all { it in cache.events })
            anchors(cache.range_after, cache.previous_ranges)
            cache.range_next?.let { check(cache.scanned_at != null && cache.list_ids.isNotEmpty() && number(it) > number(cache.range_after)) { "缓存后续区间不合法" } }
            cache.scanned_at?.let { Instant.parse(it) }
            cache.events.forEach { (id, value) -> check(id.matches(idPattern) && value.event.id == id && value.event.event_version > 0); Instant.parse(value.observed_at) }
            cache.histories.forEach { (id, history) ->
                anchors(history.from_after, history.previous_ranges)
                check(id in cache.events && history.items.size <= MAX_CACHED_HISTORY); validateHistory(id, number(history.from_after), history.items); Instant.parse(history.observed_at)
                history.next_after?.let { check(number(it) == history.items.lastOrNull()?.seq) { "历史区间游标关联不匹配" } }
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
