export type Locale = "zh-CN" | "en";
export const supportedLocales: readonly Locale[];
export function resolveLocale(value?: string): Locale;
export function getLocale(): Locale;
export function setLocale(value: Locale): void;
export function translate(message: unknown, language: string, values?: readonly unknown[]): string;
export function t(message: unknown, values?: readonly unknown[]): string;
export function beforeLanguageChange(guard: () => void | Promise<void>): () => void;
export function changeLanguage(value: Locale): Promise<void>;
