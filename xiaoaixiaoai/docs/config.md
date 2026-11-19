# Relay configuration: text model and voice

The relay has two model-backed parts:

- the **text assistant** (chat in the app, and the tasks a voice call hands over), which can use many providers with an ordered fallback;
- **voice calls**, through MOSS-Live (default and recommended) or a service that speaks the OpenAI Realtime protocol.

Keys stay on the relay. They are never sent to the phone, never shown by `/v1/health` or the admin page, and removed from upstream error messages before those are logged.

## Where settings come from

1. **Environment variables**, usually from `/etc/xiaoaixiaoai/relay.env` (systemd) or `relay.env` next to the Docker Compose file. Template: [`deploy/relay.env.example`](../deploy/relay.env.example).
2. **An optional JSON file** named by `POCKET_CONFIG`, for the text-model, voice and time-zone settings only (format below). Other relay settings (port, database, admin token, public URL) are environment-only.

Precedence, per setting: a non-empty environment variable, then the file, then the built-in default. A variable that is set but empty (`POCKET_X=`) counts as unset, so the empty lines of the template never hide a value from the file. A file that cannot be read or parsed stops the relay at startup with the reason.

At startup the relay prints one line per problem it found (a model without a key, an unknown provider, and so on) and a summary such as `[relay] assistant: deepseek, qwen  voice: moss-live`.

JSON values in an env file (`*_EXTRA_BODY`) go in single quotes: `POCKET_OPENAI_EXTRA_BODY='{"reasoning_effort":"low"}'`. systemd and Docker Compose remove the quotes; the relay also accepts them if a loader keeps them.

## Text assistant

### The model list

`POCKET_ASSISTANT_MODELS` is a comma-separated list, tried in order. A model is skipped and the next one asked when its request fails, or when no first token arrives within `POCKET_ASSISTANT_FIRST_TOKEN_MS` (default 25 000 ms). One answer may take at most 120 s.

Each entry is `provider:model`:

```sh
POCKET_ASSISTANT_MODELS=deepseek:deepseek-flash,qwen:qwen3.7-plus,ollama:qwen3:8b
```

The part before the first colon counts as a provider only if it names one (a preset below, `custom`, a provider in the config file, or an id with its own `POCKET_<ID>_BASE_URL`). Otherwise the whole entry is a model name for the default provider (`POCKET_ASSISTANT_PROVIDER`, default `custom`). So `ollama:qwen3:8b` is model `qwen3:8b` at Ollama, and with `POCKET_ASSISTANT_PROVIDER=ollama` a bare `qwen3:8b` means the same.

There is no default model list. Without models, or when no listed model has a usable provider, the assistant answers only that it is not set up.

### Providers

| id | Vendor | Protocol | Default base URL | Notes |
|---|---|---|---|---|
| `anthropic` | Anthropic | Anthropic Messages | `https://api.anthropic.com` | `x-api-key` header, `anthropic-version: 2023-06-01` |
| `openai` | OpenAI | Chat Completions | `https://api.openai.com/v1` | sends `max_completion_tokens` (`max_tokens` is deprecated there) |
| `gpt-login` | existing GPT OAuth | Pi OpenAI Responses (`pi-openai-oauth`) | provider-owned, not configurable | explicit credential file only; see the dedicated GPT example below |
| `deepseek` | DeepSeek | Chat Completions | `https://api.deepseek.com` | Anthropic-compatible: `https://api.deepseek.com/anthropic` |
| `qwen` | Alibaba Cloud Model Studio (DashScope) | Chat Completions | `https://dashscope.aliyuncs.com/compatible-mode/v1` | Singapore: `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`. Keys belong to one region. Anthropic-compatible: `https://dashscope.aliyuncs.com/apps/anthropic` |
| `moonshot` | Moonshot Kimi | Chat Completions | `https://api.moonshot.cn/v1` | International: `https://api.moonshot.ai/v1`. Sends `max_completion_tokens` (its docs deprecate `max_tokens`). Anthropic-compatible: `https://api.moonshot.cn/anthropic` |
| `zhipu` | Zhipu GLM (BigModel) | Chat Completions | `https://open.bigmodel.cn/api/paas/v4` | Z.ai: `https://api.z.ai/api/paas/v4`. Tool arguments come in one piece unless `tool_stream` is set; both work. Anthropic-compatible: `https://open.bigmodel.cn/api/anthropic` |
| `siliconflow` | SiliconFlow | Chat Completions | `https://api.siliconflow.cn/v1` | International: `https://api.siliconflow.com/v1` |
| `volcengine` | Volcengine Ark (Doubao) | Chat Completions | `https://ark.cn-beijing.volces.com/api/v3` | |
| `openrouter` | OpenRouter | Chat Completions | `https://openrouter.ai/api/v1` | model names look like `vendor/model` |
| `gemini` | Google Gemini | Chat Completions | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini's OpenAI-compatible endpoint; streamed tool calls are not confirmed by its docs |
| `ollama` | Ollama (local) | Chat Completions | `http://localhost:11434/v1` | no key. In Docker use `http://host.docker.internal:11434/v1` |
| `custom` | your own gateway | Anthropic Messages unless set | none: set `POCKET_ASSISTANT_URL` or `POCKET_CUSTOM_BASE_URL` | the meaning `POCKET_ASSISTANT_URL` always had |

