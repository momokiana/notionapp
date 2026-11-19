# 用 Docker 部署中转服务

## 一条命令

```sh
curl -fsSL https://raw.githubusercontent.com/Crosery/herdr-pocket/main/scripts/install-relay.sh | sudo bash -s -- --domain pocket.example.com
```

先把域名的 DNS 记录指向这台服务器，并放开 80、443 端口。脚本会：

1. 在 `/opt/herdr-pocket` 写好 `compose.yml`、`.env`（Compose 设置）和 `relay.env`（中转服务设置，含自动生成的管理员令牌，权限 600）。
2. 启动中转服务和 Caddy，Caddy 自动申请和续期 HTTPS 证书。
3. 等健康检查 `/v1/health` 通过，打印第一台设备用的设置码和二维码。
4. 装好管理命令 `herdr-pocket-relay`。

换一种访问方式：

| 参数 | 效果 |
|---|---|
| `--domain <域名>` | Caddy + 自动 HTTPS |
| `--tunnel <token> --domain <域名>` | Cloudflare Tunnel，不开端口，见 [cloudflare-tunnel.md](cloudflare-tunnel.md) |
| `--tunnel quick` | 临时的 `*.trycloudflare.com` 地址，只适合试用 |
| `--port <端口>` | 只开一个 HTTP 端口（局域网或自己的反代） |
| `--image <镜像>` | 用别的镜像，比如自己构建的 |
| `--version <x.y.z>` | 装指定版本（默认最新） |

再跑一次脚本就能改设置或修复，`relay.env` 会保留。不带访问方式参数重跑时沿用原来的方式。

## 管理

```sh
sudo herdr-pocket-relay status    # 容器状态和健康检查
sudo herdr-pocket-relay logs      # 容器的实时输出
sudo herdr-pocket-relay restart   # 改了 relay.env 之后
sudo herdr-pocket-relay update    # 拉最新镜像并重启，数据保留
sudo herdr-pocket-relay setup     # 还没有设备时再显示设置码
```

`update` 做的就是 `docker compose pull && docker compose up -d`，在 `/opt/herdr-pocket` 里手动跑效果一样。助理的模型和密钥写在 `relay.env` 里，所有选项见 [deploy/relay.env.example](../../deploy/relay.env.example) 和 [config.md](../config.md)。设备、助理和各端日志在 `/admin` 控制台和 `herdr-pocket logs` 里看，见 [README.md](README.md#查看运行情况)。

## 不用脚本

把 [deploy/docker/compose.yml](../../deploy/docker/compose.yml) 放进一个空目录，旁边建 `.env`：

```sh
COMPOSE_PROFILES=caddy          # 留空：只开端口；caddy；tunnel；quicktunnel
POCKET_DOMAIN=pocket.example.com
RELAY_BIND=127.0.0.1            # 前面有 Caddy 或隧道时只给本机
RELAY_PORT=7420
TUNNEL_TOKEN=                   # tunnel 方式填
```

再建 `relay.env`（至少写 `POCKET_PUBLIC_URL=https://pocket.example.com` 和 `POCKET_TRUST_PROXY=1`），然后 `docker compose up -d`。

只要镜像也可以：

```sh
docker run -d --name herdr-pocket -p 7420:7420 -v herdr-pocket-data:/data \
  -e POCKET_PUBLIC_URL=http://<服务器地址>:7420 ghcr.io/crosery/herdr-pocket-relay:latest
docker logs herdr-pocket 2>&1 | grep 'setup code'      # 第一台设备用的设置码
```

从源码构建镜像：`docker compose -f deploy/docker/compose.yml -f deploy/docker/compose.build.yml up -d --build`。

## 镜像

- `ghcr.io/crosery/herdr-pocket-relay`，标签 `latest`、`x.y.z`、`x.y`，amd64 和 arm64。
- 数据在卷 `/data`（`/data/relay.db`）。进程以 `node` 用户（uid 1000）运行；平台挂进来的卷如果属于 root，启动时会先把 `/data` 交给 uid 1000 再降权。
- 健康检查：`GET /v1/health`。

## 备份

```sh
cd /opt/herdr-pocket
docker compose stop relay
docker run --rm -v herdr-pocket_data:/data -v "$PWD":/backup alpine tar czf /backup/relay-data.tgz -C /data .
docker compose start relay
```

恢复时反过来解压到同一个卷。`relay.env` 也一起备份。
