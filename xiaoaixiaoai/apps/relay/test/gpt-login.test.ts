import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Provider, type TranscriptContext, type OAuthCredential } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { makeGptLoginDriver } from "../src/assistant/gpt-login.ts";
import { makeLlm, type GptLoginTarget, type LlmRequest } from "../src/assistant/llm.ts";

const TOOLS = [{ name: "list_agents", description: "fixture tool", input_schema: { type: "object", properties: { n: { type: "number" } } } }];
const req = (): LlmRequest => ({ system: "fixture system", messages: [{ role: "user", content: "你好 fixture" }], tools: TOOLS });
const usage = () => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function answer(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-6-sol", content, stopReason, usage: usage(), timestamp: Date.now() };
}
function completed(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "start", partial: message });
  for (const [contentIndex, block] of message.content.entries()) {
    if (block.type === "text") {
      stream.push({ type: "text_delta", contentIndex, delta: block.text, partial: message });
      stream.push({ type: "text_end", contentIndex, content: block.text, partial: message });
    } else if (block.type === "thinking") {
      stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial: message });
    } else stream.push({ type: "toolcall_start", contentIndex, partial: message });
  }
  stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse" | "length" | "deferred", message });
  stream.end();
  return stream;
}
function provider(run: (context: TranscriptContext) => AssistantMessageEventStream,
  auth: { refresh?: (c: OAuthCredential) => Promise<OAuthCredential>; toAuth?: (c: OAuthCredential) => Promise<{ apiKey: string }> } = {}): Provider {
  const original = openaiProvider();
  return { ...original, auth: { oauth: {
    name: "fixture OAuth", login: async () => { throw Error("fixture has no login UI"); },
    refresh: auth.refresh ?? (async () => { throw Error("unexpected fixture refresh"); }),
    toAuth: auth.toAuth ?? (async (c) => ({ apiKey: c.access })),
  } }, stream: (_m, c) => run(c), streamSimple: (_m, c) => run(c) };
}
async function fixture(expired = false) {
  const dir = await mkdtemp(join(tmpdir(), "pocket-gpt-driver-test-"));
  const file = join(dir, "auth.json");
  const credential = { type: "oauth" as const, access: "FIXTURE_ACCESS_NOT_A_TOKEN", refresh: "FIXTURE_REFRESH_NOT_A_TOKEN",
    expires: expired ? 0 : Date.now() + 3_600_000, clientId: "fixture-client", scopes: ["chatgpt.tokens.use.direct"], opaque: { retained: true } };
  await writeFile(file, JSON.stringify({ openai: credential, other: { unrelated: true } }), { mode: 0o600 });
  const target: GptLoginTarget = { provider: "gpt-login", protocol: "pi-openai-oauth", baseUrl: "https://api.openai.com/v1", model: "gpt-6-sol", credentialsFile: file };
  return { file, dir, credential, target, close: () => rm(dir, { recursive: true, force: true }) };
}
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }
async function within<T>(promise: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("fixture deadline")), ms); });
  try { return await Promise.race([promise, deadline]); } finally { clearTimeout(timer!); }
}

