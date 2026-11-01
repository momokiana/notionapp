package dev.notifier.app

import java.net.ServerSocket
import java.net.InetAddress
import kotlin.concurrent.thread
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DisplayAndBoundsTest {
    @Test fun buttonAndTextHistoryPreserveOriginalActionAndText() {
        val original = "  逐字保留\n🙂  "
        fun history(text: String) = History(1, "response_saved", "fixture", buildJsonObject {
            put("action", buildJsonObject { put("id", "approve_a"); put("label", "批准方案 A"); put("type", if (text.isEmpty()) "button" else "text") })
            put("text", text)
        })
        assertEquals("选择：批准方案 A (approve_a)", historyText(history("")))
        assertEquals("选择：批准方案 A (approve_a)\n文字回应：\n$original", historyText(history(original)))
    }
    @Test fun correlatedSourceReceiptNeverClaimsExecutionOrReopensBlockedEligibility() {
        val response = buildJsonObject {
            put("eligibility_state", "blocked"); put("routing_state", "blocked")
            put("source_delivery", buildJsonObject { put("state", "source_received"); put("command_id", "command_1"); put("receipt", buildJsonObject { put("message_id", "native_message_1") }) })
        }
        val text = responseStatus(response)
        assertTrue(text.contains("来源适配器报告原生收件")); assertTrue(text.contains("blocked")); assertTrue(text.contains("native_message_1")); assertTrue(text.contains("执行未观察，结果未核验"))
        val history = History(1, "source_received", "fixture", buildJsonObject { put("command_id", "command_1"); put("response_id", "response_1"); put("receipt", buildJsonObject { put("message_id", "native_message_1") }) })
        assertTrue(historyText(history).contains("native_message_1")); assertTrue(historyText(history).contains("不是执行完成"))
    }
    @Test fun olderNotificationReceiptNeverBecomesCurrentVersionEvidence() {
        val e = wire.decodeFromString<Event>("""{"id":"event_1","title":"Question","body":"Body","source_id":"source","event_version":2,"interaction_version":0,"disposition":"open","expires_at":"2099-01-01T00:00:00Z","updated_at":"fixture","delivery_state":"notification_posted"}""")
        val old = NotificationDelivery("notice_v1", 1, "platform_accepted", "received-v1", "posted-v1")
        val withoutCurrent = notificationStatus(e.copy(notification_delivery = null, previous_notification_delivery = old))
        assertTrue(withoutCurrent.startsWith("当前 v2 通知：not_observed")); assertTrue(withoutCurrent.contains("较早 v1 已知回执")); assertTrue(withoutCurrent.contains("posted-v1"))
        val legacy = notificationStatus(e.copy(notification_delivery = old))
        assertTrue(legacy.startsWith("当前 v2 通知：not_observed")); assertTrue(legacy.contains("不代表当前版本"))
        val current = NotificationDelivery("notice_v2", 2, "effect_unknown")
        val unknown = notificationStatus(e.copy(notification_delivery = current, previous_notification_delivery = old))
        assertTrue(unknown.startsWith("当前 v2 通知：effect_unknown")); assertTrue(unknown.contains("posted-v1")); assertTrue(unknown.contains("当前 v2 回执"))
    }
    @Test fun maliciousOversizedResponseIsStillRejectedAtBound() {
        val http = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))
        val serving = thread(isDaemon = true) {
            try { http.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader(); while (!reader.readLine().isNullOrEmpty()) { }
                socket.getOutputStream().use { out ->
                    out.write("HTTP/1.1 200 OK\r\nContent-Length: ${MAX_PAGE_RESPONSE_BYTES + 1}\r\nConnection: close\r\n\r\n".toByteArray())
                    val chunk = ByteArray(8192) { 65 }; repeat(MAX_PAGE_RESPONSE_BYTES / chunk.size) { out.write(chunk) }; out.write(65)
                }
            } } catch (_: java.io.IOException) { }
        }
        try {
            val c = Connection.parse("http://127.0.0.1:${http.localPort}", "a".repeat(64), true)
            try { HttpTransport().call(c, "GET", "/v1/events"); fail("oversized response must reject") }
            catch (e: IllegalArgumentException) { assertEquals("服务响应超出限额", e.message) }
        } finally { http.close(); serving.join(2000) }
    }
}
