# 开发

项目使用 Node.js 22，开发工具和测试环境通过 Docker 提供。仓库根目录的 `package.json` 管理 workspace 依赖；源码、配置和锁文件一同提交，环境文件、用户数据及构建输出不进入版本控制。

## 目录

| 目录 | 内容 |
| --- | --- |
| `apps/api` | API、权限、数据库、协作、文件、OAuth MCP 和媒体 Worker |
| `apps/web` | 网页入口与浏览器回归 |
| `apps/desktop` | Electron 主进程、共享界面和桌面测试 |
| `packages/document-model` | 富文本模型与规范化 |
| `packages/editor` | React 编辑器与节点视图 |
| `packages/sync-core` | Markdown 和目录同步 |
| `packages/i18n` | 中英文文案和语言偏好 |
| `validation` | 协作验证程序、单元测试和合成资料 |
| `deploy`、`scripts` | 容器配置、打包和检查脚本 |

## 本地检查

以下命令从仓库根目录执行，将依赖和输出写入被忽略的目录。

```sh
docker run --rm -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
  -v "$PWD:/workspace" -w /workspace node:22-bookworm npm ci --no-audit --no-fund

docker run --rm -v "$PWD:/workspace" -w /workspace node:22-bookworm npm run build:workspace

docker run --rm -v "$PWD:/workspace" -w /workspace node:22-bookworm \
  node --import tsx --test validation/tests/merge.test.ts validation/tests/mcp-model.test.ts apps/api/tests/origin.test.ts

docker run --rm -v "$PWD:/workspace" -w /workspace node:22-bookworm \
  node --test validation/tests/i18n.test.mjs
```

`packages/i18n` 提供 JavaScript 源模块和类型声明，不依赖编译输出。新增界面文案及英文翻译的维护方法见[国际化](internationalization.md)。

## 集成测试

集成测试会写入账号、笔记和附件，使用独立副本、环境文件及数据库。测试 Compose 项目名为 `anote-test`，协作验证程序为 `anote-validation`，与使用中的实例分开。

```sh
docker run --rm -v "$PWD:/workspace" -w /workspace node:22-bookworm node deploy/init-env.mjs
ANOTE_PORT=3101 docker compose --env-file deploy/.env \
  -f deploy/compose.yaml -f deploy/compose.mcp-test.yaml -p anote-test up -d --build --wait api worker

docker build -f validation/Dockerfile.browser -t anote-validation-browser:local .
docker run --rm --init --ipc=host --network anote-test_default \
  --env-file deploy/.env -e BASE_URL=http://anote.internal:3000 \
  -v "$PWD:/workspace" -w /workspace anote-validation-browser:local \
  node_modules/.bin/playwright test --config apps/web/playwright.config.ts
```

网页测试固定使用简体中文，以保持既有定位器稳定。英文资源由独立检查覆盖。OIDC 用例需要模拟身份服务，媒体用例需要对应样例文件；相关环境由 `scripts/validate-mcp.sh` 和 `scripts/validate-resources.sh` 管理。

测试入口包括 `validate-server-foundation.sh`、`validate-server-documents.sh`、`validate-web.sh`、`validate-records.sh` 和 `validate-workspace.sh`。各项覆盖见[测试说明](validation.md)。网页报告位于 `artifacts/web`，桌面报告位于 `artifacts/desktop`；失败轨迹可能包含测试会话，不作为发布附件。

## 桌面与分发

`bash scripts/package-desktop.sh` 构建桌面发行包，`scripts/validate-desktop.sh` 运行开发版回归，`scripts/validate-desktop-release.sh` 检查解压包和无网络个人模式。Linux Electron 测试使用 Xvfb；测试中的 `--no-sandbox` 用于 root 容器环境。

发行包包含项目的 `LICENSE`、`NOTICE` 和第三方声明。构建、测试和安装到服务器下载目录是独立操作，分发方式见[桌面指南](desktop.md)。
