package dev.notifier.xiaoaixiaoai.bridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Lets the installer read the downloaded APK through a content:// URI. */
class UpdateFileProvider : FileProvider()

/**
 * In-app update: downloads a release APK into the app's cache and hands it to the system
 * installer. Android itself refuses an APK signed by a different key, so only checks that
 * cost little are done here: size, SHA-256 from the release's SHA256SUMS (the file may have
 * come through a mirror) and package name.
 */
object Updater {
  private val client = OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS)
    .readTimeout(60, TimeUnit.SECONDS)
    .build()

  @Volatile private var call: Call? = null

  private fun dir(context: Context) = File(context.cacheDir, "updates").apply { mkdirs() }

  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

  private fun sha256Of(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buf = ByteArray(64 * 1024)
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        md.update(buf, 0, n)
      }
    }
    return hex(md.digest())
  }

  /** Blocking; call off the main thread. Returns the APK's path. `sha256`: "" when unknown. */
  fun download(context: Context, url: String, name: String, size: Long, sha256: String, progress: (Long, Long) -> Unit): String {
    val want = sha256.lowercase()
    require(name.matches(Regex("^[A-Za-z0-9._-]+\\.apk$"))) { "bad file name" }
    val dir = dir(context)
    // Only the newest download is kept.
    dir.listFiles()?.forEach { if (it.name != name && it.name != "$name.part") it.delete() }
    val target = File(dir, name)
    if (target.exists() && (size <= 0 || target.length() == size) && (want.isEmpty() || sha256Of(target) == want) && isThisApp(context, target)) {
      return target.absolutePath
    }
    val part = File(dir, "$name.part")
    part.delete()

    val c = client.newCall(Request.Builder().url(url).header("Accept", "application/octet-stream").build())
    call = c
    val md = MessageDigest.getInstance("SHA-256")
    try {
      c.execute().use { res ->
        if (!res.isSuccessful) throw IOException("HTTP ${res.code}")
        val body = res.body ?: throw IOException("empty response")
        val total = body.contentLength().takeIf { it > 0 } ?: size
        body.byteStream().use { input ->
          part.outputStream().use { out ->
            val buf = ByteArray(64 * 1024)
            var got = 0L
            var shown = 0L
            while (true) {
              val n = input.read(buf)
              if (n < 0) break
              out.write(buf, 0, n)
              md.update(buf, 0, n)
              got += n
              if (got - shown >= 256 * 1024) {
                shown = got
                progress(got, total)
              }
            }
            progress(got, total)
          }
        }
      }
    } finally {
      call = null
    }
    if (size > 0 && part.length() != size) {
      part.delete()
      throw IOException("download incomplete")
    }
    if (want.isNotEmpty() && hex(md.digest()) != want) {
      part.delete()
      throw IOException("checksum mismatch")
    }
    if (!isThisApp(context, part)) {
      part.delete()
      throw IOException("not an update of this app")
    }
    target.delete()
    if (!part.renameTo(target)) throw IOException("cannot save the download")
    return target.absolutePath
  }

  fun cancel() {
    call?.cancel()
  }

  private fun isThisApp(context: Context, apk: File): Boolean {
    val info = context.packageManager.getPackageArchiveInfo(apk.path, 0)
    return info?.packageName == context.packageName
  }

  fun installedVersion(context: Context): String? =
    try {
      context.packageManager.getPackageInfo(context.packageName, 0).versionName
    } catch (_: Throwable) {
      null
    }

  /**
   * "started": the system installer is open. "permission": the person first has to allow
   * this app to install apps; the settings page for that is open. "missing": no such file.
   */
  fun install(context: Context, activity: Activity?, path: String): String {
    val apk = File(path)
    if (!apk.exists() || apk.parentFile?.canonicalPath != dir(context).canonicalPath) return "missing"
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
      launch(context, activity, Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}")))
      return "permission"
    }
    val uri = FileProvider.getUriForFile(context, "${context.packageName}.xiaoaixiaoai.updates", apk)
    val intent = Intent(Intent.ACTION_VIEW)
      .setDataAndType(uri, "application/vnd.android.package-archive")
      .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    launch(context, activity, intent)
    return "started"
  }

  /**
   * From the visible screen when there is one. Started as a new task, a second try would be
   * handed to the installer's leftover task from the first try and show nothing.
   */
  private fun launch(context: Context, activity: Activity?, intent: Intent) {
    if (activity != null) activity.startActivity(intent)
    else context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
  }

  fun canInstall(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()
}
