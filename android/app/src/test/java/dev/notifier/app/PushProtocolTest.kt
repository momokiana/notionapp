package dev.notifier.app

import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class PushProtocolTest {
    private val a = "a".repeat(64); private val b = "b".repeat(64)
    private val payload = PushEnvelope("event_1", 1, "delivery_1", "c".repeat(64))
    private class Disk : PushVault {
        private val file = Files.createTempFile("notifier-push-", ".json").toFile().apply { deleteOnExit() }
        init { save(PushDatabase()) }
        override fun load(): PushDatabase = wire.decodeFromString(file.readText())
        override fun save(state: PushDatabase) { file.outputStream().use { out -> out.write(wire.encodeToString(PushDatabase.serializer(), state).toByteArray()); out.fd.sync() } }
    }
    private fun event(version: Long = 1, disposition: String = "open"): Event = wire.decodeFromString("""{"id":"event_1","title":"private title","body":"private body","source_id":"source","event_version":$version,"interaction_version":0,"disposition":"$disposition","expires_at":"2099-01-01T00:00:00Z","updated_at":"fixture"}""")
    private fun fails(action: () -> Unit) { try { action(); fail("expected rejection") } catch (_: Exception) { } }
    @Test fun strictPayloadIsOnlyReferencesAndBounded() {
        assertEquals(payload, PushEnvelope.parse(wire.encodeToString(PushEnvelope.serializer(), payload).toByteArray()))
        listOf("{}", """{"event_id":"../../other","event_version":1,"delivery_id":"d","nonce":"${payload.nonce}"}""", """{"event_id":"event_1","event_version":0,"delivery_id":"d","nonce":"${payload.nonce}"}""").forEach { fails { PushEnvelope.parse(it.toByteArray()) } }
        val extra = wire.parseToJsonElement(wire.encodeToString(PushEnvelope.serializer(), payload)).jsonObject.toMutableMap(); extra["body"] = JsonPrimitive("must never be authority")
        fails { PushEnvelope.parse(JsonObject(extra).toString().toByteArray()) }; fails { PushEnvelope.parse(ByteArray(4097)) }
        val quotedVersion = wire.parseToJsonElement(wire.encodeToString(PushEnvelope.serializer(), payload)).jsonObject.toMutableMap()
        quotedVersion["event_version"] = JsonPrimitive("1"); fails { PushEnvelope.parse(JsonObject(quotedVersion).toString().toByteArray()) }
        quotedVersion["event_version"] = JsonPrimitive(1); quotedVersion["event_id"] = JsonPrimitive(1); fails { PushEnvelope.parse(JsonObject(quotedVersion).toString().toByteArray()) }
    }
    @Test fun serverReceiptMustAuthenticateExactPayloadMappingBeforeNotification() {
        val matching = buildJsonObject { put("delivery_id", payload.delivery_id); put("event_id", payload.event_id); put("event_version", payload.event_version); put("state", "device_received") }
        payload.verifyReceipt(matching)
        listOf("delivery_id", "event_id", "event_version", "state").forEach { key -> val wrong = matching.toMutableMap(); wrong[key] = JsonPrimitive(if (key == "event_version") "9" else "wrong"); fails { payload.verifyReceipt(JsonObject(wrong)) } }
        assertNotEquals(payload.fingerprint, payload.copy(nonce = "d".repeat(64)).fingerprint)
        assertNotEquals(payload.fingerprint, payload.copy(event_id = "other_event").fingerprint)
    }
    @Test fun duplicateAndRestartKeepReceiptAndDoNotAlertAgain() {
        val disk = Disk(); var count = 0; val records = PushRecords(disk, a)
        records.received(payload); records.post(payload, event(), { true }) { count++ }
        val reopened = PushRecords(disk, a); assertTrue(reopened.received(payload).posted)
        assertTrue(reopened.post(payload, event(2), { true }) { count++ }.posted); assertEquals(1, count)
        fails { reopened.received(payload.copy(nonce = "d".repeat(64))) }
    }
    @Test fun outOfOrderAndSameVersionDifferentDeliveryCannotOverwriteLatest() {
        val disk = Disk(); val records = PushRecords(disk, a); var count = 0
        val newer = payload.copy(delivery_id = "new", event_version = 3); records.received(newer)
        records.post(newer, event(3), { true }) { count++ }
        records.received(payload); assertFalse(records.post(payload, event(2), { true }) { count++ }.posted)
        val same = payload.copy(delivery_id = "same", event_version = 3); records.received(same)
        assertFalse(records.post(same, event(3), { true }) { count++ }.posted); assertEquals(1, count)
        assertEquals(3L, PushRecords(disk, a).snapshot().watermarks["event_1"])
    }
    @Test fun connectionNamespacesStayIndependentAndInactiveOrClosedEventsDoNotPost() {
        val disk = Disk(); var count = 0; val first = PushRecords(disk, a); val second = PushRecords(disk, b)
        first.received(payload); first.post(payload, event(), { false }) { count++ }
        assertTrue(first.snapshot().watermarks.isEmpty()); second.received(payload); second.post(payload, event(disposition = "paused"), { true }) { count++ }
        assertEquals(0, count); first.post(payload, event(), { true }) { count++ }; second.post(payload, event(), { true }) { count++ }
        assertEquals(2, count); assertTrue(PushRecords(disk, a).snapshot().deliveries[payload.delivery_id]!!.posted)
    }
    @Test fun crashInNotifyWindowPersistsUnknownAndNeverFakesPostedOrRetriesOS() {
        val disk = Disk(); val records = PushRecords(disk, a); records.received(payload); var calls = 0
        fails { records.post(payload, event(), { true }) { calls++; throw java.io.IOException("OS result unknown") } }
        val reopened = PushRecords(disk, a); val observation = reopened.post(payload, event(), { true }) { calls++ }
        assertTrue(observation.posting_unknown); assertFalse(observation.posted); assertEquals(1, calls)
    }
    @Test fun failedReservationPersistenceMeansZeroOSCalls() {
        val initial = PushDatabase(mapOf(a to PushAccount(deliveries = mapOf(payload.delivery_id to DeviceObservation(payload)))))
        var calls = 0
        val store = object : PushVault { override fun load() = initial; override fun save(state: PushDatabase) { throw java.io.IOException("disk full") } }
        fails { PushRecords(store, a).post(payload, event(), { true }) { calls++ } }; assertEquals(0, calls)
    }
    @Test fun registrationRequestIsStableOnDiskAndOnlyExplicitEndpointChangeSupersedesIt() {
        val disk = Disk(); val records = PushRecords(disk, a); val revision = records.endpoint("https://fixture.invalid/topic").revision
        val first = records.registration(revision, 7)!!
        assertEquals(first, PushRecords(disk, a).registration(revision, 99))
        val next = records.endpoint("https://fixture.invalid/new_topic").revision
        assertNull(records.registration(revision, 7)); assertNotEquals(first.registration_id, records.registration(next, 8)!!.registration_id)
        assertTrue(PushRecords(disk, b).snapshot().deliveries.isEmpty())
    }
    @Test fun repeatedEndpointAndLostRegistrationAckReconcileWithoutNewGenerationRequest() {
        val disk = Disk(); val records = PushRecords(disk, a); val revision = records.endpoint("https://fixture.invalid/topic").revision
        val original = records.registration(revision, 0)!!
        assertTrue(PushRecords(disk, a).confirmRegistration(revision, original.registration_id, true)) // Original ACK lost, server current record proves it.
        assertNull(records.snapshot().registration); assertEquals(original.registration_id, records.snapshot().registered_id)
        val duplicate = records.endpoint("https://fixture.invalid/topic"); assertEquals(revision, duplicate.revision)
        assertTrue(records.confirmRegistration(revision, original.registration_id, true)); assertNull(records.snapshot().registration)
        assertFalse(records.confirmRegistration(revision, original.registration_id, false)) // Origin/config no longer approves it.
        val changed = records.endpoint("https://fixture.invalid/new_topic"); assertTrue(changed.revision > revision)
        assertFalse(records.confirmRegistration(changed.revision, original.registration_id, true))
        assertNotEquals(original.registration_id, records.registration(changed.revision, 1)!!.registration_id)
    }
    @Test fun independentWorkerThreadsShareDurableVersionReservation() {
        val disk = Disk(); val ready = CountDownLatch(2); val start = CountDownLatch(1); val calls = AtomicInteger(); val failure = AtomicReference<Throwable?>()
        val threads = (1..2).map { n -> Thread {
            try { val p = payload.copy(delivery_id = "delivery_$n"); val r = PushRecords(disk, a); r.received(p); ready.countDown(); start.await(); r.post(p, event(), { true }) { calls.incrementAndGet() } }
            catch (e: Throwable) { failure.set(e) }
        }.apply { start() } }
        assertTrue(ready.await(5, java.util.concurrent.TimeUnit.SECONDS)); start.countDown(); threads.forEach { it.join(5000) }
        failure.get()?.let { throw it }; assertEquals(1, calls.get())
    }
}
