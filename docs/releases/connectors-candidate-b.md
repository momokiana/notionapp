# 连接器B：限定FINAL PASS，联合稳定发布待后端独审

本分支 `wip/connectors-candidate-b` 从已公开的main文档更正提交 `92c57e36af92b6c4fe166b63027fbc43b04cc5de` 派生，只增加连接器B源码及公开说明，**不合入main、不导入source-binding或T014、不创建正式Release**。

## 精确范围与限定审查

- 独立冻结source-only白名单21项，SHA256SUMS表哈希 `47d7997378e9415bd3814afcafe571405c68857c6204a51e240173c835b9746f`；[逐项源/公开哈希](connectors-candidate-b.json) 与 [A旧历史](https://github.com/momokiana/notionapp/blob/be573a8b6dc2fa6a007dd077365e090559dc5887/docs/releases/connectors-candidate-a.md) 分开保存。
- 对照A原始来源：4个源码和README修改，新增 `test/regressions.test.mjs`，其余原样，0删除。本分支保留全部B的21项；仅组件README补充公开候选/依赖状态和N1，20项其余文件与冻结B逐字节一致。
- 用户/作者最终交接确认：**同一独审限定FINAL PASS，F1/F2/F3在准确B关闭；A仍FINAL BLOCK。** 交接中的原独审候选清单哈希为 `31ddea1bfee9c75914b3dd06fe3ca67b7e208b4ee4f98a21b337b91cef28acaa`，不是本次21项公开清单；不混淆两者或原样导出私有审查/证据。
- B修复：同库并发flush拒绝重入，迟到/重复旧ACK不回退较新映射；实际SQLite关闭成功才释放锁，支持最低客户端版本的真实close；配置/producer文件读入有界，即使fstat后增长也只读限额＋1。
- 发布者不是新的产品独审，不把其自跑测试当原审查probe或联合验收，也不将B结论迁给A。A分支及其原代码/缺陷历史保留，不重写或升级为通过。

## N1：运行组合必须保持区分

| 组合 | 已取得的实际范围 | 边界 |
| --- | --- | --- |
| connector **22.13.0 / 22.23.2** → 独立backend **22.23.2** | 连接器作者/同一独审交接报告已验证分进程实际HTTP链路 | 客户端内置node:sqlite不代表后端native驱动支持22.13 |
| 当前安装backend better-sqlite3 **13.0.3** + 官方Node **22.13.0** | 开发/独审同步：连单独open亦SIGSEGV | **原因未定，不支持该backend或in-process integration-runner的22.13组合**；不外推所有平台或重建二进制 |
| 当前公开后端/Pi + Node **22.23.2** | 先前发布者对其公开字节做过本机隔离验证 | 不推出全部Node22/24或其他平台兼容；见[运行验证矩阵](../status.md) |

`test/integration-runner.mjs` 在同一进程导入后端native模块，所以只能按已验证的backend Node22.23.2运行，不能用客户端22.13绿证替代。包内engines范围是声明而非完整矩阵；本机 `NAPI_VERSION=10` 配置不是SIGSEGV根因证明。**不改锁包、依赖或构建参数来伪造兼容；发布者未重复触发已知崩溃组合。**

## 分层验证

| 执行方 | 准确结果 / 范围 | 不代表什么 |
| --- | --- | --- |
| 作者/同一独审交接 | connector22.13.0与22.23.2各34/34；原独审probe各5/5，新增边界各6/6 | 发布者没有代跑/代签这些独审probe |
| 作者交接的实际后端集成 | 3/3及2/2链路/降级验证；关联独立source-binding67项候选，原始表哈希 `b43957d21874d5b716923ec3570d03c12f7422ff7957bd0066175cd318b3a186` | 只是B依赖的测试对象，不是后端自身FINAL通过 |
| 独审交接的分进程实际HTTP | 每个connector运行时各5/5，backend22.23.2 | 不能据此批准backend22.13、联合稳定合并或生产 |
| 发布者独立自检 | 21项白名单/哈希及来源delta核对，扫描凭据/SSH/私人地址路径/会话与运行资料；只保留明显合成占位数据；npm安装成功且报告0已知漏洞 | 发布自检不是新的产品审查或绝对无秘密保证 |
| 发布者Node22.23.2自跑 | `npm --prefix connectors run check`：语法检查及34/34，0失败/skip | 只是当前B公开业务字节的本机自动化，不是原独审或新后端正常集成 |
| 发布者旧后端验证 | 使用既有公开T013后端的独立副本，以Node22.23.2运行 `--legacy`：1/1通过，0失败/skip | 只证明缺协议时fail-closed，**不是新协议正常发布通过** |
| 发布者Node22.13.0自跑 | 已核现成工具版本/哈希，5个源码语法检查及connector内置SQLite相关 **34/34通过，0失败/skip** | 未运行integration-runner、未加载backend native；不能推导backend22.13通过 |

发布者测试只用新POSIX私有scratch、空HOME、新TMPDIR及回环合成服务，不扫活跃连接器/后端，不读原运行数据。原始日志、probe、fixture配置/库与任何私有资料不在公开白名单中。

## 联合稳定合并仍有独立前置

截至此次协调，服务端明确source-binding只有PLAN结论，**其自身FINAL尚未给出**。本分支继承的T013 Server不含 `GET /v1/source/self` 新协议和写入实际门的source_binding核验，正常集成不能在当前公开树冒作成功，也不能删绑定字段降级。

服务端只会在本人接收准确最终结论后给出窄接口稳定增量（routes、source-binding源码、对应测试和README）及依赖闭包；发布者届时核准确字节并串行整合，不取T014活树、不因B PASS代签后端。B现在可单独公开其限定源码，但不是已完成的联合产品链路。

未验：真实Uniflo daemon/harness矩阵、Windows ACL、物理文件系统故障/断电、Android/物理设备、生产、完整A15/A16/A29、远程原生执行及旧spool自动恢复/凭据迁移。不附实际部署/凭据/会话/推送端点、原始evidence或依赖二进制；产品LICENSE仍未选择，原上游协议/第三方声明保留。
