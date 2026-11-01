# 部署与维护

ANote 通过 Docker 运行 API、PostgreSQL 和媒体 Worker。宿主机需要 Docker Engine、Compose V2、Bash 和 Git；依赖和构建工具由容器提供。

## Docker 命名卷

在仓库根目录生成本地配置并启动服务：

```sh
docker run --rm --user 0:0 -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm node deploy/init-env.mjs

docker compose --env-file deploy/.env -f deploy/compose.yaml -p anote up -d --build --wait
```

默认地址是 <http://127.0.0.1:3100>。初始管理员为 `admin`，随机密码保存在 `deploy/.env` 中的 `ADMIN_PASSWORD`。配置文件也包含数据库密码和加密主密钥，不应提交到版本控制。

数据保存在 `anote_` 前缀的 Docker 命名卷中，数据库端口不向宿主机发布。监听地址和端口分别由 `ANOTE_BIND_IP`、`ANOTE_PORT` 配置；修改后重新创建服务即可生效。

## TrueNAS Dataset

使用 Dataset 时，为 ANote 准备一个专用空目录。以下示例中的路径和 IP 需要换成实际值：

```sh
docker run --rm --user 0:0 \
  -e ANOTE_DATA_ROOT=/mnt/pool/anote \
  -e ANOTE_NAS_IP=192.168.1.50 \
  --mount type=bind,source=/mnt/pool/anote,target=/nas-root \
  -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm node deploy/prepare-nas.mjs

bash deploy/nas.sh up -d --build --wait
```

准备脚本建立 `database`、`originals`、`uploads`、`previews` 和 `clients` 目录，并在本地写入 `deploy/.env.nas`。未识别的非空目录不会被接管。数据库目录归容器 UID/GID 999 所有，其他数据目录归 1000 所有，Dataset ACL 需要允许相应容器访问。

`nas.sh` 合并基础 Compose 与 Dataset 配置。日常管理可继续使用同一脚本：

```sh
bash deploy/nas.sh ps
bash deploy/nas.sh logs --tail 100 api worker
bash deploy/nas.sh stop
bash deploy/nas.sh up -d --wait
```

默认项目名为 `anote`，`ANOTE_COMPOSE_PROJECT` 可用于区分多个实例。`.env.nas` 中的目录和监听配置优先于 `.env`。环境变量的完整说明见[平台配置](../docs/configuration.md)。

## 公共地址与认证

反向代理需要转发 HTTP 和 WebSocket 请求，保留 `Host` 并传递转发协议与客户端地址。上传体积和超时限制可按实际文件大小调整。

网页「设置 → 平台管理」保存站点的公共地址，例如 `https://notes.example.org`。公开链接、邀请、OIDC 回调和远程 MCP 都使用这一地址。HTTPS 访问可设置 `COOKIE_SECURE=true`，HTTP 内网访问使用 `false`。

OIDC 连接自己的身份服务，未配置时使用本地账号即可。切换到仅 OIDC 模式前，当前管理员需要完成身份绑定，以保留管理入口。

## 更新和数据

环境文件、数据和 `SETTINGS_ENCRYPTION_KEY` 在更新时保留。Dataset 实例可在更新源码后重建应用：

```sh
bash deploy/nas.sh build api worker
bash deploy/nas.sh up -d --no-build --no-deps --wait api worker
```

命名卷实例使用安装时的 Compose 项目管理。`down -v` 会删除持久化卷，不用于普通更新。数据库迁移由 API 启动时执行，涉及数据结构变化的升级应保留可恢复的数据库与附件备份。

数据库保存正文、协作状态、账号、权限、评论、版本和附件索引。`originals` 保存原件，`uploads` 保存上传暂存，`previews` 保存派生文件。完整恢复需要数据库、原件和加密主密钥保持一致。

从命名卷迁往 Dataset 属于数据迁移，单独修改挂载不会转移现有数据。可在维护期间停止写入，使用匹配版本的 PostgreSQL 容器导出数据库、复制原件，并在独立实例中验证恢复。运行中的 PostgreSQL 数据目录不适合直接复制作为一致备份。

备份和定时任务由部署者管理，仓库不自动执行数据迁移或定时备份。

## 桌面下载

桌面发行包的构建方法见[桌面指南](../docs/desktop.md)。构建产物与服务器下载目录独立管理，Dataset 实例可以用以下命令安装校验通过的四个平台包：

```sh
docker run --rm --user 0:0 \
  -e ANOTE_DATA_ROOT=/mnt/pool/anote \
  --mount type=bind,source=/mnt/pool/anote,target=/nas-root \
  -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm node scripts/install-client-releases.mjs
```

安装后的清单和包位于 Dataset 的 `clients` 中，网页「设置 → 桌面客户端」据此提供下载。没有发布包时，客户端下载页面显示准备状态。

测试专用的 `compose.*-test.yaml` 包含模拟认证和测试挂载，与使用中的实例分开配置。检查环境见[开发指南](../docs/development.md)。
