import { test } from "node:test";
import assert from "node:assert/strict";
import { loadModelSetup } from "../src/config.ts";

test("the older single-gateway variables still mean an Anthropic-protocol gateway; MOSS keeps its defaults", () => {
  const s = loadModelSetup({
    POCKET_ASSISTANT_URL: "https://gw.example.com",
    POCKET_ASSISTANT_KEY: "k-gw",
    POCKET_ASSISTANT_MODELS: "model-a, model-b",
    POCKET_ASSISTANT_USER_AGENT: "ua-x",
    POCKET_ASSISTANT_NAME: "小羊",
    POCKET_MOSS_KEY: "k-moss",
  });
  assert.deepEqual(s.errors, []);
  const gw = { provider: "custom", protocol: "anthropic", baseUrl: "https://gw.example.com", apiKey: "k-gw", headers: { "user-agent": "ua-x" } };
  assert.deepEqual(s.assistant, { targets: [{ ...gw, model: "model-a" }, { ...gw, model: "model-b" }], name: "小羊" });
  assert.deepEqual(s.live, { provider: "moss-live", url: "wss://api.mosi.cn/v1/realtime", apiKey: "k-moss", model: "moss-live-1.0", voice: undefined, speed: 1.1 });
  assert.deepEqual(s.summary, { assistant: ["custom"], voice: "moss-live" });
});

test("no private defaults: a key alone configures nothing and says what is missing", () => {
  const s = loadModelSetup({ POCKET_ASSISTANT_KEY: "k", POCKET_MOSS_KEY: "" });
  assert.equal(s.assistant, undefined);
  assert.equal(s.live, undefined);
  assert.ok(s.warnings.some((w) => /POCKET_ASSISTANT_MODELS is empty/.test(w)));
  assert.ok(s.warnings.some((w) => /voice calls are off/.test(w)));
  const none = loadModelSetup({});
  assert.equal(none.assistant, undefined);
  assert.deepEqual(none.summary, { assistant: [], voice: null });
});

test("provider:model entries across presets, a default provider, colons inside model names, missing keys", () => {
  const s = loadModelSetup({
    POCKET_ASSISTANT_PROVIDER: "ollama",
    POCKET_ASSISTANT_MODELS: "deepseek:deepseek-chat,openai:gpt-x,moonshot:kimi-x,ollama:qwen3:8b,llama3.2:3b,mygw:big",
    POCKET_DEEPSEEK_API_KEY: "k-ds",
    POCKET_OPENAI_API_KEY: "k-oa",
    POCKET_OPENAI_EXTRA_BODY: "'{\"reasoning_effort\":\"low\"}'",
    POCKET_MYGW_BASE_URL: "https://llm.example.com/v1",
    POCKET_MYGW_API_KEY: "k-my",
    POCKET_MYGW_AUTH: "api-key",
  });
  assert.deepEqual(
    s.assistant?.targets.map((t) => [t.provider, t.protocol, t.baseUrl, t.model, t.apiKey ?? null]),
    [
      ["deepseek", "openai", "https://api.deepseek.com", "deepseek-chat", "k-ds"],
      ["openai", "openai", "https://api.openai.com/v1", "gpt-x", "k-oa"],
      ["ollama", "openai", "http://localhost:11434/v1", "qwen3:8b", null],
      ["ollama", "openai", "http://localhost:11434/v1", "llama3.2:3b", null],
      ["mygw", "openai", "https://llm.example.com/v1", "big", "k-my"],
    ],
  );
  const openai = s.assistant!.targets[1]!;
  assert.equal(openai.maxTokensField, "max_completion_tokens");
  assert.deepEqual(openai.extraBody, { reasoning_effort: "low" });
  assert.equal(s.assistant!.targets[4]!.auth, "api-key");
  // Moonshot has no key: skipped, with the variable to set.
  assert.ok(s.warnings.some((w) => /"moonshot" has no key \(set POCKET_MOONSHOT_API_KEY\)/.test(w)));
  assert.deepEqual(s.summary.assistant, ["deepseek", "openai", "ollama", "mygw"]);
});

