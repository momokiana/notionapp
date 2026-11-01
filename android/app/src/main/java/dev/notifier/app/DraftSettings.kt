package dev.notifier.app

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp

@Composable internal fun ReplyPicker(templates: List<ReplyTemplate>, enabled: Boolean, append: (String) -> Unit) {
    if (templates.isNotEmpty()) {
        Text("快捷回复：点击追加，不会发送", style = MaterialTheme.typography.labelMedium)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            templates.forEach { template -> OutlinedButton(onClick = { append(template.text) }, enabled = enabled) { Text(template.title) } }
        }
    }
}

@Composable internal fun ResponseComposer(m: ClientModel, event: Event) {
    Text("回应当前问题", style = MaterialTheme.typography.titleMedium)
    Text("草稿仅在本机待提交，网络恢复不会自动发送。", style = MaterialTheme.typography.bodySmall)
    if (!event.can_respond) Text("所见版本不可回应；可整理本机草稿，但发送须联网重新核对。")
    event.interaction?.actions?.forEach { action ->
        key(m.connection?.namespace, event.id, event.interaction_version, action.id) {
            var text by remember { mutableStateOf("") }
            var error by remember { mutableStateOf<String?>(null) }
            if (action.type == "text") {
                OutlinedTextField(text, { if (boundedText(it, 4000)) { text = it; error = null } else error = "最多4000字符，原文字未改变" },
                    label = { Text(action.label) }, enabled = !m.busy, modifier = Modifier.fillMaxWidth(),
                    supportingText = { Text("编辑中文字尚未保存 · ${text.codePointCount(0, text.length)}/4000") })
                ReplyPicker(m.templates, !m.busy) { value ->
                    runCatching { appendReplyText(text, value) }.onSuccess { text = it; error = null }.onFailure { error = it.message }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
            val filled = action.type != "text" || text.isNotBlank()
            OutlinedButton(onClick = { m.saveDraft(event, action, if (action.type == "text") text else "") { text = "" } }, enabled = !m.busy && filled && m.drafts.size + m.isolatedDrafts.size < MAX_RESPONSE_DRAFTS) {
                Text(if (action.type == "text") "保存文字待提交草稿" else "保存「${action.label}」待提交草稿")
            }
            Button(onClick = { m.respond(action, if (action.type == "text") text else "") }, enabled = m.currentFresh && event.can_respond && !m.pending && !m.busy && m.canWrite && filled) {
                Text(if (action.type == "text") "在线提交${action.label}" else "在线提交：${action.label}")
            }
        }
    }
    if (m.drafts.size + m.isolatedDrafts.size >= MAX_RESPONSE_DRAFTS) Text("草稿已达8份，请先处理或在设置中删除未发送草稿。", color = MaterialTheme.colorScheme.error)
}

@Composable internal fun DraftRow(m: ClientModel, draft: ResponseDraft) {
    var editing by remember(draft) { mutableStateOf(false) }
    var text by remember(draft) { mutableStateOf(draft.text) }
    var deleting by remember(draft) { mutableStateOf(false) }
    var error by remember(draft) { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("待提交 · ${draft.title}", style = MaterialTheme.typography.titleSmall)
        Text("${draft.action.label} · 原 v${draft.event_version} · ${draft.saved_at}", style = MaterialTheme.typography.labelSmall)
        if (editing) {
            OutlinedTextField(text, { if (boundedText(it, 4000)) text = it else error = "最多4000字符" }, label = { Text("修改原草稿文字，不改绑问题") }, enabled = !m.busy, modifier = Modifier.fillMaxWidth())
            ReplyPicker(m.templates, !m.busy) { value -> runCatching { appendReplyText(text, value) }.onSuccess { text = it; error = null }.onFailure { error = it.message } }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row {
                Button(onClick = { m.editDraft(draft, text) }, enabled = !m.busy && text.isNotBlank()) { Text("保存草稿修改") }
                TextButton(onClick = { editing = false; text = draft.text }) { Text("取消修改") }
            }
        } else {
            if (draft.text.isNotEmpty()) Text(draft.text, style = MaterialTheme.typography.bodyMedium)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { m.prepareDraft(draft) }, enabled = !m.busy && !m.pending && m.canWrite) { Text("联网核对草稿") }
                if (draft.action.type == "text") TextButton(onClick = { editing = true; m.cancelDraftReview() }, enabled = !m.busy) { Text("编辑文字") }
                TextButton(onClick = { deleting = true; m.cancelDraftReview() }, enabled = !m.busy) { Text("删除草稿") }
            }
        }
        if (deleting) {
            Text("仅删除这份尚未发送的本机草稿？不会取消已保存回应。")
            FlowRow {
                TextButton(onClick = { m.deleteDraft(draft) }, enabled = !m.busy) { Text("确认删除草稿") }
                TextButton(onClick = { deleting = false }) { Text("保留草稿") }
            }
        }
    }
}

