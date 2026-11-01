package dev.notifier.app

import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal object ConnectionGate { val monitor = Any() }
/** Captured at the caller's intent boundary, not after waiting for another owner's IO. */
data class ConnectionSnapshot(val namespace: String?)
internal fun checkConnectionSnapshot(state: LocalState, expected: ConnectionSnapshot) {
    check(state.connection?.namespace == expected.namespace) { "连接已由另一实例改变，旧操作未发送；请重新核对当前界面" }
}
internal val deviceIdPattern = Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}")
internal val credentialPattern = Regex("[a-f0-9]{64}")
internal val storeIdPattern = Regex("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
internal fun credentialDigest(value: String): String = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
internal fun newDeviceToken(): String = ByteArray(32).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

@Serializable data class ManagedDevice(
    val store_id: String, val device_id: String, val owner_id: String, val label: String,
    val manage_devices: Boolean, val credential_version: Long, val revoked: Boolean = false
) {
    fun validate(): ManagedDevice {
        require(storeIdPattern.matches(store_id) && deviceIdPattern.matches(device_id) && deviceIdPattern.matches(owner_id) && label.isNotBlank() && label.codePointCount(0, label.length) <= 80 && !label.any { it.code < 32 || it.code == 127 } && credential_version in 1..9_007_199_254_740_991L) { "设备身份格式不匹配" }
        return this
    }
}
@Serializable data class CredentialTransition(
    val store_id: String, val request_id: String, val device_id: String, val owner_id: String,
    val previous_credential_hash: String, val replacement_credential_hash: String,
    val previous_credential_version: Long, val credential_version: Long
)
@Serializable data class DeviceEntry(
    val device_id: String, val owner_id: String, val label: String, val manage_devices: Boolean,
    val state: String, val credential_version: Long, val created_at: Long
)
@Serializable data class DeviceList(val items: List<DeviceEntry>)

@Serializable data class PairingPackage(
    val notifier_pairing: Int, val base: String, val store_id: String, val invitation_id: String,
    val secret: String, val expires_at: Long, val owner_id: String, val label: String, val manage_devices: Boolean
) {
    override fun toString(): String = "PairingPackage(base=$base, invitation=$invitation_id, secret=REDACTED)"
    companion object {
        fun parse(text: String, debug: Boolean): PairingPackage = try { parseChecked(text, debug) }
        catch (_: Exception) { throw IllegalArgumentException("配对包格式或范围不受支持，请核对原包；未联网或更换身份") }
        private fun parseChecked(text: String, debug: Boolean): PairingPackage {
            require(text.toByteArray(Charsets.UTF_8).size <= 8192) { "配对包超过 8192 字节" }
            val value = wire.parseToJsonElement(text).jsonObject
            require(value.keys == setOf("notifier_pairing", "base", "store_id", "invitation_id", "secret", "expires_at", "owner_id", "label", "manage_devices")) { "配对包版本或字段不受支持" }
            val strings = listOf("base", "store_id", "invitation_id", "secret", "owner_id", "label")
            require(strings.all { value[it] is JsonPrimitive && value[it]!!.jsonPrimitive.isString }) { "配对包文字字段格式错误" }
            require(value["notifier_pairing"]?.jsonPrimitive?.let { !it.isString && it.intOrNull == 1 } == true && value["expires_at"]?.jsonPrimitive?.let { !it.isString && it.longOrNull?.let { number -> number in 0..9_007_199_254_740_991L } == true } == true && value["manage_devices"]?.jsonPrimitive?.let { !it.isString && it.booleanOrNull != null } == true) { "配对包版本、到期或能力格式错误" }
            val result = wire.decodeFromString<PairingPackage>(text)
            require(result.notifier_pairing == 1 && storeIdPattern.matches(result.store_id) && deviceIdPattern.matches(result.invitation_id) && credentialPattern.matches(result.secret) && deviceIdPattern.matches(result.owner_id)) { "配对包身份格式错误" }
            ManagedDevice(result.store_id, result.invitation_id, result.owner_id, result.label, result.manage_devices, 1).validate()
            val root = Connection.parse(result.base, "0".repeat(64), debug)
            val uri = URI(root.base)
            val port = if (uri.scheme == "https" && uri.port == 443 || uri.scheme == "http" && uri.port == 80) -1 else uri.port
            val canonical = URI(uri.scheme, null, uri.host.lowercase(Locale.ROOT), port, null, null, null).toASCIIString()
            require(result.base == canonical) { "配对包须使用规范服务根地址，不含路径或默认端口" }
            return result
        }
    }
}

@Serializable data class AuthIntent(
    val kind: String, val id: String, val root: String, val body: String,
    val proposed_token: String? = null, val prior: Connection? = null, val before: ManagedDevice? = null,
    val pairing: PairingPackage? = null, val target_device: String? = null, val uncertain: Boolean = false
) {
    override fun toString(): String = "AuthIntent(kind=$kind, id=$id, root=$root, credentials=REDACTED)"
}
data class AuthSummary(val kind: String, val id: String, val root: String, val target: String?)