Chat Completions requests go to `{base}/chat/completions` with `Authorization: Bearer <key>`; Anthropic requests go to `{base}/v1/messages`. Both stream. The assistant's tools are sent as functions and the answers translated back, so any listed provider can call them, provided the model supports tool calling.

Example model ids from the vendors' docs in 2026-11 (check the vendor's current list): DeepSeek `deepseek-flash`, `deepseek-v4-pro`; Qwen `qwen3.7-plus`, `qwen3.8-max`; Kimi `kimi-k3`; GLM `glm-5.3`; Doubao `doubao-seed-2.1-pro`. For a voice-friendly assistant prefer fast models without long thinking: the first token has to arrive within the limit above.

### Per-provider variables

`<ID>` is the provider id in upper case, `-` replaced by `_` (`my-gw` becomes `POCKET_MY_GW_…`).

| Variable | Meaning |
|---|---|
| `POCKET_<ID>_API_KEY` | key for this provider (not needed for `ollama`) |
| `POCKET_<ID>_BASE_URL` | replaces the preset's base URL (international endpoints, proxies). Required for ids that are not presets |
| `POCKET_<ID>_PROTOCOL` | `openai` or `anthropic`. Example: `POCKET_DEEPSEEK_PROTOCOL=anthropic` with `POCKET_DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic` |
| `POCKET_<ID>_AUTH` | `bearer`, `x-api-key`, `api-key` or `none`. Default: `x-api-key` for Anthropic, `bearer` for OpenAI |
| `POCKET_<ID>_EXTRA_BODY` | JSON merged into every request body last, e.g. `'{"reasoning_effort":"low"}'`, `'{"enable_thinking":false}'`, or a larger output limit for a reasoning model (`'{"max_completion_tokens":4000}'`) |

Any other id works as a provider once it has a base URL: `POCKET_MYGW_BASE_URL=https://llm.example.com/v1`, `POCKET_MYGW_API_KEY=…`, then `mygw:some-model` in the list. Such providers default to the OpenAI protocol. These ids are reserved: `assistant`, `voice`, `moss`, `admin`, `public`, `trust`, `port`, `host`, `db`, `config`.

