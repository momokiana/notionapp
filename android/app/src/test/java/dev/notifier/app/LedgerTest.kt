package dev.notifier.app

import java.io.File
import java.nio.file.Files
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class LedgerTest {
    private val c = Connection.parse("https://fixture.invalid", "a".repeat(64), false)
    private class Disk : StateStore {
        val file = Files.createTempFile("notifier-jvm-", ".json").toFile().apply { deleteOnExit() }
        init { save(LocalState()) }
        override fun load(): LocalState = wire.decodeFromString(file.readText())
        override fun save(state: LocalState) { file.writeText(wire.encodeToString(LocalState.serializer(), state)) }
    }
    private val event = wire.decodeFromString<Event>("""{"id":"event_1","title":"Question","body":"Body","source_id":"source","event_version":1,"interaction_version":1,"interaction":{"id":"q","version":1,"actions":[{"id":"go","label":"Go","type":"button"},{"id":"reply","label":"Reply","type":"text"}]},"disposition":"open","expires_at":"2099-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","can_respond":true}""")
    private fun failure(block: () -> Unit): Exception { try { block(); fail("expected failure") } catch (e: Exception) { return e }; error("unreachable") }
    @Test fun connectionRules() {
        listOf("http://example.org", "https://name:pass@example.org", "https://example.org?q=1", "https://example.org/#a", "https://example.org/v1", "https://example.org:0").forEach { failure { Connection.parse(it, c.token, false) } }
        failure { Connection.parse("http://127.0.0.1:3000", c.token, false) }
        assertEquals("http://127.0.0.1:3000", Connection.parse("http://127.0.0.1:3000/", c.token, true).base)
        assertNotEquals(c.namespace, c.copy(token = "b".repeat(64)).namespace)
    }
    @Test fun pendingIsOnDiskBeforeNetworkAndRestartUsesSameIdAndBody() {
        val disk = Disk(); var original: Pending? = null; var posts = 0
        val lost = object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String {
            original = disk.load().pending; assertNotNull(original); assertTrue(original!!.uncertain); posts++; throw java.io.IOException("lost ACK")
        } }
        val ledger = Ledger(disk, lost); ledger.connect(c)
        failure { ledger.respond(event, event.interaction!!.actions[0], "") }
        assertEquals(1, posts); assertNotNull(disk.load().pending)
        failure { ledger.connect(c.copy(base = "https://other.invalid")) }; failure { ledger.disconnect() }
        failure { ledger.respond(event, event.interaction!!.actions[1], "new choice") }; assertEquals(1, posts)
        val recover = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String {
            if (method == "GET") throw ApiFailure(404, "NOT_FOUND")
            assertEquals(original!!.body, body); assertEquals(original!!.path, path)
            return """{"response_id":"${original!!.id}","event_id":"event_1","saved_at":"fixture"}"""
        } })
        recover.recover(); assertNull(disk.load().pending)
    }
    @Test fun unknownNeverClearedByRecoveryRefusalForResponsesAndDecisions() {
        listOf(true, false).forEach { response ->
            listOf(401, 403, 409, 422, 503).forEach { status ->
                val disk = Disk()
                val lost = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw java.io.IOException() } })
                lost.connect(c)
                failure { if (response) lost.respond(event, event.interaction!!.actions[0], "") else lost.decide(event, "completed") }
                val original = disk.load().pending!!
                val denied = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw ApiFailure(status, "FIXTURE") } })
                failure { denied.recover() }; assertEquals(original, disk.load().pending)
                failure { denied.connect(c.copy(token = "b".repeat(64))) }
            }
        }
    }
    @Test fun unknown404ThenReplayConflictStaysUnknown() {
        val disk = Disk(); val setup = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw java.io.IOException() } })
        setup.connect(c); failure { setup.respond(event, event.interaction!!.actions[0], "") }
        val p = disk.load().pending!!
        failure { Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw ApiFailure(if (method == "GET") 404 else 409, "IDEMPOTENCY_CONFLICT") } }).recover() }
        assertEquals(p, disk.load().pending)
    }
    @Test fun restoredAuthFindsOriginalWithoutRepost() {
        val disk = Disk(); var posts = 0
        val initial = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { posts++; throw java.io.IOException() } })
        initial.connect(c); failure { initial.respond(event, event.interaction!!.actions[0], "") }
        val p = disk.load().pending!!
        val restored = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { assertEquals("GET", method); return """{"id":"${p.id}","event_id":"event_1"}""" } })
        restored.recover(); assertNull(disk.load().pending); assertEquals(1, posts)
    }
    @Test fun firstBusinessRefusalClearsButAuthRefusalDoesNot() {
        listOf(409 to "EVENT_VERSION_CONFLICT", 410 to "ACTION_EXPIRED", 422 to "INVALID_INPUT", 401 to "UNAUTHENTICATED", 403 to "FORBIDDEN").forEach { (status, code) ->
            val disk = Disk(); val l = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { throw ApiFailure(status, code) } })
            l.connect(c); failure { l.respond(event, event.interaction!!.actions[0], "") }
            assertEquals(status in listOf(401, 403), disk.load().pending != null)
        }
    }
    @Test fun failedPersistenceDoesNotSend() {
        var sent = false
        val state = object : StateStore { override fun load() = LocalState(c); override fun save(state: LocalState) { throw java.io.IOException("disk full") } }
        val l = Ledger(state, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { sent = true; return "{}" } })
        failure { l.respond(event, event.interaction!!.actions[0], "") }; assertFalse(sent)
    }
    @Test fun noCoercionAndOriginalUnicodeTextAndBindings() {
        val disk = Disk(); var body = ""
        val l = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, payload: String?): String { body = payload!!; val id = wire.parseToJsonElement(body).jsonObject["response_id"]!!.jsonPrimitive.content; return """{"response_id":"$id"}""" } })
        l.connect(c); val text = "  完整保留\n🙂  "
        l.respond(event, event.interaction!!.actions[1], text)
        val data = wire.parseToJsonElement(body).jsonObject
        assertEquals(text, data["text"]!!.jsonPrimitive.content); assertEquals(1, data["event_version"]!!.jsonPrimitive.int)
        assertEquals("q", data["interaction_id"]!!.jsonPrimitive.content); assertFalse(data.containsKey("target"))
        failure { l.respond(event, event.interaction!!.actions[1], " ") }
    }
    @Test fun paginationUsesSnapshotRefreshAndHistoryCursor() {
        val disk = Disk(); val paths = mutableListOf<String>()
        val l = Ledger(disk, object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { paths += path; return """{"items":[],"next_after":"51"}""" } })
        l.connect(c); assertEquals("51", l.events().next_after); l.events("51"); l.events(); l.history("event_1", "10")
        assertEquals(paths[0], paths[2]); assertTrue(paths[1].endsWith("after=51")); assertTrue(paths[3].contains("/history?limit=50&after=10"))
    }
}
