package dev.notifier.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class PrivateInbox(context: Context) : InboxVault {
    companion object { private val lock = Any() }
    private val file = AtomicFile(File(context.noBackupFilesDir, "inbox.enc"))
    private fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("notifier-inbox", null) as? SecretKey)?.let { return it }
        check(!exists()) { "离线内容密钥不可用，原缓存保留；不能自动重置" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("notifier-inbox", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun load(): InboxCache = synchronized(lock) {
        try {
        if (!exists()) return@synchronized InboxCache()
        val bytes = file.openRead().use { input ->
            val output = java.io.ByteArrayOutputStream(); val chunk = ByteArray(8192)
            while (output.size() <= MAX_CACHE_BYTES) {
                val n = input.read(chunk, 0, minOf(chunk.size, MAX_CACHE_BYTES + 1 - output.size()))
                if (n < 0) break
                output.write(chunk, 0, n)
            }
            output.toByteArray()
        }
        InboxCipher.decrypt(bytes, key())
        } catch (e: Exception) { throw InboxCacheReadFailure(e) }
    }
    override fun save(cache: InboxCache) = synchronized(lock) {
        val bytes = InboxCipher.encrypt(cache, key())
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) }
        catch (e: Exception) { file.failWrite(output); throw e }
    }
}