### Shorthand for the default provider and the other assistant settings

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_ASSISTANT_PROVIDER` | `custom` | provider for list entries without a prefix |
| `POCKET_ASSISTANT_KEY` | | key of the default provider (a provider's own `POCKET_<ID>_API_KEY` wins) |
| `POCKET_ASSISTANT_URL` | | base URL of the default provider |
| `POCKET_ASSISTANT_PROTOCOL` | provider's | protocol of the default provider |
| `POCKET_ASSISTANT_USER_AGENT` | none | `User-Agent` sent to every text provider, for gateways that filter on it |
| `POCKET_ASSISTANT_NAME` | `爱弥斯` | the assistant's display name in 小爱小爱 chat and on calls; single line, at most 40 Unicode characters, no control/format characters |
| `POCKET_ASSISTANT_PERSONA` | none | optional style material, not a replacement system prompt; at most 2000 Unicode characters; file form: `assistant.persona` |
| `POCKET_ASSISTANT_FIRST_TOKEN_MS` | `25000` | see the model list above |
| `POCKET_ASSISTANT_CONFIRM` | `never` | `never`: the assistant acts at once. `always`: it asks before acting on agents in typed chats. Calls never wait. The app's Settings toggle "爱弥斯动手前先问我" and the /admin dashboard override it; the override is kept in the relay database (`settings` table, key `assistant.confirm`) |

### Display identity and persona

The app is **小爱小爱** and the default assistant is **爱弥斯**, not 小羊. A relay operator can set a name and optional style, independently of whether any model is configured:

```sh
POCKET_ASSISTANT_NAME=爱弥斯
POCKET_ASSISTANT_PERSONA=温柔、耐心，像熟悉的朋友；回答先说重点，不用表情符号。
```

These settings are trimmed. Non-empty environment values override `assistant.name` / `assistant.persona` in JSON. Empty values add no custom style and an empty name falls back to 爱弥斯. Invalid types, excessive lengths or control/format characters are fatal configuration errors; errors name the setting without echoing its contents. Persona text permits line breaks and tabs. Do not put credentials, private facts, transcripts or tool instructions in it.

Persona is quoted style material **before** the complete fixed tool, permission and fact rules, never a replacement system prompt. It cannot grant permission, bypass confirmation, change the read-only wake tools or assert an operation succeeded. The assistant still checks actual tool results and permission gates in code. Prompt boundaries reduce accidental conflicts; they are not a guarantee against malicious model behavior. Text chat, delegated tasks, wake-ups and both voice paths share the profile; transport and tool execution stay unchanged. A prompt-epoch update excludes the older voice from model context, not from the app's visible history.

Authenticated `GET /v1/assistant/settings` returns `{ "name": "爱弥斯", "confirm": "never", "default": "never" }`; the same name is in `AssistantState.settings`. `name` is read-only configuration, not an App user account or a POST setting. The app uses this existing settings channel (older relays without a name fall back to 爱弥斯). Persona text is never sent in settings, health or logs.

### GPT on your own relay: choose one credential mode

The examples below contain **only placeholder model ids, paths and values**, and are not runnable credentials. Model availability depends on the chosen provider/account; replace the model id with an actually supported one. No account login or model call is performed by configuration parsing.

**API key (ordinary `openai` Chat Completions transport):**

```sh
POCKET_ASSISTANT_NAME=爱弥斯
POCKET_ASSISTANT_PROVIDER=openai
POCKET_ASSISTANT_MODELS=openai:YOUR_CHAT_COMPLETIONS_MODEL_ID
POCKET_OPENAI_API_KEY=REPLACE_WITH_YOUR_SERVER_SIDE_API_KEY
```

Keep the key in a private relay env/secret file, never in mobile config, screenshots, source or persona. A ChatGPT subscription is not an API key. Use a tool-capable model for the existing relay assistant loop.

**Existing GPT OAuth credential (`gpt-login`, dedicated Pi OpenAI transport):**

```sh
POCKET_ASSISTANT_NAME=爱弥斯
POCKET_ASSISTANT_PROVIDER=gpt-login
POCKET_ASSISTANT_MODELS=gpt-login:YOUR_PI_OPENAI_RESPONSES_MODEL_ID
POCKET_GPT_LOGIN_CREDENTIALS_FILE=/var/lib/xiaoaixiaoai/secrets/gpt-oauth.json
POCKET_GPT_LOGIN_REASONING=low
```

Equivalent JSON (the path is deliberately fictitious):

```json
{
  "assistant": {
    "name": "爱弥斯",
    "persona": "温柔、耐心，先说重点；不编造结果。",
    "provider": "gpt-login",
    "models": ["YOUR_PI_OPENAI_RESPONSES_MODEL_ID"],
    "providers": {
      "gpt-login": {
        "credentialsFile": "/var/lib/xiaoaixiaoai/secrets/gpt-oauth.json",
        "reasoning": "low"
      }
    }
  }
}
```

- This reuses the **existing** `pi-openai-oauth` implementation and its SSE transport. It does not create an App login, run interactive OAuth, discover local accounts, import another agent's session or replace the relay's tool loop. Prepare the existing supported credential file outside the App using the authorized operator's supported login flow. Do not copy a real credential into this repository or issue login/refresh commands just to test configuration.
- `POCKET_GPT_LOGIN_CREDENTIALS_FILE` must be an explicit **absolute** path to an existing regular file (no symlink). It is a Pi credential map containing an `openai` OAuth entry, not an arbitrary Codex/ChatGPT export or API-key file. Parsing the relay config does not open it; the existing driver validates/opens it only on a model request.
- On POSIX, the file must be owned by the relay service user with **0600** permissions. Keep its parent directory private and writable by that user: refresh uses a sibling lock plus a same-directory temporary file and atomic rename. In a container, privately mount the writable directory, not a read-only single-file secret; never bake the file into an image. Do not share it with an unrelated credential writer. Do not print its contents to diagnose failures.
- Optional `POCKET_GPT_LOGIN_PROTOCOL=pi-openai-oauth` is the only accepted protocol; normally omit it. Reasoning may be `minimal`, `low`, `medium`, `high`, `xhigh` or `max` (model support still varies).
- Do **not** set `POCKET_GPT_LOGIN_API_KEY`, `BASE_URL`, `AUTH`, `EXTRA_BODY` or file-only `headers` / `maxTokensField` for this provider. With `POCKET_ASSISTANT_PROVIDER=gpt-login`, also leave `POCKET_ASSISTANT_KEY`, `URL` and `USER_AGENT` unset. Mixed credential/endpoint settings stop startup rather than silently switching transport. Other providers can have their own separately named settings.
- Credential/refresh failure is fail-closed; it does not silently switch account or fall back to an API-key provider. Retrying eligible model failures can use only the same explicitly configured OAuth credential file, and never concatenate a partially streamed draft with a fallback answer.
- This text setting does **not** enable voice. MOSS-Live/OpenAI Realtime retain separate `POCKET_VOICE_*` credentials; the GPT OAuth file is never reused for voice or sent to the phone.

Validate in stages: first offline config/fixture tests and local fake model/socket tests; only after separate explicit authorization should an operator verify a real account/model, host agent, production relay or phone. The current change claims only those offline/local checks, not real-account eligibility, a successful deployment or real-device behavior.

### Examples

```sh
# One vendor
POCKET_DEEPSEEK_API_KEY=sk-...
POCKET_ASSISTANT_MODELS=deepseek:deepseek-flash

