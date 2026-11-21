/**
 * Tri-tier diagnostics bundle builder (`relay` + `host` + `viewer`) for quick AI
 * and human root-cause investigation. All preview texts, summaries, and event
 * rows are redacted via `redact()` and never expose credentials, memories, or
 * personal ledger balances.
 */
import {
  effectiveAgentStatus,
  type Agent,
  type AgentStatus,
  type AssistantAction,
  type Device,
  type LogEntry,
  type LogLevel,
} from "@xiaoaixiaoai/protocol";
import { clipText, redact } from "./eventlog.ts";

export interface DiagnosticAgent {
  key: string;
  deviceId: string;
  deviceName: string;
  source: Agent["source"];
  harness: Agent["harness"];
  title?: string;
  where?: string;
  status: AgentStatus;
  rawStatus: AgentStatus;
  statusSince?: number;
  updatedAt?: number;
  turn?: number;
  subagents?: number;
  subagentsWorking?: number;
  model?: string;
  contextTokens?: number;
  contextLimit?: number;
  canSend?: boolean;
  preview?: string;
  reason?: string;
  watcherCount: number;
}

export interface DiagnosticsBundle {
  generatedAt: number;
  relay: {
    version: string;
    protocol: number;
    startedAt: number;
    uptimeMs: number;
    notifySubs: number;
    assistantReady: boolean;
    models: string[];
    endpoint: string;
    confirm: string;
    replyMode: string;
    voice: { provider: string; model: string; endpoint: string } | null;
  };
  filter: {
    since?: number;
    until?: number;
    agent?: string;
    device?: string;
    source?: string;
    level?: string;
    kind?: string;
    text?: string;
    limit: number;
  };
  devices: Array<{
    id: string;
    name: string;
    kind: Device["kind"];
    online: boolean;
    lastSeenAt: number;
    version?: string;
    platform?: string;
    sources?: Device["sources"];
  }>;
  board: Record<"blocked" | "working" | "done" | "idle", number>;
  agents: DiagnosticAgent[];
  summary: {
    eventsTotal: number;
    byLevel: Record<LogLevel, number>;
    bySource: Record<"relay" | "host" | "viewer", number>;
    last24h: { warn: number; error: number };
    recentWarnings: LogEntry[];
    recentActions: AssistantAction[];
  };
  events: LogEntry[];
}

export interface BuildDiagnosticsInput {
  generatedAt: number;
  relay: DiagnosticsBundle["relay"];
  filter: DiagnosticsBundle["filter"];
  devices: Device[];
  agents: Agent[];
  deviceName: (deviceId: string) => string | undefined;
  reasonOf: (agentKey: string) => string | undefined;
  watcherCount: (agentKey: string) => number;
  last24h: { warn: number; error: number };
  recentActions: AssistantAction[];
  events: LogEntry[];
}

/** Converts live `Agent` rows to sanitized control-panel / diagnostics items. */
export function sanitizeDiagnosticAgents(
  agents: Agent[],
  deviceName: (deviceId: string) => string | undefined,
  reasonOf: (agentKey: string) => string | undefined,
  watcherCount: (agentKey: string) => number,
): DiagnosticAgent[] {
  return agents.map((a) => {
    const status = effectiveAgentStatus(a);
    const reason = reasonOf(a.key);
    return {
      key: a.key,
      deviceId: a.deviceId,
      deviceName: deviceName(a.deviceId) ?? a.deviceId,
      source: a.source,
      harness: a.harness,
      title: a.title ? clipText(redact(a.title), 120) : undefined,
      where: a.where ? clipText(redact(a.where), 120) : undefined,
      status,
      rawStatus: a.status,
      statusSince: a.statusSince,
      updatedAt: a.updatedAt,
      turn: a.turn,
      subagents: a.subagents,
      subagentsWorking: a.subagentsWorking,
      model: a.model,
      contextTokens: a.contextTokens,
      contextLimit: a.contextLimit,
      canSend: a.canSend,
      preview: a.preview ? clipText(redact(a.preview), 180) : undefined,
      reason: reason ? clipText(redact(reason), 180) : undefined,
      watcherCount: watcherCount(a.key),
    };
  });
}

