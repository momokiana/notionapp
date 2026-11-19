import React from "react";
import { AbsoluteFill, AnimatedImage, Img, useCurrentFrame } from "remotion";
import { Avatar, C, Caption, Chip, FONT_BODY, FONT_DISPLAY, FONT_MONO, Phone, Sky, Sparkle, asset, clamp01, ramp, typed, useIn } from "./kit";
import { AgentList, Assistant, Call, CALL_TIMELINE, Chat, Term, callStateAt } from "./screens";
// Repository slug and example server come from the site's single config constant.
import { SITE } from "../../src/config";

const ease = (k: number) => 1 - Math.pow(1 - clamp01(k), 3);

// ------------------------------------------------------------------ shared: terminal window
const TermWindow: React.FC<{ title: string; v: string; lines: string[]; start: number; x: number; y: number; rot: number; dim?: number; waitAt?: number }> = ({
  title,
  v,
  lines,
  start,
  x,
  y,
  rot,
  dim = 0,
  waitAt,
}) => {
  const f = useCurrentFrame();
  const k = useIn(start, 15);
  const shown = Math.max(0, Math.floor((f - start - 10) / 9));
  const w0 = useIn(waitAt ?? 0, 11);
  const w = waitAt !== undefined ? w0 : 0;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: 560,
        borderRadius: 26,
        background: C.term,
        color: "#F3E9F2",
        boxShadow: "0 50px 90px -40px rgba(120,40,90,.55), 0 0 0 1px rgba(255,255,255,.06) inset",
        transform: `perspective(1600px) rotateY(${rot}deg) translateY(${(1 - k) * 120}px) scale(${0.9 + 0.1 * k})`,
        opacity: k,
        filter: `saturate(${1 - dim * 0.6}) brightness(${1 - dim * 0.25})`,
        overflow: "visible",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "16px 20px", borderBottom: "1px solid rgba(255,255,255,.07)" }}>
        {["#FF8299", "#F6D47A", "#7FDBB6"].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c }} />
        ))}
        <Avatar v={v} size={30} style={{ marginLeft: 10 }} />
        <span style={{ fontFamily: FONT_BODY, fontWeight: 800, fontSize: 20, color: "rgba(255,255,255,.7)" }}>{title}</span>
      </div>
      <div style={{ padding: "16px 22px 22px", fontFamily: FONT_MONO, fontSize: 21, lineHeight: 1.65, minHeight: 250 }}>
        {lines.slice(0, shown).map((l, i) => (
          <div key={i} style={{ color: l.startsWith("✓") ? "#7FDBB6" : l.startsWith("$") ? "#FF8FB8" : l.startsWith("*") ? "#F6D47A" : "#F3E9F2", whiteSpace: "nowrap", overflow: "hidden" }}>
            {l}
          </div>
        ))}
        {shown < lines.length ? <span style={{ display: "inline-block", width: 11, height: 22, background: "#FF8FB8", opacity: Math.floor(f / 8) % 2 }} /> : null}
      </div>
      {waitAt !== undefined && f >= waitAt ? (
        <div
          style={{
            position: "absolute",
            right: -30,
            top: -34,
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "12px 22px 12px 14px",
            borderRadius: 22,
            background: "#fff",
            color: C.deep,
            fontFamily: FONT_BODY,
            fontWeight: 900,
            fontSize: 26,
            boxShadow: "0 20px 40px -18px rgba(217,87,140,.7)",
            transform: `scale(${w}) rotate(${(1 - w) * -10}deg)`,
          }}
        >
          <span style={{ width: 14, height: 14, borderRadius: "50%", background: C.accent, boxShadow: `0 0 0 ${6 + Math.sin(f / 4) * 3}px rgba(242,123,166,.25)` }} />
          等你确认
        </div>
      ) : null}
    </div>
  );
};

const WINDOWS = [
  { title: "MacBook Pro · web-shop", v: "claude-code", lines: ["$ claude", "> 修复结账金额计算", "✓ 读取 src/cart/total.ts", "✓ 24 passed (1.8s)", "* 思考中… (3m 12s)"], x: 140, y: 250, rot: 14 },
  { title: "Linux 工作站 · api-gateway", v: "gemini", lines: ["$ gemini", "> 补全网关的集成测试", "✓ 新增 18 个用例", "$ pnpm test", "✓ 41 passed (6.2s)"], x: 690, y: 150, rot: 0 },
  { title: "云主机 · docs-site", v: "codex", lines: ["$ codex", "> 生成 API 文档", "✓ 写入 docs/api.md", "* 要覆盖 README 吗？", "  1. 是   2. 否"], x: 1240, y: 270, rot: -14 },
];

