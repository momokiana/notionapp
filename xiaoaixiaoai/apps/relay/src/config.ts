/**
 * Text-model and voice settings, from the environment and an optional JSON
 * file (POCKET_CONFIG). A setting given in both places takes the environment's
 * value; an empty variable counts as unset. docs/config.md describes every key.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import type { AuthStyle, LlmProvider, LlmTarget, Protocol } from "./assistant/llm.ts";
import type { LiveConfig } from "./assistant/live.ts";
import { MOSS_DEFAULTS, REALTIME_DEFAULTS, TEXT_PRESETS, VOICE_PROVIDERS, type VoiceProvider } from "./assistant/providers.ts";
import { DEFAULT_TIME_ZONE, validTimeZone } from "./assistant/timezone.ts";
import { DEFAULT_ASSISTANT_NAME, type AssistantProfile } from "./assistant/persona.ts";

export interface AssistantSetup {
  targets: LlmTarget[];
  name?: string;
  persona?: string;
  firstByteMs?: number;
}

export interface ModelSetup {
  assistant?: AssistantSetup;
  /** Identity still applies when no text model is configured. Never sent as a credential. */
  assistantProfile: AssistantProfile;
  live?: LiveConfig;
  /** IANA zone the assistant tells and takes times in. */
  timeZone: string;
  /** Not fatal: something is off or incomplete. */
  warnings: string[];
  /** Fatal: the relay should not start like this. */
  errors: string[];
  /** Provider ids for logs and health; never keys or URLs. */
  summary: { assistant: string[]; voice: VoiceProvider | null };
}

interface FileProvider {
  credentialsFile?: string;
  reasoning?: string;
  protocol?: string;
  baseUrl?: string;
  apiKey?: string;
  auth?: string;
  headers?: Record<string, string>;
  maxTokensField?: string;
  extraBody?: Record<string, unknown>;
}

interface FileConfig {
  timeZone?: string;
  assistant?: {
    name?: string;
    persona?: string;
    provider?: string;
    models?: string[] | string;
    apiKey?: string;
    url?: string;
    protocol?: string;
    userAgent?: string;
    firstTokenMs?: number;
    providers?: Record<string, FileProvider>;
  };
  voice?: {
    provider?: string;
    apiKey?: string;
    url?: string;
    model?: string;
    voice?: string;
    speed?: number;
    auth?: string;
    dialect?: string;
    transcribeModel?: string;
    language?: string;
    vad?: string;
    inputRate?: number;
    outputRate?: number;
  };
}

type Env = Record<string, string | undefined>;

/** Words already used by other POCKET_* settings; a provider cannot take them as its id. */
const RESERVED = new Set(["assistant", "voice", "moss", "admin", "public", "trust", "port", "host", "db", "config"]);
const PROTOCOLS: Protocol[] = ["anthropic", "openai"];
const AUTHS: AuthStyle[] = ["bearer", "x-api-key", "api-key", "none"];

export function loadModelSetup(env: Env, read: (path: string) => string = (p) => readFileSync(p, "utf8")): ModelSetup {
  const out: ModelSetup = { assistantProfile: { name: DEFAULT_ASSISTANT_NAME }, timeZone: DEFAULT_TIME_ZONE, warnings: [], errors: [], summary: { assistant: [], voice: null } };
  const e = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  let file: FileConfig = {};
  const path = e("POCKET_CONFIG");
  if (path) {
    try {
      file = JSON.parse(read(path)) as FileConfig;
      if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("not a JSON object");
    } catch (err) {
      out.errors.push(`POCKET_CONFIG ${path}: ${(err as Error).message}`);
      return out;
    }
  }
  const zone = e("POCKET_TIMEZONE") ?? file.timeZone;
  if (zone) {
    const z = validTimeZone(zone);
    if (z) out.timeZone = z;
    else out.warnings.push(`POCKET_TIMEZONE "${zone}" is not a time zone this system knows (use an IANA name such as Europe/Berlin); using ${DEFAULT_TIME_ZONE}.`);
  }
  assistantProfile(e, file, out);
  assistantSetup(e, file, out);
  voiceSetup(e, file, out);
  return out;
}

const envId = (id: string) => `POCKET_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_`;

/** A URL the relay can open later: checked now, so a typo turns a feature off instead of failing mid-call. */
function urlOk(u: string, schemes: string[]): boolean {
  try {
    return schemes.includes(new URL(u).protocol);
  } catch {
    return false;
  }
}

