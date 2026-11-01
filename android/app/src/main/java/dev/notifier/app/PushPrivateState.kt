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

class PushPrivateState(context: Context) : PushVault {
    private val file = AtomicFile(File(context.noBackupFilesDir, "push.enc"))
    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey("notifier-push-state", null) as? SecretKey)?.let { return it }
        check(!file.baseFile.exists()) { "推送密钥不可用，不能静默重置重复提醒记录" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("notifier-push-state", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun load(): PushDatabase {
        if (!file.baseFile.exists() && !File(file.baseFile.path + ".bak").exists()) return PushDatabase()
        val bytes = file.openRead().use { input ->
            val out = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
            while (out.size() <= 8_388_608) { val count = input.read(buffer, 0, minOf(buffer.size, 8_388_609 - out.size())); if (count < 0) break; out.write(buffer, 0, count) }
            out.toByteArray()
        }
        check(bytes.size in 29..8_388_608) { "推送账本超限或损坏，停止新的系统提醒" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return wire.decodeFromString(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8))
    }
    override fun save(state: PushDatabase) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        val bytes = cipher.iv + cipher.doFinal(wire.encodeToString(PushDatabase.serializer(), state).toByteArray(Charsets.UTF_8))
        check(bytes.size <= 8_388_608) { "推送账本已满，暂停新提醒；不清未知记录" }
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) } catch (e: Exception) { file.failWrite(output); throw e }
    }
}
