# Railway、Render、Zeabur、Kubernetes

这些平台都能直接跑发布好的镜像 `ghcr.io/crosery/herdr-pocket-relay:latest`。不管哪个平台，设置都一样：

| 项目 | 值 |
|---|---|
| 镜像 | `ghcr.io/crosery/herdr-pocket-relay:latest` |
| 端口 | `7420`（HTTP，带 WebSocket） |
| 持久卷 | 挂到 `/data`，1 GB 足够 |
| 实例数 | 1，不能多开 |
| 健康检查 | `GET /v1/health` |
| 环境变量 | `POCKET_PUBLIC_URL=https://<平台给的地址或你的域名>`，`POCKET_TRUST_PROXY=1` |

可选：`POCKET_ADMIN_TOKEN`（`/admin` 管理页用，至少 24 个字符）、助理模型和密钥（见 [config.md](../config.md)）。

部署好之后，在平台的控制台/Shell 里运行 `herdr-pocket-relay setup`，就能看到第一台设备的设置码；也可以直接看启动日志，里面打印了同样的设置码和链接。

没有持久卷的平台（或只有临时磁盘的免费档）不适合：每次重启数据库都会丢，所有设备要重新配对。

## Railway

1. New Project → Deploy a Docker Image → 填上面的镜像。
2. 服务的 Settings → Volumes：加一个卷，挂载路径 `/data`。
3. Variables：`POCKET_TRUST_PROXY=1`、`PORT=7420`。
4. Settings → Networking → Generate Domain（端口 7420），再把得到的地址填进 `POCKET_PUBLIC_URL`。

更新：服务菜单里 Redeploy 会重新拉 `latest`。

## Render

仓库里有 Blueprint：[deploy/render/render.yaml](../../deploy/render/render.yaml)。

1. New → Blueprint → 选这个仓库，Blueprint 路径填 `deploy/render/render.yaml`。
2. 部署完把 `POCKET_PUBLIC_URL` 设成服务的 `https://...onrender.com` 地址（或你的域名）。

持久磁盘需要付费实例（Blueprint 里是 starter）。更新：Manual Deploy → Deploy latest reference。

## Zeabur

1. 新建服务 → Docker 镜像 → 填上面的镜像。
2. 加一个 Volume，挂载目录 `/data`。
3. 网络里把端口 `7420` 设为 HTTP，并绑定域名。
4. 环境变量：`POCKET_PUBLIC_URL`、`POCKET_TRUST_PROXY=1`。

更新：重新部署服务即可拉取 `latest`。

## Kubernetes

[deploy/k8s/relay.yaml](../../deploy/k8s/relay.yaml)：一个 PVC、一个副本数为 1 的 Deployment（`Recreate` 策略，避免新旧 Pod 同时挂同一个卷）和一个 Service。

```sh
kubectl create namespace herdr-pocket
kubectl -n herdr-pocket create secret generic herdr-pocket-relay \
  --from-literal=POCKET_PUBLIC_URL=https://pocket.example.com \
  --from-literal=POCKET_ADMIN_TOKEN="$(openssl rand -hex 24)"
kubectl -n herdr-pocket apply -f deploy/k8s/relay.yaml
kubectl -n herdr-pocket exec deploy/herdr-pocket-relay -- herdr-pocket-relay setup
```

再用你自己的 Ingress 把域名指到 Service `herdr-pocket-relay`（端口 80），`/v1/ws`、`/v1/notify`、`/v1/assistant/live` 是 WebSocket，Ingress 要放行升级请求并调大空闲超时。

更新：`kubectl -n herdr-pocket rollout restart deploy/herdr-pocket-relay`（`latest` 标签默认每次重新拉取）。
