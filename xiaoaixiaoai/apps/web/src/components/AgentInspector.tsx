import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  effectiveAgentStatus,
  type Agent,
  type ConvEvent,
  type Device,
  type RuntimePendingQuestion,
  type RuntimeQuestionAnswerItem,
  type SubSession,
} from "@xiaoaixiaoai/protocol";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cpu,
  GitBranch,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Send,
  Square,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import type { RelaySocket } from "../lib/relay-ws";
import { Markdown } from "./Markdown";

interface Props {
  agent: Agent;
  device?: Device;
  socket: RelaySocket | null;
  onClose: () => void;
  onToast: (msg: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  blocked: "需要你",
  working: "工作中",
  done: "已完成",
  idle: "空闲",
  unknown: "未知",
};

function fmtTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const cmd = obj.CommandLine ?? obj.command ?? obj.cmd;
    if (typeof cmd === "string" && cmd.trim()) return cmd.trim();
    const path = obj.Path ?? obj.path ?? obj.TargetFile ?? obj.AbsolutePath;
    if (typeof path === "string" && path.trim()) return path.trim();
    const query = obj.Query ?? obj.query ?? obj.Pattern;
    if (typeof query === "string" && query.trim()) return query.trim();
    try {
      const s = JSON.stringify(input, null, 2);
      return s.length > 400 ? `${s.slice(0, 400)}…` : s;
    } catch {
      return String(input);
    }
  }
  return `${name}: ${String(input)}`;
}

function parseExitCode(output: string): number | null {
  const m = /(?:^|\n)(?:exit(?:\s+code)?|Command exited with code)[:=\s]+(-?\d+)/i.exec(output);
  return m ? Number(m[1]) : null;
}

type RenderRow =
  | { kind: "event"; ev: ConvEvent }
  | { kind: "tool"; id: string; name: string; input: unknown; result?: Extract<ConvEvent, { kind: "tool_result" }>; ts: number };

