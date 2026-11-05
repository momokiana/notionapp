# connector-004-B：显式v2、完整归档与持久有界扩容

独立 **`wip/connectors-004`** 从已公开003提交 `7cbbe67350806c54c7fda275955397cfe8972420` 增量消费准确36项source-only；较003源 **6新增／9修改／21同字节／0删除**，lock/transport/validation/uniflo不变。**不合main、不创建正式Release或联合backend结论，不自启005/其他产品。**

## 字节与原限定结论

- 原36项源表SHA256 **`cab133660418af02c0e20cae872f97cf7e00e0a5fe88541b1b2acd55c8558e87`**，发布者逐项核验持久冻结导出，不扫核心活树。
- 原B37项表（36源码＋TASK）SHA256 `b3292ca856fdf6e35a4a5987eaa3b26d2bc1c9e07f30ddae597261663495bb90`；TASK SHA256 `18548af8ff0a6ea0286da36dd1848fdcbd7b4409fdaf19bdcb9b37bf1c5cedbb`，只核指纹/对应源码集合，不复制TASK。
- 同一独审原§8限定FINAL PASS/B：review SHA256 **`be4bce6f46849581d20b6244c0c62c182f47d673794af756bc77fb88ff4119e9`**。发布者不是替代独审，不读取或发布其原审查上下文；只核指纹、准确源码及实际消费范围。
- **004-A仍BLOCK/F1**：缺main但残留旧WAL/SHM时init可能新建空库并丢unknown。B在任何main创建/SQLite打开前lstat残留组，固定`ORPHAN_SPOOL_FILES`拒绝；坏类型、悬空链接或非ENOENT探测失败均保守保留，不导入/重接孤组、不清旧lock。只关闭准确B的反例，旧A、003及更早有限范围不倒改，也不把别的任务F1混为同一问题。
- 当前[逐项source/public哈希](connectors-004.json)分列；仅README作公开banner/范围适配，其余35文件保持原字节，原源表不改。公开36项表可按JSON顺序将`public_sha256`＋两空格＋路径＋LF重建，哈希另列JSON，不含新写release/root说明。

## 能力与不能推导的承诺

1. v1不自动迁移。显式`upgrade`只在原私有路径、原binding和单写者lock下工作：先耐久保存upgrading意图，才提高有界页限/提交v2，SQL与目录屏障后才ready。过渡期只能诊断或显式续upgrade，普通发送拒绝。`.storage`不是授权、业务账本或备份当前性证明，仍须核SQL和完整binding。
2. 同一SQLite新增archive，原十一字段/ID/指纹/payload/wire/ACK/目标完整保留；同事务复制、逐字段核对再移出工作queue。**pending/unknown绝不归档**，同ID历史/冲突、全局seq max+1、原水位/观察代次及旧ACK防map倒退保持。明确允许归档blocked仅释放工作额度，**仍全局FIFO阻断**，不是saved/skip或新目标重试。
3. 工作初始10000行/8MiB，archive100000行/64MiB；严格四项policy只增/相等并持久化，硬顶分别100000行/32MiB、1000000行/128MiB；v2页/各文件硬界256MiB。先到者背压，不保证能同时填满或磁盘永不耗尽。preview只读、不是预留票据，apply在事务内重算。
4. 维护用SQLite自己的TRUNCATE checkpoint并核0/0/0；读者阻塞则`MAINTENANCE_BUSY`，不驱逐读者、不手删WAL。批量按页/编码/实际费用保守预留写放大空间；回收工作额度及可重用页，不保证文件缩小，不做VACUUM。
5. COMMIT后本机屏障失败可能已经有事实，不能返回成功或反向抹掉已提交事实。维护不增加request_id账本，重跑archive可能选择下一批或moved=0，不是第一次不可变ACK。旧备份恢复/轮换/跨文件冷存储/保留期仍未实现，不得换库/ID/身份、清pending/unknown或已用事实假恢复。
6. 所有维护仅显式本地命令，0HTTP/模型/原生输入权，不抢锁、不杀已有连接器/Uniflo/生产进程。只读诊断仍是有界SQL snapshot与附近文件stat，可能创建/使用私有SHM；`persistence_ack:false`不证明新fsync、当前授权或来源收件。

## 分层复验（2026-11-05）

| 执行方 | 实际范围 | 不证明什么 |
| --- | --- | --- |
| 作者/原同一独审交接 | 双Node各92/92＋严格真v2/archive daemon2/2；独审另原脚本、15guard，其中13组零SQLite构造/零main open | 这些额外私有脚本是交接报告，发布者没有执行或迁签为亲测 |
| 发布者来源/隐私 | 原36表/逐项字节、37表源码子集、review/TASK指纹、6/9/21/0差异及固定工具摘要均核；未发现凭据/私人路径IP/真实会话设备等高风险匹配 | 是本次发布检查，不是新产品独审或绝对无秘密保证 |
| 发布者普通矩阵 | 持久源外POSIX副本、空HOME及新TMPDIR；Node22.13.0、22.23.2各语法检查＋**92/92，0失败/skip、退出0**；含原53日志回归、15维护自有child SIGKILL、实际SQLite FULL/注入EIO、原孤组、UTF-16、批量WAL、去重/FIFO等公开测试 | 不冒称再跑旧002任务、私有独审探针、宿主真正磁盘满或断电 |
| 发布者严格daemon | 双Node各 **2/2，0失败/skip、退出0**；结果明确`spool_schema:2`、`saved_transport_archived:true`；固定官方Uniflo0.2.6、新Bubblewrap CASE、两份自写Claude/Codex JSONL | **接收器为内部合成HTTP，不是实际backend/native receipt**；没有私人agent/model/live-PID或生产 |

环境：WSL2 Linux6.6.87.2 x86_64、Bubblewrap0.11.1。既有官方Node22.13 binary SHA256 `af8d5d1e234beb26b3095e6bebf80edc781f79c9435553a383037eccec2716f8`；Uniflo18720856字节、SHA256 `e5d8c89633bac3f08d7f3a2ef8dec702579aceaf63878b79bc254c4894e7c996`，均在执行前核。无工具下载/安装、无宿主fallback、无backend native加载；测试后36项源码哈希不变。`npm ci --ignore-scripts`成功、0运行依赖、报告0已知漏洞。

```sh
npm --prefix connectors ci --ignore-scripts
npm --prefix connectors run check
UNIFLO_BIN=/absolute/path/to/verified/uniflo npm --prefix connectors run uniflo:real
# 两个Node用同一普通测试和严格runner；禁止在22.13加载backend native
```

## 未覆盖与排除

N1不变：后端/in-process runner只记录22.23.2已验；现安装better-sqlite3在官方22.13单独open亦SIGSEGV，原因未定，不迁客户端内置SQLite绿证。backend自身FINAL仍未知/原拒绝不重试、不换通道或提供方，不借本轮限定PASS补签联合main或正式Release。

没有宿主真实ENOSPC/断电、256MiB填满/全超时饱和、任意OS/FS、私人harness/live-PID、手机/推送/生产或完整A27/A29证明。总archive/物理界耗尽仍须保全事实并背压，不提供无限存储/恢复保证。

只上传36项source-only及安全说明；TASK/review/raw evidence、CASE/spool/storage运行标记、工具binary、私有配置/凭据不上传；不读核心活树、不改共享路线、不恢复其他线或暂停核心审查/模型/云端。产品许可证仍未选，既有第三方/上游声明不变。旧003及更早发布提交/清单/审查边界保留，本次另立哈希和结果。
