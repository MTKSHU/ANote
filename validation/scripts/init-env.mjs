import fs from "node:fs";
import { randomBytes } from "node:crypto";
if (!fs.existsSync("validation/.env")) {
  fs.writeFileSync(
    "validation/.env",
    `VALIDATION_DB_PASSWORD=${randomBytes(24).toString("hex")}\nVALIDATION_SECRET=${randomBytes(24).toString("hex")}\nVALIDATION_PORT=3099\n`,
    { mode: 0o600 },
  );
  console.log("Created validation/.env; credentials were not printed.");
} else console.log("Reusing existing validation/.env.");