function ToolCard({ row }: { row: Extract<RenderRow, { kind: "tool" }> }) {
  const isCmd = /run_command|bash|exec|shell|terminal/i.test(row.name);
  const exitCode = row.result ? parseExitCode(row.result.output) : null;
  const isErr = Boolean(row.result?.is_error) || (exitCode !== null && exitCode !== 0);
  const [open, setOpen] = useState(isErr || isCmd);
  const summary = summarizeToolInput(row.name, row.input);

  return (
    <div className={`tool-box ${isErr ? "err" : ""}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((v) => !v)}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0, overflow: "hidden" }}>
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Wrench size={13} />
          <span style={{ fontFamily: "ui-monospace, Consolas, monospace" }}>{row.name}</span>
          {summary && (
            <span style={{ color: "var(--muted)", fontWeight: 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }}>
              {summary.split("\n")[0]}
            </span>
          )}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {exitCode !== null && (
            <span className={`status-pill ${exitCode === 0 ? "status-working" : "status-blocked"}`}>exit {exitCode}</span>
          )}
          {row.result?.is_error && exitCode === null && <span className="status-pill status-blocked">失败</span>}
          {!row.result && <span className="status-pill status-idle">执行中</span>}
          <span style={{ fontSize: 11, color: "var(--faint)", fontWeight: 400 }}>{fmtTime(row.ts)}</span>
        </span>
      </button>
      {open && (
        <pre className="tool-body">
          {summary ? `$ ${summary}\n` : ""}
          {summary && row.result?.output ? "\n" : ""}
          {row.result ? row.result.output || "(无输出)" : "(等待工具返回结果…)"}
        </pre>
      )}
    </div>
  );
}

function PendingQuestionCard({
  pq,
  canSend,
  onSubmit,
}: {
  pq: RuntimePendingQuestion;
  canSend: boolean;
  onSubmit: (pq: RuntimePendingQuestion, answers: RuntimeQuestionAnswerItem[]) => Promise<void>;
}) {
  const [selectedMap, setSelectedMap] = useState<Record<string, string[]>>({});
  const [customMap, setCustomMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const toggleOption = (qId: string, label: string, multi?: boolean) => {
    setSelectedMap((prev) => {
      const cur = prev[qId] ?? [];
      if (!multi) return { ...prev, [qId]: cur.includes(label) ? [] : [label] };
      return { ...prev, [qId]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
    });
  };

  const submit = async () => {
    setSubmitting(true);
    try {
      const answers: RuntimeQuestionAnswerItem[] = pq.questions.map((q) => ({
        id: q.id,
        selected: selectedMap[q.id] ?? [],
        ...(customMap[q.id]?.trim() ? { custom: customMap[q.id]!.trim() } : {}),
      }));
      await onSubmit(pq, answers);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="notice-card blocked" style={{ flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--error)" }}>
        需要你确认 / 回答 ({pq.state === "readonly" ? "只读展示" : "待处理"})
      </div>
      {pq.questions.map((q) => (
        <div key={q.id} style={{ display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
          {q.header && <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--muted)" }}>{q.header}</div>}
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{q.question}</div>
          {q.detail && <div style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "pre-wrap" }}>{q.detail}</div>}
          {q.options && q.options.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              {q.options.map((opt) => {
                const active = (selectedMap[q.id] ?? []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    disabled={!canSend || pq.state === "readonly"}
                    className={`icon-btn ${active ? "active" : ""}`}
                    style={{ justifyContent: "flex-start", textAlign: "left", padding: "7px 10px" }}
                    onClick={() => toggleOption(q.id, opt.label, q.multiSelect)}
                  >
                    <CheckCircle2 size={14} />
                    <span>
                      <strong>{opt.label}</strong>
                      {opt.description ? ` — ${opt.description}` : ""}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {canSend && pq.state !== "readonly" && (
            <input
              className="search-input"
              value={customMap[q.id] ?? ""}
              onChange={(e) => setCustomMap((p) => ({ ...p, [q.id]: e.target.value }))}
              placeholder="或输入自定义回复…"
            />
          )}
        </div>
      ))}
      {canSend && pq.state !== "readonly" && (
        <button type="button" className="icon-btn primary" disabled={submitting} onClick={() => void submit()}>
          {submitting ? <Loader2 size={14} /> : <Send size={14} />}
          提交回复
        </button>
      )}
    </div>
  );
}

export function AgentInspector({ agent, device, socket, onClose, onToast }: Props) {
  const [viewMode, setViewMode] = useState<"chat" | "terminal">("chat");
  const [events, setEvents] = useState<ConvEvent[]>([]);
  const [more, setMore] = useState(false);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [pendingQuestions, setPendingQuestions] = useState<RuntimePendingQuestion[]>([]);
  const [canSend, setCanSend] = useState<boolean>(agent.canSend !== false);
  const [readOnlyReason, setReadOnlyReason] = useState<string | undefined>(agent.readOnlyReason);
  const [terminalText, setTerminalText] = useState<string>("");
  const [children, setChildren] = useState<SubSession[]>([]);
  const [activeSub, setActiveSub] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const effStatus = effectiveAgentStatus(agent);

  const loadData = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!socket) return;
      if (!opts.silent) setLoading(true);
      setError(null);
      try {
        if (viewMode === "chat") {
          const res = await socket.rpc(agent.deviceId, "session.events", {
            agent: agent.localId,
            ...(activeSub ? { sub: activeSub } : {}),
            limit: 60,
          });
          setEvents(res.events);
          setMore(res.more);
          setNextBefore(res.nextBefore ?? null);
          setPendingQuestions(res.pendingQuestions ?? []);
          setCanSend(res.canSend ?? agent.canSend !== false);
          setReadOnlyReason(res.readOnlyReason ?? agent.readOnlyReason);
        } else {
          const term = await socket.rpc(agent.deviceId, "terminal.read", {
            agent: agent.localId,
            lines: 200,
          });
          setTerminalText(term.text || "(当前屏幕为空)");
        }
      } catch (err) {
        setError((err as Error).message);
      } finally {
        if (!opts.silent) setLoading(false);
      }
    },
    [socket, agent.deviceId, agent.localId, agent.canSend, agent.readOnlyReason, viewMode, activeSub],
  );

  const loadChildren = useCallback(async () => {
    if (!socket) return;
    try {
      const res = await socket.rpc(agent.deviceId, "session.children", { agent: agent.localId });
      setChildren(res.sessions ?? []);
    } catch {
      setChildren([]);
    }
  }, [socket, agent.deviceId, agent.localId]);

  useEffect(() => {
    setActiveSub(undefined);
    setEvents([]);
    setTerminalText("");
    setPendingQuestions([]);
    setViewMode("chat");
  }, [agent.key]);

  useEffect(() => {
    void loadData();
    void loadChildren();
    if (socket && effStatus === "done") {
      void socket.rpc(agent.deviceId, "agent.seen", { agent: agent.localId }).catch(() => {});
    }
  }, [loadData, loadChildren, socket, agent.deviceId, agent.localId, effStatus]);

  // Auto-refresh while working or blocked
  useEffect(() => {
    if (effStatus !== "working" && effStatus !== "blocked") return;
    const id = window.setInterval(() => {
      void loadData({ silent: true });
    }, 4500);
    return () => window.clearInterval(id);
  }, [effStatus, loadData]);

  const loadOlder = async () => {
    if (!socket || !nextBefore || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const res = await socket.rpc(agent.deviceId, "session.events", {
        agent: agent.localId,
        ...(activeSub ? { sub: activeSub } : {}),
        limit: 60,
        before: nextBefore,
      });
      setEvents((prev) => [...res.events, ...prev]);
      setMore(res.more);
      setNextBefore(res.nextBefore ?? null);
    } catch (err) {
      onToast(`加载更早记录失败：${(err as Error).message}`);
    } finally {
      setLoadingOlder(false);
    }
  };

  const rows = useMemo<RenderRow[]>(() => {
    const out: RenderRow[] = [];
    const byCallId = new Map<string, Extract<RenderRow, { kind: "tool" }>>();
    for (const ev of events) {
      if (ev.kind === "turn_start" || ev.kind === "turn_end" || ev.kind === "usage") continue;
      if (ev.kind === "tool_call") {
        const row: Extract<RenderRow, { kind: "tool" }> = {
          kind: "tool",
          id: ev.id,
          name: ev.name,
          input: ev.input,
          ts: ev.ts,
        };
        byCallId.set(ev.call_id, row);
        out.push(row);
      } else if (ev.kind === "tool_result") {
        const existing = byCallId.get(ev.call_id);
        if (existing) {
          existing.result = ev;
        } else {
          out.push({
            kind: "tool",
            id: ev.id,
            name: ev.name || "tool_result",
            input: null,
            result: ev,
            ts: ev.ts,
          });
        }
      } else {
        out.push({ kind: "event", ev });
      }
    }
    return out;
  }, [events]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!socket || !text || sending) return;
    setSending(true);
    try {
      await socket.rpc(agent.deviceId, "terminal.send", { agent: agent.localId, text, enter: true });
      setDraft("");
      onToast("已发送给 Agent");
      window.setTimeout(() => void loadData({ silent: true }), 800);
    } catch (err) {
      onToast(`发送失败：${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const handleInterrupt = async () => {
    if (!socket) return;
    try {
      const res = await socket.rpc(agent.deviceId, "terminal.interrupt", { agent: agent.localId });
      onToast(res.report || "已发送中断信号");
      window.setTimeout(() => void loadData({ silent: true }), 800);
    } catch (err) {
      onToast(`中断失败：${(err as Error).message}`);
    }
  };

  const handleAnswerPending = async (pq: RuntimePendingQuestion, answers: RuntimeQuestionAnswerItem[]) => {
    if (!socket) return;
    const summary = answers
      .map((a) => [...a.selected, a.custom].filter(Boolean).join(" / "))
      .filter(Boolean)
      .join("\n");
    if (!summary) {
      onToast("请至少选择一个选项或输入回复内容");
      return;
    }
    try {
      // Runtime bridge encodes localId as `<runtime>~<projectId>~<sessionId>`.
      const parts = agent.localId.split("~");
      if (agent.source === "runtime" && parts.length === 3 && (parts[0] === "dsh" || parts[0] === "codex" || parts[0] === "antigravity")) {
        const reqId =
          typeof crypto?.randomUUID === "function"
            ? crypto.randomUUID()
            : "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
                const r = (Math.random() * 16) | 0;
                return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
              });
        await socket.rpc(agent.deviceId, "runtimeSessions.answer", {
          runtime: parts[0],
          projectId: parts[1]!,
          sessionId: parts[2]!,
          requestId: reqId,
          callId: pq.callId,
          answers,
        });
      } else {
        await socket.rpc(agent.deviceId, "terminal.send", { agent: agent.localId, text: summary, enter: true });
      }
      onToast("已提交回复");
      window.setTimeout(() => void loadData({ silent: true }), 900);
    } catch (err) {
      onToast(`提交失败：${(err as Error).message}`);
    }
  };

  return (
    <aside className="inspector-pane">
      <div className="pane-header">
        <div className="pane-title" style={{ flex: 1 }}>
          <span className={`status-pill status-${effStatus}`}>{STATUS_LABEL[effStatus] ?? effStatus}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {agent.title || agent.name || agent.localId}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            className={`icon-btn ${viewMode === "chat" ? "active" : ""}`}
            onClick={() => setViewMode("chat")}
            title="结构化对话"
          >
            <MessageSquareText size={14} /> 对话
          </button>
          <button
            type="button"
            className={`icon-btn ${viewMode === "terminal" ? "active" : ""}`}
            onClick={() => setViewMode("terminal")}
            title="终端屏幕"
          >
            <Terminal size={14} /> 终端
          </button>
          <button type="button" className="icon-btn" onClick={() => void loadData()} title="刷新">
            <RefreshCw size={14} />
          </button>
          {effStatus === "working" && canSend && (
            <button type="button" className="icon-btn danger" onClick={() => void handleInterrupt()} title="中断当前执行">
              <Square size={13} /> 停止
            </button>
          )}
          <button type="button" className="icon-btn" onClick={onClose} title="收起右侧面板">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Metadata strip */}
      <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--divider)", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", fontSize: 12, color: "var(--muted)" }}>
        <span className="tag">{device?.name ?? agent.deviceId}</span>
        <span className="tag">{agent.harness}</span>
        {agent.model && (
          <span className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Cpu size={11} /> {agent.model}
          </span>
        )}
        {agent.contextTokens !== undefined && agent.contextLimit ? (
          <span className="tag">
            上下文 {Math.round((agent.contextTokens / agent.contextLimit) * 100)}%
          </span>
        ) : null}
        {agent.cwd && (
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={agent.cwd}>
            {agent.cwd}
          </span>
        )}
      </div>

      {/* Subagent switcher */}
      {children.length > 0 && viewMode === "chat" && (
        <div style={{ padding: "7px 16px", borderBottom: "1px solid var(--divider)", display: "flex", alignItems: "center", gap: 6, overflowX: "auto" }}>
          <GitBranch size={13} style={{ color: "var(--faint)", flexShrink: 0 }} />
          <button type="button" className={`chip-btn ${!activeSub ? "active" : ""}`} onClick={() => setActiveSub(undefined)}>
            主会话
          </button>
          {children.map((sub) => (
            <button
              key={sub.key}
              type="button"
              className={`chip-btn ${activeSub === sub.key ? "active" : ""}`}
              onClick={() => setActiveSub(sub.key)}
            >
              {sub.title || sub.harness} ({sub.status === "working" ? "运行中" : "空闲"})
            </button>
          ))}
        </div>
      )}

      {/* Body */}
      <div ref={scrollRef} className="messages-scroll" style={{ padding: "14px 16px" }}>
        {loading && rows.length === 0 && !terminalText ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--muted)", margin: "24px auto" }}>
            <Loader2 size={16} /> 加载会话内容中…
          </div>
        ) : error ? (
          <div style={{ padding: 12, borderRadius: 12, background: "var(--error-bg)", color: "var(--error)", fontSize: 13 }}>
            读取失败：{error}
          </div>
        ) : viewMode === "terminal" ? (
          <pre className="tool-body" style={{ maxHeight: "none", borderRadius: 14, flex: 1 }}>
            {terminalText}
          </pre>
        ) : (
          <>
            {more && nextBefore && (
              <button type="button" className="icon-btn" style={{ alignSelf: "center" }} disabled={loadingOlder} onClick={() => void loadOlder()}>
                {loadingOlder ? "加载中…" : "加载更早的对话记录"}
              </button>
            )}
            {agent.statusNote && (
              <div className="notice-card blocked">
                <div style={{ fontSize: 13 }}>
                  <strong>状态说明：</strong>
                  {agent.statusNote}
                </div>
              </div>
            )}
            {rows.length === 0 && (
              <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 13, marginTop: 28 }}>
                暂无结构化对话记录，可切换右上角「终端」查看实时屏幕。
              </div>
            )}
            {rows.map((row) => {
              if (row.kind === "tool") return <ToolCard key={row.id} row={row} />;
              const ev = row.ev;
              if (ev.kind === "user_message") {
                return (
                  <div key={ev.id} className="msg-row user" style={{ maxWidth: "94%" }}>
                    <div className="bubble" style={{ fontSize: 13.5 }}>
                      <div style={{ whiteSpace: "pre-wrap" }}>{ev.text}</div>
                      <div className="bubble-tools" style={{ justifyContent: "flex-end" }}>
                        {fmtTime(ev.ts)}
                      </div>
                    </div>
                  </div>
                );
              }
              if (ev.kind === "assistant_message") {
                return (
                  <div key={ev.id} className="msg-row assistant" style={{ maxWidth: "98%" }}>
                    <div className="bubble" style={{ fontSize: 13.5, width: "100%" }}>
                      <Markdown text={ev.text} />
                      <div className="bubble-tools">
                        <span>{fmtTime(ev.ts)}</span>
                        {ev.model && <span>· {ev.model}</span>}
                        {ev.truncated && <span style={{ color: "var(--error)" }}>· 已截断</span>}
                      </div>
                    </div>
                  </div>
                );
              }
              if (ev.kind === "reasoning") {
                return (
                  <details key={ev.id} className="tool-box">
                    <summary className="tool-head" style={{ cursor: "pointer", color: "var(--muted)" }}>
                      <span>思考过程</span>
                      <span style={{ fontSize: 11, color: "var(--faint)", fontWeight: 400 }}>{fmtTime(ev.ts)}</span>
                    </summary>
                    <div style={{ padding: "8px 12px", fontSize: 12.5, color: "var(--muted)", whiteSpace: "pre-wrap" }}>
                      {ev.text}
                    </div>
                  </details>
                );
              }
              if (ev.kind === "system") {
                return (
                  <div key={ev.id} className="time-divider" title={ev.text}>
                    {ev.summary || ev.text.slice(0, 80)}
                  </div>
                );
              }
              return null;
            })}

            {pendingQuestions.map((pq) => (
              <PendingQuestionCard key={pq.callId} pq={pq} canSend={canSend} onSubmit={handleAnswerPending} />
            ))}
          </>
        )}
      </div>

      {/* Composer */}
      <div className="composer-wrap">
        {!canSend ? (
          <div style={{ fontSize: 12.5, color: "var(--muted)", textAlign: "center", padding: "6px 0" }}>
            {readOnlyReason || "该会话当前为只读状态，暂不可直接发送消息"}
          </div>
        ) : (
          <div className="composer-box">
            <textarea
              className="composer-textarea"
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="直接向这个 Agent 发送指令（Enter 发送，Shift+Enter 换行）"
            />
            <button type="button" className="icon-btn primary" disabled={sending || !draft.trim()} onClick={() => void handleSend()}>
              {sending ? <Loader2 size={15} /> : <Send size={15} />}
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}
