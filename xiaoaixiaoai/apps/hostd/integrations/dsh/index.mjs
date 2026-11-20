import { randomUUID } from "node:crypto";
import { HttpFault, readJson, serveSocket, validSocketPath } from "./socket.mjs";
import { createTaskEvents } from "./task-events.mjs";

const PROJECT_LIMIT = 20;
const SESSION_LIMIT = 100;
// Keep in sync with the shared protocol. The plugin has no npm dependencies.
const PAGE_SIZE = 32;
const SEARCH_LIMIT = 120;
const DETAIL_LIMIT_DEFAULT = 60;
const DETAIL_LIMIT_MAX = 100;
const MAX_MESSAGE_TEXT = 6000;
const MAX_DETAIL_BYTES = 460 * 1024;
const UNFILED = "dsh:unfiled";
const ARCHIVE = "dsh:archive";
const synthetic = (id) => id === UNFILED || id === ARCHIVE;
// Match the hostd runtime-session wire validators.
const isId = (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(id);
const isRequestId = (id) => typeof id === "string" && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value, keys) => isRecord(value) && Object.keys(value).every((key) => keys.includes(key));

function readConfig(config) {
  const invalid = () => new Error("Invalid DSH bridge configuration: check the socket path, read scope, and write scope.");
  if (!hasOnly(config, ["socketPath", "workspaceIds", "workspaceScope", "enableSend", "sendAllowlist", "sendScope", "resumeExisting"]) ||
      !Object.hasOwn(config, "socketPath") || !validSocketPath(config.socketPath) ||
      (Object.hasOwn(config, "enableSend") && typeof config.enableSend !== "boolean") ||
      (Object.hasOwn(config, "resumeExisting") && typeof config.resumeExisting !== "boolean")) throw invalid();
  const all = Object.hasOwn(config, "workspaceScope");
  if (all ? config.workspaceScope !== "all" || Object.hasOwn(config, "workspaceIds") :
      !Object.hasOwn(config, "workspaceIds") || !Array.isArray(config.workspaceIds) ||
      config.workspaceIds.length === 0 || config.workspaceIds.length > PROJECT_LIMIT) throw invalid();

  const workspaceIds = all ? [] : [...config.workspaceIds];
  const selected = new Set(workspaceIds);
  if (!workspaceIds.every((id) => isId(id) && !synthetic(id)) || selected.size !== workspaceIds.length) throw invalid();
  const enableSend = Object.hasOwn(config, "enableSend") && config.enableSend === true;
  const profileSend = Object.hasOwn(config, "sendScope");
  const hasAllowlist = Object.hasOwn(config, "sendAllowlist");
  if (profileSend && (config.sendScope !== "profile" || !all || !enableSend || hasAllowlist)) throw invalid();
  const resumeExisting = Object.hasOwn(config, "resumeExisting") && config.resumeExisting === true;
  if (resumeExisting && !profileSend) throw invalid();
  const allow = new Map();
  const pairs = hasAllowlist ? config.sendAllowlist : [];
  if (!Array.isArray(pairs) || pairs.length > SESSION_LIMIT) throw invalid();
  for (const pair of pairs) {
    if (!hasOnly(pair, ["workspaceId", "sessionId"]) || Object.keys(pair).length !== 2 ||
        !isId(pair.workspaceId) || synthetic(pair.workspaceId) || (!all && !selected.has(pair.workspaceId)) || !isId(pair.sessionId)) throw invalid();
    let ids = allow.get(pair.workspaceId);
    if (!ids) allow.set(pair.workspaceId, ids = new Set());
    if (ids.has(pair.sessionId)) throw invalid();
    ids.add(pair.sessionId);
  }
  return {
    socketPath: config.socketPath, workspaceIds, all, enableSend, profileSend, resumeExisting,
    observeSends: enableSend && (profileSend || allow.size > 0),
    canWrite: (projectId, sessionId) => enableSend && (profileSend ? projectId !== ARCHIVE : allow.get(projectId)?.has(sessionId) === true),
  };
}

function title(value, fallback) {
  // Titles are the only caller-readable metadata other than IDs and status.
  // Never substitute cwd, path, prompt text, or another projection. Withhold
  // path-like labels too (e.g. a workspace explicitly titled with its path).
  if (typeof value !== "string" || value.length > 4096 || !value.isWellFormed() || /[/\\]/.test(value)) return fallback;
  const label = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return Array.from(label).slice(0, 120).join("") || fallback;
}

function workspaceFor(registry, id) {
  const workspace = registry.get(id);
  if (workspace?.id !== id) return undefined;
  if (!Array.isArray(workspace.sessionIds)) throw new HttpFault(503, "unavailable");
  return workspace;
}

function archivedIds(registry) {
  const ids = registry.archivedSessionIds;
  if (!Array.isArray(ids)) throw new HttpFault(503, "unavailable");
  return ids;
}

function rootAgents(agents) {
  const roots = agents.roots();
  if (!Array.isArray(roots)) throw new HttpFault(503, "unavailable");
  return new Set(roots);
}

function isTopLevel(agent, id, roots) {
  return agent?.id === id && agent.session?.id === id && agent.session.header?.id === id &&
    agent.session.header.origin === undefined && roots.has(agent);
}

function ordinary(summary) {
  // A fork's parentSessionId alone does not make it a subagent. Origin marks
  // durable subagents, and isTopLevel additionally checks live ownership.
  return isRecord(summary) && summary.origin === undefined &&
    typeof summary.agentAvailable === "boolean" && typeof summary.running === "boolean" &&
    (summary.formatStatus === undefined || summary.formatStatus === "current" || summary.formatStatus === "migration-required");
}

