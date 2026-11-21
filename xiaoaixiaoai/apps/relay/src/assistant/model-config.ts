/**
 * Runtime text-model & provider overrides persisted in SQLite (`settings` table).
 * Env / POCKET_CONFIG targets stay the fallback baseline; admin console changes
 * apply immediately via `Assistant.setModelRuntime()` without restarting the
 * relay, and can be reverted cleanly with `reset()`. API keys are never returned
 * in full to clients—only masked tails (`…xxxx`).
 */
import type { Store } from "../store.ts";
import { redact } from "../eventlog.ts";
import type { AuthStyle, GptLoginTarget, HttpLlmTarget, LlmTarget } from "./llm.ts";
import { TEXT_PRESETS } from "./providers.ts";

const SETTING_MODELS = "assistant.models.override";
const RESERVED_IDS = new Set(["assistant", "voice", "moss", "admin", "public", "trust", "port", "host", "db", "config", "gpt-login"]);

export interface StoredProviderOverride {
  label?: string;
  protocol: "anthropic" | "openai";
  baseUrl: string;
  apiKey?: string;
  auth?: AuthStyle;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

export interface ModelOrderItem {
  provider: string;
  model: string;
}

interface StoredModelOverride {
  rev: number;
  updatedAt: number;
  updatedBy: string;
  providers: Record<string, StoredProviderOverride>;
  order?: ModelOrderItem[];
}

export interface ProviderSummary {
  id: string;
  label: string;
  protocol: "anthropic" | "openai" | "pi-openai-oauth";
  baseUrl: string;
  maskedKey: string;
  hasKey: boolean;
  source: "server" | "console" | "preset";
  overridden: boolean;
  readOnly: boolean;
  auth?: AuthStyle;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

export interface ModelConfigView {
  modified: boolean;
  rev: number;
  updatedAt: number | null;
  updatedBy: string | null;
  providers: ProviderSummary[];
  order: Array<{
    index: number;
    provider: string;
    model: string;
    protocol: string;
    endpointHost: string;
    isPrimary: boolean;
  }>;
  presets: Array<{ id: string; label: string; protocol: "anthropic" | "openai"; baseUrl: string }>;
}

type ServerProviderEntry =
  | {
      kind: "http";
      id: string;
      protocol: "anthropic" | "openai";
      baseUrl: string;
      apiKey?: string;
      auth?: AuthStyle;
      headers?: Record<string, string>;
      maxTokensField?: "max_tokens" | "max_completion_tokens";
      extraBody?: Record<string, unknown>;
    }
  | {
      kind: "oauth";
      id: string;
      target: GptLoginTarget;
    };

function maskSecret(key: string | undefined): string {
  const k = (key ?? "").trim();
  if (!k) return "";
  if (k.length <= 4) return "••••";
  return `…${k.slice(-4)}`;
}

function validUrl(u: string): string {
  const trimmed = u.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Base URL 格式不正确");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Base URL 只支持 http:// 或 https://");
  }
  return trimmed;
}

function hostOf(u: string): string {
  try {
    return new URL(u).host;
  } catch {
    return "";
  }
}

export class ModelConfigService {
  private store: Store;
  private serverTargets: LlmTarget[];
  private serverProviders = new Map<string, ServerProviderEntry>();
  private now: () => number;

  constructor(store: Store, serverTargets: LlmTarget[] = [], now: () => number = () => Date.now()) {
    this.store = store;
    this.serverTargets = [...serverTargets];
    this.now = now;
    for (const t of serverTargets) {
      if (this.serverProviders.has(t.provider)) continue;
      if (t.protocol === "pi-openai-oauth") {
        this.serverProviders.set(t.provider, { kind: "oauth", id: t.provider, target: { ...t } });
      } else {
        this.serverProviders.set(t.provider, {
          kind: "http",
          id: t.provider,
          protocol: t.protocol,
          baseUrl: t.baseUrl,
          apiKey: t.apiKey,
          auth: t.auth,
          headers: t.headers ? { ...t.headers } : undefined,
          maxTokensField: t.maxTokensField,
          extraBody: t.extraBody ? { ...t.extraBody } : undefined,
        });
      }
    }
  }

