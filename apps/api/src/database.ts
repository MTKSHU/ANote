import { Pool, type PoolClient } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});
export const digest = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
export async function migrate(
  directory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../migrations",
  ),
) {
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('anote:migrations'))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY,hash TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT now())",
    );
    for (const name of (await fs.readdir(directory))
      .filter((name) => /^\d+_.*\.sql$/.test(name))
      .sort()) {
      const sql = await fs.readFile(path.join(directory, name), "utf8"),
        hash = digest(sql),
        previous = (
          await client.query(
            "SELECT hash FROM schema_migrations WHERE name=$1",
            [name],
          )
        ).rows[0];
      if (previous) {
        if (previous.hash !== hash)
          throw new Error("Applied migration was changed: " + name);
        continue;
      }
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations(name,hash) VALUES($1,$2)",
        [name, hash],
      );
    }
  });
}
