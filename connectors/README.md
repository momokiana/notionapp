# 本地出站连接器 — B限定FINAL PASS，联合发布待后端独审

> 本分支 `wip/connectors-candidate-b` 仅公开准确B源码及其限定结论：同一独审确认F1/F2/F3在B关闭；**A仍FINAL BLOCK，不迁签。** source-binding后端自身FINAL与联合稳定合并另由服务端准确结论决定；本分支未导入该后端，继承的公开T013服务仅能验证fail-closed，不能当作已接通的正常链路。见 [B范围/哈希/验证记录](../docs/releases/connectors-candidate-b.md)。

POSIX CLI 与库，使用内置 `node:sqlite`（当前 Node 22 会提示 ExperimentalWarning），没有第三方运行依赖。包声明Node.js >=22.13，实际只报告22.13.0/22.23.2的限定测试，不外推所有中间/后续版本。不开放入站端口、不执行 shell、不发现或读取私人会话目录。

## 必须保留的运行限制 N1

- 交接报告已验：**connector Node22.13.0 / 22.23.2 → 独立进程backend Node22.23.2**；客户端内置SQLite通过不意味着后端native驱动可用。
- 当前安装的backend better-sqlite3 13.0.3在官方Node22.13.0下连单独open亦SIGSEGV，**原因未定，不支持该backend/in-process integration-runner的22.13组合**。不要用22.13运行下面的后端集成runner。
- 后端公开验证仅记录22.23.2，不因连接器PASS、engines下限或本机NAPI_VERSION配置扩展矩阵；不修改现有锁包/依赖来掩盖限制。上述失败是开发/独审报告，发布者未重复触发崩溃；不是所有平台或所有重新构建native二进制的根因结论。

- 脚本、CI、定时任务：把严格 JSON 数据文件入队，连接器主动向同一个事件服务发布。
- Uniflo：显式选择会话，只 GET 当前快照与 NDJSON，映射为无交互只读事件与原事件 progress；不上传会话正文、路径、标题、preview、工具参数、reasoning 或原生 ID。
- 服务端仍是唯一事件／回应／命令／通知账本。本地 SQLite 只存传输原包、发布回执与观察映射／水位；`connector_persisted` 不是服务已保存，`event_saved` 也不是手机或原会话收件、执行或验证。

## 检查

```sh
npm --prefix connectors ci
npm --prefix connectors run check
# 以下集成runner必须由Node22.23.2执行（同进程加载backend native）
# 正常集成还须另行取得通过独审的source-binding后端；本分支未包含它
npm --prefix connectors run integration
# 当前公开T013旧服务只运行fail-closed验证，不称正常新协议集成
node connectors/test/integration-runner.mjs /absolute/public-server-tree --legacy
```

普通测试使用全新私有临时目录和回环 HTTP 合成协议夹具；`integration` 只复制 server/src 和 package/lock 到源外 scratch，前后核 hash，再以实际 Fastify/CoreStore/SQLite 测试。不编译或修改共享 server，不读取 data、生产配置、部署或 evidence。真实 Uniflo daemon、私人 harness、手机和生产验收不由这些测试代表。

## 配置与初始化

将 `examples/config.example.json` 复制到仓库外，替换占位字段。凭据由管理员私下从**准确来源**供应；不能从 Uniflo 文本或脚本正文导入身份。示例 token 是无效占位，不可直接运行。来源服务端配置使用 `publish`；Uniflo 模式必须仅有 publish，不授 reply/deliver。

配置和 spool 使用已存在的 0700 私有父目录，普通文件 0600、服务 UID 所有、非 symlink/hardlink；Windows ACL 未实现，拒绝而非伪称可用。示例路径不是私人部署位置。

```sh
install -d -m 700 /private/app-connector
# 安全编辑 /private/app-connector/config.json，chmod 600；禁止把 token 写入共享终端日志
node connectors/src/cli.mjs init /private/app-connector/config.json
node connectors/src/cli.mjs enqueue /private/app-connector/config.json /path/to/operation.json
node connectors/src/cli.mjs status /private/app-connector/config.json
node connectors/src/cli.mjs flush /private/app-connector/config.json
# 持续出站；SIGTERM/SIGINT 取消本连接器请求、关本库，保留原 pending/unknown
node connectors/src/cli.mjs run /private/app-connector/config.json
```

`enqueue` 不联网，成功后才表示本地持久；输入文件只读，不执行其内容。`flush` 每次至多 100 包，常驻每轮继续。`observe` 单独做一轮快照／流采集，不发事件服务 POST；流断开以失败退出且持久 disconnected，供隔离诊断。`run` 会持续重连；事件服务不可达不阻止本地观察，已保存传输仍保留。

配置固定服务根、owner、actor、source、epoch、installation 及 token 摘要；Uniflo origin／选择／token 摘要也固定。更换这些字段不能接管旧 spool。不得为了绕过阻塞换 ID、身份、新 spool 或服务根转投原未决内容。轮换与旧 spool 备份恢复尚无自动接续工具；先停发送并按原 ID／服务权威事实对账，不删除旧库。旧快照不能证明现在没发布过。

HTTP 只显式允许公网 HTTPS 根；开发 HTTP 需 `allow_loopback_http:true` 且准确 IP 回环。Uniflo 只接受固定 IP 回环 origin，不使用 DNS／任意 callback URL，不跟随重定向；token 仅在 Authorization。管理员批准的服务根及其 TLS 是信任边界，不宣称客户端能防恶意服务器。

## 绑定协议，不能降级

需要服务端 `backend-next-source-binding`：

