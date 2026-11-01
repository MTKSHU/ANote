# ANote 命名约定

项目展示名称统一使用 **ANote**，技术标识统一使用小写 `anote`，环境变量前缀使用大写 `ANOTE`。平台网页与桌面团队侧栏的名称可在管理设置中修改，默认值为 `ANote`。

| 标识 | 含义 |
| --- | --- |
| `ANote` | 桌面应用、快捷方式、程序及发行包名称 |
| `anote` | 根 npm 包、PostgreSQL 默认数据库与用户、Compose 默认项目名 |
| `anote-desktop`、`org.anote.desktop` | 桌面包与应用 ID |
| `@anote/*` | workspace 内部包名 |
| `ANOTE_*`、`VITE_ANOTE_*` | 配置环境变量 |
| `.anote` | 本地同步基准及个人目录数据 |
| `.anote-storage.json`、`.anote-workspace.json` | NAS 数据根目录及桌面工作目录标识 |
| `anote://` | 桌面应用协议及 MCP 编辑规则资源 URI |
| `anote.internal`、`anote-validation.internal` | 测试网络别名 |
| `anote:*`、`anote-*` | 浏览器存储键、事件与桌面 IPC 标识 |
| `anote_doc`、`anote_base`、`anote:block` | 受管 Markdown 元数据及块标记 |

公开版 Compose 默认项目名为 `anote`，隔离回归使用 `anote-test` 和 `anote-validation`。

桌面应用默认使用系统应用配置目录下的 `ANote`；`ANOTE_CLIENT_DATA_DIR` 可显式指定配置目录。发行包名称使用 `ANote-版本-平台-架构`，下载接口仅接受这一命名格式。