/** Style is bounded material, not a configurable system prompt or an authorization source. */
function assistantProfile(e: (n: string) => string | undefined, file: FileConfig, out: ModelSetup): void {
  const name: unknown = e("POCKET_ASSISTANT_NAME") ?? file.assistant?.name;
  const persona: unknown = e("POCKET_ASSISTANT_PERSONA") ?? file.assistant?.persona;
  if (name !== undefined) {
    if (typeof name !== "string" || Array.from(name.trim()).length > 40 || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) {
      out.errors.push("POCKET_ASSISTANT_NAME / assistant.name must be single-line text of at most 40 characters, without control or format characters.");
    } else if (name.trim()) out.assistantProfile.name = name.trim();
  }
  if (persona !== undefined) {
    if (typeof persona !== "string" || Array.from(persona.trim()).length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/u.test(persona)) {
      out.errors.push("POCKET_ASSISTANT_PERSONA / assistant.persona must be text of at most 2000 characters, without control or format characters (except line breaks and tabs).");
    } else if (persona.trim()) out.assistantProfile.persona = persona.trim();
  }
}

function assistantSetup(e: (n: string) => string | undefined, file: FileConfig, out: ModelSetup): void {
  const fa = file.assistant ?? {};
  const fileProviders = fa.providers ?? {};
  const fallback = (e("POCKET_ASSISTANT_PROVIDER") ?? fa.provider ?? "custom").toLowerCase();
  const rawModels = e("POCKET_ASSISTANT_MODELS") ?? fa.models;
  const entries = (Array.isArray(rawModels) ? rawModels : (rawModels ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  const known = (id: string) => id in TEXT_PRESETS || id === "custom" || id === "gpt-login" || id in fileProviders || !!e(`${envId(id)}BASE_URL`);

  const resolved = new Map<string, LlmProvider | null>();
  const resolve = (id: string): LlmProvider | null => {
    if (resolved.has(id)) return resolved.get(id)!;
    const r = provider(id);
    resolved.set(id, r);
    return r;
  };
  const provider = (id: string): LlmProvider | null => {
    if (!/^[a-z][a-z0-9-]*$/.test(id) || RESERVED.has(id)) {
      out.warnings.push(`assistant: "${id}" cannot be a provider id; its models are skipped.`);
      return null;
    }
    const preset = TEXT_PRESETS[id];
    const fp = fileProviders[id] ?? {};
    const P = envId(id);
    const isDefault = id === fallback;
    const apiKey = e(`${P}API_KEY`) ?? (isDefault ? e("POCKET_ASSISTANT_KEY") : undefined) ?? fp.apiKey ?? (isDefault ? fa.apiKey : undefined);
    const baseUrl = e(`${P}BASE_URL`) ?? (isDefault ? e("POCKET_ASSISTANT_URL") : undefined) ?? fp.baseUrl ?? (isDefault ? fa.url : undefined) ?? preset?.baseUrl;
    // `custom` stays on the Anthropic protocol unless told otherwise: that is what POCKET_ASSISTANT_URL always meant.
    const protocol = (e(`${P}PROTOCOL`) ?? (isDefault ? e("POCKET_ASSISTANT_PROTOCOL") : undefined) ?? fp.protocol ?? (isDefault ? fa.protocol : undefined) ?? preset?.protocol ?? (id === "gpt-login" ? "pi-openai-oauth" : id === "custom" ? "anthropic" : "openai")).toLowerCase();
    if (id === "gpt-login" || protocol === "pi-openai-oauth") {
      const fail = () => { out.errors.push("assistant: gpt-login needs its explicit absolute credentialsFile and only OAuth transport settings."); return null; };
      const credentialsFile = e(`${P}CREDENTIALS_FILE`) ?? fp.credentialsFile;
      const reasoning = e(`${P}REASONING`) ?? fp.reasoning;
      if (id !== "gpt-login" || protocol !== "pi-openai-oauth" || typeof credentialsFile !== "string" || !isAbsolute(credentialsFile) ||
          apiKey || baseUrl || e(`${P}AUTH`) || fp.auth || fp.headers !== undefined || fp.extraBody !== undefined || e(`${P}EXTRA_BODY`) ||
          fp.maxTokensField !== undefined || (isDefault && (e("POCKET_ASSISTANT_USER_AGENT") || fa.userAgent))) return fail();
      if (reasoning !== undefined && !["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoning)) return fail();
      return { provider: id, protocol: "pi-openai-oauth", baseUrl: "https://api.openai.com/v1", credentialsFile: resolvePath(credentialsFile),
        ...(reasoning ? { reasoning: reasoning as ThinkingLevel } : {}) };
    }
    const auth = (e(`${P}AUTH`) ?? fp.auth)?.toLowerCase();
    let extraBody = fp.extraBody;
    const extraEnv = e(`${P}EXTRA_BODY`);
    if (extraEnv) {
      try {
        // Some env-file readers keep the quotes the example puts around JSON.
        extraBody = JSON.parse(/^'.*'$/s.test(extraEnv) ? extraEnv.slice(1, -1) : extraEnv);
      } catch {
        out.warnings.push(`${P}EXTRA_BODY is not valid JSON; ignored.`);
      }
    }
    if (!PROTOCOLS.includes(protocol as Protocol)) {
      out.warnings.push(`assistant: provider "${id}" has an unknown protocol "${protocol}" (anthropic or openai); its models are skipped.`);
      return null;
    }
    if (auth && !AUTHS.includes(auth as AuthStyle)) {
      out.warnings.push(`assistant: provider "${id}" has an unknown auth "${auth}" (${AUTHS.join(", ")}); its models are skipped.`);
      return null;
    }
    if (!baseUrl) {
      const hint = id === "custom" ? ", or name a provider: POCKET_ASSISTANT_PROVIDER=deepseek or a prefix such as deepseek:deepseek-chat" : "";
      out.warnings.push(`assistant: provider "${id}" has no base URL (set ${isDefault ? "POCKET_ASSISTANT_URL or " : ""}${P}BASE_URL${hint}); its models are skipped.`);
      return null;
    }
    if (!urlOk(baseUrl, ["http:", "https:"])) {
      out.warnings.push(`assistant: provider "${id}" has an invalid base URL "${baseUrl}"; its models are skipped.`);
      return null;
    }
    if (!apiKey && !preset?.keyless && auth !== "none") {
      out.warnings.push(`assistant: provider "${id}" has no key (set ${isDefault ? "POCKET_ASSISTANT_KEY or " : ""}${P}API_KEY); its models are skipped.`);
      return null;
    }
    const ua = e("POCKET_ASSISTANT_USER_AGENT") ?? fa.userAgent;
    const headers = { ...(ua ? { "user-agent": ua } : {}), ...fp.headers };
    const field = fp.maxTokensField ?? preset?.maxTokensField;
    return {
      provider: id,
      protocol: protocol as "anthropic" | "openai",
      baseUrl,
      apiKey,
      ...(auth ? { auth: auth as AuthStyle } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(field === "max_tokens" || field === "max_completion_tokens" ? { maxTokensField: field } : {}),
      ...(extraBody && typeof extraBody === "object" ? { extraBody } : {}),
    };
  };

  const targets: LlmTarget[] = [];
  for (const entry of entries) {
    // "provider:model" when the part before the first colon names a provider; otherwise a model of the default provider
    // (so "ollama:qwen3:8b" and a bare "qwen3:8b" both work).
    const colon = entry.indexOf(":");
    const head = colon > 0 ? entry.slice(0, colon).toLowerCase() : "";
    const [id, model] = head && known(head) ? [head, entry.slice(colon + 1).trim()] : [fallback, entry];
    if (!model) continue;
    const p = resolve(id);
    if (p) targets.push({ ...p, model });
  }

  if (!entries.length) {
    const hinted = e("POCKET_ASSISTANT_KEY") || e("POCKET_ASSISTANT_URL") || Object.keys(TEXT_PRESETS).some((id) => e(`${envId(id)}API_KEY`)) || file.assistant;
    if (hinted) out.warnings.push("POCKET_ASSISTANT_MODELS is empty: list the models to use, e.g. deepseek:deepseek-chat.");
  }
  if (!targets.length) {
    out.warnings.push("No text model is configured: the assistant can only explain that it is not set up.");
    return;
  }
  const firstMs = Number(e("POCKET_ASSISTANT_FIRST_TOKEN_MS") ?? fa.firstTokenMs);
  out.assistant = {
    targets,
    ...out.assistantProfile,
    ...(firstMs > 0 ? { firstByteMs: firstMs } : {}),
  };
  out.summary.assistant = [...new Set(targets.map((t) => t.provider))];
}

function voiceSetup(e: (n: string) => string | undefined, file: FileConfig, out: ModelSetup): void {
  const fv = file.voice ?? {};
  const provider = (e("POCKET_VOICE_PROVIDER") ?? fv.provider ?? "moss-live").toLowerCase();
  if (!VOICE_PROVIDERS.includes(provider as VoiceProvider)) {
    out.warnings.push(`POCKET_VOICE_PROVIDER "${provider}" is unknown (${VOICE_PROVIDERS.join(" or ")}): voice calls are off.`);
    return;
  }
  const num = (v: string | number | undefined) => (v === undefined || v === "" ? undefined : Number(v));
  if (provider === "moss-live") {
    // POCKET_MOSS_* are the older names of the same settings.
    const v = (name: string) => e(`POCKET_VOICE_${name}`) ?? e(`POCKET_MOSS_${name}`);
    const apiKey = v("KEY") ?? fv.apiKey;
    if (!apiKey) {
      out.warnings.push("POCKET_VOICE_KEY (or POCKET_MOSS_KEY) is not set: voice calls are off.");
      return;
    }
    const url = v("URL") ?? fv.url ?? MOSS_DEFAULTS.url;
    if (!urlOk(url, ["ws:", "wss:"])) {
      out.warnings.push(`POCKET_VOICE_URL "${url}" is not a ws:// or wss:// URL: voice calls are off.`);
      return;
    }
    out.live = {
      provider: "moss-live",
      url,
      apiKey,
      model: v("MODEL") ?? fv.model ?? MOSS_DEFAULTS.model,
      voice: v("VOICE") ?? fv.voice,
      // A touch faster than normal reads as less drawn out; 1 turns it off.
      speed: num(v("SPEED") ?? fv.speed) || MOSS_DEFAULTS.speed,
    };
    out.summary.voice = "moss-live";
    return;
  }
  const v = (name: string) => e(`POCKET_VOICE_${name}`);
  const apiKey = v("KEY") ?? fv.apiKey;
  if (!apiKey) {
    out.warnings.push("POCKET_VOICE_KEY is not set: voice calls are off.");
    return;
  }
  const dialect = (v("DIALECT") ?? fv.dialect ?? "ga").toLowerCase();
  const auth = (v("AUTH") ?? fv.auth ?? "bearer").toLowerCase();
  const vad = (v("VAD") ?? fv.vad ?? "server_vad").toLowerCase();
  if (dialect !== "ga" && dialect !== "beta") out.warnings.push(`POCKET_VOICE_DIALECT "${dialect}" is unknown; using ga.`);
  if (auth !== "bearer" && auth !== "api-key") out.warnings.push(`POCKET_VOICE_AUTH "${auth}" is unknown; using bearer.`);
  if (vad !== "server_vad" && vad !== "semantic_vad") out.warnings.push(`POCKET_VOICE_VAD "${vad}" is unknown; using server_vad.`);
  const beta = dialect === "beta";
  const transcribe = v("TRANSCRIBE_MODEL") ?? fv.transcribeModel ?? (beta ? undefined : REALTIME_DEFAULTS.transcribeModel);
  const language = v("LANGUAGE") ?? fv.language ?? "zh";
  const speed = num(v("SPEED") ?? fv.speed);
  const url = v("URL") ?? fv.url ?? REALTIME_DEFAULTS.url;
  if (!urlOk(url, ["ws:", "wss:"])) {
    out.warnings.push(`POCKET_VOICE_URL "${url}" is not a ws:// or wss:// URL: voice calls are off.`);
    return;
  }
  out.live = {
    provider: "openai-realtime",
    url,
    apiKey,
    model: v("MODEL") ?? fv.model ?? REALTIME_DEFAULTS.model,
    voice: v("VOICE") ?? fv.voice,
    ...(speed && speed > 0 ? { speed } : {}),
    auth: auth === "api-key" ? "api-key" : "bearer",
    dialect: beta ? "beta" : "ga",
    ...(transcribe && transcribe !== "none" ? { transcribeModel: transcribe } : {}),
    ...(language !== "auto" ? { language } : {}),
    vad: vad === "semantic_vad" ? "semantic_vad" : "server_vad",
    inputRate: num(v("INPUT_RATE") ?? fv.inputRate) || REALTIME_DEFAULTS.rate,
    outputRate: num(v("OUTPUT_RATE") ?? fv.outputRate) || REALTIME_DEFAULTS.rate,
  };
  out.summary.voice = "openai-realtime";
}
