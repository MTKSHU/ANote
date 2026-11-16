# Changelog

## 0.5.10 — 2026-11-16

- 支持知识库归档、整库只读共享、笔记链接及文末参考列表。
- 支持标题折叠、便携 Markdown 与 assets 附件归档，以及手机端阅读与浮动面板。
- 支持 SVG、音频与 360° 图片／视频，媒体临近视口再加载。
- 表格可拖动列宽、按内容分配列宽、设置底纹及垂直对齐；正文支持首行缩进两字符并保留至 PDF。
- 左键拖动优先选择单元格文字，松开后显示工具；整格选择有独立入口。
- 桌面端提供离线副本、分块增量备份与分页删除、工作目录迁移及在线更新；保存与备份在后台线程处理。
- 协作数据紧凑编码，历史状态去重，保留旧备份和未同步草稿。
- MCP 支持个人令牌与桌面本地目录。编辑 schema 升至 9，工具集为 1.1.10；有效认证不因 schema 升级而撤销。
- 同步移动源工程数字版本为 0.5.10 / build 510。Android 为测试签名、HarmonyOS HAP 需签名，iOS 仅提供源工程。
- 保留开源版 ANote 命名、Apache-2.0、简体中文／英文支持和可配置的自托管部署；不内置私有服务器或认证服务。


## 0.5.0 — 2026-11-01

ANote 的开源发行版，提供网页、自托管服务端及桌面客户端。

- 网页和桌面支持简体中文、英文，语言偏好保存在本机。
- 个人模式无需账号或服务器，支持离线笔记、附件与本地历史。
- 团队空间提供实时协作、评论、共享、版本历史和 Markdown 同步。
- MCP 通过 OAuth 使用现有权限，编辑采用差异预览与确认提交。
- 项目采用 Apache-2.0，发行包附带许可证和第三方声明。
- 新增中英双语 GitHub Pages 项目介绍页。

桌面包包括 Linux x64、Windows x64、macOS Intel 和 macOS Apple Silicon。当前为未签名预览包；Windows 和 macOS 原生运行及签名需在对应系统完成验证。

### English

The open-source ANote release includes the web app, self-hosted server and desktop client.

- English and Simplified Chinese interfaces with a locally saved language preference.
- Account-free personal mode with offline notes, attachments and local history.
- Team collaboration, comments, sharing, version history and managed Markdown sync.
- OAuth MCP connections that follow existing permissions, with previews before saving.
- Apache-2.0 licensing and third-party notices in desktop packages.
- A bilingual GitHub Pages project website.

Desktop archives target Linux x64, Windows x64, macOS Intel and macOS Apple Silicon. Packages are unsigned previews. Native Windows and macOS validation, signing and notarization remain platform-specific work.
