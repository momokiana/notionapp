# 安卓账本客户端（android-002 缓存窗口与隔离修复）

Kotlin 2.1.20 / Compose / Material3；minSdk 26，target/compile 35；AGP 8.9.1、Gradle 8.13、JDK 17。`dev.notifier.app` 为开发包名，不是正式品牌。

当前为作者独立冻结的63项 android-002 源码：有界缓存区间/历史区间、明确内容清理，以及后继缓存owner-ABA隔离修复；保留001本机草稿与快捷回复。交接报告同一独审**限定FINAL PASS／F1关闭**；准确源/公开哈希、旧BLOCK与作者/独审/发布者分层验证见 [本次增量](../docs/releases/android-002.md)。**不含依赖未就绪的新对话/媒体/复杂卡片，也不是物理设备或生产验收。**

> **隔离修复有版本边界：001及更早缓存的逐页临时凭据/末尾namespace旧模式，不由001 PASS、111项或AVD证明A→B→A并发安全。** 当前002是在新字节上把六处缓存GET的完整读取置于现有身份门内，并由同一独审关闭原反例；002旧预审BLOCK和[001范围更正](../docs/releases/android-001.md)仍保留。新限定PASS不迁给旧源，也不承诺任意并发/平台或外部身份配置变更场景。

## 构建

准备 JDK 17、Android SDK platform 35 / build-tools 35.0.0，设置 `JAVA_HOME`、`ANDROID_HOME`，或在不提交的 `local.properties` 配置 `sdk.dir`。

```sh
cd android
./gradlew app:testDebugUnitTest app:assembleDebug app:lintDebug
./gradlew app:assembleRelease app:lintRelease
```

`app/gradle.lockfile` 固定解析结果；Gradle 8.13 发行 zip 有官方 SHA256 校验。APK 不入库；release 产物未正式签名，不是公开发行包。

真实本机 socket 合同测试需要先构建同仓库 server，从项目根执行：

```sh
npm --prefix server ci
npm --prefix server run build
node android/tools/contract-fixture.mjs "$PWD/android/gradlew" --no-daemon app:testDebugUnitTest --rerun-tasks
```

夹具创建新的私有凭据、SQLite 和回环端口。普通 JVM 测试中依赖该夹具的用例会 skip，不能计作通过；本地 socket 也不是 Android 后台或真机验证。

## 缓存区间、容量与读取隔离

- 收件箱按服务创建游标显示当前有界区间，每区间最多1000条；明确确认后可查看下一/上一/最早区间，超过1000的后续事件仍能访问。自动恢复只刷新当前区间，不自动翻区间，也不表示全库归档、跨页一致快照或更新订阅。
- 完整事件、已加载历史/回执、列表外详情、包装和导航连同28字节AEAD开销计入32MiB预算。只接收完整服务页和准确next_after；自动刷新不能在新容量边界用较短前缀覆盖旧完整缓存。
- 当前列表外可新开一个详情槽，第二份明确背压；旧合法格式中的多份列表外详情继续可读，不判损坏或自动逐出。显式换区间/清理才可移除相关内容。
- 历史每区间最多1000条，明确确认后可继续后续/前段/从创建重看，采用实际全局seq，不按条数偏移猜游标；较晚区间不伪称完整历史。
- 内容清理分为历史/回执、列表外详情、全部离线内容，绑定原namespace及准确缓存摘要。只改合法可读内容缓存，不改原用户/身份未决槽、草稿/模板或推送去重，不自动recover、POST或已读。坏缓存/缺key也不能借连接reset覆盖原文件。
- 六处缓存GET把每次资格核验和完整网络调用置于同一现有身份门内，避免核验后、实际取凭据/读页时穿插另一owner；这不表示整轮多页扫描是全局原子快照或禁止页间身份切换。A→B→A原反例的限定关闭证据属于新002，不覆盖旧001。导航、清理与观察时间的具体边界见源码/测试及[发布说明](../docs/releases/android-002.md)。

`tools/capacity-emulator-fixture.mjs` 为显式合成夹具：需已构建server并设置 `NOTIONAPP_CAPACITY_EMULATOR_FIXTURE=1`；仅新私有目录内准备1051条事件，不执行ADB、AI/模型、推送或假设备回执。生成的配置、请求记录与数据库保持私有；本次发布者不运行AVD或instrumentation。

## 本机草稿与快捷回复

