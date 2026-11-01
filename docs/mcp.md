# ANote MCP

ANote 在 `/mcp` 提供 Streamable HTTP MCP 接口，使用 OAuth 授权码和 PKCE。连接后的访问范围由用户授权和笔记权限共同决定，平台管理员身份不会绕过私人内容的权限。

## 连接与授权

「设置 → AI工具链」显示当前站点的 MCP 地址，例如 `https://notes.example.org/mcp`。支持远程 MCP OAuth 的客户端可使用该地址完成浏览器登录和授权。授权分为读取与写入范围，可在设置中随时撤销；云端客户端需要能够访问站点的 HTTPS 地址。

MCP 授权凭据与平台登录密码、OIDC Client Secret 相互独立。客户端需要使用 OAuth 连接功能，不能把这些密码填入 Bearer Token 字段。本地个人模式中尚未同步的内容不经服务器提供。

## 工具

| 工具 | 用途 |
| --- | --- |
| `get_context` | 当前账号、授权范围与编辑约束 |
| `get_editor_rules` | 富文本 schema、节点属性及操作格式 |
| `list_libraries` | 可访问的个人和团队知识库 |
| `list_notes` | 按知识库和关键词检索笔记 |
| `list_folders` | 知识库目录 |
| `read_note` | 正文分块、稳定块 ID 和 `base_hash` |
| `list_note_comments` | 评论、回复、状态与原文定位 |
| `search_assets` | 可访问的附件 |
| `read_asset` | 附件信息、小图片或文本内容 |
| `prepare_changes` | 新建或修改笔记的差异预览 |
| `prepare_note_move` | 同范围跨知识库移动的预览 |
| `apply_changes` | 提交已确认的修改，校验版本与有效期 |
| `begin_upload` | 私有暂存上传与分块 PUT 地址 |
| `upload_status` | 上传状态和续传偏移 |
| `complete_upload` | 完成文件校验 |
| `cancel_upload` | 取消尚未引用的暂存文件 |
| `import_chatgpt_file` | 导入客户端提供的原生文件参数 |

## 修改与冲突

编辑采用预览与提交两个阶段。`prepare_changes` 返回完整差异，不修改笔记；用户确认后，`apply_changes` 才会保存。预览绑定笔记的 `base_hash`，正文有并发变化或预览过期时，需要重新生成预览。`operation_id` 保证重复提交的幂等性。

富文本节点具有稳定块 ID 和结构化属性。编辑应保留未修改的表格、图片尺寸、对齐和导图数据；普通 Markdown 无法完整表示这些内容。

跨库移动仅支持本人个人知识库之间或同一团队内部。正文、链接 ID、附件、评论和历史随笔记保留，原指定授权和公开链接会被撤销。目标知识库、目录和可见范围均包含在移动预览中。

## 附件

本地文件使用私有暂存上传。`begin_upload` 返回短期分块地址，文件由有本机访问能力的客户端传输，服务器不读取用户电脑上的路径。上传通过完整校验后，仍需在笔记修改中引用才成为正式附件。

`import_chatgpt_file` 依赖客户端提供的原生文件参数。不具备此能力的客户端可以使用分块上传。暂存内容在引用提交前保持私有，读取评论和附件也始终检查当前用户权限。

实现位于 [mcp.ts](../apps/api/src/mcp.ts)，接口回归见 [MCP 测试](../apps/web/tests/mcp.spec.ts)。
