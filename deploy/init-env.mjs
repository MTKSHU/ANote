import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
try {
  await fs.access("deploy/.env");
  console.log("deploy/.env already exists; left unchanged");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  await fs.writeFile(
    "deploy/.env",
    `DB_PASSWORD=${randomBytes(24).toString("hex")}\nADMIN_USERNAME=admin\nADMIN_PASSWORD=${randomBytes(24).toString("hex")}\nANOTE_PORT=3100\nSETTINGS_ENCRYPTION_KEY=${randomBytes(32).toString("base64url")}\n`,
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created private deploy/.env");
}
