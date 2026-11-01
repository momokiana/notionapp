package dev.notifier.app

import android.Manifest
import android.app.Notification
import android.app.AlertDialog
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.*
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.*
import org.unifiedpush.android.connector.MessagingReceiver
import org.unifiedpush.android.connector.UnifiedPush

internal const val EVENT_NOTIFICATION_CHANNEL = "events"
object PushController {
    private val receiveExecutor = Executors.newSingleThreadExecutor { runnable -> Thread(runnable, "unifiedpush-receive").apply { isDaemon = true } }
    fun background(action: () -> Unit) { receiveExecutor.execute { runCatching { action() } } }
    fun records(context: Context, namespace: String) = PushRecords(PushPrivateState(context.applicationContext), namespace)
    fun current(context: Context, namespace: String): Connection? = PrivateState(context.applicationContext).load().connection?.takeIf { it.namespace == namespace }
    fun channel(context: Context): NotificationManager = context.getSystemService(NotificationManager::class.java).also {
        it.createNotificationChannel(NotificationChannel(EVENT_NOTIFICATION_CHANNEL, "事件更新", NotificationManager.IMPORTANCE_DEFAULT))
    }
    fun mayNotify(context: Context): Boolean {
        val manager = channel(context)
        return (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
            && manager.areNotificationsEnabled() && (manager.getNotificationChannel(EVENT_NOTIFICATION_CHANNEL)?.importance ?: NotificationManager.IMPORTANCE_NONE) != NotificationManager.IMPORTANCE_NONE
    }
    fun describe(context: Context, connection: Connection?): String {
        if (connection == null) return "请先设置连接"
        val distributors = UnifiedPush.getDistributors(context)
        val provider = if (distributors.isEmpty()) "未发现 UnifiedPush 分发器，请安装并配置自托管 ntfy App" else "分发器可用：${UnifiedPush.getSavedDistributor(context) ?: "尚未选择"}"
        val os = if (mayNotify(context)) "系统允许提醒（不证明后台必达）" else "系统通知权限或此通知渠道已关闭"
        return "$provider\n$os\n${records(context, connection.namespace).snapshot().status}"
    }
    fun choose(context: Context, connection: Connection) {
        val providers = UnifiedPush.getDistributors(context)
        fun select(provider: String) = background {
            if (current(context, connection.namespace) != null) {
                // Serialize connector mutations with receiver callbacks (including instance cleanup).
                UnifiedPush.saveDistributor(context.applicationContext, provider)
                UnifiedPush.registerApp(context.applicationContext, connection.namespace)
            }
        }
        when (providers.size) {
            0 -> AlertDialog.Builder(context).setTitle("需要 UnifiedPush 分发器").setMessage("请先安装支持 UnifiedPush 的 ntfy App，并配置与你的服务端一致的自托管地址。").setPositiveButton("知道了", null).show()
            1 -> select(providers.first())
            else -> AlertDialog.Builder(context).setTitle("选择推送分发器").setItems(providers.toTypedArray()) { _, index -> select(providers[index]) }.show()
        }
    }
    fun registration(context: Context, namespace: String, revision: Long) {
        val request = OneTimeWorkRequestBuilder<PushRegistrationWorker>().setInputData(workDataOf("namespace" to namespace, "revision" to revision))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        // Wait for durable enqueue before the connector returns its distributor ACK.
        WorkManager.getInstance(context).enqueueUniqueWork("push-registration:$namespace", ExistingWorkPolicy.REPLACE, request).result.get(5, TimeUnit.SECONDS)
    }
    fun message(context: Context, namespace: String, message: ByteArray) {
        // Invalid input is not a processing promise; acknowledge/discard instead of a poison-message retry loop.
        val payload = runCatching { PushEnvelope.parse(message) }.getOrNull() ?: return
        if (current(context, namespace) == null) return
        val request = OneTimeWorkRequestBuilder<PushMessageWorker>().setInputData(workDataOf("namespace" to namespace, "payload" to wire.encodeToString(PushEnvelope.serializer(), payload)))
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build()
        WorkManager.getInstance(context).enqueueUniqueWork("push-message:$namespace:${payload.delivery_id}:${payload.fingerprint}", ExistingWorkPolicy.KEEP, request).result.get(5, TimeUnit.SECONDS)
    }
    fun retryRegistration(context: Context, connection: Connection) = background {
        val state = records(context, connection.namespace).snapshot()
        if (state.revision > 0) registration(context, connection.namespace, state.revision)
    }
}

/** Library validates distributor token->instance. Its ACK occurs only after our durable WorkManager enqueue returns. */
class PushReceiver : MessagingReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val safe = Intent(intent)
        if (safe.action in listOf("org.unifiedpush.android.connector.REGISTRATION_FAILED", "org.unifiedpush.android.connector.REGISTRATION_REFUSED")) {
            // Connector 2.4.0 logs this distributor-supplied field. Never let a private endpoint enter logcat.
            safe.putExtra("message", "Registration failed")
        }
        PushController.background {
            try { super.onReceive(context, safe) }
            catch (_: Exception) { /* No ACK on failed persistence; no endpoint/payload/credential logs. */ }
            finally { pending.finish() }
        }
    }
    override fun onNewEndpoint(context: Context, endpoint: String, instance: String) {
        if (PushController.current(context, instance) == null || endpoint.length > 2048) return
        val state = PushController.records(context, instance).endpoint(endpoint)
        PushController.registration(context, instance, state.revision)
    }
    override fun onMessage(context: Context, message: ByteArray, instance: String) { PushController.message(context, instance, message) }
    override fun onUnregistered(context: Context, instance: String) {
        if (PushController.current(context, instance) == null) return
        val state = PushController.records(context, instance).endpoint(null)
        PushController.registration(context, instance, state.revision)
    }
    override fun onRegistrationFailed(context: Context, instance: String) {
        if (PushController.current(context, instance) != null) PushController.records(context, instance).update { it.copy(status = "分发器注册失败，未确认推送可用") }
    }
}

class PushRegistrationWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val namespace = inputData.getString("namespace") ?: return Result.failure()
        val revision = inputData.getLong("revision", -1)
        return try {
            val connection = PushController.current(applicationContext, namespace) ?: return Result.success()
            val records = PushController.records(applicationContext, namespace)
            if (records.snapshot().revision != revision) return Result.success()
            val http = HttpTransport()
            val remote = wire.parseToJsonElement(http.call(connection, "GET", "/v1/device/push")).jsonObject
            if (remote["configured"]?.jsonPrimitive?.boolean != true && records.snapshot().endpoint != null) {
                records.update { if (it.revision == revision) it.copy(status = "服务端尚未配置 ntfy origin，收件箱仍可使用") else it }; return Result.failure()
            }
            val remoteId = remote["registration_id"]?.jsonPrimitive?.contentOrNull
            if (records.confirmRegistration(revision, remoteId, remote["registered"]!!.jsonPrimitive.boolean)) return Result.success()
            val request = records.registration(revision, remote["generation"]!!.jsonPrimitive.long) ?: return Result.success()
            if (PushController.current(applicationContext, namespace) == null || records.snapshot().revision != revision) return Result.success()
            val result = wire.parseToJsonElement(http.call(connection, "PUT", "/v1/device/push", wire.encodeToString(RegistrationRequest.serializer(), request))).jsonObject
            records.update { if (it.revision == revision) it.copy(registered_id = request.registration_id, registration = null, status = if (result["registered"]!!.jsonPrimitive.boolean) "端点已登记，仍需真机验证后台/锁屏" else "推送端点已停用") else it }
            Result.success()
        } catch (e: ApiFailure) {
            val records = PushController.records(applicationContext, namespace)
            records.update { if (it.revision == revision) it.copy(registration = if (e.code == "DEVICE_GENERATION_CONFLICT") null else it.registration, status = "端点登记未确认：${e.code}") else it }
            if (e.status == 422 || e.status == 403) Result.failure() else Result.retry()
        } catch (_: Exception) { Result.retry() }
    }
}

class PushMessageWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val namespace = inputData.getString("namespace") ?: return Result.failure()
        val raw = inputData.getString("payload") ?: return Result.failure()
        return try {
            val payload = PushEnvelope.parse(raw.toByteArray(Charsets.UTF_8))
            val connection = PushController.current(applicationContext, namespace) ?: return Result.success()
            val records = PushController.records(applicationContext, namespace)
            val http = HttpTransport()
            fun receipt(state: String) = http.call(connection, "POST", "/v1/notifications/${payload.delivery_id}/receipt", buildJsonObject { put("nonce", payload.nonce); put("state", state) }.toString())
            // Authenticate the nonce AND immutable event/version mapping before trusting any push reference or showing UI.
            payload.verifyReceipt(wire.parseToJsonElement(receipt("device_received")).jsonObject)
            records.received(payload)
            val event = wire.decodeFromString<Event>(http.call(connection, "GET", "/v1/events/${payload.event_id}"))
            if (event.event_version < payload.event_version) return Result.retry()
            val observed = postWithNoticePreferences(PrivateNoticePreferences(applicationContext), records, namespace, payload, event,
                permitted = { PushController.current(applicationContext, namespace) != null && PushController.mayNotify(applicationContext) }) { preferences ->
                val intent = Intent(applicationContext, MainActivity::class.java)
                    .setData(Uri.parse("notifier://event/$namespace/${event.id}"))
                    .putExtra("event_id", event.id).putExtra("namespace", namespace)
                val target = PendingIntent.getActivity(applicationContext, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                val notification = Notification.Builder(applicationContext, EVENT_NOTIFICATION_CHANNEL).setSmallIcon(R.drawable.ic_notification)
                    .setContentTitle("有事件更新").setContentText("打开应用查看当前事件与可回应操作")
                    .setContentIntent(target).setAutoCancel(true).setVisibility(if (preferences.lock_screen == "generic") Notification.VISIBILITY_PUBLIC else Notification.VISIBILITY_SECRET).build()
                PushController.channel(applicationContext).notify("$namespace:${event.id}", 0, notification)
            }
            if (PushController.current(applicationContext, namespace) == null) return Result.success()
            if (observed.posted) receipt("notification_posted")
            Result.success()
        } catch (e: ApiFailure) {
            // Old/invisible references never become authority or get rebound. Auth/network failures may recover.
            if (e.status in listOf(404, 409, 410, 422, 403)) Result.failure() else Result.retry()
        } catch (_: Exception) { Result.retry() }
    }
}
