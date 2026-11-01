import { Controller, Get, Param, Req, Res, Module } from "@nestjs/common";
import type { Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { user } from "./auth.js";
import { fail } from "./errors.js";
import { sendFile } from "./storage.js";
const directory = path.resolve(
  process.env.DESKTOP_RELEASE_DIR || "/data/clients",
);
async function manifest() {
  try {
    const value = JSON.parse(
      await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
    );
    if (!Array.isArray(value.packages)) throw new Error("Missing packages");
    for (const item of value.packages)
      if (
        !/^ANote-[A-Za-z0-9_.-]+$/.test(item.file) ||
        !/^[a-f0-9]{64}$/.test(item.sha256) ||
        !Number.isSafeInteger(item.bytes) ||
        item.bytes <= 0
      )
        throw new Error("Invalid release");
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        version: null,
        packages: [],
        signed: false,
        nativeAcceptance: {},
      };
    fail(503, "客户端下载资料暂不可用");
  }
}
@Controller("api/client-releases")
export class ReleasesController {
  @Get() async list(@Req() req: Request) {
    await user(req);
    const value = await manifest();
    return {
      version: value.version,
      electron: value.electron,
      signed: value.signed,
      nativeAcceptance: value.nativeAcceptance,
      packages: value.packages.map(
        ({ platform, arch, file, bytes, sha256 }: any) => ({
          platform,
          arch,
          file,
          bytes,
          sha256,
          url: "/api/client-releases/" + encodeURIComponent(file),
        }),
      ),
    };
  }
  @Get(":filename") async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param("filename") filename: string,
  ) {
    await user(req);
    const value = await manifest(),
      item = value.packages.find((item: any) => item.file === filename);
    if (!item) fail(404, "客户端构建不存在");
    const file = path.join(directory, item.file),
      stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== item.bytes)
      fail(503, "客户端文件校验信息不一致");
    await sendFile(req, res, file, {
      filename: item.file,
      hash: item.sha256,
      mime: item.file.endsWith(".zip") ? "application/zip" : "application/gzip",
    });
  }
}
@Module({ controllers: [ReleasesController] })
export class ReleasesModule {}
