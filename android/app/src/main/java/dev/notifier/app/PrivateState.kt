package dev.notifier.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class PrivateState(context: Context) : StateStore {
    companion object { private val lock = Any() }
    private val file = AtomicFile(File(context.noBackupFilesDir, "connection.enc"))
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("notifier-local-state", null) as? SecretKey)?.let { return it }
        check(!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) { "安全密钥不可用，原提交状态不能自动清空" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("notifier-local-state", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun load(): LocalState = synchronized(lock) {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return@synchronized LocalState()
        val bytes = file.openRead().use { input ->
            val output = java.io.ByteArrayOutputStream(); val chunk = ByteArray(8192)
            while (output.size() < 131073) {
                val count = input.read(chunk, 0, minOf(chunk.size, 131073 - output.size()))
                if (count < 0) break
                output.write(chunk, 0, count)
            }
            output.toByteArray()
        }
        LocalStateCipher.decrypt(bytes, key())
    }
    override fun save(state: LocalState) = synchronized(lock) {
        val encrypted = LocalStateCipher.encrypt(state, key())
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) }
        catch (e: Exception) { file.failWrite(output); throw e }
    }
}
