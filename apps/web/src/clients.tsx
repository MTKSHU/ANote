import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState } from "react";
const names: Record<string, string> = {
  "win32-x64": "Windows",
  "darwin-x64": "macOS Intel",
  "darwin-arm64": "macOS Apple Silicon",
  "linux-x64": "Linux",
};
export function Clients({ onError }: { onError: (error: unknown) => void }) {
  const [value, setValue] = useState<any>(null);
  useEffect(() => {
    fetch("/api/client-releases")
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok)
          throw Object.assign(new Error(data.error || translateUI("客户端列表读取失败")), {
            status: res.status,
          });
        setValue(data);
      })
      .catch(onError);
  }, []);
  return (
    <section className="resources-page">
      <div className="home-heading">
        <div>
          <p className="kicker">YOUR NOTES, WHERE YOU WORK</p>
          <h1>{translateUI("桌面客户端")}</h1>
          <p>{translateUI("共享富文本编辑、离线保存，以及本地 Markdown 双向同步。")}</p>
        </div>
      </div>
      {value?.packages?.length ? (
        <>
          <div className="client-preview-note">{translateUI("内部预览版 ")}{value.version} · {value.signed ? translateUI("已签名") : translateUI("未签名")}{translateUI("。Linux 已在容器中运行验证；Windows 与 macOS 的原生验收尚待完成。 ")}</div>
          <div className="client-download-list" role="region" aria-label={translateUI("客户端下载列表")} tabIndex={0}>
            <table className="client-download-table" aria-label={translateUI("桌面客户端下载")}>
              <thead>
                <tr>
                  <th scope="col">{translateUI("应用名称")}</th>
                  <th scope="col">{translateUI("平台")}</th>
                  <th scope="col">SHA-256</th>
                  <th scope="col">{translateUI("下载")}</th>
                </tr>
              </thead>
              <tbody>
                {value.packages.map((item: any) => (
                  <tr className="client-download" key={item.file}>
                    <th scope="row" className="client-package-name" title={`${names[item.platform + "-" + item.arch] || item.platform + " " + item.arch} · ${(item.bytes / 1024 ** 2).toFixed(1)} MiB`}>
                      {item.file}
                    </th>
                    <td>{names[item.platform + "-" + item.arch] || item.platform + " " + item.arch}</td>
                    <td><code>{item.sha256}</code></td>
                    <td>
                      <a href={item.url} download={item.file} aria-label={translateUI("下载 {0}", [item.file])}>{translateUI("↓ 下载 ")}</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="client-howto">
            <h3>{translateUI("开始使用")}</h3>
            <ol>
              <li>{translateUI("解压对应系统的客户端，以普通用户打开 ANote。")}</li>
              <li>{translateUI("服务地址填写当前团队平台地址，使用自己的成员账号登录。")}</li>
              <li>{translateUI("选择独立的本地工作目录，在笔记中点击“下载到本地目录”。")}</li>
              <li>{translateUI("在客户端编辑富文本，或修改受管 Markdown。发生冲突时先保留本地内容，再选择合并方式。 ")}</li>
            </ol>
            <p>{translateUI("macOS 构建尚未进行 Developer ID 签名与公证。每个账号使用自己的目录；保留目录内的 .anote 元数据。 ")}</p>
          </div>
        </>
      ) : (
        <div className="empty-notes">
          <span>▱</span>
          <h3>{value ? translateUI("客户端构建正在准备") : translateUI("正在读取客户端构建…")}</h3>
          <p>{translateUI("网页笔记与资源功能可继续使用。")}</p>
        </div>
      )}
    </section>
  );
}
