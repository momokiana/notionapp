package dev.notifier.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

private fun cacheChangeLabel(change: CacheChange) = when (change) {
    CacheChange.NEXT -> "查看后续缓存区间"
    CacheChange.PREVIOUS -> "上一缓存区间"
    CacheChange.FIRST -> "回到最早区间"
    CacheChange.CLEAR_HISTORY -> "清理已加载历史和回执"
    CacheChange.CLEAR_EXTERNAL -> "清理列表外详情"
    CacheChange.CLEAR_ALL -> "清空离线内容"
}
@Composable internal fun CacheControls(m: ClientModel, management: Boolean = false) {
    val view = m.cacheView
    if (m.cacheUnavailable) {
        Text("离线内容缓存不可读，原文件保留；这不表示服务端为空。不能借清理或切换连接覆盖坏缓存，原未决请求仍独立保留。", color = MaterialTheme.colorScheme.error)
        return
    }
    if (view == null) { Text("离线缓存尚未就绪。连接服务后可同步；没有自动清理或发送。", style = MaterialTheme.typography.bodySmall); return }
    val cache = view.cache
    val enabled = !m.busy && cache.namespace == m.connection?.namespace
    var confirm by remember(view.token) { mutableStateOf<CacheChange?>(null) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (management) Text("离线容量与缓存区间", style = MaterialTheme.typography.titleLarge)
        Text("本机序列化密文估计 ${view.bytes}/$MAX_CACHE_BYTES 字节 · 列表 ${cache.list_ids.size}/$MAX_WINDOW_EVENTS 条", style = MaterialTheme.typography.labelSmall)
        Text("当前创建游标 ${cache.range_after} 起 · 区间观察 ${cache.scanned_at ?: "尚未同步"}", style = MaterialTheme.typography.labelSmall)
        Text(when {
            cache.scanned_at == null -> "尚未完成本区间同步，联网刷新后可离线阅读。"
            cache.range_next != null -> "后续事件尚未缓存。前台/重连只刷新当前区间，不自动替换内容。"
            else -> "本区间已读到当时服务所见末尾。不是实时更新订阅，也不代表全库离线归档。"
        }, style = MaterialTheme.typography.bodySmall)
        val outside = cache.events.size - cache.list_ids.size
        if (outside > 0) Text("列表外详情 $outside 份${if (outside > 1) "（旧版保留资料，新增详情已背压；可明确清理）" else "，再次打开其他区间外事件前可明确清理"}。", style = MaterialTheme.typography.bodySmall)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (cache.range_next != null) OutlinedButton(onClick = { confirm = CacheChange.NEXT }, enabled = enabled) { Text(cacheChangeLabel(CacheChange.NEXT)) }
            if (cache.previous_ranges.isNotEmpty()) TextButton(onClick = { confirm = CacheChange.PREVIOUS }, enabled = enabled) { Text(cacheChangeLabel(CacheChange.PREVIOUS)) }
            if (cache.range_after != "0") TextButton(onClick = { confirm = CacheChange.FIRST }, enabled = enabled) { Text(cacheChangeLabel(CacheChange.FIRST)) }
        }
        if (management) {
            Text("每个列表区间最多1000条，另有一个列表外详情新槽；历史每区间最多1000条。完整缓存含历史/回执/导航，共32MiB。大正文可能在完整页边界提前停止，不静默逐出原前缀。", style = MaterialTheme.typography.bodySmall)
            Text("最近可回看64个区间起点，也可随时明确回到最早。更换区间会替换本机内容；服务记录、草稿、原未决提交和通知去重不动。", style = MaterialTheme.typography.bodySmall)
            listOf(CacheChange.CLEAR_HISTORY, CacheChange.CLEAR_EXTERNAL, CacheChange.CLEAR_ALL).forEach { change ->
                TextButton(onClick = { confirm = change }, enabled = enabled) { Text(cacheChangeLabel(change)) }
            }
        }
        confirm?.let { change ->
            HorizontalDivider()
            Text("确认${cacheChangeLabel(change)}？", style = MaterialTheme.typography.titleSmall)
            Text(if (change in setOf(CacheChange.NEXT, CacheChange.PREVIOUS, CacheChange.FIRST)) "成功后替换本机当前列表和关联离线资料，之后可重新下载。操作失败保留原区间，不会提交回应。" else "只移除所选本机只读内容，之后需重新下载。不会删除服务历史、草稿、原未决请求、身份或通知账本。", style = MaterialTheme.typography.bodySmall)
            FlowRow {
                Button(onClick = { m.changeCache(change, view.token) }, enabled = enabled) { Text("确认${cacheChangeLabel(change)}") }
                TextButton(onClick = { confirm = null }) { Text("保留当前缓存") }
            }
        }
    }
}

private fun historyWindowLabel(change: HistoryWindow) = when (change) {
    HistoryWindow.NEXT -> "查看后续历史区间"
    HistoryWindow.PREVIOUS -> "上一历史区间"
    HistoryWindow.FIRST -> "从创建重看历史"
}
@Composable internal fun HistoryControls(m: ClientModel, id: String) {
    val view = m.cacheView
    val history = view?.cache?.histories?.get(id)
    var confirm by remember(id, view?.token) { mutableStateOf<HistoryWindow?>(null) }
    if (history == null) { Text("本机尚未加载该事件历史。", style = MaterialTheme.typography.labelSmall); return }
    val enabled = !m.busy && !m.cacheUnavailable && view.cache.namespace == m.connection?.namespace
    Text("历史游标 ${history.from_after} 起 · 已加载 ${history.items.size}/$MAX_CACHED_HISTORY 条 · 前缀观察 ${history.observed_at}", style = MaterialTheme.typography.labelSmall)
    Text(if (history.next_after == null) "本区间已到当时历史末尾，不代表从创建以来完整。" else "后续历史尚未全部缓存，可保留本前缀继续加载，或明确更换区间。", style = MaterialTheme.typography.bodySmall)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        if (history.next_after != null) OutlinedButton(onClick = { confirm = HistoryWindow.NEXT }, enabled = enabled) { Text(historyWindowLabel(HistoryWindow.NEXT)) }
        if (history.previous_ranges.isNotEmpty()) TextButton(onClick = { confirm = HistoryWindow.PREVIOUS }, enabled = enabled) { Text(historyWindowLabel(HistoryWindow.PREVIOUS)) }
        if (history.from_after != "0") TextButton(onClick = { confirm = HistoryWindow.FIRST }, enabled = enabled) { Text(historyWindowLabel(HistoryWindow.FIRST)) }
    }
    confirm?.let { change ->
        Text("确认${historyWindowLabel(change)}？会替换这一个事件的本机历史前缀；服务历史及其他事件缓存不变。", style = MaterialTheme.typography.bodySmall)
        FlowRow {
            Button(onClick = { m.changeHistoryWindow(id, change, view.token) }, enabled = enabled) { Text("确认${historyWindowLabel(change)}") }
            TextButton(onClick = { confirm = null }) { Text("保留当前历史") }
        }
    }
}
