/**
 * Known text-model vendors: protocol and base URL, so a key and a model name
 * are all a deployment has to give. Checked against each vendor's docs in
 * 2026-11; docs/config.md lists the sources. Any other endpoint works as a
 * custom provider with its own base URL.
 */
import type { Protocol } from "./llm.ts";

export interface TextPreset {
  label: string;
  protocol: Protocol;
  baseUrl: string;
  /** Runs locally and needs no key. */
  keyless?: boolean;
  maxTokensField?: "max_tokens" | "max_completion_tokens";
}

export const TEXT_PRESETS: Record<string, TextPreset> = {
  anthropic: { label: "Anthropic", protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  // max_tokens is deprecated in favour of max_completion_tokens (o-series models refuse it).
  openai: { label: "OpenAI", protocol: "openai", baseUrl: "https://api.openai.com/v1", maxTokensField: "max_completion_tokens" },
  deepseek: { label: "DeepSeek", protocol: "openai", baseUrl: "https://api.deepseek.com" },
  // Beijing region; Singapore: https://dashscope-intl.aliyuncs.com/compatible-mode/v1
  qwen: { label: "Qwen (Alibaba Cloud Model Studio / DashScope)", protocol: "openai", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  // International: https://api.moonshot.ai/v1. Its docs mark max_tokens as deprecated.
  moonshot: { label: "Moonshot Kimi", protocol: "openai", baseUrl: "https://api.moonshot.cn/v1", maxTokensField: "max_completion_tokens" },
  // International (Z.ai): https://api.z.ai/api/paas/v4
  zhipu: { label: "Zhipu GLM (BigModel)", protocol: "openai", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  // International: https://api.siliconflow.com/v1
  siliconflow: { label: "SiliconFlow", protocol: "openai", baseUrl: "https://api.siliconflow.cn/v1" },
  volcengine: { label: "Volcengine Ark (Doubao)", protocol: "openai", baseUrl: "https://ark.cn-beijing.volces.com/api/v3" },
  openrouter: { label: "OpenRouter", protocol: "openai", baseUrl: "https://openrouter.ai/api/v1" },
  gemini: { label: "Google Gemini (OpenAI-compatible endpoint)", protocol: "openai", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  // From inside a container use http://host.docker.internal:11434/v1.
  ollama: { label: "Ollama (local)", protocol: "openai", baseUrl: "http://localhost:11434/v1", keyless: true },
};

export const VOICE_PROVIDERS = ["moss-live", "openai-realtime"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const MOSS_DEFAULTS = { url: "wss://api.mosi.cn/v1/realtime", model: "moss-live-1.0", speed: 1.1 };
export const REALTIME_DEFAULTS = { url: "wss://api.openai.com/v1/realtime", model: "gpt-realtime", transcribeModel: "gpt-4o-mini-transcribe", rate: 24_000 };
