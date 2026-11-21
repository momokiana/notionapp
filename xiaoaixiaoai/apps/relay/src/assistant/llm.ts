/**
 * Streaming chat client for the text assistant. Two wire protocols: Anthropic
 * Messages and OpenAI Chat Completions, which most vendors also expose. The
 * assistant only sees the Anthropic-shaped blocks below; the OpenAI side is
 * translated both ways here. GPT login uses the public Pi model transport only;
 * the assistant's own tool loop remains unchanged.
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { GptLoginError, makeGptLoginDriver } from "./gpt-login.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface Msg {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** Streamed text of the current answer, as it arrives. */
  onText?: (delta: string) => void;
}

export interface LlmResult {
  content: ContentBlock[];
  stopReason: string | null;
  model: string;
}

export type Llm = (req: LlmRequest) => Promise<LlmResult>;

export type Protocol = "anthropic" | "openai" | "pi-openai-oauth";
export type AuthStyle = "bearer" | "x-api-key" | "api-key" | "none";

/** One model at one provider: an entry of the fallback list. */
export interface HttpLlmTarget {
  /** Provider id, for logs and health (never the key). */
  provider: string;
  protocol: "anthropic" | "openai";
  /** Anthropic: the root before `/v1/messages`. OpenAI: the base before `/chat/completions`. */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Default: `x-api-key` for Anthropic, `bearer` for OpenAI; nothing is sent without a key. */
  auth?: AuthStyle;
  headers?: Record<string, string>;
  /** OpenAI protocol: the name of the output limit (`max_tokens` unless the vendor wants the newer one). */
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** Merged into every request body last, e.g. `{"reasoning_effort":"low"}`. */
  extraBody?: Record<string, unknown>;
}

export interface GptLoginTarget {
  provider: string;
  protocol: "pi-openai-oauth";
  model: string;
  credentialsFile: string;
  reasoning?: ThinkingLevel;
  /** Fixed public diagnostics metadata; never a configurable request endpoint. */
  readonly baseUrl: "https://api.openai.com/v1";
  apiKey?: never;
  auth?: never;
  headers?: never;
  maxTokensField?: never;
  extraBody?: never;
}
export type LlmTarget = HttpLlmTarget | GptLoginTarget;
export type LlmProvider = Omit<HttpLlmTarget, "model"> | Omit<GptLoginTarget, "model">;

export interface LlmConfig {
  /** Tried in order: the next one is used when one fails or stays silent too long. */
  targets: LlmTarget[];
  /** No first token of the answer within this long: give up on that model. */
  firstByteMs?: number;
  totalMs?: number;
  /** Fallbacks and slow answers (never the key). */
  log?: (msg: string) => void;
}

const SLOW_MS = 8_000;

export class LlmError extends Error {}

/** Drops raw tool-call markup (e.g. DeepSeek `<｜｜DSML｜｜ calls>…`) that a model printed as text. */
export function stripToolMarkup(text: string): string {
  const at = text.search(/<[|\uFF5C]+\s*DSML\s*[|\uFF5C]+/);
  return at < 0 ? text : text.slice(0, at).trimEnd();
}

export function makeLlm(cfg: LlmConfig): Llm {
  const gpt = makeGptLoginDriver();
  const withLogin = cfg.targets.some((t) => t.protocol === "pi-openai-oauth");
  return async (req) => {
    let last: unknown;
    let visible = false;
    let loginFile: string | undefined;
    const request = { ...req, onText: (text: string) => { visible ||= !!text; req.onText?.(text); } };
    for (const t of cfg.targets) {
      if (req.signal?.aborted) throw new LlmError("cancelled");
      if (loginFile && (t.protocol !== "pi-openai-oauth" || resolve(t.credentialsFile) !== loginFile)) throw last;
      const t0 = Date.now();
      const label = `${t.provider}:${t.model}`;
      try {
        const r = t.protocol === "pi-openai-oauth" ? await gpt(t, cfg, request) : await once(t, cfg, request);
        const ms = Date.now() - t0;
        if (ms > SLOW_MS) cfg.log?.(`${label} slow: ${ms}ms`);
        return r;
      } catch (e) {
        last = e;
        if (req.signal?.aborted) throw e;
        cfg.log?.(`${label} failed after ${Date.now() - t0}ms: ${(e as Error).message.slice(0, 200)}`);
        // Both directions of a chain touching GPT login must not concatenate drafts.
        // Pure legacy HTTP chains retain their original behavior.
        if (withLogin && visible) throw e;
        if (t.protocol === "pi-openai-oauth") {
          if (!(e instanceof GptLoginError) || !e.retryable || e.visible) throw e;
          loginFile = resolve(t.credentialsFile);
        }
      }
    }
    throw last instanceof Error ? last : new LlmError("model unavailable");
  };
}

