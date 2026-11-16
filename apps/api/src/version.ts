import { Controller, Get, Header } from "@nestjs/common";
import { EDITOR_SCHEMA_VERSION } from "@anote/document-model";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readVersionInfo, type PlatformVersion } from "./version-info.js";

const webIndex = fileURLToPath(new URL("../../web/dist/index.html", import.meta.url));
const releaseManifest = path.join(
  path.resolve(process.env.DESKTOP_RELEASE_DIR || "/data/clients"),
  "manifest.json",
);

@Controller("api/version")
export class VersionController {
  private cached: PlatformVersion | undefined;
  private expiresAt = 0;

  @Get()
  @Header("Cache-Control", "no-store")
  async current(): Promise<PlatformVersion> {
    if (!this.cached || Date.now() >= this.expiresAt) {
      this.cached = await readVersionInfo(webIndex, releaseManifest, EDITOR_SCHEMA_VERSION);
      this.expiresAt = Date.now() + 30_000;
    }
    return this.cached;
  }
}