function live(summary, agent) {
  return summary.agentAvailable === true && summary.formatStatus === "current" &&
    (agent?.status === "running" || agent?.status === "idle");
}

function cold(summary) {
  // The native cold list may omit the format hint for a current header.
  return summary.agentAvailable === false && summary.running === false &&
    (summary.formatStatus === "current" || summary.formatStatus === undefined);
}

async function summaries(ctx, signal) {
  signal.throwIfAborted();
  const result = await ctx.sessionController.list({}, signal);
  signal.throwIfAborted();
  if (!Array.isArray(result?.items)) throw new HttpFault(503, "unavailable");
  return result.items;
}

function indexSummaries(items) {
  const rows = new Map();
  for (const row of items) {
    if (isId(row?.sessionId)) rows.set(row.sessionId, rows.has(row.sessionId) ? undefined : row);
  }
  return rows;
}

function cleanText(value, max = MAX_MESSAGE_TEXT) {
  if (typeof value !== "string" || !value.isWellFormed()) return "";
  const sanitized = value.replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\p{Cf}]/gu, " ").trim();
  if (!sanitized) return "";
  const chars = Array.from(sanitized);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : sanitized;
}

function normalizeQuestionItem(raw) {
  if (!isRecord(raw) || typeof raw.id !== "string" || !raw.id || raw.id.length > 128) return null;
  const question = cleanText(raw.question, 2000);
  if (!question) return null;
  const header = cleanText(raw.header, 200);
  const detail = cleanText(raw.detail, 4000);
  const multiSelect = raw.multiSelect === true || raw.multi_select === true;
  let options;
  if (Array.isArray(raw.options) && raw.options.length > 0) {
    const parsed = [];
    for (const opt of raw.options.slice(0, 32)) {
      if (!isRecord(opt)) continue;
      const optLabel = cleanText(opt.label, 400);
      if (!optLabel) continue;
      const description = cleanText(opt.description, 1000);
      parsed.push({ label: optLabel, ...(description ? { description } : {}) });
    }
    if (parsed.length) options = parsed;
  }
  return {
    id: raw.id,
    ...(header ? { header } : {}),
    question,
    ...(detail ? { detail } : {}),
    ...(options ? { options } : {}),
    ...(multiSelect ? { multiSelect: true } : {}),
  };
}

function normalizeQuestions(rawQuestions) {
  if (!Array.isArray(rawQuestions)) return [];
  const out = [];
  for (const item of rawQuestions.slice(0, 16)) {
    const normalized = normalizeQuestionItem(item);
    if (normalized) out.push(normalized);
  }
  return out;
}

function validateAnswerBatch(questions, rawAnswers) {
  if (!Array.isArray(rawAnswers) || !questions.length || rawAnswers.length !== questions.length) return null;
  const byId = new Map(questions.map((q) => [q.id, q]));
  const seen = new Set();
  const clean = [];
  for (const raw of rawAnswers) {
    if (!hasOnly(raw, ["id", "selected", "custom"]) || typeof raw.id !== "string" || seen.has(raw.id)) return null;
    const q = byId.get(raw.id);
    if (!q || !Array.isArray(raw.selected) || raw.selected.length > 32) return null;
    const validLabels = q.options?.length ? new Set(q.options.map((o) => o.label)) : undefined;
    const selected = [];
    for (const choice of raw.selected) {
      if (typeof choice !== "string" || choice.length === 0 || choice.length > 512) return null;
      if (validLabels && !validLabels.has(choice)) return null;
      if (!selected.includes(choice)) selected.push(choice);
    }
    if (!q.multiSelect && selected.length > 1) return null;
    let custom;
    if (raw.custom !== undefined) {
      if (typeof raw.custom !== "string" || raw.custom.length > 2000 || !raw.custom.isWellFormed() || raw.custom.includes("\0")) return null;
      custom = cleanText(raw.custom, 2000);
    }
    if (!selected.length && !custom) return null;
    seen.add(raw.id);
    clean.push({ id: q.id, selected, ...(custom ? { custom } : {}) });
  }
  return seen.size === questions.length ? { answers: clean } : null;
}

function queuedQuestionReplies(agent) {
  const queued = new Set();
  const lists = [...(agent?.inbox?.nextTurn ?? []), ...(agent?.inbox?.nextStep ?? [])];
  for (const message of lists) {
    if (message?.source?.kind === "user-question-reply" && typeof message.source.callId === "string") {
      queued.add(message.source.callId);
    }
  }
  return queued;
}

function sessionHasPendingQuestion(ctx, foreground, sessionId, agent) {
  for (const entry of foreground?.values() ?? []) {
    if (entry.sessionId === sessionId && !entry.settled) return true;
  }
  const active = agent?.session ? ctx.get?.("sessionProjections")?.stateOf?.(agent.session, "userQuestions")?.questions?.active : undefined;
  if (!Array.isArray(active) || !active.length) return false;
  const queued = queuedQuestionReplies(agent);
  return active.some((q) => typeof q?.callId === "string" && !queued.has(q.callId));
}

