package dev.notifier.app

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Preserve the selected action even when a legitimate button response has empty text. */
fun historyText(h: History): String {
    if (h.kind == "response_saved") {
        val action = h.data["action"] as? JsonObject
        val label = (action?.get("label") as? JsonPrimitive)?.content ?: "原操作"
        val id = (action?.get("id") as? JsonPrimitive)?.content ?: "未知动作"
        val text = (h.data["text"] as? JsonPrimitive)?.content ?: ""
        return "选择：$label ($id)" + if (text.isNotEmpty()) "\n文字回应：\n$text" else ""
    }
    if (h.kind == "source_received") {
        val receipt = h.data["receipt"] as? JsonObject
        return "来源适配器报告原生收件（不是执行完成）\n命令：${h.data["command_id"]}\n回应：${h.data["response_id"]}\n原生消息：${(receipt?.get("message_id") as? JsonPrimitive)?.content ?: "未提供"}"
    }
    if (h.kind == "command_claimed") return "交付效果未知，只查询原命令：${h.data["command_id"]}"
    if (h.kind == "command_update_link") return "进展/结果关联命令：${h.data["command_id"]}\n原回应：${h.data["response_id"]}"
    return listOf("body", "text", "disposition").firstNotNullOfOrNull { (h.data[it] as? JsonPrimitive)?.content } ?: "已记录关联状态变更"
}

fun notificationStatus(event: Event): String {
    val current = event.notification_delivery?.takeIf { it.version == event.event_version }
    val phase = current?.let { when { it.notification_posted_at != null -> "notification_posted"; it.device_received_at != null -> "device_received"; else -> it.platform_state } } ?: "not_observed"
    val lines = mutableListOf("当前 v${event.event_version} 通知：$phase")
    listOfNotNull(event.notification_delivery, event.previous_notification_delivery).distinctBy { it.id }.forEach { n ->
        val label = if (n.version == event.event_version) "当前 v${n.version} 回执" else "较早 v${n.version} 已知回执（不代表当前版本）"
        lines += "$label\n平台：${n.platform_state}\n设备接收报告：${n.device_received_at ?: "未观察"}\n系统提醒请求：${n.notification_posted_at ?: "未观察"}（不代表已看见）"
    }
    return lines.joinToString("\n")
}

fun responseStatus(response: JsonObject): String {
    val delivery = response["source_delivery"] as? JsonObject
    val receipt = delivery?.get("receipt") as? JsonObject
    val state = (delivery?.get("state") as? JsonPrimitive)?.content ?: "waiting_source"
    val routing = when (state) { "source_received" -> "来源适配器报告原生收件"; "effect_unknown" -> "交付效果未知，只对账原命令"; else -> "回应已保存，尚未观察来源收件" }
    val eligibility = (response["eligibility_state"] as? JsonPrimitive)?.content ?: (response["routing_state"] as? JsonPrimitive)?.content ?: "unknown"
    return "$routing\n当前资格：$eligibility（不等于输入许可）" +
        ((delivery?.get("command_id") as? JsonPrimitive)?.takeIf { it.isString }?.let { "\n命令：${it.content}" } ?: "") +
        ((receipt?.get("message_id") as? JsonPrimitive)?.let { "\n原生消息：${it.content}" } ?: "") +
        "\n执行未观察，结果未核验"
}
