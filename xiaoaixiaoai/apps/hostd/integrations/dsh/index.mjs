import { HttpFault, readJson, serveSocket, validSocketPath } from "./socket.mjs";
import { createTaskEvents } from "./task-events.mjs";

const PROJECT_LIMIT = 20;
const SESSION_LIMIT = 100;
// Keep in sync with the shared protocol. The plugin has no npm dependencies.
const PAGE_SIZE = 32;
const SEARCH_LIMIT = 120;
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
    socketPath: config.socketPath, workspaceIds, all, profileSend, resumeExisting,
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

function sessionRow(config, agents, roots, projectId, id, row, archived) {
  if (!ordinary(row)) return undefined;
  const agent = agents.get(id);
  if (agent !== undefined && !isTopLevel(agent, id, roots)) return undefined;
  const available = live(row, agent);
  const resumable = config.resumeExisting && agent === undefined && cold(row);
  return {
    id, title: title(row.projections?.values?.title, `会话 ${id}`),
    state: archived ? "inactive" : row.formatStatus === "migration-required" ? "attention" : available ? agent.status :
      agent === undefined ? "inactive" : "unknown",
    canSend: !archived && (available || resumable) && config.canWrite(projectId, id),
  };
}

async function catalog(ctx, config, signal) {
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
      const session = sessionRow(config, agents, roots, id, sessionId, rows.get(sessionId), false);
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

async function browse(ctx, config, request, signal) {
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
    const session = sessionRow(config, agents, roots, project.id, id, rows.get(id), fromArchive);
    if (!session || (needle && ![project.title, project.id, session.title, session.id].some((str) => searchKey(str).includes(needle)))) continue;
    if (owner?.ambiguous) session.canSend = false;
    entries.set(id, { project, session, archived: fromArchive });
  }
  if (input.view === "exact") return { view: input.view, scope, entries: [...entries.values()] };
  const { page, next } = pageAfter([...entries.keys()], input.after);
  return { view: input.view, scope, entries: page.map((id) => entries.get(id)), next };
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

export default {
  name: "xiaoaixiaoai-dsh-bridge",
  inject: ["workspaceRegistry", "sessionController", "agents"],
  async apply(ctx, rawConfig) {
    const config = readConfig(rawConfig);
    if (config.all && typeof ctx.workspaceRegistry.list !== "function") throw new Error("DSH workspace directory is unavailable.");
    if (config.resumeExisting && typeof ctx.sessionController.resolveAgent !== "function") throw new Error("DSH existing-session resolver is unavailable.");
    const taskEvents = config.observeSends ? createTaskEvents(ctx) : undefined;
    try {
      const close = await serveSocket(config.socketPath, async (request, signal) => {
        if (request.url === "/v2/browse") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return browse(ctx, config, request, signal);
        }
        if (request.url === "/v1/catalog") {
          if (request.method !== "GET") throw new HttpFault(405, "method_not_allowed");
          if (request.headers["transfer-encoding"] !== undefined ||
              (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
            throw new HttpFault(400, "invalid_request");
          }
          return catalog(ctx, config, signal);
        }
        if (request.url === "/v1/send") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          return send(ctx, config, taskEvents, request, signal);
        }
        if (request.url === "/v3/task-events") {
          if (request.method !== "POST") throw new HttpFault(405, "method_not_allowed");
          if (!hasOnly(await readJson(request, signal), [])) throw new HttpFault(400, "invalid_request");
          return { events: taskEvents?.read() ?? [] };
        }
        throw new HttpFault(404, "route_not_found");
      });
      return () => { taskEvents?.close(); return close(); };
    } catch (error) {
      taskEvents?.close();
      throw error;
    }
  },
};
