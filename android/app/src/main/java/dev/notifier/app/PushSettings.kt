package dev.notifier.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable fun PushSettings(connection: Connection?, enabled: Boolean, sourceIds: List<String> = emptyList(), registrationEnabled: Boolean = enabled) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var status by remember(connection?.namespace) { mutableStateOf("读取通知状态…") }
    suspend fun readStatus() {
        status = withContext(Dispatchers.IO) { runCatching { PushController.describe(context, connection) }.getOrDefault("无法读取推送安全存储，未确认推送可用") }
    }
    LaunchedEffect(connection?.namespace) { readStatus() }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, connection?.namespace) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) scope.launch { readStatus() }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { scope.launch { readStatus() } }
    HorizontalDivider()
    Text("系统通知", style = MaterialTheme.typography.titleLarge)
    Text(status)
    Text("使用自托管 ntfy 的 UnifiedPush 分发器，不要求 Google 服务。需要与服务端管理员配置的 ntfy 地址一致；没有分发器也可刷新收件箱。", style = MaterialTheme.typography.bodySmall)
    if (Build.VERSION.SDK_INT >= 33) OutlinedButton(onClick = { permission.launch(Manifest.permission.POST_NOTIFICATIONS) }, enabled = enabled) { Text("请求系统通知权限") }
    Button(onClick = {
        connection?.let { c -> runCatching { PushController.choose(context, c) }.onFailure { status = "分发器注册未启动，请确认系统设置" } }
    }, enabled = enabled && registrationEnabled && connection != null) { Text("选择分发器并注册") }
    OutlinedButton(onClick = { connection?.let { PushController.retryRegistration(context, it) }; scope.launch { readStatus() } }, enabled = enabled && registrationEnabled && connection != null) { Text("重试登记并检查状态") }
    TextButton(onClick = { runCatching { context.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)) } }, enabled = enabled) { Text("打开系统通知设置") }
    Text("平台接受、设备接收、系统提醒请求、已读、来源收件各自独立。后台/锁屏是否及时仍须真机验证。锁屏不显示事件正文；所有回应都在应用内确认。", style = MaterialTheme.typography.bodySmall)
    NoticeSettings(connection, sourceIds, enabled)
    Spacer(Modifier.height(16.dp))
}
