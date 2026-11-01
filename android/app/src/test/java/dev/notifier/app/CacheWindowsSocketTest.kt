package dev.notifier.app

import java.io.File
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test

/** Volume belongs to an isolated synthetic owner, so other socket tests keep their own original inbox. */
class CacheWindowsSocketTest {
    private class State(initial: LocalState) : StateStore {
        var value = initial
        override fun load() = value
        override fun save(state: LocalState) { value = state }
    }
    @Test fun actual1051EventWindowsExternalSlotAnd1002HistoryRowsKeepOriginalWriteState() {
        val base = System.getenv("NOTIFIER_TEST_URL"); val authPath = System.getenv("NOTIFIER_TEST_AUTH")
        assumeNotNull(base, authPath)
        val auth = File(authPath!!); val original = auth.readText(); val principals = wire.parseToJsonElement(original).jsonObject["principals"]!!.jsonArray
        val suffix = UUID.randomUUID().toString(); val owner = "volume_$suffix"
        val user = Connection.parse(base!!, newDeviceToken(), true); val source = Connection.parse(base, newDeviceToken(), true)
        val extra = buildJsonArray {
            principals.forEach(::add)
            add(buildJsonObject { put("id", "user_$suffix"); put("owner_id", owner); put("kind", "user"); put("token", user.token) })
            add(buildJsonObject { put("id", "actor_$suffix"); put("owner_id", owner); put("kind", "source"); put("token", source.token); put("source_id", "volume_source"); put("source_epoch", "epoch_1"); put("capabilities", buildJsonArray { add("publish"); add("reply"); add("read_responses") }) })
        }
        val http = HttpTransport()
        try {
            auth.writeText(buildJsonObject { put("principals", extra) }.toString())
            val ids = (1..1051).map { n ->
                val input = buildJsonObject {
                    put("request_id", UUID.randomUUID().toString()); put("title", "Volume fixture $n"); put("body", "Synthetic window content $n")
                    put("session_ref", "volume_fixture"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z")
                    if (n == 1) put("interaction", buildJsonObject { put("id", "question"); put("actions", buildJsonArray { add(buildJsonObject { put("id", "reply"); put("label", "Reply"); put("type", "text") }) }) })
                }
                wire.parseToJsonElement(http.call(source, "POST", "/v1/events", input.toString())).jsonObject["event_id"]!!.jsonPrimitive.content
            }
            val state = State(LocalState(user)); var stored = InboxCache(); val methods = mutableListOf<String>()
            val reader = Ledger(state, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { assertEquals("GET", method); methods += method; return http.call(connection, method, path, body) } })
            val vault = object : InboxVault { override fun load() = stored; override fun save(cache: InboxCache) { InboxCipherTestValidation(cache); stored = cache } }
            val inbox = OfflineInbox(reader, vault)
            val draftBook = ResponseDrafts(state, reader); val firstEvent = reader.event(ids.first())
            draftBook.create(firstEvent, firstEvent.interaction!!.actions.single(), "Preserve original local draft", ConnectionSnapshot(user.namespace))
            draftBook.template(null, "Local", "Preserve original template", ConnectionSnapshot(user.namespace))
            state.value = state.value.copy(pending = Pending(user.namespace, "original", "/v1/events/${ids.first()}/responses", "original-body", true, true), auth_intent = AuthIntent("rotate", "original_rotation", user.base, "original-auth-body", prior = user))
            val originalState = wire.encodeToString(LocalState.serializer(), state.value)
            fun token() = OfflineInbox.inspect(stored).token
            val first = inbox.refresh(); assertEquals(ids.take(1000), first.list_ids); assertNotNull(first.range_next)
            inbox.refreshEvent(ids[1000]); assertEquals(1001, stored.events.size)
            try { inbox.refreshEvent(ids[1001]); fail("second external slot must backpressure") } catch (_: IllegalStateException) { }
            assertEquals(1001, stored.events.size); inbox.refresh(); assertTrue(ids[1000] in stored.events)
            inbox.change(CacheChange.CLEAR_EXTERNAL, token()); assertEquals(1000, stored.events.size)
            val second = inbox.change(CacheChange.NEXT, token()); assertEquals(ids.drop(1000), second.list_ids); assertNull(second.range_next)
            assertEquals(ids, first.list_ids + second.list_ids)
            assertEquals(second.list_ids, OfflineInbox(reader, vault).refresh().list_ids)
            inbox.change(CacheChange.PREVIOUS, token()); assertEquals(ids.take(1000), stored.list_ids)
            repeat(1001) { version ->
                val body = buildJsonObject { put("update_id", UUID.randomUUID().toString()); put("expected_event_version", version + 1); put("kind", "progress"); put("body", "History progress ${version + 1}") }
                http.call(source, "POST", "/v1/events/${ids.first()}/updates", body.toString())
            }
            inbox.refreshEvent(ids.first()); inbox.refreshHistory(ids.first()); repeat(19) { inbox.moreHistory(ids.first()) }
            val prefix = stored.histories[ids.first()]!!; assertEquals(1000, prefix.items.size); assertNotNull(prefix.next_after)
            assertNotEquals("1000", prefix.next_after) // Other events consumed global history seq; not an item offset.
            val tail = inbox.historyWindow(ids.first(), HistoryWindow.NEXT, token()); assertEquals(prefix.next_after, tail.from_after); assertEquals(2, tail.items.size); assertNull(tail.next_after)
            assertTrue(tail.items.first().seq > prefix.items.last().seq)
            assertEquals(tail.items, OfflineInbox(reader, vault).refreshHistory(ids.first()).items)
            val previous = inbox.historyWindow(ids.first(), HistoryWindow.PREVIOUS, token()); assertEquals("0", previous.from_after); assertEquals(prefix.items.take(50), previous.items)
            http.call(user, "PUT", "/v1/events/${ids.first()}/read-state", """{"event_version":1002}""")
            val refreshed = inbox.refresh(); assertFalse(refreshed.events[ids.first()]!!.event.read_state.unread); assertEquals(1002L, refreshed.events[ids.first()]!!.event.event_version)
            inbox.change(CacheChange.CLEAR_HISTORY, token()); assertTrue(stored.histories.isEmpty()); assertEquals(1000, stored.list_ids.size)
            inbox.change(CacheChange.CLEAR_ALL, token()); assertNull(stored.scanned_at); assertTrue(stored.events.isEmpty())
            assertTrue(methods.all { it == "GET" }); assertEquals(originalState, wire.encodeToString(LocalState.serializer(), state.value))
        } finally { auth.writeText(original) }
    }
    private fun InboxCipherTestValidation(cache: InboxCache) { OfflineInbox.validate(cache); assertTrue(OfflineInbox.inspect(cache).bytes <= MAX_CACHE_BYTES) }
}
