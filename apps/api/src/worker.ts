import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db, transaction } from "./database.js";
import { storagePath, fileHash } from "./storage.js";

let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
  });
async function command(
  binary: string,
  args: string[],
  limit = 2 * 1024 ** 2,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] }),
      out: Buffer[] = [],
      errors: Buffer[] = [];
    let bytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) child.kill("SIGKILL");
      else out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (errors.reduce((n, b) => n + b.length, 0) < 16000) errors.push(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("媒体解析失败，原文件仍可下载"));
      else resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}
async function claim() {
  return transaction(async (client) => {
    const job = (
      await client.query(
        "SELECT * FROM jobs WHERE kind='probe' AND (status='pending' OR (status='running' AND locked_at<now()-interval '5 minutes')) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!job) return null;
    const lease = randomUUID();
    return (
      await client.query(
        "UPDATE jobs SET status='running',attempts=attempts+1,locked_at=now(),lease_id=$2,progress=5,error=NULL WHERE id=$1 RETURNING *",
        [job.id, lease],
      )
    ).rows[0];
  });
}
async function processJob(job: any) {
  const row = (
    await db.query("SELECT * FROM assets WHERE id=$1", [job.asset_id])
  ).rows[0];
  if (!row) return;
  const input = storagePath("originals", row.storage_key),
    output = storagePath("derived", row.id + ".jpg");
  const heartbeat = setInterval(() => {
    void db
      .query(
        "UPDATE jobs SET locked_at=now() WHERE id=$1 AND lease_id=$2 AND status='running'",
        [job.id, job.lease_id],
      )
      .catch(() => {});
  }, 20000);
  try {
    const raw = await command("ffprobe", [
      "-v",
      "error",
      "-protocol_whitelist",
      "file,pipe",
      "-format_whitelist",
      "mov,matroska,webm,mp3,wav,ogg,flac,image2,png_pipe,jpeg_pipe,gif,webp_pipe",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels",
      "-of",
      "json",
      input,
    ]);
    const info = JSON.parse(raw),
      video = info.streams?.find((v: any) => v.codec_type === "video"),
      audio = info.streams?.find((v: any) => v.codec_type === "audio");
    const metadata: any = {
      ...row.metadata,
      ...(video
        ? {
            width: video.width,
            height: video.height,
            video_codec: video.codec_name,
          }
        : {}),
      ...(audio
        ? {
            audio_codec: audio.codec_name,
            sample_rate: audio.sample_rate,
            channels: audio.channels,
          }
        : {}),
    };
    if (Number.isFinite(Number(info.format?.duration)))
      metadata.duration = Number(info.format.duration);
    if (video) {
      const temp = storagePath("derived", row.id + "." + job.lease_id + ".jpg");
      try {
        await command("ffmpeg", [
          "-nostdin",
          "-v",
          "error",
          "-threads",
          "1",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov,matroska,webm,image2,png_pipe,jpeg_pipe,gif,webp_pipe",
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=640:640:force_original_aspect_ratio=decrease",
          "-threads",
          "1",
          "-y",
          temp,
        ]);
        await fs.rename(temp, output);
        metadata.thumbnail = {
          key: row.id + ".jpg",
          hash: await fileHash(output),
        };
      } finally {
        await fs.rm(temp, { force: true });
      }
    }
    await transaction(async (client) => {
      const held = (
        await client.query(
          "UPDATE jobs SET status='complete',progress=100,completed_at=now(),locked_at=NULL WHERE id=$1 AND lease_id=$2 AND status='running' RETURNING id",
          [job.id, job.lease_id],
        )
      ).rowCount;
      if (held)
        await client.query(
          "UPDATE assets SET metadata=metadata||$2::jsonb WHERE id=$1",
          [row.id, JSON.stringify(metadata)],
        );
    });
  } catch (error) {
    await db.query(
      "UPDATE jobs SET status=$3,error=$4,locked_at=NULL WHERE id=$1 AND lease_id=$2",
      [
        job.id,
        job.lease_id,
        job.attempts >= 3 ? "failed" : "pending",
        (error as Error).message.slice(0, 300),
      ],
    );
  } finally {
    clearInterval(heartbeat);
  }
}
while (!stopping) {
  const job = await claim().catch(() => null);
  if (job) await processJob(job);
  else await delay(1000);
}
await db.end();
