import { url } from '@kit.ArkTS';
import { PREVIEW_ORIGIN } from './Preview';

export function parseOrigin(value: string): string {
  try {
    const parsed = url.URL.parseURL(value);
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.username || parsed.password || !parsed.hostname) return '';
    return parsed.origin;
  } catch { return ''; }
}
export function downloadOrigin(value: string): string {
  return parseOrigin(value.startsWith('blob:') ? value.substring(5) : value);
}
export function validateServer(value: string): string {
  const parsed = url.URL.parseURL(value.trim());
  const origin = parseOrigin(value.trim());
  if (!origin || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('请输入不含路径、账号或参数的服务器地址');
  }
  if (parsed.protocol !== 'https:' && origin !== parseOrigin(PREVIEW_ORIGIN)) {
    throw new Error('服务器必须使用 HTTPS；HTTP 仅限构建时指定的隔离预览地址');
  }
  return origin;
}
export function isAuthStart(value: string, server: string): boolean {
  if (parseOrigin(value) !== server) return false;
  try { return /^\/api\/auth\/casdoor\/(start|link)$/.test(url.URL.parseURL(value).pathname); }
  catch { return false; }
}
export function safeFilename(value: string): string {
  const clean = value.replace(/[\u0000-\u001f/\\:*?"<>|]/g, '_').trim();
  return !clean || clean === '.' || clean === '..' ? '附件' : clean.slice(0, 180);
}
