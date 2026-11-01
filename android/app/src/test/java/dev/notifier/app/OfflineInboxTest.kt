package dev.notifier.app

import java.io.IOException
import java.nio.file.Files
import javax.crypto.KeyGenerator
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OfflineInboxTest {
    private val connection = Connection.parse("https://cache.invalid", "a".repeat(64), false)
    private val time = "2026-10-30T01:00:00Z"
    private fun event(id: String = "event_1", version: Long = 1) = Event(id, "缓存🙂", "正文\n完整保留", "source", version, 1,
        Interaction("q", 1, listOf(Action("go", "继续", "button"))), disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = time, can_respond = true)
    private class State(var value: LocalState) : StateStore { override fun load() = value; override fun save(state: LocalState) { value = state } }
    private class Disk : InboxVault {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        val file = Files.createTempFile("notifier-inbox-", ".enc").toFile().apply { deleteOnExit() }
        var reject = false
        init { save(InboxCache()) }
        override fun load() = InboxCipher.decrypt(file.readBytes(), key)
        override fun save(cache: InboxCache) { val bytes = InboxCipher.encrypt(cache, key); if (reject) throw IOException("disk full"); file.writeBytes(bytes) }
    }
    private class Fixture(val state: State, val vault: InboxVault, val handle: (String) -> String) {
        val methods = mutableListOf<String>()
        val ledger = Ledger(state, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { methods += method; check(method == "GET"); return handle(path) } })
        fun inbox(stamp: String = "2026-10-30T01:00:00Z") = OfflineInbox(ledger, vault) { stamp }
    }
    private fun fixture(disk: InboxVault = Disk(), handle: (String) -> String) = Fixture(State(LocalState(connection)), disk, handle)
    private fun page(items: List<Event>, next: String? = null) = wire.encodeToString(Page.serializer(Event.serializer()), Page(items, next))
    private fun history(items: List<History>, next: String? = null) = wire.encodeToString(Page.serializer(History.serializer()), Page(items, next))
    private fun failWith(block: () -> Unit) { try { block(); fail("failure expected") } catch (_: Exception) {} }
    @Test fun encryptedDiskReopenUnicodeNamespaceAndReadOnlyMethods() {
        val disk = Disk(); val f = fixture(disk) { page(listOf(event())) }
        val result = f.inbox().refresh()
        assertEquals(event(), f.inbox().snapshot().events["event_1"]!!.event)
        assertFalse(disk.file.readBytes().toString(Charsets.ISO_8859_1).contains("a".repeat(64)))
        assertEquals(time, result.scanned_at); assertEquals(listOf("GET"), f.methods)
        f.state.value = LocalState(connection.copy(token = "b".repeat(64)))
        assertTrue(f.inbox().snapshot().events.isEmpty()); assertNull(f.inbox().snapshot().scanned_at)
        f.state.value = LocalState(connection); assertEquals(result, f.inbox().snapshot())
    }
    @Test fun fullScanRefreshesOldPagesSameVersionReadAndNotifications() {
        var generation = 1
        val f = fixture { path ->
            val values = (1..51).map { n -> event("event_$n").let { if (generation == 2 && n == 1) it.copy(read_state = ReadState(1, false), notification_delivery = NotificationDelivery("d", 1, "platform_accepted", time)) else it } }
            if (path.endsWith("after=0")) page(values.take(50), "50") else { assertTrue(path.endsWith("after=50")); page(values.drop(50)) }
        }
        f.inbox().refresh(); generation = 2
        val second = f.inbox("2026-10-30T02:00:00Z").refresh()
        assertEquals(51, second.list_ids.size); assertFalse(second.events["event_1"]!!.event.read_state.unread)
        assertEquals(time, second.events["event_1"]!!.event.notification_delivery!!.device_received_at)
        assertEquals(1L, second.events["event_1"]!!.event.event_version); assertEquals(4, f.methods.size)
    }
    @Test fun interruptedOrDeniedSecondPageKeepsOriginalBytesAndTimeAndPending() {
        listOf(IOException(), ApiFailure(401, "UNAUTHENTICATED"), ApiFailure(403, "FORBIDDEN")).forEach { failure ->
            val disk = Disk(); var broken = false
            val f = fixture(disk) { path -> if (broken) { if (path.endsWith("after=0")) page(listOf(event("changed")), "2") else throw failure } else page(listOf(event())) }
            f.inbox().refresh(); val original = disk.file.readBytes()
            val p = Pending(connection.namespace, "original", "/v1/events/event_1/responses", "original body", true, true)
            f.state.value = f.state.value.copy(pending = p); broken = true
            failWith { f.inbox("2026-10-30T02:00:00Z").refresh() }
            assertArrayEquals(original, disk.file.readBytes()); assertEquals(p, f.state.value.pending)
        }
    }
    @Test fun repeatedOrInvalidCursorAndDuplicateIdsDoNotReplaceSnapshot() {
        listOf("0", "-1", "10000000000000000", "x", "1").forEach { cursor ->
            val disk = Disk(); val setup = fixture(disk) { page(listOf(event())) }; setup.inbox().refresh(); val original = disk.file.readBytes()
            val broken = fixture(disk) { page(listOf(event("duplicate")), cursor) }
            failWith { broken.inbox().refresh() }; assertArrayEquals(original, disk.file.readBytes())
        }
    }
    @Test fun failedSaveRetainsOriginalAndRejectsVersionRegression() {
        val disk = Disk(); val setup = fixture(disk) { page(listOf(event(version = 3))) }; setup.inbox().refresh(); val old = disk.file.readBytes()
        failWith { fixture(disk) { page(listOf(event(version = 2))) }.inbox().refresh() }; assertArrayEquals(old, disk.file.readBytes())
        disk.reject = true
        failWith { fixture(disk) { page(listOf(event(version = 4))) }.inbox().refresh() }; assertArrayEquals(old, disk.file.readBytes())
    }
    @Test fun successfulVisibilityReplacementPrunesDetailsAndOldAssociatedData() {
        var visible = true
        val f = fixture { path -> when {
            path.contains("history") -> history(listOf(History(1, "created", time, buildJsonObject { put("body", "历史🙂") })))
            path.contains("?") -> page(if (visible) listOf(event()) else emptyList())
            else -> wire.encodeToString(Event.serializer(), event())
        } }
        f.inbox().refresh(); f.inbox().refreshHistory("event_1"); visible = false
        val result = f.inbox().refresh(); assertTrue(result.events.isEmpty()); assertTrue(result.histories.isEmpty()); assertNotNull(result.scanned_at)
    }
    @Test fun detailHistoryAndReceiptSurviveDiskReopenAndKeepExactAssociation() {
        val e = event().copy(reserved_response_id = "response_1")
        val receipt = buildJsonObject { put("id", "response_1"); put("event_id", "event_1"); put("text", "完整\n🙂") }
        val h = listOf(History(1, "response_saved", time, buildJsonObject { put("text", "完整\n🙂") }))
        val f = fixture { path -> when {
            path.contains("/history") -> history(h)
            path.contains("/responses/") -> receipt.toString()
            path.contains("?") -> page(listOf(e))
            else -> wire.encodeToString(Event.serializer(), e)
        } }
        f.inbox().refresh(); f.inbox().refreshEvent(e.id); f.inbox().refreshHistory(e.id); f.inbox().refreshReceipt(e.id)
        val stored = f.inbox().snapshot(); assertEquals(h, stored.histories[e.id]!!.items); assertEquals(receipt, stored.receipts[e.id]!!.response)
        assertTrue(f.methods.all { it == "GET" })
    }
    @Test fun historyRefreshPreservesLoadedPrefixWhenLaterPageFailsOrDisappears() {
        var mode = 0
        val h = (1L..100).map { History(it, "progress", time, buildJsonObject { put("body", "历史$it") }) }
        val disk = Disk(); val f = fixture(disk) { path -> when {
            path.contains("/history") && path.endsWith("after=0") -> history(h.take(50), "50")
            path.contains("/history") -> if (mode == 1) throw IOException() else history(if (mode == 2) emptyList() else h.drop(50))
            else -> page(listOf(event()))
        } }
        f.inbox().refresh(); f.inbox().refreshHistory("event_1"); f.inbox().moreHistory("event_1")
        assertEquals(100, f.inbox().snapshot().histories["event_1"]!!.items.size)
        val original = disk.file.readBytes()
        mode = 1; failWith { f.inbox().refreshHistory("event_1") }; assertArrayEquals(original, disk.file.readBytes())
        mode = 2; failWith { f.inbox().refreshHistory("event_1") }; assertArrayEquals(original, disk.file.readBytes())
    }
    @Test fun wrongDetailOrReceiptCannotReplaceCachedFacts() {
        val disk = Disk(); val f = fixture(disk) { page(listOf(event().copy(reserved_response_id = "response_1"))) }; f.inbox().refresh(); val original = disk.file.readBytes()
        failWith { fixture(disk) { wire.encodeToString(Event.serializer(), event("other")) }.inbox().refreshEvent("event_1") }
        failWith { fixture(disk) { """{"id":"response_1","event_id":"other"}""" }.inbox().refreshReceipt("event_1") }
        assertArrayEquals(original, disk.file.readBytes())
    }
    @Test fun ciphertextTamperMissingWrongKeyUnknownFormatAndBoundsRefuse() {
        val disk = Disk(); val cache = disk.load(); val bytes = disk.file.readBytes()
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        failWith { InboxCipher.decrypt(bytes, disk.key) }
        val other = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        failWith { InboxCipher.decrypt(disk.file.readBytes(), other) }
        failWith { InboxCipher.encrypt(cache.copy(format = 2), disk.key) }
        failWith { InboxCipher.decrypt(ByteArray(MAX_CACHE_BYTES + 1), disk.key) }
        failWith { InboxCipher.encrypt(cache.copy(events = mapOf("event_1" to CachedEvent(event().copy(body = "x".repeat(MAX_CACHE_BYTES)), time))), disk.key) }
        assertEquals(cache, disk.load())
    }
    @Test fun eventAndHistoryCountLimitsBackpressureWithoutEviction() {
        val disk = Disk(); val first = fixture(disk) { page(listOf(event())) }; first.inbox().refresh(); val original = disk.file.readBytes()
        val over = fixture(disk) { path ->
            val after = path.substringAfter("after=").toInt()
            page((after + 1..after + 50).map { event("event_$it") }, (after + 50).toString())
        }
        failWith { over.inbox().refresh() }; assertArrayEquals(original, disk.file.readBytes())
        val historyCache = first.inbox().snapshot().copy(histories = mapOf("event_1" to CachedHistory((1L..1001).map { History(it, "x", time, buildJsonObject {}) }, null, time)))
        failWith { OfflineInbox.validate(historyCache) }
    }
    @Test fun connectionChangedDuringGetCannotCommitLateResults() {
        val disk = Disk(); val setup = fixture(disk) { page(listOf(event())) }; setup.inbox().refresh(); val original = disk.file.readBytes()
        lateinit var changed: Fixture
        changed = fixture(disk) { changed.state.value = LocalState(connection.copy(token = "b".repeat(64))); page(listOf(event("late"))) }
        failWith { changed.inbox().refresh() }; assertArrayEquals(original, disk.file.readBytes())
    }
    @Test fun separateOwnersSerializeWholeReadsAndCannotCommitOutOfOrder() {
        val disk = Disk()
        val entered = java.util.concurrent.CountDownLatch(1); val release = java.util.concurrent.CountDownLatch(1)
        val secondStarted = java.util.concurrent.CountDownLatch(1); val secondHttp = java.util.concurrent.CountDownLatch(1)
        val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
        val a = fixture(disk) { entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)); page(listOf(event(version = 1))) }
        val b = fixture(disk) { secondHttp.countDown(); page(listOf(event(version = 2))) }
        val first = kotlin.concurrent.thread { try { a.inbox().refresh() } catch (e: Throwable) { failure.set(e) } }
        assertTrue(entered.await(3, java.util.concurrent.TimeUnit.SECONDS))
        val second = kotlin.concurrent.thread { secondStarted.countDown(); try { b.inbox().refresh() } catch (e: Throwable) { failure.set(e) } }
        assertTrue(secondStarted.await(3, java.util.concurrent.TimeUnit.SECONDS))
        try { assertFalse(secondHttp.await(200, java.util.concurrent.TimeUnit.MILLISECONDS)) } finally { release.countDown() }
        first.join(3000); second.join(3000); assertFalse(first.isAlive); assertFalse(second.isAlive); assertNull(failure.get())
        assertEquals(2L, b.inbox().snapshot().events["event_1"]!!.event.event_version)
    }
    @Test fun mismatchedFirstHistoryPagePreservesOriginalCiphertextTimeAndPending() {
        val bad = listOf(
            History(1, "event_created", time, wire.encodeToJsonElement(Event.serializer(), event("event_B")).jsonObject),
            History(1, "source_result_reported", time, wire.encodeToJsonElement(Event.serializer(), event("event_B")).jsonObject),
            History(1, "response_saved", time, buildJsonObject { put("id", "response_B"); put("event_id", "event_B"); put("text", "wrong event") }),
            History(1, "progress", time, buildJsonObject { put("id", 1) }),
            History(1, "response_saved", time, buildJsonObject { put("id", "response_B"); put("event_id", JsonNull) })
        )
        bad.forEach { wrong ->
            val disk = Disk(); val setup = fixture(disk) { page(listOf(event())) }; setup.inbox().refresh()
            val original = disk.file.readBytes()
            val broken = fixture(disk) { history(listOf(wrong)) }
            val pending = Pending(connection.namespace, "original", "/v1/events/event_1/responses", "original body", true, true)
            broken.state.value = broken.state.value.copy(pending = pending)
            failWith { broken.inbox("2026-10-30T02:00:00Z").refreshHistory("event_1") }
            assertArrayEquals(original, disk.file.readBytes()); assertEquals(pending, broken.state.value.pending)
        }
    }
    @Test fun wrongLaterHistoryCannotAppendOrReplacePreviouslyLoadedPrefix() {
        val disk = Disk(); var phase = 0
        val prefix = (1L..50).map { History(it, if (it == 1L) "event_created" else "progress", time, wire.encodeToJsonElement(Event.serializer(), event()).jsonObject) }
        val wrong = History(51, "progress", time, wire.encodeToJsonElement(Event.serializer(), event("event_B")).jsonObject)
        val f = fixture(disk) { path -> when {
            !path.contains("history") -> page(listOf(event()))
            phase == 0 || path.endsWith("after=0") -> history(prefix, "50")
            else -> history(listOf(wrong))
        } }
        f.inbox().refresh(); f.inbox().refreshHistory("event_1"); val original = disk.file.readBytes(); phase = 1
        failWith { f.inbox().moreHistory("event_1") }; assertArrayEquals(original, disk.file.readBytes())
        // Enough prior prefix to force the second page during a refresh, too.
        val existing = f.inbox().snapshot(); val expanded = existing.copy(histories = mapOf("event_1" to CachedHistory(prefix + History(51, "user_disposition", time, buildJsonObject { put("disposition", "paused") }), null, time)))
        disk.save(expanded); val expandedBytes = disk.file.readBytes()
        failWith { f.inbox().refreshHistory("event_1") }; assertArrayEquals(expandedBytes, disk.file.readBytes())
    }
    @Test fun legacyCiphertextWithCrossEventHistoryRefusesWithoutAutoReset() {
        val disk = Disk(); val f = fixture(disk) { page(listOf(event())) }; f.inbox().refresh()
        val wrong = History(1, "progress", time, wire.encodeToJsonElement(Event.serializer(), event("event_B")).jsonObject)
        val invalid = f.inbox().snapshot().copy(histories = mapOf("event_1" to CachedHistory(listOf(wrong), null, time)))
        // Construct an old-format authenticated file, bypassing only the new writer validation in this test.
        val cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding").apply { init(javax.crypto.Cipher.ENCRYPT_MODE, disk.key) }
        val bytes = cipher.iv + cipher.doFinal(wire.encodeToString(InboxCache.serializer(), invalid).toByteArray(Charsets.UTF_8))
        disk.file.writeBytes(bytes)
        failWith { f.inbox().snapshot() }; assertArrayEquals(bytes, disk.file.readBytes())
        failWith { f.inbox().refresh() }; assertArrayEquals(bytes, disk.file.readBytes())
    }
    @Test fun matchingSnapshotResponseIdsAndUnscopedHistoryRemainCompatible() {
        val kinds = listOf("event_created", "progress", "source_result_reported")
        val h = kinds.mapIndexed { n, kind -> History(n + 1L, kind, time, wire.encodeToJsonElement(Event.serializer(), event()).jsonObject) } + listOf(
            History(4, "response_saved", time, buildJsonObject { put("id", "response_A_not_event_id"); put("event_id", "event_1"); put("text", "exact🙂") }),
            History(5, "user_disposition", time, buildJsonObject { put("disposition", "paused"); put("actor_id", "fixture_user") }),
            History(6, "command_claimed", time, buildJsonObject { put("command_id", "original_command"); put("response_id", "response_A_not_event_id") })
        )
        val f = fixture { path -> if (path.contains("history")) history(h) else page(listOf(event())) }
        f.inbox().refresh(); f.inbox().refreshHistory("event_1")
        assertEquals(h, f.inbox().snapshot().histories["event_1"]!!.items); assertTrue(f.methods.all { it == "GET" })
    }
    @Test fun localFiltersAreIndependentAndDoNotWriteOrAuthorize() {
        val a = event(); val b = event("b").copy(source_id = "other", read_state = ReadState(1, false), can_respond = false)
        assertEquals(listOf(a), filterInbox(listOf(a, b), null, true, false))
        assertEquals(listOf(b), filterInbox(listOf(a, b), "other", false, false))
        assertTrue(filterInbox(listOf(a, b), "other", false, true).isEmpty())
    }
}
