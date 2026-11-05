# 本地出站连接器 — 003-B容量/诊断，限定FINAL PASS

> 独立分支 `wip/connectors-003` 只公开准确003-B的30项源码：同一独审§7限定FINAL PASS，**003-A仍BLOCK/F1，不迁签**。8MiB逻辑保留预算、只读SQL诊断及背压不是GC/迁移或执行授权。旧临时快照已失效，本次使用按原31项清单与review指纹恢复重建、原30项哈希不变的新导出，不冒称旧目录仍在。详见 [来源/公开哈希与分层复验](../docs/releases/connectors-003.md)。**未合入main，backend自身FINAL未知，真实daemon发布接收器仍是HTTP夹具，不是backend/native receipt或生产。**

POSIX CLI/库，包声明Node>=22.13，实际仅报告22.13.0/22.23.2的限定矩阵；使用内置 `node:sqlite`（Node22提示ExperimentalWarning），没有第三方运行依赖。不开放入站端口、不执行shell、不发现私人会话目录。N1不变：当前backend/in-process runner只按22.23.2验证；现安装better-sqlite3在22.13单独open亦SIGSEGV，原因未定，不可迁用connector绿证。

- 脚本、CI、定时任务：把严格 JSON 数据文件入队，连接器主动向同一个事件服务发布。
- Uniflo：显式选择会话，只 GET 当前快照与 NDJSON，映射为无交互只读事件与原事件 progress；不上传会话正文、路径、标题、preview、工具参数、reasoning 或原生 ID。
- 服务端仍是唯一事件／回应／命令／通知账本。本地 SQLite 只存传输原包、发布回执与观察映射／水位；`connector_persisted` 不是服务已保存，`event_saved` 也不是手机或原会话收件、执行或验证。

## 检查

```sh
npm --prefix connectors ci
npm --prefix connectors run check
# backend/native runner仅由Node22.23.2运行；正常绑定集成仍待backend自身FINAL
# 本独立分支继承的公开T013后端未包含新source-binding，不称联合通过
npm --prefix connectors run integration
# 明确验证旧服务端拒绝绑定发布，不把它称正常新协议集成
node connectors/test/integration-runner.mjs /absolute/public-server-tree --legacy
```

普通测试使用全新私有临时目录和回环 HTTP 合成协议夹具；`integration` 只复制 server/src 和 package/lock 到源外 scratch，前后核 hash，再以实际 Fastify/CoreStore/SQLite 测试。不编译或修改共享 server，不读取 data、生产配置、部署或 evidence。普通check不代表真实 Uniflo daemon、私人 harness、手机或生产验收；真实公开daemon另有下文显式隔离入口。后端原生二进制的实际运行组合独立于连接器最低Node版本：当前已验后端/in-process integration runner为22.23.2，不能在22.13加载现安装better-sqlite3后推定受支持（已观察该组合独立open也SIGSEGV，根因未定）。

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

`enqueue` 不联网，成功后才表示本地持久；输入文件只读，不执行其内容。`flush` 每次至多 100 包，常驻每轮继续。`observe` 单独做一轮快照／流采集，不发事件服务 POST；流断开以失败退出且持久 disconnected，供隔离诊断。`run` 会持续重连；事件服务不可达时只要仍有本地容量，就可继续观察；已知背压则先处理旧传输并暂停新采集，不轮询来源、不递增观察代次。已保存传输仍保留，flush成功不承诺腾出新准入额度。

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

按每个快照 `x-uniflo-seq` 水位，以最小水位订阅；hello 是当前 head，不可据它跳过其后的 replay。按各来源水位去重；过滤导致全局跳号不是必然丢包。水位／metadata／outbox 同事务；新轮次不预清原maps水位，已知近满先背压；低seq重基线只在当前代次的首次成功snapshot事务接受，同代live仍不回退。满队列不越过未保存观察。未知 v1 类型忽略，UTF-8 分块有界解码，超长／非法／不完整行断流。

