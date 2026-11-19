# 小爱小爱 project guide

## Scope

小爱小爱 is an Android-first viewer and controller for Herdr agents on multiple computers.
The repository contains the shared wire contract, the relay, the computer host daemon, the Expo Android app, deployment units, and design/brand references.

## Project map

- `packages/protocol/src/index.ts`: versioned device, agent, conversation, RPC, stream, and pairing contracts. Change this before changing a cross-process message.
- `apps/relay`: server-side WebSocket relay. Device tokens are stored as hashes; the relay rewrites published agent ownership.
- `apps/hostd`: per-computer daemon. It bridges `hc`, the Herdr TUI socket, and Uniflo, and serves RPC/stream subscriptions.
- `apps/mobile`: Expo SDK 58 Android app. It is intentionally excluded from the root pnpm workspace; run its checks from that directory.
- `deploy`: systemd, Caddy, launchd, and environment examples. Never put real tokens in these files.
- `apps/mobile/docs` and `apps/mobile/assets/brand`: current design and artwork; `reference/upstream` is historical only.

## Commands

From the repository root:

```sh
pnpm install
pnpm typecheck
pnpm --filter @xiaoaixiaoai/relay test
pnpm --filter @xiaoaixiaoai/hostd test
```

For the Android app:

```sh
cd apps/mobile
pnpm install
pnpm typecheck
cd android && ./gradlew assembleRelease -I ../deps/local-maven.gradle -PreactNativeArchitectures=arm64-v8a -Pexpo.webp.animated=true
```

The two `-P` flags match `plugins/withAndroidBuild.js` (applied on the next `expo prebuild`): arm64 only keeps the APK near 50 MB instead of about 126 MB, and animated WebP makes the mascot move. `deps/local-maven.gradle` serves `deps/maven/`, artifacts Gradle cannot download on the build Mac (Java's TLS handshake to Maven Central is cut there).

The release APK is written to `apps/mobile/android/app/build/outputs/apk/release/app-release.apk` by Gradle. Do not install it on a real phone without explicit user authorization for that installation; use the emulator for routine checks.

## Runtime topology

A relay runs on a server you control (systemd, Docker, or the other targets under `docs/deploy/`). Each computer runs the host daemon with `~/.config/xiaoaixiaoai/hostd.json` and a launchd/systemd service; those are machine state, not repository artifacts. Keep credentials in the OS keychain/environment/secret files, never in source, logs, screenshots, or prompts. Maintainer-specific deployment notes, if present, are in the git-ignored `AGENTS.local.md`: read it before touching a real deployment.

The host daemon reads local agents and publishes snapshots; terminal and conversation streams are optional live paths with RPC polling as recovery. Preserve both paths when changing live behavior. A relay restart must never strand a host: hosts reconnect on their own.

## Change rules

- Keep the app Android-only and keep the existing pink, no-emoji UI language.
- Preserve uncommitted work; do not reset, clean, stash, or commit unless explicitly requested.
- Do not send text or keys to real agents during tests.
- This repository is meant to be published: no real domains, IPs, machine names, project names, ids or tokens in tracked files; use placeholders such as `xiaoaixiaoai.example.com`. The project's own public addresses are the exception: the GitHub repo (`RELEASE_REPO` in the protocol), its container image and the Android package id stay real, since in-app updates and installs depend on them.
- The project is AGPL-3.0-only (`LICENSE`; the section 7 permission for the archived website and video is in `NOTICE.md`). New dependencies of the relay, hostd and app must be AGPL-compatible (MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL/GPL-3.0); ask the maintainer before adding anything else.
- For cross-process changes, update protocol types, relay forwarding, host handler, mobile client, mock mode, and focused tests together.
- For production deploy/restart, external messages, real-device installation, or credential changes, ask first unless the user explicitly authorized that exact action.
- Prefer focused checks. Report actual checks and blockers; do not call a simulator result a real-phone result.
