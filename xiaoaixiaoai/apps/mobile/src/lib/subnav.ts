import { router } from "expo-router";
import type { SubSession } from "@xiaoaixiaoai/protocol";

/** One breadcrumb step below the main agent: a subagent session key and its label. */
export interface Crumb {
  k: string;
  t: string;
}

export function subLabel(s: Pick<SubSession, "title" | "preview" | "harness">): string {
  return s.title?.trim() || s.preview?.trim().split("\n")[0] || s.harness;
}

export function parseTrail(raw: string | string[] | undefined): Crumb[] {
  if (!raw || Array.isArray(raw)) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((c): c is Crumb => !!c && typeof c.k === "string" && typeof c.t === "string") : [];
  } catch {
    return [];
  }
}

/** Push a read-only subagent page; `trail` is the path down to (excluding) `s`. */
export function openSub(agentKey: string, trail: Crumb[], s: SubSession) {
  const next = [...trail, { k: s.key, t: subLabel(s) }];
  router.push({ pathname: "/agent/[key]", params: { key: agentKey, sub: s.key, trail: JSON.stringify(next) } });
}

export const SUB_STATUS = { working: "工作中", idle: "空闲" } as const;
