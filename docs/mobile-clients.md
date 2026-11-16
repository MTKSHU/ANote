# ANote 移动客户端

移动端是连接自托管 ANote 服务的原生 WebView 外壳，服务器地址由用户选择。数字版本跟随桌面 `apps/desktop/package.json`，当前为 0.5.10 / build 510。

在仓库根目录使用 Docker 构建：

```sh
bash scripts/mobile-build-android.sh
bash scripts/mobile-build-harmonyos.sh
bash scripts/mobile-pack-ios-source.sh
```

Android 脚本使用独立 Docker 签名卷保存测试签名资料；不要提交密钥。HarmonyOS 产出未签名 HAP，需开发环境签名后安装；iOS 只打包 Xcode 源工程，需要 macOS、Xcode 及相应签名条件生成安装包。版本一致性可在 Node Docker 容器中运行 `node scripts/sync-mobile-version.mjs --check`。输出在 `artifacts/mobile/版本/`，不纳入 Git。

调试仅使用隔离的服务。Android／HarmonyOS 构建脚本通过 `MOBILE_PREVIEW_ORIGIN` 向容器传入 `PREVIEW_ORIGIN`；iOS 源工程默认地址为空，调试 HTTP 时需自行配置预览地址及 ATS 例外。勿把生产地址或测试账号固化到公开源码或分发包中。桌面与移动的下载清单分开，安装移动应用不会更新桌面程序。
