# 部署到 Fly.io

用发布好的镜像，一台机器加一个卷放数据库。需要先装 `flyctl` 并 `fly auth login`。

```sh
# 1. 建应用：改 deploy/fly/fly.toml 里的 app（全局唯一）和 primary_region（例如 nrt、hkg、sin）
fly launch --config deploy/fly/fly.toml --copy-config --no-deploy --ha=false

# 2. 建卷（与 primary_region 同一地区）
fly volumes create herdr_pocket_data --size 1 --config deploy/fly/fly.toml

# 3. 手机和电脑用的地址
fly secrets set POCKET_PUBLIC_URL=https://<app>.fly.dev --config deploy/fly/fly.toml

# 4. 部署
fly deploy --config deploy/fly/fly.toml

# 5. 第一台设备的设置码和二维码
fly ssh console --config deploy/fly/fly.toml -C "herdr-pocket-relay setup"
```

然后电脑上 `--server https://<app>.fly.dev`，见 [host.md](host.md)。

要点：

- **只能一台机器**。`--ha=false` 防止 Fly 默认开两台；之后也不要 `fly scale count` 超过 1。
- 机器不会自动停（`auto_stop_machines = "off"`），因为电脑一直保持 WebSocket 连接。
- 助理的模型和密钥用 `fly secrets set POCKET_ASSISTANT_MODELS=... POCKET_DEEPSEEK_API_KEY=...` 设置，选项见 [config.md](../config.md)。
- 自己的域名：`fly certs add pocket.example.com`，再把 `POCKET_PUBLIC_URL` 改成它。

更新：`fly deploy --config deploy/fly/fly.toml` 会重新拉 `latest` 镜像，卷里的数据保留。
