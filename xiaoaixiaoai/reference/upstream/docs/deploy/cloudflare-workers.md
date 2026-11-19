# Cloudflare Workers + Durable Objects：可行性评估

结论先说：**能做，但不是换个部署目标，而是给中转服务写第二个运行时**。估计 2～3 周工作量（不含休眠优化），之后 Node 版和 Workers 版要一起维护。在这之前，[Cloudflare Tunnel](cloudflare-tunnel.md) 已经能做到“不开端口、不管证书、走 Cloudflare 网络”，缺的只是“不要服务器”。

本文按 2026-11 的代码（`apps/relay/src`，约 7100 行，其中 `server.ts` 1082 行、`store.ts` 352 行、`assistant/` 约 4600 行）评估。

## 架构对应

整个中转服务对应**一个 Durable Object（DO）实例**（`idFromName("relay")`）：Worker 的 `fetch` 只做转发，所有 HTTP 和 WebSocket 都进这个 DO。这正好符合中转服务“只能单实例”的要求，内存里的连接表、agent 快照、待处理 RPC 可以照旧放在 DO 的内存里。

## 哪些是 Node 专有的

| 代码 | 用到的 Node 能力 | Workers 上的做法 | 工作量 |
|---|---|---|---|
| `server.ts` HTTP | `node:http` 的 `createServer`、`IncomingMessage`/`ServerResponse`，约 25 个路由 | 改成 `fetch(Request) → Response`；`sendJson`、读 body、`clientIp`（换成 `CF-Connecting-IP`）都要重写 | 中 |
| `server.ts` WebSocket | `ws` 的 `WebSocketServer`（`noServer` + `upgrade`），`ws.ping()`/`pong` 心跳，`terminate()`，`maxPayload` 8 MB，permessage-deflate 压缩 | `WebSocketPair` + `ctx.acceptWebSocket()`。没有协议层 ping，心跳改用应用层 `ping` 帧（客户端已经每 20 秒发一次）和“最后收到消息的时间”。消息大小上限和压缩是否可用要实测（压缩有兼容性开关，终端画面和对话不压缩时流量会大几倍） | 中 |
| `store.ts` | `node:sqlite` 的 `DatabaseSync`，约 35 条 `prepare()` 语句 | DO 自带 SQLite，`ctx.storage.sql.exec(sql, ...参数)` 也是同步的，表结构和 SQL 基本能直接用；把 `prepare().run/get/all` 包一层适配；事务改用 `ctx.storage.transactionSync()` | 小 |
| 定时器 | 约 18 处 `setTimeout`/`setInterval`：30 秒心跳清扫、助理提醒 15 秒一轮、RPC 超时、加入请求过期 | DO 活着时定时器照常工作；但 DO 随时可能被迁移或重启，提醒（已存数据库）要改由 `alarm()` 驱动，其余短定时器可以保留 | 小～中 |
| 语音 `assistant/live.ts`、`realtime.ts` | `ws` 客户端主动连 MOSS-Live / OpenAI Realtime，带鉴权请求头 | `fetch(url, { headers: { Upgrade: "websocket", ... } })` 拿到 `webSocket` 再 `accept()`；手机和上游之间转发音频帧逻辑不变 | 小 |
| `config.ts` | `node:fs` 读 `POCKET_CONFIG` JSON 文件 | 只支持环境变量和 Secret（`wrangler secret put`） | 小 |
| 其他 | `node:crypto`（randomBytes、randomUUID、timingSafeEqual、createHash、randomInt）、`qrcode`、`node:path` | 开 `nodejs_compat` 后可用；`qrcode` 是纯 JS | 小 |
| 启动与 CLI | `main.ts`、`bootstrap.ts`、`cli.ts`（setup 码、更新） | 设置码改成首次请求时生成，显示在一个只有管理员令牌能看的页面或 `wrangler tail` 日志里；更新就是重新 `wrangler deploy` | 小 |

`assistant/` 里的模型调用本来就用 `fetch`，流式响应在 DO 里没问题，基本不用改。

## 主要风险

1. **DO 被重启时内存状态会丢**：在线连接会断开重连（电脑端和 App 已经会自动重连并重新发布 agent 列表），正在转发的 RPC 会失败。现在 Node 进程重启也是同样表现，但 DO 重启更频繁（每次部署、平台迁移）。
2. **休眠与费用**：电脑一直连着，DO 不休眠就会一直计时长费。用 WebSocket Hibernation 可以省钱，但休眠会清掉内存，连接表和 agent 快照要能从 `serializeAttachment` 和 SQLite 里恢复，这是改动最大的部分，建议第二期再做。个人规模（几台电脑、一两部手机）估计在 Workers 付费套餐（$5/月）的额度内，要按实际消息量核算。
3. **消息大小**：现在单条 WebSocket 消息允许 8 MB，Workers/DO 的上限更低，大的终端画面或对话页可能要分片，需要实测。
4. **两套运行时**：`server.ts` 里传输层和业务逻辑现在混在一起，不先抽一层接口就只能复制一份代码。

## 移植方案

1. 抽接口（2～3 天）：`Transport`（send / close / 收消息 / 关闭事件）、`Clock`（定时器）、`Sql`（同步 exec）。Node 版先切到这些接口上，现有测试保证行为不变。
2. Worker 入口 + DO（2～3 天）：`apps/relay-worker/`，`wrangler.toml` 声明一个 SQLite DO 类和迁移；HTTP 路由改成 `fetch`。
3. 存储（1～2 天）：`Store` 的 SQLite 适配，沿用同一份表结构。
4. 定时器和提醒（1～2 天）：提醒改 `alarm()`，心跳改应用层。
5. 语音（1 天）：上游 WebSocket 改 `fetch` 升级。
6. 测试和文档（2～3 天）：`@cloudflare/vitest-pool-workers` 跑现有 relay 测试的子集；“Deploy to Cloudflare”按钮和文档。
7. （第二期，3～5 天）WebSocket Hibernation。

合计约 10～14 个工作日，第二期另算。

## 不推荐的替代

- **Cloudflare Containers** 能直接跑现在的 Docker 镜像，但容器磁盘不持久，SQLite 每次重启都会丢，除非改用外部存储，不适合。
- **Workers + D1**：D1 是异步 API，`store.ts` 的同步调用要全部改成 `await`，牵连整个 `server.ts`，不如 DO 自带的同步 SQLite。