/** Matches log events referencing a target agent key in either `data` or `msg`. */
export function filterEventsForAgent(entries: LogEntry[], agentKey: string, limit: number): LogEntry[] {
  const needle = agentKey.trim();
  if (!needle) return entries.slice(-limit);
  const matched = entries.filter((e) => {
    const dataAgent = typeof e.data?.agent === "string" ? e.data.agent : undefined;
    if (dataAgent === needle) return true;
    if (e.msg.includes(needle)) return true;
    if (e.data) {
      for (const v of Object.values(e.data)) {
        if (typeof v === "string" && v.includes(needle)) return true;
      }
    }
    return false;
  });
  return matched.slice(-limit);
}

/** Assembles a redacted tri-tier diagnostics bundle ready for JSON or Markdown export. */
export function buildDiagnosticsBundle(input: BuildDiagnosticsInput): DiagnosticsBundle {
  const nonShell = input.agents.filter((a) => !a.isShell);
  const board: DiagnosticsBundle["board"] = { blocked: 0, working: 0, done: 0, idle: 0 };
  for (const a of nonShell) {
    const eff = effectiveAgentStatus(a);
    if (eff === "blocked" || eff === "working" || eff === "done" || eff === "idle") board[eff]++;
  }
  const filteredAgents = input.filter.agent
    ? nonShell.filter((a) => a.key === input.filter.agent || a.localId === input.filter.agent)
    : nonShell;

  const byLevel: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
  const bySource: Record<"relay" | "host" | "viewer", number> = { relay: 0, host: 0, viewer: 0 };
  const recentWarnings: LogEntry[] = [];
  for (const e of input.events) {
    byLevel[e.level] = (byLevel[e.level] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    if (e.level === "warn" || e.level === "error") recentWarnings.push(e);
  }

  return {
    generatedAt: input.generatedAt,
    relay: input.relay,
    filter: input.filter,
    devices: input.devices.map((d) => ({
      id: d.id,
      name: d.name,
      kind: d.kind,
      online: d.online,
      lastSeenAt: d.lastSeenAt,
      version: d.version,
      platform: d.platform,
      sources: d.sources,
    })),
    board,
    agents: sanitizeDiagnosticAgents(filteredAgents, input.deviceName, input.reasonOf, input.watcherCount),
    summary: {
      eventsTotal: input.events.length,
      byLevel,
      bySource,
      last24h: input.last24h,
      recentWarnings: recentWarnings.slice(-20),
      recentActions: input.recentActions.map((a) => ({
        ...a,
        summary: clipText(redact(a.summary), 160),
        text: a.text ? clipText(redact(a.text), 160) : undefined,
        result: a.result ? clipText(redact(a.result), 180) : undefined,
      })),
    },
    events: input.events,
  };
}

function fmtIso(ts: number | undefined): string {
  if (!ts) return "-";
  return new Date(ts).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

function fmtSpan(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 120) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

function fmtDataInline(data: Record<string, unknown> | undefined): string {
  if (!data) return "";
  const parts = Object.entries(data).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
  return parts.length ? ` | ${parts.join(" ")}` : "";
}

/** Formats a `DiagnosticsBundle` as concise, high-signal Markdown for AI debugging. */
export function formatDiagnosticsMarkdown(b: DiagnosticsBundle): string {
  const lines: string[] = [];
  lines.push(`# 小爱小爱 Tri-Tier Diagnostics Bundle`);
  lines.push(`- generatedAt: ${fmtIso(b.generatedAt)}`);
  lines.push(
    `- relay: v${b.relay.version} (protocol v${b.relay.protocol}, uptime ${fmtSpan(b.relay.uptimeMs)}, notifySubs=${b.relay.notifySubs}, assistantReady=${b.relay.assistantReady}, confirm=${b.relay.confirm}, replyMode=${b.relay.replyMode})`,
  );
  lines.push(`- models: ${b.relay.models.join(", ") || "none"} (${b.relay.endpoint || "local"})`);
  lines.push(`- voice: ${b.relay.voice ? `${b.relay.voice.provider}:${b.relay.voice.model}` : "off"}`);
  lines.push(
    `- board: blocked=${b.board.blocked}, working=${b.board.working}, done=${b.board.done}, idle=${b.board.idle} | 24h warn=${b.summary.last24h.warn}, error=${b.summary.last24h.error}`,
  );
  lines.push(
    `- filter: since=${b.filter.since ? fmtIso(b.filter.since) : "-"} agent=${b.filter.agent ?? "*"} device=${b.filter.device ?? "*"} source=${b.filter.source ?? "*"} level=${b.filter.level ?? "all"} kind=${b.filter.kind ?? "*"} limit=${b.filter.limit}`,
  );
  lines.push("");

  lines.push(`## Devices (${b.devices.length})`);
  for (const d of b.devices) {
    lines.push(
      `- [${d.online ? "ONLINE" : "offline"}] ${d.name} (${d.kind}, id=${d.id}, ver=${d.version ?? "-"}, platform=${d.platform ?? "-"}, lastSeen=${fmtIso(d.lastSeenAt)}${d.sources?.length ? `, sources=${d.sources.join(",")}` : ""})`,
    );
  }
  lines.push("");

  if (b.agents.length) {
    lines.push(`## Agents (${b.agents.length})`);
    for (const a of b.agents.slice(0, 40)) {
      const ctx = a.contextTokens !== undefined && a.contextLimit ? ` ctx=${Math.round(a.contextTokens / 1000)}k/${Math.round(a.contextLimit / 1000)}k` : "";
      lines.push(
        `- [${a.status}] ${a.title ?? a.key} @ ${a.deviceName} (${a.harness}/${a.source}, key=${a.key}${a.turn ? `, turn=${a.turn}` : ""}${a.subagentsWorking ? `, subWorking=${a.subagentsWorking}` : ""}${a.watcherCount ? `, watchers=${a.watcherCount}` : ""}${ctx})`,
      );
      if (a.reason) lines.push(`  - reason: ${a.reason}`);
      else if (a.preview) lines.push(`  - preview: ${a.preview}`);
    }
    lines.push("");
  }

  if (b.summary.recentWarnings.length) {
    lines.push(`## Recent Warn / Error (${b.summary.recentWarnings.length})`);
    for (const e of b.summary.recentWarnings) {
      const who = e.source === "relay" ? "relay" : `${e.source}/${e.deviceName ?? e.device ?? "?"}`;
      lines.push(`- ${fmtIso(e.ts)} [${e.level.toUpperCase()}] ${who} ${e.kind}: ${e.msg}${fmtDataInline(e.data)}`);
    }
    lines.push("");
  }

  if (b.summary.recentActions.length) {
    lines.push(`## Recent Assistant Actions (${b.summary.recentActions.length})`);
    for (const a of b.summary.recentActions.slice(0, 15)) {
      lines.push(`- ${fmtIso(a.createdAt)} [${a.state}] ${a.kind}: ${a.summary}${a.result ? ` -> ${a.result}` : ""}`);
    }
    lines.push("");
  }

  lines.push(
    `## Merged Timeline (${b.events.length} rows | relay=${b.summary.bySource.relay}, host=${b.summary.bySource.host}, viewer=${b.summary.bySource.viewer})`,
  );
  lines.push("```text");
  for (const e of b.events) {
    const who = e.source === "relay" ? "relay" : `${e.source}/${e.deviceName ?? e.device ?? "?"}`;
    lines.push(`${fmtIso(e.ts)} ${e.level.toUpperCase().padEnd(5)} [${who}] ${e.kind}: ${e.msg}${fmtDataInline(e.data)}`);
  }
  lines.push("```");
  return lines.join("\n");
}
