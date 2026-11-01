package dev.notifier.app

import java.io.File
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test

class RealContractTest {
    private class Memory(var state: LocalState = LocalState()) : StateStore {
        override fun load() = state
        override fun save(state: LocalState) { this.state = state }
    }
    @Test fun actualT001LargeUnicodeEventAndHistoryPagesStayBoundedAndComplete() {
        val base = System.getenv("NOTIFIER_TEST_URL"); val path = System.getenv("NOTIFIER_TEST_AUTH")
        assumeNotNull(base, path)
        val principals = wire.parseToJsonElement(File(path!!).readText()).jsonObject["principals"]!!.jsonArray
        val user = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "user" }.jsonObject
        val source = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "source" }.jsonObject
        val c = Connection.parse(base!!, user["token"]!!.jsonPrimitive.content, true)
        val s = c.copy(token = source["token"]!!.jsonPrimitive.content); val http = HttpTransport(); val large = "汉".repeat(16000)
        val ids = (1..51).map {
            val input = buildJsonObject { put("request_id", UUID.randomUUID().toString()); put("title", "Large fixture"); put("body", large); put("session_ref", "fixture"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z") }
            wire.parseToJsonElement(http.call(s, "POST", "/v1/events", input.toString())).jsonObject["event_id"]!!.jsonPrimitive.content
        }.toSet()
        val ledger = Ledger(Memory(LocalState(c)), http); val seen = mutableSetOf<String>(); var cursor: String? = null
        do { val page = ledger.events(cursor); seen += page.items.map { it.id }; cursor = page.next_after } while (cursor != null)
        assertTrue(seen.containsAll(ids))
        val id = ids.first()
        repeat(50) { version ->
            val input = buildJsonObject { put("update_id", UUID.randomUUID().toString()); put("expected_event_version", version + 1); put("kind", "progress"); put("body", large) }
            http.call(s, "POST", "/v1/events/$id/updates", input.toString())
        }
        val seqs = mutableSetOf<Long>(); cursor = null
        do { val page = ledger.history(id, cursor); page.items.forEach { assertEquals(large, it.data["body"]!!.jsonPrimitive.content); assertTrue(seqs.add(it.seq)) }; cursor = page.next_after } while (cursor != null)
        assertEquals(51, seqs.size)
    }
    @Test fun actualSocketCacheFullScanSameVersionFactsAndStaleWriteGate() {
        val base = System.getenv("NOTIFIER_TEST_URL"); val authPath = System.getenv("NOTIFIER_TEST_AUTH")
        assumeNotNull(base, authPath)
        val principals = wire.parseToJsonElement(File(authPath!!).readText()).jsonObject["principals"]!!.jsonArray
        val user = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "user" }.jsonObject
        val source = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "source" }.jsonObject
        val c = Connection.parse(base!!, user["token"]!!.jsonPrimitive.content, true)
        val s = c.copy(token = source["token"]!!.jsonPrimitive.content); val http = HttpTransport()
        val ids = (1..51).map { n ->
            val input = buildJsonObject {
                put("request_id", UUID.randomUUID().toString()); put("title", "Offline contract $n"); put("body", "缓存🙂")
                put("session_ref", "isolated_cache"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z")
                put("interaction", buildJsonObject { put("id", "question"); put("actions", buildJsonArray { add(buildJsonObject { put("id", "go"); put("label", "Continue"); put("type", "button") }) }) })
            }
            wire.parseToJsonElement(http.call(s, "POST", "/v1/events", input.toString())).jsonObject["event_id"]!!.jsonPrimitive.content
        }
        val state = Memory(LocalState(c)); var stored = InboxCache(); val methods = mutableListOf<String>()
        val vault = object : InboxVault { override fun load() = stored; override fun save(cache: InboxCache) { stored = cache } }
        val ledger = Ledger(state, http)
        val reader = Ledger(state, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String {
            methods += method; check(method == "GET"); return http.call(connection, method, path, body)
        } })
        val inbox = OfflineInbox(reader, vault); val initial = inbox.refresh(); assertTrue(initial.list_ids.containsAll(ids))
        val old = initial.events[ids.first()]!!.event
        http.call(c, "PUT", "/v1/events/${old.id}/read-state", """{"event_version":1}""")
        val read = inbox.refresh().events[old.id]!!.event
        assertEquals(old.event_version, read.event_version); assertFalse(read.read_state.unread)
        http.call(s, "POST", "/v1/events/${old.id}/updates", """{"update_id":"${UUID.randomUUID()}","expected_event_version":1,"kind":"progress","body":"新版完整🙂"}""")
        val changed = inbox.refresh().events[old.id]!!.event
        assertEquals(2L, changed.event_version); assertEquals("新版完整🙂", changed.body)
        inbox.refreshEvent(old.id); inbox.refreshHistory(old.id)
        assertEquals(2, stored.histories[old.id]!!.items.size); assertTrue(methods.all { it == "GET" })
        try { ledger.respond(old, old.interaction!!.actions.first(), ""); fail("stale card must refuse") } catch (e: ApiFailure) { assertEquals("EVENT_VERSION_CONFLICT", e.code) }
        assertNull(state.state.pending); assertNull(ledger.event(old.id).reserved_response_id)
        assertEquals(stored, OfflineInbox(reader, vault).snapshot())
    }
    @Test fun actualT001HttpLostAckRevocationAndRecoveryForBothWrites() {
        val base = System.getenv("NOTIFIER_TEST_URL"); val authPath = System.getenv("NOTIFIER_TEST_AUTH")
        assumeNotNull(base, authPath)
        val authFile = File(authPath!!); val original = authFile.readText()
        val principals = wire.parseToJsonElement(original).jsonObject["principals"]!!.jsonArray
        val user = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "user" }.jsonObject
        val source = principals.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "source" }.jsonObject
        val c = Connection.parse(base!!, user["token"]!!.jsonPrimitive.content, true)
        val s = c.copy(token = source["token"]!!.jsonPrimitive.content)
        val http = HttpTransport()
        try {
            listOf(true, false).forEach { response ->
                val body = buildJsonObject {
                    put("request_id", UUID.randomUUID().toString()); put("title", "Contract fixture"); put("body", "Choose")
                    put("session_ref", "isolated_session"); put("target_revision", "revision_1"); put("expires_at", "2099-01-01T00:00:00Z")
                    put("interaction", buildJsonObject { put("id", "question"); put("actions", buildJsonArray { add(buildJsonObject { put("id", "go"); put("label", "Continue"); put("type", "button") }) }) })
                }.toString()
                val eventId = wire.parseToJsonElement(http.call(s, "POST", "/v1/events", body)).jsonObject["event_id"]!!.jsonPrimitive.content
                val store = Memory(LocalState(c))
                val lost = Ledger(store, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { http.call(connection, method, path, body); throw java.io.IOException("simulate lost committed ACK") } })
                val e = Ledger(store, http).event(eventId)
                try { if (response) lost.respond(e, e.interaction!!.actions[0], "") else lost.decide(e, "completed"); fail("expected lost ACK") } catch (_: java.io.IOException) { }
                val p = store.state.pending!!
                authFile.writeText(buildJsonObject { put("principals", buildJsonArray { add(source) }) }.toString())
                try { Ledger(store, http).recover(); fail("auth must reject") } catch (failure: ApiFailure) { assertEquals(401, failure.status) }
                assertEquals(p, store.state.pending)
                authFile.writeText(original)
                val restored = Ledger(store, http); restored.recover(); assertNull(store.state.pending)
                assertEquals(2L, restored.event(eventId).event_version)
                val history = restored.history(eventId).items
                assertEquals(1, history.count { it.kind == if (response) "response_saved" else "user_disposition" })
                if (response) assertEquals(p.id, restored.event(eventId).reserved_response_id) else assertEquals("completed", restored.event(eventId).disposition)
            }
        } finally { authFile.writeText(original) }
    }
}