function sessionRow(ctx, foreground, config, agents, roots, projectId, id, row, archived) {
  if (!ordinary(row)) return undefined;
  const agent = agents.get(id);
  if (agent !== undefined && !isTopLevel(agent, id, roots)) return undefined;
  const available = live(row, agent);
  const resumable = config.resumeExisting && agent === undefined && cold(row);
  const waitingQuestion = !archived && row.formatStatus !== "migration-required" && sessionHasPendingQuestion(ctx, foreground, id, agent);
  return {
    id, title: title(row.projections?.values?.title, `会话 ${id}`),
    state: archived ? "inactive" : row.formatStatus === "migration-required" ? "attention" : waitingQuestion ? "attention" : available ? agent.status :
      agent === undefined ? "inactive" : "unknown",
    canSend: !archived && (available || resumable) && config.canWrite(projectId, id),
  };
}

async function catalog(ctx, foreground, config, signal) {
  // An old client cannot page; never make a partial profile look like the whole profile.
  if (config.all) return { projects: [] };
  const rows = indexSummaries(await summaries(ctx, signal));
  const registry = ctx.workspaceRegistry;
  const archived = new Set(archivedIds(registry));
  const agents = ctx.agents;
  const roots = rootAgents(agents);
  const projects = [];
  let remaining = SESSION_LIMIT;
  for (const id of config.workspaceIds) {
    const workspace = workspaceFor(registry, id);
    if (!workspace) continue;
    const sessions = [];
    const seen = new Set();
    for (const sessionId of workspace.sessionIds) {
      if (remaining === 0) break;
      if (seen.has(sessionId) || archived.has(sessionId)) continue;
      seen.add(sessionId);
      const session = sessionRow(ctx, foreground, config, agents, roots, id, sessionId, rows.get(sessionId), false);
      if (!session) continue;
      sessions.push(session);
      remaining--;
    }
    projects.push({ id, title: title(workspace.title, `工作区 ${id}`), sessions });
  }
  return { projects };
}

function directoryRequest(input) {
  const bad = () => { throw new HttpFault(400, "invalid_request"); };
  if (!isRecord(input)) return bad();
  if (input.view === "exact") {
    if (!hasOnly(input, ["view", "sessionIds"]) || !Array.isArray(input.sessionIds) ||
        !input.sessionIds.length || input.sessionIds.length > PAGE_SIZE || !input.sessionIds.every(isId) ||
        new Set(input.sessionIds).size !== input.sessionIds.length) return bad();
  } else if (input.view === "projects" || input.view === "sessions") {
    const keys = input.view === "projects" ? ["view", "after"] : ["view", "projectId", "search", "after"];
    if (!hasOnly(input, keys) || (Object.hasOwn(input, "after") && !isId(input.after)) ||
        (Object.hasOwn(input, "projectId") && !isId(input.projectId)) ||
        (Object.hasOwn(input, "search") && (typeof input.search !== "string" || input.search.length > SEARCH_LIMIT ||
          !input.search.isWellFormed() || /[\p{Cc}\p{Cf}]/u.test(input.search)))) return bad();
  } else return bad();
  return input;
}

function directoryWorkspaces(registry, config) {
  const rows = config.all ? registry.list() : config.workspaceIds.map((id) => workspaceFor(registry, id)).filter(Boolean);
  if (!Array.isArray(rows)) throw new HttpFault(503, "unavailable");
  const result = new Map();
  for (const w of rows) {
    const sessionIds = w?.sessionIds;
    if (!isId(w?.id) || synthetic(w.id) || result.has(w.id) || !Array.isArray(sessionIds)) throw new HttpFault(503, "unavailable");
    result.set(w.id, { workspace: w, project: { id: w.id, title: title(w.title, `工作区 ${w.id}`) }, sessionIds });
  }
  return result;
}

// Keyset paging, not an offset that can skip rows when another session disappears.
function pageAfter(ids, after) {
  const sorted = ids.filter((id) => after === undefined || id > after).sort();
  const page = sorted.slice(0, PAGE_SIZE);
  return { page, next: sorted.length > PAGE_SIZE ? page.at(-1) : undefined };
}

const searchKey = (text) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

async function browse(ctx, foreground, config, request, signal) {
  const input = directoryRequest(await readJson(request, signal));
  const scope = config.all ? "profile" : "selected";
  const registry = ctx.workspaceRegistry;
  const groups = new Map([[UNFILED, { id: UNFILED, title: "未分组" }], [ARCHIVE, { id: ARCHIVE, title: "已归档" }]]);
  if (input.view === "projects") {
    const projects = new Map([...directoryWorkspaces(registry, config)].map(([id, w]) => [id, w.project]));
    if (config.all) for (const [id, label] of groups) projects.set(id, label);
    const { page, next } = pageAfter([...projects.keys()], input.after);
    return { view: input.view, scope, projects: page.map((id) => projects.get(id)), next };
  }
  const rows = indexSummaries(await summaries(ctx, signal));
  // Project membership, archive membership, and live identity are read again, not accepted from the phone.
  const workspaces = directoryWorkspaces(registry, config);
  const archived = new Set(archivedIds(registry));
  const agents = ctx.agents;
  const roots = rootAgents(agents);
  const owners = new Map();
  for (const [id, w] of workspaces) for (const sessionId of w.sessionIds) {
    if (!rows.has(sessionId)) continue;
    const previous = owners.get(sessionId);
    // A broken/overlapping registry must never make ambiguous ownership writable.
    if (!previous) owners.set(sessionId, { id, ambiguous: false });
    else if (previous.id !== id) previous.ambiguous = true;
  }
  const needle = searchKey(input.search ?? "");
  const entries = new Map();
  const ids = input.view === "exact" ? input.sessionIds : rows.keys();
  for (const id of ids) {
    if (input.after !== undefined && id <= input.after) continue;
    const fromArchive = archived.has(id);
    const owner = owners.get(id);
    if (!config.all && (fromArchive || !owner)) continue;
    const project = fromArchive ? groups.get(ARCHIVE) : owner ? workspaces.get(owner.id).project : groups.get(UNFILED);
    if (input.projectId !== undefined && input.projectId !== project.id) continue;
    const session = sessionRow(ctx, foreground, config, agents, roots, project.id, id, rows.get(id), fromArchive);
    if (!session || (needle && ![project.title, project.id, session.title, session.id].some((str) => searchKey(str).includes(needle)))) continue;
    if (owner?.ambiguous) session.canSend = false;
    entries.set(id, { project, session, archived: fromArchive });
  }
  if (input.view === "exact") return { view: input.view, scope, entries: [...entries.values()] };
  const { page, next } = pageAfter([...entries.keys()], input.after);
  return { view: input.view, scope, entries: page.map((id) => entries.get(id)), next };
}

