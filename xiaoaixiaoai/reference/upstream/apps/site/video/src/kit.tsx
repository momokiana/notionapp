import React from "react";
import { AbsoluteFill, Img, interpolate, random, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/fonts";

// Same subset fonts the site ships (copied by scripts/copy-assets.sh).
for (const [family, file, weight] of [
  ["Nunito", "nunito-400", "400"],
  ["Nunito", "nunito-700", "700"],
  ["Nunito", "nunito-900", "900"],
  ["ZCOOL KuaiLe", "zcool-kuaile", "400"],
  ["Maple Mono", "maple-mono-400", "400"],
  ["Maple Mono", "maple-mono-700", "700"],
] as const) {
  loadFont({ family, url: staticFile(`fonts/${file}.woff2`), weight });
}

export const C = {
  bg: "#FFF6F9",
  bg2: "#FFEEF4",
  surface: "#FFFFFF",
  ink: "#4A3550",
  ink2: "#9A8AA3",
  ink3: "#C2B5C9",
  accent: "#F27BA6",
  deep: "#D9578C",
  lav: "#C9B6F7",
  lavDeep: "#7A5CC8",
  lavSoft: "#EFE7FF",
  pinkSoft: "#FFE3EE",
  mint: "#2E8A6A",
  mintSoft: "#DDF5EC",
  term: "#241D2B",
  plum: "#241A30",
};

export const FONT_BODY = '"Nunito", "PingFang SC", "Noto Sans SC", sans-serif';
export const FONT_DISPLAY = '"Nunito", "ZCOOL KuaiLe", "PingFang SC", sans-serif';
export const FONT_MONO = '"Maple Mono", Menlo, monospace';

export const asset = (p: string) => staticFile(`assets/${p}`);

/** Spring from 0 to 1 starting at `delay` frames. */
export function useIn(delay = 0, damping = 14, durationInFrames?: number): number {
  const f = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: f - delay, fps, config: { damping, mass: 0.8 }, durationInFrames });
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const ramp = (f: number, a: number, b: number) => clamp01((f - a) / (b - a));

/** Characters of `text` visible at frame f when typing starts at `start`. */
export const typed = (text: string, f: number, start: number, cps = 18, fps = 30) => {
  const chars = Array.from(text);
  const n = Math.max(0, Math.min(chars.length, Math.floor(((f - start) / fps) * cps)));
  return chars.slice(0, n).join("");
};

