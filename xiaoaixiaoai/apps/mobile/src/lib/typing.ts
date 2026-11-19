/**
 * Direct typing into a terminal: the phone keeps what was typed on the
 * terminal's current line and sends only the change, so input methods that
 * rewrite text (pinyin turning into characters, autocorrect) stay in step.
 */

/** Bytes that turn the line `before` into `after`: Backspace for each changed character at the end, then the new text. */
export function typingDiff(before: string, after: string): string {
  const a = Array.from(before);
  const b = Array.from(after);
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  return "\x7f".repeat(a.length - k) + b.slice(k).join("");
}

/** Pieces of at most `max` characters, never splitting a character. */
export function chunks(data: string, max = 2000): string[] {
  const chars = Array.from(data);
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(""));
  return out;
}