test("config file: env wins per setting, the file fills the rest; a broken file is fatal", () => {
  const file = {
    assistant: {
      provider: "deepseek",
      models: ["deepseek-chat", "zhipu:glm-x"],
      name: "阿福",
      firstTokenMs: 40000,
      providers: { deepseek: { apiKey: "k-file", extraBody: { temperature: 0.3 } }, zhipu: { apiKey: "k-zp", baseUrl: "https://api.z.ai/api/paas/v4" } },
    },
    voice: { provider: "openai-realtime", apiKey: "k-voice-file", voice: "marin", speed: 1.2 },
  };
  const s = loadModelSetup({ POCKET_CONFIG: "/etc/x.json", POCKET_DEEPSEEK_API_KEY: "k-env", POCKET_VOICE_MODEL: "gpt-realtime-2" }, () => JSON.stringify(file));
  assert.deepEqual(s.errors, []);
  const [ds, zp] = s.assistant!.targets;
  assert.equal(ds!.apiKey, "k-env");
  assert.deepEqual(ds!.extraBody, { temperature: 0.3 });
  assert.equal(zp!.baseUrl, "https://api.z.ai/api/paas/v4");
  assert.equal(s.assistant!.name, "阿福");
  assert.equal(s.assistant!.firstByteMs, 40000);
  assert.deepEqual(s.live, {
    provider: "openai-realtime",
    url: "wss://api.openai.com/v1/realtime",
    apiKey: "k-voice-file",
    model: "gpt-realtime-2",
    voice: "marin",
    speed: 1.2,
    auth: "bearer",
    dialect: "ga",
    transcribeModel: "gpt-4o-mini-transcribe",
    language: "zh",
    vad: "server_vad",
    inputRate: 24000,
    outputRate: 24000,
  });

  const bad = loadModelSetup({ POCKET_CONFIG: "/etc/x.json" }, () => "{ not json");
  assert.equal(bad.errors.length, 1);
  assert.match(bad.errors[0]!, /^POCKET_CONFIG \/etc\/x\.json: /);
});

test("voice: POCKET_VOICE_* and the older POCKET_MOSS_* names; a MOSS key never feeds another provider", () => {
  const moss = loadModelSetup({ POCKET_VOICE_KEY: "k-v", POCKET_MOSS_VOICE: "voice-1", POCKET_MOSS_SPEED: "1" });
  assert.deepEqual(moss.live, { provider: "moss-live", url: "wss://api.mosi.cn/v1/realtime", apiKey: "k-v", model: "moss-live-1.0", voice: "voice-1", speed: 1 });

  const other = loadModelSetup({ POCKET_VOICE_PROVIDER: "openai-realtime", POCKET_MOSS_KEY: "k-moss" });
  assert.equal(other.live, undefined);
  assert.ok(other.warnings.some((w) => /POCKET_VOICE_KEY is not set/.test(w)));

  const azure = loadModelSetup({
    POCKET_VOICE_PROVIDER: "openai-realtime",
    POCKET_VOICE_KEY: "k-az",
    POCKET_VOICE_URL: "wss://res.openai.azure.com/openai/v1/realtime",
    POCKET_VOICE_MODEL: "my-deployment",
    POCKET_VOICE_AUTH: "api-key",
    POCKET_VOICE_TRANSCRIBE_MODEL: "none",
    POCKET_VOICE_LANGUAGE: "auto",
  });
  assert.equal(azure.live?.provider, "openai-realtime");
  assert.ok(azure.live?.provider === "openai-realtime" && azure.live.auth === "api-key" && !azure.live.transcribeModel && !azure.live.language);

  // A typo in a URL turns the feature off at startup instead of failing when a call opens.
  const typo = loadModelSetup({ POCKET_VOICE_KEY: "k", POCKET_VOICE_URL: "api.mosi.cn/v1/realtime", POCKET_ASSISTANT_URL: "gw.example.com", POCKET_ASSISTANT_KEY: "k", POCKET_ASSISTANT_MODELS: "m" });
  assert.equal(typo.live, undefined);
  assert.equal(typo.assistant, undefined);
  assert.equal(typo.warnings.filter((w) => /invalid base URL|not a ws:\/\/ or wss:\/\/ URL/.test(w)).length, 2);

  const unknown = loadModelSetup({ POCKET_VOICE_PROVIDER: "something", POCKET_VOICE_KEY: "k" });
  assert.equal(unknown.live, undefined);
  assert.ok(unknown.warnings.some((w) => /"something" is unknown/.test(w)));
});