# Two vendors, the second when the first fails or is slow
POCKET_QWEN_API_KEY=sk-...
POCKET_MOONSHOT_API_KEY=sk-...
POCKET_ASSISTANT_MODELS=qwen:qwen3.7-plus,moonshot:kimi-k3

# Your own OpenAI-compatible gateway, several models on it
POCKET_ASSISTANT_URL=https://llm.example.com/v1
POCKET_ASSISTANT_PROTOCOL=openai
POCKET_ASSISTANT_KEY=...
POCKET_ASSISTANT_MODELS=model-a,model-b

# An Anthropic-compatible gateway (what POCKET_ASSISTANT_URL meant before providers existed)
POCKET_ASSISTANT_URL=https://gateway.example.com
POCKET_ASSISTANT_KEY=...
POCKET_ASSISTANT_MODELS=model-a,model-b
```

### Upgrading from the single-gateway settings

Earlier versions read only `POCKET_ASSISTANT_KEY`, `POCKET_ASSISTANT_URL`, `POCKET_ASSISTANT_MODELS`, `POCKET_ASSISTANT_NAME` and `POCKET_ASSISTANT_USER_AGENT`, and filled in a built-in gateway, model list and user agent when they were missing. Those variables keep their meaning (an Anthropic-protocol gateway, models tried in order, the same requests), but nothing is filled in any more: set `POCKET_ASSISTANT_URL` and `POCKET_ASSISTANT_MODELS` explicitly, and `POCKET_ASSISTANT_USER_AGENT` if your gateway needs a particular one.

## Time zone

`POCKET_TIMEZONE` (or `"timeZone"` at the top level of the config file) is the IANA zone the assistant tells the time in, both spoken and written, and in which it understands reminder times. Examples: `Asia/Shanghai`, `Europe/Berlin`, `America/New_York`. Default: `Asia/Shanghai`. A name this system's time-zone data does not know is ignored with a warning, and the default stays.

In `Asia/Shanghai` the assistant calls its times 北京时间, as before. In any other zone they are 当地时间, and the model is also told the current UTC offset (daylight saving included), so reminder times it writes carry the right one. On a MOSS-Live call the zone is also passed as the call's `time_zone`.

## Admin token

`POCKET_ADMIN_TOKEN` is optional. A relay with no devices prints a one-time setup code and link for the first one, so pairing works without it. Only the `/admin` dashboard and the admin APIs need it; it must be at least 24 characters (`openssl rand -hex 24`), and a shorter one stops the relay at startup.

## Voice calls

`POCKET_VOICE_PROVIDER` selects the service: `moss-live` (default) or `openai-realtime`. Calls are off while the provider has no key. The phone app is the same for both: the relay converts audio and events, and the app never sees which service is behind a call. One call is open at a time; a new call replaces the old one.

### MOSS-Live (default, recommended)

| Variable | Older name | Default |
|---|---|---|
| `POCKET_VOICE_KEY` | `POCKET_MOSS_KEY` | (required) key from platform.mosi.cn → API Keys |
| `POCKET_VOICE_URL` | `POCKET_MOSS_URL` | `wss://api.mosi.cn/v1/realtime` |
| `POCKET_VOICE_MODEL` | `POCKET_MOSS_MODEL` | `moss-live-1.0` |
| `POCKET_VOICE_VOICE` | `POCKET_MOSS_VOICE` | the model's default voice |
| `POCKET_VOICE_SPEED` | `POCKET_MOSS_SPEED` | `1.1` (0.5–1.5; 1 is normal) |