  private loadSaved(): StoredModelOverride | null {
    const raw = this.store.getSetting<Partial<StoredModelOverride>>(SETTING_MODELS);
    if (!raw || typeof raw !== "object") return null;
    return {
      rev: typeof raw.rev === "number" ? raw.rev : 1,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : this.now(),
      updatedBy: typeof raw.updatedBy === "string" ? raw.updatedBy : "admin",
      providers: raw.providers && typeof raw.providers === "object" ? raw.providers : {},
      order: Array.isArray(raw.order) ? raw.order : undefined,
    };
  }

  private save(next: StoredModelOverride): void {
    this.store.putSetting(SETTING_MODELS, next);
  }

  private resolveProvider(id: string, saved: StoredModelOverride | null): ServerProviderEntry | null {
    const srv = this.serverProviders.get(id);
    if (srv?.kind === "oauth") return srv;
    const ov = saved?.providers[id];
    if (ov) {
      return {
        kind: "http",
        id,
        protocol: ov.protocol,
        baseUrl: ov.baseUrl,
        apiKey: ov.apiKey !== undefined && ov.apiKey !== "" ? ov.apiKey : (srv?.kind === "http" ? srv.apiKey : undefined),
        auth: ov.auth ?? (srv?.kind === "http" ? srv.auth : undefined),
        headers: srv?.kind === "http" ? srv.headers : undefined,
        maxTokensField: ov.maxTokensField ?? (srv?.kind === "http" ? srv.maxTokensField : undefined),
        extraBody: srv?.kind === "http" ? srv.extraBody : undefined,
      };
    }
    return srv ?? null;
  }

  /** Returns active ordered `LlmTarget[]` for runtime LLM calls & probes. */
  targets(): LlmTarget[] {
    const saved = this.loadSaved();
    const order = saved?.order ?? this.serverTargets.map((t) => ({ provider: t.provider, model: t.model }));
    const out: LlmTarget[] = [];
    for (const item of order) {
      const p = this.resolveProvider(item.provider, saved);
      if (!p) continue;
      if (p.kind === "oauth") {
        out.push({ ...p.target, model: item.model });
      } else {
        const t: HttpLlmTarget = {
          provider: p.id,
          protocol: p.protocol,
          baseUrl: p.baseUrl,
          model: item.model,
          ...(p.apiKey ? { apiKey: p.apiKey } : {}),
          ...(p.auth ? { auth: p.auth } : {}),
          ...(p.headers ? { headers: p.headers } : {}),
          ...(p.maxTokensField ? { maxTokensField: p.maxTokensField } : {}),
          ...(p.extraBody ? { extraBody: p.extraBody } : {}),
        };
        out.push(t);
      }
    }
    return out;
  }

