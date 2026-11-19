/** Model transport only: the existing Pocket assistant remains the sole tool executor. */
import {
  createModels, InMemoryModelsStore,
  type AssistantMessage, type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import type { Context, Message, Provider, Tool, ToolCall } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ContentBlock, GptLoginTarget, LlmConfig, LlmRequest, LlmResult, Msg } from "./llm.ts";
import { GptLoginCredentials } from "./gpt-login-credentials.ts";

export class GptLoginError extends Error {
  readonly retryable: boolean;
  readonly visible: boolean;
  constructor(code: string, retryable = false, visible = false) {
    super(`gpt-login: ${code}`);
    this.retryable = retryable;
    this.visible = visible;
  }
}
interface Dependencies {
  /** Test-only injection: real Models still owns auth resolution and refresh. No config/env hook. */
  provider?: () => Provider;
  fetch?: typeof globalThis.fetch;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new GptLoginError("cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
  try { return await Promise.race([work, cancelled]); }
  finally { signal.removeEventListener("abort", cancel); }
}

export function makeGptLoginDriver(deps: Dependencies = {}) {
  // Only the current run reuses these content-array identities. Persisted Pocket
  // items contain visible text, not these keys: this is NOT a session/history store.
  const native = new WeakMap<ContentBlock[], { message: AssistantMessage; snapshot: string }>();
  function context(req: LlmRequest): Context {
    const messages: Message[] = [];
    const calls = new Map<string, string>();
    const results = new Set<string>();
    for (const item of req.messages) {
      const blocks = typeof item.content === "string" ? [{ type: "text" as const, text: item.content }] : item.content;
      if (item.role === "assistant") {
        const content: AssistantMessage["content"] = [];
        for (const block of blocks) {
          if (block.type === "text") content.push({ type: "text", text: block.text });
          else if (block.type === "tool_use") {
            if (!block.id || !block.name || calls.has(block.id) || !object(block.input)) throw new GptLoginError("invalid context");
            calls.set(block.id, block.name);
            content.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.input as ToolCall["arguments"] });
          } else throw new GptLoginError("invalid context");
        }
        const cached = typeof item.content === "string" ? undefined : native.get(item.content);
        if (cached && cached.snapshot !== JSON.stringify(item.content)) throw new GptLoginError("changed context");
        // Foreign/plain history is explicitly foreign. Let the official SDK remove
        // incompatible item ids; never pretend reconstructed text has native signatures.
        messages.push(cached ? structuredClone(cached.message) : {
          role: "assistant", content, api: "pocket-history", provider: "pocket-history", model: "pocket-history",
          usage: zeroUsage(), stopReason: content.some((b) => b.type === "toolCall") ? "toolUse" : "stop", timestamp: Date.now(),
        });
      } else {
        let text: string[] = [];
        const flush = () => { if (text.length) { messages.push({ role: "user", content: text.join(""), timestamp: Date.now() }); text = []; } };
        for (const block of blocks) {
          if (block.type === "text") text.push(block.text);
          else if (block.type === "tool_result") {
            flush();
            const name = calls.get(block.tool_use_id);
            if (!name || results.has(block.tool_use_id)) throw new GptLoginError("invalid tool result");
            results.add(block.tool_use_id);
            messages.push({ role: "toolResult", toolCallId: block.tool_use_id, toolName: name,
              content: [{ type: "text", text: block.content }], isError: !!block.is_error, timestamp: Date.now() });
          } else throw new GptLoginError("invalid context");
        }
        flush();
      }
    }
    if (req.tools.some((t, i) => !t.name || req.tools.findIndex((x) => x.name === t.name) !== i)) throw new GptLoginError("invalid tools");
    const tools = req.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema })) as Tool[];
    return { systemPrompt: req.system, messages, tools };
  }
  return async (target: GptLoginTarget, cfg: Pick<LlmConfig, "firstByteMs" | "totalMs">, req: LlmRequest): Promise<LlmResult> => {
    if (req.signal?.aborted) throw new GptLoginError("cancelled");
    const controller = new AbortController();
    const cancel = () => controller.abort();
    req.signal?.addEventListener("abort", cancel, { once: true });
    if (req.signal?.aborted) controller.abort();
    let timedOut = false;
    const timeout = () => { timedOut = true; controller.abort(); };
    const total = setTimeout(timeout, cfg.totalMs ?? 120_000);
    let first: ReturnType<typeof setTimeout> | undefined;
    let armed = false, progressed = false, visible = false;
    let store: GptLoginCredentials | undefined;
    const progress = () => { progressed = true; clearTimeout(first); };
    try {
      const input = context(req);
      store = new GptLoginCredentials(target.credentialsFile);
      const models = createModels({ credentials: store, modelsStore: new InMemoryModelsStore(),
        authContext: { env: async () => undefined, fileExists: async () => false } });
      models.setProvider(deps.provider?.() ?? openaiProvider());
      const model = models.getModel("openai", target.model);
      if (!model || model.api !== "openai-responses") throw new GptLoginError("unknown model");
      const events = models.streamSimple(model, input, {
        signal: controller.signal, transport: "sse", maxRetries: 0, timeoutMs: cfg.totalMs ?? 120_000,
        maxTokens: req.maxTokens, reasoning: target.reasoning, fetch: deps.fetch,
        // Public post-auth boundary. Do not inspect, print or change auth headers.
        transformHeaders: (headers) => {
          controller.signal.throwIfAborted();
          armed = true;
          if (!progressed && first === undefined) first = setTimeout(timeout, cfg.firstByteMs ?? 25_000);
          return headers;
        },
      });
      let done: AssistantMessage | undefined;
      const iterator = events[Symbol.asyncIterator]();
      for (;;) {
        const next = await abortable(iterator.next(), controller.signal);
        if (next.done) break;
        const event: AssistantMessageEvent = next.value;
        if (event.type === "text_delta") {
          if (event.delta) { progress(); visible = true; req.onText?.(event.delta); }
        } else if (event.type === "thinking_delta" || event.type === "toolcall_start" || event.type === "toolcall_delta") {
          progress();
        } else if (event.type === "thinking_start") {
          const block = event.partial.content[event.contentIndex];
          if (block?.type === "thinking" && block.thinkingSignature) progress();
        } else if (event.type === "error") {
          throw new GptLoginError(store.failure ? "authentication failed" : armed ? "model failed" : "authentication failed", armed && !store.failure, visible);
        } else if (event.type === "done") {
          if (done || event.reason !== event.message.stopReason) throw new GptLoginError("invalid terminal result", false, visible);
          done = event.message;
          break;
        }
      }
      controller.signal.throwIfAborted();
      if (!done || !["stop", "toolUse"].includes(done.stopReason) || done.api !== "openai-responses" || done.provider !== "openai" || done.model !== model.id)
        throw new GptLoginError("incomplete result", false, visible);
      const content: ContentBlock[] = [];
      const ids = new Set<string>();
      let hasText = false;
      for (const block of done.content) {
        if (block.type === "text") {
          if (block.text) { content.push({ type: "text", text: block.text }); hasText ||= !!block.text.trim(); }
        } else if (block.type === "toolCall") {
          if (block.argumentsError !== undefined || !block.id || ids.has(block.id) || !object(block.arguments) || !req.tools.some((t) => t.name === block.name))
            throw new GptLoginError("invalid tool call", false, visible);
          ids.add(block.id);
          content.push({ type: "tool_use", id: block.id, name: block.name, input: structuredClone(block.arguments) });
        }
      }
      if ((!hasText && !ids.size) || (done.stopReason === "toolUse") !== !!ids.size) throw new GptLoginError("empty or invalid result", false, visible);
      native.set(content, { message: structuredClone(done), snapshot: JSON.stringify(content) });
      return { content, stopReason: ids.size ? "tool_use" : "end_turn", model: done.model };
    } catch (error) {
      controller.abort();
      if (req.signal?.aborted) throw new GptLoginError("cancelled", false, visible);
      if (timedOut) throw new GptLoginError("timeout", armed && !store?.failure, visible);
      if (error instanceof GptLoginError) throw error;
      throw new GptLoginError(store?.failure ? "authentication failed" : armed ? "timeout or model failed" : "authentication failed", armed && !store?.failure, visible);
    } finally {
      clearTimeout(total); clearTimeout(first);
      req.signal?.removeEventListener("abort", cancel);
    }
  };
}