/** What a protocol needs to know while a stream is read. */
interface Stream {
  /** Set once the answer has really started (text, a tool call, or reasoning). */
  started(): void;
}

async function once(t: HttpLlmTarget, cfg: LlmConfig, req: LlmRequest): Promise<LlmResult> {
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal?.addEventListener("abort", onAbort, { once: true });
  let gotContent = false;
  const firstTimer = setTimeout(() => {
    if (!gotContent) ac.abort();
  }, cfg.firstByteMs ?? 25_000);
  const totalTimer = setTimeout(() => ac.abort(), cfg.totalMs ?? 120_000);
  const label = `${t.provider}:${t.model}`;
  const stream: Stream = { started: () => (gotContent = true) };
  try {
    const anthropic = t.protocol === "anthropic";
    const base = t.baseUrl.replace(/\/+$/, "");
    const res = await fetch(anthropic ? `${base}/v1/messages` : `${base}/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "content-type": "application/json",
        ...(anthropic ? { "anthropic-version": "2023-06-01" } : {}),
        ...authHeaders(t),
        ...t.headers,
      },
      body: JSON.stringify({ ...(anthropic ? anthropicBody(t, req) : openaiBody(t, req)), ...t.extraBody }),
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new LlmError(`${label}: HTTP ${res.status} ${scrub(text, t.apiKey).slice(0, 200)}`);
    }
    const events = sse(res.body as unknown as AsyncIterable<Uint8Array>);
    const r = anthropic ? await readAnthropic(events, t, req, stream) : await readOpenai(events, t, req, stream);
    // Some models (DeepSeek) leak raw tool-call markup as text when called without tools; it is never an answer.
    r.content = r.content
      .map((b) => (b.type === "text" ? { ...b, text: stripToolMarkup(b.text) } : b))
      .filter((b) => b.type !== "text" || b.text.trim().length > 0);
    if (!gotContent || r.content.length === 0) {
      const suffix = r.stopReason === "max_tokens" ? " (exhausted max_tokens)" : "";
      throw new LlmError(`${label}: empty answer${suffix}`);
    }
    return r;
  } catch (e) {
    if (e instanceof LlmError) throw e;
    if (ac.signal.aborted && !req.signal?.aborted) throw new LlmError(`${label}: no answer in time`);
    throw new LlmError(`${label}: ${scrub((e as Error).message, t.apiKey)}`);
  } finally {
    clearTimeout(firstTimer);
    clearTimeout(totalTimer);
    req.signal?.removeEventListener("abort", onAbort);
  }
}

function authHeaders(t: HttpLlmTarget): Record<string, string> {
  if (!t.apiKey) return {};
  switch (t.auth ?? (t.protocol === "anthropic" ? "x-api-key" : "bearer")) {
    case "bearer":
      return { authorization: `Bearer ${t.apiKey}` };
    case "x-api-key":
      return { "x-api-key": t.apiKey };
    case "api-key":
      return { "api-key": t.apiKey };
    default:
      return {};
  }
}

/** `data:` payloads of a server-sent event stream, parsed; `[DONE]` and junk are skipped. */
async function* sse(body: AsyncIterable<Uint8Array>): AsyncGenerator<any> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* a keep-alive or a broken line */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages
// ---------------------------------------------------------------------------

function anthropicBody(t: HttpLlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    max_tokens: req.maxTokens ?? 1200,
    stream: true,
    system: req.system,
    messages: req.messages,
    ...(req.tools.length ? { tools: req.tools } : {}),
  };
}

async function readAnthropic(events: AsyncGenerator<any>, t: HttpLlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  const blocks: Array<{ type: string; text?: string; id?: string; name?: string; json?: string }> = [];
  let stopReason: string | null = null;
  for await (const d of events) {
    switch (d.type) {
      case "content_block_start": {
        stream.started();
        const b = d.content_block ?? {};
        blocks[d.index] = { type: b.type, text: b.text ?? "", id: b.id, name: b.name, json: "" };
        break;
      }
      case "content_block_delta": {
        stream.started();
        const b = blocks[d.index];
        if (!b) break;
        if (d.delta?.type === "text_delta" && typeof d.delta.text === "string") {
          b.text += d.delta.text;
          req.onText?.(d.delta.text);
        } else if (d.delta?.type === "input_json_delta" && typeof d.delta.partial_json === "string") {
          b.json += d.delta.partial_json;
        }
        break;
      }
      case "message_delta":
        if (d.delta?.stop_reason) stopReason = d.delta.stop_reason;
        break;
      case "error":
        throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error?.message ?? "stream error"), t.apiKey)}`);
    }
  }
  const content: ContentBlock[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) content.push({ type: "text", text: b.text });
    else if (b.type === "tool_use" && b.id && b.name) {
      const parsed = parseArgs(b.json);
      if (!parsed.ok) throw new LlmError(`${t.provider}:${t.model}: truncated tool call (${b.name})`);
      content.push({ type: "tool_use", id: b.id, name: b.name, input: parsed.value });
    }
  }
  return { content, stopReason, model: t.model };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions
