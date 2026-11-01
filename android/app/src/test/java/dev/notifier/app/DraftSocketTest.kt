package dev.notifier.app

import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test

class DraftSocketTest {
    private class State(initial: LocalState) : StateStore {
        private var bytes = checkedLocalBytes(initial).toString(Charsets.UTF_8)
        override fun load(): LocalState = wire.decodeFromString(bytes)
        override fun save(state: LocalState) { bytes = checkedLocalBytes(state).toString(Charsets.UTF_8) }
    }
    private fun connections(): Pair<Connection, Connection> {
        val base = System.getenv("NOTIFIER_TEST_URL"); val auth = System.getenv("NOTIFIER_TEST_AUTH"); assumeNotNull(base, auth)
        val principals = wire.parseToJsonElement(File(auth!!).readText()).jsonObject["principals"]!!.jsonArray.map { it.jsonObject }
        return Connection.parse(base!!, principals.first { it["kind"]!!.jsonPrimitive.content == "user" }["token"]!!.jsonPrimitive.content, true) to
            Connection.parse(base, principals.first { it["kind"]!!.jsonPrimitive.content == "source" }["token"]!!.jsonPrimitive.content, true)
    }
    private fun seed(http: HttpTransport, source: Connection): String {
        val body = buildJsonObject {
            put("request_id", UUID.randomUUID().toString()); put("title", "Draft socket question"); put("body", "Read this before submitting")
            put("session_ref", "synthetic_draft"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z")
            put("interaction", buildJsonObject { put("id", "question"); put("actions", buildJsonArray { add(buildJsonObject { put("id", "reply"); put("label", "Reply"); put("type", "text") }) }) })
        }
        return wire.parseToJsonElement(http.call(source, "POST", "/v1/events", body.toString())).jsonObject["event_id"]!!.jsonPrimitive.content
    }
    @Test fun actualSocketDraftReconfirmationProgressCommittedLostAckAndOriginalRecovery() {
        val (user, source) = connections(); val http = HttpTransport(); val id = seed(http, source)
        val state = State(LocalState(user)); var posts = 0
        val dropAck = object : Transport {
            override fun call(connection: Connection, method: String, path: String, body: String?): String {
                val result = http.call(connection, method, path, body)
                if (method == "POST") { posts++; throw IOException("synthetic lost committed draft ACK") }
                return result
            }
        }
        val ledger = Ledger(state, dropAck); val book = ResponseDrafts(state, ledger); val event = ledger.event(id); val expected = ConnectionSnapshot(user.namespace)
        val draft = book.create(event, event.interaction!!.actions.single(), "  准确原文🙂\n保留空白  ", expected)
        book.template(null, "Local", "Not sent", expected); assertNull(Ledger(state, http).event(id).reserved_response_id)
        http.call(source, "POST", "/v1/events/$id/updates", """{"update_id":"${UUID.randomUUID()}","expected_event_version":1,"kind":"progress","body":"Current progress v2"}""")
        val confirmation = book.prepare(draft, expected); assertEquals(2L, confirmation.current.event_version); assertEquals(1L, confirmation.draft.event_version)
        try { ledger.submitDraft(confirmation, expected); fail("ACK should be lost") } catch (_: IOException) { }
        val pending = state.load().pending!!; assertTrue(pending.uncertain); assertEquals(draft, pending.draft); assertTrue(state.load().drafts.isEmpty()); assertEquals(1, posts)
        val reopened = Ledger(state, http); reopened.recover(expected, pending.id)
        assertNull(state.load().pending); assertTrue(state.load().drafts.isEmpty()); assertEquals(1, state.load().templates.size)
        val saved = reopened.response(pending.id); assertEquals(draft.text, saved["text"]!!.jsonPrimitive.content); assertEquals(id, saved["event_id"]!!.jsonPrimitive.content)
        assertEquals(1, reopened.history(id).items.count { it.kind == "response_saved" }); assertEquals(3L, reopened.event(id).event_version); assertEquals(1, posts)
    }
    @Test fun actualSocketChangedQuestionRefusesWithoutSubmittingOrDiscardingText() {
        val (user, source) = connections(); val http = HttpTransport(); val id = seed(http, source); val state = State(LocalState(user))
        val ledger = Ledger(state, http); val book = ResponseDrafts(state, ledger); val event = ledger.event(id); val expected = ConnectionSnapshot(user.namespace)
        val draft = book.create(event, event.interaction!!.actions.single(), "Keep original draft", expected); val confirmation = book.prepare(draft, expected)
        http.call(source, "POST", "/v1/events/$id/updates", """{"update_id":"${UUID.randomUUID()}","expected_event_version":1,"kind":"progress","body":"Different question","interaction":{"id":"replacement","actions":[{"id":"reply","label":"Reply","type":"text"}]}}""")
        try { ledger.submitDraft(confirmation, expected); fail("must re-confirm a different question") } catch (_: IllegalStateException) { }
        assertEquals(listOf(draft), state.load().drafts); assertNull(state.load().pending); assertNull(ledger.event(id).reserved_response_id)
        assertEquals(0, ledger.history(id).items.count { it.kind == "response_saved" })
    }
}
