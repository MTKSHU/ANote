import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { sha256 } from "@noble/hashes/sha2.js";
const ScenePreview = lazy(() => import("./scene-preview"));
const kindNames: Record<string, string> = {
  image: translateUI("图片"),
  video: translateUI("视频"),
  audio: translateUI("音频"),
  text: translateUI("文本"),
  mesh: translateUI("网格模型"),
  pointcloud: translateUI("点云"),
  gaussian: translateUI("高斯场景"),
  project: translateUI("工程归档"),
  file: translateUI("其他文件"),
};
const size = (bytes: number) =>
  bytes >= 1024 ** 3
    ? (bytes / 1024 ** 3).toFixed(2) + " GiB"
    : bytes >= 1024 ** 2
      ? (bytes / 1024 ** 2).toFixed(1) + " MiB"
      : (bytes / 1024).toFixed(1) + " KiB";
async function request(
  endpoint: string,
  method = "GET",
  body?: any,
  signal?: AbortSignal,
) {
  const res = await fetch("/api/" + endpoint, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const value = await res.json();
  if (!res.ok)
    throw Object.assign(new Error(value.error || value.message || translateUI("请求失败")), {
      status: res.status,
    });
  return value;
}
function hashFile(
  file: File,
  progress: (value: number) => void,
  signal: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), {
      type: "module",
    });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new DOMException(translateUI("上传已暂停"), "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.onmessage = (event) => {
      if (event.data.hash) {
        stop();
        resolve(event.data.hash);
      } else if (event.data.error) {
        stop();
        reject(new Error(event.data.error));
      } else progress(event.data.progress);
    };
    worker.onerror = () => {
      stop();
      reject(new Error(translateUI("文件校验失败，请重新选择文件")));
    };
    worker.postMessage(file);
  });
}
export function Resources({
  space,
  editable,
  onError,
  query,
}: {
  space: string;
  editable: boolean;
  onError: (error: unknown) => void;
  query: string;
}) {
  const [assets, setAssets] = useState<any[]>([]),
    [uploads, setUploads] = useState<any[]>([]),
    [kind, setKind] = useState(""),
    [archived, setArchived] = useState(false),
    [selected, setSelected] = useState<any>(null),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0),
    [message, setMessage] = useState(""),
    [max, setMax] = useState(32 * 1024 ** 3);
  const abort = useRef<AbortController | null>(null),
    input = useRef<HTMLInputElement>(null),
    generation = useRef(0);
  async function refresh() {
    const current = ++generation.current;
    try {
      const values = await request(
        `assets?space_id=${space}&q=${encodeURIComponent(query)}&kind=${kind}&archived=${archived}`,
      );
      if (current === generation.current) setAssets(values);
      if (editable) {
        const pending = await request(`uploads?space_id=${space}`);
        if (current === generation.current) setUploads(pending);
      }
    } catch (error) {
      onError(error);
    }
  }
  useEffect(() => {
    void refresh();
  }, [space, query, kind, archived, editable]);
  useEffect(() => {
    request("resource-limits")
      .then((v) => setMax(v.max_asset_bytes))
      .catch(onError);
    return () => {
      abort.current?.abort();
      generation.current++;
    };
  }, []);
  async function upload(files: FileList | null) {
    if (!files?.length || busy) return;
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (file.size <= 0 || file.size > max)
          throw new Error(
            translateUI("“{0}”超出文件大小范围，当前上限 {1}", [file.name, size(max)]),
          );
        setMessage(translateUI("正在校验 {0}", [file.name]));
        setProgress(0);
        const hash = await hashFile(file, setProgress, controller.signal);
        let task = await request(
          "uploads",
          "POST",
          { space_id: space, filename: file.name, bytes: file.size, hash },
          controller.signal,
        );
        setMessage(translateUI("正在上传 {0}", [file.name]));
        setProgress(task.offset / file.size);
        while (task.offset < file.size) {
          const bytes = new Uint8Array(
            await file
              .slice(
                task.offset,
                Math.min(file.size, task.offset + task.chunk_bytes),
              )
              .arrayBuffer(),
          );
          const chunkHash = Array.from(sha256(bytes), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join("");
          const res = await fetch(`/api/uploads/${task.id}/chunk`, {
            method: "PUT",
            headers: {
              "Content-Type": "application/octet-stream",
              "Upload-Offset": String(task.offset),
              "X-Chunk-SHA256": chunkHash,
            },
            body: bytes,
            signal: controller.signal,
          });
          const value = await res.json();
          if (!res.ok) {
            if (res.status === 409) {
              task = await request(
                `uploads/${task.id}`,
                "GET",
                undefined,
                controller.signal,
              );
              continue;
            }
            throw Object.assign(new Error(value.error || translateUI("分块上传失败")), {
              status: res.status,
            });
          }
          task = value;
          setProgress(task.offset / file.size);
        }
        setMessage(translateUI("正在核验完整文件 {0}", [file.name]));
        await request(
          `uploads/${task.id}/complete`,
          "POST",
          {},
          controller.signal,
        );
        setMessage(translateUI("{0} 已上传", [file.name]));
        await refresh();
      }
    } catch (error) {
      if (controller.signal.aborted)
        setMessage(translateUI("已暂停。重新选择同一文件即可续传。"));
      else {
        setMessage(translateUI("上传未完成，可重新选择文件续传。"));
        onError(error);
      }
    } finally {
      setBusy(false);
      abort.current = null;
      if (input.current) input.current.value = "";
      await refresh();
    }
  }
  return (
    <section className="resources-page">
      <div className="home-heading">
        <div>
          <p className="kicker">A LIBRARY FOR EVERY FRAME</p>
          <h1>{translateUI("创作与研究的素材库")}</h1>
          <p>{translateUI("原始素材、模型与工程，和团队知识一起积累。")}</p>
        </div>
        <label
          className={
            "primary upload-button" + (!editable || busy ? " disabled" : "")
          }
        >{translateUI("＋ 上传资源 ")}<input
            ref={input}
            type="file"
            multiple
            aria-label={translateUI("上传资源")}
            disabled={!editable || busy}
            onChange={(e) => void upload(e.target.files)}
          />
        </label>
      </div>
      <div className="resource-filters">
        <select
          aria-label={translateUI("资源类型")}
          value={kind}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="">{translateUI("全部类型")}</option>
          {Object.entries(kindNames).map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />{translateUI("显示已归档 ")}</label>
        <button onClick={() => void refresh()}>{translateUI("刷新")}</button>
        <span>
          {assets.length}{translateUI(" 项 · 单文件上限 ")}{size(max)}
        </span>
      </div>
      {message && (
        <div className="upload-progress" role="status">
          <span>{message}</span>
          {busy && (
            <>
              <progress value={progress} max={1} />
              <b>{Math.round(progress * 100)}%</b>
              <button onClick={() => abort.current?.abort()}>{translateUI("暂停上传")}</button>
            </>
          )}
        </div>
      )}
      {uploads.length > 0 && (
        <details className="pending-uploads">
          <summary>{uploads.length}{translateUI(" 个待续传任务")}</summary>
          <p>{translateUI("关闭页面后进度仍会保留。选择原文件，校验一致后从已完成分块继续。 ")}</p>
          {uploads.map((task) => (
            <div key={task.id}>
              <span>
                {task.filename} · {size(task.offset)} / {size(task.bytes)}
              </span>
              <button
                disabled={busy}
                onClick={async () => {
                  try {
                    await request(`uploads/${task.id}`, "DELETE");
                    await refresh();
                  } catch (error) {
                    onError(error);
                  }
                }}
              >{translateUI("取消任务 ")}</button>
            </div>
          ))}
        </details>
      )}
      {assets.length ? (
        <div className="resource-grid">
          {assets.map((asset) => (
            <button
              className="resource-card"
              key={asset.id}
              onClick={() => setSelected(asset)}
            >
              <div className={"resource-cover " + asset.kind}>
                {asset.kind === "image" ? (
                  <img src={asset.url} loading="lazy" alt={asset.title} />
                ) : (
                  <span>
                    {(
                      {
                        video: "▷",
                        audio: "♫",
                        mesh: "◇",
                        gaussian: "✧",
                        pointcloud: "∴",
                        text: "▤",
                        project: "▣",
                      } as any
                    )[asset.kind] || "▧"}
                  </span>
                )}
                <small>{kindNames[asset.kind]}</small>
              </div>
              <div className="resource-card-body">
                <h3>{asset.title}</h3>
                <p>
                  {size(asset.bytes)} ·{" "}
                  {new Date(asset.created_at).toLocaleDateString(uiLocale())}
                </p>
                <div className="card-tags">
                  {asset.tags.map((tag: string) => (
                    <span key={tag}>#{tag}</span>
                  ))}
                </div>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-notes">
          <span>▣</span>
          <h3>{translateUI("还没有匹配的资源")}</h3>
          <p>{translateUI("上传剧本、图片、音视频或模型，建立团队共享资源库。")}</p>
        </div>
      )}
      {selected && (
        <AssetDialog
          asset={selected}
          editable={editable}
          onClose={() => setSelected(null)}
          onError={onError}
          onChange={(value) => {
            setSelected(value);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
function AssetDialog({
  asset,
  editable,
  onClose,
  onError,
  onChange,
}: {
  asset: any;
  editable: boolean;
  onClose: () => void;
  onError: (error: unknown) => void;
  onChange: (value: any) => void;
}) {
  const [title, setTitle] = useState<string>(asset.title),
    [description, setDescription] = useState<string>(asset.description),
    [tags, setTags] = useState<string>(asset.tags.join(", ")),
    [text, setText] = useState(""),
    [render, setRender] = useState(false),
    [busy, setBusy] = useState(false),
    [details, setDetails] = useState(asset);
  useEffect(() => {
    let disposed = false;
    request(`assets/${asset.id}`)
      .then((v) => {
        if (!disposed) setDetails(v);
      })
      .catch(onError);
    if (asset.kind === "text")
      fetch(asset.url, { headers: { Range: "bytes=0-65535" } })
        .then((r) => {
          if (!r.ok) throw new Error(translateUI("文本读取失败"));
          return r.text();
        })
        .then((v) => {
          if (!disposed) setText(v);
        })
        .catch(onError);
    return () => {
      disposed = true;
    };
  }, [asset.id]);
  return (
    <div className="modal">
      <section className="asset-dialog" role="dialog" aria-label={translateUI("资源详情")}>
        <div className="modal-heading">
          <div>
            <p className="kicker">
              {kindNames[asset.kind]} · {size(asset.bytes)}
            </p>
            <h2>{asset.title}</h2>
          </div>
          <button aria-label={translateUI("关闭资源详情")} onClick={onClose}>
            ×
          </button>
        </div>
        <div className="asset-dialog-columns">
          <div className="asset-preview">
            {asset.kind === "image" ? (
              <img src={asset.url} alt={asset.title} />
            ) : asset.kind === "video" ? (
              <video controls preload="metadata" src={asset.url} />
            ) : asset.kind === "audio" ? (
              <audio controls preload="metadata" src={asset.url} />
            ) : asset.kind === "text" ? (
              <pre>
                {text}
                {asset.bytes > 65536 ? translateUI("\n…仅预览前 64 KiB") : ""}
              </pre>
            ) : ["mesh", "pointcloud", "gaussian"].includes(asset.kind) ? (
              render ? (
                <Suspense fallback={<p>{translateUI("正在载入 3D 查看器…")}</p>}>
                  <ScenePreview asset={asset} />
                </Suspense>
              ) : (
                <div className="scene-intro">
                  <span>◇</span>
                  <h3>{kindNames[asset.kind]}{translateUI("交互预览")}</h3>
                  <p>{translateUI("旋转、缩放与平移查看场景。 ")}{asset.metadata.format === "obj"
                      ? translateUI("OBJ 预览几何；材质请导出为 GLB。")
                      : ""}
                  </p>
                  <button
                    className="primary"
                    disabled={asset.bytes > 256 * 1024 ** 2}
                    onClick={() => setRender(true)}
                  >{translateUI("载入 3D 场景 ")}</button>
                  {asset.bytes > 256 * 1024 ** 2 && (
                    <p>{translateUI("此文件超过浏览器预览上限 256 MiB，请下载原文件，或上传精简预览。 ")}</p>
                  )}
                </div>
              )
            ) : (
              <div className="scene-intro">
                <span>▣</span>
                <h3>{translateUI("原始文件已保存")}</h3>
                <p>
                  {asset.kind === "project"
                    ? translateUI("工程可下载到对应软件打开。可另行上传导出的 GLB、PLY 或视频用于浏览器预览。")
                    : translateUI("请下载原文件查看。")}
                </p>
              </div>
            )}
            <div className="asset-technical">
              <b>{translateUI("原文件")}</b>
              <p>{asset.filename}</p>
              <p className="hash">SHA-256 {asset.hash}</p>
              {details.metadata?.duration && (
                <p>{translateUI("时长 ")}{Number(details.metadata.duration).toFixed(2)}{translateUI(" 秒")}</p>
              )}
              {details.metadata?.width && (
                <p>
                  {details.metadata.width} × {details.metadata.height}
                </p>
              )}
              {details.jobs?.map((job: any) => (
                <p key={job.id}>{translateUI("媒体解析： ")}{
                    (
                      {
                        pending: translateUI("等待处理"),
                        running: translateUI("处理中"),
                        complete: translateUI("完成"),
                        failed: translateUI("失败"),
                      } as any
                    )[job.status]
                  }
                  {job.error ? " · " + job.error : ""}
                </p>
              ))}
              <a href={asset.url + "?download=1"} download={asset.filename}>{translateUI("↓ 下载原文件 ")}</a>
            </div>
          </div>
          <form
            className="asset-metadata"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                onChange(
                  await request(`assets/${asset.id}`, "PATCH", {
                    revision: asset.revision,
                    title,
                    description,
                    tags: tags
                      .split(/[,，]/)
                      .map((v) => v.trim())
                      .filter(Boolean),
                  }),
                );
              } catch (error) {
                onError(error);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>{translateUI("资源标题 ")}<input
                aria-label={translateUI("资源标题")}
                value={title}
                required
                maxLength={240}
                disabled={!editable}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label>{translateUI("标签 ")}<input
                aria-label={translateUI("资源标签")}
                value={tags}
                disabled={!editable}
                onChange={(e) => setTags(e.target.value)}
              />
            </label>
            <label>{translateUI("说明 ")}<textarea
                aria-label={translateUI("资源说明")}
                rows={8}
                maxLength={10000}
                value={description}
                disabled={!editable}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <button className="primary" disabled={!editable || busy}>{translateUI("保存资料 ")}</button>
            <button
              type="button"
              disabled={!editable || busy}
              onClick={async () => {
                try {
                  onChange(
                    await request(`assets/${asset.id}`, "PATCH", {
                      revision: asset.revision,
                      archived: !asset.archived,
                    }),
                  );
                  onClose();
                } catch (error) {
                  onError(error);
                }
              }}
            >
              {asset.archived ? translateUI("恢复资源") : translateUI("归档资源")}
            </button>
            <p>{translateUI("归档保留原文件及已有引用。")}</p>
          </form>
        </div>
      </section>
    </div>
  );
}