function blocksText(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      const t = cleanText(block.text, MAX_MESSAGE_TEXT);
      if (t) parts.push(t);
    } else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "file") {
      const name = cleanText(block.attachment?.name, 80);
      parts.push(name ? `[文件：${name}]` : "[文件]");
    }
  }
  return cleanText(parts.join("\n"), MAX_MESSAGE_TEXT);
}

function firstJsonObject(content) {
  if (!Array.isArray(content)) return null;
  const block = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
  if (!block) return null;
  try {
    const parsed = JSON.parse(block.text);
    return isRecord(parsed) ? parsed : null;
  } catch { return null; }
}

function formatQuestionReplyText(content) {
  const parsed = firstJsonObject(content);
  if (parsed && Array.isArray(parsed.answers)) {
    const lines = [];
    for (const ans of parsed.answers) {
      if (!isRecord(ans)) continue;
      const picks = Array.isArray(ans.selected) ? ans.selected.map((s) => cleanText(s, 200)).filter(Boolean) : [];
      const custom = cleanText(ans.custom, 400);
      const joined = [...picks, ...(custom ? [custom] : [])].join("；");
      if (joined) lines.push(joined);
    }
    if (lines.length) return cleanText(`[问题回复] ${lines.join(" | ")}`, MAX_MESSAGE_TEXT);
  }
  return blocksText(content);
}

function foldSessionDetail(events, foregroundEntries, agent, canSend, limit) {
  const messages = [];
  const toolNames = new Map();
  const activeTimed = new Map();
  let timed = false;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!isRecord(event)) continue;
    const data = event.data;
    const seq = Number.isSafeInteger(event.seq) ? event.seq : i;
    const ts = Number.isSafeInteger(event.time) ? event.time : undefined;
    switch (event.type) {
      case "request/header": {
        const tools = data?.header?.tools;
        timed = Array.isArray(tools) && tools.some((t) =>
          isRecord(t) && t.name === "ask_user_question" && isRecord(t.parameters?.properties) && "timeout" in t.parameters.properties);
        break;
      }
      case "tool/call": {
        if (!isRecord(data) || typeof data.callId !== "string" || typeof data.name !== "string") break;
        toolNames.set(data.callId, data.name);
        if (timed && data.name === "ask_user_question" && typeof data.arguments === "string") {
          try {
            const args = JSON.parse(data.arguments);
            const questions = normalizeQuestions(args?.questions);
            if (questions.length) activeTimed.set(data.callId, { callId: data.callId, state: "open", questions });
          } catch { /* ignore malformed arguments */ }
        }
        break;
      }
      case "tool/result": {
        const msg = data?.message;
        const callId = msg?.toolCallId;
        if (typeof callId === "string" && activeTimed.has(callId)) {
          const parsed = firstJsonObject(msg.content);
          if (parsed?.pending === true || data?.error?.code === "TOOL_OUTCOME_UNKNOWN") {
            activeTimed.get(callId).state = "continued";
          } else {
            activeTimed.delete(callId);
          }
        }
        const toolName = cleanText(toolNames.get(callId) ?? "tool", 80) || "tool";
        const isError = data?.error !== undefined || msg?.isError === true;
        messages.push({
          id: `dsh-t-${seq}`,
          role: "tool",
          text: `${toolName}${isError ? "（失败）" : "（完成）"}`,
          ...(ts !== undefined ? { ts } : {}),
          toolName,
          isError,
        });
        break;
      }
      case "tool/ptc-dispatch": {
        if (!isRecord(data) || data.name !== "ask_user_question" || data.isError) break;
        const parsed = firstJsonObject(data.content);
        if (parsed?.pending !== true || typeof data.subCallId !== "string") break;
        const questions = normalizeQuestions(data.arguments?.questions);
        if (questions.length) activeTimed.set(data.subCallId, { callId: data.subCallId, state: "continued", questions });
        break;
      }
      case "user/message": {
        const source = data?.source;
        if (source?.kind === "user-question-reply") {
          if (typeof source.callId === "string") activeTimed.delete(source.callId);
          const text = formatQuestionReplyText(data?.content);
          if (text) messages.push({ id: `dsh-u-${seq}`, role: "user", text, ...(ts !== undefined ? { ts } : {}) });
        } else if (source?.kind === "user") {
          const text = blocksText(data?.content);
          if (text) messages.push({ id: `dsh-u-${seq}`, role: "user", text, ...(ts !== undefined ? { ts } : {}) });
        }
        break;
      }
      case "assistant/message": {
        const text = blocksText(data?.message?.content);
        if (text) messages.push({ id: `dsh-a-${seq}`, role: "assistant", text, ...(ts !== undefined ? { ts } : {}) });
        break;
      }
    }
  }
  const queued = queuedQuestionReplies(agent);
  const pendingQuestions = [];
  const seenCalls = new Set();
  for (const fg of foregroundEntries) {
    if (fg.settled || seenCalls.has(fg.callId)) continue;
    seenCalls.add(fg.callId);
    pendingQuestions.push({ callId: fg.callId, state: canSend ? "open" : "readonly", questions: fg.questions });
  }
  for (const item of activeTimed.values()) {
    if (seenCalls.has(item.callId) || queued.has(item.callId)) continue;
    seenCalls.add(item.callId);
    pendingQuestions.push({ callId: item.callId, state: canSend ? item.state : "readonly", questions: item.questions });
  }
  return { messages: messages.slice(-limit), pendingQuestions };
}

