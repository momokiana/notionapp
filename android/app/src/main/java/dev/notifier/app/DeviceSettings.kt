package dev.notifier.app

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import java.time.Instant

@Composable fun DeviceSettings(m: ClientModel) {
    val focus = LocalFocusManager.current
    var packageText by remember { mutableStateOf("") }
    var preview by remember { mutableStateOf<PairingPackage?>(null) }
    var packageError by remember { mutableStateOf<String?>(null) }
    var rotateConfirm by remember(m.connection?.namespace, m.device?.credential_version) { mutableStateOf(false) }
    var revokeTarget by remember(m.connection?.namespace, m.device?.credential_version) { mutableStateOf<DeviceEntry?>(null) }
    var selfRevokeConfirm by remember(m.connection?.namespace) { mutableStateOf(false) }
    var replayConfirm by remember(m.authOperation?.id) { mutableStateOf(false) }
    val operation = m.authOperation
    if (operation != null) {
        Text("原身份操作待对账", style = MaterialTheme.typography.titleLarge)
        Text("${when (operation.kind) { "pair" -> "配对"; "rotate" -> "凭据轮换"; else -> "设备撤销" }} · ${operation.root}")
        Text("原请求 ${operation.id}${operation.target?.let { "\n目标设备 $it" } ?: ""}", style = MaterialTheme.typography.bodySmall)
        Text("不要更换配对包、凭据、请求 ID 或服务。401、找不到和网络中断都不能证明原操作未执行。")
        Button(onClick = { focus.clearFocus(); m.reconcileIdentity() }, enabled = !m.busy) { Text("查询原身份操作") }
        TextButton(onClick = { replayConfirm = !replayConfirm }, enabled = !m.busy) { Text("原请求仍无法查到？") }
        if (replayConfirm) {
            Text("只重放本机已保存的同一正文、目标与凭据，不创建新身份。请保留此原意图继续核验。", style = MaterialTheme.typography.bodySmall)
            OutlinedButton(onClick = { focus.clearFocus(); replayConfirm = false; m.reconcileIdentity(true) }, enabled = !m.busy) { Text("重放同一身份请求") }
        }
    } else {
        Text("配对你的事件服务", style = MaterialTheme.typography.titleLarge)
        Text("粘贴管理员提供的一次性配对包。先核对服务根与能力，再确认连接；不会读取旧聊天或自动发送回应。", style = MaterialTheme.typography.bodySmall)
        if (preview == null) {
            OutlinedTextField(packageText, { value ->
                if (value.toByteArray(Charsets.UTF_8).size <= 8192) { packageText = value; packageError = null }
                else packageError = "配对包最多 8192 字节，未截断或替换原输入"
            }, label = { Text("一次性配对包") }, supportingText = { Text(packageError ?: "secret 不回显；预览只在本机解析，不联网") }, isError = packageError != null,
                visualTransformation = PasswordVisualTransformation(), minLines = 2, maxLines = 4, enabled = !m.busy && !m.pending, modifier = Modifier.fillMaxWidth())
            Button(onClick = {
                focus.clearFocus()
                try { preview = PairingPackage.parse(packageText, BuildConfig.DEBUG); packageText = ""; packageError = null }
                catch (_: Exception) { packageError = "配对包格式或范围不受支持，请核对管理员提供的原包" }
            }, enabled = !m.busy && !m.pending && packageText.isNotBlank()) { Text("预览配对范围") }
        }
        preview?.let { pkg ->
            Text("服务：${pkg.base}", style = MaterialTheme.typography.titleMedium)
            Text("所有者：${pkg.owner_id}\n设备标签：${pkg.label}\n能力：${if (pkg.manage_devices) "个人操作与同所有者设备管理" else "个人操作与自身凭据管理"}\n到期（UTC）：${Instant.ofEpochMilli(pkg.expires_at)}")
            if (pkg.base.startsWith("http:")) Text("调试回环 HTTP，只用于本机隔离验证。", style = MaterialTheme.typography.bodySmall)
            if (m.connection != null) Text("确认后切换连接并隔离旧内容缓存。这是新设备配对，不是原设备的安全轮换。", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { focus.clearFocus(); preview = null; m.pair(pkg) }, enabled = !m.busy && !m.pending) { Text("确认范围并配对") }
                TextButton(onClick = { preview = null }, enabled = !m.busy) { Text("取消预览") }
            }
        }
        if (m.pending) Text("有原未决提交，不能新配对或切换连接；同设备安全轮换不会丢弃原提交。", style = MaterialTheme.typography.bodySmall)
    }
    if (m.connection != null) {
        HorizontalDivider()
        Text("当前设备与凭据", style = MaterialTheme.typography.titleLarge)
        val device = m.device
        if (device == null) Text("尚未查询受管设备信息。旧静态用户仍可使用原功能，但安全轮换前须由运维精确接续，不靠手工换 token 猜身份。", style = MaterialTheme.typography.bodySmall)
        else {
            Text("${device.label} · 凭据 v${device.credential_version}${if (device.revoked) " · 本机已核实撤销" else ""}", style = MaterialTheme.typography.titleMedium)
            Text("设备 ${device.device_id}\n所有者 ${device.owner_id}\n${if (device.manage_devices) "有明确设备管理能力" else "仅个人操作与自身凭据管理"}", style = MaterialTheme.typography.bodySmall)
            Text("本机保存的信息不是实时权限。已有凭据不显示；服务会在每次操作时核验。", style = MaterialTheme.typography.bodySmall)
        }
        if (device?.revoked != true) {
            OutlinedButton(onClick = { m.refreshIdentity() }, enabled = !m.busy && operation == null) { Text("查询当前设备身份") }
            OutlinedButton(onClick = { rotateConfirm = !rotateConfirm; selfRevokeConfirm = false }, enabled = !m.busy && operation == null) { Text("安全轮换本设备凭据") }
            if (rotateConfirm) {
                Text("只更新同一设备的认证。原未决提交 ID/正文、离线缓存、推送实例与提醒水位都保留；不会自动重发回应。", style = MaterialTheme.typography.bodySmall)
                Button(onClick = { focus.clearFocus(); rotateConfirm = false; m.rotateCredential() }, enabled = !m.busy && operation == null) { Text("确认同设备轮换") }
            }
            TextButton(onClick = { selfRevokeConfirm = !selfRevokeConfirm; rotateConfirm = false }, enabled = !m.busy && !m.pending && operation == null && device != null) { Text("撤销本设备 API 凭据") }
            if (selfRevokeConfirm) {
                Text("将撤销当前设备 ${device?.device_id ?: "（以本次认证查询为准）"} 的后续 API 访问。不是取消已保存回应或未知来源效果；本机连接与缓存不会自动删除。", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedButton(onClick = { focus.clearFocus(); selfRevokeConfirm = false; m.revokeDevice() }, enabled = !m.busy && !m.pending && operation == null && device != null) { Text("确认撤销本设备") }
            }
            OutlinedButton(onClick = { m.listDevices() }, enabled = !m.busy && operation == null) { Text("查询同所有者设备") }
        } else Text("此连接只保留离线阅读，不恢复通用认证。需要时可显式移除本机连接，已保存工作仍须在服务核验。", style = MaterialTheme.typography.bodySmall)
        m.deviceListObserved?.let { time ->
            Text("设备列表观察：$time", style = MaterialTheme.typography.labelSmall)
            if (m.deviceEntries.isEmpty()) Text("本次没有可见设备。", style = MaterialTheme.typography.bodySmall)
            m.deviceEntries.forEach { entry ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                    Text(entry.label, style = MaterialTheme.typography.titleSmall)
                    Text("${entry.device_id}\n${entry.state} · 凭据 v${entry.credential_version}", style = MaterialTheme.typography.bodySmall)
                    if (device?.manage_devices == true && entry.device_id != device.device_id && entry.state == "active") TextButton(onClick = { revokeTarget = entry }, enabled = !m.busy && operation == null) { Text("撤销此设备访问") }
                }
            }
        }
        revokeTarget?.let { target ->
            Text("撤销「${target.label}」(${target.device_id}) 的后续访问？不会删除其已保存回应、历史或未知效果。", style = MaterialTheme.typography.bodySmall)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { focus.clearFocus(); revokeTarget = null; m.revokeDevice(target.device_id) }, enabled = !m.busy && operation == null) { Text("确认撤销该设备") }
                TextButton(onClick = { revokeTarget = null }, enabled = !m.busy) { Text("保留该设备") }
            }
        }
    }
}