test("real Models: text deltas once, tool round IDs/results/order and in-run opaque signatures, no new persistent session", async () => {
  const f = await fixture();
  try {
    const seen: any[] = [];
    const first = answer([
      { type: "thinking", thinking: "PRIVATE_REASONING_FIXTURE", thinkingSignature: '{"type":"reasoning","id":"rs_fixture","encrypted_content":"fixture"}' },
      { type: "text", text: "我查看", textSignature: '{"v":1,"id":"msg_fixture","phase":"commentary"}' },
      { type: "toolCall", id: "call_fixture|fc_fixture", name: "list_agents", arguments: { n: 2 }, namespace: "fixture_namespace" },
    ], "toolUse");
    const driver = makeGptLoginDriver({ provider: () => provider((c) => { seen.push(c); return completed(seen.length === 1 ? first : answer([{ type: "text", text: "两个" }])); }) });
    const pieces: string[] = [];
    const input = req(); input.onText = (d) => pieces.push(d);
    const result = await driver(f.target, {}, input);
    assert.deepEqual(result.content, [{ type: "text", text: "我查看" }, { type: "tool_use", id: "call_fixture|fc_fixture", name: "list_agents", input: { n: 2 } }]);
    input.messages.push({ role: "assistant", content: result.content }, { role: "user", content: [
      { type: "tool_result", tool_use_id: "call_fixture|fc_fixture", content: "fixture result", is_error: true },
      { type: "text", text: "最后一轮" },
    ] });
    await driver(f.target, {}, input);
    assert.deepEqual(pieces, ["我查看", "两个"]);
    const history = seen[1].messages as any[];
    assert.deepEqual(history.find((m) => m.role === "assistant").content, first.content);
    assert.equal(history.find((m) => m.role === "toolResult").toolName, "list_agents");
    assert.equal(history.find((m) => m.role === "toolResult").isError, true);
    assert.equal(history.at(-1).content, "最后一轮");
    assert.ok(history.find((m) => m.role === "system").toolsAdded.some((t: any) => t.name === "list_agents"));
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_REASONING|thinkingSignature|fixture_namespace|textSignature/);
    // A new request/factory receives only visible stored text, exactly like messagesFromThread.
    const reconstructed = makeGptLoginDriver({ provider: () => provider((c) => { assert.ok(c.messages.every((m: any) => m.role !== "assistant" || m.content.every((b: any) => b.type === "text"))); return completed(answer([{ type: "text", text: "新请求" }])); }) });
    await reconstructed(f.target, {}, { ...req(), messages: [{ role: "user", content: "之前" }, { role: "assistant", content: "我查看\n两个" }, { role: "user", content: "继续" }] });
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).openai.access, f.credential.access);
  } finally { await f.close(); }
});

test("SDK argumentsError, duplicate/undeclared calls, length/deferred/empty/error/incomplete streams never return executable tools", async () => {
  const f = await fixture();
  try {
    const tool = { type: "toolCall" as const, id: "call_a|fc_a", name: "list_agents", arguments: {} };
    const bad = [answer([{ ...tool, argumentsError: "PRIVATE_SENTINEL_ARGUMENTS" }], "toolUse"), answer([tool, tool], "toolUse"),
      answer([{ ...tool, name: "undeclared" }], "toolUse"), answer([tool], "length"), answer([], "stop"), answer([], "deferred")];
    for (const message of bad) {
      const driver = makeGptLoginDriver({ provider: () => provider(() => completed(message)) });
      await assert.rejects(driver(f.target, {}, req()), (e: Error) => { assert.doesNotMatch(e.stack ?? "", /PRIVATE_SENTINEL|auth\.json/); return true; });
    }
    const failed = makeGptLoginDriver({ provider: () => provider(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: { ...answer([]), stopReason: "error", errorMessage: "PRIVATE_SENTINEL_HTTP_BODY" } });
      stream.end(); return stream;
    }) });
    await assert.rejects(failed(f.target, {}, req()), { message: "gpt-login: model failed" });
    const incomplete = makeGptLoginDriver({ provider: () => provider(() => { const stream = createAssistantMessageEventStream(); stream.end(answer([tool], "toolUse")); return stream; }) });
    await assert.rejects(incomplete(f.target, {}, req()), /incomplete result/);
  } finally { await f.close(); }
});

test("missing/foreign result IDs and mutated in-run context fail before a model request", async () => {
  const f = await fixture();
  try {
    let sends = 0;
    const driver = makeGptLoginDriver({ provider: () => provider(() => { sends++; return completed(answer([{ type: "toolCall", id: "call_1", name: "list_agents", arguments: {} }], "toolUse")); }) });
    await assert.rejects(driver(f.target, {}, { ...req(), messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "wrong", content: "x" }] }] }), /invalid tool result/);
    assert.equal(sends, 0);
    const r = await driver(f.target, {}, req());
    r.content.push({ type: "text", text: "mutated" });
    await assert.rejects(driver(f.target, {}, { ...req(), messages: [{ role: "assistant", content: r.content }] }), /changed context/);
    assert.equal(sends, 1);
  } finally { await f.close(); }
});