// ---------------------------------------------------------------------------

function openaiBody(t: HttpLlmTarget, req: LlmRequest): Record<string, unknown> {
  return {
    model: t.model,
    stream: true,
    [t.maxTokensField ?? "max_tokens"]: req.maxTokens ?? 1200,
    messages: [{ role: "system", content: req.system }, ...toOpenaiMessages(req.messages)],
    ...(req.tools.length
      ? { tools: req.tools.map((x) => ({ type: "function", function: { name: x.name, description: x.description, parameters: x.input_schema } })) }
      : {}),
  };
}

/** Anthropic-shaped history to Chat Completions messages: tool results become `tool` messages right after the call. */
export function toOpenaiMessages(msgs: Msg[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const m of msgs) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = m.content
      .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    if (m.role === "assistant") {
      const calls = m.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      out.push(calls.length ? { role: "assistant", content: text || null, tool_calls: calls } : { role: "assistant", content: text });
      continue;
    }
    for (const b of m.content) if (b.type === "tool_result") out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
    if (text) out.push({ role: "user", content: text });
  }
  return out;
}

const OPENAI_STOP: Record<string, string> = { tool_calls: "tool_use", function_call: "tool_use", stop: "end_turn", length: "max_tokens" };

async function readOpenai(events: AsyncGenerator<any>, t: HttpLlmTarget, req: LlmRequest, stream: Stream): Promise<LlmResult> {
  let text = "";
  const calls: Array<{ id: string; name: string; args: string }> = [];
  let stopReason: string | null = null;
  for await (const d of events) {
    if (d.error) throw new LlmError(`${t.provider}:${t.model}: ${scrub(String(d.error.message ?? d.error.code ?? "stream error"), t.apiKey)}`);
    const ch = Array.isArray(d.choices) ? d.choices[0] : undefined;
    if (!ch) continue;
    const delta = ch.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      stream.started();
      text += delta.content;
      req.onText?.(delta.content);
    }
    // Thinking models reason before they answer: that counts as having started, but is not the answer.
    if ((typeof delta.reasoning_content === "string" && delta.reasoning_content) || (typeof delta.reasoning === "string" && delta.reasoning)) stream.started();
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        stream.started();
        let i: number = typeof tc.index === "number" ? tc.index : calls.length - 1;
        // Without an index, a new id starts a new call.
        if (typeof tc.index !== "number" && (i < 0 || (tc.id && calls[i]!.id && calls[i]!.id !== tc.id))) i = calls.length;
        const c = (calls[i] ??= { id: "", name: "", args: "" });
        if (typeof tc.id === "string" && tc.id) c.id = tc.id;
        if (typeof tc.function?.name === "string" && tc.function.name && !c.name) c.name = tc.function.name;
        if (typeof tc.function?.arguments === "string") c.args += tc.function.arguments;
        else if (tc.function?.arguments && typeof tc.function.arguments === "object") c.args = JSON.stringify(tc.function.arguments);
      }
    }
    if (ch.finish_reason) stopReason = OPENAI_STOP[ch.finish_reason] ?? ch.finish_reason;
  }
  const content: ContentBlock[] = [];
  if (text) content.push({ type: "text", text });
  calls.forEach((c, n) => {
    if (!c?.name) return;
    const parsed = parseArgs(c.args);
    if (!parsed.ok) throw new LlmError(`${t.provider}:${t.model}: truncated tool call (${c.name})`);
    // Ids go back to the model next round; some vendors leave them out.
    content.push({ type: "tool_use", id: c.id || `call_${Date.now().toString(36)}_${n}`, name: c.name, input: parsed.value });
  });
  return { content, stopReason, model: t.model };
}

function parseArgs(json: string | undefined): { value: unknown; ok: boolean } {
  if (!json || !json.trim()) return { value: {}, ok: true };
  try {
    return { value: JSON.parse(json), ok: true };
  } catch {
    return { value: {}, ok: false };
  }
}

function scrub(s: string, key: string | undefined): string {
  return key ? s.split(key).join("[redacted]") : s;
}
