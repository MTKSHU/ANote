import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionStore, atomicJSON } from "../../apps/desktop/main/session-store.mjs";

const token = "A".repeat(43);
const encrypted = Buffer.from("opaque-os-encrypted-credential");
const storage = (extra = {}) => ({
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptStringAsync: async value => { assert.equal(value, token); return encrypted; },
  decryptStringAsync: async bytes => { assert.deepEqual(bytes, encrypted); return { result: token, shouldReEncrypt: false }; },
  ...extra,
});
async function temporary(work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anote-session-"));
  try { await work(root); } finally { await fs.rm(root, { force: true, recursive: true }); }
}
async function seed(root) {
  await atomicJSON(path.join(root, "settings.json"), { serverURL: "https://example.test", user: { id: "account-one" }, offline: false });
  await fs.writeFile(path.join(root, "session.bin"), encrypted);
}

test("saved login survives a restart with Electron 45 async decryption's object result", () => temporary(async root => {
  const first = await new SessionStore(root, storage()).load();
  await first.acceptSession("https://example.test", { token, user: { id: "account-one" } });
  const restarted = await new SessionStore(root, storage()).load();
  assert.equal(restarted.token, token);
  assert.equal(restarted.state().token, token);
  assert.equal(restarted.state().offline, false);
  assert.equal(restarted.state().credentialWarning, "");
  assert.equal(JSON.stringify(await fs.readFile(path.join(root, "settings.json"), "utf8")).includes(token), false);
}));

test("key rotation replaces the encrypted credential atomically without plaintext files", () => temporary(async root => {
  await seed(root);
  const rotated = Buffer.from("new-opaque-key");
  const session = await new SessionStore(root, storage({
    decryptStringAsync: async () => ({ result: token, shouldReEncrypt: true }),
    encryptStringAsync: async value => { assert.equal(value, token); return rotated; },
  })).load();
  assert.equal(session.token, token);
  assert.deepEqual(await fs.readFile(path.join(root, "session.bin")), rotated);
  assert.deepEqual((await fs.readdir(root)).sort(), ["session.bin", "settings.json"]);
}));

test("temporary key rotation failure keeps the restored session and original encrypted file", () => temporary(async root => {
  await seed(root);
  const session = await new SessionStore(root, storage({
    decryptStringAsync: async () => ({ result: token, shouldReEncrypt: true }),
    encryptStringAsync: async () => { throw new Error("key provider locked"); },
  })).load();
  assert.equal(session.token, token);
  assert.equal(session.settings.offline, false);
  assert.match(session.credentialWarning, /本次登录已恢复/);
  assert.deepEqual(await fs.readFile(path.join(root, "session.bin")), encrypted);
}));

test("invalid decrypt results never become bearer objects and leave offline notes accessible", () => temporary(async root => {
  await seed(root);
  const session = await new SessionStore(root, storage({ decryptStringAsync: async () => ({ result: { token } }) })).load();
  assert.equal(session.token, null);
  assert.equal(session.settings.user.id, "account-one");
  assert.equal(session.settings.offline, true);
  assert.match(session.credentialWarning, /重新登录/);
  assert.deepEqual(await fs.readFile(path.join(root, "session.bin")), encrypted);
}));

test("unavailable OS storage preserves the encrypted session for a later restart", () => temporary(async root => {
  await seed(root);
  const unavailable = await new SessionStore(root, storage({ isAsyncEncryptionAvailable: async () => false })).load();
  assert.equal(unavailable.token, null);
  assert.equal(unavailable.settings.offline, true);
  assert.deepEqual(await fs.readFile(path.join(root, "session.bin")), encrypted);
  assert.equal((await new SessionStore(root, storage()).load()).token, token);
}));

test("login succeeds with a locked key provider and cannot restore another account's old token", () => temporary(async root => {
  await seed(root);
  const session = await new SessionStore(root, storage({ encryptStringAsync: async () => { throw new Error("locked"); } })).load();
  await session.acceptSession("https://other.test", { token, user: { id: "account-two" } });
  assert.equal(session.token, token);
  assert.equal(session.settings.user.id, "account-two");
  assert.match(session.credentialWarning, /本次会话不保存/);
  await assert.rejects(fs.readFile(path.join(root, "session.bin")), { code: "ENOENT" });
  const restarted = await new SessionStore(root, storage()).load();
  assert.equal(restarted.token, null);
  assert.equal(restarted.settings.user.id, "account-two");
}));

async function interruptedIdentityChange(root, serverURL, userId) {
  await seed(root);
  let entered, release;
  const encryptionStarted = new Promise(resolve => { entered = resolve; });
  const encryptionGate = new Promise(resolve => { release = resolve; });
  const session = await new SessionStore(root, storage({
    encryptStringAsync: async () => { entered(); await encryptionGate; return Buffer.from("new-account-encrypted-credential"); },
  })).load();
  const switching = session.acceptSession(serverURL, { token: "B".repeat(43), user: { id: userId } });
  await encryptionStarted;
  try {
    // These are the exact durable files a new process sees if the old process
    // exits while the OS key provider is still encrypting the new credential.
    const restarted = await new SessionStore(root, storage()).load();
    assert.equal(restarted.settings.serverURL, serverURL);
    assert.equal(restarted.settings.user.id, userId);
    assert.equal(restarted.token, null);
    assert.equal(restarted.settings.offline, true);
    await assert.rejects(fs.readFile(path.join(root, "session.bin")), { code: "ENOENT" });
  } finally { release(); await switching; }
}

test("an account switch interrupted during encryption cannot pair the new profile with the previous account's token", () => temporary(root => interruptedIdentityChange(root, "https://example.test", "account-two")));

test("switching servers with the same user ID also removes the previous server's credential before committing settings", () => temporary(root => interruptedIdentityChange(root, "https://other.test", "account-one")));

test("failure to remove a previous credential aborts the identity switch before changing memory or durable settings", () => temporary(async root => {
  await seed(root);
  const session = await new SessionStore(root, storage()).load();
  await fs.unlink(path.join(root, "session.bin"));
  await fs.mkdir(path.join(root, "session.bin"));
  await assert.rejects(session.acceptSession("https://other.test", { token: "B".repeat(43), user: { id: "account-two" } }), error => ["EISDIR", "EPERM"].includes(error.code));
  assert.equal(session.token, token);
  assert.equal(session.settings.serverURL, "https://example.test");
  assert.equal(session.settings.user.id, "account-one");
  const settings = JSON.parse(await fs.readFile(path.join(root, "settings.json"), "utf8"));
  assert.equal(settings.serverURL, "https://example.test");
  assert.equal(settings.user.id, "account-one");
}));