@Composable internal fun DraftConfirmationScreen(m: ClientModel, confirmation: DraftConfirmation) {
    val event = confirmation.current
    val draft = confirmation.draft
    LazyColumn(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        item { TextButton(onClick = { m.cancelDraftReview() }) { Text("取消核对，保留草稿") } }
        item {
            Text("请重新确认当前问题", style = MaterialTheme.typography.headlineSmall)
            Text("草稿基于 v${draft.event_version}，将提交至已在线核对的 v${event.event_version}。提交前仍会再次核验。")
            Text("${event.source_id} · 有效期 ${event.expires_at}", style = MaterialTheme.typography.labelMedium)
        }
        item { Text(event.title, style = MaterialTheme.typography.titleLarge); Text(event.body) }
        item {
            HorizontalDivider()
            Text("将回应：${draft.action.label}", style = MaterialTheme.typography.titleMedium)
            Text(if (draft.text.isEmpty()) "按钮选择，无补充文字" else draft.text)
            Text("确认后先保存原请求，再向服务提交。服务保存不代表来源已执行。", style = MaterialTheme.typography.bodySmall)
        }
        item { Button(onClick = { m.submitDraft() }, enabled = !m.busy && !m.pending && m.canWrite) { Text("确认提交回应") } }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable internal fun WorkspaceSettings(m: ClientModel) {
    var showEditor by remember { mutableStateOf(false) }
    var previous by remember { mutableStateOf<ReplyTemplate?>(null) }
    var title by remember { mutableStateOf("") }
    var text by remember { mutableStateOf("") }
    var deletingTemplate by remember { mutableStateOf<ReplyTemplate?>(null) }
    var isolatedConfirmation by remember(m.isolatedDrafts) { mutableStateOf<List<ResponseDraft>?>(null) }
    LaunchedEffect(m.templates) { showEditor = false; deletingTemplate = null }
    Text("本机待提交与快捷回复", style = MaterialTheme.typography.titleLarge)
    Text("安全状态 ${m.workspaceBytes}/$MAX_LOCAL_STATE_BYTES 字节，包含原未决请求与身份意图。草稿/模板上限不保证能同时装满；超限保留原状态。", style = MaterialTheme.typography.bodySmall)
    Text("当前连接未发送草稿 ${m.drafts.size}/$MAX_RESPONSE_DRAFTS")
    m.drafts.forEach { DraftRow(m, it) }
    if (m.isolatedDrafts.isNotEmpty()) {
        Text("另有 ${m.isolatedDrafts.size} 份原连接隔离草稿，不向当前连接展示内容。恢复准确原连接可查看；移除连接不会删除它们。", style = MaterialTheme.typography.bodySmall)
        TextButton(onClick = { isolatedConfirmation = m.isolatedDrafts }, enabled = !m.busy) { Text("删除隔离的未发送草稿…") }
        isolatedConfirmation?.let { original ->
            Text("确认删除这 ${original.size} 份隔离草稿？此操作不可撤销，不会清除原未决提交。")
            FlowRow {
                TextButton(onClick = { m.deleteIsolatedDrafts(original) }, enabled = !m.busy) { Text("确认删除隔离草稿") }
                TextButton(onClick = { isolatedConfirmation = null }) { Text("保留隔离草稿") }
            }
        }
    }
    HorizontalDivider()
    Text("快捷回复 ${m.templates.size}/$MAX_REPLY_TEMPLATES", style = MaterialTheme.typography.titleMedium)
    Text("本机全局设置，跨助理/连接保留。只向编辑器追加文字，不创建权限、不自动提交。", style = MaterialTheme.typography.bodySmall)
    m.templates.forEach { template ->
        Text(template.title, style = MaterialTheme.typography.titleSmall)
        Text(template.text)
        FlowRow {
            TextButton(onClick = { previous = template; title = template.title; text = template.text; showEditor = true }, enabled = !m.busy) { Text("修改${template.title}") }
            TextButton(onClick = { deletingTemplate = template }, enabled = !m.busy) { Text("删除${template.title}") }
        }
    }
    deletingTemplate?.let { template ->
        Text("删除快捷回复「${template.title}」？已有草稿文字不会改变。")
        FlowRow {
            TextButton(onClick = { m.deleteTemplate(template) }, enabled = !m.busy) { Text("确认删除快捷回复") }
            TextButton(onClick = { deletingTemplate = null }) { Text("保留快捷回复") }
        }
    }
    if (!showEditor) OutlinedButton(onClick = { previous = null; title = ""; text = ""; showEditor = true }, enabled = !m.busy && m.templates.size < MAX_REPLY_TEMPLATES) { Text("新增快捷回复") }
    if (showEditor) {
        OutlinedTextField(title, { if (boundedText(it, 40)) title = it }, label = { Text("快捷回复名称，最多40字符") }, enabled = !m.busy, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(text, { if (boundedText(it, 1000)) text = it }, label = { Text("快捷回复正文，最多1000字符") }, enabled = !m.busy, modifier = Modifier.fillMaxWidth())
        Text("编辑中，尚未保存。", style = MaterialTheme.typography.labelSmall)
        FlowRow {
            Button(onClick = { m.saveTemplate(previous, title, text) }, enabled = !m.busy && title.isNotBlank() && text.isNotBlank()) { Text("保存快捷回复") }
            TextButton(onClick = { showEditor = false }, enabled = !m.busy) { Text("取消编辑") }
        }
    }
}
