package dev.notifier.app

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Same existing connection.enc format/key, with bounded default-compatible workspace fields. */
object LocalStateCipher {
    fun encrypt(state: LocalState, key: SecretKey): ByteArray {
        val plain = checkedLocalBytes(state)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        return cipher.iv + cipher.doFinal(plain)
    }
    fun decrypt(bytes: ByteArray, key: SecretKey): LocalState {
        check(bytes.size in 29..MAX_LOCAL_STATE_BYTES) { "本机状态损坏，停止新提交" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        val plain = cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
        return try { wire.decodeFromString<LocalState>(plain).also(::validateWorkspace) }
        catch (_: Exception) { throw IllegalStateException("本机安全状态结构不可读，原文件保留，不能自动重置") }
    }
}
