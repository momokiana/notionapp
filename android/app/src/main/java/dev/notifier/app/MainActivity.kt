package dev.notifier.app

import android.app.Application
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var requested by mutableStateOf<Pair<String, String>?>(null)
    private fun notification(intent: Intent?): Pair<String, String>? {
        val namespace = intent?.getStringExtra("namespace") ?: return null
        val event = intent.getStringExtra("event_id") ?: return null
        return if (namespace.matches(Regex("[a-f0-9]{64}")) && event.matches(Regex("[A-Za-z0-9][A-Za-z0-9_-]{0,79}"))) namespace to event else null
    }
    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); requested = notification(intent) }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Match status/navigation icon contrast to the same system theme as MaterialTheme.
        enableEdgeToEdge()
        requested = notification(intent)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                Surface(Modifier.fillMaxSize()) { Client(viewModel(), requested) { requested = null } }
            }
        }
    }
}
class ClientModel(app: Application) : AndroidViewModel(app) {
    private val localState = PrivateState(app)
    private val ledger = Ledger(localState, HttpTransport())
    private val draftBook = ResponseDrafts(localState, ledger)
    private val reviewGate = DraftReviewGate()
    var drafts by mutableStateOf<List<ResponseDraft>>(emptyList()); private set
    var isolatedDrafts by mutableStateOf<List<ResponseDraft>>(emptyList()); private set
    var templates by mutableStateOf<List<ReplyTemplate>>(emptyList()); private set
    var workspaceBytes by mutableStateOf(0); private set
    var draftReview by mutableStateOf<DraftConfirmation?>(null); private set
    fun cancelDraftReview() { reviewGate.invalidate(); draftReview = null }
    private val devices = DeviceClient(localState, HttpTransport(), BuildConfig.DEBUG)
    private val runtimeClient = SourceRuntimeClient(localState, HttpTransport())
    private val inbox = OfflineInbox(ledger, PrivateInbox(app))
    private var foreground = false
    private var refreshRequested = false
    var connection by mutableStateOf<Connection?>(null); private set
    var pending by mutableStateOf(false); private set
    private var pendingId: String? = null
    var device by mutableStateOf<ManagedDevice?>(null); private set
    var authOperation by mutableStateOf<AuthSummary?>(null); private set
    var deviceEntries by mutableStateOf<List<DeviceEntry>>(emptyList()); private set
    var deviceListObserved by mutableStateOf<String?>(null); private set
    val canWrite: Boolean get() = authOperation == null && device?.revoked != true
    var ready by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    var message by mutableStateOf<String?>(null); private set
    var events by mutableStateOf<List<Event>>(emptyList()); private set
    var current by mutableStateOf<Event?>(null); private set
    var history by mutableStateOf<List<History>>(emptyList()); private set
    var historyNext by mutableStateOf<String?>(null); private set
    var receipt by mutableStateOf<String?>(null); private set
    var lastSync by mutableStateOf<String?>(null); private set
    var cacheUnavailable by mutableStateOf(false); private set
    var currentAt by mutableStateOf<String?>(null); private set
    var historyAt by mutableStateOf<String?>(null); private set
    var receiptAt by mutableStateOf<String?>(null); private set
    var localNotice by mutableStateOf<String?>(null); private set
    var sourceRuntimeRead by mutableStateOf<SourceRuntimeRead?>(null); private set
    var currentFresh by mutableStateOf(false); private set
    init { work {
        val state = withContext(Dispatchers.IO) { ledger.state() }
        applyLocal(state); ready = true
        if (connection != null) { showCache(); refreshInside() }
    } }
    fun foreground(active: Boolean) {
        foreground = active
        if (active) autoRefresh() else { refreshRequested = false; currentFresh = false; cancelDraftReview() }
    }
    fun autoRefresh() {
        if (!foreground || !ready || connection == null) return
        if (busy) { refreshRequested = true; return }
        work { refreshInside(); current?.let { detailInside(it.id) } }
    }
    private fun work(action: suspend () -> Unit) {
        if (busy) return
        cancelDraftReview()
        busy = true; error = null; message = null
        viewModelScope.launch {
            try { action() }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) {
                currentFresh = false
                if (e is InboxCacheReadFailure) cacheUnavailable = true
                error = if (e is ApiFailure || e is IllegalArgumentException || e is IllegalStateException) e.message else "连接或安全存储操作失败，已显示内容可能是缓存。若有未决提交，请保留原请求对账。"
            }
            finally {
                runCatching { withContext(Dispatchers.IO) { ledger.state() } }.onSuccess { applyLocal(it) }
                busy = false
                if (refreshRequested) { refreshRequested = false; autoRefresh() }
            }
        }
    }
    private fun boundWork(action: suspend (ConnectionSnapshot) -> Unit) {
        val expected = ConnectionSnapshot(connection?.namespace)
        work { action(expected) }
    }
    private fun applyLocal(state: LocalState) {
        if (connection?.namespace != state.connection?.namespace || state.auth_intent != null || state.pending != null || state.device?.revoked == true || draftReview?.draft?.let { it !in state.drafts } == true) cancelDraftReview()
        drafts = state.drafts.filter { it.namespace == state.connection?.namespace }
        isolatedDrafts = state.drafts.filter { it.namespace != state.connection?.namespace }
        templates = state.templates
        workspaceBytes = wire.encodeToString(LocalState.serializer(), state).toByteArray(Charsets.UTF_8).size + 28
        if (connection?.namespace != state.connection?.namespace) {
            deviceEntries = emptyList(); deviceListObserved = null; events = emptyList(); current = null; history = emptyList(); receipt = null; lastSync = null; currentFresh = false; sourceRuntimeRead = null
        }
        connection = state.connection; pending = state.pending != null; pendingId = state.pending?.id; device = state.device
        authOperation = state.auth_intent?.let { AuthSummary(it.kind, it.id, it.root, it.target_device) }
    }
    fun connect(base: String, token: String) = boundWork { expected ->
        val c = Connection.parse(base, token, BuildConfig.DEBUG)
        val previousNamespace = connection?.namespace
        withContext(Dispatchers.IO) { ledger.connect(c, expected) }
        applyLocal(withContext(Dispatchers.IO) { ledger.state() })
        val changed = previousNamespace != connection?.namespace
        deviceEntries = emptyList(); events = emptyList(); current = null; history = emptyList(); receipt = null; lastSync = null; currentFresh = false
        if (changed) withContext(Dispatchers.IO) { inbox.reset() }
        showCache(); refreshInside(); message = "连接已保存；凭据不回显"
    }
    fun disconnect() = boundWork { expected ->
        withContext(Dispatchers.IO) { ledger.disconnect(expected) }
        applyLocal(withContext(Dispatchers.IO) { ledger.state() }); deviceEntries = emptyList(); events = emptyList(); current = null; history = emptyList(); receipt = null; lastSync = null; currentFresh = false
        withContext(Dispatchers.IO) { inbox.reset() }
    }
    private suspend fun identityResult(previousNamespace: String?, kind: String) {
        applyLocal(withContext(Dispatchers.IO) { ledger.state() }); currentFresh = false; deviceEntries = emptyList(); deviceListObserved = null
        if (previousNamespace != connection?.namespace) {
            events = emptyList(); current = null; history = emptyList(); receipt = null; lastSync = null
            withContext(Dispatchers.IO) { inbox.reset() }; showCache(); refreshInside()
        } else showCache()
        message = when (kind) {
            "pair" -> "配对身份已核实，连接已切换；这是新设备，不继承旧连接的提交或推送。"
            "rotate" -> "同一设备新凭据已核实，原未决提交和推送绑定保留。对账原提交仍须明确操作。"
            else -> "原撤销事实已核实；撤销不会取消已保存回应或未知来源效果。"
        }
    }
    fun pair(pkg: PairingPackage) = boundWork { expected -> withContext(Dispatchers.IO) { devices.pair(pkg, expected) }; identityResult(expected.namespace, "pair") }
    fun refreshIdentity() = boundWork { expected -> withContext(Dispatchers.IO) { devices.refreshIdentity(expected) }; message = "已查询当前凭据对应设备；能力仍由服务在每次操作时核验。" }
    fun listDevices() = boundWork { expected -> deviceEntries = withContext(Dispatchers.IO) { devices.devices(expected) }; deviceListObserved = java.time.Instant.now().toString(); message = "已查询同所有者设备，状态可能随后变化。" }
    fun rotateCredential() = boundWork { expected -> currentFresh = false; withContext(Dispatchers.IO) { devices.rotate(expected) }; identityResult(expected.namespace, "rotate") }
    fun revokeDevice(target: String? = null) = boundWork { expected -> currentFresh = false; withContext(Dispatchers.IO) { devices.revoke(target, expected) }; identityResult(expected.namespace, "revoke") }
    fun reconcileIdentity(replay: Boolean = false) {
        val operation = authOperation ?: return
        boundWork { expected ->
            withContext(Dispatchers.IO) { if (replay) devices.replayOriginal(expected, operation.id) else devices.reconcile(expected, operation.id) }; identityResult(expected.namespace, operation.kind)
        }
    }
    private fun show(cache: InboxCache) {
        cacheUnavailable = false
        events = cache.list_ids.mapNotNull { cache.events[it]?.event }; lastSync = cache.scanned_at
        current?.let { previous ->
            current = cache.events[previous.id]?.event
            currentAt = cache.events[previous.id]?.observed_at
            history = cache.histories[previous.id]?.items ?: emptyList(); historyNext = cache.histories[previous.id]?.next_after
            historyAt = cache.histories[previous.id]?.observed_at
            receipt = cache.receipts[previous.id]?.response?.let { responseStatus(it) }; receiptAt = cache.receipts[previous.id]?.observed_at
        }
    }
    private suspend fun readLocalNotice() {
        val event = current
        val c = connection
        localNotice = if (event == null || c == null) null else withContext(Dispatchers.IO) {
            runCatching {
                val records = PushController.records(getApplication(), c.namespace).snapshot().deliveries
                listOfNotNull(event.notification_delivery, event.previous_notification_delivery).distinctBy { it.id }
                    .mapNotNull { localNoticeStatus(event.id, it, records[it.id]) }.takeIf { it.isNotEmpty() }?.joinToString("\n")
            }.getOrDefault("本机提醒账本不可读，无法确认本机投递状态；原记录未重置。")
        }
    }
    private suspend fun showCache() { show(withContext(Dispatchers.IO) { inbox.snapshot() }); readLocalNotice() }
    private suspend fun refreshInside() { show(withContext(Dispatchers.IO) { inbox.refresh() }); readLocalNotice() }
    fun refresh() = work { refreshInside() }
    private suspend fun readSourceRuntime(event: Event) {
        val expected = ConnectionSnapshot(connection?.namespace)
        sourceRuntimeRead = null
        val result = try { withContext(Dispatchers.IO) { runtimeClient.read(event, expected) } }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: ApiFailure) { if (e.status == 401 || e.status == 409) throw e else SourceRuntimeRead() }
        catch (_: Exception) { SourceRuntimeRead() }
        checkConnectionSnapshot(withContext(Dispatchers.IO) { ledger.state() }, expected)
        check(current?.id == event.id && current?.event_version == event.event_version) { "事件已改变，未应用迟到的来源观察" }
        sourceRuntimeRead = result
    }
    private suspend fun detailInside(id: String) {
        currentFresh = false
        current = withContext(Dispatchers.IO) { inbox.refreshEvent(id) }.event; showCache()
        withContext(Dispatchers.IO) { inbox.refreshHistory(id) }; showCache()
        withContext(Dispatchers.IO) { inbox.refreshReceipt(id) }; showCache()
        readSourceRuntime(current ?: error("详情关联已改变，未查询来源观察"))
        currentFresh = true
    }
    fun open(id: String) = work {
        currentFresh = false; current = null; history = emptyList(); historyNext = null; receipt = null; currentAt = null; historyAt = null; receiptAt = null; sourceRuntimeRead = null
        val cache = withContext(Dispatchers.IO) { inbox.snapshot() }
        current = cache.events[id]?.event
        if (current != null) { show(cache); readLocalNotice() } else localNotice = null
        // A new notification may refer to an event not yet in the cached list.
        detailInside(id)
    }
    fun back() { val reviewing = draftReview != null; cancelDraftReview(); if (!busy && !reviewing) { current = null; history = emptyList(); receipt = null; currentFresh = false; sourceRuntimeRead = null } }
    fun saveDraft(event: Event, action: Action, text: String, saved: () -> Unit = {}) = boundWork { expected ->
        withContext(Dispatchers.IO) { draftBook.create(event, action, text, expected) }; saved(); message = "草稿仅保存于本机，尚未提交；联网后请核对并确认。"
    }
    fun editDraft(draft: ResponseDraft, text: String) = boundWork { expected -> withContext(Dispatchers.IO) { draftBook.edit(draft, text, expected) }; message = "原草稿文字已保存，未改绑问题或发送。" }
    fun deleteDraft(draft: ResponseDraft) = boundWork { expected -> withContext(Dispatchers.IO) { draftBook.delete(draft, expected) }; message = "已删除这份未发送草稿，不影响已提交或未知请求。" }
    fun deleteIsolatedDrafts(original: List<ResponseDraft>) = boundWork { expected -> withContext(Dispatchers.IO) { draftBook.deleteIsolated(expected, original) }; message = "已删除确认的隔离草稿，未删除原未决请求。" }
    fun saveTemplate(previous: ReplyTemplate?, title: String, text: String) = boundWork { expected -> withContext(Dispatchers.IO) { draftBook.template(previous, title, text, expected) }; message = "快捷回复已保存于本机，不会自动发送。" }
    fun deleteTemplate(previous: ReplyTemplate) = boundWork { expected -> withContext(Dispatchers.IO) { draftBook.deleteTemplate(previous, expected) } }
    fun prepareDraft(draft: ResponseDraft) = boundWork { expected ->
        val ticket = reviewGate.ticket()
        val confirmation = withContext(Dispatchers.IO) { draftBook.prepare(draft, expected) }
        if (foreground && reviewGate.accepts(ticket)) draftReview = confirmation
    }
    fun submitDraft() {
        val confirmation = draftReview ?: return
        boundWork { expected ->
            val ticket = reviewGate.ticket()
            withContext(Dispatchers.IO) { ledger.submitDraft(confirmation, expected) { reviewGate.accepts(ticket) } }
            current?.let { detailInside(it.id) }
            message = "回应已保存；草稿已移出，来源交付仍须另核回执。"
        }
    }
    fun reloadDetail() = current?.let { open(it.id) }
    fun moreHistory() = current?.let { e -> work { withContext(Dispatchers.IO) { inbox.moreHistory(e.id) }; showCache() } }
    private fun requireFresh() { check(currentFresh) { "缓存只供阅读，请先在线刷新详情再操作" } }
    fun markRead() = current?.let { e -> boundWork { expected -> requireFresh(); withContext(Dispatchers.IO) { ledger.read(e, expected) }; detailInside(e.id); message = "所见版本已标为已读；不代表事项完成" } }
    fun respond(action: Action, text: String) = current?.let { e -> boundWork { expected -> requireFresh(); withContext(Dispatchers.IO) { ledger.respond(e, action, text, expected) }; detailInside(e.id); message = "回应已保存，来源交付需另核回执" } }
    fun decide(value: String) = current?.let { e -> boundWork { expected -> requireFresh(); withContext(Dispatchers.IO) { ledger.decide(e, value, expected) }; detailInside(e.id); message = "事项决定已保存，不代表取消来源效果" } }
    fun notificationMismatch() { error = "此通知属于其他连接，未打开或提交任何操作。恢复原连接后刷新收件箱。" }
    fun recover() {
        val id = pendingId
        boundWork { expected -> withContext(Dispatchers.IO) { ledger.recover(expected, id) }; message = "原请求已对账"; current?.let { detailInside(it.id) } ?: refreshInside() }
    }
}

