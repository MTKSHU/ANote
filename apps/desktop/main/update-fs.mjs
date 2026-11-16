import nodeFS from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// Electron's patched fs treats app.asar as a virtual directory. Updates must
// inspect and copy the archive as bytes, without executing anything inside it.
const rawFS = process.versions.electron
  ? createRequire(path.join(path.dirname(process.execPath), "updater.cjs"))("original-fs")
  : nodeFS;
export const updateFS = rawFS.promises;
export const updateReadStream = rawFS.createReadStream;
export const updateWriteStream = rawFS.createWriteStream;
