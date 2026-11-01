# 安卓账本客户端（既有开发基线）

Kotlin 2.1.20 / Compose / Material3；minSdk 26，target/compile 35；AGP 8.9.1、Gradle 8.13、JDK 17。`dev.notifier.app` 为开发包名，不是正式品牌。

本次导入为作者冻结的既有基线，**不含后续 android-001 草稿/模板新功能**。历史测试或独审不自动成为此公开副本的新通过结论；本次执行结果见 [公开状态](../docs/status.md)。

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
- 当前没有自动逐出未知记录或完整容量治理；达到持久存储上限须背压，后续增量另行验证。

`tools/` 都是显式隔离夹具，不是生产部署器；运行材料含临时凭据，必须保持私有。`src/androidTest/` 的 StateEvidence 只进入独立测试 APK，不随正式 App 提供诊断入口。模拟器/ADB/物理设备操作仍需明确拥有的目标与授权，本次公开发布不运行它们。

## 第三方

UnifiedPush android-connector 2.4.0 从限定组的 JitPack 解析，POM 声明 Apache-2.0，未复制/修改其实现。App 内保留 `assets/third_party/NOTICES.txt` 与 Apache-2.0 文本。Kotlin / AndroidX / Gradle 依各自许可使用。Gradle wrapper 是未修改的官方 8.13 构建引导文件；本次核对其 SHA256 与官方发布值一致。未复制参考 App 代码、品牌或第三方 APK。

产品自身许可证仍未选择；上述第三方许可不授予本产品整体许可。