lagged、daemon 回退、EOF、元数据缺失／404 后的 event、解析失败都持久记录 gap/disconnected，下次重新快照；新快照只能补当前状态，**不证明丢失期间每条历史已恢复**。idle／turn_end 不是停工或完成，removed 只追加观察，不删服务事件，不重开用户完成／停止跟踪。上游 snapshot/seq 原子性和 replay 完整性仍依赖固定上游合同；真实公开daemon的有限复现矩阵见下文，不扩展为私人会话或所有harness支持。

## 真实公开 daemon 隔离复现（opt-in）

```sh
UNIFLO_BIN=/absolute/path/to/verified/uniflo npm --prefix connectors run uniflo:real
# 指定另一已核官方Node工具时直接运行同一runner，不加载backend/native addon：
UNIFLO_BIN=/absolute/path/to/verified/uniflo /absolute/path/to/node test/real-uniflo-runner.mjs
# 上一行在connectors目录运行；仓库根则用 connectors/test/real-uniflo-runner.mjs
```

`UNIFLO_BIN`必须是官方v0.2.6 Linux x86_64 musl二进制，完整SHA256 **`e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996`**。对应[官方归档](https://github.com/Crosery/uniflo/releases/download/v0.2.6/uniflo-0.2.6-x86_64-unknown-linux-musl.tar.gz) SHA256 **`3787f11f7a46581a86eb6101dd9b5905ad0a28d80cc96ae2806d16a62b631973`**，同release SHA256SUMS核对；固定表在 `test/real-uniflo-artifact.mjs`。不自动下载、安装、运行setup/update或安装脚本，二进制及其第三方notice不进本仓库。

这是Linux专用测试，不是用户生产daemon管理器。需要可用的 `/usr/bin/bwrap` 与源码中列明的必要系统库布局；工具缺失、摘要不符、隔离不成立或测试失败均非零退出，**不skip／不fallback到宿主运行**。实际环境矩阵限定WSL2 Linux6.6 x86_64、bwrap0.11.1、官方Uniflo上述二进制、Node22.13.0／22.23.2及自写Claude/Codex JSONL布局；不是所有Node／发行版／macOS／Windows支持声明。

runner新建0700合成case，只挂精确公共Node／必要库／固定Uniflo／源码allowlist副本；新user/mount/PID/proc/net/IPC/UTS及固定hostname，网络只有内部loopback。宿主home/mnt/项目／部署不挂入，环境clearenv，root/proc/dev/程序只读，工作与临时数据都在新case。外层先故意让自己的合成canary进入worker stdin/fd3；worker再只向bwrap提供 `/dev/null` stdin及新的有界stdout/stderr管道，内层实核canary inode不可见。daemon同样不继承宿主FD/环境；隔离断言失败不会继续启动daemon。

实际前台daemon固定read-only/no-cache/no-update-check/no-price-sync/no-fts，随机测试Bearer只在私有env/请求头。test-only的准确synthetic transcript GET校验两个decoder的Unicode，以及带正确Bearer/写header的空cleanup-plan只读403对照，不是连接器新增历史读取／写入能力。连接器实际请求仍只有health／显式snapshot／NDJSON。

覆盖快照之间真实文件变化、实际hello/backlog与不同水位、两种格式实时追加、未选择来源、纯metadata隐私、正常断流／同spool重启、只杀自己准确child的SIGKILL故障后非主动abort的gap／再次重启。原映射只追加current snapshot，不把离线期间全部历史补称连续。上游SIGINT采用graceful drain：runner发送SIGINT后显式取消自己的长流再等正常退出；不会将超时后的SIGKILL伪装为graceful成功。

**发布接收器只是内部合成HTTP协议夹具，不是实际backend／独立来源回执。** 原backend接缝验证另见其入口和项目路线；本测试不在22.13加载better-sqlite3，不代表AI/Claude/Codex程序实际运行、live-PID附着、模型／工具执行、33种harness、真实用户会话、手机或生产。case资料留在测试输出的私有临时目录；仅源码/安全合成fixtures可公开，不上传raw日志、spool或工具。

## 容量、崩溃与诊断

- 最多16个明确Uniflo选择、累计10000个操作（含saved/blocked）、**8MiB逻辑保留预算**；SQLite页上限按实际page_size折算32MiB，主库/WAL/SHM/journal各32MiB检查。每行按实际UTF-8 payload、至少payload+256的未来wire、至少1024的ACK、映射及行余量保守收费，另留binding/meta/map余量；不是当前文件大小或能同时装满各上限的保证。WAL/journal距硬边界不足1MiB即保守停止写入，不手动删/截WAL、不猜checkpoint成功；真正存储失败可使已有传输也暂时不能处理。
- 新准入在IMMEDIATE事务内核准，满时旧同ID同内容仍可按原耐久屏障对账，异内容仍冲突。新逻辑限额不挡已有eligible prepare/原wire重放/准确ACK保存；过新预算的合法v1库保留为retained_over_limit，不清旧事实。容量投影是预测，具体包仍由事务核准；CLI固定产品限额，库的更小测试限额仅当前实例、不持久化成新政策；观察另按每个所选来源16KiB与一个行位保守预留，近满即暂停，不反复开始注定放不下的新轮次。没有GC/delete/VACUUM/自动新库，额度可能一直耗尽；安全迁移/轮换、保留期仍是后继，不可删pending/unknown/旧映射/已用事实来恢复。
- 配置／producer 读取本身最多分配并读取限额+1字节，即使 fstat 后文件增长也不全量读入。正文 65536 字节，响应回执／self 各 4 KiB，snapshot／NDJSON 行各 64 KiB。HTTP 5 秒，单观察流 60 秒后按 gap 重连。没有永远在线／完整历史恢复承诺。
- 单写者独占 `.lock` 贯穿异步 flush／observe；同一库实例的并发flush或observe明确拒绝，旧轮次错误收尾不覆盖新代次，迟到／重复旧ACK也不覆盖较新映射。实际 SQLite 关闭成功才释放 lock（重复 close 幂等，不依赖新版本 isOpen getter）。正常关闭释放；SIGKILL 残留保守拒绝。操作员必须先**正面核实原精确进程已退出且无使用者**，保留原库后仅移走其旧 lock；本程序不根据 PID 重用／不存在或超时自动抢锁。测试只在已观察自有 child SIGKILL 后显式移除夹具锁。
- 未知 appID／schema／损坏库、空既有文件、路径替换与权限不符拒绝；不清库、不创建替代身份。配置／目录和同账户管理员是信任边界，不宣称抵御恶意同 UID 修改。
- `status`用独立SQL只读连接，不取/移除写者lock、不建缺库、不联网，在同一read snapshot先验格式/binding再输出≤8KiB聚合（计数、保留/实际payload-wire-ACK字节、限额、首未结项、观察与文件stat）。文件stat是附近时点，不与SQL提交全局原子；lock只报present/absent、不证明存活。超32MiB文件仅stat，scope_validation:not_checked、业务计数null、不打开SQLite。错误身份/格式/路径/权限非零拒绝。SQL只读可能使用/新建私有SHM，不是物理零写取证工具。
- 诊断标diagnostic_only:true/persistence_ack:false：可读saved行不证明本次目录fsync或来源在线，不补发持久ACK，不授当前发送/回应/执行权。原保存/重复回执仍走写者耐久屏障。终端仅固定原因，不输出token/摘要、原URL/key/正文/路径或上游/SQL异常；run分别按采集/发布/容量阶段及原因抑制重复日志，只由对应阶段实际成功重置；新采集不伪造发布恢复。blocked/unknown须按原ID/原目标对账；没有reset/force/clear按钮。

本次来源重建、30项source/public哈希、003-A旧BLOCK、003-B限定审查与发布者实际53＋严格daemon2矩阵见 [003发布说明](../docs/releases/connectors-003.md)。不复制TASK/原review/raw evidence/CASE/spool/工具；002及更早历史保留，未覆盖项不因本轮绿证自动通过。
