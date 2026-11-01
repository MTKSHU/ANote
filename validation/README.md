# ANote 协作与同步验证

此目录保留独立的 React／NestJS 验证服务、合成测试资料及回归代码，用于验证多人协作、增强内容保真、Markdown 双向合并和重启恢复。验证身份与数据独立，不作为正式认证系统。

从仓库根目录执行：

```sh
bash validation/scripts/validate.sh
```

脚本仅在 Docker 内安装依赖、构建与测试，自动生成忽略的 validation/.env，使用 anote-validation Compose 项目及独立数据库卷。原型监听 http://127.0.0.1:3099，验证口令在本地环境文件的 VALIDATION_SECRET。不要用正式账号或环境文件替换它。

场景覆盖独立浏览器协作、增强表格、双图对比、真实文件同步、三方合并、重叠冲突、幂等导入及正常重启持久化。原型中保留早期审核快照用例；当前产品只提供评论。

结果写入忽略的 validation/artifacts/，摘要位于 artifacts/reports/validation-evidence.json。这些文件由本机复验生成，仓库不附带内部环境的历史报告或会话轨迹。

可停止服务并保留测试卷：

```sh
docker compose --env-file validation/.env -f validation/compose.yaml -p anote-validation stop
```

API、网页和桌面测试入口见[开发指南](../docs/development.md)，各类测试的覆盖内容见[测试说明](../docs/validation.md)。
