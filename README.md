# FirstLeap

一个安静、专注的个人英语课堂。首版包含新概念英语第一册课程目录、视频播放、搜索、倍速、浏览器续播和完成进度。

React + TypeScript + Vite 前端，Go HTTP 服务，单一 Docker 镜像。Go 直接流式读取只读媒体目录，支持 Range、HEAD、条件请求；原始 H.264/AAC MP4 不转码。`ffprobe` 和 `ffmpeg` 仅用于时长与缩略图。无账号、无数据库，学习进度保存在当前浏览器；清除站点数据会清除进度。

## 本地开发

需要 Linux、Go 1.26、Node.js 22.12+、pnpm 9.15.9，以及 PATH 中的 ffprobe/ffmpeg。媒体目录应包含课程 MP4；测试仅使用临时生成的模拟文件，不需要 NAS。

```sh
pnpm install --frozen-lockfile
MEDIA_ROOT=/absolute/path/to/course DATA_ROOT=/tmp/firstleap-data go run ./cmd/firstleap
# 另一个终端
pnpm dev
```

打开 Vite 输出的本机地址。开发环境允许本地媒体目录；生产必须设置 `REQUIRE_CIFS=true`，验证媒体目录实际属于只读 CIFS 文件系统。不要将视频或真实连接配置复制进仓库。

```sh
go vet ./...
go test -race ./...
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器测试使用受控课程响应验证搜索、导航、完成状态、续播状态与故障恢复。真实视频的解码、随机拖动和续播需在已连接媒体的环境验证。

## 配置与接口

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8000` | HTTP 端口 |
| `BIND_ADDRESS` | `0.0.0.0` | 监听地址；临时预览可限定为 `127.0.0.1` |
| `MEDIA_ROOT` | `/media` | 课程目录，只读 |
| `DATA_ROOT` | `/data` | 元数据与缩略图缓存，可写 |
| `WEB_ROOT` | `web/dist` | 静态页面目录，镜像中为 `/app/web` |
| `REQUIRE_CIFS` | `false` | 生产设为 `true`，拒绝普通目录和可写 CIFS 挂载 |

- `GET /api/courses`、`GET /api/courses/ncese01`：课程信息、课节列表、`sourceAvailable` 与 `indexing` 状态。
- `GET/HEAD /api/lessons/{id}/video`：原视频流；支持 `Range`、`ETag`、`If-Range`。
- `GET /api/lessons/{id}/thumbnail`：缩略图，生成前返回 404。
- `GET /health/live`：进程存活；`GET /health/ready`：挂载可读且已有目录索引。

课节 ID 取相对路径的 SHA-256 前 128 位，不随挂载绝对路径变化；重命名文件会产生新 ID。目录每 5 分钟刷新；媒体状态每 15 秒检查，恢复后重新扫描。文件大小或修改时间变化后重新生成元数据。目录先展示，时长和缩略图后台依次补全。源失联时保留最后一次有效目录；不会把空目录当成正常课程源。

## GitHub Actions / GHCR

`.github/workflows/build-images.yml` 在 PR 上运行 Go、前端与浏览器测试并验证镜像构建。推送 `main`、`v*` 标签或手动触发时发布 `linux/amd64` 镜像至 `ghcr.io/cloverstd/firstleap`。

工作流使用 `GITHUB_TOKEN` 的 `contents: read` 和发布任务的 `packages: write` 权限。提供完整提交 SHA 标签、版本标签及主分支 `latest`。服务器使用 digest 固定版本，不自动追踪 `latest`。镜像只包含应用程序与静态页面，不包含课程、缓存或 SMB 配置。首次发布后需确保服务器具有 GHCR 拉取权限；私有包使用服务端已配置的只读 GHCR 凭据，不提交登录信息。

## 生产部署

使用已有 Docker Compose、Traefik `websecure` HTTPS 入口和外部 `traefik-net` 网络。项目目录为 `/opt/docker-compose/firstleap`。服务器安装 `cifs-utils`；应用容器不具有挂载权限。

1. 复制 `compose.yaml` 到项目目录；复制 `.env.example` 为服务器上的 `.env`，填入镜像 digest、站点主机名和独立挂载路径。`.env` 不进入 Git。
2. 创建项目下的 `data` 目录，将所有者设为 `10001:10001`。
3. 在服务器上以 root 运行 `deploy/install-mount.py`，从标准输入提供私有 JSON。字段为 `source`（`//server/share`）、`subdirectory`、`username`、`password`、可选 `domain`。由受信任的配置读取程序直接写入 stdin，不使用 shell 参数或输出凭据。脚本把凭据保存到 root-only 的 `/etc/firstleap/smb.credentials`，生成服务器专属 systemd 挂载单元，并将课程子目录只读挂载到 `/srv/firstleap/media`。真实 SMB 信息只保存在主机，不在 Compose 中。
4. 将 `deploy/firstleap.service` 安装到 `/etc/systemd/system/firstleap.service`。该单元在 Docker 和实际媒体挂载就绪后启动 Compose；`restart: on-failure` 处理容器进程故障，systemd 负责开机及 Docker 重启顺序。

```sh
cd /opt/docker-compose/firstleap
docker compose pull
sudo systemctl daemon-reload
sudo systemctl enable --now firstleap.service
docker compose ps
```

检查独立挂载为 `cifs` 且含 `ro`，容器 `/media` 为 `RW=false`。不要通过创建测试文件验证只读性。健康检查同时验证只读 CIFS 类型，防止错误绑定空目录。首次启动后台建立索引和缩略图，页面会逐步补全。

## 更新、停止与回滚

等待 GitHub Actions 发布成功，记录当前 `.env` 中的镜像 digest，然后将 `FIRSTLEAP_IMAGE` 改为新 digest：

```sh
cd /opt/docker-compose/firstleap
docker compose pull
sudo systemctl restart firstleap.service
docker compose ps
docker compose logs --tail=50
```

通过站点 HTTPS 检查 `/health/ready`、课程列表和视频首段/中段/末段。回滚时恢复之前的 digest 并重复 pull/restart。停止使用 `sudo systemctl stop firstleap.service`；重新启动使用 `sudo systemctl start firstleap.service`。只重启本项目，不重启共享 Docker 或 Traefik。

如 NAS 不可用，保留缓存和浏览器进度，恢复网络后重试；如挂载单元启动失败，在服务端私下检查其日志（可能包含共享地址），修复后启动挂载及应用单元。现有 NAS 目录和其它应用的挂载不受本项目管理。

## 使用边界

这是可信私有网络中的个人课堂，无账号与跨设备进度同步。课程内容来自部署者自己的媒体源。视频和派生缓存均排除在源码及镜像构建上下文之外。
