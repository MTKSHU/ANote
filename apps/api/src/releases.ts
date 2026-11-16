import { Controller, Get, Param, Req, Res, Module } from "@nestjs/common";
import type { Request, Response } from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { user } from "./auth.js";
import { fail } from "./errors.js";
import { sendFile } from "./storage.js";
import { releaseList, releasePackage, validateReleaseManifest, releaseCheck, ReleaseCheckError } from "./release-manifest.js";
import { mobileReleaseList, readMobileReleaseManifest } from "./mobile-releases.js";
const directory = path.resolve(
  process.env.DESKTOP_RELEASE_DIR || "/data/clients",
);
async function manifest() {
  try {
    return validateReleaseManifest(JSON.parse(
      await fs.readFile(path.join(directory, "manifest.json"), "utf8"),
    ));
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
  @Get("mobile") async mobileList(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await user(req);
    res.setHeader("Cache-Control", "no-store");
    return mobileReleaseList(await readMobileReleaseManifest(path.join(directory, "mobile")));
  }
  @Get("mobile/:filename") async mobileDownload(@Req() req: Request, @Res() res: Response, @Param("filename") filename: string) {
    await user(req);
    const root = path.join(directory, "mobile"), manifest = await readMobileReleaseManifest(root), item = manifest.packages.find(item => item.file === filename);
    if (!item) fail(404, "移动客户端构建不存在");
    const file = path.join(root, item.file), stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.isSymbolicLink() || !stat.isFile() || stat.size !== item.bytes) fail(503, "移动客户端文件校验信息不一致");
    await sendFile(req, res, file, { filename: item.file, hash: item.sha256, mime: item.kind === "apk" ? "application/vnd.android.package-archive" : item.kind === "source" ? "application/gzip" : "application/octet-stream" });
  }
  @Get("check") async check(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Anonymous version discovery does not grant access to the package itself.
    // Set before validation so unsupported targets and temporary failures also
    // cannot be cached by a browser or reverse proxy.
    res.setHeader("Cache-Control", "no-store");
    try {
      return releaseCheck(await manifest(), req.query);
    } catch (error) {
      if (error instanceof ReleaseCheckError) fail(error.status, error.message);
      throw error;
    }
  }
  @Get() async list(@Req() req: Request) {
    await user(req);
    const value = await manifest();
    return releaseList(value, req.query.brand);
  }
  @Get(":filename") async download(
    @Req() req: Request,
    @Res() res: Response,
    @Param("filename") filename: string,
  ) {
    await user(req);
    const value = await manifest(),
      item = releasePackage(value, filename);
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
