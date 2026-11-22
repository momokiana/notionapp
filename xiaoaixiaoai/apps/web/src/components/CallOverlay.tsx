import React, { useEffect, useRef, useState } from "react";
import { AlertTriangle, Mic, MicOff, PhoneOff, Sparkles, Volume2 } from "lucide-react";
import type { LiveCallPhase, LiveCallSnapshot } from "../lib/audio";

interface Props {
  name: string;
  snapshot: LiveCallSnapshot;
  onToggleMute: () => void;
  onSwitchMic: (deviceId: string) => void;
  onResumeAudio: () => void;
  onHangup: () => void;
}

const PHASE_LABEL: Record<LiveCallPhase, string> = {
  connecting: "正在预热本地语音模型，请稍候…",
  speaking: "爱弥斯正在说话…",
  thinking: "正在查看电脑与思考…",
  muted: "麦克风已静音",
  listening: "正在听你说…",
  idle: "随时可以开口说话",
};

function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CallOverlay({ name, snapshot, onToggleMute, onSwitchMic, onResumeAudio, onHangup }: Props) {
  const [elapsed, setElapsed] = useState(0);
  const capRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!snapshot.startedAt || snapshot.status !== "ready") {
      setElapsed(0);
      return;
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - snapshot.startedAt!) / 1000)));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [snapshot.startedAt, snapshot.status]);

  useEffect(() => {
    if (capRef.current) {
      capRef.current.scrollTop = capRef.current.scrollHeight;
    }
  }, [snapshot.lines]);

  const bars = [0.35, 0.7, 1, 0.75, 0.4];
  const dynamicScale =
    snapshot.phase === "listening"
      ? 1 + snapshot.level * 0.06
      : snapshot.phase === "speaking"
        ? 1.03
        : 1;

  const suspended = snapshot.audioState === "suspended";
  const showSilentWarn =
    snapshot.status === "ready" &&
    !snapshot.muted &&
    !suspended &&
    !snapshot.heardAnyAudio &&
    elapsed >= 4;

  return (
    <div className="call-modal" role="dialog" aria-label="实时语音通话">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="conn-pill ok">
            <span className="dot" /> 实时通话
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: "var(--muted)" }}>
            {snapshot.status === "ready" ? fmtDuration(elapsed) : "连接中"}
          </span>
        </div>
        <div className="level-meter" title={`实时收音音量：${Math.round(snapshot.level * 100)}%`}>
          {bars.map((weight, i) => (
            <div
              key={i}
              className="level-bar"
              style={{ height: `${Math.max(3, Math.min(16, Math.round(snapshot.level * 16 * weight + 3)))}px` }}
            />
          ))}
        </div>
      </div>

      {/* Active Microphone Picker */}
      {snapshot.status !== "ended" && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, background: "color-mix(in srgb, var(--surface) 75%, transparent)", padding: "5px 9px", borderRadius: 12, border: "1px solid var(--divider)" }}>
          <Mic size={13} style={{ color: snapshot.heardAnyAudio ? "var(--ok)" : "var(--muted)", flexShrink: 0 }} />
          {snapshot.mics.length > 0 ? (
            <select
              aria-label="选择麦克风"
              value={snapshot.activeMicId}
              onChange={(e) => onSwitchMic(e.target.value)}
              style={{
                flex: 1,
                minWidth: 0,
                border: "none",
                background: "transparent",
                outline: "none",
                fontSize: 12,
                color: "var(--ink)",
                textOverflow: "ellipsis",
              }}
            >
              {snapshot.mics.map((m) => (
                <option key={m.deviceId} value={m.deviceId} style={{ background: "var(--surface)", color: "var(--ink)" }}>
                  {m.label}{m.isVirtual ? " (虚拟设备)" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--muted)" }}>
              {snapshot.activeMicLabel || "正在获取麦克风…"}
            </span>
          )}
        </div>
      )}

      {suspended && (
        <button
          type="button"
          className="icon-btn primary"
          style={{ width: "100%", fontSize: 12.5, padding: "7px 10px" }}
          onClick={onResumeAudio}
        >
          <Volume2 size={14} /> 浏览器暂停了音频采集，点此激活麦克风
        </button>
      )}

      {showSilentWarn && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "6px 10px", borderRadius: 10, background: "var(--error-bg)", color: "var(--error)" }}>
          <AlertTriangle size={14} style={{ flexShrink: 0 }} />
          <span>暂未收到麦音量，可在上方切换实体麦克风（如 SIMGOT）</span>
        </div>
      )}

      <div className="call-orb-wrap">
        <div className={`call-orb phase-${snapshot.phase}`} style={{ transform: `scale(${dynamicScale})` }}>
          <span className="call-ring ring-a" />
          <span className="call-ring ring-b" />
          <img src="./aimisi-avatar.png" alt={name} className="call-mascot" />
        </div>
        <div style={{ fontSize: 16, fontWeight: 800, marginTop: 4 }}>{name}</div>
        <div style={{ fontSize: 12.5, color: "var(--muted)", display: "flex", alignItems: "center", gap: 6 }}>
          {snapshot.task && <Sparkles size={13} style={{ color: "var(--primary-strong)" }} />}
          <span>{snapshot.task ? snapshot.task.title : snapshot.message || PHASE_LABEL[snapshot.phase]}</span>
        </div>
      </div>

      {snapshot.lines.length > 0 && (
        <div ref={capRef} className="call-captions">
          {snapshot.lines.map((line) => (
            <div
              key={line.id}
              style={{
                fontSize: 12.5,
                lineHeight: 1.45,
                alignSelf: line.role === "user" ? "flex-end" : "flex-start",
                background: line.role === "user" ? "var(--bubble-user)" : "var(--bubble-assistant)",
                padding: "5px 9px",
                borderRadius: 10,
                maxWidth: "92%",
                opacity: line.final ? 1 : 0.85,
              }}
            >
              {line.text}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "center", gap: 12, marginTop: 4 }}>
        <button
          type="button"
          className={`icon-btn ${snapshot.muted ? "active" : ""}`}
          style={{ padding: "10px 18px", borderRadius: 999 }}
          onClick={onToggleMute}
        >
          {snapshot.muted ? <MicOff size={16} /> : <Mic size={16} />}
          {snapshot.muted ? "取消静音" : "静音"}
        </button>
        <button
          type="button"
          className="icon-btn danger"
          style={{ padding: "10px 20px", borderRadius: 999, background: "#d93757", color: "#fff" }}
          onClick={onHangup}
        >
          <PhoneOff size={16} /> 挂断
        </button>
      </div>
    </div>
  );
}
