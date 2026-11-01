# ANote API

NestJS／Express 服务，提供账号与会话、知识库和目录、笔记权限、Yjs 协作、评论、历史、文件及 OAuth MCP，同时托管网页构建输出。PostgreSQL 使用带事务锁和校验值的迁移。

个人内容与团队内容按数据权限隔离；API 和协作 WebSocket 均检查权限。附件原件保存在持久化存储，媒体分析由独立 Worker 执行。

安装见[部署指南](../../deploy/README.md)，服务与权限模型见[架构](../../docs/architecture.md)，工具列表见[MCP](../../docs/mcp.md)，容器化验证见[开发指南](../../docs/development.md)。
