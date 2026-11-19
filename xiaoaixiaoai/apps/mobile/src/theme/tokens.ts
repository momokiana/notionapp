import { Easing } from "react-native-reanimated";
import type { AgentStatus } from "@xiaoaixiaoai/protocol";
import { makePalette } from "./palette";

export { brand, makePalette, type Palette } from "./palette";

/** Spacing scale (dp). */
export const space = { xxs: 2, xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32 } as const;

/** Corner radii: cards 20, composer/sheets 28, chips/buttons pill. */
export const radius = { xs: 8, sm: 12, md: 16, card: 20, xl: 28, pill: 999 } as const;

export const motion = {
  press: 90,
  quick: 160,
  standard: 240,
  breathe: 2400,
  glide: Easing.bezier(0.32, 0.72, 0, 1),
} as const;

export const fonts = {
  cute: "XiaoaiStarlightHand",
  body: "Nunito_400Regular",
  bodySemi: "Nunito_600SemiBold",
  bodyBold: "Nunito_700Bold",
  mono: "MapleMono-Regular",
  monoBold: "MapleMono-Bold",
} as const;

/** Status still uses its own colour, text and tinted background. */
const lightStatuses: Record<AgentStatus, { fg: string; bg: string }> = {
  blocked: { fg: "#A32648", bg: "#FFE6E9" },
  working: { fg: "#186B57", bg: "#DDF5EE" },
  done: { fg: "#6045A2", bg: "#EEE8FF" },
  idle: { fg: "#606984", bg: "#EDF3FA" },
  unknown: { fg: "#606984", bg: "#EDF3FA" },
};
const nightStatuses: Record<AgentStatus, { fg: string; bg: string }> = {
  blocked: { fg: "#FFABBA", bg: "#492832" },
  working: { fg: "#7DDBC0", bg: "#1F3A33" },
  done: { fg: "#D2C4FD", bg: "#383451" },
  idle: { fg: "#A9B8D7", bg: "#303D58" },
  unknown: { fg: "#A9B8D7", bg: "#303D58" },
};

export function statusColors(status: AgentStatus, dark: boolean): { fg: string; bg: string } {
  return (dark ? nightStatuses : lightStatuses)[status];
}

export const statusLabel: Record<AgentStatus, string> = {
  blocked: "需要你",
  working: "工作中",
  done: "已完成",
  idle: "空闲",
  unknown: "未知",
};

/** The word on an agent's status chip: an error says so, though its status is `blocked`. */
export function agentStatusLabel(a: { status: AgentStatus; errored?: boolean }): string {
  return a.errored ? "出错了" : statusLabel[a.status];
}

/** Space swatches share the new palette without changing group assignment. */
export function spaceColors(name: string, dark: boolean, hash: (s: string) => number): { fg: string; bg: string } {
  const p = makePalette(dark);
  const set = [
    { fg: p.accentText, bg: p.accentContainer },
    { fg: p.dusk, bg: p.duskContainer },
    statusColors("working", dark),
    { fg: p.skyText, bg: p.skyContainer },
    statusColors("idle", dark),
  ];
  return set[hash(name) % set.length]!;
}
