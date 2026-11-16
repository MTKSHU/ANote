import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
import { connectForClientUpdate } from "../../desktop/renderer/client-updates";

type MobilePackage = { platform: "android" | "harmonyos" | "ios"; kind: "apk" | "hap" | "source"; version: string; channel: "preview" | "stable"; signing: "test" | "unsigned" | "release" | "source"; file: string; bytes: number; sha256: string; url: string };
const platforms = { android: "Android", harmonyos: "HarmonyOS", ios: translateUI("iOS 源工程") };
const signatures = { test: translateUI("内部测试签名"), unsigned: translateUI("未签名"), release: translateUI("发行签名"), source: translateUI("源工程，非安装包") };
const fileSize = (bytes: number) => bytes < 1024 ** 2 ? (bytes / 1024).toFixed(1) + " KiB" : (bytes / 1024 ** 2).toFixed(1) + " MiB";
export function MobileClients({ authenticated = true, onConnectServer, serverURL }: { authenticated?: boolean; onConnectServer?: () => void; serverURL?: string }) {
  const [value, setValue] = useState<MobilePackage[] | null>(null), [error, setError] = useState(""), [needsAuth, setNeedsAuth] = useState(false), [attempt, setAttempt] = useState(0);
  let serverOrigin = "";
  try { const server = new URL(serverURL || location.origin); if (["http:", "https:"].includes(server.protocol) && !server.username && !server.password) serverOrigin = server.origin; } catch {}
  useEffect(() => {
    if (!authenticated) return;
    const abort = new AbortController();
    setValue(null); setError(""); setNeedsAuth(false);
    fetch("/api/client-releases/mobile", { signal: abort.signal }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { setNeedsAuth(true); return; }
      if (!response.ok) throw new Error(response.status === 404 ? translateUI("当前服务器尚未提供移动客户端下载列表。") : data.error || translateUI("移动客户端列表读取失败"));
      if (!Array.isArray(data.packages)) throw new Error(translateUI("移动客户端下载资料暂不可用"));
      if (!abort.signal.aborted) setValue(data.packages);
    }).catch(reason => { if (!abort.signal.aborted) setError(translateUI(reason instanceof Error ? reason.message : translateUI("移动客户端列表读取失败"))); });
    return () => abort.abort();
  }, [authenticated, attempt, serverURL]);
  return <section className="client-howto" aria-label={translateUI("移动客户端下载")}>
    <h2>{translateUI("移动客户端")}</h2>
    {!authenticated || needsAuth ? <><p>{translateUI("连接服务器后可查看并下载移动应用。")}</p><button type="button" onClick={() => connectForClientUpdate(onConnectServer)}>{translateUI("连接服务器查看移动应用")}</button></>
      : error ? <><p role="status">{error}</p><button type="button" onClick={() => setAttempt(value => value + 1)}>{translateUI("重新读取移动客户端列表")}</button></>
      : value === null ? <p role="status">{translateUI("正在读取移动客户端…")}</p>
      : value.length === 0 ? <p>{translateUI("服务器暂未提供移动应用安装包。")}</p>
      : <>
        {value.some(item => item.channel === "preview") && <p className="client-preview-note">{translateUI("移动预览版仍需设备验收。Android 测试签名包可用于内部测试；未签名 HarmonyOS HAP 需开发环境签名后安装；iOS 提供 Xcode 源工程，暂无可分发安装包。")}</p>}
        <div className="client-download-list" role="region" aria-label={translateUI("移动客户端下载列表")} tabIndex={0}>
          <table className="client-download-table" aria-label={translateUI("移动客户端下载")}>
            <thead><tr><th scope="col">{translateUI("平台与应用")}</th><th scope="col">{translateUI("版本与状态")}</th><th scope="col">SHA-256</th><th scope="col">{translateUI("下载")}</th></tr></thead>
            <tbody>{value.map(item => <tr className="client-download" key={item.file}>
              <th scope="row" className="client-package-name" title={item.file}>{platforms[item.platform]}<p className="muted">{item.file} · {fileSize(item.bytes)}</p></th>
              <td>{item.version} · {item.channel === "preview" ? translateUI("预览版") : translateUI("正式版")}<p className="muted">{signatures[item.signing]}</p></td>
              <td><code>{item.sha256}</code></td>
              <td><a href={item.url} download={item.file} aria-label={translateUI("下载 {0}", [item.file])}>↓ {item.kind === "source" ? translateUI("下载源工程") : translateUI("下载")}</a></td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="muted">{translateUI("移动应用的版本独立于桌面客户端；下载不会替换或重启当前桌面程序。")}</p>
        {serverOrigin && <p>{translateUI("安装后在首次连接页面填写服务器地址：")}<code>{serverOrigin}</code>{translateUI("。预览包中预填的测试地址可以修改。")}</p>}
      </>}
  </section>;
}
