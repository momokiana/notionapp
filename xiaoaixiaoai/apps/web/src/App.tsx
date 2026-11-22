import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  effectiveAgentStatus,
  STATUS_ORDER,
  type Agent,
  type AgentStatus,
  type AssistantItem,
  type AssistantMemoryItem,
  type AssistantPersonaConfig,
  type AssistantState,
  type Device,
  type LedgerState,
  type PersonaPresetSummary,
  type ServerFrame,
} from "@xiaoaixiaoai/protocol";
import {
  Bell,
  BellOff,
  BookHeart,
  Check,
  Copy,
  CornerUpLeft,
  LayoutDashboard,
  Loader2,
  LogOut,
  Mic,
  Moon,
  Phone,
  Plus,
  QrCode,
  Send,
  ShieldAlert,
  ShieldCheck,
  Square,
  Sun,
  Trash2,
  Volume2,
  VolumeX,
  Wallet,
  X,
} from "lucide-react";
import { createRelayApi, loadAuth, saveAuth, type StoredAuth } from "./lib/api";
import { base64ToBytes, PcmStreamPlayer, VoiceNoteRecorder, WebLiveCall, type LiveCallSnapshot } from "./lib/audio";
import { RelaySocket, type WsStatus } from "./lib/relay-ws";
import { AgentInspector } from "./components/AgentInspector";
import { CallOverlay } from "./components/CallOverlay";
import { LedgerView } from "./components/LedgerView";
import { LoginView } from "./components/LoginView";
import { Markdown } from "./components/Markdown";
import { MemoryProfileView } from "./components/MemoryProfileView";
import { NewSessionModal } from "./components/NewSessionModal";

type NavTab = "console" | "ledger" | "memory";
type StatusFilter = "all" | "blocked" | "working" | "done" | "idle";

const STATUS_LABEL: Record<AgentStatus, string> = {
  blocked: "需要你",
  working: "工作中",
  done: "已完成",
  idle: "空闲",
  unknown: "未知",
};

function fmtClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtRel(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)}分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}小时前`;
  return `${Math.floor(diff / 86400)}天前`;
}

export function App() {
  const [auth, setAuth] = useState<StoredAuth | null>(() => loadAuth());
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    const saved = localStorage.getItem("xiaoaixiaoai.web.theme");
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [tab, setTab] = useState<NavTab>("console");
  const [wsStatus, setWsStatus] = useState<WsStatus>("disconnected");
  const [devices, setDevices] = useState<Device[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [assistant, setAssistant] = useState<AssistantState | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | undefined>(undefined);
  const [profile, setProfile] = useState<AssistantPersonaConfig | null>(null);
  const [presets, setPresets] = useState<PersonaPresetSummary[]>([]);
  const [memories, setMemories] = useState<AssistantMemoryItem[]>([]);
  const [ledger, setLedger] = useState<LedgerState | null>(null);

  const [selectedAgentKey, setSelectedAgentKey] = useState<string | null>(null);
  const [agentQuery, setAgentQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showNewSession, setShowNewSession] = useState(false);
  const [pairModal, setPairModal] = useState<{ code: string; link: string; expiresAt: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);

  // Chat composer
  const [draft, setDraft] = useState("");
  const [quote, setQuote] = useState<AssistantItem | null>(null);
  const [sending, setSending] = useState(false);

  // Voice in chat (TTS playback + PTT voice note)
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const recorderRef = useRef<VoiceNoteRecorder | null>(null);
  const [speakingItemId, setSpeakingItemId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recordLevel, setRecordLevel] = useState(0);
  const [transcribing, setTranscribing] = useState(false);

  // Live voice call
  const liveCallRef = useRef<WebLiveCall | null>(null);
  const [callSnap, setCallSnap] = useState<LiveCallSnapshot | null>(null);

  // Browser desktop notifications
  const [notifPerm, setNotifPerm] = useState<NotificationPermission>(() =>
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );

  const socketRef = useRef<RelaySocket | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const api = useMemo(() => (auth ? createRelayApi(auth) : null), [auth]);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("xiaoaixiaoai.web.theme", theme);
  }, [theme]);

  const refreshAssistant = useCallback(async () => {
    if (!api) return;
    try {
      const state = await api.getAssistant();
      setAssistant(state);
    } catch {}
  }, [api]);

  const refreshProfileAndMemories = useCallback(
    async (q?: string) => {
      if (!api) return;
      try {
        const [p, m] = await Promise.all([api.getProfile(), api.getMemories(q)]);
        setProfile(p.profile);
        setPresets(p.presets);
        setMemories(m.items);
      } catch {}
    },
    [api],
  );

  const refreshLedger = useCallback(async () => {
    if (!api) return;
    try {
      const data = await api.getLedger();
      setLedger(data);
    } catch {}
  }, [api]);

  // Ensure PCM player exists
  const getPlayer = useCallback(() => {
    if (!playerRef.current) playerRef.current = new PcmStreamPlayer();
    return playerRef.current;
  }, []);

  // Connect Relay WS & load initial state
  useEffect(() => {
    if (!auth || !api) return;
    let alive = true;
    void refreshAssistant();
    void refreshProfileAndMemories();
    void refreshLedger();
    void api.warmupVoice();

    const handleFrame = (frame: ServerFrame) => {
      if (!alive) return;
      switch (frame.type) {
        case "snapshot":
          setDevices(frame.devices);
          setAgents(frame.agents.filter((a) => !a.isShell));
          break;
        case "device":
          setDevices((prev) => {
            const idx = prev.findIndex((d) => d.id === frame.device.id);
            if (idx >= 0) {
              const next = prev.slice();
              next[idx] = frame.device;
              return next;
            }
            return [...prev, frame.device];
          });
          break;
        case "device_removed":
          setDevices((prev) => prev.filter((d) => d.id !== frame.id));
          setAgents((prev) => prev.filter((a) => a.deviceId !== frame.id));
          break;
        case "agents":
          setAgents((prev) => {
            const others = prev.filter((a) => a.deviceId !== frame.deviceId);
            return [...others, ...frame.agents.filter((a) => !a.isShell)];
          });
          break;
        case "assistant_item":
          setAssistant((prev) => {
            if (!prev) return prev;
            const idx = prev.items.findIndex((it) => it.id === frame.item.id);
            const items = idx >= 0 ? prev.items.map((it, i) => (i === idx ? frame.item : it)) : [...prev.items, frame.item];
            return { ...prev, items };
          });
          if (frame.item.role === "notice" && frame.item.notice && document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
            const n = new Notification(frame.item.notice.title || "小爱小爱提醒", {
              body: frame.item.notice.body || frame.item.text,
              icon: "./icon.png",
            });
            n.onclick = () => {
              window.focus();
              if (frame.item.notice?.agent) {
                setTab("console");
                setSelectedAgentKey(frame.item.notice.agent);
              }
              n.close();
            };
          }
          break;
        case "assistant_busy":
          setAssistant((prev) => (prev ? { ...prev, busy: frame.busy } : prev));
          setBusyLabel(frame.busy ? frame.label : undefined);
          break;
        case "assistant_reset":
          void refreshAssistant();
          break;
        case "assistant_profile":
          setProfile(frame.profile);
          break;
        case "assistant_memories":
          void api.getMemories().then((r) => alive && setMemories(r.items)).catch(() => {});
          break;
        case "ledger_updated":
          void refreshLedger();
          break;
        case "assistant_speech": {
          const player = getPlayer();
          if (frame.phase === "start") {
            setSpeakingItemId(frame.itemId);
            player.start(frame.utteranceId, frame.sampleRate ?? 24_000, () => {
              setSpeakingItemId((cur) => (cur === frame.itemId ? null : cur));
            });
          } else if (frame.phase === "chunk" && frame.pcmBase64) {
            player.feedBytes(frame.utteranceId, base64ToBytes(frame.pcmBase64));
          } else if (frame.phase === "done") {
            player.finish(frame.utteranceId);
          } else if (frame.phase === "stop") {
            player.stop(frame.utteranceId);
            setSpeakingItemId((cur) => (cur === frame.itemId ? null : cur));
          }
          break;
        }
      }
    };

    const sock = new RelaySocket(auth, handleFrame, (st) => {
      if (!alive) return;
      setWsStatus(st);
      if (st === "unauthorized") {
        showToast("登录凭证已失效，请重新配对");
        saveAuth(null);
        setAuth(null);
      }
    });
    socketRef.current = sock;
    sock.start();

    return () => {
      alive = false;
      sock.stop();
      socketRef.current = null;
      playerRef.current?.stop();
      liveCallRef.current?.hangup();
      recorderRef.current?.cancel();
    };
  }, [auth, api, refreshAssistant, refreshProfileAndMemories, refreshLedger, getPlayer, showToast]);

  // Auto-scroll chat when items grow
  const itemCount = assistant?.items.length ?? 0;
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [itemCount, assistant?.busy]);

  const hosts = useMemo(() => devices.filter((d) => d.kind === "host"), [devices]);
  const deviceById = useMemo(() => new Map(devices.map((d) => [d.id, d])), [devices]);

  const filteredAgents = useMemo(() => {
    const q = agentQuery.trim().toLowerCase();
    return agents
      .filter((a) => {
        const st = effectiveAgentStatus(a);
        if (statusFilter !== "all" && st !== statusFilter) return false;
        if (!q) return true;
        const dev = deviceById.get(a.deviceId)?.name ?? "";
        return (
          (a.title ?? "").toLowerCase().includes(q) ||
          (a.name ?? "").toLowerCase().includes(q) ||
          a.harness.toLowerCase().includes(q) ||
          (a.cwd ?? "").toLowerCase().includes(q) ||
          dev.toLowerCase().includes(q)
        );
      })
      .sort((a, b) => {
        const sa = STATUS_ORDER[effectiveAgentStatus(a)] ?? 9;
        const sb = STATUS_ORDER[effectiveAgentStatus(b)] ?? 9;
        if (sa !== sb) return sa - sb;
        return b.updatedAt - a.updatedAt;
      });
  }, [agents, agentQuery, statusFilter, deviceById]);

  const statusCounts = useMemo(() => {
    const c = { all: agents.length, blocked: 0, working: 0, done: 0, idle: 0 };
    for (const a of agents) {
      const s = effectiveAgentStatus(a);
      if (s === "blocked" || s === "working" || s === "done" || s === "idle") c[s]++;
    }
    return c;
  }, [agents]);

  const selectedAgent = useMemo(
    () => (selectedAgentKey ? agents.find((a) => a.key === selectedAgentKey) ?? null : null),
    [agents, selectedAgentKey],
  );

  const assistantName = profile?.name || assistant?.settings?.name || "爱弥斯";
  const replyMode = assistant?.settings?.replyMode ?? "text";
  const confirmMode = assistant?.settings?.confirm ?? "never";

  const handleSendChat = async () => {
    if (!api || sending) return;
    const raw = draft.trim();
    if (!raw) return;
    getPlayer().unlock();
    const text = quote ? `> 引用：${quote.text.slice(0, 140).replace(/\n+/g, " ")}\n\n${raw}` : raw;
    setSending(true);
    setDraft("");
    setQuote(null);
    try {
      await api.sendMessage(text);
    } catch (err) {
      setDraft(raw);
      showToast(`发送失败：${(err as Error).message}`);
    } finally {
      setSending(false);
    }
  };

  const handleToggleVoiceNote = async () => {
    if (!api || transcribing) return;
    getPlayer().unlock();
    if (!recording) {
      try {
        if (!recorderRef.current) recorderRef.current = new VoiceNoteRecorder();
        await recorderRef.current.start((lvl) => setRecordLevel(lvl));
        setRecording(true);
      } catch (err) {
        showToast((err as Error).message);
      }
      return;
    }
    // Stop and send
    setRecording(false);
    setRecordLevel(0);
    const rec = recorderRef.current?.stop();
    if (!rec || rec.durationMs < 350) {
      showToast("录音时间太短，已取消");
      return;
    }
    setTranscribing(true);
    try {
      const res = await api.sendVoiceNote(rec.audioBase64, rec.sampleRate);
      if (!res.text) showToast("没有识别到语音内容");
    } catch (err) {
      showToast(`语音发送失败：${(err as Error).message}`);
    } finally {
      setTranscribing(false);
    }
  };

  const handleCancelVoiceNote = () => {
    recorderRef.current?.cancel();
    setRecording(false);
    setRecordLevel(0);
  };

  const handleSpeakItem = async (item: AssistantItem) => {
    if (!api) return;
    const player = getPlayer();
    player.unlock();
    if (speakingItemId === item.id) {
      player.stop();
      setSpeakingItemId(null);
      void api.stopSpeak();
      return;
    }
    try {
      await api.speakItem(item.id);
    } catch (err) {
      showToast(`朗读失败：${(err as Error).message}`);
    }
  };

  const handleStartCall = async () => {
    if (!auth || !api) return;
    if (callSnap && callSnap.status !== "ended") return;
    playerRef.current?.stop();
    setSpeakingItemId(null);
    void api.stopSpeak();
    const call = new WebLiveCall((snap) => {
      setCallSnap(snap);
      if (snap.status === "ended") {
        window.setTimeout(() => {
          setCallSnap((cur) => (cur?.status === "ended" ? null : cur));
        }, 1600);
      }
    });
    liveCallRef.current = call;
    try {
      await call.start(auth.server, auth.token);
    } catch (err) {
      setCallSnap(null);
      showToast((err as Error).message);
    }
  };

  const handleMintPairCode = async () => {
    if (!api) return;
    try {
      const res = await api.mintPairCode("viewer");
      setPairModal(res);
    } catch (err) {
      showToast(`生成配对码失败：${(err as Error).message}`);
    }
  };

  const handleRequestNotif = async () => {
    if (typeof Notification === "undefined") {
      showToast("当前浏览器不支持桌面通知");
      return;
    }
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
    showToast(perm === "granted" ? "已开启桌面提醒通知" : "未授予通知权限");
  };

  const handleLogout = () => {
    socketRef.current?.stop();
    liveCallRef.current?.hangup();
    playerRef.current?.stop();
    saveAuth(null);
    setAuth(null);
    setDevices([]);
    setAgents([]);
    setAssistant(null);
    setSelectedAgentKey(null);
  };

  if (!auth || !api) {
    return (
      <LoginView
        onAuthed={(next) => {
          saveAuth(next);
          setAuth(next);
        }}
      />
    );
  }

  return (
    <div className="app-shell">
      {/* Topbar */}
      <header className="topbar">
        <div className="brand-group">
          <img src="./aimisi-avatar.jpg" alt={assistantName} className="brand-avatar" />
          <span className="brand-title">{assistantName}</span>
          <span className={`conn-pill ${wsStatus === "connected" ? "ok" : wsStatus === "disconnected" ? "err" : ""}`}>
            <span className="dot" />
            {wsStatus === "connected" ? "已连接" : wsStatus === "connecting" ? "连接中" : "已断开"}
          </span>
        </div>

        <nav className="nav-tabs" aria-label="主导航">
          <button type="button" className={`nav-tab ${tab === "console" ? "active" : ""}`} onClick={() => setTab("console")}>
            <LayoutDashboard size={15} /> 总控台
          </button>
          <button type="button" className={`nav-tab ${tab === "ledger" ? "active" : ""}`} onClick={() => { setTab("ledger"); void refreshLedger(); }}>
            <Wallet size={15} /> 微信账单
          </button>
          <button type="button" className={`nav-tab ${tab === "memory" ? "active" : ""}`} onClick={() => { setTab("memory"); void refreshProfileAndMemories(); }}>
            <BookHeart size={15} /> 记忆与人设
          </button>
        </nav>

        <div className="topbar-actions">
          <button
            type="button"
            className="icon-btn primary"
            onClick={() => void handleStartCall()}
            disabled={Boolean(callSnap && callSnap.status !== "ended")}
            title={assistant?.voice ? "发起实时语音通话" : "中转站未配置实时语音时可能无法接通"}
          >
            <Phone size={14} /> 语音通话
          </button>
          <button
            type="button"
            className={`icon-btn ${notifPerm === "granted" ? "active" : ""}`}
            onClick={() => void handleRequestNotif()}
            title={notifPerm === "granted" ? "桌面通知已开启" : "开启后台桌面通知"}
          >
            {notifPerm === "granted" ? <Bell size={14} /> : <BellOff size={14} />}
          </button>
          <button type="button" className="icon-btn" onClick={() => void handleMintPairCode()} title="生成新设备配对码">
            <QrCode size={14} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
            title="切换浅色/深色主题"
          >
            {theme === "light" ? <Moon size={14} /> : <Sun size={14} />}
          </button>
          <button type="button" className="icon-btn" onClick={handleLogout} title="退出当前桌面端登录">
            <LogOut size={14} />
          </button>
        </div>
      </header>

      {/* Main Content */}
      {tab === "console" && (
        <div className="workspace">
          {/* Left Sidebar: Devices + Agents */}
          <aside className="sidebar">
            <div className="sidebar-section">
              <div className="section-head">
                <span>电脑主机 ({hosts.filter((h) => h.online).length}/{hosts.length})</span>
                <button type="button" className="mini-btn" onClick={() => setShowNewSession(true)}>
                  <Plus size={12} /> 新建
                </button>
              </div>
              <div className="device-chips">
                {hosts.length === 0 && <span style={{ fontSize: 12, color: "var(--faint)" }}>暂无已配对主机</span>}
                {hosts.map((h) => (
                  <span key={h.id} className={`device-chip ${h.online ? "online" : ""}`} title={`${h.name} (${h.platform ?? ""})`}>
                    <span className="dot" />
                    {h.name}
                  </span>
                ))}
              </div>
            </div>

            <div className="sidebar-section">
              <input
                className="search-input"
                value={agentQuery}
                onChange={(e) => setAgentQuery(e.target.value)}
                placeholder="搜索会话 / 项目 / 工具…"
              />
              <div className="filter-row">
                {(
                  [
                    ["all", `全部 ${statusCounts.all}`],
                    ["blocked", `需要你 ${statusCounts.blocked}`],
                    ["working", `工作中 ${statusCounts.working}`],
                    ["done", `已完成 ${statusCounts.done}`],
                    ["idle", `空闲 ${statusCounts.idle}`],
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip-btn ${statusFilter === k ? "active" : ""}`}
                    onClick={() => setStatusFilter(k)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="agent-list">
              {filteredAgents.length === 0 && (
                <div style={{ textAlign: "center", color: "var(--faint)", fontSize: 12.5, padding: "24px 8px" }}>
                  没有匹配的 Agent 会话
                </div>
              )}
              {filteredAgents.map((a) => {
                const eff = effectiveAgentStatus(a);
                const devName = deviceById.get(a.deviceId)?.name ?? a.deviceId;
                return (
                  <button
                    key={a.key}
                    type="button"
                    className={`agent-card ${selectedAgentKey === a.key ? "selected" : ""}`}
                    onClick={() => setSelectedAgentKey((cur) => (cur === a.key ? null : a.key))}
                  >
                    <div className="agent-card-top">
                      <span className="agent-title">{a.title || a.name || a.localId}</span>
                      <span className={`status-pill status-${eff}`}>{STATUS_LABEL[eff]}</span>
                    </div>
                    <div className="agent-meta">
                      <span className="tag">{devName}</span>
                      <span className="tag">{a.harness}</span>
                      {a.subagentsWorking ? <span className="tag">子任务 {a.subagentsWorking}</span> : null}
                      <span style={{ marginLeft: "auto" }}>{fmtRel(a.updatedAt)}</span>
                    </div>
                    {(a.statusNote || a.preview) && (
                      <div style={{ fontSize: 12, color: a.statusNote ? "var(--error)" : "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {a.statusNote || a.preview}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Center Chat + Right Inspector */}
          <div className="main-split">
            <section className="chat-pane">
              <div className="pane-header">
                <div className="pane-title">
                  <span>与{assistantName}对话</span>
                  {assistant?.busy ? (
                    <span className="conn-pill ok">
                      <Loader2 size={12} /> {busyLabel || "思考中…"}
                    </span>
                  ) : assistant?.model ? (
                    <span className="tag">{assistant.model}</span>
                  ) : null}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    type="button"
                    className={`icon-btn ${replyMode === "voice" ? "active" : ""}`}
                    onClick={() => {
                      getPlayer().unlock();
                      void api
                        .updateSettings({ replyMode: replyMode === "voice" ? "text" : "voice" })
                        .then(() => {
                          showToast(replyMode === "voice" ? "已切换为纯文字回复" : "已开启双轨语音+文字回复");
                          void refreshAssistant();
                        })
                        .catch((e) => showToast((e as Error).message));
                    }}
                    title="切换爱弥斯回复是否自动朗读"
                  >
                    {replyMode === "voice" ? <Volume2 size={14} /> : <VolumeX size={14} />}
                    {replyMode === "voice" ? "语音+文字" : "纯文字"}
                  </button>
                  <button
                    type="button"
                    className={`icon-btn ${confirmMode === "always" ? "active" : ""}`}
                    onClick={() => {
                      void api
                        .updateSettings({ confirm: confirmMode === "always" ? "never" : "always" })
                        .then(() => {
                          showToast(confirmMode === "always" ? "已改为自动执行操作" : "已改为执行前先让你确认");
                          void refreshAssistant();
                        })
                        .catch((e) => showToast((e as Error).message));
                    }}
                    title="控制爱弥斯操作电脑 Agent 前是否先弹出确认卡片"
                  >
                    {confirmMode === "always" ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
                    {confirmMode === "always" ? "先确认" : "直接执行"}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => {
                      if (!window.confirm("确定开启新对话并清空当前聊天窗口吗？（长期记忆会保留）")) return;
                      void api.clearThread().then(() => {
                        showToast("已开启新对话");
                        void refreshAssistant();
                      });
                    }}
                    title="清空当前对话线程"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* Active reminders strip */}
              {assistant && assistant.reminders.length > 0 && (
                <div style={{ padding: "8px 16px", borderBottom: "1px solid var(--divider)", display: "flex", flexWrap: "wrap", gap: 6, background: "var(--surface-2)" }}>
                  {assistant.reminders.map((r) => (
                    <span key={r.id} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px" }}>
                      <span>提醒：{r.text}</span>
                      <button
                        type="button"
                        style={{ border: "none", background: "transparent", padding: 0, display: "inline-flex" }}
                        onClick={() => void api.cancelReminder(r.id).then(() => refreshAssistant())}
                        title="取消此提醒"
                      >
                        <X size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {/* Messages */}
              <div className="messages-scroll">
                {(!assistant || assistant.items.length === 0) && (
                  <div style={{ margin: "auto", textAlign: "center", maxWidth: 420, color: "var(--muted)" }}>
                    <img
                      src="./aimisi-avatar.jpg"
                      alt={assistantName}
                      style={{ width: 72, height: 72, borderRadius: 24, objectFit: "cover", border: "2px solid var(--primary)", marginBottom: 10 }}
                    />
                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--ink)", marginBottom: 6 }}>
                      你好，{profile?.userCall || "欢迎回来"}
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                      直接在这里发文字、按麦克风说一段语音，或者点右上角「语音通话」和我实时连麦；也可以在左侧点开任意一台电脑的 Agent 查看完整输出。
                    </div>
                  </div>
                )}

                {assistant?.items.map((item, idx) => {
                  const prevTs = idx > 0 ? assistant.items[idx - 1]!.ts : 0;
                  const showDivider = !prevTs || item.ts - prevTs > 15 * 60_000;

                  if (item.role === "notice") {
                    const n = item.notice;
                    return (
                      <React.Fragment key={item.id}>
                        {showDivider && <div className="time-divider">{fmtClock(item.ts)}</div>}
                        <div className="msg-row notice">
                          <div className={`notice-card ${n?.kind === "blocked" ? "blocked" : ""}`}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 4 }}>
                                {n?.title || "进度通知"}
                              </div>
                              <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{n?.body || item.text}</div>
                              {n?.details && (
                                <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--muted)" }}>
                                  <Markdown text={n.details} />
                                </div>
                              )}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                              {n?.agent && (
                                <button
                                  type="button"
                                  className="icon-btn primary"
                                  onClick={() => setSelectedAgentKey(n.agent!)}
                                >
                                  查看会话
                                </button>
                              )}
                              <button type="button" className="mini-btn" onClick={() => void handleSpeakItem(item)}>
                                {speakingItemId === item.id ? <Square size={11} /> : <Volume2 size={11} />}
                                {speakingItemId === item.id ? "停止" : "朗读"}
                              </button>
                            </div>
                          </div>
                        </div>
                      </React.Fragment>
                    );
                  }

                  const isUser = item.role === "user";
                  return (
                    <React.Fragment key={item.id}>
                      {showDivider && <div className="time-divider">{fmtClock(item.ts)}</div>}
                      <div className={`msg-row ${isUser ? "user" : "assistant"}`}>
                        {!isUser && <img src="./aimisi-avatar.jpg" alt={assistantName} className="msg-avatar" />}
                        <div className="bubble">
                          {item.steps && item.steps.length > 0 && (
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 6 }}>
                              {item.steps.map((s, i) => (
                                <span key={i} className="tag">
                                  {s}
                                </span>
                              ))}
                            </div>
                          )}

                          {isUser ? (
                            <div style={{ whiteSpace: "pre-wrap" }}>{item.text}</div>
                          ) : (
                            <Markdown text={item.text} />
                          )}

                          {item.action && (
                            <div className="action-card">
                              <div style={{ fontSize: 13, fontWeight: 700 }}>{item.action.summary}</div>
                              {item.action.result && (
                                <div style={{ fontSize: 12.5, color: "var(--muted)" }}>{item.action.result}</div>
                              )}
                              {item.action.state === "pending" ? (
                                <div className="action-buttons">
                                  <button
                                    type="button"
                                    className="icon-btn primary"
                                    onClick={() => void api.decideAction(item.action!.id, "confirm").catch((e) => showToast((e as Error).message))}
                                  >
                                    <Check size={14} /> 确认执行
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn"
                                    onClick={() => void api.decideAction(item.action!.id, "cancel").catch((e) => showToast((e as Error).message))}
                                  >
                                    取消
                                  </button>
                                </div>
                              ) : (
                                <span className="tag" style={{ alignSelf: "flex-start" }}>
                                  状态：{item.action.state}
                                </span>
                              )}
                            </div>
                          )}

                          <div className="bubble-tools" style={{ justifyContent: isUser ? "flex-end" : "flex-start" }}>
                            <span>{fmtClock(item.ts)}</span>
                            {item.via === "voice" && <span>· 语音</span>}
                            {!isUser && (
                              <button type="button" className="mini-btn" onClick={() => void handleSpeakItem(item)}>
                                {speakingItemId === item.id ? <Square size={11} /> : <Volume2 size={11} />}
                                {speakingItemId === item.id ? "停止" : "朗读"}
                              </button>
                            )}
                            <button type="button" className="mini-btn" onClick={() => setQuote(item)}>
                              <CornerUpLeft size={11} /> 引用
                            </button>
                            <button
                              type="button"
                              className="mini-btn"
                              onClick={() => void navigator.clipboard.writeText(item.text).then(() => showToast("已复制"))}
                            >
                              <Copy size={11} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
                <div ref={chatEndRef} />
              </div>

              {/* Composer */}
              <div className="composer-wrap">
                {quote && (
                  <div className="quote-bar">
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      引用：{quote.text.slice(0, 120)}
                    </span>
                    <button type="button" className="mini-btn" onClick={() => setQuote(null)}>
                      <X size={12} />
                    </button>
                  </div>
                )}

                {recording ? (
                  <div className="composer-box" style={{ justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderColor: "var(--primary-strong)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span className="conn-pill err">
                        <span className="dot" /> 正在录音…
                      </span>
                      <div className="level-meter">
                        {[0.4, 0.75, 1, 0.8, 0.5].map((w, i) => (
                          <div key={i} className="level-bar" style={{ height: `${Math.max(4, Math.min(16, Math.round(recordLevel * 16 * w + 4)))}px` }} />
                        ))}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="icon-btn" onClick={handleCancelVoiceNote}>
                        取消
                      </button>
                      <button type="button" className="icon-btn primary" onClick={() => void handleToggleVoiceNote()}>
                        <Send size={14} /> 发送语音
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="composer-box">
                    <button
                      type="button"
                      className="icon-btn"
                      disabled={transcribing}
                      onClick={() => void handleToggleVoiceNote()}
                      title="点击开始录音，再点一次发送给爱弥斯"
                    >
                      {transcribing ? <Loader2 size={15} /> : <Mic size={15} />}
                    </button>
                    <textarea
                      className="composer-textarea"
                      rows={1}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          void handleSendChat();
                        }
                      }}
                      placeholder={`和${assistantName}说点什么…（Enter 发送，Shift+Enter 换行）`}
                    />
                    <button
                      type="button"
                      className="icon-btn primary"
                      disabled={sending || !draft.trim()}
                      onClick={() => void handleSendChat()}
                    >
                      {sending ? <Loader2 size={15} /> : <Send size={15} />}
                    </button>
                  </div>
                )}
              </div>
            </section>

            {/* Right Split Pane: Agent Inspector */}
            {selectedAgent && (
              <AgentInspector
                agent={selectedAgent}
                device={deviceById.get(selectedAgent.deviceId)}
                socket={socketRef.current}
                onClose={() => setSelectedAgentKey(null)}
                onToast={showToast}
              />
            )}
          </div>
        </div>
      )}

      {tab === "ledger" && (
        <LedgerView
          ledger={ledger}
          onRefresh={refreshLedger}
          onUpdateConfig={async (patch) => {
            const next = await api.updateLedgerConfig(patch);
            setLedger(next);
          }}
          onAddFixed={async (input) => {
            const next = await api.addLedgerFixed(input);
            setLedger(next);
          }}
          onToggleFixed={async (id, paid) => {
            const next = await api.updateLedgerFixed(id, { paid });
            setLedger(next);
          }}
          onDeleteFixed={async (id) => {
            const next = await api.deleteLedgerFixed(id);
            setLedger(next);
          }}
          onAddTx={async (input) => {
            const res = await api.addLedgerTx(input);
            setLedger(res.state);
          }}
          onDeleteTx={async (id) => {
            const next = await api.deleteLedgerTx(id);
            setLedger(next);
          }}
          onToast={showToast}
        />
      )}

      {tab === "memory" && (
        <MemoryProfileView
          profile={profile}
          presets={presets}
          memories={memories}
          onRefreshMemories={async (q) => {
            const res = await api.getMemories(q);
            setMemories(res.items);
          }}
          onAddMemory={async (input) => {
            await api.addMemory(input);
            const res = await api.getMemories();
            setMemories(res.items);
          }}
          onDeleteMemory={async (id) => {
            await api.deleteMemory(id);
            const res = await api.getMemories();
            setMemories(res.items);
          }}
          onExportMemories={async () => (await api.exportMemories()).markdown}
          onSaveProfile={async (patch) => {
            const res = await api.updateProfile(patch);
            setProfile(res.profile);
            setPresets(res.presets);
          }}
          onToast={showToast}
        />
      )}

      {/* Floating Live Call Overlay */}
      {callSnap && (
        <CallOverlay
          name={assistantName}
          snapshot={callSnap}
          onToggleMute={() => liveCallRef.current?.setMuted(!callSnap.muted)}
          onHangup={() => liveCallRef.current?.hangup()}
        />
      )}

      {/* New Session Modal */}
      {showNewSession && (
        <NewSessionModal
          hosts={hosts}
          socket={socketRef.current}
          onClose={() => setShowNewSession(false)}
          onCreated={(agentKey) => setSelectedAgentKey(agentKey)}
          onToast={showToast}
        />
      )}

      {/* Pair Code Modal */}
      {pairModal && (
        <div className="modal-backdrop" onClick={() => setPairModal(null)}>
          <div className="modal-panel" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>新设备配对码</h3>
              <button type="button" className="icon-btn" onClick={() => setPairModal(null)}>
                <X size={14} />
              </button>
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2, textAlign: "center", padding: "14px 0", color: "var(--accent-text)" }}>
              {pairModal.code}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted)", wordBreak: "break-all", padding: "8px 10px", borderRadius: 10, background: "var(--surface-2)", marginBottom: 12 }}>
              {pairModal.link}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                className="icon-btn primary"
                onClick={() => void navigator.clipboard.writeText(pairModal.link).then(() => showToast("已复制配对链接"))}
              >
                <Copy size={14} /> 复制配对链接
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