1. GET `/v1/source/self` 严格协议 `binding_protocol:1`，核准确 owner/actor/source/epoch 与当前 publish。404／旧协议／错身份零 POST。
2. 每个 POST 同时固定携带 header `x-notionapp-source-binding` 和 JSON `source_binding`，值为小写 SHA256（UTF-8 `JSON.stringify([owner_id,id,source_id,source_epoch])`）。producer 不可自选此字段。
3. 服务端实际同步门重读当前认证并核绑定，先于原事务／旧幂等回执；然后剥离传输字段，不改变旧业务幂等摘要。GET 不是写许可。
4. 即便预检后到达旧版，旧严格 schema 仍因额外正文绑定字段 422、零业务写入；**不能删字段或只保请求头降级**。

正文固定后才发请求，注入字段后的完整 HTTP 包仍 ≤65536 字节。断网、5xx、ACK 丢失或本机记录失败，只能用完全相同的路径／ID／正文重放**服务端数据库发布**，不代表外部动作可重试。4xx／版本冲突持久 blocked，FIFO 后续不越过阻塞；不会按新版本自动 rebase。回执须准确关联原 event/version 才记录保存，不凭 HTTP 200 标来源收件。

## 脚本／自动化输入

见 `examples/create.json`、`examples/update.json`。顶层只允许 `id,kind,payload`，update 另需准确 `event_id`。payload 沿用事件服务字段／交互／期限合同，额外字段拒绝。create 固定原 session_ref、target_revision；update 固定原 expected_event_version。稳定 producer ID 的同内容重入队返回原状态，异内容冲突；不是按相同文字永久去重。

没有 Webhook 入站、任意 URL／shell／工具插件执行或命令领取接口。脚本可以创建可回应卡片，但回应仍留服务端，只有原合同下已核实的来源执行门才能交付；本连接器不把 HTTP validate、read_responses、Uniflo 观察或 `/send` 当 AI 输入权。

## Uniflo 只读与断流边界

独立按公开协议实现，核对 `Crosery/uniflo@4dbda948068e2f8ce288dc2c2e56777ca88274e0`：
[API](https://github.com/Crosery/uniflo/blob/4dbda948068e2f8ce288dc2c2e56777ca88274e0/docs/api.md)、[schema v1](https://github.com/Crosery/uniflo/blob/4dbda948068e2f8ce288dc2c2e56777ca88274e0/docs/schema.md)。上游 MIT，未复制其代码、二进制或私人材料；本项目许可证仍由用户另定。

每次启动／重连先 GET health/schema=1，再 GET 各**显式 key**快照；不扫描 sessions/discovery 或历史消息。首连为每个明确选择建一张只读基线卡，后续同事件追加。session_ref 为安装绑定派生不透明引用，不是写回定位证据。

按每个快照 `x-uniflo-seq` 水位，以最小水位订阅；hello 是当前 head，不可据它跳过其后的 replay。按各来源水位去重；过滤导致全局跳号不是必然丢包。水位／metadata／outbox 同事务；满队列不越过未保存观察。未知 v1 类型忽略，UTF-8 分块有界解码，超长／非法／不完整行断流。

lagged、daemon 回退、EOF、元数据缺失／404 后的 event、解析失败都持久记录 gap/disconnected，下次重新快照；新快照只能补当前状态，**不证明丢失期间每条历史已恢复**。idle／turn_end 不是停工或完成，removed 只追加观察，不删服务事件，不重开用户完成／停止跟踪。上游 snapshot/seq 原子性和 replay 完整性仍依赖固定上游合同；没有真实 daemon/harness 支持矩阵通过结论。

## 容量、崩溃与诊断

- 最多 16 个明确 Uniflo 选择、累计 10000 个传输操作（含已确认记录），SQLite page 约 32 MiB，主库／WAL／SHM 各 32 MiB 检查。任一先满即拒绝／背压，不静默删除已承诺原包；未实现自动保留期／压缩／迁移。不是各项上限能同时装满的保证。
- 配置／producer 读取本身最多分配并读取限额+1字节，即使 fstat 后文件增长也不全量读入。正文 65536 字节，响应回执／self 各 4 KiB，snapshot／NDJSON 行各 64 KiB。HTTP 5 秒，单观察流 60 秒后按 gap 重连。没有永远在线／完整历史恢复承诺。
- 单写者独占 `.lock` 贯穿异步 flush／observe；同一库实例的并发 flush 明确拒绝，迟到／重复旧 ACK 也不覆盖较新映射。实际 SQLite 关闭成功才释放 lock（重复 close 幂等，不依赖新版本 isOpen getter）。正常关闭释放；SIGKILL 残留保守拒绝。操作员必须先**正面核实原精确进程已退出且无使用者**，保留原库后仅移走其旧 lock；本程序不根据 PID 重用／不存在或超时自动抢锁。测试只在已观察自有 child SIGKILL 后显式移除夹具锁。
- 未知 appID／schema／损坏库、空既有文件、路径替换与权限不符拒绝；不清库、不创建替代身份。配置／目录和同账户管理员是信任边界，不宣称抵御恶意同 UID 修改。
- 终端只输出聚合状态与固定安全错误，不输出 token、原 URL／请求体或上游异常。队列 blocked 和 unknown 需按原记录对账；没有“重置全部成功”按钮。

公开导出事实、同人限定FINAL PASS、作者/独审报告与发布者自跑结果分别见 [B发布说明](../docs/releases/connectors-candidate-b.md)。A原代码/缺陷历史保留，不由B结果覆盖；本README不为后端自身FINAL、真实Uniflo/设备或生产代签。