  /** Safe redacted view for `/admin` and admin API responses (never returns raw keys). */
  view(): ModelConfigView {
    const saved = this.loadSaved();
    const ids = new Set<string>([...this.serverProviders.keys(), ...Object.keys(saved?.providers ?? {})]);
    const providers: ProviderSummary[] = [];
    for (const id of ids) {
      const srv = this.serverProviders.get(id);
      const ov = saved?.providers[id];
      const resolved = this.resolveProvider(id, saved);
      if (!resolved) continue;
      if (resolved.kind === "oauth") {
        providers.push({
          id,
          label: "OpenAI GPT OAuth",
          protocol: "pi-openai-oauth",
          baseUrl: resolved.target.baseUrl,
          maskedKey: "OAuth",
          hasKey: true,
          source: "server",
          overridden: false,
          readOnly: true,
        });
      } else {
        const key = resolved.apiKey;
        providers.push({
          id,
          label: ov?.label ?? TEXT_PRESETS[id]?.label ?? id,
          protocol: resolved.protocol,
          baseUrl: resolved.baseUrl,
          maskedKey: maskSecret(key),
          hasKey: Boolean(key || resolved.auth === "none" || TEXT_PRESETS[id]?.keyless),
          source: srv ? "server" : "console",
          overridden: Boolean(ov),
          readOnly: false,
          auth: resolved.auth,
          maxTokensField: resolved.maxTokensField,
        });
      }
    }
    const activeTargets = this.targets();
    return {
      modified: Boolean(saved && (Object.keys(saved.providers).length > 0 || saved.order !== undefined)),
      rev: saved?.rev ?? 0,
      updatedAt: saved?.updatedAt ?? null,
      updatedBy: saved?.updatedBy ?? null,
      providers,
      order: activeTargets.map((t, idx) => ({
        index: idx + 1,
        provider: t.provider,
        model: t.model,
        protocol: t.protocol,
        endpointHost: hostOf(t.baseUrl),
        isPrimary: idx === 0,
      })),
      presets: Object.entries(TEXT_PRESETS).map(([id, p]) => ({
        id,
        label: p.label,
        protocol: (p.protocol === "anthropic" ? "anthropic" : "openai") as "anthropic" | "openai",
        baseUrl: p.baseUrl,
      })),
    };
  }

