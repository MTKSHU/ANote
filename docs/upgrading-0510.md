# 升级到 0.5.10 / Upgrading to 0.5.10

升级前按自己的部署方式备份 PostgreSQL、附件目录和客户端数据。先在隔离环境验证，再更新服务及对应桌面客户端。不要把实际环境文件、令牌、数据库或安装包提交到源码仓库。

服务启动会运行新增 SQL 迁移，并保留已有笔记、权限和分享配置。公开版已发布的旧迁移文件保持原内容，避免 checksum 不匹配。协作编码和本地旧备份兼容由程序处理；常规升级不会自动启动全库离线转换或清理历史原件。高级维护操作需要独立启用对应开关，升级前先阅读代码并在备份副本验证。

编辑 schema 升至 9。网页刷新后使用新编辑器，桌面需更新到本版。旧编辑器拒绝写入以防丢失格式；未同步草稿与旧备份保留。首次在本地目录使用知识库归档后，旧客户端会拒绝打开该目录。

有效 MCP 认证可继续使用，刷新工具并调用 `get_editor_rules`。修改前重新读取笔记、生成新预览；不要重放旧 schema 的写入。写入新格式后不应直接降级到旧 schema 服务或客户端，回退须协调数据兼容与备份。

桌面与移动源工程数字版本统一为 0.5.10 / 510。Android 为测试签名，HarmonyOS 需自行签名，iOS 源工程需要 macOS / Xcode；这些工程不等于已完成所有设备验收的正式安装包。构建说明见 [mobile](../apps/mobile/README.md)。

## English

Back up your database, attachments and client data before upgrading. Validate the upgrade in isolation, then update the service and desktop clients together. New SQL migrations run on startup; previously published migration files retain their checksums. Normal upgrades do not automatically run the optional full-database offline conversion or remove historical originals.

The editor requires schema 9. Refresh web clients and upgrade desktop clients; old clients refuse writes rather than dropping new formatting. Existing offline drafts and older backups are retained. After library archiving is first used in a local directory, older clients refuse to open that directory.

Valid MCP credentials remain usable. Refresh tools, call get_editor_rules, reread the note and prepare a new preview. Never replay an old-schema write. A downgrade after new-format writes requires coordinated data recovery.

Desktop and mobile source versions are 0.5.10 / 510. Android uses a test signing key, HarmonyOS needs developer signing, and the iOS source project requires macOS / Xcode. Native device validation remains separate from source builds.
