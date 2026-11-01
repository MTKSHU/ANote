import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
const file = "deploy/.env",
  raw = await fs.readFile(file, "utf8");
if (!/^SETTINGS_ENCRYPTION_KEY=\S+/m.test(raw)) {
  const next = raw.replace(/^SETTINGS_ENCRYPTION_KEY=.*\r?\n?/gm, "");
  await fs.writeFile(
    file,
    next.trimEnd() +
      "\nSETTINGS_ENCRYPTION_KEY=" +
      randomBytes(32).toString("base64url") +
      "\n",
    { mode: 0o600 },
  );
  console.log("Prepared platform-settings encryption key; value not displayed");
} else console.log("Platform-settings encryption key already present");
