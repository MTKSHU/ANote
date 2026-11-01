# ANote

[English](README.en.md) · 简体中文 · [项目主页](https://mtkshu.github.io/ANote/) · [Releases](https://github.com/MTKSHU/ANote/releases)

ANote 是一个可自托管的笔记与知识管理应用，适合个人、课题组和团队使用。笔记按知识库和目录组织，支持富文本编辑、实时协作、评论、版本历史，以及本地 Markdown 双向同步。

网页和桌面客户端均支持简体中文与英文。界面默认跟随浏览器语言，也可以在登录页或「设置 → 账号与偏好」中切换；笔记正文和用户填写的名称不会随界面语言改变。

## 功能

- **编辑与整理**：多级目录、标签、搜索、拖拽排序、表格、待办、代码高亮、LaTeX、Mermaid 和思维导图。
- **附件**：在正文中上传、粘贴和拖入图片、音视频及文件，支持图片对比和部分三维格式预览。
- **协作与共享**：多人编辑、段落评论、版本恢复、团队权限和可撤销的只读公开链接。
- **桌面与离线**：本地个人模式无需账号或服务器；团队模式提供离线缓存和受管 Markdown 目录同步。
- **身份与管理**：本地账号、OIDC、团队邀请、回收站，以及明暗主题。
- **MCP**：AI 客户端可以在用户授权范围内检索笔记、读取评论、准备修改和上传附件。修改需经过差异预览与确认。

个人笔记默认私有。团队成员可以阅读和评论有权访问的内容，编辑他人的笔记需要授权。平台管理员身份不会自动获得私人内容的访问权。

## 安装

服务端使用 Docker Engine 和 Compose V2，数据库为 PostgreSQL 17。以下命令在仓库根目录执行。

```sh
docker run --rm --user 0:0 \
  -v "$PWD:/workspace" -w /workspace \
  node:22-bookworm node deploy/init-env.mjs

docker compose --env-file deploy/.env \
  -f deploy/compose.yaml -p anote up -d --build --wait
```

配置脚本生成本地 `deploy/.env`，其中包含随机密码和配置加密密钥。打开 <http://127.0.0.1:3100>，使用 `admin` 和文件中的 `ADMIN_PASSWORD` 登录。已有配置文件不会被覆盖。

默认监听本机地址。需要局域网访问时，在环境文件中设置 `ANOTE_BIND_IP`；端口由 `ANOTE_PORT` 指定。TrueNAS Dataset、自定义数据目录、反向代理和日常维护见[部署指南](deploy/README.md)。

站点名称、公共地址和认证方式在「设置 → 平台管理」中管理。OIDC 使用部署者自己的身份服务；未配置时可以使用本地账号。配置项说明见[平台配置](docs/configuration.md)。

## 桌面客户端

桌面客户端提供本地个人笔记和团队连接两种模式。个人模式的正文、附件和历史保存在自己选择的目录中，连接团队不会自动上传这些内容。团队模式连接自托管服务器，并按服务和账号隔离缓存与同步目录。

当前桌面预览版为 **0.5.0**。源码仓库不包含二进制包；维护者可通过以下脚本生成 Linux、Windows 和 macOS 发行包：

```sh
bash scripts/package-desktop.sh
```

发行包输出到 `artifacts/releases/`。目前发行流程生成未签名的解压运行包，Windows 和 macOS 仍需在对应系统验证。使用与同步说明见[桌面指南](docs/desktop.md)。

## MCP 连接

「设置 → AI工具链」提供本站的 MCP 地址，例如 `https://notes.example.org/mcp`。支持远程 MCP OAuth 的客户端通过浏览器登录并授权，访问范围沿用用户已有权限。授权可以随时撤销，本地个人模式中未同步的笔记不向远程客户端提供。

工具、权限和附件传输说明见 [MCP 文档](docs/mcp.md)。

## 开发与文档

项目使用 TypeScript、React、Tiptap、Yjs、NestJS 和 Electron。开发环境与检查命令见[开发指南](docs/development.md)。

| 文档 | 内容 |
| --- | --- |
| [部署](deploy/README.md) | Docker、TrueNAS、HTTPS、更新和数据维护 |
| [配置](docs/configuration.md) | 环境变量、认证、用户和团队 |
| [编辑器](docs/editor.md) | 正文、附件、评论、历史与共享 |
| [桌面端](docs/desktop.md) | 个人模式、团队同步和发行包 |
| [架构](docs/architecture.md) | 服务组成、数据和权限模型 |
| [国际化](docs/internationalization.md) | 语言选择、文案和翻译维护 |
| [命名](docs/naming.md) | 项目名称及技术标识 |
| [项目介绍页](docs/github-pages.md) | GitHub Pages 源码与发布方式 |

## 许可证

ANote 使用 [Apache License 2.0](LICENSE)。允许使用、修改和分发，包括商业用途；分发时须遵守许可证中的声明保留等条件。第三方组件使用各自的许可证，相关声明随发行包提供。
