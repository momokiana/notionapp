package dev.notifier.app

import android.app.Activity
import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Owned-debug-AVD inspection only, in a separate test APK. No HTTP, mutation, credentials or message bodies in output. */
class StateEvidence : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    private fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    override fun onStart() {
        val result = Bundle()
        try {
            @Suppress("DEPRECATION") val context = targetContext
            check(File(context.noBackupFilesDir, "connection.enc").isFile)
            val state = PrivateState(context).load()
            val value = buildJsonObject {
                put("inspection", "owned_debug_avd_read_only_state")
                put("pid", android.os.Process.myPid())
                state.connection?.let { put("connection", buildJsonObject { put("namespace", it.namespace); put("credential_hash", credentialDigest(it.token)); put("base_hash", credentialDigest(it.base)) }) }
                state.device?.let { put("device", wire.encodeToJsonElement(ManagedDevice.serializer(), it)) }
                state.pending?.let { p -> put("pending", buildJsonObject { put("id", p.id); put("namespace", p.namespace); put("path", p.path); put("body_hash", credentialDigest(p.body)); put("uncertain", p.uncertain); put("response", p.response); put("record_hash", credentialDigest(wire.encodeToString(Pending.serializer(), p))) }) }
                state.auth_intent?.let { p -> put("auth_intent", buildJsonObject { put("kind", p.kind); put("id", p.id); put("root_hash", credentialDigest(p.root)); put("body_hash", credentialDigest(p.body)); put("uncertain", p.uncertain); p.proposed_token?.let { put("proposal_hash", credentialDigest(it)) }; p.target_device?.let { put("target", it) } }) }
                put("drafts", buildJsonArray { state.drafts.forEach { d -> add(buildJsonObject {
                    put("id", d.id); put("namespace", d.namespace); put("event_id", d.event_id); put("event_version", d.event_version); put("interaction_version", d.interaction_version)
                    put("text_hash", credentialDigest(d.text)); put("record_hash", credentialDigest(wire.encodeToString(ResponseDraft.serializer(), d)))
                }) } })
                put("templates", buildJsonArray { state.templates.forEach { t -> add(buildJsonObject { put("id", t.id); put("record_hash", credentialDigest(wire.encodeToString(ReplyTemplate.serializer(), t))) }) } })
                put("files", buildJsonObject {
                    listOf("connection.enc", "inbox.enc", "push.enc", "notification-preferences.enc").forEach { name ->
                        val file = File(context.noBackupFilesDir, name)
                        if (file.isFile) { check(file.length() <= 34L * 1024 * 1024); put(name, buildJsonObject { put("bytes", file.length()); put("sha256", hash(file.readBytes())) }) }
                    }
                })
                if (File(context.noBackupFilesDir, "inbox.enc").isFile) {
                    val cache = PrivateInbox(context).load()
                    put("inbox", buildJsonObject { put("namespace", cache.namespace); put("events", cache.events.size); put("listed", cache.list_ids.size); put("histories", cache.histories.size); put("range_after", cache.range_after); cache.range_next?.let { put("range_next", it) }; put("prior_ranges", cache.previous_ranges.size); put("record_hash", credentialDigest(wire.encodeToString(InboxCache.serializer(), cache))) })
                }
                state.connection?.let { connection ->
                    if (File(context.noBackupFilesDir, "push.enc").isFile) {
                        val account = PushRecords(PushPrivateState(context), connection.namespace).snapshot()
                        put("push", buildJsonObject {
                            put("revision", account.revision); account.endpoint?.let { put("endpoint_hash", credentialDigest(it)) }; account.registered_id?.let { put("registered_id", it) }; account.registration?.let { put("pending_registration_id", it.registration_id) }
                            put("watermarks", buildJsonObject { account.watermarks.forEach { (id, version) -> put(id, version) } })
                            put("deliveries", buildJsonObject { account.deliveries.forEach { (id, observed) -> put(id, buildJsonObject { put("event_id", observed.envelope.event_id); put("version", observed.envelope.event_version); put("nonce_hash", credentialDigest(observed.envelope.nonce)); put("posting_unknown", observed.posting_unknown); put("posted", observed.posted); observed.suppression?.let { put("suppression", it) } }) } })
                        })
                    }
                }
            }
            result.putString("notion_state", value.toString()); finish(Activity.RESULT_OK, result)
        } catch (_: Exception) { result.putString("notion_state", "{\"error\":\"STATE_EVIDENCE_FAILED_ORIGINAL_FILES_UNCHANGED\"}"); finish(Activity.RESULT_CANCELED, result) }
    }
}
