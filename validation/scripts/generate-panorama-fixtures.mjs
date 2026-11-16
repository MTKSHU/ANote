// Run inside the existing FFmpeg worker image, never on the TrueNAS host.
import { mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const directory = path.resolve("artifacts/server/fixtures");
await mkdir(directory, { recursive: true });
execFileSync("ffmpeg", [
  "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=1024x512:rate=10",
  "-t", "3", "-an", "-c:v", "libvpx", "-b:v", "300k",
  "-deadline", "realtime", "-cpu-used", "8", "-threads", "1",
  path.join(directory, "panorama.webm"),
], { stdio: "inherit" });
console.log("Generated 1024×512, three-second panoramic video fixture.");
