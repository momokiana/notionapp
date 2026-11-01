# android-001：本机回应草稿与快捷回复

本页保留android-001历史发布：从 `main` 基线 `0f9489bb316f921f24ad88c949e56e84aee1358c` 增量公开59项源码，源/公开哈希按当时字节保留，不用后继修复回写旧哈希。**001本身不包含android-002，也不是完整产品发行；当前main的后继002另见[准确新范围](android-002.md)。**

## 源码与审查绑定

- 当前原始清单 SHA256：`e1647f226f484da676c69e3180f655fb301990b0938ddc77f8cecee85d206afb`。
- 前一53项来源清单：`b02c8fd3505eaae16fd74f6e322bdd111d0d3937b4c147ecc249d0a7da7c76eb`；独立计算差异为 **6新增／6修改／0删除**，不读取私有delta证据作为上传内容。
- [当前59项源/公开哈希与准确差异](android-001.json) 单列；[首轮清单](initial-export.json) 保留为历史，不覆盖旧哈希。只有组件README按公开用途整理，58项其余文件与本次冻结源逐字节一致；业务代码不由发布者修改。
- 交接报告：同一独审完成PLAN审查及**限定FINAL PASS**，作者已实读接收并完成末次哈希核验。准确TASK内容哈希 `942a1cb8336dc9baf8ced5397876a8e319968d461c4813e3ecbf2cc07cbb7a53`；准确review内容哈希 `80874f7f61504d732d41af2eb22374675c721e2a8489663abec0260cee4ed598`。
- 上述是已接收交接的限定结论，不是发布者代签产品独审。私有TASK/review、原始日志、AVD资料和图片不复制；不把结论扩展到后续android-002、物理设备、生产或经改动的其他字节。

## 已知限制：跨owner A→B→A缓存并发不在001通过范围

开发/审查交接补充确认：001及更早缓存源码也沿用分页GET“每页临时取当前凭据、末尾才核namespace”的旧模式。发生owner A→B→A切换时，末尾namespace恢复为A不能证明中间每页都使用同一owner凭据；001发布快照的缓存存在这类并发隔离风险，**不得把001限定PASS、111项或原AVD结果说成已验证该场景隔离安全**。草稿/快捷回复的既有功能与缓存读取隔离的验证边界须分开。

本次只补正文档，不把001原限定FINAL PASS改签为缓存ABA通过，也不伪造001新的审查结论。其原源码、审查哈希、测试结果与提交历史保留。发布者没有在此次说明更正中重新执行产品测试或独立复现原反例。

后继android-002的旧预审曾有缓存ABA **BLOCK/F1**，该历史继续保留。首次范围更正 `68fa58f` 时仅新源原反例关闭、整体仍待审；随后作者交接确认002最终e334来源表已获同一独审**限定FINAL PASS／F1关闭**，review `2608d081974d62b245cf01c17957dca90effed8d08de721877b4a94db457fad5`，现在按[002独立清单与范围](android-002.md)发布。它是后继缓存隔离修复，不是旧001源码自动已修复/通过；不迁签旧PASS、不抹掉旧BLOCK，也不上传原始证据。

## 能力与失败边界

1. 原连接namespace隔离的持久本机回应草稿，可离线明确保存；网络恢复/回前台只读刷新，不自动提交。
2. 发送前对准确原事件联网重核并展示原版本/当前内容，用户确认后再次核验；问题、动作、来源或资格变化不自动改绑。
3. 原AtomicFile状态一次将草稿移入原Pending并保留恢复材料，然后才POST。unknown后只按原ID/正文对账，不同时保留可再次发送的第二份草稿；仅首次明确无效果拒绝可恢复原草稿。
4. 本机全局快捷回复的增改删与只追加插入；不覆盖原输入、不触发发送、不携带私人默认人格/授权。原凭据、身份转换、未决槽和回应门保持。
5. 草稿最多8份、每份文字4000个Unicode字符；快捷回复最多12条、名称40/正文1000字符。仍共用128KiB加密状态上限，超限背压，数量上限不保证能同时装满。离线内容窗口/容量治理属于后续android-002，不在此快照。

## 分层验证

以下明确区分交接报告与发布者实际执行，不把JVM/可编译APK当Android界面、硬件或生产证明：

| 执行方 | 准确范围 / 结果 | 未覆盖 |
| --- | --- | --- |
| 作者（交接报告） | 111/111 JVM含真实回环HTTP/SQLite socket，0失败/skip；debug、未签名release及独立测试APK构建；debug/release lint各0 Error、2 Warning、1 Information | 不是正式签名/分发，物理设备与生产未验 |
| 作者Android平台（交接报告） | 自有API35 AVD：离线保存草稿与快捷回复、重启/升级保留准确密文状态、联网GET不提交、v1草稿对照当前v2再次确认，显式操作只保存一次原文字回应 | 不证明物理设备/厂商矩阵、模型/来源执行或生产 |
| 同一独审（交接报告） | 独立重建/执行111项真实socket测试及另3项边界验证，限定FINAL PASS | 独审未操作AVD、未重建APK；发布者不虚构3项probe的额外范围 |
| 发布者 | 已独立核验59项来源/旧公开基线哈希，核算6新增/6修改/0删除；扫描凭据、SSH、私人路径/IP、设备/原生会话ID、固定端点/运行材料与第三方声明，未发现需公开的私人材料 | 发布自检不是新的产品独审或绝对无秘密保证 |
| 发布者镜像复验（已完成） | 真实socket/JVM **111/111通过，0失败/error/skip**；debug、未签名release、独立测试APK均成功构建；debug/release lint各 **0 Error、2 Warning、1 Information** | 未操作ADB/AVD、手机、云端或模型；APK仅本机构建，不分发 |

发布者复验使用与公开Server一致的独立POSIX构建和相同公开`contract-fixture.mjs`，只启动新私有临时库/凭据/回环端口，Android输出与项目缓存仅写公开镜像；不读写活跃后端或安卓目录。实际构建命令为：

```sh
# 先在独立副本安装并构建同一公开server，再从公开镜像根调用相同夹具：
node android/tools/contract-fixture.mjs "$PWD/android/gradlew" --no-daemon \
  app:testDebugUnitTest app:assembleDebug app:assembleRelease \
  app:assembleDebugAndroidTest app:lintDebug app:lintRelease --rerun-tasks
```

发布者已读取本轮JUnit XML与debug/release lint XML确认上述计数，并核对三种APK实际生成；Gradle命令退出0。生成的全部APK、lint/XML/HTML报告、临时凭据/数据库及日志保留本地，不上传。测试APK中的StateEvidence只作为独立测试工具源码保留，不进入正式App诊断入口；本次发布没有运行instrumentation。

## 发布排除项

不上传任何evidence、缓存、APK/签名材料、原平台/设备资料、真实会话/正文/人格、授权/凭据、数据库/WAL/native、推送端点或运行输出。新增`draft-emulator-fixture.mjs`只有合成夹具源码，不附其生成材料。依赖锁、构建版本、Gradle wrapper和第三方声明相对上次未变；未新增产品LICENSE。
