# connector-002：固定官方daemon的限定验证，非联合发布

独立分支 **`wip/connectors-002`** 从main `0a745c88fbba495f145263e5384af24215c394b2` 派生，加入完整27项source-only白名单及公开说明；**不合main，不改A/B分支，不导入backend/source-binding/T014或宣称生产可用。**

## 来源、增量与审查边界

- 当前27项来源表SHA256：`88036d5b72e17728247cfd2d625bc919d6fb2f17c957d467e356c7ccf8dfba05`；[逐项source/public哈希](connectors-002.json)。只有组件README增加发布banner和范围限定，26项其余文件逐字节保持。
- 对照001-B来源表 `47d7997378e9415bd3814afcafe571405c68857c6204a51e240173c835b9746f`，独立核出**README＋package scripts两项修改、六个自写真实daemon测试模块新增、0删除**；其余19项、产品src与package-lock原字节不变。锁包没有新依赖，新增脚本为显式`uniflo:real`。
- 正式交接为同一独审**限定FINAL PASS**；原审候选清单指纹 `15185ded99d2fe523cf0c9e1e6a224fa6b27fba7301676504226146b7df0f815` 与27项公开表用途不同，不混淆为同一清单。发布者不代签产品独审，不复制原TASK/probe/raw evidence。
- [A旧BLOCK](https://github.com/momokiana/notionapp/blob/be573a8b6dc2fa6a007dd077365e090559dc5887/docs/releases/connectors-candidate-a.md)与[B限定结论](https://github.com/momokiana/notionapp/blob/f5b1f3743a30eaf36a62dfd6415d5d878d6d1fc8/docs/releases/connectors-candidate-b.md)及其源码/历史保持，不用002结果迁签旧字节。

## 究竟验证了什么

这是**真实官方Uniflo 0.2.6 daemon**读取两份独立自写的合成Claude/Codex JSONL布局，验证实际decoder/快照/hello与backlog/实时流、不同水位、断流及同spool重启；没有运行Claude/Codex agent、附着live PID或读取私人会话。未选择来源及标题/路径/正文等合成标记不得进入发布载荷。

发布接收器是隔离内部的**合成HTTP协议夹具，不是实际backend或原生收件**。GET synthetic transcript与带正确Bearer/write-header的空cleanup-plan 403只是测试上游decoder/read-only的对照，不是连接器新增历史读取或写入能力；连接器仍只用health、显式snapshot、NDJSON。

正常停止是SIGINT后取消测试自己持有的长流并实际等退出0；故障是对准确自有daemon child发SIGKILL、观察signal退出与非主动abort的gap，再按原spool重启，不把超时SIGKILL当graceful成功。只补当前快照，`history_complete:false`、`source_received:false`，不声称补齐断流期间全部历史。

## 固定制品与隔离

| 项目 | 准确限定 |
| --- | --- |
| 制品 | 官方Uniflo **0.2.6 Linux x86_64 musl**，18720856字节，binary SHA256 `e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996` |
| 官方归档 | [固定release URL](https://github.com/Crosery/uniflo/releases/download/v0.2.6/uniflo-0.2.6-x86_64-unknown-linux-musl.tar.gz)，archive SHA256 `3787f11f7a46581a86eb6101dd9b5905ad0a28d80cc96ae2806d16a62b631973`；固定常量见`test/real-uniflo-artifact.mjs` |
| 本次环境 | Linux6.6.87.2-microsoft-standard-WSL2 x86_64、Bubblewrap **0.11.1**、客户端Node **22.13.0 / 22.23.2** |
| 能力边界 | 新user/mount/PID/proc/net/IPC/UTS、clearenv、仅内部loopback；精确Node/必要库/固定制品/允许源码只读挂载，工作数据仅新0700合成CASE |

runner先向worker故意传入自己的合成canary stdin/fd3，再撤销传入能力，以`/dev/null`及新有界管道启动bwrap；内层验证canary inode不可见、宿主home/mnt不挂载、环境白名单及只读root/proc/dev，隔离失败不继续启动daemon。前台daemon固定read-only/no-cache/no-update-check/no-price-sync/no-fts；不运行setup/update/installer。

`UNIFLO_BIN`必须显式提供现有正确制品；**工具缺失、类型/哈希错误、隔离拒绝或测试失败均非零，不skip、不自动下载、不fallback到宿主daemon。** 发布者只核验既有工具的大小/哈希并运行，不复制工具或原作者CASE。

```sh
# 明确准备并自行核验官方制品及本平台bwrap条件；不自动下载或安装
UNIFLO_BIN=/absolute/path/to/verified/uniflo npm --prefix connectors run uniflo:real
# 另一已核Node可直接执行同一runner，仍不加载backend/native addon
UNIFLO_BIN=/absolute/path/to/verified/uniflo /absolute/path/to/node connectors/test/real-uniflo-runner.mjs
```

## 分层结果

| 执行方 | 实际范围 / 结果 | 不扩大为 |
| --- | --- | --- |
| 作者/同一独审交接 | 每个Node普通36/36、真实daemon 2/2，0 skip；独审另14拒绝边界＋2运行时对照通过，限定FINAL PASS | 发布者没有复演或代签这些私有额外probe |
| 发布者普通测试 | 新POSIX副本、空HOME、新TMPDIR；Node22.13.0和22.23.2各语法检查＋**36/36，0失败/skip**；npm安装报告0已知漏洞 | 普通check不证明daemon，缺工具拒绝用例不等于真daemon运行 |
| 发布者真实daemon | 独立核固定binary大小/哈希及工具版本；两个Node各在新Bubblewrap CASE运行上述真实daemon **2/2，0失败/skip，runner退出0**；内层隔离对照先通过才启动daemon | 合成两布局，不是实际agent/私人会话/所有harness；HTTP接收器不是backend |
| 发布自检 | 核27来源/文件哈希、19原样与准确8项delta，检查凭据/SSH/私人地址路径/真实会话设备ID与运行材料、许可边界；只保留明确合成的UUID/标记 | 不是完整产品安全审计或绝对无秘密证明 |

真实测试结果保留为本次私有CASE/日志，不原样上传。完整日志洪泛与完整上限timeout并未动态施加；代码存在预算/上限和拒绝路径，不等于这些场景已全覆盖。

## 后端、N1与未验项

**后端自身FINAL仍未取得，提供方访问中断不被重试/替代本测试绕过；联合main合并继续暂停。** 当前分支继承的公开T013后端没有新source-binding合同，002 PASS既不是后端FINAL，也不是实际backend集成通过。

N1不变：连接器内置SQLite的22.13/22.23与独立backend22.23.2的既有交接矩阵不得迁成backend22.13支持；当前安装better-sqlite3在22.13单独open亦SIGSEGV，原因未定。任何加载backend native的in-process runner只按已验证22.23.2使用；本轮真实daemon测试没有加载它，不改锁/驱动或猜测根因。

未验：live Claude/Codex进程或私人会话、live-PID附着、其余31种harness、其他OS/Node/文件系统矩阵、手机/推送/生产、完整A15/A16/A29、完整上限timeout/日志洪泛动态故障。官方binary/第三方notice随各自制品，本仓库不附这些二进制，不复制上游实现或原数据；原上游MIT协议说明保留，产品LICENSE仍未选择。
