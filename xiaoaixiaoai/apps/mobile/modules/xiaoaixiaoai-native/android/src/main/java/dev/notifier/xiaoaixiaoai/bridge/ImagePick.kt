package dev.notifier.xiaoaixiaoai.bridge

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import expo.modules.kotlin.Promise
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Pictures to send to an agent: the system photo picker (Android 13+, no
 * storage permission; older phones get the system file picker), then each
 * picture shrunk to a JPEG whose longest side is at most `maxSide`.
 */
object ImagePick {
  const val REQUEST = 0x7e51

  private class Pending(val promise: Promise, val max: Int, val maxSide: Int, val quality: Int)

  private var pending: Pending? = null

  fun start(activity: Activity, promise: Promise, max: Int, maxSide: Int, quality: Int) {
    // A pick that never came back (the activity was replaced) ends as cancelled.
    pending?.promise?.resolve(emptyList<Any>())
    pending = Pending(promise, max.coerceIn(1, 20), maxSide.coerceIn(256, 4096), quality.coerceIn(40, 95))
    try {
      activity.startActivityForResult(intent(max), REQUEST)
    } catch (e: Throwable) {
      pending = null
      promise.reject("E_PICK", e.message ?: "no picture picker on this phone", e)
    }
  }

  fun onResult(context: Context, resultCode: Int, data: Intent?) {
    val p = pending ?: return
    pending = null
    val uris = if (resultCode == Activity.RESULT_OK) uris(data).take(p.max) else emptyList()
    if (uris.isEmpty()) {
      p.promise.resolve(emptyList<Any>())
      return
    }
    // Decoding a large photo takes a moment: off the main thread.
    Thread {
      try {
        p.promise.resolve(uris.map { encode(context, it, p.maxSide, p.quality) })
      } catch (e: Throwable) {
        p.promise.reject("E_IMAGE", e.message ?: "could not read the picture", e)
      }
    }.start()
  }

  private fun intent(max: Int): Intent {
    if (Build.VERSION.SDK_INT >= 33) {
      val i = Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
      val limit = min(max, MediaStore.getPickImagesMaxLimit())
      if (limit > 1) i.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, limit)
      return i
    }
    return Intent(Intent.ACTION_GET_CONTENT)
      .setType("image/*")
      .addCategory(Intent.CATEGORY_OPENABLE)
      .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, max > 1)
  }

  private fun uris(data: Intent?): List<Uri> {
    if (data == null) return emptyList()
    val clip = data.clipData
    if (clip != null && clip.itemCount > 0) return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    return listOfNotNull(data.data)
  }

  private fun encode(context: Context, uri: Uri, maxSide: Int, quality: Int): Map<String, Any> {
    val decoded = decode(context, uri, maxSide)
    // JPEG has no transparency: transparent parts would turn black.
    val bitmap = if (decoded.hasAlpha()) onWhite(decoded) else decoded
    val out = ByteArrayOutputStream()
    if (!bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)) error("could not encode the picture")
    val bytes = out.toByteArray()
    val stem = displayName(context, uri)?.substringBeforeLast('.')?.takeIf { it.isNotBlank() } ?: "image"
    return mapOf(
      "name" to "$stem.jpg",
      "mime" to "image/jpeg",
      "data" to Base64.encodeToString(bytes, Base64.NO_WRAP),
      "width" to bitmap.width,
      "height" to bitmap.height,
      "bytes" to bytes.size,
    )
  }

  private fun decode(context: Context, uri: Uri, maxSide: Int): Bitmap {
    if (Build.VERSION.SDK_INT >= 28) {
      // ImageDecoder turns the picture upright (EXIF) and reads HEIF; its size is the upright one.
      val source = ImageDecoder.createSource(context.contentResolver, uri)
      return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val w = info.size.width
        val h = info.size.height
        val scale = maxSide.toDouble() / max(w, h)
        if (scale < 1) decoder.setTargetSize(max(1, (w * scale).roundToInt()), max(1, (h * scale).roundToInt()))
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
    }
    val resolver = context.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, bounds) }
    var sample = 1
    while (max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
    val raw = resolver.openInputStream(uri).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
      ?: error("not a picture")
    val turn = try {
      resolver.openInputStream(uri)?.use {
        when (ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)) {
          ExifInterface.ORIENTATION_ROTATE_90 -> 90f
          ExifInterface.ORIENTATION_ROTATE_180 -> 180f
          ExifInterface.ORIENTATION_ROTATE_270 -> 270f
          else -> 0f
        }
      } ?: 0f
    } catch (_: Throwable) {
      0f
    }
    val scale = min(1.0, maxSide.toDouble() / max(raw.width, raw.height)).toFloat()
    if (scale >= 1f && turn == 0f) return raw
    val m = Matrix().apply {
      postScale(scale, scale)
      postRotate(turn)
    }
    return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, m, true)
  }

  private fun onWhite(b: Bitmap): Bitmap {
    val out = Bitmap.createBitmap(b.width, b.height, Bitmap.Config.ARGB_8888)
    Canvas(out).apply {
      drawColor(Color.WHITE)
      drawBitmap(b, 0f, 0f, null)
    }
    return out
  }

  private fun displayName(context: Context, uri: Uri): String? =
    try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      }
    } catch (_: Throwable) {
      null
    }
}
