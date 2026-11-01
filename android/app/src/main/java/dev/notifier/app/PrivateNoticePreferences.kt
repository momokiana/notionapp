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

object NoticeCipher {
    const val LIMIT = 131072
    fun encode(value: NoticePreferences, key: SecretKey): ByteArray {
        value.validate()
        val plain = wire.encodeToString(NoticePreferences.serializer(), value).toByteArray(Charsets.UTF_8)
        require(plain.size <= LIMIT - 28) { "本机通知偏好容量不足，原设置保留" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        return cipher.iv + cipher.doFinal(plain)
    }
    fun decode(bytes: ByteArray, key: SecretKey): NoticePreferences {
        require(bytes.size in 29..LIMIT)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
        return wire.decodeFromString<NoticePreferences>(cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)).also { it.validate() }
    }
}

class PrivateNoticePreferences(context: Context) : NoticeVault {
    private val file = AtomicFile(File(context.applicationContext.noBackupFilesDir, "notification-preferences.enc"))
    private fun exists() = file.baseFile.exists() || File(file.baseFile.path + ".bak").exists()
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("notifier-notice-preferences", null) as? SecretKey)?.let { return it }
        check(!exists()) { "通知偏好密钥不可用，不能静默重置" }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("notifier-notice-preferences", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    override fun load(): NoticePreferences = synchronized(NoticeGate.monitor) {
        try {
            if (!exists()) return@synchronized NoticePreferences()
            val bytes = file.openRead().use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(4096)
                while (output.size() <= NoticeCipher.LIMIT) {
                    val n = input.read(buffer, 0, minOf(buffer.size, NoticeCipher.LIMIT + 1 - output.size()))
                    if (n < 0) break
                    output.write(buffer, 0, n)
                }
                output.toByteArray()
            }
            NoticeCipher.decode(bytes, key())
        } catch (e: Exception) { throw IllegalStateException("本机通知偏好不可读，暂停新提醒；原文件与收件/交付记录保留。", e) }
    }
    override fun save(value: NoticePreferences) = synchronized(NoticeGate.monitor) {
        val bytes = NoticeCipher.encode(value, key())
        val output = file.startWrite()
        try { output.write(bytes); file.finishWrite(output) } catch (e: Exception) { file.failWrite(output); throw e }
    }
}
