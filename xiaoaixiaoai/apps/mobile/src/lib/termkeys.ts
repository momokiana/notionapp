/**
 * Accessory key bar, modelled on Orca's terminal-accessory-layout: a fixed set of built-in keys,
 * a user order and a visible subset, normalised so new built-ins appear next to their neighbours.
 * Only keys hostd forwards (hc/herdr key names) are listed. Ctrl+C is not here: it is always
 * pinned rightmost with a long-press guard.
 */
export interface TermKey {
  id: string;
  label: string;
  /** hostd `terminal.keys` name. */
  key: string;
  a11y: string;
  mono?: boolean;
}

export const TERM_KEYS: TermKey[] = [
  { id: "enter", label: "回车", key: "enter", a11y: "按回车" },
  { id: "esc", label: "Esc", key: "esc", a11y: "按 Esc", mono: true },
  { id: "up", label: "↑", key: "up", a11y: "向上" },
  { id: "down", label: "↓", key: "down", a11y: "向下" },
  { id: "tab", label: "Tab", key: "tab", a11y: "按 Tab", mono: true },
  { id: "shiftTab", label: "⇧Tab", key: "shift+tab", a11y: "按 Shift 加 Tab", mono: true },
  { id: "left", label: "←", key: "left", a11y: "向左" },
  { id: "right", label: "→", key: "right", a11y: "向右" },
  { id: "backspace", label: "退格", key: "backspace", a11y: "退格" },
  { id: "space", label: "空格", key: "space", a11y: "空格" },
  { id: "ctrlD", label: "Ctrl+D", key: "ctrl+d", a11y: "Ctrl 加 D，发送结束", mono: true },
  { id: "ctrlL", label: "Ctrl+L", key: "ctrl+l", a11y: "Ctrl 加 L，清屏", mono: true },
];

const DEFAULT_HIDDEN = new Set(["space", "ctrlD", "ctrlL"]);

export interface TermKeyLayout {
  order: string[];
  visible: string[];
}

export function defaultTermKeyLayout(): TermKeyLayout {
  const ids = TERM_KEYS.map((k) => k.id);
  return { order: ids, visible: ids.filter((id) => !DEFAULT_HIDDEN.has(id)) };
}

/** Drop unknown/duplicate ids; insert missing built-ins after their nearest earlier neighbour (visible). */
export function normalizeTermKeyLayout(value: unknown): TermKeyLayout {
  const ids = TERM_KEYS.map((k) => k.id);
  const known = new Set(ids);
  const v = value as Partial<TermKeyLayout> | null | undefined;
  if (!v || !Array.isArray(v.order) || !Array.isArray(v.visible)) return defaultTermKeyLayout();
  const seen = new Set<string>();
  const order = v.order.filter((id): id is string => typeof id === "string" && known.has(id) && !seen.has(id) && !!seen.add(id));
  const visible = new Set(v.visible.filter((id) => known.has(id)));
  ids.forEach((id, i) => {
    if (order.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const k = order.indexOf(ids[j]!);
      if (k !== -1) {
        at = k + 1;
        break;
      }
    }
    order.splice(at, 0, id);
    if (!DEFAULT_HIDDEN.has(id)) visible.add(id);
  });
  return { order, visible: order.filter((id) => visible.has(id)) };
}

export function visibleTermKeys(layout: TermKeyLayout): TermKey[] {
  const byId = new Map(TERM_KEYS.map((k) => [k.id, k]));
  return layout.visible.map((id) => byId.get(id)).filter((k): k is TermKey => !!k);
}