  /** Creates or updates a provider override in SQLite (empty `apiKey` preserves existing key). */
  upsertProvider(
    input: {
      id: string;
      label?: string;
      protocol: string;
      baseUrl: string;
      apiKey?: string;
      auth?: string;
      maxTokensField?: string;
    },
    by: string,
  ): ModelConfigView {
    const id = String(input.id ?? "").trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(id) || RESERVED_IDS.has(id)) {
      throw new Error("服务商 ID 需为小写字母开头（仅限 a-z、0-9、-，且不能用保留字）");
    }
    const existingSrv = this.serverProviders.get(id);
    if (existingSrv?.kind === "oauth") {
      throw new Error("OAuth 服务商不支持从控制台修改");
    }
    const protocol = String(input.protocol ?? "").trim().toLowerCase();
    if (protocol !== "anthropic" && protocol !== "openai") {
      throw new Error("协议只支持 openai 或 anthropic");
    }
    const baseUrl = validUrl(String(input.baseUrl ?? ""));
    const cur = this.loadSaved();
    const prevOv = cur?.providers[id];
    const apiKeyInput = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    const keepKey = apiKeyInput || prevOv?.apiKey || (existingSrv?.kind === "http" ? existingSrv.apiKey : undefined);
    const preset = TEXT_PRESETS[id];
    const auth = input.auth && ["bearer", "x-api-key", "api-key", "none"].includes(input.auth)
      ? (input.auth as AuthStyle)
      : (prevOv?.auth ?? (existingSrv?.kind === "http" ? existingSrv.auth : undefined));
    if (!keepKey && !preset?.keyless && auth !== "none") {
      throw new Error("请填写 API Key");
    }
    const field =
      input.maxTokensField === "max_tokens" || input.maxTokensField === "max_completion_tokens"
        ? input.maxTokensField
        : (prevOv?.maxTokensField ?? (existingSrv?.kind === "http" ? existingSrv.maxTokensField : undefined));
    const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, 40) : undefined;
    const ov: StoredProviderOverride = {
      ...(label ? { label } : {}),
      protocol,
      baseUrl,
      // Keep env key in RAM when user didn't supply a replacement key.
      ...(apiKeyInput ? { apiKey: apiKeyInput } : prevOv?.apiKey ? { apiKey: prevOv.apiKey } : {}),
      ...(auth ? { auth } : {}),
      ...(field ? { maxTokensField: field } : {}),
    };
    const next: StoredModelOverride = {
      rev: (cur?.rev ?? 0) + 1,
      updatedAt: this.now(),
      updatedBy: by,
      providers: { ...(cur?.providers ?? {}), [id]: ov },
      ...(cur?.order !== undefined ? { order: cur.order } : {}),
    };
    this.save(next);
    return this.view();
  }

  /** Reverts a server preset override or deletes a console-added provider. */
  removeProvider(idRaw: string, by: string): ModelConfigView {
    const id = idRaw.trim().toLowerCase();
    const cur = this.loadSaved();
    if (!cur || !(id in cur.providers)) {
      throw new Error(this.serverProviders.has(id) ? "服务器预设服务商本身没有可还原的修改" : "没有这个服务商");
    }
    const providers = { ...cur.providers };
    delete providers[id];
    const isConsoleOnly = !this.serverProviders.has(id);
    let order = cur.order;
    if (isConsoleOnly) {
      const baseOrder = order ?? this.serverTargets.map((t) => ({ provider: t.provider, model: t.model }));
      order = baseOrder.filter((m) => m.provider !== id);
    }
    if (!Object.keys(providers).length && order === undefined) {
      this.store.putSetting(SETTING_MODELS, null);
      return this.view();
    }
    this.save({
      rev: cur.rev + 1,
      updatedAt: this.now(),
      updatedBy: by,
      providers,
      ...(order !== undefined ? { order } : {}),
    });
    return this.view();
  }

  /** Replaces the active ordered model priority list (index 0 = primary model). */
  setOrder(items: Array<{ provider: string; model: string }>, by: string): ModelConfigView {
    if (!Array.isArray(items) || !items.length) {
      throw new Error("至少保留一个模型在顺位列表里");
    }
    const cur = this.loadSaved();
    const normalized: ModelOrderItem[] = [];
    const seen = new Set<string>();
    for (const raw of items.slice(0, 20)) {
      const provider = String(raw?.provider ?? "").trim().toLowerCase();
      const model = String(raw?.model ?? "").trim();
      if (!provider || !model || /[\r\n\0]/.test(model) || model.length > 120) {
        throw new Error("模型 ID 格式无效");
      }
      if (!this.resolveProvider(provider, cur)) {
        throw new Error(`未知服务商 "${provider}"，请先配置服务商`);
      }
      const dedupKey = `${provider}:${model}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      normalized.push({ provider, model });
    }
    if (!normalized.length) throw new Error("没有有效的模型顺位");
    this.save({
      rev: (cur?.rev ?? 0) + 1,
      updatedAt: this.now(),
      updatedBy: by,
      providers: cur?.providers ?? {},
      order: normalized,
    });
    return this.view();
  }

  /** Clears all overrides and reverts to startup server targets. */
  reset(): ModelConfigView {
    this.store.putSetting(SETTING_MODELS, null);
    return this.view();
  }

  /** Fetches available model IDs from a configured HTTP provider's `/models` endpoint. */
  async fetchProviderModels(providerId: string): Promise<{ provider: string; models: string[]; note?: string }> {
    const id = providerId.trim().toLowerCase();
    const p = this.resolveProvider(id, this.loadSaved());
    if (!p) throw new Error(`未知服务商 "${id}"`);
    if (p.kind === "oauth") {
      return { provider: id, models: [], note: "OAuth 凭据不支持拉取模型列表，请手动输入模型 ID" };
    }
    const base = p.baseUrl.replace(/\/+$/, "");
    const url = p.protocol === "anthropic" ? `${base}/v1/models` : `${base}/models`;
    const headers: Record<string, string> = { ...(p.headers ?? {}) };
    if (p.apiKey) {
      const style = p.auth ?? (p.protocol === "anthropic" ? "x-api-key" : "bearer");
      if (style === "bearer") headers.authorization = `Bearer ${p.apiKey}`;
      else if (style === "x-api-key") headers["x-api-key"] = p.apiKey;
      else if (style === "api-key") headers["api-key"] = p.apiKey;
    }
    if (p.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
    if (!res.ok) {
      const body = redact((await res.text().catch(() => "")).slice(0, 180));
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const json = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
    const models = (Array.isArray(json?.data) ? json.data : [])
      .map((x) => (typeof x?.id === "string" ? x.id.trim() : ""))
      .filter(Boolean);
    return { provider: id, models: [...new Set(models)] };
  }
}
