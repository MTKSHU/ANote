# 配置与密钥 / Configuration and secrets

公开源码中的配置只应使用占位符、环境变量或明确隔离的测试值。真实 `.env`、OIDC 客户端密钥、MCP 令牌、数据库转储、SSH 私钥和应用签名资料均不属于源码；本地构建、测试与发布输出位于被忽略的目录。`deploy/init-env.mjs` 为新部署随机生成密码和配置加密密钥，已有文件不覆盖。

发布前检查 Git diff 以及新增文件；使用 Gitleaks 等工具扫描待发布文件。不要仅依赖 `.gitignore`：它不会清除已经进入 Git 历史的内容。若真实密钥曾提交，先撤销／轮换，再安排历史清理。公开分享链接也可能允许持有人访问内容，文档示例应使用示例域名。

Public configuration should contain placeholders, environment variable references or clearly isolated test values. Do not commit real environment files, OAuth secrets, MCP tokens, database dumps, private keys or signing material. Review new files and diffs and run a secret scanner before publishing. Ignoring a file does not remove it from Git history; revoke exposed credentials before arranging history cleanup.
