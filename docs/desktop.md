# ANote 桌面客户端

Electron 桌面端复用 React 编辑器、文档模型和同步核心。当前版本 **0.5.0**、协作格式 **4**，应用、快捷方式、程序及发行包名称统一为 **ANote**，见[命名约定](naming.md)。团队侧栏使用管理员设置的平台名称，应用窗口标题为 ANote。

界面支持简体中文和英文，登录页与设置中可以切换。语言偏好保存在本机，切换前会保存当前笔记；笔记内容和用户填写的名称保持原样。

## 使用模式

**本地个人笔记**无需账号和服务器。选择自己的目录后，正文、附件、历史和昵称保存在其中的 `.anote`，并生成可编辑 Markdown。切换目录时内容隔离，连接团队不会自动上传个人笔记。

**连接团队空间**填写部署者自己的服务器地址并登录。支持实时协作、评论、Yjs 离线缓存、附件缓存、持久同步队列和受管 Markdown 目录。服务与账号隔离目录和队列；凭据仅在系统密钥库可用时加密保存，否则只保留内存会话。

受管笔记子目录含 Markdown、附件和 `.anote` 同步基准。保留元数据，不用另一账号直接接管目录。兼容的文本修改可三方合并；重叠修改、增强内容结构变化及块的增删重排进入冲突处理。缺失文件不向服务器传播删除；采用线上版本前保留本地副本。

离线内容无法通过服务器的远程 MCP 访问。同步与历史不替代独立备份。

## 构建

仓库根目录执行以下宿主机编排脚本，全部构建在 Docker 内：

```sh
bash scripts/package-desktop.sh
```

默认服务器地址为空；如需自己的默认地址，可在调用脚本前设置 `VITE_ANOTE_SERVER_URL`。输出至忽略的 `artifacts/releases/`：

| 平台 | 包 |
| --- | --- |
| Linux Intel／AMD | `ANote-0.5.0-linux-x64.tar.gz` |
| Windows Intel／AMD | `ANote-0.5.0-win32-x64.zip` |
| macOS Intel | `ANote-0.5.0-darwin-x64.tar.gz` |
| macOS Apple Silicon | `ANote-0.5.0-darwin-arm64.tar.gz` |

清单 `manifest.json` 记录平台、版本、字节数和 SHA-256。可用 `DESKTOP_TARGETS=linux-x64` 只打包指定目标；完整分发校验需要四个包。Electron 运行时下载缓存位于 `anote-electron-downloads` Docker 卷。构建需要访问 npm registry 和 Electron 官方发行资源。

这些包为解压运行的未签名预览版。Linux 解压后运行 `ANote`，Windows 运行 `ANote.exe`，macOS 打开 `ANote.app`。Windows 和 macOS 的原生测试、签名与公证在对应系统完成。发行包包含 Apache-2.0 许可证、项目声明及第三方组件声明。

## 验证与分发

开发验证见[开发指南](development.md)。容器中的 Linux 验证使用 Xvfb；无网络个人模式测试使用 `--network none`。测试命令中的 `--no-sandbox` 仅用于 root 容器，不是给用户关闭系统安全功能的要求。

发布包可独立上传到 GitHub Releases，也可按[部署指南](../deploy/README.md)显式安装至服务器 `clients` 目录。构建、测试不会自动发布到任何正式实例。