When both names are set, `POCKET_VOICE_*` wins. Behaviour is unchanged from earlier versions.

### OpenAI Realtime protocol

| Variable | Default | Meaning |
|---|---|---|
| `POCKET_VOICE_KEY` | (required) | the service's key. `POCKET_MOSS_KEY` is not used here |
| `POCKET_VOICE_URL` | `wss://api.openai.com/v1/realtime` | `?model=` is added unless the URL has it |
| `POCKET_VOICE_MODEL` | `gpt-realtime` | realtime model, or the deployment name on Azure |
| `POCKET_VOICE_VOICE` | service default | OpenAI: `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar` |
| `POCKET_VOICE_SPEED` | service default | 0.25–1.5 |
| `POCKET_VOICE_AUTH` | `bearer` | `api-key` sends an `api-key` header (Azure) |
| `POCKET_VOICE_TRANSCRIBE_MODEL` | `gpt-4o-mini-transcribe` | speech-to-text for captions of what the person says; `none` turns it off |
| `POCKET_VOICE_LANGUAGE` | `zh` | language hint for transcription; `auto` leaves it out |
| `POCKET_VOICE_VAD` | `server_vad` | turn detection: `server_vad` or `semantic_vad` |
| `POCKET_VOICE_DIALECT` | `ga` | `beta`: the older flat session fields and `response.audio.*` events (see the table below) |
| `POCKET_VOICE_INPUT_RATE` / `POCKET_VOICE_OUTPUT_RATE` | `24000` | PCM sample rates the service takes and gives. OpenAI's `audio/pcm` is 24 kHz only |

