import { t as translateUI } from "@anote/i18n";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Editor } from "@tiptap/core";
import { newId } from "@anote/document-model/id";
import { request } from "./native";
const hex = (data: Uint8Array) =>
  Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");
export function assetNodes(values: any[], comparison = false) {
  return comparison &&
    values.length === 2 &&
    values.every((a) => a.kind === "image")
    ? [
        {
          type: "imageComparison",
          attrs: {
            blockId: newId(),
            caption: "",
            layout: "slider",
            images: values.map((a) => ({
              id: a.id,
              assetId: a.id,
              src: a.url,
              localPath: a.localPath,
              label: a.title,
              hash: a.hash,
            })),
          },
        },
      ]
    : values.map((a) => ({
        type: "mediaResource",
        attrs: {
          blockId: newId(),
          assetId: a.id,
          src: a.url,
          localPath: a.localPath,
          title: a.title,
          kind: a.kind,
          mime: a.mime,
          bytes: a.bytes,
          hash: a.hash,
        },
      }));
}
function hashFile(
  file: File,
  signal: AbortSignal,
  progress: (v: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./upload.worker.ts", import.meta.url), {
      type: "module",
    });
    const stop = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      stop();
      reject(new Error(translateUI("上传已停止，可重新选择原文件续传")));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (e) => {
      if (e.data.hash) {
        stop();
        resolve(e.data.hash);
      } else if (e.data.error) {
        stop();
        reject(new Error(e.data.error));
      } else progress(e.data.progress);
    };
    worker.onerror = (e) => {
      stop();
      reject(new Error(e.message));
    };
    worker.postMessage(file);
  });
}
export async function uploadFiles(
  files: File[],
  space: string,
  doc: string,
  signal: AbortSignal,
  progress: (s: string) => void,
) {
  const values = [];
  for (const file of files) {
    const limits = await request("resource-limits");
    if (!file.size || file.size > limits.max_asset_bytes)
      throw new Error(translateUI("{0} 大小超出允许范围", [file.name]));
    const hash = await hashFile(file, signal, (v) =>
      progress(translateUI("{0} · 校验 {1}%", [file.name, Math.round(v * 100)])),
    );
    if (signal.aborted) throw new Error(translateUI("上传已停止"));
    let task = await request("uploads", "POST", {
      space_id: space,
      doc_id: doc,
      filename: file.name,
      bytes: file.size,
      hash,
    });
    while (task.offset < file.size) {
      const chunk = await file
        .slice(task.offset, task.offset + task.chunk_bytes)
        .arrayBuffer();
      const response = await fetch(`/api/uploads/${task.id}/chunk`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Upload-Offset": String(task.offset),
          "Upload-Length": String(chunk.byteLength),
          "X-Chunk-SHA256": hex(sha256(new Uint8Array(chunk))),
        },
        body: chunk,
        signal,
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(
          value.message || value.error || translateUI("上传失败，请重新选择原文件续传"),
        );
      task = value;
      progress(
        translateUI("{0} · 上传 {1}%", [file.name, Math.round((task.offset / file.size) * 100)]),
      );
    }
    if (signal.aborted) throw new Error(translateUI("上传已停止"));
    const asset = await request(`uploads/${task.id}/complete`, "POST", {});
    const attached = await request(`documents/${doc}/assets`, "POST", {
      asset_ids: [asset.id],
    });
    values.push(...attached);
  }
  return values;
}
// Map the insertion point through concurrent edits while files are hashing/uploading.
export async function uploadIntoEditor(
  editor: Editor,
  files: File[],
  space: string,
  doc: string,
  signal: AbortSignal,
  progress: (s: string) => void,
  position = editor.state.selection.from,
  comparison = false,
) {
  let pos = position;
  const map = ({ transaction }: any) => {
    pos = transaction.mapping.map(pos, 1);
  };
  editor.on("transaction", map);
  try {
    const values = await uploadFiles(files, space, doc, signal, progress);
    if (!signal.aborted && !editor.isDestroyed)
      editor
        .chain()
        .focus()
        .insertContentAt(pos, [
          ...assetNodes(values, comparison),
          { type: "paragraph" },
        ])
        .run();
  } finally {
    editor.off("transaction", map);
  }
}
