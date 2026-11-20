package dev.notifier.xiaoaixiaoai.bridge

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class XiaoaiNativeModule : Module() {
  private val context: Context
    get() = requireNotNull(appContext.reactContext) { "React context is not ready" }

  override fun definition() = ModuleDefinition {
    Name("XiaoaiNative")

    Events("onCall", "onCallEvent", "onLevel", "onNotice", "onNotifier", "onUpdateProgress", "onSpeech", "onPttLevel")

    OnCreate {
      XiaoaiBus.listener = { name, body -> sendEvent(name, body) }
    }

    OnDestroy {
      XiaoaiBus.listener = null
    }

    /** Starts a voice call (needs RECORD_AUDIO granted first). */
    Function("startCall") { server: String, token: String ->
      ChatVoice.cancelRecording()
      ChatVoice.stopSpeech(null)
      XiaoaiService.startCall(context, server, token)
    }

    AsyncFunction("startVoiceNote") { promise: Promise ->
      val ctx = context
      Thread {
        try {
          ChatVoice.startRecording(ctx)
          promise.resolve(true)
        } catch (e: Throwable) {
          promise.reject("E_VOICE_NOTE", e.message ?: "无法开始录音", e)
        }
      }.start()
    }

    AsyncFunction("stopVoiceNote") { promise: Promise ->
      Thread {
        try {
          promise.resolve(ChatVoice.stopRecording())
        } catch (e: Throwable) {
          promise.reject("E_VOICE_NOTE", e.message ?: "停止录音失败", e)
        }
      }.start()
    }

    Function("cancelVoiceNote") {
      ChatVoice.cancelRecording()
    }

    Function("startSpeech") { utteranceId: String, sampleRate: Int ->
      ChatVoice.startSpeech(context, utteranceId, sampleRate)
    }

    Function("feedSpeech") { utteranceId: String, pcmBase64: String ->
      ChatVoice.feedSpeech(context, utteranceId, pcmBase64)
    }

    Function("finishSpeech") { utteranceId: String ->
      ChatVoice.finishSpeech(utteranceId)
    }

    Function("stopSpeech") { utteranceId: String? ->
      ChatVoice.stopSpeech(utteranceId)
    }

    Function("hangup") {
      XiaoaiService.hangup(context)
    }

    Function("setMuted") { muted: Boolean ->
      VoiceCall.current?.setMuted(muted)
    }

    Function("callState") {
      val c = VoiceCall.current
      mapOf("active" to (c != null), "muted" to (c?.muted ?: false))
    }

    /** Background alerts: stores what the service needs and starts or stops it. */
    Function("configureNotifier") { server: String?, token: String?, enabled: Boolean, kinds: List<String>, name: String? ->
      Prefs(context).configure(server, token, enabled, kinds.toSet(), name)
      XiaoaiService.sync(context)
    }

    Function("notifierState") {
      val p = Prefs(context)
      mapOf(
        "enabled" to p.notify,
        "connected" to (XiaoaiService.notifier?.connected ?: false),
        "notificationsAllowed" to NotificationManagerCompat.from(context).areNotificationsEnabled(),
        "batteryUnrestricted" to (context.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(context.packageName),
      )
    }

    /** Asks the system to let the service run in the background without being killed. */
    Function("requestBatteryExemption") {
      val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        context.startActivity(i)
      } catch (_: Throwable) {
        context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }

    Function("openNotificationSettings") {
      val i = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(i)
    }

    /** The installed versionName, e.g. "0.1.0". */
    Function("appVersion") {
      Updater.installedVersion(context)
    }

    /**
     * Downloads a release APK into the cache; progress arrives as onUpdateProgress.
     * Runs on its own thread so a long download never holds up other native calls.
     */
    AsyncFunction("downloadUpdate") { url: String, name: String, size: Double, sha256: String, promise: Promise ->
      val ctx = context
      Thread {
        try {
          val path = Updater.download(ctx, url, name, size.toLong(), sha256) { got, total ->
            XiaoaiBus.emit("onUpdateProgress", mapOf("received" to got.toDouble(), "total" to total.toDouble()))
          }
          promise.resolve(path)
        } catch (e: Throwable) {
          promise.reject("E_UPDATE_DOWNLOAD", e.message ?: "download failed", e)
        }
      }.start()
    }

    Function("cancelUpdate") {
      Updater.cancel()
    }

    /** "started" | "permission" | "missing" (see Updater.install). */
    Function("installUpdate") { path: String ->
      Updater.install(context, appContext.currentActivity, path)
    }

    Function("canInstallUpdates") {
      Updater.canInstall(context)
    }

    /**
     * Lets the person pick up to `max` pictures; each comes back as
     * {name, mime, data (base64 JPEG), width, height, bytes}, its longest side at
     * most `maxSide`. Cancelled: an empty list.
     */
    AsyncFunction("pickImages") { max: Int, maxSide: Int, quality: Int, promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) promise.reject("E_NO_ACTIVITY", "the app is not in front", null)
      else ImagePick.start(activity, promise, max, maxSide, quality)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode == ImagePick.REQUEST) ImagePick.onResult(context, payload.resultCode, payload.data)
    }

    /** A local test notification, to check that alerts really show up. */
    Function("testNotice") { title: String, body: String ->
      post(context, "test-${System.currentTimeMillis()}", title, body)
    }
  }
}
