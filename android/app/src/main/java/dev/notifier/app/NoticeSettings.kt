package dev.notifier.app

import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private fun systemNoticeStatus(context: android.content.Context): String {
    val manager = PushController.channel(context)
    val channel = manager.getNotificationChannel(EVENT_NOTIFICATION_CHANNEL)
    val importance = when (channel?.importance) { NotificationManager.IMPORTANCE_NONE -> "渠道关闭"; NotificationManager.IMPORTANCE_MIN -> "最小"; NotificationManager.IMPORTANCE_LOW -> "低"; NotificationManager.IMPORTANCE_DEFAULT -> "默认"; NotificationManager.IMPORTANCE_HIGH -> "高"; else -> "未知" }
    val dnd = when (manager.currentInterruptionFilter) { NotificationManager.INTERRUPTION_FILTER_ALL -> "未开启"; NotificationManager.INTERRUPTION_FILTER_PRIORITY -> "仅优先通知"; NotificationManager.INTERRUPTION_FILTER_NONE -> "全部抑制"; NotificationManager.INTERRUPTION_FILTER_ALARMS -> "仅闹钟"; else -> "未知" }
    val visibility = when (channel?.lockscreenVisibility) { Notification.VISIBILITY_SECRET -> "系统渠道隐藏整卡"; Notification.VISIBILITY_PRIVATE -> "系统渠道隐藏私密内容"; Notification.VISIBILITY_PUBLIC -> "系统渠道允许内容"; else -> "由系统与本机隐私选择共同决定" }
    return "实际渠道重要性：$importance\n声音配置：${if (channel?.sound != null) "有" else "无"} · 振动配置：${if (channel?.shouldVibrate() == true) "有" else "无"}\n系统免打扰：$dnd\n锁屏：$visibility\n音振配置不保证会响；权限、免打扰、电池与分发器仍可能限制。"
}

