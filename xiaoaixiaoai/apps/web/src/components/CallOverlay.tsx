import React, { useEffect, useRef, useState } from "react";
import { Mic, MicOff, PhoneOff, Sparkles } from "lucide-react";
import type { LiveCallPhase, LiveCallSnapshot } from "../lib/audio";

interface Props {
  name: string;
  snapshot: LiveCallSnapshot;
  onToggleMute: () => void;
  onHangup: () => void;
}

const PHASE_LABEL: Record<LiveCallPhase, string> = {
  connecting: "正在接通语音…",
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

export function CallOverlay({ name, snapshot, onToggleMute, onHangup }: Props) {
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
        <div className="level-meter" title="麦克风音量">
          {bars.map((weight, i) => (
            <div
              key={i}
              className="level-bar"
              style={{ height: `${Math.max(3, Math.min(16, Math.round(snapshot.level * 16 * weight + 3)))}px` }}
            />
          ))}
        </div>
      </div>

      <div className="call-orb-wrap">
        <div className={`call-orb phase-${snapshot.phase}`} style={{ transform: `scale(${dynamicScale})` }}>
          <span className="call-ring ring-a" />
          <span className="call-ring ring-b" />
          <img
            src="./aimisi-avatar.png"
            alt={name}
            className="call-mascot"
          />
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
