# 小爱小爱文档

- [项目介绍](../README.md) · [开发规则](../AGENTS.md) · [修改记录](../MODIFICATIONS.md)
- [安卓 App](../apps/mobile/README.md) — Expo 开发、配对、链接和 Android 构建。
- [小爱小爱外观](../apps/mobile/docs/starlight-theme.md) — 星海蓝粉、图标和手写字体。
- [部署与配对](deploy/README.md) · [新装模板](../deploy/) · [模型与语音配置](config.md)。
- [项目会话（DSH / Codex）](runtime-sessions.md) — 授权、同会话发送、验证边界。
- [版权与许可](../NOTICE.md)。

## Contract ownership

The source of truth for cross-process behavior is `packages/protocol/src/index.ts`. Relay forwarding lives in `apps/relay/src/server.ts`; computer-side adapters and handlers live in `apps/hostd/src`; the Android WebSocket/RPC client lives in `apps/mobile/src/lib/relay.ts`. Update those together when a wire message changes.

## Operational notes

The relay is a server-side production service and the host daemon is a per-computer service. Health, service state, and real-device connectivity must be checked separately. A successful emulator build does not prove a real phone is connected, and a host daemon's local `connected` state does not prove the public relay is healthy.
