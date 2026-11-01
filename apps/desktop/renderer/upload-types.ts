import { t as translateUI } from "@anote/i18n";
export type UploadCategory =
  | "image"
  | "audio"
  | "video"
  | "document"
  | "project"
  | "comparison";
export const uploadTypes: Record<
  UploadCategory,
  { label: string; accept: string; hint: string }
> = {
  image: {
    label: translateUI("图片"),
    accept: "image/*",
    hint: translateUI("上传图片，或直接粘贴、拖入正文"),
  },
  audio: {
    label: translateUI("音频"),
    accept: "audio/*,.mp3,.wav,.flac,.ogg,.m4a",
    hint: translateUI("音频播放器"),
  },
  video: {
    label: translateUI("视频"),
    accept: "video/*,.mp4,.webm,.mov,.mkv",
    hint: translateUI("视频播放器"),
  },
  document: {
    label: translateUI("附件"),
    accept:
      ".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.odt,.odp,.ods,.rtf,.txt,.md,.csv",
    hint: translateUI("PDF、Word、PPT、Excel 等文档"),
  },
  project: {
    label: translateUI("三维文件／项目"),
    accept:
      ".glb,.gltf,.obj,.ply,.splat,.blend,.unity,.unitypackage,.uproject,.uasset,.umap,.zip,.7z,.tar,.gz",
    hint: translateUI("模型预览或 Blender、Unity、UE 工程归档；含关联文件的项目请打包上传"),
  },
  comparison: {
    label: translateUI("双图对比"),
    accept: "image/*",
    hint: translateUI("选择两张图片，在图片上直接拖动比较"),
  },
};
