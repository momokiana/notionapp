package dev.notifier.app

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class SourceRuntimeTest {
    private class Disk(initial: LocalState) : StateStore {
        var value = initial; var saves = 0
        override fun load() = value
        override fun save(state: LocalState) { saves++; value = state }
    }
    private val connection = Connection.parse("https://app.example.test", "a".repeat(64), false)
    private fun event() = Event("event", "Title", "Body", "source", 1, 1, disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = "now")
    private fun raw() = """{"event_id":"event","event_version":1,"source_id":"source","source_epoch":"epoch_1","state":"paused","model_permission_configured":true,"reason_code":"SOURCE_PAUSED_EXPLICIT","observed_at":"2026-10-31T00:00:00.000Z"}"""
    private fun failSafely(action: () -> Unit): Exception { try { action(); fail("Expected conservative refusal") } catch (e: AssertionError) { throw e } catch (e: Exception) { return e }; error("unreachable") }
    @Test fun exactObservationUsesGetOnlyAndCannotModifyEitherOriginalSlotOrCredentials() {
        val pending = Pending(connection.namespace, "original", "/v1/events/event/responses", "original exact body", true, true)
        val intent = AuthIntent("rotate", "original_identity", connection.base, "original identity body", prior = connection, uncertain = true)
        val disk = Disk(LocalState(connection, pending, auth_intent = intent)); val before = disk.value; var calls = 0
        val transport = object : Transport { override fun call(c: Connection, method: String, path: String, body: String?): String {
            assertEquals(connection, c); assertEquals("GET", method); assertEquals("/v1/source-runtime/source?event_id=event&event_version=1", path); assertNull(body); calls++; return raw()
        } }
        val read = SourceRuntimeClient(disk, transport).read(event()); assertEquals("paused", read.observation!!.state); assertTrue(read.observation.model_permission_configured)
        assertEquals(1, calls); assertEquals(0, disk.saves); assertEquals(before, disk.value); assertTrue(sourceRuntimeText(read).contains("仍可先保存等待"))
    }
    @Test fun oldOrInvisibleSource404IsLocalUnknownNotAnAssertionThatTheSourceStopped() {
        val disk = Disk(LocalState(connection)); val client = SourceRuntimeClient(disk, object : Transport { override fun call(c: Connection, method: String, path: String, body: String?): String { throw ApiFailure(404, "NOT_FOUND") } })
        val read = client.read(event()); assertTrue(read.unavailable); assertNull(read.observation); assertTrue(sourceRuntimeText(read).contains("不代表来源已停止")); assertEquals(0, disk.saves)
    }
    @Test fun authConflictAndFailureCannotClearOriginalUnknownOrBecomeRevocationOrCompletionFacts() {
        for (status in listOf(401, 409, 503)) {
            val disk = Disk(LocalState(connection, Pending(connection.namespace, "original", "/v1/events/event/responses", "body", true, true))); val before = disk.value
            val error = failSafely { SourceRuntimeClient(disk, object : Transport { override fun call(c: Connection, method: String, path: String, body: String?): String { throw ApiFailure(status, "TEST_REFUSAL") } }).read(event()) }
            assertTrue(error is ApiFailure); assertEquals(status, (error as ApiFailure).status); assertEquals(before, disk.value); assertEquals(0, disk.saves)
        }
    }
    @Test fun wrongEventVersionSourceTypesOrPrivateExtraFieldsNeverReachDisplay() {
        val original = wire.parseToJsonElement(raw()).jsonObject
        val edits = listOf("event_id" to JsonPrimitive("other"), "event_version" to JsonPrimitive(2), "source_id" to JsonPrimitive("other_source"),
            "event_version" to JsonPrimitive("1"), "model_permission_configured" to JsonPrimitive("true"), "state" to JsonPrimitive("running"),
            "reason_code" to JsonPrimitive("PRIVATE_SYNTHETIC_TOKEN"), "observed_at" to JsonPrimitive("not-a-time"), "private_path" to JsonPrimitive("PRIVATE_SYNTHETIC_TOKEN"))
        for ((key, value) in edits) {
            val changed = JsonObject(original + (key to value)).toString(); val error = failSafely { SourceRuntimeObservation.parse(changed, event()) }
            assertFalse(error.message.orEmpty().contains("PRIVATE_SYNTHETIC_TOKEN")); assertFalse(error.message.orEmpty().contains("other_source"))
        }
        failSafely { SourceRuntimeObservation.parse(" ".repeat(4097), event()) }
    }
    @Test fun anotherConnectionBeforeOrDuringReadCannotApplyAnOldObservation() {
        val disk = Disk(LocalState(connection)); val next = connection.copy(base = "https://other.example.test"); var calls = 0
        val transport = object : Transport { override fun call(c: Connection, method: String, path: String, body: String?): String { calls++; return raw() } }
        Ledger(disk, transport).connect(next); val saves = disk.saves
        failSafely { SourceRuntimeClient(disk, transport).read(event(), ConnectionSnapshot(connection.namespace)) }; assertEquals(0, calls); assertEquals(saves, disk.saves)
        disk.value = LocalState(connection)
        val late = object : Transport { override fun call(c: Connection, method: String, path: String, body: String?): String { disk.value = LocalState(next); return raw() } }
        failSafely { SourceRuntimeClient(disk, late).read(event()) }; assertEquals(next, disk.value.connection)
    }
    @Test fun runningLoopAndConfiguredPermissionAreNeverDisplayedAsCurrentModelQualification() {
        val parsed = SourceRuntimeObservation.parse(raw().replace("\"paused\"", "\"running\"").replace("SOURCE_PAUSED_EXPLICIT", "RUNTIME_LOOP_OBSERVED"), event())
        val text = sourceRuntimeText(SourceRuntimeRead(parsed)); assertTrue(text.contains("不保证可立即处理")); assertTrue(text.contains("不等于当前授权或预算可用")); assertTrue(sourceRuntimeText(null).contains("未观察"))
    }
}
