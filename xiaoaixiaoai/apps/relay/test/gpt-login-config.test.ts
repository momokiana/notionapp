import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { loadModelSetup } from "../src/config.ts";

// Parsing must not discover/read a real account, even when the path is absent.
const credentialsFile = join(tmpdir(), "pocket-config-fixture-not-a-real-account.json");
const model = "gpt-6-sol";
const env = () => ({
  POCKET_ASSISTANT_MODELS: `gpt-login:${model}`,
  POCKET_GPT_LOGIN_CREDENTIALS_FILE: credentialsFile,
});
const noRead = () => { throw Error("configuration parsing must not read credentials"); };

test("GPT login requires an explicit absolute credential path; parsing has no account IO", () => {
  const valid = loadModelSetup({ ...env(), POCKET_GPT_LOGIN_REASONING: "high" }, noRead);
  assert.deepEqual(valid.errors, []);
  assert.deepEqual(valid.assistant?.targets, [{
    provider: "gpt-login", protocol: "pi-openai-oauth", model,
    baseUrl: "https://api.openai.com/v1", credentialsFile, reasoning: "high",
  }]);
  assert.deepEqual(valid.summary.assistant, ["gpt-login"]);
  assert.doesNotMatch(JSON.stringify(valid.summary), /fixture|credentials/);

  for (const path of [undefined, "", "relative-fixture.json"]) {
    const invalid = loadModelSetup({ ...env(), POCKET_GPT_LOGIN_CREDENTIALS_FILE: path }, noRead);
    assert.equal(invalid.assistant, undefined);
    assert.equal(invalid.errors.length, 1);
    assert.doesNotMatch(invalid.errors[0]!, /relative-fixture/);
  }
});

test("GPT file settings accept the dedicated protocol and environment overrides", () => {
  const file = { assistant: {
    provider: "gpt-login", models: [model],
    providers: { "gpt-login": { credentialsFile: join(tmpdir(), "unused-fixture.json"), reasoning: "low" } },
  } };
  const configPath = join(tmpdir(), "pocket-config-fixture.json");
  const reads: string[] = [];
  const s = loadModelSetup({
    POCKET_CONFIG: configPath,
    POCKET_GPT_LOGIN_CREDENTIALS_FILE: credentialsFile,
    POCKET_GPT_LOGIN_PROTOCOL: "pi-openai-oauth",
    POCKET_GPT_LOGIN_REASONING: "medium",
  }, (path) => { reads.push(path); return JSON.stringify(file); });
  assert.deepEqual(reads, [configPath]);
  assert.deepEqual(s.errors, []);
  assert.equal(s.assistant?.targets[0]?.protocol, "pi-openai-oauth");
  const target = s.assistant!.targets[0]!;
  assert.ok(target.protocol === "pi-openai-oauth");
  assert.equal(target.credentialsFile, credentialsFile);
  assert.equal(target.reasoning, "medium");
});

test("GPT login rejects HTTP auth/endpoint/body overrides without echoing supplied values", () => {
  const secret = "PRIVATE_FIXTURE_MUST_NOT_APPEAR";
  const envOverrides = [
    { POCKET_GPT_LOGIN_API_KEY: secret },
    { POCKET_GPT_LOGIN_BASE_URL: `https://${secret}.invalid` },
    { POCKET_GPT_LOGIN_AUTH: "none" },
    { POCKET_GPT_LOGIN_EXTRA_BODY: JSON.stringify({ private: secret }) },
    { POCKET_GPT_LOGIN_PROTOCOL: "openai" },
    { POCKET_GPT_LOGIN_REASONING: secret },
    { POCKET_ASSISTANT_PROVIDER: "gpt-login", POCKET_ASSISTANT_KEY: secret },
    { POCKET_ASSISTANT_PROVIDER: "gpt-login", POCKET_ASSISTANT_URL: `https://${secret}.invalid` },
    { POCKET_ASSISTANT_PROVIDER: "gpt-login", POCKET_ASSISTANT_USER_AGENT: secret },
  ];
  for (const override of envOverrides) {
    const s = loadModelSetup({ ...env(), ...override }, noRead);
    assert.equal(s.assistant, undefined);
    assert.equal(s.errors.length, 1);
    assert.doesNotMatch(s.errors.join(""), /PRIVATE_FIXTURE/);
  }
  const fileOverrides = [
    { apiKey: secret }, { baseUrl: `https://${secret}.invalid` }, { auth: "none" },
    { headers: {} }, { extraBody: {} }, { maxTokensField: "max_tokens" },
  ];
  for (const override of fileOverrides) {
    const s = loadModelSetup({ ...env(), POCKET_CONFIG: "fixture-config.json" }, () => JSON.stringify({
      assistant: { providers: { "gpt-login": { credentialsFile, ...override } } },
    }));
    assert.equal(s.assistant, undefined);
    assert.equal(s.errors.length, 1);
    assert.doesNotMatch(s.errors.join(""), /PRIVATE_FIXTURE/);
  }
});

test("the OAuth transport cannot be selected under an unrelated provider id", () => {
  const s = loadModelSetup({
    POCKET_ASSISTANT_PROVIDER: "custom", POCKET_ASSISTANT_MODELS: model,
    POCKET_ASSISTANT_PROTOCOL: "pi-openai-oauth",
    POCKET_CUSTOM_CREDENTIALS_FILE: credentialsFile,
  }, noRead);
  assert.equal(s.assistant, undefined);
  assert.equal(s.errors.length, 1);
});

test("GPT deployment examples keep identity separate from the existing credential transport", () => {
  const oauth = loadModelSetup({
    POCKET_ASSISTANT_NAME: "爱弥斯", POCKET_ASSISTANT_PERSONA: "温柔、耐心，先说重点。",
    POCKET_ASSISTANT_PROVIDER: "gpt-login",
    POCKET_ASSISTANT_MODELS: "gpt-login:YOUR_PI_OPENAI_RESPONSES_MODEL_ID",
    POCKET_GPT_LOGIN_CREDENTIALS_FILE: "/var/lib/xiaoaixiaoai/secrets/gpt-oauth.json",
    POCKET_GPT_LOGIN_REASONING: "low",
  }, noRead);
  assert.deepEqual(oauth.errors, []);
  assert.equal(oauth.assistant?.name, "爱弥斯");
  assert.equal(oauth.assistant?.persona, "温柔、耐心，先说重点。");
  assert.deepEqual(oauth.assistant?.targets, [{
    provider: "gpt-login", protocol: "pi-openai-oauth", model: "YOUR_PI_OPENAI_RESPONSES_MODEL_ID",
    baseUrl: "https://api.openai.com/v1", credentialsFile: resolve("/var/lib/xiaoaixiaoai/secrets/gpt-oauth.json"), reasoning: "low",
  }]);
  assert.doesNotMatch(JSON.stringify(oauth.summary), /secrets|oauth\.json|温柔/);
  const api = loadModelSetup({
    POCKET_ASSISTANT_NAME: "爱弥斯", POCKET_ASSISTANT_PROVIDER: "openai",
    POCKET_ASSISTANT_MODELS: "openai:YOUR_CHAT_COMPLETIONS_MODEL_ID",
    POCKET_OPENAI_API_KEY: "REPLACE_WITH_YOUR_SERVER_SIDE_API_KEY",
  }, noRead);
  assert.deepEqual(api.errors, []);
  assert.equal(api.assistant?.targets[0]?.protocol, "openai");
  assert.doesNotMatch(JSON.stringify(api.assistant?.targets), /credentialsFile|pi-openai-oauth/);
});