// ------------------------------------------------------------------ backgrounds
export const Sky: React.FC<{ dusk?: boolean; seed?: number }> = ({ dusk = false, seed = 1 }) => {
  const f = useCurrentFrame();
  const t = f / 30;
  const blob = (x: number, y: number, r: number, color: string, k: number) => {
    const dx = Math.sin(t * 0.35 + k) * 60;
    const dy = Math.cos(t * 0.28 + k * 1.7) * 40;
    return (
      <div
        style={{
          position: "absolute",
          left: x - r + dx,
          top: y - r + dy,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${color} 0%, transparent 68%)`,
        }}
      />
    );
  };
  const sparkles = Array.from({ length: 26 }, (_, i) => {
    const x = random(`sx${seed}${i}`) * 1920;
    const y0 = random(`sy${seed}${i}`) * 1080;
    const sp = 10 + random(`sp${seed}${i}`) * 25;
    const y = ((y0 - t * sp) % 1080 + 1080) % 1080;
    const s = 6 + random(`ss${seed}${i}`) * 10;
    const a = 0.25 + 0.6 * Math.abs(Math.sin(t * (1 + random(`sa${seed}${i}`) * 2) + i));
    return <Sparkle key={i} x={x} y={y} size={s} opacity={a} color={dusk ? "#FFB3CF" : "#F7A8C6"} />;
  });
  return (
    <AbsoluteFill style={{ background: dusk ? C.plum : C.bg, overflow: "hidden" }}>
      {dusk ? (
        <>
          {blob(300, 200, 700, "rgba(217,87,140,.55)", 0)}
          {blob(1650, 900, 800, "rgba(138,107,224,.5)", 2)}
          {blob(1100, 100, 500, "rgba(255,143,184,.25)", 4)}
        </>
      ) : (
        <>
          {blob(1450, 380, 720, "rgba(255,214,230,.95)", 0)}
          {blob(350, 860, 640, "rgba(233,222,255,.95)", 2)}
          {blob(200, 120, 480, "rgba(221,245,236,.9)", 4)}
          {blob(1000, 1050, 520, "rgba(255,233,221,.8)", 5)}
        </>
      )}
      {sparkles}
    </AbsoluteFill>
  );
};

export const Sparkle: React.FC<{ x: number; y: number; size: number; opacity: number; color: string }> = ({ x, y, size, opacity, color }) => (
  <svg style={{ position: "absolute", left: x, top: y, width: size * 2, height: size * 2, opacity }} viewBox="0 0 20 20">
    <path d="M10 0 C11 7 13 9 20 10 C13 11 11 13 10 20 C9 13 7 11 0 10 C7 9 9 7 10 0Z" fill={color} />
  </svg>
);

// ------------------------------------------------------------------ text
export const Caption: React.FC<{
  zh: string;
  en: string;
  eyebrow?: string;
  delay?: number;
  size?: number;
  align?: "left" | "center";
  light?: boolean;
  style?: React.CSSProperties;
}> = ({ zh, en, eyebrow, delay = 0, size = 76, align = "left", light = false, style }) => {
  const a = useIn(delay, 16);
  const b = useIn(delay + 8, 16);
  const c = useIn(delay - 4, 16);
  return (
    <div style={{ textAlign: align, ...style }}>
      {eyebrow ? (
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 12,
            fontFamily: FONT_BODY,
            fontWeight: 900,
            fontSize: 26,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: light ? "#FFB3CF" : C.deep,
            marginBottom: 18,
            opacity: c,
            transform: `translateY(${(1 - c) * 20}px)`,
          }}
        >
          <span style={{ width: 28, height: 3, borderRadius: 3, background: "currentColor" }} />
          {eyebrow}
        </div>
      ) : null}
      <div
        style={{
          fontFamily: FONT_DISPLAY,
          fontWeight: 900,
          fontSize: size,
          lineHeight: 1.18,
          color: light ? "#fff" : C.ink,
          opacity: a,
          transform: `translateY(${(1 - a) * 46}px)`,
          whiteSpace: "pre-line",
          fontSynthesis: "none",
        }}
      >
        {zh}
      </div>
      <div
        style={{
          fontFamily: FONT_BODY,
          fontWeight: 700,
          fontSize: size * 0.4,
          lineHeight: 1.4,
          marginTop: 16,
          color: light ? "rgba(255,255,255,.72)" : C.ink2,
          opacity: b,
          transform: `translateY(${(1 - b) * 30}px)`,
          whiteSpace: "pre-line",
        }}
      >
        {en}
      </div>
    </div>
  );
};

export const Chip: React.FC<{ children: React.ReactNode; bg?: string; color?: string; style?: React.CSSProperties }> = ({
  children,
  bg = C.pinkSoft,
  color = C.deep,
  style,
}) => (
  <span
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 10,
      padding: "10px 22px",
      borderRadius: 999,
      background: bg,
      color,
      fontFamily: FONT_BODY,
      fontWeight: 900,
      fontSize: 28,
      whiteSpace: "nowrap",
      ...style,
    }}
  >
    {children}
  </span>
);

export const Avatar: React.FC<{ v: string; size?: number; style?: React.CSSProperties }> = ({ v, size = 48, style }) => (
  <Img src={asset(`vendors/${v}.webp`)} style={{ width: size, height: size, borderRadius: "50%", ...style }} />
);

// ------------------------------------------------------------------ phone frame
export const Phone: React.FC<{ children: React.ReactNode; scale?: number; style?: React.CSSProperties; dark?: boolean }> = ({
  children,
  scale = 1,
  style,
}) => (
  <div style={{ width: 330 * scale, height: 690 * scale, position: "relative", ...style }}>
    <div className="phone" style={{ transform: `scale(${scale})`, transformOrigin: "0 0", position: "absolute", left: 0, top: 0 }}>
      <div className="phone-screen">{children}</div>
    </div>
  </div>
);

export const StatusBar: React.FC = () => (
  <div className="sb">
    <span>12:00</span>
    <span className="sb-i">
      <svg viewBox="0 0 24 24">
        <path d="M12 19.5a1.6 1.6 0 1 0 0-3.2 1.6 1.6 0 0 0 0 3.2ZM4.2 10.6a11 11 0 0 1 15.6 0l-1.6 1.6a8.8 8.8 0 0 0-12.4 0l-1.6-1.6Zm3.2 3.2a6.5 6.5 0 0 1 9.2 0L15 15.4a4.3 4.3 0 0 0-6 0l-1.6-1.6Z" />
      </svg>
      <svg viewBox="0 0 24 24">
        <rect x="3" y="7" width="16" height="10" rx="2.5" />
        <rect x="20" y="10" width="1.8" height="4" rx=".9" />
      </svg>
    </span>
  </div>
);

/** Appear with a soft rise; used for list items inside phone screens. */
export const Rise: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties; className?: string }> = ({
  at,
  children,
  style,
  className,
}) => {
  const f = useCurrentFrame();
  const k = interpolate(f, [at, at + 12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  if (f < at) return null;
  const e = 1 - Math.pow(1 - k, 3);
  return (
    <div className={className} style={{ opacity: e, transform: `translateY(${(1 - e) * 14}px)`, ...style }}>
      {children}
    </div>
  );
};
