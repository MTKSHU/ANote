# 项目介绍页

项目介绍页位于 [index.html](index.html)，样式和交互分别为 [site.css](site.css) 与 [site.js](site.js)。这是不依赖构建工具的静态网站，支持中英切换、图片对比和思维导图分支示意。图片、字体和脚本均从站点自身加载，不依赖外部 CDN。

GitHub 链接为 <https://github.com/MTKSHU/ANote>，发行包链接为 <https://github.com/MTKSHU/ANote/releases>。

## 在 GitHub Pages 发布

将源码推送到仓库后，在 **Settings → Pages** 中选择 **Deploy from a branch**，分支选择 `main`，目录选择 `/docs`。页面中已包含 `.nojekyll`，无需 Jekyll 或 Node.js 构建。

发布后的默认地址是 <https://mtkshu.github.io/ANote/>。本文只说明配置方法，保存源码或编译桌面发行包不会自动启用 Pages。

## 维护

介绍文案直接写在 HTML 中，`data-en` 保存相应的英文。更新版本时同步修改首页版本徽标；GitHub 和 Releases 入口指向固定仓库地址，不依赖某一个发行标签。

介绍页按当前 0.5.10 的源码能力描述功能。首屏和使用指南同时说明：桌面个人 App 无需账号或服务器；团队平台由管理员部署、成员通过网页或桌面连接。服务器笔记的可选离线副本、本地 MCP 与远程 MCP、移动预览的使用范围分别说明，避免把个人 App 描述为必须部署的服务。更新时同时检查中文和 `data-en` 英文，安装包版本以 Releases 实际发布为准。

功能示例素材的来源见 [assets/README.md](assets/README.md)。页面展示的笔记、评论和导图为说明功能的示例，不连接在线业务数据。

## English

The project website is a buildless static page in `docs/`. After pushing the source, choose **Settings → Pages → Deploy from a branch**, then select `main` and `/docs`. The default URL is <https://mtkshu.github.io/ANote/>.

No publication is triggered by a local build. Text lives in `index.html`; `data-en` attributes hold English translations. Download links point to the repository's Releases page so they remain valid across versions.
