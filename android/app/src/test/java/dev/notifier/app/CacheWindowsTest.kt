package dev.notifier.app

import java.io.IOException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CacheWindowsTest {
    private val c = Connection.parse("https://windows.example.test", "a".repeat(64), false)
    private val time = "2026-11-01T00:00:00Z"
    private fun event(n: Int, body: String = "内容🙂") = Event("e_$n", "Event $n", body, "source", 1, 1,
        Interaction("q", 1, listOf(Action("reply", "Reply", "text"))), disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = time, can_respond = true)
    private fun history(n: Long, id: String = "e_1", body: String = "history") = History(n, "progress", time, buildJsonObject { put("id", id); put("body", body) })
    private class State(var value: LocalState) : StateStore { override fun load() = value; override fun save(state: LocalState) { value = state } }
    private class Vault(initial: InboxCache = InboxCache()) : InboxVault {
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        var bytes = InboxCipher.encrypt(initial, key); var reject = false; var saves = 0
        override fun load() = InboxCipher.decrypt(bytes, key)
        override fun save(cache: InboxCache) { val next = InboxCipher.encrypt(cache, key); if (reject) throw IOException("synthetic disk full"); bytes = next; saves++ }
    }
    private inner class Fixture(initial: InboxCache = InboxCache(), val handle: (String) -> String) {
        val state = State(LocalState(c)); val vault = Vault(initial); val paths = mutableListOf<String>()
        val ledger = Ledger(state, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { assertEquals("GET", method); paths += path; return handle(path) } })
        val inbox = OfflineInbox(ledger, vault) { time }
        fun token() = OfflineInbox.inspect(inbox.snapshot()).token
    }
    private fun events(total: Int, path: String, body: String = "内容🙂"): String {
        val after = path.substringAfter("after=").toInt(); val end = minOf(after + 50, total)
        val values = if (after >= total) emptyList() else (after + 1..end).map { event(it, body) }
        return wire.encodeToString(Page.serializer(Event.serializer()), Page(values, if (end < total) end.toString() else null))
    }
    private fun histories(total: Long, path: String): String {
        val after = path.substringAfter("after=").toLong(); val end = minOf(after + 50, total)
        val values = if (after >= total) emptyList() else (after + 1..end).map { history(it) }
        return wire.encodeToString(Page.serializer(History.serializer()), Page(values, if (end < total) end.toString() else null))
    }
    private fun failWith(block: () -> Unit): Exception { try { block(); fail("expected refusal") } catch (e: AssertionError) { throw e } catch (e: Exception) { return e }; error("unreachable") }
    private fun oneCache() = InboxCache(namespace = c.namespace, list_ids = listOf("e_1"), scanned_at = time, events = mapOf("e_1" to CachedEvent(event(1), time)))

    @Test fun exact1001And1051BoundariesPersistNextAndTraverseWithoutSkipping() {
        for (total in listOf(1000, 1001, 1051)) {
            val f = Fixture { events(total, it) }; val first = f.inbox.refresh()
            assertEquals(1000, first.list_ids.size); assertEquals(if (total == 1000) null else "1000", first.range_next)
            assertEquals(20, f.paths.size)
            if (total > 1000) {
                val next = f.inbox.change(CacheChange.NEXT, f.token()); assertEquals("1000", next.range_after); assertEquals(total - 1000, next.list_ids.size); assertNull(next.range_next)
                assertEquals((1001..total).map { "e_$it" }, next.list_ids); assertEquals(listOf("0"), next.previous_ranges)
                val reopened = OfflineInbox(f.ledger, f.vault) { time }.refresh(); assertEquals(next, reopened)
                val prior = f.inbox.change(CacheChange.PREVIOUS, f.token()); assertEquals(first, prior)
            }
        }
    }
    @Test fun currentWindowRefreshReadsItsStartAndUpdatesSameVersionFacts() {
        var changed = false
        val f = Fixture { path ->
            val page = wire.decodeFromString<Page<Event>>(events(1051, path))
            wire.encodeToString(Page.serializer(Event.serializer()), page.copy(items = page.items.map { if (changed && it.id == "e_1001") it.copy(read_state = ReadState(1, false)) else it }))
        }
        f.inbox.refresh(); f.inbox.change(CacheChange.NEXT, f.token()); changed = true; f.paths.clear()
        val refreshed = f.inbox.refresh(); assertTrue(f.paths.first().endsWith("after=1000")); assertFalse(refreshed.events["e_1001"]!!.event.read_state.unread)
        assertEquals(1L, refreshed.events["e_1001"]!!.event.event_version); assertEquals("1000", refreshed.range_after)
    }
    @Test fun legacyMultipleOutsideDetailsDecryptRemainReadableAndAreNeverSilentlyPruned() {
        val old = oneCache().copy(events = (1..3).associate { "e_$it" to CachedEvent(event(it), time) }, histories = mapOf("e_2" to CachedHistory(listOf(history(7, "e_2")), null, time)))
        val f = Fixture(old) { path -> if (path.contains("?")) events(1, path) else wire.encodeToString(Event.serializer(), event(2)) }
        // Produce an actual old-format ciphertext without any new window fields.
        val json = wire.encodeToJsonElement(InboxCache.serializer(), old).jsonObject.toMutableMap().apply { remove("range_after"); remove("range_next"); remove("previous_ranges") }
        json["histories"] = buildJsonObject { put("e_2", JsonObject(wire.encodeToJsonElement(CachedHistory.serializer(), old.histories["e_2"]!!).jsonObject.filterKeys { it !in setOf("from_after", "previous_ranges") })) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, f.vault.key) }
        f.vault.bytes = cipher.iv + cipher.doFinal(JsonObject(json).toString().toByteArray())
        val before = f.vault.bytes.clone(); assertEquals(old, f.inbox.snapshot()); assertArrayEquals(before, f.vault.bytes)
        val refreshed = f.inbox.refresh(); assertEquals(setOf("e_1", "e_2", "e_3"), refreshed.events.keys); assertEquals(time, refreshed.events["e_3"]!!.observed_at); assertEquals(old.histories, refreshed.histories)
        f.inbox.refreshEvent("e_2"); failWith { f.inbox.refreshEvent("e_4") }
        val cleared = f.inbox.change(CacheChange.CLEAR_EXTERNAL, f.token()); assertEquals(setOf("e_1"), cleared.events.keys); assertTrue(cleared.histories.isEmpty())
    }
    @Test fun fullListHasOneNewExternalSlotAndAnotherCannotOverwriteIt() {
        val f = Fixture { if (it.contains("?")) events(1051, it) else wire.encodeToString(Event.serializer(), event(it.substringAfterLast('/').removePrefix("e_").toInt())) }
        f.inbox.refresh(); f.inbox.refreshEvent("e_1001"); assertEquals(1001, f.inbox.snapshot().events.size)
        val before = f.vault.bytes.clone(); failWith { f.inbox.refreshEvent("e_1002") }; assertArrayEquals(before, f.vault.bytes)
        f.inbox.refresh(); assertTrue("e_1001" in f.inbox.snapshot().events)
        val next = f.inbox.change(CacheChange.NEXT, f.token()); assertEquals(51, next.events.size); assertEquals(51, next.list_ids.size)
        f.inbox.change(CacheChange.CLEAR_EXTERNAL, f.token()); f.inbox.refreshEvent("e_1"); assertTrue("e_1" in f.inbox.snapshot().events)
    }
    @Test fun realByteBudgetIncludesHistoryAndStopsOnlyOnAWholePageWithoutShrinkingAutomaticPrefix() {
        val oldEvents = (1..1000).associate { "e_$it" to CachedEvent(event(it, "汉".repeat(3000)), time) }
        val bigHistory = CachedHistory((1L..1000).map { history(it, body = "汉".repeat(5000)) }, null, time)
        val old = InboxCache(namespace = c.namespace, list_ids = oldEvents.keys.toList(), scanned_at = time, events = oldEvents, histories = mapOf("e_1" to bigHistory))
        val f = Fixture(old) { events(1051, it, "汉".repeat(16000)) }; val before = f.vault.bytes.clone()
        assertTrue(OfflineInbox.inspect(old).bytes < MAX_CACHE_BYTES)
        val refusal = failWith { f.inbox.refresh() }; assertTrue(refusal.message.orEmpty().contains("缩短")); assertArrayEquals(before, f.vault.bytes)
        // An explicit replacement may drop the old offline material; no automatic eviction occurred above.
        val chosen = f.inbox.change(CacheChange.FIRST, f.token()); assertTrue(chosen.list_ids.size in 50..950); assertEquals(0, chosen.list_ids.size % 50)
        assertEquals(chosen.list_ids.size.toString(), chosen.range_next); assertTrue(chosen.histories.isEmpty()); assertTrue(OfflineInbox.inspect(chosen).bytes <= MAX_CACHE_BYTES)
    }
    @Test fun firstPageWithPreservedLegacyMaterialTooLargeRefusesWithoutChangingOldBytes() {
        val old = oneCache().copy(events = mapOf("e_1" to CachedEvent(event(1), time), "e_9999" to CachedEvent(event(9999), time)),
            histories = mapOf("e_9999" to CachedHistory((1L..1000).map { history(it, "e_9999", "汉".repeat(11000)) }, null, time)))
        val f = Fixture(old) { events(1051, it, "汉".repeat(16000)) }; val before = f.vault.bytes.clone()
        assertTrue(OfflineInbox.inspect(old).bytes <= MAX_CACHE_BYTES)
        failWith { f.inbox.refresh() }; assertArrayEquals(before, f.vault.bytes)
    }
    @Test fun completeVisibleEndMayPruneOldListedDataButStillKeepsExternalObservation() {
        val initial = oneCache().copy(list_ids = listOf("e_1", "e_2"), events = (1..3).associate { "e_$it" to CachedEvent(event(it), time) })
        val f = Fixture(initial) { events(1, it) }; val after = f.inbox.refresh()
        assertEquals(listOf("e_1"), after.list_ids); assertEquals(setOf("e_1", "e_3"), after.events.keys); assertNull(after.range_next)
    }
    @Test fun lateCleanupNewCacheAndNewNamespaceRejectBeforeAnyMutation() {
        val f = Fixture { events(1051, it) }; f.inbox.refresh(); val token = f.token()
        f.inbox.change(CacheChange.NEXT, token); val before = f.vault.bytes.clone()
        failWith { f.inbox.change(CacheChange.CLEAR_ALL, token) }; assertArrayEquals(before, f.vault.bytes)
        val newToken = f.token(); f.state.value = LocalState(c.copy(token = "b".repeat(64)))
        failWith { f.inbox.change(CacheChange.CLEAR_ALL, newToken) }; assertArrayEquals(before, f.vault.bytes)
    }
    @Test fun cleanupOnlyTouchesReadModelAndDiskFailurePreservesFullContentAndOriginalWriteSlots() {
        val f = Fixture(oneCache().copy(histories = mapOf("e_1" to CachedHistory(listOf(history(1)), null, time)))) { error("cleanup must not call HTTP") }
        val p = Pending(c.namespace, "original", "/v1/events/e_1/responses", "original-body", true, true)
        val auth = AuthIntent("rotate", "original_rotation", c.base, "body", prior = c)
        f.state.value = f.state.value.copy(pending = p, auth_intent = auth)
        val draft = ResponseDraft("local_draft", c.namespace, "e_1", "source", 1, "q", 1, event(1).interaction!!.actions[0], "Event 1", event(1).expires_at, "original local text", time)
        f.state.value = f.state.value.copy(drafts = listOf(draft), templates = listOf(ReplyTemplate("t", "Local", "Text")))
        val originalState = f.state.value
        val before = f.vault.bytes.clone(); f.vault.reject = true
        failWith { f.inbox.change(CacheChange.CLEAR_ALL, f.token()) }; assertArrayEquals(before, f.vault.bytes); assertEquals(originalState, f.state.value)
        f.vault.reject = false; f.inbox.change(CacheChange.CLEAR_HISTORY, f.token()); assertTrue(f.inbox.snapshot().histories.isEmpty()); assertEquals(originalState, f.state.value)
        f.inbox.change(CacheChange.CLEAR_ALL, f.token()); assertTrue(f.inbox.snapshot().events.isEmpty()); assertNull(f.inbox.snapshot().scanned_at); assertTrue(f.paths.isEmpty()); assertEquals(originalState, f.state.value)
    }
    @Test fun corruptResetAndConnectionPairStyleResetNeverOverwriteUnreadableOldFile() {
        val f = Fixture(oneCache()) { error("no HTTP") }
        f.vault.bytes[f.vault.bytes.lastIndex] = (f.vault.bytes.last().toInt() xor 1).toByte(); val broken = f.vault.bytes.clone()
        failWith { f.inbox.reset() }; assertArrayEquals(broken, f.vault.bytes)
        f.ledger.connect(c.copy(token = "b".repeat(64))); failWith { f.inbox.reset() }; assertArrayEquals(broken, f.vault.bytes)
        f.ledger.disconnect(); failWith { f.inbox.reset() }; assertArrayEquals(broken, f.vault.bytes)
        assertEquals(0, f.vault.saves)
    }
    @Test fun laterGetDeniedBadCursorDuplicateOrSaveFailureKeepsOriginalWindowAndPosition() {
        for (mode in 0..3) {
            var broken = false
            val f = Fixture { path ->
                val after = path.substringAfter("after=").toInt()
                if (broken && after >= 1050) when (mode) {
                    0 -> throw ApiFailure(401, "UNAUTHENTICATED")
                    1 -> return@Fixture wire.encodeToString(Page.serializer(Event.serializer()), Page(listOf(event(1051)), "0"))
                    2 -> return@Fixture wire.encodeToString(Page.serializer(Event.serializer()), Page(listOf(event(1001)), null))
                }
                events(1100, path)
            }
            f.inbox.refresh(); val before = f.vault.bytes.clone(); val token = f.token(); broken = true; f.vault.reject = mode == 3
            failWith { f.inbox.change(CacheChange.NEXT, token) }; assertArrayEquals(before, f.vault.bytes)
        }
    }
    @Test fun historyBeyond1000RangesPersistAndRefreshFromActualAfterWithStrictEventBinding() {
        val f = Fixture(oneCache()) { histories(1051, it) }
        f.inbox.refreshHistory("e_1"); repeat(19) { f.inbox.moreHistory("e_1") }
        assertEquals(1000, f.inbox.snapshot().histories["e_1"]!!.items.size)
        val full = f.vault.bytes.clone(); failWith { f.inbox.moreHistory("e_1") }; assertArrayEquals(full, f.vault.bytes)
        val next = f.inbox.historyWindow("e_1", HistoryWindow.NEXT, f.token()); assertEquals("1000", next.from_after); assertEquals(1001L, next.items.first().seq); assertEquals(50, next.items.size)
        f.paths.clear(); assertEquals(next, f.inbox.refreshHistory("e_1")); assertTrue(f.paths.first().endsWith("after=1000"))
        val final = f.inbox.moreHistory("e_1"); assertEquals(51, final.items.size); assertNull(final.next_after)
        val back = f.inbox.historyWindow("e_1", HistoryWindow.PREVIOUS, f.token()); assertEquals("0", back.from_after); assertEquals(50, back.items.size)
    }
    @Test fun historyWindowWrongEventOldSeqMalformedStartOrLateConfirmationPreservesCipher() {
        val h = CachedHistory(listOf(history(1001)), "1001", time, "1000", listOf("0"))
        for (bad in listOf(history(1001, "e_other"), history(1000))) {
            val f = Fixture(oneCache().copy(histories = mapOf("e_1" to h))) { wire.encodeToString(Page.serializer(History.serializer()), Page(listOf(bad), null)) }
            val before = f.vault.bytes.clone(); failWith { f.inbox.refreshHistory("e_1") }; assertArrayEquals(before, f.vault.bytes)
        }
        for (invalid in listOf(h.copy(from_after = "1001"), h.copy(from_after = "-1"), h.copy(from_after = "9007199254740992"), h.copy(previous_ranges = listOf("1000")))) {
            failWith { OfflineInbox.validate(oneCache().copy(histories = mapOf("e_1" to invalid))) }
        }
        val f = Fixture(oneCache().copy(histories = mapOf("e_1" to h))) { histories(1100, it) }
        val token = f.token(); f.inbox.moreHistory("e_1"); val bytes = f.vault.bytes.clone(); failWith { f.inbox.historyWindow("e_1", HistoryWindow.FIRST, token) }; assertArrayEquals(bytes, f.vault.bytes)
    }
    @Test fun sixtyFourAnchorsDoNotBlockForwardAndFirstRemainsAvailableForBothKinds() {
        val anchors = (0..63).map { (it * 1000).toString() }
        val old = oneCache().copy(range_after = "64000", range_next = "65000", previous_ranges = anchors,
            histories = mapOf("e_1" to CachedHistory(listOf(history(64001)), "64001", time, "64000", anchors)))
        val f = Fixture(old) { path -> if (path.contains("/history")) histories(100000, path) else events(100000, path) }
        val hist = f.inbox.historyWindow("e_1", HistoryWindow.NEXT, f.token()); assertEquals(64, hist.previous_ranges.size); assertEquals("1000", hist.previous_ranges.first()); assertEquals("64001", hist.from_after)
        val next = f.inbox.change(CacheChange.NEXT, f.token()); assertEquals(64, next.previous_ranges.size); assertEquals("1000", next.previous_ranges.first())
        val again = f.inbox.change(CacheChange.NEXT, f.token()); assertEquals("66000", again.range_after); assertEquals(64, again.previous_ranges.size)
        val first = f.inbox.change(CacheChange.FIRST, f.token()); assertEquals("0", first.range_after); assertTrue(first.previous_ranges.isEmpty())
        failWith { OfflineInbox.validate(old.copy(previous_ranges = (0..64).map { it.toString() })) }
    }
    @Test fun namespaceMustBeBoundToEveryPageNotOnlyTheFinalCommit() {
        lateinit var f: Fixture
        f = Fixture(oneCache()) { path ->
            if (path.endsWith("after=0")) wire.encodeToString(Page.serializer(Event.serializer()), Page(listOf(event(1)), "1"))
            else {
                assertNotEquals(c.namespace, f.state.value.connection!!.namespace)
                f.ledger.connect(c) // Another identity was used for this page, then the original was restored before commit.
                wire.encodeToString(Page.serializer(Event.serializer()), Page(listOf(event(2, "OTHER NAMESPACE CONTENT")), null))
            }
        }
        var switched = false
        val reader = OfflineInbox(f.ledger, f.vault) {
            if (!switched) { switched = true; f.ledger.connect(c.copy(token = "b".repeat(64))) }
            time
        }
        val original = f.vault.bytes.clone()
        var failure: Exception? = null
        try { reader.refresh() } catch (e: Exception) { failure = e }
        if (failure == null) {
            assertEquals("OTHER NAMESPACE CONTENT", f.vault.load().events["e_2"]?.event?.body)
            fail("A page fetched under another namespace was committed after switching back")
        }
        assertEquals(1, f.paths.size); assertArrayEquals(original, f.vault.bytes)
    }
    @Test fun namespaceChangeDuringScanAndSeparateOwnersCleanupCannotClobberLateContent() {
        lateinit var f: Fixture
        f = Fixture(oneCache()) { path -> f.state.value = LocalState(c.copy(token = "b".repeat(64))); events(51, path) }
        val bytes = f.vault.bytes.clone(); failWith { f.inbox.refresh() }; assertArrayEquals(bytes, f.vault.bytes)
        val g = Fixture(oneCache()) { events(51, it) }; val oldToken = g.token(); g.inbox.refresh()
        val current = g.vault.bytes.clone(); failWith { OfflineInbox(g.ledger, g.vault).change(CacheChange.CLEAR_ALL, oldToken) }; assertArrayEquals(current, g.vault.bytes)
    }
}