How a call works on this protocol: the phone's 16 kHz microphone audio is resampled to the service's rate and its speech back to the phone's 48 kHz. The voice gets the same persona and instructions as on MOSS-Live, plus one function tool, `ask_backend`. A call of that tool is a task for the text assistant (the call screen shows it as one); the result goes back as the tool's output, and the voice reads its line aloud. When the person talks over an answer, the phone stops playback at once and the relay truncates the answer upstream to what was actually played, so the model knows what was heard.

Which services speak it, checked against their docs in 2026-11:

| Service | Works | How to set it up |
|---|---|---|
| OpenAI | yes | key and model; defaults above |
| Azure OpenAI | yes (same GA protocol) | `POCKET_VOICE_URL=wss://<resource>.openai.azure.com/openai/v1/realtime`, `POCKET_VOICE_MODEL=<deployment>`, `POCKET_VOICE_AUTH=api-key`. The older `api-version=…-preview` URL form is deprecated |
| Alibaba Qwen-Omni-Realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`), 16 kHz input (`POCKET_VOICE_INPUT_RATE=16000`), its own transcription model (`qwen3-asr-flash-realtime`), a URL with your workspace id. No truncation of cut-off answers. Its docs do not claim OpenAI compatibility |
| StepFun realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`); sample rate not stated in its docs; no truncation |
| Zhipu GLM-Realtime | partly; untested | older event names (`POCKET_VOICE_DIALECT=beta`); how the model is selected is not stated in its docs; no truncation |
| Volcengine / Doubao realtime dialogue | no | its own binary protocol |
| xAI Grok voice | unverified | its docs could not be read when this was written |
| MiniMax | no | no documented speech-to-speech realtime API |

"Partly; untested" means the relay has a mode for it, but it was never run against that service. Expect to adjust settings.

### Differences from MOSS-Live on the OpenAI Realtime protocol

- **Notices during a call** are better: when nobody is speaking, the relay asks the voice to say them right away. MOSS-Live can only bring them up on its next turn or inside a running task. While the person talks or an answer plays, a notice waits until that is over, or goes out with a running task's result.
- **A cut-off answer's caption** is estimated: the share of its text equal to the share of its audio that was played. MOSS-Live reports the heard text exactly.
- **Captions of the person's words** need a transcription model. Without one there are none, and tasks get less context. Transcripts can arrive after the answer has started, so a spoken question can land in the chat thread just after its answer.
- **A task cannot be called off.** MOSS-Live cancels a delegated task when the person changes their mind. Here the task runs to the end and the voice then says its result.
- **Silent notes and the spoken line** reach the voice in one tool output, labelled. MOSS-Live has separate channels for them. Keeping the notes silent relies on the model following the instructions.
- **The `beta` dialect** sets no speaking rate and sends no truncation, and services may reject fields this relay sends. If the session setup is refused, the call ends with "语音会话配置失败（<code>）" and the code is logged.

## Config file

`POCKET_CONFIG=/etc/xiaoaixiaoai/relay.json` (keep it `chmod 600` like the env file: it can hold keys). Every key is optional; environment variables win per setting.

```json
{
  "timeZone": "Asia/Shanghai",
  "assistant": {
    "name": "爱弥斯",
    "persona": "温柔、耐心，像熟悉的朋友；先说重点。",
    "provider": "deepseek",
    "models": ["deepseek-flash", "qwen:qwen3.7-plus", "mygw:model-a"],
    "firstTokenMs": 25000,
    "userAgent": "my-relay",
    "providers": {
      "deepseek": { "apiKey": "sk-..." },
      "qwen": { "apiKey": "sk-...", "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
      "openai": { "apiKey": "sk-...", "extraBody": { "reasoning_effort": "low" } },
      "mygw": {
        "protocol": "openai",
        "baseUrl": "https://llm.example.com/v1",
        "apiKey": "...",
        "auth": "bearer",
        "headers": { "x-team": "pocket" },
        "maxTokensField": "max_tokens"
      }
    }
  },
  "voice": {
    "provider": "moss-live",
    "apiKey": "...",
    "voice": "",
    "speed": 1.1
  }
}
```