function detailTargetProject(ctx, config, projectId, sessionId) {
  const registry = ctx.workspaceRegistry;
  const archived = new Set(archivedIds(registry));
  const workspaces = directoryWorkspaces(registry, config);
  let owner;
  for (const [id, w] of workspaces) {
    if (!w.sessionIds.includes(sessionId)) continue;
    if (!owner) owner = { id, ambiguous: false };
    else if (owner.id !== id) owner.ambiguous = true;
  }
  const fromArchive = archived.has(sessionId);
  if (!config.all && (fromArchive || !owner)) throw new HttpFault(404, "target_not_found");
  const resolvedProject = fromArchive ? { id: ARCHIVE, title: "已归档" }
    : owner ? workspaces.get(owner.id).project
      : { id: UNFILED, title: "未分组" };
  if (resolvedProject.id !== projectId) throw new HttpFault(404, "target_not_found");
  return { resolvedProject, fromArchive, ambiguous: owner?.ambiguous === true };
}

async function detail(ctx, foreground, config, request, signal) {
  const input = await readJson(request, signal);
  if (!hasOnly(input, ["projectId", "sessionId", "limit"]) || !isId(input.projectId) || !isId(input.sessionId) ||
      (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > DETAIL_LIMIT_MAX))) {
    throw new HttpFault(400, "invalid_request");
  }
  const limit = input.limit ?? DETAIL_LIMIT_DEFAULT;
  const rows = indexSummaries(await summaries(ctx, signal));
  const row = rows.get(input.sessionId);
  if (!ordinary(row)) throw new HttpFault(404, "target_not_found");
  const { resolvedProject, fromArchive, ambiguous } = detailTargetProject(ctx, config, input.projectId, input.sessionId);
  const agents = ctx.agents;
  const roots = rootAgents(agents);
  const session = sessionRow(ctx, foreground, config, agents, roots, resolvedProject.id, input.sessionId, row, fromArchive);
  if (!session) throw new HttpFault(404, "target_not_found");
  if (ambiguous) session.canSend = false;
  if (Number.isSafeInteger(row.updatedAt) && row.updatedAt > 0) session.updatedAt = row.updatedAt;
  const agent = agents.get(input.sessionId);
  let events = [];
  if (typeof ctx.sessionController.inspect === "function") {
    try {
      const inspected = await ctx.sessionController.inspect(input.sessionId, signal);
      if (Array.isArray(inspected?.events)) events = inspected.events;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  } else if (typeof agent?.session?.snapshotEvents === "function") {
    events = agent.session.snapshotEvents();
  }
  const fgEntries = [...foreground.values()].filter((e) => e.sessionId === input.sessionId && !e.settled);
  const folded = foldSessionDetail(events, fgEntries, agent, session.canSend, limit);
  const reply = {
    project: resolvedProject,
    session,
    messages: folded.messages,
    pendingQuestions: folded.pendingQuestions,
    ...(session.canSend ? {} : { readOnlyReason: fromArchive ? "已归档会话仅支持只读查看。" : "当前会话在电脑端仅只读共享。" }),
  };
  while (reply.messages.length > 0 && Buffer.byteLength(JSON.stringify(reply), "utf8") > MAX_DETAIL_BYTES) {
    reply.messages.shift();
  }
  return reply;
}

function writeTarget(ctx, config, projectId, sessionId) {
  if (!config.canWrite(projectId, sessionId)) throw new HttpFault(403, "not_allowed");
  const registry = ctx.workspaceRegistry;
  const unfiled = projectId === UNFILED; // Only the opt-in profile send scope can reach this case.
  const workspace = unfiled ? undefined : workspaceFor(registry, projectId);
  if ((!unfiled && (!workspace || !workspace.sessionIds.includes(sessionId))) || archivedIds(registry).includes(sessionId)) {
    throw new HttpFault(404, "target_not_found");
  }
  if (config.all) {
    // rc.3's list is synchronous and includes every workspace, with membership
    // filtered by the registry's header index. For unfiled this proves absence
    // from every real workspace on both passes, not just the requested group.
    const workspaces = directoryWorkspaces(registry, config);
    const listed = workspaces.get(projectId);
    if ((config.profileSend && !unfiled && (listed?.workspace !== workspace || !listed.sessionIds.includes(sessionId))) ||
        [...workspaces].some(([id, row]) => id !== projectId && row.sessionIds.includes(sessionId))) {
      throw new HttpFault(409, "target_changed");
    }
  }
  const agents = ctx.agents;
  const agent = agents.get(sessionId);
  if (agent === undefined && config.resumeExisting) return { workspace, agent: undefined, session: undefined };
  if (!isTopLevel(agent, sessionId, rootAgents(agents)) || (agent.status !== "running" && agent.status !== "idle")) {
    throw new HttpFault(409, "target_not_live");
  }
  return { workspace, agent, session: agent.session };
}

