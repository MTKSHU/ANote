import english from "./en.mjs";

export const supportedLocales = ["zh-CN", "en"];
const storageKey = "anote:locale";
const guards = new Set();
export function resolveLocale(value) {
  return /^zh(?:-|$)/i.test(value || "") ? "zh-CN" : "en";
}
function initialLocale() {
  try {
    const requested = new URL(globalThis.location?.href).searchParams.get("lang");
    if (supportedLocales.includes(requested)) return requested;
  } catch {}
  try {
    const saved = globalThis.localStorage?.getItem(storageKey);
    if (supportedLocales.includes(saved)) return saved;
  } catch {}
  return resolveLocale(globalThis.navigator?.language || "zh-CN");
}
let locale = initialLocale();
export const getLocale = () => locale;
export function setLocale(value) {
  if (!supportedLocales.includes(value)) throw new RangeError("Unsupported locale");
  locale = value;
  try { globalThis.localStorage?.setItem(storageKey, value); } catch {}
  if (globalThis.document) globalThis.document.documentElement.lang = value;
}
function interpolate(message, values) {
  return message.replace(/\{(\d+)\}/g, (match, index) => index in values ? String(values[index]) : match);
}
export function translate(message, language, values = []) {
  const source = String(message ?? "");
  if (resolveLocale(language) === "en") {
    const remote = /^Error invoking remote method '[^']+': (?:Error: )?([\s\S]*)$/.exec(source);
    if (remote) return translate(remote[1], language, values);
  }
  return interpolate(resolveLocale(language) === "en" ? english[source] ?? source : source, values);
}
export const t = (message, values = []) => translate(message, locale, values);
export function beforeLanguageChange(guard) {
  guards.add(guard);
  return () => { guards.delete(guard); };
}
export async function changeLanguage(value) {
  if (!supportedLocales.includes(value)) throw new RangeError("Unsupported locale");
  for (const guard of guards) await guard();
  setLocale(value);
}
if (globalThis.document) globalThis.document.documentElement.lang = locale;