test("real SDK normal refresh may exceed firstByte budget before model boundary and still succeeds within total", async () => {
  const f = await fixture(true);
  try {
    let refreshed = 0;
    const driver = makeGptLoginDriver({ provider: () => provider(() => completed(answer([{ type: "text", text: "及时" }])), {
      refresh: async (c) => { refreshed++; await delay(80); return { ...c, access: "FIXTURE_ROTATED", expires: Date.now() + 3_600_000 }; },
    }) });
    const r = await driver(f.target, { firstByteMs: 15, totalMs: 1500 }, req());
    assert.equal(r.content[0]?.type, "text"); assert.equal(refreshed, 1);
    const saved = JSON.parse(await readFile(f.file, "utf8"));
    assert.equal(saved.openai.access, "FIXTURE_ROTATED"); assert.deepEqual(saved.openai.opaque, { retained: true }); assert.deepEqual(saved.other, { unrelated: true });
  } finally { await f.close(); }
});

test("model cancel does not roll back a real SDK refresh already started; it still saves rotated credential without invoking model", async () => {
  const f = await fixture(true);
  try {
    const entered = gate(), finishRefresh = gate(), committed = gate();
    let modelCalls = 0;
    const driver = makeGptLoginDriver({ provider: () => provider(() => { modelCalls++; return completed(answer([{ type: "text", text: "must not run" }])); }, {
      refresh: async (c) => { entered.resolve(); await finishRefresh.promise; return { ...c, access: "FIXTURE_AFTER_CANCEL", expires: Date.now() + 3_600_000 }; },
      toAuth: async (c) => { committed.resolve(); return { apiKey: c.access }; },
    }) });
    const ac = new AbortController();
    const pending = driver(f.target, { firstByteMs: 10, totalMs: 1500 }, { ...req(), signal: ac.signal });
    await within(entered.promise); ac.abort();
    await assert.rejects(pending, /cancelled/);
    finishRefresh.resolve(); await within(committed.promise);
    assert.equal(JSON.parse(await readFile(f.file, "utf8")).openai.access, "FIXTURE_AFTER_CANCEL");
    assert.equal(modelCalls, 0);
  } finally { await f.close(); }
});

test("total deadline includes auth; first-content timeout and already-aborted requests do not return partial results", async () => {
  const f = await fixture(true);
  try {
    const entered = gate(), release = gate(), committed = gate();
    const driver = makeGptLoginDriver({ provider: () => provider(() => completed(answer([{ type: "text", text: "not reached" }])), {
      refresh: async (c) => { entered.resolve(); await release.promise; return { ...c, expires: Date.now() + 3_600_000 }; },
      toAuth: async (c) => { committed.resolve(); return { apiKey: c.access }; },
    }) });
    const pending = driver(f.target, { firstByteMs: 500, totalMs: 40 }, req());
    await within(entered.promise); await assert.rejects(pending, /timeout/);
    release.resolve(); await within(committed.promise);
    const silent = makeGptLoginDriver({ provider: () => provider(() => createAssistantMessageEventStream()) });
    await assert.rejects(silent(f.target, { firstByteMs: 15, totalMs: 1000 }, req()), /timeout/);
    const ac = new AbortController(); ac.abort();
    await assert.rejects(silent({ ...f.target, credentialsFile: join(f.dir, "never-created") }, {}, { ...req(), signal: ac.signal }), /cancelled/);
  } finally { await f.close(); }
});