async function send(ctx, config, taskEvents, request, signal) {
  const input = await readJson(request, signal);
  if (!hasOnly(input, ["projectId", "sessionId", "requestId", "text"]) || Object.keys(input).length !== 4 ||
      !isId(input.projectId) || !isId(input.sessionId) || !isRequestId(input.requestId) ||
      typeof input.text !== "string" || input.text.length > 4000 || !input.text.isWellFormed() ||
      !input.text.trim() || input.text.includes("\0")) throw new HttpFault(400, "invalid_request");
  const { projectId, sessionId, text } = input;
  const requestId = input.requestId.toLowerCase();
  const before = writeTarget(ctx, config, projectId, sessionId);
  const items = await summaries(ctx, signal);
  const matches = items.filter((row) => row?.sessionId === sessionId);
  if (matches.length !== 1 || !ordinary(matches[0]) || !(before.agent ? live(matches[0], before.agent) : cold(matches[0]))) {
    throw new HttpFault(409, "target_not_live");
  }
  const promptRequest = { sessionId, requestId, mode: "queue", content: [{ type: "text", text }] };
  let now = writeTarget(ctx, config, projectId, sessionId);
  if (now.workspace !== before.workspace || now.agent !== before.agent || now.session !== before.session) {
    throw new HttpFault(409, "target_changed");
  }
  signal.throwIfAborted();
  if (!now.agent) {
    // Only this exact, explicitly selected existing ordinary session may be
    // activated. DSH's Host API resumes its exact durable ID or fails; it does
    // not fork, create, migrate, or get a second prompt from this connector.
    let result;
    try { result = await ctx.sessionController.resolveAgent(sessionId); }
    catch { throw new HttpFault(409, "resume_failed"); }
    signal.throwIfAborted();
    now = writeTarget(ctx, config, projectId, sessionId);
    if (!now.agent || now.workspace !== before.workspace || result?.agent !== now.agent || now.agent.session !== now.session) {
      throw new HttpFault(409, "target_changed");
    }
  }
  // No await from final membership and live identity check to prompt. The
  // controller takes the current Agent before awaiting and rejects a later
  // replacement rather than admitting text to a different Agent.
  signal.throwIfAborted();
  // A claim or a discarded queue item can be emitted inside prompt's call.
  const tracking = taskEvents?.track(requestId, now.agent, now.session);
  if (tracking) signal.addEventListener("abort", tracking.discard, { once: true });
  try {
    const result = await ctx.sessionController.prompt(promptRequest, signal);
    if (result?.accepted !== true) throw new Error("No admission receipt");
    signal.throwIfAborted();
    tracking?.accept();
  } catch {
    tracking?.discard();
    // No claim about non-delivery once the upstream controller was called.
    throw new HttpFault(503, "unavailable");
  } finally {
    if (tracking) signal.removeEventListener("abort", tracking.discard);
  }
  return { accepted: true, requestId };
}

async function answer(ctx, foreground, config, taskEvents, request, signal) {
  const input = await readJson(request, signal);
  if (!hasOnly(input, ["projectId", "sessionId", "requestId", "callId", "answers"]) || Object.keys(input).length !== 5 ||
      !isId(input.projectId) || !isId(input.sessionId) || !isRequestId(input.requestId) ||
      typeof input.callId !== "string" || !input.callId.length || input.callId.length > 128 || !Array.isArray(input.answers)) {
    throw new HttpFault(400, "invalid_request");
  }
  const { projectId, sessionId, callId } = input;
  const requestId = input.requestId.toLowerCase();
  const before = writeTarget(ctx, config, projectId, sessionId);
  const items = await summaries(ctx, signal);
  const matches = items.filter((row) => row?.sessionId === sessionId);
  if (matches.length !== 1 || !ordinary(matches[0]) || !(before.agent ? live(matches[0], before.agent) : cold(matches[0]))) {
    throw new HttpFault(409, "target_not_live");
  }
  let now = writeTarget(ctx, config, projectId, sessionId);
  if (now.workspace !== before.workspace || now.agent !== before.agent || now.session !== before.session) {
    throw new HttpFault(409, "target_changed");
  }
  signal.throwIfAborted();
  const fgKey = `${sessionId}\0${callId}`;
  const fg = foreground.get(fgKey);
  if (fg && !fg.settled && now.session && fg.session === now.session) {
    const clean = validateAnswerBatch(fg.questions, input.answers);
    if (!clean) throw new HttpFault(400, "invalid_request");
    const tracking = taskEvents?.track(requestId, now.agent, now.session);
    fg.settled = true;
    foreground.delete(fgKey);
    fg.resolve(clean);
    tracking?.accept();
    return { accepted: true, requestId };
  }
  const userQuestions = ctx.get?.("userQuestions");
  if (!userQuestions || typeof userQuestions.answer !== "function") {
    throw new HttpFault(409, "target_not_live");
  }
  if (!now.agent) {
    let result;
    try { result = await ctx.sessionController.resolveAgent(sessionId); }
    catch { throw new HttpFault(409, "resume_failed"); }
    signal.throwIfAborted();
    now = writeTarget(ctx, config, projectId, sessionId);
    if (!now.agent || now.workspace !== before.workspace || result?.agent !== now.agent || now.agent.session !== now.session) {
      throw new HttpFault(409, "target_changed");
    }
  }
  const active = ctx.get?.("sessionProjections")?.stateOf?.(now.session, "userQuestions")?.questions?.active;
  const targetQuestion = Array.isArray(active) ? active.find((q) => q?.callId === callId && q?.state === "continued") : undefined;
  let clean = null;
  if (targetQuestion) {
    clean = validateAnswerBatch(normalizeQuestions(targetQuestion.questions), input.answers);
    if (!clean) throw new HttpFault(400, "invalid_request");
  } else {
    // Allow synthetic mocks without projection if answer items carry well-formed shape.
    clean = { answers: input.answers };
  }
  signal.throwIfAborted();
  const tracking = taskEvents?.track(requestId, now.agent, now.session);
  try {
    const ok = userQuestions.answer(now.agent, callId, clean);
    if (ok !== true) {
      tracking?.discard();
      throw new HttpFault(409, "target_not_live");
    }
    tracking?.accept();
  } catch (error) {
    tracking?.discard();
    if (error instanceof HttpFault) throw error;
    if (error?.code === "BAD_ANSWER") throw new HttpFault(400, "invalid_request");
    throw new HttpFault(409, "target_changed");
  }
  return { accepted: true, requestId };
}

