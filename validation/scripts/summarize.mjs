import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
const unit = await fs.readFile("validation/artifacts/unit-results.txt", "utf8");
const browser = JSON.parse(
  await fs.readFile("validation/artifacts/browser-results.json", "utf8"),
);
const persistence = JSON.parse(
  await fs.readFile("validation/artifacts/persistence-results.json", "utf8"),
);
const count = (name) =>
  Number(new RegExp(`# ${name} (\\d+)`).exec(unit)?.[1] || 0);
const suites = {
  unit: { passed: count("pass"), failed: count("fail") },
  browser: {
    passed: browser.stats.expected,
    failed: browser.stats.unexpected,
    skipped: browser.stats.skipped,
  },
  persistence: {
    passed: persistence.stats.expected,
    failed: persistence.stats.unexpected,
    skipped: persistence.stats.skipped,
  },
};
if (
  suites.unit.passed < 13 ||
  suites.browser.passed < 8 ||
  suites.persistence.passed < 1 ||
  Object.values(suites).some((s) => s.failed || s.skipped) ||
  count("cancelled") ||
  count("skipped")
)
  throw new Error(
    "Verification is incomplete or failing; refusing to generate a success report",
  );
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (
      ["artifacts", "dist", "data"].includes(entry.name) ||
      entry.name === ".env"
    )
      continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(file)));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
const sources = [
    ...(await files("validation")),
    ...(await files("packages")),
    "package.json",
    "package-lock.json",
  ].sort(),
  sourceHashes = {};
for (const file of sources)
  sourceHashes[file] = createHash("sha256")
    .update(await fs.readFile(file))
    .digest("hex");
const evidence = {
  verifiedAt: new Date().toISOString(),
  timezone: "Asia/Shanghai",
  scope: "collaboration-richtext-markdown-validation",
  suites,
  totalPassed: Object.values(suites).reduce((n, s) => n + s.passed, 0),
  runtime: {
    node: process.version,
    execution: "Docker containers only",
    database: "PostgreSQL 17",
    browser: "Playwright Chromium",
  },
  limits: [
    "Third-party file-sync integration and VS Code extension are excluded; actual local files used",
    "Enhanced blocks are preserved and protected; local structural edits require conflict handling",
    "New/deleted/reordered Markdown blocks require explicit conflict handling",
    "Graceful service/database restart tested; crash recovery and load capacity not proven",
    "Validation identities and bootstrap schema are not production authentication or migrations",
  ],
  sourceHashes,
};
await fs.mkdir("docs", { recursive: true });
await fs.mkdir("artifacts/reports", { recursive: true });
await fs.writeFile(
  "artifacts/reports/validation-evidence.json",
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    totalPassed: evidence.totalPassed,
    suites,
    evidence: "artifacts/reports/validation-evidence.json",
  }),
);