@Composable private fun Client(m: ClientModel, navigation: Pair<String, String>?, consumed: () -> Unit) {
    ReadOnlyAutoSync(m)
    LaunchedEffect(navigation, m.ready, m.busy) {
        if (navigation != null && m.ready && !m.busy) {
            if (m.connection?.namespace == navigation.first) m.open(navigation.second) else m.notificationMismatch()
            consumed()
        }
    }
    var settings by remember { mutableStateOf(false) }
    BackHandler(enabled = m.current != null || m.draftReview != null) { m.back() }
    Column(Modifier.fillMaxSize().safeDrawingPadding().imePadding().widthIn(max = 840.dp).padding(horizontal = 20.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(if (m.draftReview != null) "确认待提交回应" else if (settings) "连接与自定义" else if (m.current != null) "事件详情" else "收件箱", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.padding(vertical = 20.dp))
            TextButton(onClick = { m.cancelDraftReview(); settings = !settings }, enabled = !m.busy) { Text(if (settings) "收件箱" else "设置") }
        }
        if (m.busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        m.error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(vertical = 8.dp)) }
        m.message?.let { Text(it, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(vertical = 8.dp)) }
        if (m.pending) {
            Text("有未决提交：不要重复选择。保留原连接，先查询原 ID。", style = MaterialTheme.typography.bodyMedium)
            OutlinedButton(onClick = { m.recover() }, enabled = !m.busy && m.canWrite) { Text("对账原请求") }
        }
        if (!m.ready) { Text("安全存储尚未就绪，不能提交新操作"); return@Column }
        if (m.authOperation != null && !settings) TextButton(onClick = { settings = true }, enabled = !m.busy) { Text("对账原身份操作") }
        m.draftReview?.let { DraftConfirmationScreen(m, it) }
            ?: if (settings || m.connection == null) Settings(m)
            else m.current?.let { Detail(m, it) } ?: Inbox(m)
    }
}
@Composable private fun Settings(m: ClientModel) {
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    var base by remember(m.connection?.base) { mutableStateOf(m.connection?.base ?: "") }
    var token by remember { mutableStateOf("") }
    var advanced by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().verticalScrollCompat(), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        WorkspaceSettings(m)
        HorizontalDivider()
        DeviceSettings(m)
        HorizontalDivider()
        TextButton(onClick = { advanced = !advanced }, enabled = !m.busy) { Text(if (advanced) "收起高级手工连接" else "高级：手工地址与 token") }
        if (advanced) {
            Text("手工连接不证明是原设备的轮换，也不能继承未决提交。已有凭据不回显。", style = MaterialTheme.typography.bodySmall)
            val editable = !m.busy && !m.pending && m.authOperation == null
            OutlinedTextField(base, { base = it }, label = { Text("HTTPS 服务地址") }, enabled = editable, singleLine = true, modifier = Modifier.fillMaxWidth(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri))
            OutlinedTextField(token, { token = it }, label = { Text("用户 token") }, enabled = editable, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
            Button(onClick = { focus.clearFocus(); m.connect(base, token); token = "" }, enabled = editable && token.isNotBlank()) { Text("保存并连接") }
        }
        if (m.connection != null) {
            Text("已配置：${m.connection?.base}")
            OutlinedButton(onClick = { m.disconnect() }, enabled = !m.busy && !m.pending && m.authOperation == null) { Text("移除本机连接") }
        }
        PushSettings(m.connection, !m.busy, m.events.map { it.source_id }.distinct(), registrationEnabled = m.canWrite)
        Text("连接成功不代表来源在线、推送必达或外部已执行。", style = MaterialTheme.typography.bodySmall)
    }
}
@Composable private fun Inbox(m: ClientModel) {
    var unread by remember { mutableStateOf(false) }
    var actionable by remember { mutableStateOf(false) }
    var source by remember { mutableStateOf<String?>(null) }
    var sourcesOpen by remember { mutableStateOf(false) }
    val shown = filterInbox(m.events, source, unread, actionable)
    LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
    Button(onClick = { m.refresh() }, enabled = !m.busy) { Text("刷新收件箱") }
    if (m.drafts.isNotEmpty()) {
        Text("本机待提交草稿 ${m.drafts.size} 份，尚未发送", style = MaterialTheme.typography.titleSmall)
        m.drafts.forEach { DraftRow(m, it) }
        HorizontalDivider()
    }
    Text(if (m.cacheUnavailable) "本机离线缓存不可用，原文件保留；这不表示服务端没有事件。" else m.lastSync?.let { "本机缓存 · 最后完整扫描 $it\n非实时状态；刷新会从头检查所有已创建事件。" } ?: "尚未完成同步。联网刷新后可离线阅读。", style = MaterialTheme.typography.labelSmall)
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        FilterChip(unread, { unread = !unread }, label = { Text("未读") })
        FilterChip(actionable, { actionable = !actionable }, label = { Text("待回应") })
        Box {
            FilterChip(source != null, { sourcesOpen = true }, label = { Text(source ?: "所有来源", maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }, modifier = Modifier.widthIn(max = 220.dp))
            DropdownMenu(sourcesOpen, { sourcesOpen = false }) {
                DropdownMenuItem(text = { Text("所有来源") }, onClick = { source = null; sourcesOpen = false })
                m.events.map { it.source_id }.distinct().sorted().forEach { id -> DropdownMenuItem(text = { Text(id) }, onClick = { source = id; sourcesOpen = false }) }
            }
        }
    }
    Text("过滤仅限本机已同步内容；待回应状态可能已变化。", style = MaterialTheme.typography.labelSmall)
    if (shown.isEmpty() && !m.busy && !m.cacheUnavailable) Text(if (m.lastSync == null) "没有可离线查看的内容，请连接服务后刷新。" else if (m.events.isEmpty()) "上次完整扫描没有可见事件。" else "当前过滤下没有事件。", modifier = Modifier.padding(vertical = 24.dp))
        }
        items(shown, key = { it.id }) { e ->
            Column(Modifier.fillMaxWidth().clickable(enabled = !m.busy) { m.open(e.id) }.padding(vertical = 16.dp)) {
                Text(e.title, style = MaterialTheme.typography.titleMedium)
                Text("${e.source_id} · ${dispositionLabel(e.disposition)} · ${if (e.read_state.unread) "未读" else "已读"}${if (e.can_respond) " · 待回应" else ""}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                Text(e.body, maxLines = 3, style = MaterialTheme.typography.bodyMedium)
                Text("v${e.event_version} · ${e.updated_at}", style = MaterialTheme.typography.labelSmall)
            }
            HorizontalDivider()
        }
    }
}
@Composable private fun Detail(m: ClientModel, e: Event) {
    var confirm by remember(e.id, e.event_version) { mutableStateOf<String?>(null) }
    LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { Row { TextButton(onClick = { m.back() }, enabled = !m.busy) { Text("返回收件箱") }; TextButton(onClick = { m.reloadDetail() }, enabled = !m.busy) { Text("刷新详情") } } }
        item {
            Text(if (m.currentFresh) "本次已在线刷新，提交时仍会核验版本与权限。" else "缓存只供阅读，请在线刷新详情后再操作。", color = MaterialTheme.colorScheme.primary)
            Text("详情观察：${m.currentAt ?: "未同步"}", style = MaterialTheme.typography.labelSmall)
            Text(e.title, style = MaterialTheme.typography.headlineMedium)
            Text("${e.source_id} · v${e.event_version} · ${dispositionLabel(e.disposition)}", style = MaterialTheme.typography.labelLarge)
            Text(e.body, modifier = Modifier.padding(top = 12.dp))
        }
        item {
            Text(sourceRuntimeText(m.sourceRuntimeRead), style = MaterialTheme.typography.bodySmall)
            Text("来源自报 · 结果未核验", style = MaterialTheme.typography.titleSmall)
            Text(notificationStatus(e) + "\n有效期：${e.expires_at}", style = MaterialTheme.typography.bodySmall)
            m.receipt?.let { Text("回执观察：${m.receiptAt}\n$it", style = MaterialTheme.typography.bodySmall) }
            m.localNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            OutlinedButton(onClick = { m.markRead() }, enabled = m.currentFresh && !m.busy && m.canWrite && e.read_state.unread) { Text(if (e.read_state.unread) "标记所见版本已读" else "所见版本已读") }
        }
        item {
            ResponseComposer(m, e)
            m.drafts.filter { it.event_id == e.id }.forEach { DraftRow(m, it) }
        }
        item {
            Text("事项决定", style = MaterialTheme.typography.titleMedium)
            Text("只改变跟踪状态，不表示来源已取消或执行完成。", style = MaterialTheme.typography.bodySmall)
            listOf("open", "paused", "completed", "not_tracking").filter { it != e.disposition }.forEach { d ->
                OutlinedButton(onClick = { confirm = d }, enabled = m.currentFresh && !m.busy && !m.pending && m.canWrite, modifier = Modifier.padding(end = 8.dp)) { Text(dispositionLabel(d)) }
            }
            confirm?.let { d ->
                Text("将事项设为「${dispositionLabel(d)}」？")
                Row { Button(onClick = { confirm = null; m.decide(d) }, enabled = m.currentFresh && !m.busy && !m.pending && m.canWrite) { Text("保存事项决定") }; TextButton(onClick = { confirm = null }) { Text("保留原状态") } }
            }
        }
        item { HorizontalDivider(); Text("事件历史", style = MaterialTheme.typography.titleMedium); Text("已缓存 ${m.history.size} 条 · 前缀观察 ${m.historyAt ?: "未同步"}${if (m.historyNext != null) " · 后续尚未全部加载" else ""}", style = MaterialTheme.typography.labelSmall) }
        items(m.history, key = { it.seq }) { h ->
            Column { Text("${h.kind} · ${h.created_at}", style = MaterialTheme.typography.labelMedium); Text(historyText(h), style = MaterialTheme.typography.bodyMedium) }
        }
        if (m.historyNext != null) item { OutlinedButton(onClick = { m.moreHistory() }, enabled = !m.busy) { Text("加载更多历史") } }
        item { Spacer(Modifier.height(24.dp)) }
    }
}
private fun dispositionLabel(value: String) = mapOf("open" to "继续跟踪", "paused" to "暂停", "completed" to "用户标记完成", "not_tracking" to "不再跟踪")[value] ?: value
@Composable private fun Modifier.verticalScrollCompat(): Modifier = verticalScroll(rememberScrollState())
