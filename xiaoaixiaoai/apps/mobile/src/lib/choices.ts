/**
 * The numbered options an agent is asking the person to pick from, read off
 * the bottom of its screen. Claude Code's permission prompts and questions,
 * Codex's approvals and the like list "1. Yes / 2. … / 3. No" and take the
 * number key; `y` / `n` do nothing there.
 */
export interface Choice {
  /** The key that picks it: "1", "2", … */
  key: string;
  label: string;
  /** The highlighted option (Enter picks it). */
  selected: boolean;
}

const OPTION = /^\s*([❯›>▶➜→●]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;

export function parseChoices(lines: string[], lookback = 20): Choice[] {
  const tail = lines.map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim()).slice(-lookback);
  // The last run of options numbered 1, 2, 3… in order: that is the open question.
  let best: Choice[] = [];
  let run: Choice[] = [];
  for (const line of tail) {
    const m = OPTION.exec(line.replace(/[│┃║]/g, " "));
    if (!m) continue;
    const n = Number(m[2]);
    if (n === 1) run = [];
    if (n !== run.length + 1) continue;
    const label = m[3]!
      .replace(/\s+\((?:esc|y|n|a|p|shift\+tab|tab)\)$/i, "")
      .replace(/^\[[ x✓✔]\]\s*/i, "")
      .trim();
    run.push({ key: String(n), label, selected: !!m[1] });
    if (run.length >= 2) best = [...run];
  }
  // A live menu has a pointer on one option; a numbered list in the output doesn't.
  return best.length >= 2 && best.length <= 9 && best.some((c) => c.selected) ? best : [];
}
