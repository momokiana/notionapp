package dev.notifier.app

import java.io.IOException
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DeviceClientTest {
    private class Disk(initial: LocalState = LocalState()) : StateStore {
        var bytes = wire.encodeToString(LocalState.serializer(), initial)
        var writes = 0; var failAt = -1; var onLoad: (() -> Unit)? = null
        override fun load(): LocalState { val original = bytes; onLoad?.invoke(); return wire.decodeFromString(original) }
        override fun save(state: LocalState) { writes++; if (writes == failAt) throw IOException("synthetic atomic write failure"); bytes = wire.encodeToString(LocalState.serializer(), state) }
    }
    private data class Call(val c: Connection, val method: String, val path: String, val body: String?)
    private class Backend(var self: ManagedDevice, var token: String) : Transport {
        val calls = mutableListOf<Call>(); var claim: JsonObject? = null; var transition: CredentialTransition? = null; var revoke: JsonObject? = null
        var loseAck: String? = null; var selfFailure: ApiFailure? = null; var proofEdit: (CredentialTransition) -> CredentialTransition = { it }
        var before: ((Call) -> Unit)? = null; var failResponse = false
        override fun call(connection: Connection, method: String, path: String, body: String?): String {
            val call = Call(connection, method, path, body); calls.add(call); before?.invoke(call)
            val value = body?.let { wire.parseToJsonElement(it).jsonObject }
            fun current() { if (connection.token != token || self.revoked) throw ApiFailure(401, "UNAUTHENTICATED") }
            when {
                path == "/v1/pairing/claim" -> {
                    if (claim == null) { token = value!!["proposed_token"]!!.jsonPrimitive.content; claim = buildJsonObject { put("claim_id", value["claim_id"]!!); put("device_id", self.device_id); put("store_id", self.store_id) } }
                    if (loseAck == "pair") { loseAck = null; throw IOException("synthetic lost claim ACK") }
                    return claim.toString()
                }
                path == "/v1/device/self" -> { selfFailure?.let { throw it }; current(); return wire.encodeToString(ManagedDevice.serializer(), self) }
                path.startsWith("/v1/device/claims/") -> { current(); if (claim?.get("claim_id")?.jsonPrimitive?.content != path.substringAfterLast('/')) throw ApiFailure(404, "NOT_FOUND"); return claim.toString() }
                path == "/v1/device/rotate" -> {
                    current(); val old = token; token = value!!["replacement_token"]!!.jsonPrimitive.content
                    transition = CredentialTransition(self.store_id, value["request_id"]!!.jsonPrimitive.content, self.device_id, self.owner_id, credentialDigest(old), credentialDigest(token), self.credential_version, self.credential_version + 1)
                    self = self.copy(credential_version = self.credential_version + 1)
                    if (loseAck == "rotate") { loseAck = null; throw IOException("synthetic lost rotation ACK") }
                    return buildJsonObject { put("request_id", transition!!.request_id); put("device_id", self.device_id); put("credential_version", self.credential_version) }.toString()
                }
                path.startsWith("/v1/device/transitions/") -> { current(); val p = transition ?: throw ApiFailure(404, "NOT_FOUND"); return wire.encodeToString(CredentialTransition.serializer(), proofEdit(p)) }
                path == "/v1/device/revoke" -> {
                    current(); val target = value!!["device_id"]!!.jsonPrimitive.content
                    revoke = buildJsonObject { put("request_id", value["request_id"]!!); put("device_id", target); put("owner_id", self.owner_id); put("revoked", true) }
                    if (target == self.device_id) self = self.copy(revoked = true)
                    if (loseAck == "revoke") { loseAck = null; throw IOException("synthetic lost revocation ACK") }
                    return revoke.toString()
                }
                path == "/v1/device/self-revocation-receipt" -> { if (connection.token != token || revoke?.get("request_id") != value!!["request_id"]) throw ApiFailure(404, "NOT_FOUND"); return revoke.toString() }
                path.startsWith("/v1/device/revocations/") -> { current(); return revoke?.toString() ?: throw ApiFailure(404, "NOT_FOUND") }
                path == "/v1/devices" -> { current(); return "{\"items\":[]}" }
                path.startsWith("/v1/responses/") -> { current(); throw ApiFailure(404, "NOT_FOUND") }
                path.endsWith("/responses") -> { current(); if (failResponse) throw IOException("synthetic original response unknown"); return buildJsonObject { put("response_id", value!!["response_id"]!!); put("event_id", path.split('/')[3]) }.toString() }
                else -> error("Unexpected fixture route $path")
            }
        }
    }
    private data class Fixture(val disk: Disk, val backend: Backend, val client: DeviceClient, val ledger: Ledger, val old: Connection, val info: ManagedDevice)
    private fun fixture(pending: Pending? = null, manager: Boolean = false): Fixture {
        val old = Connection.parse("https://app.example.test", "a".repeat(64), false)
        val info = ManagedDevice(UUID.randomUUID().toString(), "phone", "owner", "Phone", manager, 1)
        val disk = Disk(LocalState(old, pending)); val backend = Backend(info, old.token)
        return Fixture(disk, backend, DeviceClient(disk, backend, false), Ledger(disk, backend), old, info)
    }
    private fun pkg(f: Fixture): PairingPackage = PairingPackage(1, f.old.base, f.info.store_id, "invitation", "b".repeat(64), System.currentTimeMillis() + 600000, f.info.owner_id, "Phone", f.info.manage_devices)
    private fun event() = Event("event", "Title", "Body", "source", 1, 1, Interaction("question", 1, listOf(Action("yes", "Yes", "button"))), disposition = "open", expires_at = "2099-01-01T00:00:00Z", updated_at = "now", can_respond = true)
    private fun unknown(f: Fixture): Pending { f.backend.failResponse = true; fails { f.ledger.respond(event(), event().interaction!!.actions[0], "") }; f.backend.failResponse = false; return f.disk.load().pending!! }
    private fun fails(action: () -> Unit) { try { action(); fail("Expected conservative refusal") } catch (e: AssertionError) { throw e } catch (_: Exception) {} }

    @Test fun packageRejectsInventedCapabilityFieldsAndNoncanonicalOrPublicHttpRoots() {
        val f = fixture(); val text = wire.encodeToString(PairingPackage.serializer(), pkg(f)); assertEquals(pkg(f).base, PairingPackage.parse(text, false).base)
        for (base in listOf("http://public.example.test", "https://APP.example.test:443", "https://app.example.test/path", "https://u:p@app.example.test")) fails { PairingPackage.parse(wire.encodeToString(PairingPackage.serializer(), pkg(f).copy(base = base)), false) }
        fails { PairingPackage.parse(text.dropLast(1) + ",\"binding_namespace\":\"forged\"}", false) }
        fails { PairingPackage.parse(" ".repeat(8193), false) }
        fails { PairingPackage.parse(text.replace("\"manage_devices\":false", "\"manage_devices\":\"false\""), false) }
    }
    @Test fun pairPersistsOriginalFullIntentAndUncertaintyBeforePostThenUsesNewNamespace() {
        val f = fixture(); f.backend.before = { call -> if (call.path == "/v1/pairing/claim") { val p = f.disk.load().auth_intent!!; assertTrue(p.uncertain); assertEquals(p.body, call.body); assertEquals(p.proposed_token, call.c.token); assertEquals(f.old, f.disk.load().connection) } }
        f.client.pair(pkg(f)); val state = f.disk.load(); assertNull(state.auth_intent); assertEquals(f.info.device_id, state.device!!.device_id); assertNotEquals(f.old.namespace, state.connection!!.namespace)
        assertEquals(1, f.backend.calls.count { it.method == "POST" }); assertFalse(state.connection.toString().contains(state.connection.token))
    }
    @Test fun lostClaimAckReopensOriginalTokenAndIdWithQueriesOnly() {
        val f = fixture(); f.backend.loseAck = "pair"; fails { f.client.pair(pkg(f)) }; val original = f.disk.load().auth_intent!!; assertTrue(original.uncertain); assertEquals(f.old, f.disk.load().connection)
        val calls = f.backend.calls.size; DeviceClient(f.disk, f.backend, false).reconcile(); assertTrue(f.backend.calls.drop(calls).all { it.method == "GET" }); assertEquals(original.proposed_token, f.disk.load().connection!!.token); assertNull(f.disk.load().auth_intent)
    }
    @Test fun unknownClaim401CannotClearIntentSwitchRootDisconnectOrStartAnotherClaim() {
        val f = fixture(); f.backend.loseAck = "pair"; fails { f.client.pair(pkg(f)) }; val bytes = f.disk.bytes; f.backend.selfFailure = ApiFailure(401, "UNAUTHENTICATED")
        fails { f.client.reconcile() }; assertEquals(bytes, f.disk.bytes); fails { f.ledger.disconnect() }; fails { f.ledger.connect(f.old.copy(base = "https://other.example.test")) }; fails { f.client.pair(pkg(f)) }; fails { f.ledger.respond(event(), event().interaction!!.actions[0], "") }; assertEquals(bytes, f.disk.bytes)
        f.backend.selfFailure = null; val original = f.disk.load().auth_intent!!; f.client.replayOriginal(); assertEquals(listOf(original.body, original.body), f.backend.calls.filter { it.path == "/v1/pairing/claim" }.map { it.body })
    }
    @Test fun failedPrepareOrUncertaintySaveNeverCallsNetwork() {
        for (at in listOf(1, 2)) { val f = fixture(); f.disk.failAt = at; fails { f.client.pair(pkg(f)) }; assertEquals(0, f.backend.calls.size); assertEquals(f.old, f.disk.load().connection) }
    }
    @Test fun failedAdoptionKeepsOriginalPairIntentAndCanReconcileWithoutAnotherPost() {
        val f = fixture(); f.disk.failAt = 3; fails { f.client.pair(pkg(f)) }; val p = f.disk.load().auth_intent!!; assertEquals(f.old, f.disk.load().connection); assertTrue(p.uncertain)
        f.disk.failAt = -1; f.client.reconcile(); assertEquals(p.proposed_token, f.disk.load().connection!!.token); assertEquals(1, f.backend.calls.count { it.method == "POST" })
    }
    @Test fun rotationWithOriginalUnknownPreservesEveryPendingByteNamespaceAndDoesNotRecoverIt() {
        val f = fixture(); val pending = unknown(f); val originalPosts = f.backend.calls.count { it.path.endsWith("/responses") }
        f.client.rotate(); val state = f.disk.load(); assertEquals(pending, state.pending); assertEquals(f.old.namespace, state.connection!!.namespace); assertNotEquals(f.old.token, state.connection.token); assertEquals(2L, state.device!!.credential_version)
        assertEquals(originalPosts, f.backend.calls.count { it.path.endsWith("/responses") }); assertNotEquals(state.connection.namespace, state.connection.copy().namespace)
        f.ledger.recover(); assertNull(f.disk.load().pending); assertEquals(state.connection.token, f.backend.calls.last().c.token)
    }
    @Test fun lostRotationAckUsesOriginalNewTokenAndProofNotOld401OrAutomaticUserResubmit() {
        val f = fixture(); val pending = unknown(f); f.backend.loseAck = "rotate"; fails { f.client.rotate() }; val p = f.disk.load().auth_intent!!; val calls = f.backend.calls.size
        DeviceClient(f.disk, f.backend, false).reconcile(); assertTrue(f.backend.calls.drop(calls).all { it.method == "GET" }); assertEquals(p.proposed_token, f.disk.load().connection!!.token); assertEquals(pending, f.disk.load().pending); assertEquals(f.old.namespace, f.disk.load().connection!!.namespace)
    }
    @Test fun mismatchedRotationProofsNeverAdoptOrClearOriginalUnknown() {
        val edits: List<(CredentialTransition) -> CredentialTransition> = listOf({ it.copy(store_id = UUID.randomUUID().toString()) }, { it.copy(owner_id = "other") }, { it.copy(device_id = "other_device") }, { it.copy(request_id = "other_request") }, { it.copy(previous_credential_hash = "f".repeat(64)) }, { it.copy(replacement_credential_hash = "e".repeat(64)) }, { it.copy(previous_credential_version = 99) }, { it.copy(credential_version = 99) })
        for (edit in edits) { val f = fixture(); val pending = unknown(f); f.backend.loseAck = "rotate"; fails { f.client.rotate() }; val bytes = f.disk.bytes; f.backend.proofEdit = edit; fails { f.client.reconcile() }; assertEquals(bytes, f.disk.bytes); assertEquals(pending, f.disk.load().pending); assertEquals(f.old, f.disk.load().connection) }
    }
    @Test fun differentSavedRootRefusesBeforeAnyProofRequest() {
        val f = fixture(); f.backend.loseAck = "rotate"; fails { f.client.rotate() }; val old = f.disk.load(); f.disk.save(old.copy(auth_intent = old.auth_intent!!.copy(root = "https://other.example.test"))); val count = f.backend.calls.size
        fails { f.client.reconcile() }; assertEquals(count, f.backend.calls.size); assertEquals(f.old, f.disk.load().connection)
    }
    @Test fun successfulPostFollowedByQueryRefusalNeverClearsIdentityIntentAsKnownFailure() {
        val f = fixture(); f.backend.before = { if (it.path == "/v1/device/self" && f.backend.transition != null) throw ApiFailure(422, "INVALID_INPUT") }
        fails { f.client.rotate() }; assertTrue(f.disk.load().auth_intent!!.uncertain); assertEquals(f.old, f.disk.load().connection); assertEquals(2L, f.backend.self.credential_version)
        f.backend.before = null; f.client.reconcile(); assertEquals(2L, f.disk.load().device!!.credential_version)
    }
    @Test fun manualCopyOrDecodedBindingCannotBypassOriginalPendingAndIdenticalCredentialsKeepTrustedBinding() {
        val f = fixture(); val pending = unknown(f); f.client.rotate(); val rotated = f.disk.load().connection!!; f.ledger.connect(rotated.copy()); assertEquals(rotated, f.disk.load().connection)
        val forged = wire.decodeFromString<Connection>("{\"base\":\"${rotated.base}\",\"token\":\"${"c".repeat(64)}\",\"binding_namespace\":\"${rotated.namespace}\"}")
        fails { f.ledger.connect(forged) }; assertEquals(rotated, f.disk.load().connection); assertEquals(pending, f.disk.load().pending)
    }
    @Test fun severalRotationsAndOldSchemaRoundtripKeepOneStableNamespaceAndOriginalPending() {
        val f = fixture(); val legacy = "{\"connection\":{\"base\":\"${f.old.base}\",\"token\":\"${f.old.token}\"}}"; assertEquals(f.old, wire.decodeFromString<LocalState>(legacy).connection)
        val pending = unknown(f); repeat(3) { DeviceClient(f.disk, f.backend, false).rotate(); val reopened = f.disk.load(); assertEquals(f.old.namespace, reopened.connection!!.namespace); assertEquals(pending, reopened.pending) }; assertEquals(4L, f.disk.load().device!!.credential_version)
    }
    @Test fun selfRevokeCannotDropAnOriginalUserUnknownAndConfirmedRevokeKeepsOfflineConnection() {
        val f = fixture(); unknown(f); fails { f.client.revoke() }; assertTrue(f.backend.calls.none { it.path == "/v1/device/revoke" }); assertNotNull(f.disk.load().pending)
        val g = fixture(); g.client.revoke(); assertTrue(g.disk.load().device!!.revoked); assertEquals(g.old, g.disk.load().connection); fails { g.ledger.read(event()) }; g.ledger.disconnect(); assertNull(g.disk.load().connection)
    }
    @Test fun lostSelfRevokeAckUsesOnlyOriginalNarrowFactAndDoesNotTreat401AsSuccess() {
        val f = fixture(); f.backend.loseAck = "revoke"; fails { f.client.revoke() }; val bytes = f.disk.bytes; val original = f.disk.load().auth_intent!!
        f.backend.before = { if (it.path == "/v1/device/self-revocation-receipt") throw ApiFailure(401, "UNAUTHENTICATED") }; fails { f.client.reconcile() }; assertEquals(bytes, f.disk.bytes)
        f.backend.before = null; f.client.reconcile(); assertNull(f.disk.load().auth_intent); assertTrue(f.disk.load().device!!.revoked); assertEquals(original.prior, f.disk.load().connection); assertEquals(1, f.backend.calls.count { it.path == "/v1/device/revoke" })
    }
    @Test fun normalPhoneCannotManageOtherDeviceAndAdminReconcilesExactOtherRevokeWithoutRevokingSelf() {
        val f = fixture(); fails { f.client.revoke("another") }; assertNull(f.disk.load().auth_intent)
        val g = fixture(manager = true); val pending = unknown(g); g.backend.loseAck = "revoke"; fails { g.client.revoke("another") }; g.client.reconcile(); assertFalse(g.disk.load().device!!.revoked); assertEquals(pending, g.disk.load().pending); assertEquals(g.old, g.disk.load().connection)
    }
    @Test fun malformedPackageAndServerJsonNeverEchoCredentialInFailureMessages() {
        val secret = "c".repeat(64)
        try { PairingPackage.parse("{\"secret\":\"$secret\"", false); fail("bad package") } catch (e: IllegalArgumentException) { assertFalse(e.message.orEmpty().contains(secret)) }
        val f = fixture(); val transport = object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String {
            if (path == "/v1/device/self" && f.backend.transition != null) return "{\"token\":\"${f.backend.token}\""
            return f.backend.call(connection, method, path, body)
        } }
        try { DeviceClient(f.disk, transport, false).rotate(); fail("bad reply") } catch (e: IllegalStateException) { assertFalse(e.message.orEmpty().contains(f.backend.token)) }
        assertNotNull(f.disk.load().auth_intent); assertEquals(f.old, f.disk.load().connection); f.client.reconcile(); assertEquals(f.backend.token, f.disk.load().connection!!.token)
    }
    @Test fun knownFirstRefusalMayClearOnlyIdentitySlotButSameRefusalAfterUnknownCannot() {
        val f = fixture(); f.backend.before = { if (it.path == "/v1/pairing/claim") throw ApiFailure(410, "PAIRING_EXPIRED") }; fails { f.client.pair(pkg(f)) }; assertNull(f.disk.load().auth_intent); assertEquals(f.old, f.disk.load().connection)
        val g = fixture(); g.backend.loseAck = "pair"; fails { g.client.pair(pkg(g)) }; val bytes = g.disk.bytes
        g.backend.before = { if (it.path == "/v1/pairing/claim") throw ApiFailure(410, "PAIRING_EXPIRED") }; fails { g.client.replayOriginal() }; assertEquals(bytes, g.disk.bytes)
    }
    @Test fun wrongPairOwnerCapabilityOrAcknowledgedActorNeverAdoptsTheCredential() {
        val edits: List<(ManagedDevice) -> ManagedDevice> = listOf({ it.copy(owner_id = "other") }, { it.copy(manage_devices = true) }, { it.copy(device_id = "other_phone") })
        for (edit in edits) { val f = fixture(); f.backend.before = { if (it.path == "/v1/device/self") f.backend.self = edit(f.backend.self) }; fails { f.client.pair(pkg(f)) }; assertNotNull(f.disk.load().auth_intent); assertEquals(f.old, f.disk.load().connection) }
    }
    @Test fun failedAtomicRotationAdoptionLeavesOriginalPendingAndProposalForQueryOnlyRecovery() {
        val f = fixture(); val pending = unknown(f); f.disk.failAt = f.disk.writes + 3; fails { f.client.rotate() }; val p = f.disk.load().auth_intent!!
        assertEquals(f.old, f.disk.load().connection); assertEquals(pending, f.disk.load().pending); assertTrue(p.uncertain); val posts = f.backend.calls.count { it.method == "POST" }
        f.disk.failAt = -1; DeviceClient(f.disk, f.backend, false).reconcile(); assertEquals(posts, f.backend.calls.count { it.method == "POST" }); assertEquals(pending, f.disk.load().pending); assertEquals(f.old.namespace, f.disk.load().connection!!.namespace)
    }
    @Test fun mismatchedSingleSelfRevocationFactCannotClearUnknownOrGrantGeneralLogin() {
        val f = fixture(); f.backend.loseAck = "revoke"; fails { f.client.revoke() }; val original = f.backend.revoke!!; val bytes = f.disk.bytes
        f.backend.revoke = buildJsonObject { original.forEach { (key, value) -> put(key, if (key == "device_id") JsonPrimitive("other_phone") else value) } }
        fails { f.client.reconcile() }; assertEquals(bytes, f.disk.bytes); assertFalse(f.disk.load().device!!.revoked)
        f.backend.revoke = original; f.client.reconcile(); assertTrue(f.disk.load().device!!.revoked)
    }
    @Test fun staleUiSnapshotsCannotRetargetAnyOldWriteOrIdentityOperationAfterAnotherOwnerSwitchesRoot() {
        val f = fixture(); val expected = ConnectionSnapshot(f.old.namespace); val next = f.old.copy(base = "https://other.example.test"); Ledger(f.disk, f.backend).connect(next); val bytes = f.disk.bytes
        fails { f.ledger.respond(event(), event().interaction!!.actions[0], "", expected) }; fails { f.ledger.read(event(), expected) }; fails { f.ledger.decide(event(), "completed", expected) }; fails { f.ledger.recover(expected) }; fails { f.ledger.disconnect(expected) }; fails { f.ledger.connect(f.old, expected) }
        fails { f.client.rotate(expected) }; fails { f.client.revoke(expected = expected) }; fails { f.client.pair(pkg(f), expected) }; fails { f.client.refreshIdentity(expected) }; fails { f.client.devices(expected) }
        assertEquals(0, f.backend.calls.size); assertEquals(bytes, f.disk.bytes); assertEquals(next, f.disk.load().connection)
    }
    @Test fun staleIdentityOrUserRequestIdsCannotQueryOrReplayAnotherSlotEvenWithinSameNamespace() {
        val f = fixture(); f.backend.loseAck = "rotate"; fails { f.client.rotate() }; val expected = ConnectionSnapshot(f.old.namespace); val bytes = f.disk.bytes; val count = f.backend.calls.size
        fails { f.client.reconcile(expected, "different_intent") }; fails { f.client.replayOriginal(expected, "different_intent") }; assertEquals(count, f.backend.calls.size); assertEquals(bytes, f.disk.bytes)
        val g = fixture(); unknown(g); val user = g.disk.bytes; val calls = g.backend.calls.size; fails { g.ledger.recover(ConnectionSnapshot(g.old.namespace), "different_submission") }; assertEquals(calls, g.backend.calls.size); assertEquals(user, g.disk.bytes)
    }
    @Test fun sameVerifiedNamespaceSnapshotRemainsValidAfterCredentialRotationAndUsesNewCredential() {
        val f = fixture(); val expected = ConnectionSnapshot(f.old.namespace); f.client.rotate(expected); f.ledger.respond(event(), event().interaction!!.actions[0], "", expected)
        assertEquals(f.backend.token, f.backend.calls.last().c.token); assertEquals(expected.namespace, f.backend.calls.last().c.namespace); assertNull(f.disk.load().pending)
    }
    @Test fun defaultMutationSnapshotIsCapturedBeforeWaitingForAnotherOwnersGateNotAfterTheConnectionSwitch() {
        val f = fixture(); val loaded = CountDownLatch(1); val pool = Executors.newSingleThreadExecutor(); lateinit var late: java.util.concurrent.Future<*>
        f.disk.onLoad = { if (Thread.currentThread().name == "late-writer") loaded.countDown() }
        try {
            synchronized(ConnectionGate.monitor) {
                late = pool.submit { Thread.currentThread().name = "late-writer"; f.ledger.respond(event(), event().interaction!!.actions[0], "") }
                assertTrue(loaded.await(5, TimeUnit.SECONDS)); Ledger(f.disk, f.backend).connect(f.old.copy(base = "https://other.example.test"))
            }
            fails { late.get(5, TimeUnit.SECONDS) }; assertEquals(0, f.backend.calls.size); assertEquals("https://other.example.test", f.disk.load().connection!!.base); assertNull(f.disk.load().pending)
        } finally { pool.shutdownNow() }
    }
    @Test fun completeLedgerMutationAndIdentityTransitionAreSerializedAcrossIndependentOwners() {
        val f = fixture(); val entered = CountDownLatch(1); val release = CountDownLatch(1); val rotating = CountDownLatch(1); val pool = Executors.newFixedThreadPool(2)
        f.backend.before = { if (it.path.endsWith("/responses")) { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) } }
        try {
            val first = pool.submit { Ledger(f.disk, f.backend).respond(event(), event().interaction!!.actions[0], "") }; assertTrue(entered.await(5, TimeUnit.SECONDS))
            val second = pool.submit { rotating.countDown(); DeviceClient(f.disk, f.backend, false).rotate() }; assertTrue(rotating.await(5, TimeUnit.SECONDS)); Thread.sleep(100); assertTrue(f.backend.calls.none { it.path == "/v1/device/self" })
            release.countDown(); first.get(5, TimeUnit.SECONDS); second.get(5, TimeUnit.SECONDS); assertNull(f.disk.load().pending); assertEquals(f.old.namespace, f.disk.load().connection!!.namespace); assertEquals(f.backend.token, f.disk.load().connection!!.token)
        } finally { release.countDown(); pool.shutdownNow() }
    }
}
