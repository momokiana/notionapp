package dev.notifier.app

import java.io.File
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

class SourceRuntimeSocketTest {
    private class Disk(val initial: LocalState) : StateStore {
        var saves = 0
        override fun load() = initial
        override fun save(state: LocalState) { saves++; error("A source runtime query must never persist any operation") }
    }
    @Test fun actualSocketBindsObservationToTheAuthoritativeEventWithoutClaimingSourceReceiptOrWritingClientState() {
        val base = System.getenv("NOTIFIER_TEST_URL"); val auth = System.getenv("NOTIFIER_TEST_AUTH")
        assumeTrue("Requires the explicit isolated real-socket fixture", base != null && auth != null)
        val principals = wire.parseToJsonElement(File(auth!!).readText()).jsonObject["principals"]!!.jsonArray.map { it.jsonObject }
        fun connection(kind: String): Connection = Connection.parse(base!!, principals.first { it["kind"]!!.jsonPrimitive.content == kind }["token"]!!.jsonPrimitive.content, true)
        val transport = HttpTransport(); val source = connection("source"); val user = connection("user")
        val body = buildJsonObject {
            put("request_id", UUID.randomUUID().toString()); put("title", "Source runtime socket"); put("body", "Synthetic runtime observation, not Pi or a model receipt")
            put("session_ref", "runtime_socket"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z")
        }.toString()
        val id = wire.parseToJsonElement(transport.call(source, "POST", "/v1/events", body)).jsonObject["event_id"]!!.jsonPrimitive.content
        val event = wire.decodeFromString<Event>(transport.call(user, "GET", "/v1/events/$id")); val disk = Disk(LocalState(user))
        val result = SourceRuntimeClient(disk, transport).read(event)
        assertEquals(id, result.observation!!.event_id); assertEquals(event.event_version, result.observation.event_version)
        assertEquals("paused", result.observation.state); assertEquals("SOURCE_PAUSED_EXPLICIT", result.observation.reason_code)
        assertFalse(result.observation.model_permission_configured); assertEquals(0, disk.saves); assertEquals(LocalState(user), disk.load())
        assertEquals("not_observed", event.delivery_state); assertNull(event.reserved_response_id)
    }
}