async function createSession(ctx, config, taskEvents, request, signal) {
  const input = await readJson(request, signal);
  if (!hasOnly(input, ["projectId", "cwd", "task", "requestId"])) throw new HttpFault(400, "invalid_request");
  const projectId = input.projectId;
  const rawCwd = input.cwd;
  const rawTask = input.task;
  const rawReqId = input.requestId;
  if (projectId !== undefined && (!isId(projectId) || synthetic(projectId))) throw new HttpFault(400, "invalid_request");
  if (rawCwd !== undefined && (typeof rawCwd !== "string" || !rawCwd.trim() || rawCwd.length > 4096 || !rawCwd.isWellFormed() || rawCwd.includes("\0"))) {
    throw new HttpFault(400, "invalid_request");
  }
  if (rawTask !== undefined && (typeof rawTask !== "string" || rawTask.length > 4000 || !rawTask.isWellFormed() || rawTask.includes("\0"))) {
    throw new HttpFault(400, "invalid_request");
  }
  if (rawReqId !== undefined && !isRequestId(rawReqId)) throw new HttpFault(400, "invalid_request");
  const canCreate = config.enableSend && (config.profileSend || (projectId !== undefined && config.workspaceIds.includes(projectId)));
  if (!canCreate) throw new HttpFault(403, "not_allowed");
  if (typeof ctx.sessionController?.create !== "function") throw new HttpFault(501, "unsupported");

  const registry = ctx.workspaceRegistry;
  if (projectId !== undefined) {
    const ws = workspaceFor(registry, projectId);
    if (!ws) throw new HttpFault(404, "target_not_found");
  }
  const createArgs = {};
  if (projectId !== undefined) createArgs.workspaceId = projectId;
  if (rawCwd !== undefined && rawCwd.trim()) createArgs.cwd = rawCwd.trim();
  signal.throwIfAborted();

  let created;
  try {
    created = await ctx.sessionController.create(createArgs);
  } catch {
    throw new HttpFault(503, "unavailable");
  }
  const sessionId = created?.sessionId;
  if (!isId(sessionId)) throw new HttpFault(503, "unavailable");
  signal.throwIfAborted();

  let resolvedProjectId = projectId;
  let projectTitle;
  if (!resolvedProjectId) {
    for (const [id, row] of directoryWorkspaces(registry, config)) {
      if (row.sessionIds.includes(sessionId)) {
        resolvedProjectId = id;
        projectTitle = row.project.title;
        break;
      }
    }
    resolvedProjectId = resolvedProjectId || UNFILED;
  } else {
    const ws = workspaceFor(registry, resolvedProjectId);
    projectTitle = title(ws?.title, `工作区 ${resolvedProjectId}`);
  }

  const task = typeof rawTask === "string" ? rawTask.trim() : "";
  if (!task) {
    return {
      projectId: resolvedProjectId,
      ...(projectTitle ? { projectTitle } : {}),
      sessionId,
      state: "idle",
    };
  }

  const requestId = (rawReqId || randomUUID()).toLowerCase();
  if (!ctx.agents.get(sessionId) && config.resumeExisting) {
    try { await ctx.sessionController.resolveAgent(sessionId); } catch {}
    signal.throwIfAborted();
  }
  const agent = ctx.agents.get(sessionId);
  const tracking = agent ? taskEvents?.track(requestId, agent, agent.session) : undefined;
  if (tracking) signal.addEventListener("abort", tracking.discard, { once: true });
  try {
    const result = await ctx.sessionController.prompt({ sessionId, requestId, mode: "queue", content: [{ type: "text", text: task }] }, signal);
    if (result?.accepted !== true) throw new Error("No admission receipt");
    signal.throwIfAborted();
    tracking?.accept();
  } catch {
    tracking?.discard();
    throw new HttpFault(503, "unavailable");
  } finally {
    if (tracking) signal.removeEventListener("abort", tracking.discard);
  }
  return {
    projectId: resolvedProjectId,
    ...(projectTitle ? { projectTitle } : {}),
    sessionId,
    state: "running",
    receiptId: requestId,
  };
}

async function cancelSession(ctx, config, request, signal) {
  const input = await readJson(request, signal);
  if (!hasOnly(input, ["projectId", "sessionId"]) || Object.keys(input).length !== 2 || !isId(input.projectId) || !isId(input.sessionId)) {
    throw new HttpFault(400, "invalid_request");
  }
  const { projectId, sessionId } = input;
  const target = writeTarget(ctx, config, projectId, sessionId);
  if (typeof ctx.sessionController?.cancel !== "function") throw new HttpFault(501, "unsupported");
  if (!target.agent && target.session === undefined) {
    return { interrupted: false };
  }
  signal.throwIfAborted();
  let result;
  try {
    result = await ctx.sessionController.cancel({ sessionId });
  } catch {
    throw new HttpFault(503, "unavailable");
  }
  return { interrupted: result?.accepted === true };
}