// ------------------------------------------------------------------ 1. open
export const SceneOpen: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      <Sky seed={1} />
      <AbsoluteFill style={{ transform: `scale(${1 + f * 0.0004})` }}>
        {WINDOWS.map((w, i) => (
          <TermWindow key={i} {...w} start={6 + i * 8} />
        ))}
      </AbsoluteFill>
      <Caption zh="你的 coding agent，在好几台电脑上跑着。" en="Your coding agents are running on several computers." delay={40} size={70} align="center" style={{ position: "absolute", left: 0, right: 0, bottom: 110 }} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 2. problem
export const SceneProblem: React.FC = () => {
  const f = useCurrentFrame();
  const dim = ramp(f, 20, 80);
  return (
    <AbsoluteFill>
      <Sky seed={2} />
      <AbsoluteFill style={{ transform: `scale(${1.03 - f * 0.0002})` }}>
        {WINDOWS.map((w, i) => (
          <TermWindow key={i} {...w} start={-60} dim={dim} waitAt={18 + i * 16} />
        ))}
      </AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          top: 56,
          textAlign: "center",
          fontFamily: FONT_MONO,
          fontWeight: 700,
          fontSize: 44,
          color: C.ink2,
          opacity: ramp(f, 30, 50),
        }}
      >
        23:{String(40 + Math.floor(f / 30)).padStart(2, "0")}
      </div>
      <Caption zh={"可你不在电脑前。\n它们在等，你却不知道。"} en="But you're away from your desk. They wait, and you never hear about it." delay={70} size={66} align="center" style={{ position: "absolute", left: 0, right: 0, bottom: 70 }} />
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 3. reveal
const ORBIT = ["claude-code", "codex", "gemini", "opencode", "kimi", "qwen", "cursor", "pi"];
export const SceneReveal: React.FC = () => {
  const f = useCurrentFrame();
  const m = useIn(8, 12);
  const logo = useIn(40, 14);
  const burst = ramp(f, 4, 50);
  const orbitIn = ramp(f, 20, 60);
  return (
    <AbsoluteFill>
      <Sky seed={3} />
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 640,
            top: 540,
            width: 10,
            height: 10,
            borderRadius: "50%",
            border: `4px solid rgba(242,123,166,${0.6 * (1 - ramp(f, 4 + i * 8, 60 + i * 8))})`,
            transform: `translate(-50%,-50%) scale(${1 + ease(ramp(f, 4 + i * 8, 60 + i * 8)) * 110})`,
          }}
        />
      ))}
      {/* orbit behind */}
      {ORBIT.map((v, i) => {
        const a = f * 0.012 + (i / ORBIT.length) * Math.PI * 2;
        const depth = Math.sin(a);
        const x = 640 + Math.cos(a) * 340 * orbitIn;
        const y = 640 + depth * 110 * orbitIn - Math.cos(a) * 60;
        const s = 0.6 + 0.4 * ((depth + 1) / 2);
        return (
          <Avatar
            key={v}
            v={v}
            size={96}
            style={{
              position: "absolute",
              left: x - 48,
              top: y - 48,
              transform: `scale(${s * orbitIn})`,
              zIndex: depth > 0 ? 5 : 1,
              filter: depth < -0.2 ? `blur(${(-depth - 0.2) * 3}px)` : "none",
              boxShadow: "0 0 0 5px #fff, 0 16px 30px -14px rgba(120,60,110,.6)",
            }}
          />
        );
      })}
      <div style={{ position: "absolute", left: 640 - 330, top: 120, width: 660, height: 660, zIndex: 3, transform: `translateY(${(1 - m) * 300}px) scale(${0.7 + 0.3 * m})`, opacity: clamp01(m * 1.5) }}>
        <div style={{ position: "absolute", inset: "12%", borderRadius: "50%", background: "radial-gradient(circle, #fff 0%, rgba(255,230,240,.7) 40%, transparent 70%)" }} />
        <AnimatedImage src={asset("mascot/idle.webp")} width={660} height={660} style={{ position: "relative", filter: "drop-shadow(0 30px 40px rgba(217,87,140,.3))" }} />
      </div>
      {/* wool cloud */}
      <div style={{ position: "absolute", left: 640 - 230, top: 800, width: 460, height: 120, zIndex: 4, opacity: m, transform: `translateY(${Math.sin(f / 18) * 6}px)` }}>
        {[
          [0, 50, 150, 70],
          [80, 10, 170, 110],
          [200, 0, 150, 120],
          [300, 26, 140, 94],
          [370, 56, 100, 64],
        ].map(([l, t, w, h], i) => (
          <span
            key={i}
            style={{
              position: "absolute",
              left: l,
              top: t,
              width: w,
              height: h,
              borderRadius: "50%",
              background: "radial-gradient(circle at 38% 30%, #fff 0%, #fff4f8 45%, #f7d9e7 100%)",
              boxShadow: "inset -8px -10px 18px rgba(217,87,140,.12)",
            }}
          />
        ))}
      </div>
      <div style={{ position: "absolute", left: 1080, top: 300, width: 760, opacity: logo, transform: `translateX(${(1 - logo) * 80}px)` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <Img src={asset("brand/logo-512.png")} style={{ width: 120, height: 120, borderRadius: 30, boxShadow: "0 20px 40px -18px rgba(217,87,140,.6)" }} />
          <span style={{ fontFamily: FONT_BODY, fontWeight: 900, fontSize: 92, color: C.ink, letterSpacing: "-0.02em" }}>Herdr Pocket</span>
        </div>
      </div>
      <Caption
        zh={"所有电脑上的 coding agent，\n都装进你的口袋。"}
        en="Every coding agent on every computer, in your pocket."
        delay={58}
        size={58}
        style={{ position: "absolute", left: 1084, top: 470, width: 800 }}
      />
      {Array.from({ length: 10 }, (_, i) => {
        const a = (i / 10) * Math.PI * 2;
        const r = 120 + ease(burst) * 300;
        return <Sparkle key={i} x={640 + Math.cos(a) * r - 14} y={420 + Math.sin(a) * r - 14} size={14} opacity={1 - burst} color="#F27BA6" />;
      })}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 4. flow
const bez = (p0: number[], p1: number[], p2: number[], p3: number[], t: number) => {
  const u = 1 - t;
  return [0, 1].map((i) => u * u * u * p0[i] + 3 * u * u * t * p1[i] + 3 * u * t * t * p2[i] + t * t * t * p3[i]);
};
type Curve = [number[], number[], number[], number[]];
const curveD = (c: Curve) => `M${c[0]} C${c[1]} ${c[2]} ${c[3]}`;

export const SceneFlow: React.FC = () => {
  const f = useCurrentFrame();
  const relay = [960, 560];
  const comps = [
    { y: 350, name: "MacBook Pro", vs: ["claude-code", "codex"] },
    { y: 560, name: "Linux 工作站", vs: ["gemini", "opencode", "kimi"] },
    { y: 770, name: "云主机", vs: ["qwen", "pi"] },
  ];
  const cIn = comps.map((_, i) => ease(ramp(f, 10 + i * 6, 40 + i * 6)));
  const drawA = ease(ramp(f, 70, 120));
  const relayIn = ease(ramp(f, 60, 90));
  const drawB = ease(ramp(f, 150, 190));
  const phoneIn = ease(ramp(f, 140, 175));
  const reverseOn = f >= 280;
  const curvesA: Curve[] = comps.map((c) => [
    [580, c.y],
    [730, c.y],
    [800, relay[1]],
    [relay[0] - 70, relay[1]],
  ]);
  const curveB: Curve = [
    [relay[0] + 70, relay[1]],
    [1150, relay[1]],
    [1250, relay[1]],
    [1380, relay[1]],
  ];
  const lenA = 520;
  const lenB = 320;
  const steps = [
    ["herdr-pocket up", "每台电脑一条命令", 30],
    ["自托管中转", "WebSocket · 令牌只存哈希", 90],
    ["手机实时看到", "列表、对话、终端", 170],
    ["指令沿原路送回", "回一句、按个键、新建 agent", 280],
  ] as const;
  const rows = [
    ["claude-code", "web-shop", C.mint],
    ["codex", "docs-site", C.accent],
    ["gemini", "api-gateway", C.mint],
    ["opencode", "mobile-app", C.ink3],
    ["kimi", "data-report", C.lavDeep],
    ["qwen", "infra", C.mint],
  ];
  return (
    <AbsoluteFill>
      <Sky seed={4} />
      <Caption eyebrow="工作原理 · How it works" zh="电脑 → 中转 → 手机" en="Computers → relay → phone, one live line." size={60} style={{ position: "absolute", left: 120, top: 44 }} />
      <svg style={{ position: "absolute", inset: 0 }} width={1920} height={1080}>
        <defs>
          <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="560" y1="0" x2="1400" y2="0">
            <stop offset="0" stopColor="#F27BA6" />
            <stop offset="1" stopColor="#B9A2F5" />
          </linearGradient>
        </defs>
        {curvesA.map((c, i) => (
          <g key={i}>
            <path d={curveD(c)} fill="none" stroke="rgba(242,123,166,.25)" strokeWidth={3} strokeDasharray="3 10" strokeLinecap="round" />
            <path d={curveD(c)} fill="none" stroke="url(#g)" strokeWidth={5} strokeLinecap="round" strokeDasharray={lenA} strokeDashoffset={lenA * (1 - drawA)} />
          </g>
        ))}
        <path d={curveD(curveB)} fill="none" stroke="rgba(242,123,166,.25)" strokeWidth={3} strokeDasharray="3 10" />
        <path d={curveD(curveB)} fill="none" stroke="url(#g)" strokeWidth={5} strokeLinecap="round" strokeDasharray={lenB} strokeDashoffset={lenB * (1 - drawB)} />
        {drawA >= 1
          ? curvesA.flatMap((c, i) =>
              [0, 1, 2].map((k) => {
                const t = ((f - 120) / 50 + k / 3 + i * 0.17) % 1;
                const [x, y] = bez(c[0], c[1], c[2], c[3], t);
                return <circle key={`${i}${k}`} cx={x} cy={y} r={8} fill={["#F27BA6", "#B9A2F5", "#2E8A6A"][i]} opacity={Math.sin(t * Math.PI)} />;
              }),
            )
          : null}
        {drawB >= 1
          ? [0, 1, 2, 3].map((k) => {
              const t = ((f - 190) / 34 + k / 4) % 1;
              const [x, y] = bez(curveB[0], curveB[1], curveB[2], curveB[3], t);
              return <circle key={k} cx={x} cy={y} r={8} fill="#F27BA6" opacity={Math.sin(t * Math.PI)} />;
            })
          : null}
        {reverseOn
          ? [0, 1, 2].map((k) => {
              const t = ((f - 280) / 60 + k / 3) % 1;
              const pt = t < 0.4 ? bez(curveB[3], curveB[2], curveB[1], curveB[0], t / 0.4) : (() => {
                const c = curvesA[k];
                return bez(c[3], c[2], c[1], c[0], (t - 0.4) / 0.6);
              })();
              return <circle key={k} cx={pt[0]} cy={pt[1]} r={10} fill="#7A5CC8" opacity={0.4 + 0.6 * Math.sin(t * Math.PI)} />;
            })
          : null}
      </svg>
      {comps.map((c, i) => (
        <div
          key={i}
          style={{
            position: "absolute",
            left: 160,
            top: c.y - 88,
            width: 420,
            padding: "18px 24px",
            borderRadius: 28,
            background: "#fff",
            boxShadow: "0 20px 50px -26px rgba(160,60,120,.5)",
            border: "1px solid rgba(74,53,80,.08)",
            opacity: cIn[i],
            transform: `translateX(${(1 - cIn[i]) * -60}px)`,
          }}
        >
          <div style={{ fontFamily: FONT_BODY, fontWeight: 900, fontSize: 30, color: C.ink }}>{c.name}</div>
          <div style={{ display: "flex", gap: 10, marginTop: 12, alignItems: "center" }}>
            {c.vs.map((v) => (
              <Avatar key={v} v={v} size={52} />
            ))}
            <span style={{ marginLeft: "auto", fontFamily: FONT_MONO, fontSize: 17, color: C.ink2, background: C.bg2, padding: "4px 10px", borderRadius: 10, whiteSpace: "nowrap" }}>herdr-pocket up</span>
          </div>
        </div>
      ))}
      <div style={{ position: "absolute", left: relay[0] - 85, top: relay[1] - 85, width: 170, height: 170, opacity: 0.3 + 0.7 * relayIn, transform: `scale(${0.8 + 0.2 * relayIn + (f > 120 ? Math.sin(f / 7) * 0.03 : 0)})` }}>
        <div style={{ position: "absolute", inset: 0, borderRadius: 52, border: "3px dashed rgba(242,123,166,.4)", transform: `rotate(${f * 0.8}deg)` }} />
        <div
          style={{
            position: "absolute",
            inset: 25,
            borderRadius: 38,
            background: "linear-gradient(145deg, #F27BA6, #E58AD0 55%, #C9B6F7)",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 24px 50px -18px rgba(217,87,140,.75)",
          }}
        >
          <svg viewBox="0 0 24 24" width={60} height={60} fill="none" stroke="#fff" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3 4.5 6v5.6c0 4.5 3.1 8.3 7.5 9.4 4.4-1.1 7.5-4.9 7.5-9.4V6L12 3Z" />
            <path d="m8.8 12 2.2 2.2 4.3-4.4" />
          </svg>
        </div>
        <div style={{ position: "absolute", top: 184, left: "50%", transform: "translateX(-50%)", textAlign: "center", whiteSpace: "nowrap" }}>
          <div style={{ fontFamily: FONT_BODY, fontWeight: 900, fontSize: 30, color: C.ink }}>中转服务 · Relay</div>
          <div style={{ fontFamily: FONT_MONO, fontSize: 20, color: C.ink2 }}>wss · {SITE.server}</div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 1390, top: 170, opacity: 0.3 + 0.7 * phoneIn, transform: `translateX(${(1 - phoneIn) * 60}px)` }}>
        <div style={{ width: 330, height: 690, transform: "scale(1.0)", transformOrigin: "0 0" }}>
          <div className="phone">
            <div className="phone-screen">
              <div className="scr">
                <div style={{ height: 40 }} />
                <div style={{ padding: "0 14px", fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 22, color: C.ink }}>全部 agent</div>
                <div style={{ padding: "10px 12px", display: "grid", gap: 8 }}>
                  {rows.map(([v, n, col], i) => {
                    const k = ease(ramp(f, 175 + i * 7, 190 + i * 7));
                    const sendHi = reverseOn && i === 0 ? 0.5 + 0.5 * Math.sin(f / 5) : 0;
                    return (
                      <div
                        key={v}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: 10,
                          borderRadius: 16,
                          background: "#fff",
                          boxShadow: `0 0 0 ${sendHi * 3}px rgba(122,92,200,.6), 0 6px 14px -8px rgba(160,60,120,.4)`,
                          opacity: k,
                          transform: `translateY(${(1 - k) * 16}px)`,
                          fontFamily: FONT_BODY,
                          fontWeight: 800,
                          fontSize: 16,
                          color: C.ink,
                        }}
                      >
                        <Avatar v={v} size={36} />
                        <span style={{ flex: 1 }}>{n}</span>
                        <span style={{ width: 12, height: 12, borderRadius: "50%", background: col }} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 120, right: 120, bottom: 54, display: "flex", gap: 18 }}>
        {steps.map(([a, b, at], i) => {
          const k = ease(ramp(f, at, at + 18));
          const active = f >= at && (i === steps.length - 1 || f < steps[i + 1][2]);
          return (
            <div
              key={i}
              style={{
                flex: 1,
                padding: "16px 20px",
                borderRadius: 22,
                background: active ? "#fff" : "rgba(255,255,255,.5)",
                boxShadow: active ? "0 0 0 3px #F27BA6, 0 18px 36px -20px rgba(217,87,140,.7)" : "none",
                opacity: 0.25 + 0.75 * k,
                fontFamily: FONT_BODY,
              }}
            >
              <div style={{ fontFamily: FONT_MONO, fontSize: 18, color: C.deep, fontWeight: 700 }}>0{i + 1}</div>
              <div style={{ fontWeight: 900, fontSize: 27, color: C.ink, fontFamily: FONT_DISPLAY }}>{a}</div>
              <div style={{ fontWeight: 700, fontSize: 20, color: C.ink2 }}>{b}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 5. agent list
export const SceneList: React.FC = () => {
  const p = useIn(0, 16);
  const legend: [string, string, string][] = [
    ["需要你", C.pinkSoft, C.deep],
    ["工作中", C.mintSoft, C.mint],
    ["已完成", C.lavSoft, C.lavDeep],
    ["空闲", "rgba(74,53,80,.08)", C.ink2],
  ];
  return (
    <AbsoluteFill>
      <Sky seed={5} />
      <Caption eyebrow="Agent 列表" zh={"所有电脑，\n按“要不要你管”排好。"} en={"Every computer, one list,\nsorted by what needs you."} size={72} style={{ position: "absolute", left: 160, top: 250, width: 860 }} />
      <div style={{ position: "absolute", left: 160, top: 690, display: "flex", gap: 14 }}>
        {legend.map(([t, bg, c], i) => (
          <Legend key={t} t={t} bg={bg} c={c} at={30 + i * 6} />
        ))}
      </div>
      <div style={{ position: "absolute", left: 1150, top: 70, transform: `translateY(${(1 - p) * 200}px) rotate(${(1 - p) * 6}deg)`, opacity: p }}>
        <Phone scale={1.35}>
          <AgentList
            events={[
              [70, 2, "done"],
              [120, 1, "work"],
              [170, 0, "wait"],
              [215, 4, "work"],
            ]}
          />
        </Phone>
      </div>
    </AbsoluteFill>
  );
};
const Legend: React.FC<{ t: string; bg: string; c: string; at: number }> = ({ t, bg, c, at }) => {
  const k = useIn(at, 13);
  return (
    <Chip bg={bg} color={c} style={{ transform: `scale(${k})` }}>
      <span style={{ width: 12, height: 12, borderRadius: "50%", background: c }} />
      {t}
    </Chip>
  );
};

// ------------------------------------------------------------------ 6. chat + terminal
export const SceneChatTerm: React.FC = () => {
  const a = useIn(0, 16);
  const b = useIn(10, 16);
  return (
    <AbsoluteFill>
      <Sky seed={6} />
      <Caption zh="排版好的对话，真正的终端。" en="Readable conversations. A real terminal you can type into." size={64} align="center" style={{ position: "absolute", left: 0, right: 0, top: 56 }} />
      <div style={{ position: "absolute", left: 470, top: 250, transform: `translateY(${(1 - a) * 240}px) rotate(-3deg)`, opacity: a }}>
        <Phone scale={1.12}>
          <Chat />
        </Phone>
      </div>
      <div style={{ position: "absolute", left: 1060, top: 230, transform: `translateY(${(1 - b) * 240}px) rotate(3deg)`, opacity: b }}>
        <Phone scale={1.12}>
          <Term />
        </Phone>
      </div>
      <Tag text="工具调用收成卡片" x={150} y={460} at={40} />
      <Tag text="失败的一眼就看到" x={170} y={560} at={60} />
      <Tag text="按键栏：Esc · Tab · 方向键 · 回车" x={1480} y={760} at={250} />
    </AbsoluteFill>
  );
};
const Tag: React.FC<{ text: string; x: number; y: number; at: number }> = ({ text, x, y, at }) => {
  const k = useIn(at, 13);
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        padding: "14px 24px",
        borderRadius: 20,
        background: "#fff",
        boxShadow: "0 18px 40px -20px rgba(160,60,120,.6)",
        fontFamily: FONT_BODY,
        fontWeight: 900,
        fontSize: 26,
        color: C.ink,
        transform: `scale(${k})`,
        transformOrigin: "50% 100%",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </div>
  );
};

// ------------------------------------------------------------------ 7. assistant
export const SceneAssistant: React.FC = () => {
  const f = useCurrentFrame();
  const p = useIn(0, 16);
  const n = useIn(186, 13);
  const st = useIn(20, 12);
  const points = [
    ["问一句就知道", "谁在等你、谁跑完了、今天花了多少", 40],
    ["说了就做", "发消息、按键、开新 agent，结果照实说", 110],
    ["主动来找你", "盯着 agent，跑完或卡住就叫你", 196],
  ] as const;
  return (
    <AbsoluteFill>
      <Sky seed={7} />
      <div style={{ position: "absolute", left: 260, top: 80, transform: `translateY(${(1 - p) * 200}px)`, opacity: p }}>
        <Phone scale={1.32}>
          <Assistant />
        </Phone>
      </div>
      <Img
        src={asset("mascot/hello.webp")}
        style={{ position: "absolute", left: 90, top: 700, width: 230, transform: `translateY(${Math.sin(f / 14) * 10}px) scale(${st})`, filter: "drop-shadow(0 16px 24px rgba(217,87,140,.3))" }}
      />
      <div
        style={{
          position: "absolute",
          left: 760,
          top: 70,
          width: 520,
          display: "flex",
          gap: 16,
          padding: "18px 22px",
          borderRadius: 28,
          background: "rgba(255,255,255,.92)",
          boxShadow: "0 30px 60px -28px rgba(160,60,120,.6)",
          transform: `translateY(${(1 - n) * -120}px)`,
          opacity: n,
          fontFamily: FONT_BODY,
        }}
      >
        <Img src={asset("brand/logo-64.webp")} style={{ width: 60, height: 60, borderRadius: 16 }} />
        <div>
          <div style={{ fontSize: 19, color: C.ink2, fontWeight: 700 }}>
            <b style={{ color: C.ink }}>Herdr Pocket</b> · 小羊 · 刚刚
          </div>
          <div style={{ fontSize: 24, color: C.ink, fontWeight: 700, lineHeight: 1.4 }}>web-shop 的 Claude Code 跑完了，24 个测试全过。</div>
        </div>
      </div>
      <Caption eyebrow="小羊助理 · Xiaoyang" zh="说一句，小羊就去办。" en="Say the word: she does it, then tells you how it went." size={74} style={{ position: "absolute", left: 1000, top: 300, width: 820 }} />
      <div style={{ position: "absolute", left: 1000, top: 590, display: "grid", gap: 22 }}>
        {points.map(([a, b, at]) => {
          const k = useIn(at, 14);
          return (
            <div key={a} style={{ display: "flex", gap: 18, alignItems: "center", opacity: k, transform: `translateX(${(1 - k) * 40}px)` }}>
              <span style={{ width: 18, height: 18, borderRadius: 6, background: C.accent, transform: "rotate(45deg)" }} />
              <div style={{ fontFamily: FONT_BODY }}>
                <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 34, color: C.ink }}>{a}</div>
                <div style={{ fontWeight: 700, fontSize: 24, color: C.ink2 }}>{b}</div>
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 8. call
export const SceneCall: React.FC = () => {
  const f = useCurrentFrame();
  const p = useIn(0, 16);
  const s = callStateAt(f);
  const names: Record<string, string> = { connecting: "连接中", idle: "待机", listening: "在听", thinking: "在想", speaking: "在说", muted: "静音" };
  return (
    <AbsoluteFill>
      <Sky dusk seed={8} />
      <Caption eyebrow="语音通话 · Voice" zh={"懒得打字？\n给小羊打个电话。"} en={"Real-time voice calls, MOSS-Live by default,\nmore realtime voice providers on the way."} size={76} light style={{ position: "absolute", left: 150, top: 230, width: 900 }} />
      <div style={{ position: "absolute", left: 150, top: 760, display: "flex", flexWrap: "wrap", gap: 14, width: 860 }}>
        {CALL_TIMELINE.map(([, st]) => {
          const on = st === s;
          return (
            <span
              key={st}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 12,
                padding: "8px 22px 8px 8px",
                borderRadius: 999,
                background: on ? "#fff" : "rgba(255,255,255,.09)",
                border: "1px solid rgba(255,255,255,.16)",
                color: on ? C.ink : "#fff",
                fontFamily: FONT_BODY,
                fontWeight: 900,
                fontSize: 26,
                transform: `scale(${on ? 1.06 : 1})`,
              }}
            >
              <AnimatedImage src={asset(`call/${st}.webp`)} width={50} height={50} style={{ borderRadius: "50%" }} />
              {names[st]}
            </span>
          );
        })}
      </div>
      <div style={{ position: "absolute", left: 1200, top: 70, transform: `translateY(${(1 - p) * 200}px)`, opacity: p }}>
        <Phone scale={1.35}>
          <Call />
        </Phone>
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 9. self-host
const QR: React.FC<{ size: number; seed?: number }> = ({ size, seed = 7 }) => {
  const n = 21;
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return s / 2147483647;
  };
  const cells: boolean[] = [];
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const fd = (ox: number, oy: number) => {
        const dx = x - ox;
        const dy = y - oy;
        if (dx < 0 || dy < 0 || dx > 6 || dy > 6) return null;
        return dx === 0 || dy === 0 || dx === 6 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4);
      };
      const v = fd(0, 0) ?? fd(n - 7, 0) ?? fd(0, n - 7);
      cells.push(v ?? rnd() > 0.52);
    }
  return (
    <div style={{ width: size, height: size, padding: size * 0.06, background: "#fff", borderRadius: 14, display: "grid", gridTemplateColumns: `repeat(${n}, 1fr)` }}>
      {cells.map((on, i) => (
        <i key={i} style={{ background: on ? C.term : "transparent" }} />
      ))}
    </div>
  );
};

export const SceneSelfHost: React.FC = () => {
  const f = useCurrentFrame();
  const t = useIn(0, 16);
  const full = SITE.commands.computerUp;
  const cmd = typed(full, f, 20, 26);
  const qr = useIn(78, 13);
  const chips = [
    ["Docker · Cloudflare · 一键安装", C.pinkSoft, C.deep],
    ["首次启动打印一次性二维码", C.lavSoft, C.lavDeep],
    ["二维码是 https 链接，相机一扫就开", C.mintSoft, C.mint],
    ["日志集中在中转服务 · /admin 面板", "#fff", C.ink],
    ["设备令牌只存哈希 · 只读模式", "#fff", C.ink],
    ["Anthropic · DeepSeek · Qwen · Kimi · GLM · OpenRouter · Ollama", "#fff", C.ink],
  ] as const;
  return (
    <AbsoluteFill>
      <Sky seed={9} />
      <Caption eyebrow="自托管 · Self-hosted" zh="自己的服务器，自己的口袋。" en="Your server, your data, your pocket." size={66} style={{ position: "absolute", left: 140, top: 80 }} />
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 380,
          width: 760,
          borderRadius: 30,
          background: C.term,
          color: "#F3E9F2",
          padding: "26px 30px",
          fontFamily: FONT_MONO,
          fontSize: 26,
          boxShadow: "0 50px 90px -40px rgba(120,40,90,.55)",
          opacity: t,
          transform: `translateY(${(1 - t) * 60}px)`,
        }}
      >
        <div>
          <span style={{ color: "#FF8FB8" }}>$ </span>
          {cmd}
          {cmd.length < full.length ? <span style={{ display: "inline-block", width: 13, height: 26, background: "#FF8FB8", verticalAlign: -4, opacity: Math.floor(f / 8) % 2 }} /> : null}
        </div>
        {f >= 66 ? <div style={{ color: "rgba(255,255,255,.55)", marginTop: 10, fontSize: 22 }}>用已连上的手机扫一下 · scan with a connected phone</div> : null}
        <div style={{ display: "flex", alignItems: "center", gap: 28, marginTop: 20, opacity: qr, transform: `scale(${0.8 + 0.2 * qr})`, transformOrigin: "0 50%" }}>
          <QR size={210} />
          <div style={{ fontFamily: FONT_BODY, fontSize: 26, fontWeight: 800, lineHeight: 1.5 }}>
            <div style={{ color: "#7FDBB6" }}>✓ 已允许加入</div>
            <div style={{ color: "rgba(255,255,255,.6)", fontSize: 22 }}>Mac mini · 在线</div>
          </div>
        </div>
      </div>
      <div style={{ position: "absolute", left: 980, top: 380, width: 820, display: "flex", flexWrap: "wrap", gap: 18 }}>
        {chips.map(([text, bg, c], i) => {
          const k = useIn(40 + i * 14, 13);
          return (
            <Chip key={text} bg={bg} color={c} style={{ fontSize: 30, padding: "18px 28px", borderRadius: 24, boxShadow: "0 16px 34px -20px rgba(160,60,120,.55)", transform: `scale(${k})`, whiteSpace: "normal" }}>
              {text}
            </Chip>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ 10. outro
export const SceneOutro: React.FC = () => {
  const f = useCurrentFrame();
  const m = useIn(4, 11);
  const l = useIn(24, 14);
  const u = useIn(44, 14);
  return (
    <AbsoluteFill>
      <Sky seed={10} />
      <div style={{ position: "absolute", left: 960 - 170, top: 70, width: 340, transform: `translateY(${(1 - m) * 200 + Math.sin(f / 12) * 10}px) scale(${m})` }}>
        <Img src={asset("mascot/yay.webp")} style={{ width: 340, filter: "drop-shadow(0 20px 30px rgba(217,87,140,.35))" }} />
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 520, display: "flex", justifyContent: "center", alignItems: "center", gap: 26, opacity: l, transform: `translateY(${(1 - l) * 40}px)` }}>
        <Img src={asset("brand/logo-512.png")} style={{ width: 110, height: 110, borderRadius: 28 }} />
        <span style={{ fontFamily: FONT_BODY, fontWeight: 900, fontSize: 104, color: C.ink, letterSpacing: "-0.02em" }}>Herdr Pocket</span>
      </div>
      <div style={{ position: "absolute", left: 0, right: 0, top: 690, display: "flex", justifyContent: "center", gap: 16, opacity: u }}>
        <Chip>开源 · Open source</Chip>
        <Chip bg={C.lavSoft} color={C.lavDeep}>
          自托管 · Self-hosted
        </Chip>
        <Chip bg={C.mintSoft} color={C.mint}>
          Android
        </Chip>
      </div>
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: 800,
          transform: `translateX(-50%) scale(${u})`,
          padding: "20px 40px",
          borderRadius: 999,
          background: C.term,
          color: "#fff",
          fontFamily: FONT_MONO,
          fontSize: 38,
          whiteSpace: "nowrap",
          boxShadow: "0 30px 60px -30px rgba(120,40,90,.7)",
        }}
      >
        <span style={{ color: "#FF8FB8" }}>github.com/</span>
        {SITE.repo}
      </div>
      {Array.from({ length: 14 }, (_, i) => {
        const a = (i / 14) * Math.PI * 2 + f * 0.01;
        const r = 260 + Math.sin(f / 20 + i) * 20;
        return <Sparkle key={i} x={960 + Math.cos(a) * r * 1.9 - 12} y={330 + Math.sin(a) * r * 0.9 - 12} size={12} opacity={0.4 + 0.5 * Math.abs(Math.sin(f / 10 + i))} color={i % 2 ? "#F27BA6" : "#C9B6F7"} />;
      })}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ social card (still)
export const OgCard: React.FC = () => (
  <AbsoluteFill>
    <Sky seed={11} />
    <div style={{ position: "absolute", right: 40, top: 30, width: 560, height: 560 }}>
      <div style={{ position: "absolute", inset: "10%", borderRadius: "50%", background: "radial-gradient(circle, #fff 0%, rgba(255,230,240,.7) 40%, transparent 70%)" }} />
      <Img src={asset("mascot/idle-poster.webp")} style={{ position: "relative", width: 560, height: 560 }} />
    </div>
    {["claude-code", "codex", "gemini", "kimi"].map((v, i) => (
      <Avatar key={v} v={v} size={74} style={{ position: "absolute", left: 640 + [0, 420, 30, 400][i], top: [130, 160, 430, 440][i], boxShadow: "0 0 0 5px #fff, 0 14px 26px -12px rgba(120,60,110,.6)" }} />
    ))}
    <div style={{ position: "absolute", left: 70, top: 80, width: 640 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <Img src={asset("brand/logo-512.png")} style={{ width: 76, height: 76, borderRadius: 20 }} />
        <span style={{ fontFamily: FONT_BODY, fontWeight: 900, fontSize: 54, color: C.ink }}>Herdr Pocket</span>
      </div>
      <div style={{ fontFamily: FONT_DISPLAY, fontWeight: 900, fontSize: 58, lineHeight: 1.2, color: C.ink, marginTop: 40 }}>
        所有 coding agent，
        <br />
        <span style={{ color: C.deep }}>装进你的口袋。</span>
      </div>
      <div style={{ fontFamily: FONT_BODY, fontWeight: 700, fontSize: 28, color: C.ink2, marginTop: 22 }}>Every coding agent on every computer, in your pocket.</div>
      <div style={{ display: "flex", gap: 12, marginTop: 34 }}>
        <Chip style={{ fontSize: 22 }}>Open source</Chip>
        <Chip bg={C.lavSoft} color={C.lavDeep} style={{ fontSize: 22 }}>
          Self-hosted
        </Chip>
        <Chip bg={C.mintSoft} color={C.mint} style={{ fontSize: 22 }}>
          Android
        </Chip>
      </div>
    </div>
  </AbsoluteFill>
);
