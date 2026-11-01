package dev.notifier.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

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
        check(bytes.size in 29..131072) { "本机状态损坏，停止新提交" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
        val plain = cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
        try { wire.decodeFromString<LocalState>(plain) }
        catch (_: Exception) { throw IllegalStateException("本机安全状态结构不可读，原文件保留，不能自动重置") }
    }
    override fun save(state: LocalState) = synchronized(lock) {
        val plain = wire.encodeToString(LocalState.serializer(), state).toByteArray(Charsets.UTF_8)
        check(plain.size <= 131044) { "本机原子状态达到容量上限，原状态保留" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val encrypted = cipher.iv + cipher.doFinal(plain)
        val output = file.startWrite()
        try { output.write(encrypted); file.finishWrite(output) }
        catch (e: Exception) { file.failWrite(output); throw e }
    }
}