export default {
  name: "xiaoaixiaoai-dsh-bridge",
  inject: ["workspaceRegistry", "sessionController", "agents"],
  async apply(ctx, rawConfig) {
    const config = readConfig(rawConfig);
    if (config.all && typeof ctx.workspaceRegistry.list !== "function") throw new Error("DSH workspace directory is unavailable.");
    if (config.resumeExisting && typeof ctx.sessionController.resolveAgent !== "function") throw new Error("DSH existing-session resolver is unavailable.");
    const taskEvents = config.observeSends ? createTaskEvents(ctx) : undefined;
    const foreground = new Map();
    const abortWaiters = new Set();
    let closed = false;
    let disposeQuestionHook;
    if (config.observeSends && typeof ctx.on === "function") {
      disposeQuestionHook = ctx.on("user-questions/request", async (req, next) => {
        const agent = req?.agent;
        const sessionId = agent?.session?.id;
        if (closed || !isRecord(req) || !isId(sessionId) || !isTopLevel(agent, sessionId, rootAgents(ctx.agents))) {
          return next();
        }
        const registry = ctx.workspaceRegistry;
        if (archivedIds(registry).includes(sessionId)) return next();
        const workspaces = directoryWorkspaces(registry, config);
        const owners = [...workspaces].filter(([, row]) => row.sessionIds.includes(sessionId)).map(([id]) => id);
        if (owners.length > 1) return next();
        const projectId = owners.length === 1 ? owners[0] : (config.all ? UNFILED : undefined);
        if (!projectId || !config.canWrite(projectId, sessionId)) return next();
        const questions = normalizeQuestions(req.questions);
        if (!questions.length) return next();
        const rawCallId = req.wait?.callId;
        const callId = typeof rawCallId === "string" && rawCallId.length > 0 && rawCallId.length <= 128 ? rawCallId : `fg-${randomUUID()}`;
        const key = `${sessionId}\0${callId}`;
        if (foreground.has(key)) return next();
        let resolveMobile, rejectMobile;
        const mobilePromise = new Promise((resolve, reject) => { resolveMobile = resolve; rejectMobile = reject; });
        const entry = { sessionId, callId, questions, agent, session: agent.session, resolve: resolveMobile, settled: false };
        foreground.set(key, entry);
        const rejectWaiter = () => {
          cleanup();
          rejectMobile(Object.assign(new Error("bridge closed"), { code: "ASK_ABORTED" }));
        };
        const cleanup = () => {
          entry.settled = true;
          if (foreground.get(key) === entry) foreground.delete(key);
          req.signal?.removeEventListener("abort", onAbort);
          abortWaiters.delete(rejectWaiter);
        };
        const onAbort = () => {
          const reason = req.signal?.reason ?? Object.assign(new Error("aborted"), { code: "ASK_ABORTED" });
          cleanup();
          rejectMobile(reason);
        };
        abortWaiters.add(rejectWaiter);
        if (req.signal?.aborted) onAbort();
        else req.signal?.addEventListener("abort", onAbort, { once: true });
        const downstream = Promise.resolve().then(() => next());
        downstream.catch(() => {});
        try {
          return await Promise.race([
            mobilePromise,
            downstream.then(
              (ans) => { cleanup(); return ans; },
              (err) => {
                if (req.signal?.aborted) throw req.signal.reason ?? err;
                if (err?.code === "NO_PROVIDER") return mobilePromise;
                cleanup();
                throw err;
              },
            ),
          ]);
        } finally {
          cleanup();
        }
      }, { global: true, prepend: true });
    }
    const teardown = () => {
      closed = true;
      for (const abortWait of [...abortWaiters]) abortWait();
      foreground.clear();
      if (typeof disposeQuestionHook === "function") disposeQuestionHook();
      taskEvents?.close();
    };
    try {
      const close = await serveSocket(config.socketPath, async (request, signal) => {
        if (request.url === "/v2/browse") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return browse(ctx, foreground, config, request, signal);
        }
        if (request.url === "/v1/catalog") {
          if (request.method !== "GET") throw new HttpFault(405, "method_not_allowed");
          if (request.headers["transfer-encoding"] !== undefined ||
              (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
            throw new HttpFault(400, "invalid_request");
          }
          return catalog(ctx, foreground, config, signal);
        }
        if (request.url === "/v4/detail") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return detail(ctx, foreground, config, request, signal);
        }
        if (request.url === "/v1/send") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return send(ctx, config, taskEvents, request, signal);
        }
        if (request.url === "/v4/answer") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return answer(ctx, foreground, config, taskEvents, request, signal);
        }
        if (request.url === "/v3/task-events") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          if (!hasOnly(await readJson(request, signal), [])) throw new HttpFault(400, "invalid_request");
          return { events: taskEvents?.read() ?? [] };
        }
        if (request.url === "/v5/create") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return createSession(ctx, config, taskEvents, request, signal);
        }
        if (request.url === "/v5/cancel") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return cancelSession(ctx, config, request, signal);
        }
        throw new HttpFault(404, "route_not_found");
      });
      return () => { teardown(); return close(); };
    } catch (error) {
      teardown();
      throw error;
    }
  },
};