- 离线可显式保存原事件/来源/问题代次/动作和完整文字；只是本机未发送草稿，不发HTTP。网络恢复、回前台或重新打开App不自动提交；未点击保存的编辑文字不承诺重开保留。
- 点击“联网核对草稿”只GET原事件，展示原版本与当前内容；问题/动作/来源改变或失去回应资格时保留原草稿，不自动改绑。离页、失前台、编辑、身份操作或重开会使预览失效。
- 用户明确“确认提交回应”后再次GET核对；内容变化需重新确认。真正提交时一次原AtomicFile保存将草稿移到原Pending并保留恢复材料，然后才进行网络写入。丢ACK只对账同一个稳定请求，不再出现可重复提交的第二份草稿。
- 仅首次明确无效果的业务拒绝可原子恢复草稿；unknown之后的拒绝不清原槽、不产生新ID。原请求恢复、身份门和服务端权限/版本仍有效。
- 草稿按连接namespace隔离，同设备可信轮换保留namespace；换连接/新配对不静默删除隔离草稿，删除须明确确认。快捷回复本机全局保留，可新增/修改/删除，只在现有文字后追加，不覆盖、不发送、不授予权限。
- 最多8份草稿、每份文字4000个Unicode字符；最多12条快捷回复，名称40/正文1000字符。与原凭据/未决意图共用128KiB加密状态上限，各数量不保证能同时装满；超限/写盘失败拒绝并保留原状态。

`tools/draft-emulator-fixture.mjs` 是显式隔离合成夹具，需先构建server并设置 `NOTIONAPP_DRAFT_EMULATOR_FIXTURE=1`；仅新建回环事件/凭据，推进原问题至v2供核对，不操作ADB、AI、推送或伪造设备回执。运行产生的配置/请求记录保持私有，不提交。本次发布不自行操作AVD或手机。

## 行为与限制

- 收件箱、详情、回应、历史、版本核验、事项决定、设备配对/凭据生命周期和分层回执，消费 [事件服务](../server/README.md) 的实际 API。
- 无默认服务地址或凭据。正式构建只准 HTTPS；debug 仅准回环 HTTP，不为公网 HTTP 增加白名单。拒绝跨重定向转发认证。
- Keystore AES-GCM / AtomicFile / noBackup 保存连接、未决请求及本机缓存。内容缓存只读恢复，联网刷新后才有新写资格；缓存不是当前授权。
- 首次发送前持久保存原 ID、完整正文及准确绑定。超时/认证失败不清 unknown，不通过换连接、凭据、ID 或卸载绕过去重。
- 身份轮换只有精确原设备/操作/摘要/版本匹配后才延续本机 namespace；配对是新身份，不凭同 owner 或标签猜延续。
- UnifiedPush connector 2.4.0 + WorkManager 2.10.1，无 Google 服务代码依赖。设备先核 nonce 与权威事件，系统提醒不带正文、无内联回应；已读须明确点击。
- 通知按版本去重；OS notify 崩溃窗保留 posting_unknown，不自动补发。系统请求过提醒不等于用户看见。
- 本机通知总开关、锁屏隐私、静默时段、来源静默不改变事件/来源效果。系统渠道、DND 和厂商省电仍可限制提醒。
- 来源运行观察是只读诊断，不是模型调用授权、收件回执或执行成功。
- 本轮只提供明确区间/内容清理与有界背压，不自动逐出未知记录、草稿或推送去重；不是完整保留期、迁移、性能或容量治理承诺。

`tools/` 都是显式隔离夹具，不是生产部署器；运行材料含临时凭据，必须保持私有。`src/androidTest/` 的 StateEvidence 只进入独立测试 APK，不随正式 App 提供诊断入口。模拟器/ADB/物理设备操作仍需明确拥有的目标与授权，本次公开发布不运行它们。

## 第三方

UnifiedPush android-connector 2.4.0 从限定组的 JitPack 解析，POM 声明 Apache-2.0，未复制/修改其实现。App 内保留 `assets/third_party/NOTICES.txt` 与 Apache-2.0 文本。Kotlin / AndroidX / Gradle 依各自许可使用。Gradle wrapper 是未修改的官方 8.13 构建引导文件；本次核对其 SHA256 与官方发布值一致。未复制参考 App 代码、品牌或第三方 APK。

产品自身许可证仍未选择；上述第三方许可不授予本产品整体许可。