@Composable fun NoticeSettings(connection: Connection?, sourceIds: List<String>, enabled: Boolean) {
    val context = LocalContext.current
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val owner = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()
    val store = remember { PrivateNoticePreferences(context.applicationContext) }
    var saved by remember(connection?.namespace) { mutableStateOf<NoticePreferences?>(null) }
    var draft by remember(connection?.namespace) { mutableStateOf(NoticePreferences()) }
    var start by remember(connection?.namespace) { mutableStateOf("22:00") }
    var end by remember(connection?.namespace) { mutableStateOf("08:00") }
    var busy by remember(connection?.namespace) { mutableStateOf(false) }
    var error by remember(connection?.namespace) { mutableStateOf<String?>(null) }
    var message by remember(connection?.namespace) { mutableStateOf<String?>(null) }
    var system by remember { mutableStateOf("读取实际系统渠道…") }
    suspend fun read() {
        try {
            val value = withContext(Dispatchers.IO) { store.load() }
            saved = value; draft = value; start = NoticePreferences.displayTime(value.quiet_start); end = NoticePreferences.displayTime(value.quiet_end); error = null
        } catch (_: Exception) { error = "本机通知偏好不可读，暂停新提醒；原文件保留，不会重置收件/交付记录。" }
    }
    suspend fun readSystem() { system = withContext(Dispatchers.IO) { runCatching { systemNoticeStatus(context) }.getOrDefault("无法确认系统渠道状态，请打开系统渠道设置检查。") } }
    LaunchedEffect(connection?.namespace) { read(); readSystem() }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) scope.launch { readSystem() } }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    val editable = enabled && !busy && saved != null
    HorizontalDivider()
    Text("本机提醒偏好", style = MaterialTheme.typography.titleLarge)
    Text("以下总开关、锁屏和静默时间只作用于本机，不改变事件保存、来源处理或历史回执。", style = MaterialTheme.typography.bodySmall)
    if (saved == null) error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    if (saved == null) OutlinedButton(onClick = { scope.launch { read() } }, enabled = enabled && !busy) { Text("重读本机通知偏好") }
    Row(Modifier.fillMaxWidth().toggleable(value = draft.enabled, enabled = editable, role = Role.Switch, onValueChange = { draft = draft.copy(enabled = it) }), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("允许本机新提醒", modifier = Modifier.weight(1f))
        Switch(draft.enabled, onCheckedChange = null, enabled = editable)
    }
    Text("锁屏隐私", style = MaterialTheme.typography.titleMedium)
    listOf("secret" to "完全隐藏锁屏卡片（默认）", "generic" to "锁屏显示通用提醒").forEach { (value, label) ->
        Row(Modifier.fillMaxWidth().selectable(selected = draft.lock_screen == value, enabled = editable, role = Role.RadioButton, onClick = { draft = draft.copy(lock_screen = value) }).padding(vertical = 4.dp)) {
            RadioButton(selected = draft.lock_screen == value, onClick = null, enabled = editable)
            Text(label, modifier = Modifier.padding(start = 12.dp))
        }
    }
    Text("通用提醒只显示固定提示，不显示事件标题、正文或来源。系统仍可能完全隐藏。", style = MaterialTheme.typography.bodySmall)
    Row(Modifier.fillMaxWidth().toggleable(value = draft.quiet_enabled, enabled = editable, role = Role.Switch, onValueChange = { draft = draft.copy(quiet_enabled = it) }), horizontalArrangement = Arrangement.SpaceBetween) {
        Text("启用本机静默时间", modifier = Modifier.weight(1f))
        Switch(draft.quiet_enabled, onCheckedChange = null, enabled = editable)
    }
    OutlinedTextField(start, { start = it }, enabled = editable, label = { Text("静默开始 HH:mm（24小时）") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii))
    OutlinedTextField(end, { end = it }, enabled = editable, label = { Text("静默结束 HH:mm（24小时）") }, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii))
    Text("按准备提醒时的本地时间/时区判断，包含开始、不包含结束；允许跨午夜，起止不能相同。已在本机静默的版本不补发；此前未收到的离线消息恢复后按当前状态处理。", style = MaterialTheme.typography.bodySmall)
    connection?.namespace?.let { namespace ->
        Text("当前连接的静默来源", style = MaterialTheme.typography.titleMedium)
        Text("只抑制这些来源在本机的提醒；同名来源不会跨连接套用。", style = MaterialTheme.typography.bodySmall)
        val muted = draft.muted_sources[namespace] ?: emptySet()
        val known = (sourceIds + muted).distinct().sorted()
        if (known.isEmpty()) Text("先同步收件箱，再选择要静默的来源。")
        known.forEach { source ->
            Row(Modifier.fillMaxWidth().toggleable(value = source in muted, enabled = editable, role = Role.Checkbox, onValueChange = { checked ->
                val current = draft.muted_sources[namespace] ?: emptySet()
                val ids = if (checked) current + source else current - source
                draft = draft.copy(muted_sources = if (ids.isEmpty()) draft.muted_sources - namespace else draft.muted_sources + (namespace to ids))
            })) {
                Checkbox(source in muted, onCheckedChange = null, enabled = editable)
                Text(source, modifier = Modifier.weight(1f).padding(top = 12.dp))
            }
        }
    }
    Text("保存会撤下本App现有通知卡片，并只影响以后新的提醒；不会补发旧版本，也不抹历史posted/未知事实。", style = MaterialTheme.typography.bodySmall)
    if (saved != null) error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    message?.let { Text(it, color = MaterialTheme.colorScheme.primary) }
    Button(onClick = {
        focus.clearFocus()
        scope.launch {
            busy = true; error = null; message = null
            try {
                val value = draft.copy(quiet_start = NoticePreferences.parseTime(start), quiet_end = NoticePreferences.parseTime(end)).also { it.validate() }
                val withdrawn = withContext(Dispatchers.IO) { synchronized(NoticeGate.monitor) {
                    store.save(value)
                    runCatching { context.getSystemService(NotificationManager::class.java).cancelAll() }.isSuccess
                } }
                saved = value; draft = value
                message = if (withdrawn) "本机偏好已保存，现有通知已撤下；事件和回执保留。" else "本机偏好已保存，但无法确认旧通知撤下，请检查通知栏。"
                readSystem()
            } catch (e: IllegalArgumentException) { error = e.message ?: "设置无效，原偏好保留。" }
            catch (_: Exception) { error = "无法保存偏好，未确认生效；原交付记录保留，请重读设置核对。" }
            finally { busy = false }
        }
    }, enabled = editable) { Text(if (busy) "正在保存本机偏好" else "保存本机提醒偏好") }
    HorizontalDivider()
    Text("声音与系统限制", style = MaterialTheme.typography.titleMedium)
    Text(system, style = MaterialTheme.typography.bodySmall)
    OutlinedButton(onClick = {
        runCatching { context.startActivity(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName).putExtra(Settings.EXTRA_CHANNEL_ID, EVENT_NOTIFICATION_CHANNEL)) }
            .onFailure { error = "无法打开系统渠道，请从系统应用设置进入通知。" }
    }, enabled = enabled && !busy) { Text("打开事件通知渠道设置") }
}