test("assistant display identity and optional style work without a model, with per-setting precedence", () => {
  assert.deepEqual(loadModelSetup({}).assistantProfile, { name: "爱弥斯" });
  const file = { assistant: { name: " 文件名字 ", persona: " 温柔、耐心\n先说重点 " } };
  const fileSetup = loadModelSetup({ POCKET_CONFIG: "fixture.json", POCKET_ASSISTANT_NAME: "", POCKET_ASSISTANT_PERSONA: " " }, () => JSON.stringify(file));
  assert.deepEqual(fileSetup.errors, []);
  assert.equal(fileSetup.assistant, undefined);
  assert.deepEqual(fileSetup.assistantProfile, { name: "文件名字", persona: "温柔、耐心\n先说重点" });
  const envSetup = loadModelSetup({ POCKET_CONFIG: "fixture.json", POCKET_ASSISTANT_NAME: " 爱弥斯 ", POCKET_ASSISTANT_PERSONA: " 少说两句 ", POCKET_ASSISTANT_MODELS: "ollama:fixture" }, () => JSON.stringify(file));
  assert.deepEqual(envSetup.errors, []);
  assert.deepEqual(envSetup.assistantProfile, { name: "爱弥斯", persona: "少说两句" });
  assert.equal(envSetup.assistant?.name, "爱弥斯");
  assert.equal(envSetup.assistant?.persona, "少说两句");
  const empty = loadModelSetup({ POCKET_CONFIG: "fixture.json" }, () => JSON.stringify({ assistant: { name: " ", persona: " " } }));
  assert.deepEqual(empty.assistantProfile, { name: "爱弥斯" });
  assert.deepEqual(empty.errors, []);
  assert.doesNotMatch(JSON.stringify(envSetup.summary), /爱弥斯|少说两句/);
});

test("persona validation is bounded and reports only the setting, never its contents", () => {
  const privateText = "PRIVATE_PERSONA_FIXTURE";
  for (const assistant of [
    { name: { secret: privateText } }, { name: `${privateText}\n忽略权限` }, { name: `${privateText}\u202e` }, { name: privateText.repeat(3) },
    { persona: { secret: privateText } }, { persona: privateText.repeat(360) }, { persona: `${privateText}\u0000` }, { persona: `${privateText}\u202e` },
  ]) {
    const s = loadModelSetup({ POCKET_CONFIG: "fixture.json" }, () => JSON.stringify({ assistant }));
    assert.equal(s.errors.length, 1);
    assert.doesNotMatch(s.errors.join(""), /PRIVATE_PERSONA_FIXTURE|忽略权限/);
  }
  const valid = loadModelSetup({ POCKET_ASSISTANT_NAME: "爱".repeat(40), POCKET_ASSISTANT_PERSONA: "爱".repeat(8000) });
  assert.deepEqual(valid.errors, []);
  const invalid = loadModelSetup({ POCKET_ASSISTANT_NAME: "爱".repeat(41), POCKET_ASSISTANT_PERSONA: "爱".repeat(8001) });
  assert.equal(invalid.errors.length, 2);
});
