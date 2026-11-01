import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { resolveLocale, translate, getLocale, setLocale, beforeLanguageChange, changeLanguage } from "../../packages/i18n/index.mjs";
import english from "../../packages/i18n/en.mjs";

test("language detection supports English and Chinese with an English fallback", () => {
  assert.equal(resolveLocale("zh-TW"), "zh-CN");
  assert.equal(resolveLocale("en-GB"), "en");
  assert.equal(resolveLocale("fr-FR"), "en");
});

test("saved preference overrides the browser and explicit links work without storage", async () => {
  const names = ["localStorage", "navigator", "location"], descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  try {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "en-US" } });
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://notes.example.org/" } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => "zh-CN" } });
    const cached = await import("../../packages/i18n/index.mjs?preference");
    assert.equal(cached.getLocale(), "zh-CN");
    Object.defineProperty(globalThis, "location", { configurable: true, value: { href: "https://notes.example.org/?lang=en" } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("Storage unavailable"); } });
    const linked = await import("../../packages/i18n/index.mjs?explicit");
    assert.equal(linked.getLocale(), "en");
    assert.doesNotThrow(() => linked.setLocale("zh-CN"));
  } finally {
    names.forEach((name, index) => { if (descriptors[index]) Object.defineProperty(globalThis, name, descriptors[index]); else delete globalThis[name]; });
  }
});

test("interpolation preserves user text and supports reordered placeholders", () => {
  assert.equal(translate("删除整个{0}", "en", ["研究记录 {1}"]), "Delete entire 研究记录 {1}");
  assert.equal(translate("{0} 到期", "en", ["2026-12-01"]), "Expires 2026-12-01");
  assert.equal(translate("{0} 到期", "zh-CN", ["2026-12-01"]), "2026-12-01 到期");
  assert.equal(translate("自定义笔记名称", "en"), "自定义笔记名称");
  assert.equal(translate("Error invoking remote method 'anote:connect': Error: 请先登录", "en"), "Sign in to continue");
});

test("language changes save before switching and retain the language on failure", async () => {
  setLocale("zh-CN");
  const events = [];
  const remove = beforeLanguageChange(async () => { events.push(getLocale()); });
  await changeLanguage("en");
  assert.deepEqual(events, ["zh-CN"]);
  assert.equal(getLocale(), "en");
  remove();
  const removeFailure = beforeLanguageChange(async () => { throw new Error("save failed"); });
  await assert.rejects(changeLanguage("zh-CN"), /save failed/);
  assert.equal(getLocale(), "en");
  removeFailure();
  await assert.rejects(changeLanguage("unsupported"), RangeError);
});

test("English messages preserve all interpolation placeholders", () => {
  for (const [source, target] of Object.entries(english)) {
    assert.ok(target.trim(), source);
    const placeholders = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
    assert.deepEqual(placeholders(target), placeholders(source), source);
    assert.doesNotMatch(target, /[\u3400-\u9fff]/, source);
  }
});

test("interface translation keys have English entries", async () => {
  const { default: ts } = await import("typescript");
  const folders = ["apps/desktop/renderer", "apps/web/src", "packages/editor/src"];
  for (const folder of folders) for (const file of await readdir(folder)) {
    if (!/\.tsx?$/.test(file)) continue;
    const path = folder + "/" + file, content = await readFile(path, "utf8");
    const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
    assert.equal(source.parseDiagnostics.length, 0, path);
    function visit(node) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["t", "translateUI"].includes(node.expression.text)) {
        const key = node.arguments[0];
        if (key && ts.isStringLiteralLike(key)) assert.ok(key.text in english, path + ": " + key.text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
