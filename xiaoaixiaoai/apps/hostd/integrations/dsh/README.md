# 小爱小爱 DSH connector (opt-in)

This is an in-process Node ESM Cordis plugin for **DeepSeek Harness 0.2.1-rc.3**. It is intended for DSH and `hostd` running under the same OS user on Linux/WSL. It does not access the Web GUI, acquire credentials, or provide an agent runtime. Do not enable it on other DSH releases without revalidating the controller's live admission path.

## Activation by the computer owner

1. Choose the DSH host/profile that owns the existing sessions. `workspaceScope: all` shares this profile's browseable metadata with the one phone approved by hostd. It does not grant writes by itself. Use `workspaceIds` instead for narrower sharing, never both. The one approved phone can send to eligible sessions across the profile after the owner explicitly enables `sendScope: profile`.
2. Create a dedicated, owner-only directory on a local POSIX filesystem. For example, if your canonical runtime directory is available: `install -d -m 0700 -- "${XDG_RUNTIME_DIR:?}/xiaoaixiaoai-dsh"`. Use the literal canonical absolute socket pathname (at most 103 UTF-8 bytes) below. The immediate directory must be owned by your effective UID with mode `0700`; symlinked paths are refused. Do not use a shared filesystem, forward the socket, or expose it through TCP/HTTP proxies. Processes under the same UID are trusted by this socket; the phone identity is checked separately by `hostd`.
3. Keep all plugin files, including `task-events.mjs` and the adjacent compatibility manifest, together in a trusted location. Pass the following separate patch file via `dsh --profile <profile> --patch <absolute-patch-file>` on the next normal start, or merge it into only the selected profile with an appropriate maintenance window. The Web profile can hot-recompose when its patch changes. Do not start a duplicate host against a running profile.

```yaml
- insert:
    - id: xiaoaixiaoai-dsh-bridge
      name: 'file:///absolute/path/to/xiaoaixiaoai/apps/hostd/integrations/dsh/index.mjs'
      config:
        socketPath: '/run/user/12345/xiaoaixiaoai-dsh/bridge.sock'
        workspaceScope: all
        # Or replace workspaceScope with: workspaceIds: ['approved-workspace-id']
        enableSend: false
        # Profile-wide sending: set enableSend: true with the following opt-in:
        # sendScope: profile
        # resumeExisting: true  # explicitly send to a dormant, existing session
        # Or keep a narrower write policy with sendAllowlist instead of sendScope:
        # sendAllowlist:
        #   - { workspaceId: 'approved-workspace-id', sessionId: 'approved-session-id' }
```

The alternative `workspaceIds` is a nonempty ordered list of up to 20 unique IDs. `enableSend` defaults to `false`; legacy `sendAllowlist` defaults to empty and accepts up to 100 distinct real workspace/session pairs. `sendScope: profile` requires `workspaceScope: all`, `enableSend: true`, and no `sendAllowlist`. It accepts uniquely verified ordinary sessions, including unfiled ones that are verified absent from every real workspace. Archived, subagent, migration-required, and ambiguous entries remain read-only. `resumeExisting: true` requires profile sending and the pinned DSH Host resolver; it can restore only the selected existing session on an explicit send, not on read.

The plugin waits for Cordis to supply `workspaceRegistry`, `sessionController`, and `agents`. It will not remove an existing path, even a stale socket. After an abnormal exit, confirm the old host has stopped before removing its stale socket or choosing a new unused path. Do not rename or replace the path or its directory while mounted.

4. Set `dsh.socketPath` to this absolute path in the private `xiaoaixiaoai run --runtime-config <private-config.json>` file that names the approved phone with `viewerId`. To verify the plugin locally without sending anything, use `curl --unix-socket <socket-path> -H 'Content-Type: application/json' --data '{"view":"projects"}' http://localhost/v2/browse`. Do this locally; don't paste the actual catalog into shared logs. To revoke access, remove or disable the plugin row on the selected host, or remove the relevant allowlist pair and reload its config. Disable the hostd connector too if it is no longer needed.

## Local interface and limits

- `POST /v2/browse` accepts `view: projects` and optional `after`, `view: sessions` with optional `projectId`, `search` (120 UTF-16 units, title/ID only), and `after`, or `view: exact` with `sessionIds` (up to 32 unique IDs). Each page has at most 32 rows, ordered by stable ID, with `next` to fetch another page; there is no 20/100 catalog ceiling in full mode. Full mode uses the selected profile's workspace registry and DSH-visible ordinary session summaries, including unfiled and archived groups. Selected mode keeps the previous workspace scope and excludes unfiled and archived sessions. Subagents aren't included. Archived sessions are read-only; dormant ordinary sessions require `resumeExisting: true` to send. Titles come only from DSH workspace/session title metadata, can be sensitive, and are never replaced with working paths, content previews, or transcripts.
- Legacy `GET /v1/catalog` remains unchanged for old explicit workspace lists (up to 20 projects and 100 rows); in full mode it deliberately returns an empty list instead of misrepresenting a truncated catalog. Use a matching phone and hostd with `runtimeSessions.browse` for full mode.
- `POST /v1/send` takes only JSON `{projectId,sessionId,requestId,text}`. `requestId` is a UUIDv4 and text must be nonblank and at most 4,000 UTF-16 code units. The plugin checks membership and archive state before and after discovery, and when explicitly resuming, after the exact-ID native resolver returns. It checks the top-level Agent and its live Session again immediately before DSH's text-only `prompt` with `mode: 'queue'`. It never creates a new session, overrides approvals, or exposes separate lifecycle or history routes.
- `POST /v3/task-events` takes only `{}` and returns a bounded window of stable `{eventId,requestId,kind}` records. It observes only the exact scoped turn that claimed the confirmed request. A step completion, a pending native approval or question, and the turn's observed terminal outcome are distinct. It never copies prompts, tool arguments, question text, or replies. The window is process-local: at most 128 records for 15 minutes; a host restart, expiry or missed event is not a successful completion.
- A success `{accepted:true,requestId}` acknowledges queue admission, not execution or task completion. There is no upstream transaction that can freeze workspace or archival changes after submission. A timeout, disconnect, or failure after invoking DSH can leave the outcome unknown. Verify in the original session; do not automatically resend. Errors have fixed codes and never contain the prompt or an upstream diagnostic.
- Only the `0600` filesystem socket is served. The plugin caps active work and connections at eight, the JSON request body at 32 KiB, request processing at five seconds, and total connection lifetime at seven seconds. It aborts outstanding calls on disconnect or unload; an upstream call that ignores abort may still settle after its caller is gone.

## Tests (no real sessions or accounts)

From `xiaoaixiaoai/apps/hostd`:

```sh
node --test test/dsh-bridge.test.ts
DSH_TEST_PACKAGE=/absolute/path/to/node_modules/@deepseek-ai/dsh/package.json \
  node --test test/dsh-bridge.test.ts
```

Both use temporary private Unix sockets and synthetic services. Setting `DSH_TEST_PACKAGE` also loads the installed Cordis Loader and verifies the plugin's file-URL activation, required-service readiness, and unload. The tests do not boot DSH or open its profile, history, or model services.