function sse(events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
}
function wireResponse(toolRound: boolean) {
  const reasoning = { type: "reasoning", id: "rs_fixture", summary: [], encrypted_content: "FIXTURE_CIPHER" };
  const call = { type: "function_call", id: "fc_fixture", call_id: "call_fixture", name: "list_agents", arguments: '{"n":2}' };
  const text = { type: "message", id: "msg_fixture", role: "assistant", phase: "final_answer", status: "completed", content: [{ type: "output_text", text: "你好", annotations: [] }] };
  const output = toolRound ? [reasoning, call] : [text];
  const events: unknown[] = [{ type: "response.created", response: { id: "resp_fixture", model: "gpt-6-sol", status: "in_progress", output: [] } }];
  if (toolRound) {
    events.push({ type: "response.output_item.added", output_index: 0, item: reasoning }, { type: "response.output_item.done", output_index: 0, item: reasoning });
    events.push({ type: "response.output_item.added", output_index: 1, item: { ...call, arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 1, item_id: call.id, delta: call.arguments }, { type: "response.output_item.done", output_index: 1, item: call });
  } else {
    events.push({ type: "response.output_item.added", output_index: 0, item: { ...text, content: [] } },
      { type: "response.content_part.added", output_index: 0, item_id: text.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", output_index: 0, item_id: text.id, content_index: 0, delta: "你好" },
      { type: "response.output_item.done", output_index: 0, item: text });
  }
  events.push({ type: "response.completed", response: { id: "resp_fixture", model: "gpt-6-sol", status: "completed", output,
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } });
  return sse(events);
}

test("actual openaiProvider and Responses SDK with fake HTTP preserve rs/fc and function output, omit ChatGPT unsupported fields", async () => {
  const f = await fixture();
  try {
    const requests: any[] = [];
    const driver = makeGptLoginDriver({ fetch: async (url, init) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      const body = JSON.parse(String(init?.body)); requests.push(body);
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${f.credential.access}`);
      return wireResponse(requests.length === 1);
    } });
    const input = { ...req(), maxTokens: 1500, onText: (_d: string) => {} };
    const r1 = await driver(f.target, { firstByteMs: 5000 }, input);
    assert.equal(r1.content[0]?.type, "tool_use");
    const id = r1.content.find((b) => b.type === "tool_use")!;
    assert.ok(id.type === "tool_use"); assert.equal(id.id, "call_fixture|fc_fixture");
    input.messages.push({ role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: id.id, content: "two fixture agents" }] });
    const pieces: string[] = [];
    const r2 = await driver(f.target, {}, { ...input, onText: (d) => pieces.push(d) });
    assert.deepEqual(r2.content, [{ type: "text", text: "你好" }]); assert.deepEqual(pieces, ["你好"]);
    assert.equal(requests[0].max_output_tokens, undefined); assert.equal(requests[0].temperature, undefined); assert.equal(requests[0].store, false);
    // Pi's pinned gpt-6-sol model declares tools in a transcript additional_tools
    // item, not the top-level tools field. Assert the actual wire declaration in
    // both rounds so this cannot pass when the assistant's tools are dropped.
    for (const request of requests) {
      const declaration = request.input.find((i: any) => i.type === "additional_tools");
      assert.ok(declaration, "the SDK must declare tools in the request transcript");
      assert.equal(declaration.role, "developer");
      assert.equal(declaration.tools.length, 1);
      assert.equal(declaration.tools[0].type, "function");
      assert.equal(declaration.tools[0].name, TOOLS[0]!.name);
      assert.equal(declaration.tools[0].description, TOOLS[0]!.description);
      assert.deepEqual(declaration.tools[0].parameters, TOOLS[0]!.input_schema);
    }
    assert.ok(requests[1].input.some((i: any) => i.type === "reasoning" && i.encrypted_content === "FIXTURE_CIPHER"));
    assert.ok(requests[1].input.some((i: any) => i.type === "function_call" && i.id === "fc_fixture" && i.call_id === "call_fixture"));
    assert.ok(requests[1].input.some((i: any) => i.type === "function_call_output" && i.call_id === "call_fixture" && i.output === "two fixture agents"));
  } finally { await f.close(); }
});

test("makeLlm OAuth authentication failures cannot fall back to HTTP/another account or leak private paths", async (t) => {
  let network = 0; const logs: string[] = [];
  t.mock.method(globalThis, "fetch", async () => { network++; throw Error("unexpected network"); });
  const target: GptLoginTarget = { provider: "gpt-login", protocol: "pi-openai-oauth", baseUrl: "https://api.openai.com/v1", model: "gpt-6-sol", credentialsFile: "/tmp/pocket-nonexistent-fixture-auth-do-not-create.json" };
  await assert.rejects(makeLlm({ targets: [target, { provider: "other", protocol: "openai", model: "m", baseUrl: "https://other.invalid" }], log: (s) => logs.push(s) })(req()), /authentication failed/);
  assert.equal(network, 0); assert.doesNotMatch(logs.join(""), /auth-do-not-create|\/tmp\//);
});