- `timeZone` is the file form of `POCKET_TIMEZONE`.
- `assistant.name` / `assistant.persona` set display identity and optional style (limits and fixed-rule boundary above), even when there is no model.
- `assistant.models` may also be a comma-separated string. `assistant.apiKey`, `assistant.url` and `assistant.protocol` are the file forms of the default-provider shorthand.
- `providers.<id>` takes `protocol`, `baseUrl`, `apiKey`, `auth`, `headers` (file only), `maxTokensField` (`max_tokens` or `max_completion_tokens`, file only) and `extraBody`.
- `voice` takes `provider`, `apiKey`, `url`, `model`, `voice`, `speed`, and for `openai-realtime` also `auth`, `dialect`, `transcribeModel`, `language`, `vad`, `inputRate` and `outputRate`.

## Health

`GET /v1/health` (no auth) now also reports which services are configured, by name only:

```json
{ "ok": true, "assistant": ["deepseek", "qwen"], "voice": "moss-live", "...": "..." }
```

`assistant` is empty and `voice` is `null` when they are off.

## Sources

Vendor documentation the presets and the voice table were checked against (2026-11). Where a vendor's own page could not be opened from the build machine, the official SDK or cookbook was used instead; that is noted.

- Anthropic Messages: official Python SDK (`anthropics/anthropic-sdk-python`, `_client.py`, `types/message_create_params.py`, `types/input_json_delta.py`); docs page not reachable.
- OpenAI Chat Completions: official Python SDK (`openai/openai-python`, `types/chat/completion_create_params.py`, `types/chat/chat_completion_chunk.py`); docs pages not reachable.
- DeepSeek: https://api-docs.deepseek.com/, https://api-docs.deepseek.com/guides/tool_calls, https://api-docs.deepseek.com/guides/anthropic_api
- Qwen (DashScope): https://help.aliyun.com/zh/model-studio/base-url, https://help.aliyun.com/zh/model-studio/qwen-function-calling, https://www.alibabacloud.com/help/en/model-studio/anthropic-api-messages
- Moonshot Kimi: https://platform.kimi.com/docs/api/chat, https://platform.kimi.ai/docs/overview
- Zhipu GLM: https://docs.bigmodel.cn/cn/guide/develop/openai/introduction, https://docs.bigmodel.cn/cn/guide/capabilities/stream-tool, https://docs.bigmodel.cn/cn/guide/develop/claude/introduction, https://docs.z.ai/guides/develop/openai/python
- SiliconFlow: https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions, https://docs.siliconflow.com/en/api-reference/chat-completions/chat-completions
- Volcengine Ark: https://docs.volcengine.com/docs/82379/1298454, https://docs.volcengine.com/docs/ark/base-url-and-authentication
- OpenRouter: https://openrouter.ai/docs/api-reference/overview
- Gemini: Google's cookbook `quickstarts/Get_started_OpenAI_Compatibility.ipynb` (`google-gemini/cookbook`); https://ai.google.dev/gemini-api/docs/openai not reachable.
- Ollama: https://docs.ollama.com/api/openai-compatibility
- OpenAI Realtime (GA): official SDK types (`openai/openai-node` `src/resources/realtime/realtime.ts`; `openai/openai-python` `src/openai/types/realtime/`) and Microsoft's migration guide below.
- Azure OpenAI realtime: https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-websockets, https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/realtime-audio-preview-api-migration-guide
- Qwen-Omni-Realtime: https://www.alibabacloud.com/help/en/model-studio/realtime, https://www.alibabacloud.com/help/en/model-studio/server-events
- StepFun: https://platform.stepfun.com/docs/zh/api-reference/realtime/chat
- Zhipu GLM-Realtime: https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-realtime
- Volcengine realtime dialogue: https://docs.volcengine.com/docs/6561/1594356
- MOSS-Live: https://platform.mosi.cn/docs/reference/moss-live
