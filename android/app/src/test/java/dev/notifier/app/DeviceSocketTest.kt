package dev.notifier.app

import java.io.File
import java.io.IOException
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeNotNull
import org.junit.Test

/** Actual loopback HTTP against the real SQLite device/event service. Not emulator/Keystore evidence. */
class DeviceSocketTest {
    private class Disk(initial: LocalState = LocalState()) : StateStore {
        var bytes = wire.encodeToString(LocalState.serializer(), initial)
        override fun load(): LocalState = wire.decodeFromString(bytes)
        override fun save(state: LocalState) { bytes = wire.encodeToString(LocalState.serializer(), state) }
    }
    private fun packages(): List<PairingPackage> {
        val path = System.getenv("NOTIFIER_TEST_PAIRING"); assumeNotNull(path)
        return wire.parseToJsonElement(File(path!!).readText()).jsonObject["packages"]!!.jsonArray.map { PairingPackage.parse(it.toString(), true) }
    }
    private fun source(base: String): Connection {
        val path = System.getenv("NOTIFIER_TEST_AUTH"); assumeNotNull(path)
        val row = wire.parseToJsonElement(File(path!!).readText()).jsonObject["principals"]!!.jsonArray.first { it.jsonObject["kind"]!!.jsonPrimitive.content == "source" }.jsonObject
        return Connection.parse(base, row["token"]!!.jsonPrimitive.content, true)
    }
    private fun event(http: HttpTransport, source: Connection): String {
        val body = buildJsonObject {
            put("request_id", UUID.randomUUID().toString()); put("title", "Device socket contract"); put("body", "原提交🙂")
            put("session_ref", "device_contract"); put("target_revision", "r1"); put("expires_at", "2099-01-01T00:00:00Z")
            put("interaction", buildJsonObject { put("id", "question"); put("actions", buildJsonArray { add(buildJsonObject { put("id", "go"); put("label", "Continue"); put("type", "button") }) }) })
        }.toString()
        return wire.parseToJsonElement(http.call(source, "POST", "/v1/events", body)).jsonObject["event_id"]!!.jsonPrimitive.content
    }
    private fun lost(http: HttpTransport, selected: String): Transport = object : Transport {
        override fun call(connection: Connection, method: String, path: String, body: String?): String {
            val value = http.call(connection, method, path, body)
            if (method == "POST" && path == selected) throw IOException("discard actual committed ACK before client accepts it")
            return value
        }
    }
    @Test fun actualPairAndRotationKeepOriginalUnknownResponseCacheAndStableNamespaceThenExplicitlyQueryIt() {
        val pkg = packages()[0]; val http = HttpTransport(); val disk = Disk(); DeviceClient(disk, http, true).pair(pkg); val original = disk.load().connection!!
        val id = event(http, source(pkg.base)); val current = Ledger(disk, http).event(id)
        var cache = InboxCache(); val vault = object : InboxVault { override fun load() = cache; override fun save(value: InboxCache) { cache = value } }
        OfflineInbox(Ledger(disk, http), vault).refresh(); val cached = cache
        try { Ledger(disk, lost(http, "/v1/events/$id/responses")).respond(current, current.interaction!!.actions[0], ""); fail("Expected discarded actual response ACK") } catch (_: IOException) {}
        val pending = disk.load().pending!!; val calls = mutableListOf<String>()
        val observed = object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { calls += "$method $path"; return http.call(connection, method, path, body) } }
        DeviceClient(disk, observed, true).rotate(); val next = disk.load().connection!!
        assertEquals(original.namespace, next.namespace); assertNotEquals(original.token, next.token); assertEquals(pending, disk.load().pending); assertEquals(cached, cache); assertTrue(calls.none { it.contains("/events/") || it.contains("/responses/") })
        Ledger(disk, http).recover(); assertNull(disk.load().pending); assertEquals(pending.id, Ledger(disk, http).event(id).reserved_response_id); assertEquals(1, Ledger(disk, http).history(id).items.count { it.kind == "response_saved" })
        try { http.call(original, "GET", "/v1/device/self"); fail("old token must reject") } catch (failure: ApiFailure) { assertEquals(401, failure.status) }
    }
    @Test fun actualClaimLostClientAckReopensSameIntentAndReconcilesWithoutAnotherPost() {
        val pkg = packages()[1]; val http = HttpTransport(); val disk = Disk()
        try { DeviceClient(disk, lost(http, "/v1/pairing/claim"), true).pair(pkg); fail("Expected discarded claim ACK") } catch (_: IOException) {}
        val pending = disk.load().auth_intent!!; val calls = mutableListOf<String>(); val observed = object : Transport { override fun call(connection: Connection, method: String, path: String, body: String?): String { calls += method; return http.call(connection, method, path, body) } }
        DeviceClient(disk, observed, true).reconcile(); assertNull(disk.load().auth_intent); assertEquals(pending.proposed_token, disk.load().connection!!.token); assertTrue(calls.all { it == "GET" }); assertEquals(1L, disk.load().device!!.credential_version)
        val list = DeviceClient(disk, http, true).devices(); assertEquals(1, list.count { it.device_id == disk.load().device!!.device_id })
    }
    @Test fun actualSelfRevokeLostClientAckKeepsUnknownAfter401AndOnlyNarrowFactSettlesIt() {
        val pkg = packages()[2]; val http = HttpTransport(); val disk = Disk(); DeviceClient(disk, http, true).pair(pkg); val original = disk.load().connection!!
        try { DeviceClient(disk, lost(http, "/v1/device/revoke"), true).revoke(); fail("Expected discarded revoke ACK") } catch (_: IOException) {}
        val bytes = disk.bytes
        try { http.call(original, "GET", "/v1/device/self"); fail("revoked token cannot login") } catch (failure: ApiFailure) { assertEquals(401, failure.status) }
        assertEquals(bytes, disk.bytes); assertNotNull(disk.load().auth_intent)
        DeviceClient(disk, http, true).reconcile(); assertNull(disk.load().auth_intent); assertTrue(disk.load().device!!.revoked); assertEquals(original, disk.load().connection)
    }
    @Test fun actualOwnerAdminReconcilesOriginalOtherDeviceRevokeWithoutTakingItsCredentialOrRevokingSelf() {
        val all = packages(); val http = HttpTransport(); val admin = Disk(); val peer = Disk(); DeviceClient(admin, http, true).pair(all[3]); DeviceClient(peer, http, true).pair(all[4]); val target = peer.load().device!!.device_id
        try { DeviceClient(admin, lost(http, "/v1/device/revoke"), true).revoke(target); fail("Expected discarded admin ACK") } catch (_: IOException) {}
        DeviceClient(admin, http, true).reconcile(); assertFalse(admin.load().device!!.revoked); assertNull(admin.load().auth_intent); assertEquals(1L, admin.load().device!!.credential_version)
        try { http.call(peer.load().connection!!, "GET", "/v1/device/self"); fail("peer must reject") } catch (failure: ApiFailure) { assertEquals(401, failure.status) }
        assertEquals(1, DeviceClient(admin, http, true).devices().count { it.device_id == target && it.state == "revoked" })
    }
}
