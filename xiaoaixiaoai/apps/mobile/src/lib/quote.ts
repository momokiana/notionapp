export interface ReplyQuote {
  id?: string;
  author: string;
  text: string;
}

function clipChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("")}…`;
}

/** Single-line readable snippet for quote preview banners. */
export function previewQuoteText(text: string, max = 96): string {
  const clean = text
    .replace(/\r\n/g, "\n")
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/^>+\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return clipChars(clean, max);
}

/** Formats a quoted reply so both LLMs and coding agents read the referenced snippet as context. */
export function formatQuotedMessage(quote: ReplyQuote | null | undefined, body: string): string {
  const trimmedBody = body.trim();
  if (!quote) return trimmedBody;
  const singleLineSnippet = previewQuoteText(quote.text, 240);
  if (!singleLineSnippet) return trimmedBody;
  const author = quote.author.replace(/[\[\]\r\n]/g, "").trim();
  const header = author ? `> [引用 ${author}] ${singleLineSnippet}` : `> ${singleLineSnippet}`;
  return trimmedBody ? `${header}\n\n${trimmedBody}` : header;
}

/** Extracts a leading quote prefix created by `formatQuotedMessage` for clean bubble rendering. */
export function splitQuotedPrefix(raw: string): { quote?: { author?: string; text: string }; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const match = /^>\s*(?:\[引用\s+([^\]]+)\]\s*)?(.+?)\n\n([\s\S]+)$/.exec(normalized);
  if (!match) return { body: raw };
  const author = match[1]?.trim() || undefined;
  const quoteText = match[2]?.trim() ?? "";
  const body = match[3] ?? "";
  if (!quoteText || !body.trim()) return { body: raw };
  return { quote: { author, text: quoteText }, body };
}
