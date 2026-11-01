package dev.notifier.app

import java.util.UUID
import kotlinx.serialization.json.*

/** One identity intent, sharing the complete mutation gate with every Ledger owner. No automatic write recovery. */
class DeviceClient(private val storage: StateStore, private val transport: Transport, private val debug: Boolean) {
    private inline fun <reified T> decode(raw: String): T = try { wire.decodeFromString<T>(raw) } catch (_: Exception) { error("设备回执结构不匹配，原意图保留，凭据不回显") }
    private fun record(raw: String): JsonObject = try { wire.parseToJsonElement(raw).jsonObject } catch (_: Exception) { error("设备回执结构不匹配，原意图保留，凭据不回显") }
    private fun connection(state: LocalState): Connection = state.connection ?: error("请先设置连接")
    private fun checkedSelf(connection: Connection): ManagedDevice = decode<ManagedDevice>(transport.call(connection, "GET", "/v1/device/self")).validate().also { check(!it.revoked) { "当前设备已撤销" } }
    private fun sameIdentity(a: ManagedDevice, b: ManagedDevice): Boolean = a.store_id == b.store_id && a.device_id == b.device_id && a.owner_id == b.owner_id && a.credential_version == b.credential_version
    private fun current(state: LocalState): ManagedDevice {
        check(state.device?.revoked != true) { "此本机连接已确认撤销；可离线阅读，不能恢复通用认证" }
        val result = checkedSelf(connection(state))
        state.device?.let { check(sameIdentity(it, result)) { "当前凭据身份或版本改变，不能猜测继承原连接" } }
        return result
    }
    fun refreshIdentity(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)): ManagedDevice = synchronized(ConnectionGate.monitor) {
        val old = storage.load(); checkConnectionSnapshot(old, expected); check(old.auth_intent == null) { "请先对账原身份操作" }
        val result = current(old); storage.save(old.copy(device = result)); result
    }
    fun devices(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)): List<DeviceEntry> = synchronized(ConnectionGate.monitor) {
        val state = storage.load(); checkConnectionSnapshot(state, expected); check(state.auth_intent == null) { "请先对账原身份操作" }
        val self = current(state)
        val list = decode<DeviceList>(transport.call(connection(state), "GET", "/v1/devices")).items
        require(list.size <= 1000 && list.map { it.device_id }.distinct().size == list.size) { "设备列表超限或重复" }
        list.forEach {
            ManagedDevice(self.store_id, it.device_id, it.owner_id, it.label, it.manage_devices, it.credential_version).validate()
            require(it.owner_id == self.owner_id && it.state in setOf("active", "revoked", "handover_pending")) { "设备列表归属或状态不匹配" }
        }
        storage.save(state.copy(device = self))
        list
    }
    fun pair(pkg: PairingPackage, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(storage.load(), expected)
        val verified = PairingPackage.parse(wire.encodeToString(PairingPackage.serializer(), pkg), debug)
        val old = storage.load(); check(old.pending == null && old.auth_intent == null) { "有原未决提交或配对，不能切换身份/服务" }
        require(verified.expires_at > System.currentTimeMillis()) { "新配对包已过期；原未知配对请使用对账，不换包" }
        val id = UUID.randomUUID().toString(); val proposed = newDeviceToken()
        val body = buildJsonObject { put("store_id", verified.store_id); put("claim_id", id); put("invitation_id", verified.invitation_id); put("secret", verified.secret); put("proposed_token", proposed) }.toString()
        val intent = AuthIntent("pair", id, verified.base, body, proposed_token = proposed, prior = old.connection, pairing = verified)
        storage.save(old.copy(auth_intent = intent)); send(intent, true)
    }
    fun rotate(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        val old = storage.load(); checkConnectionSnapshot(old, expected); check(old.auth_intent == null) { "请先对账原身份操作" }
        val before = current(old); val id = UUID.randomUUID().toString(); val replacement = newDeviceToken()
        val body = buildJsonObject { put("request_id", id); put("replacement_token", replacement) }.toString()
        val intent = AuthIntent("rotate", id, connection(old).base, body, proposed_token = replacement, prior = connection(old), before = before)
        storage.save(old.copy(device = before, auth_intent = intent)); send(intent, true)
    }
    fun revoke(target: String? = null, expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace)) = synchronized(ConnectionGate.monitor) {
        val old = storage.load(); checkConnectionSnapshot(old, expected); check(old.auth_intent == null) { "请先对账原身份操作" }
        val before = current(old); val device = target ?: before.device_id
        require(deviceIdPattern.matches(device))
        check(device == before.device_id || before.manage_devices) { "没有撤销其他设备的管理能力" }
        check(device != before.device_id || old.pending == null) { "有原未决提交，不能自撤销或清空连接" }
        val id = UUID.randomUUID().toString(); val body = buildJsonObject { put("request_id", id); put("device_id", device) }.toString()
        val intent = AuthIntent("revoke", id, connection(old).base, body, prior = connection(old), before = before, target_device = device)
        storage.save(old.copy(device = before, auth_intent = intent)); send(intent, true)
    }
    fun summary(): AuthSummary? = synchronized(ConnectionGate.monitor) { storage.load().auth_intent?.let { AuthSummary(it.kind, it.id, it.root, it.target_device) } }
    private fun text(value: JsonElement?, expected: String): Boolean = value is JsonPrimitive && value.isString && value.content == expected
    private fun intent(): AuthIntent {
        val old = storage.load(); val p = old.auth_intent ?: error("没有原身份操作需要对账")
        require(deviceIdPattern.matches(p.id) && p.body.toByteArray(Charsets.UTF_8).size <= 32768 && old.connection == p.prior) { "原身份意图或连接不匹配，停止并保留" }
        val body = record(p.body)
        when (p.kind) {
            "pair" -> {
                val pkg = p.pairing ?: error("原配对包缺失，不能生成替代身份")
                PairingPackage.parse(wire.encodeToString(PairingPackage.serializer(), pkg), debug)
                require(old.pending == null && p.root == pkg.base && p.proposed_token?.let { credentialPattern.matches(it) } == true && body.keys == setOf("store_id", "claim_id", "invitation_id", "secret", "proposed_token") && text(body["store_id"], pkg.store_id) && text(body["claim_id"], p.id) && text(body["invitation_id"], pkg.invitation_id) && text(body["secret"], pkg.secret) && text(body["proposed_token"], p.proposed_token!!)) { "原配对正文关联不匹配" }
            }
            "rotate", "revoke" -> {
                val before = p.before?.validate() ?: error("原设备身份缺失")
                require(!before.revoked && old.device?.let { sameIdentity(it, before) } == true && p.root == p.prior?.base && text(body["request_id"], p.id)) { "原设备操作关联不匹配" }
                if (p.kind == "rotate") require(p.proposed_token?.let { credentialPattern.matches(it) && it != p.prior!!.token } == true && body.keys == setOf("request_id", "replacement_token") && text(body["replacement_token"], p.proposed_token!!)) { "原轮换正文不匹配" }
                else require(p.target_device?.let { deviceIdPattern.matches(it) } == true && body.keys == setOf("request_id", "device_id") && text(body["device_id"], p.target_device!!) && (p.target_device != before.device_id || old.pending == null)) { "原撤销目标或未决槽不匹配" }
            }
            else -> error("未知身份意图类型，原状态不能自动清空")
        }
        return p
    }
    private fun proposed(p: AuthIntent): Connection = Connection.parse(p.root, p.proposed_token ?: error("原提议凭据缺失"), debug)
    private fun send(original: AuthIntent, first: Boolean) {
        val p = intent(); check(p == original) { "原身份操作已改变" }
        storage.save(storage.load().copy(auth_intent = p.copy(uncertain = true)))
        var postCompleted = false
        try {
            val path = when (p.kind) { "pair" -> "/v1/pairing/claim"; "rotate" -> "/v1/device/rotate"; else -> "/v1/device/revoke" }
            val raw = transport.call(if (p.kind == "pair") proposed(p) else p.prior!!, "POST", path, p.body)
            postCompleted = true
            val response = record(raw)
            val idKey = if (p.kind == "pair") "claim_id" else "request_id"
            check(text(response[idKey], p.id)) { "身份回执ID不匹配，保留原意图" }
            if (p.kind == "pair") {
                check(text(response["store_id"], p.pairing!!.store_id) && response["device_id"] is JsonPrimitive && response["device_id"]!!.jsonPrimitive.isString) { "配对回执关联不匹配" }
                finishPair(p, response["device_id"]!!.jsonPrimitive.content)
            } else if (p.kind == "rotate") {
                check(text(response["device_id"], p.before!!.device_id)) { "轮换回执目标不匹配" }; finishRotation(p)
            } else finishRevocation(p, response)
        } catch (e: ApiFailure) {
            val refusal = when (p.kind) {
                "pair" -> setOf("PAIRING_EXPIRED", "PAIRING_REVOKED", "PAIRING_ALREADY_USED", "DEVICE_STORE_MISMATCH", "INVALID_INPUT", "CREDENTIAL_ALREADY_KNOWN")
                "rotate" -> setOf("CREDENTIAL_ALREADY_KNOWN", "INVALID_INPUT")
                else -> setOf("FORBIDDEN", "NOT_FOUND", "INVALID_INPUT")
            }
            if (!postCompleted && first && !p.uncertain && e.status in listOf(403, 404, 409, 410, 422) && e.code in refusal) storage.save(storage.load().copy(auth_intent = null))
            throw e
        }
    }
    private fun finishPair(p: AuthIntent, acknowledgedDevice: String? = null) {
        val c = proposed(p); val self = checkedSelf(c); val pkg = p.pairing!!
        require(self.store_id == pkg.store_id && self.owner_id == pkg.owner_id && self.manage_devices == pkg.manage_devices && self.credential_version == 1L && (acknowledgedDevice == null || self.device_id == acknowledgedDevice)) { "配对范围或设备不匹配，保留原意图" }
        val fact = record(transport.call(c, "GET", "/v1/device/claims/${p.id}"))
        check(text(fact["claim_id"], p.id) && text(fact["device_id"], self.device_id) && text(fact["store_id"], self.store_id)) { "原配对事实不匹配" }
        val old = storage.load(); check(old.auth_intent?.id == p.id && old.auth_intent.body == p.body && old.connection == p.prior && old.pending == null) { "原配对状态已改变" }
        storage.save(old.copy(connection = c, device = self, auth_intent = null))
    }
    private fun finishRotation(p: AuthIntent) {
        val c = proposed(p); val self = checkedSelf(c)
        val proof = decode<CredentialTransition>(transport.call(c, "GET", "/v1/device/transitions/${p.id}"))
        val next = Connection.afterVerifiedRotation(p.prior!!, c.token, p.before!!, self, p.id, proof)
        val old = storage.load(); check(old.auth_intent?.id == p.id && old.auth_intent.body == p.body && old.connection == p.prior) { "原轮换状态已改变" }
        check(old.pending == null || old.pending.namespace == p.prior.namespace) { "原提交namespace不匹配，不能迁移" }
        // One encrypted AtomicFile write: exact original user ID/body/path/uncertain stays untouched.
        storage.save(old.copy(connection = next, device = self, auth_intent = null))
    }
    private fun finishRevocation(p: AuthIntent, fact: JsonObject) {
        check(text(fact["request_id"], p.id) && text(fact["device_id"], p.target_device!!) && fact["revoked"]?.jsonPrimitive?.let { !it.isString && it.booleanOrNull == true } == true) { "原撤销事实不匹配，保留原意图" }
        check(fact["owner_id"] == null || text(fact["owner_id"], p.before!!.owner_id)) { "原撤销所有者不匹配" }
        val old = storage.load(); check(old.auth_intent?.id == p.id && old.auth_intent.body == p.body && old.connection == p.prior) { "原撤销状态已改变" }
        val self = p.target_device == p.before!!.device_id
        check(!self || old.pending == null) { "存在原提交，不能清除或隐式自撤销" }
        storage.save(old.copy(auth_intent = null, device = if (self) p.before.copy(revoked = true) else old.device))
    }
    /** Explicit readonly facts; the narrow self-revocation endpoint uses POST but performs no action. */
    fun reconcile(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace), expectedId: String? = storage.load().auth_intent?.id) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(storage.load(), expected)
        val p = intent(); check(p.id == expectedId) { "原身份操作已改变，不能查询另一个意图" }
        when (p.kind) {
            "pair" -> finishPair(p)
            "rotate" -> finishRotation(p)
            else -> {
                val self = p.target_device == p.before!!.device_id
                val fact = record(if (self) transport.call(p.prior!!, "POST", "/v1/device/self-revocation-receipt", p.body) else transport.call(p.prior!!, "GET", "/v1/device/revocations/${p.id}"))
                finishRevocation(p, fact)
            }
        }
    }
    /** User explicitly chooses an idempotent replay of the SAME persisted operation, never new IDs/tokens. */
    fun replayOriginal(expected: ConnectionSnapshot = ConnectionSnapshot(storage.load().connection?.namespace), expectedId: String? = storage.load().auth_intent?.id) = synchronized(ConnectionGate.monitor) {
        checkConnectionSnapshot(storage.load(), expected)
        val p = intent(); check(p.id == expectedId) { "原身份操作已改变，不能重放另一个意图" }
        send(p, false)
    }
}
