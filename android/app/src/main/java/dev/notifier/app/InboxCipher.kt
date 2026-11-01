package dev.notifier.app

import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Shared by Android storage and JVM fault/tamper tests; credentials never enter this format. */
object InboxCipher {
    fun encrypt(cache: InboxCache, key: SecretKey): ByteArray {
        OfflineInbox.validate(cache)
        val plain = wire.encodeToString(InboxCache.serializer(), cache).toByteArray(Charsets.UTF_8)
        check(plain.size <= MAX_CACHE_BYTES - 28) { "本机内容缓存已满，原缓存保留" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        return cipher.iv + cipher.doFinal(plain)
    }
    fun decrypt(bytes: ByteArray, key: SecretKey): InboxCache {
        check(bytes.size in 29..MAX_CACHE_BYTES) { "本机内容缓存损坏或超限" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        val result = wire.decodeFromString<InboxCache>(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8))
        OfflineInbox.validate(result); return result
    }
}
