# 当前状态与版本进度

> 主工程位于 [xiaoaixiaoai/](<../xiaoaixiaoai/README.md>)。早期多路线历史目录（`android/`、`web/`、`server/`、`pi-host/`、`pocket/`、`legacy/`）与历史 `wip/*` 分支已从主线清理；完整改动细节见 [xiaoaixiaoai/MODIFICATIONS.md](<../xiaoaixiaoai/MODIFICATIONS.md>)。

## 当前主线（0.1.9，2026-11-19）

- **产品与身份**：App 名 **小爱小爱**，助理名 **爱弥斯**；Android 包名 `dev.notifier.xiaoaixiaoai`，配对 scheme `xiaoaixiaoai`，自有发布签名，未配置自有发布源时默认关闭远程更新与网页下载。
- **0.1.0 首版真机闭环（2026-11-18）**：
  - 独立 HTTPS relay 已上线，完成独立 OpenAI/GPT 授权并启用文字模型（语音保持关闭）。
  - 用户在开启 VPN 的真机上独立验证了安装、扫码配对、GPT 文字聊天、历史恢复、断线自动重连以及后台预约提醒送达并点击打开 App。详见 [首版验收记录](<migrations/2026-11-17-xiaoaixiaoai-first-use.md>) 与 [真机验收清单](<xiaoaixiaoai-phone-check.md>)。
- **0.1.1 – 0.1.5 主题、字体与源码自有化（2026-11-18）**：
  - 落地星海蓝粉主题与星海手写字体，主工程迁入 `xiaoaixiaoai/`，包名、CLI 与 Android 原生桥接切换为自有命名，保持既有包名、签名、本地存储键和线上服务兼容。
- **0.1.6 – 0.1.8 项目会话与代理支持（2026-11-18）**：
  - 新增按需开启的 DSH / Codex 项目会话视图、DSH 全 profile 分页/搜索目录、手机本地关注列表，以及电脑端 `--relay-proxy`（支持经本地 HTTP CONNECT 代理连接 HTTPS relay）。详见 [项目会话说明](<../xiaoaixiaoai/docs/runtime-sessions.md>)。
- **0.1.9 DSH Profile 发送与后台任务通知（2026-11-19）**：
  - 支持对同一 DSH profile 显式授权发送、发送时按 exact-ID 唤醒未加载的现有会话，以及向发起任务的手机推送后台私密任务通知（进展 / 需决定 / 结束或停止，点击定位对应会话）。
  - 本地验证：类型检查通过；工作区测试 236 通过 / 1 平台跳过，脚本测试 43 通过，Android 检查 13 通过（lint 0 error），API 35 模拟器闭环验收通过。
  - 环境更新：线上独立 relay 已备份数据库并平滑升级至 `0.1.9`（健康检查与 WSL 重连通过）；WSL 电脑端 helper 已原地更新，DSH 插件已就位等待 DSH 下次正常启动生效。

## 当前边界与待推进项

- `0.1.9` APK 尚未在真实手机上安装验收，也未在重启真实 DSH 后向真实会话发送测试任务。
- 真机验收基于 VPN 链路，尚未覆盖无 VPN 直连；完整长期记忆与语音功能尚未启用。
- Windows Store 版 Codex Desktop 尚无已验证的直接附着路径（仅通过本机 App Server 夹具测试）。

## 公开仓库排除项

本仓库不提交私人服务器地址、SSH/证书/签名密钥、模型凭据与授权文件、设备/原生会话 ID、运行数据库（`.db`/`.sqlite`）、真实聊天或截图证据、APK/压缩包产物（`dist/`）、`node_modules/` 及本地构建缓存。
