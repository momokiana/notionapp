# 小爱小爱 — Android app

当前自有身份：显示名“小爱小爱”，Android包名 `dev.notifier.xiaoaixiaoai`，scheme `xiaoaixiaoai`，默认助理“爱弥斯”。[用户选择的头像与图标出处](<assets/brand/USER-ARTWORK.md>)独立于代码AGPL许可；原作者版权仍保留。未配置自有发布源前，自动/手动更新与配对页下载均关闭，只使用明确收到的自有签名 APK。

本地检查：`pnpm install --frozen-lockfile --ignore-workspace --ignore-scripts` 后执行 `pnpm test && pnpm typecheck && pnpm lint`。构建前使用已核实的 [Expo SDK58配置文档](<https://docs.expo.dev/versions/v58.0.0/config/app/>)与[本地发行构建说明](<https://docs.expo.dev/guides/local-app-production.md>)，从配置生成原生工程，不手工维护生成目录。正式发行须有自己的签名，缺失签名不得回退公共debug key。模型授权只留服务器，不写入APK；真实部署/账号与手机验收须单独记录。

Android-only (`app.json` → `"platforms": ["android"]`). Expo SDK 58 + expo-router + react-native-paper (MD3). Watches and drives the herdr agents on every computer registered with your relay.

## Run

```sh
cd apps/mobile
npm install                 # standalone install (not part of the pnpm workspace)
npx expo start              # then press `a`, or:
adb reverse tcp:8081 tcp:8081
adb shell am start -a android.intent.action.VIEW -d exp://127.0.0.1:8081 host.exp.exponent
```

The custom XiaoaiNative module provides background notifications, audio and updates; it is not bundled in Expo Go. Use a generated native development/release build to validate those capabilities. Expo Go or mock mode is not acceptance of the installable app.
Installable APK: `npx expo run:android --variant release` locally, or `npx eas-cli@latest build -p android --profile preview`.

On first launch the app offers **扫码配对** (the QR carries server + code, nothing to type). The fallback is one input that takes a pair link, `server code`, or a bare code plus the server URL (no default server); the last real server is remembered, so re-pairing only needs a new code. To try the UI with no server, tap **先逛逛演示数据** (uses `mock://demo`, see `src/lib/mock.ts`).

Deep links (scheme `xiaoaixiaoai`, registered as an Android intent filter):

| Link | Opens |
| --- | --- |
| `xiaoaixiaoai://pair?server=<url>&code=<CODE>` | this phone joins straight away (an invite QR) |
| `xiaoaixiaoai://join?server=<url>&id=<ID>` | asks whether to let another device in (the QR `xiaoaixiaoai up` shows) |
| `xiaoaixiaoai://agent/<urlencoded agent key>?tab=chat\|terminal\|info` | an agent |
| `xiaoaixiaoai://devices`, `xiaoaixiaoai://settings` | tabs |

In Expo Go replace `xiaoaixiaoai://` with `exp://127.0.0.1:8081/--/`.

## Layout

```
src/app/                 routes (expo-router)
  _layout.tsx            fonts, theme, query client, relay link bootstrap
  connect.tsx            onboarding: server URL + pair code / QR
  scan.tsx  pair.tsx     QR scanner, deep-link pairing
  pair-new.tsx           invite: one QR + code that adds a phone (scan) or a computer (command)
  join.tsx               approve a device that showed a join QR (xiaoaixiaoai://join?server=&id=)
  (tabs)/index.tsx       Agents hub: overview, filters, search, grouped by computer
  (tabs)/devices.tsx     devices, online state, revoke (long press)
  (tabs)/settings.tsx    server/latency, theme, accent, text size, re-pair
  agent/[key].tsx        agent detail: 对话 / 终端 / 信息 + composer with quick keys
src/components/          ui.tsx (Card, StatusPill, BreathingDot, Sheep…), agents.tsx, chat.tsx, detail.tsx
src/lib/                 relay.ts (WebSocket + RPC + REST), store.ts (zustand), mock.ts, auth.ts (SecureStore), format.ts, harness.ts, session.ts
src/theme/               tokens.ts (palette, radii, motion, fonts), theme.tsx (Paper theme, window background)
docs/screenshots/        Android emulator screenshots (Android 14, 1080×2400)
```

The wire contract is `packages/protocol/src/index.ts`, resolved by Metro (`metro.config.js`) and `tsconfig.json` paths.

## Relay expectations

- `POST /v1/pair` `{code,name,kind:"viewer",platform}` → `{device, token}`; token kept in SecureStore. When the phone already holds a token for the same relay it sends it as `Authorization: Bearer`, and the relay replaces that registration instead of adding a second device.
- `GET /v1/ws?token=` WebSocket; the app sends `hello`, `ping` (every 20 s) and `rpc`; it handles `welcome`, `snapshot`, `device`, `device_removed`, `agents`, `rpc_result`, `pong`, `error`.
- Close code **4001** (also 4401) means the token was revoked: the app stops reconnecting and asks to re-pair. A token revoked while the app was closed is refused at the WebSocket upgrade (plain close), so after a close with no `welcome` the app asks `GET /v1/devices`; a 401 there is treated the same way.
- Signing out (设置 → 重新配对) calls `DELETE /v1/devices/<own id>` first (best effort, 4 s cap).
- `POST /v1/pair/codes` `{}` (an invite for any kind of device) and `DELETE /v1/devices/:id` with `Authorization: Bearer <token>`.
- `GET /v1/join/:id`, `POST /v1/join/:id/approve|deny` with `Authorization: Bearer <token>` to let in a device that asked to join.

## Agent screen

- 对话: runs of two or more tool calls fold into one line; thinking shows its first line. A message sent from the phone shows at once and gives way to the session's own copy. Every event received is kept by id, so the sliding newest page never leaves a hole; only a page that no longer touches what is held starts the list over.
- 终端: key bar only; the keyboard button opens a one-line box that sends with Enter. 对话: message box only; the keyboard button shows the key bar.
- “实时” means the stream is open, not that frames keep arriving: an unchanged screen sends nothing.

## Fonts

ZCOOL KuaiLe (headings), Nunito (body), Maple Mono (terminal/code; `assets/fonts`, OFL-1.1). CJK text without a glyph in Nunito / Maple Mono falls back to the system font, so CJK inside terminal box drawings is not perfectly column-aligned.
