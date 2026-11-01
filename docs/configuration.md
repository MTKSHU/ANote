# ANote 平台配置

## 环境与网页设置

`deploy/.env` 由容器中的初始化脚本生成。它包含数据库密码、初始管理员和 `SETTINGS_ENCRYPTION_KEY`，不加入 Git。TrueNAS 另使用 `deploy/.env.nas` 保存数据根目录和监听 IP；同名配置以后者为准。

| 变量 | 用途 |
| --- | --- |
| `DB_PASSWORD` | 数据库连接密码；已有数据库保留原值 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 空数据库的初始平台管理员；修改环境变量不会重置已有账号 |
| `SETTINGS_ENCRYPTION_KEY` | 32 字节 base64url 配置加密主密钥，初始化时生成 |
| `ANOTE_BIND_IP` / `ANOTE_PORT` | 默认 `127.0.0.1:3100`，按访问范围配置 |
| `ANOTE_DATA_ROOT` | TrueNAS 的绝对数据目录，由部署者指定 |
| `PUBLIC_ORIGIN` | 公共访问地址的首次引导值，例如 `https://notes.example.org` |
| `CASDOOR_SERVER_URL` / `CASDOOR_APPLICATION` | OIDC 初始服务地址及可选应用名；默认不连接真实服务 |
| `CASDOOR_CLIENT_ID` / `CASDOOR_CLIENT_SECRET` | 首次 OIDC 引导凭据，后续从网页修改 |
| `COOKIE_SECURE` | 仅 HTTPS 访问时可设为 `true`；需要 HTTP 内网登录时保留 `false` |
| `MAX_ASSET_BYTES` | 默认单文件上限 32 GiB，上传分块 16 MiB |

平台名称、公共地址、认证方式和 OIDC 凭据首次入库后，以「设置 → 平台管理」保存的值为准。环境变量修改不覆盖已有数据库设置。配置主密钥始终由部署环境保存，恢复数据库时需要原值。

## OIDC

平台支持本地账号、OIDC 或并存。当前实现面向 Casdoor，按已验证邮箱关联已有账号，后续使用 issuer 与 subject 定位稳定身份。OIDC 不直接授予平台管理员角色。

以示例站点为例，回调是：

```text
https://notes.example.org/api/auth/casdoor/callback
```

先使用并存模式保存凭据、检查 discovery，并实际完成当前管理员的 OIDC 登录／绑定，再关闭本地登录。OIDC 来源账号的密码由身份服务管理，本地来源账号通过平台管理密码。

公共地址必须是不带业务路径的 HTTP(S) origin。变更域名时同步更新 DNS、证书、反向代理、平台设置与身份服务回调；旧 MCP 连接重新授权。

## 用户与团队

管理员创建本地用户，或由启用的 OIDC 首次登录生成普通用户。普通用户可创建自己的团队，通过邀请加入其他团队。团队创建者成为团队管理员，成员角色与受限知识库在本团队内管理。

普通团队邀请在有效期内支持多人加入，可撤销；指定邮箱邀请要求匹配已验证邮箱。团队对外分享由安全设置控制。平台角色不自动授予私人内容访问权。

## 入门笔记

首次访问会初始化用户的默认个人知识库。管理员准备唯一、有效的《ANote 功能与使用示例》和《ChatGPT 连接与使用 ANote MCP》个人源笔记后，平台识别并固定来源 ID，为用户提供独立私人副本和“平台入门教程”标签。

源稿不存在或有歧义时延后分发；仓库不包含任何真实用户源稿。复制时保留富文本与媒体排版，并独立授权附件；源评论、协作者和外链不分发。用户改写、分享、评论、归档或删除后，日常初始化不会强制覆盖或复活。

当前权限与保存模型见[架构](architecture.md)。
