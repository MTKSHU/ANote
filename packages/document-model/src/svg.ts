export const SVG_MIME = "image/svg+xml";
export const SVG_HEADER_BYTES = 65536;

/** Recognize an SVG document, never an HTML wrapper or a file extension.
 * This is a bounded format check, not an HTML sanitizer. SVG is displayed only
 * as an image; callers must retain the sandboxed file response policy.
 * DTDs/entities and processing instructions that load resources are excluded.
 */
export function isSvgImagePrefix(input: string): boolean {
  if (input.includes("\0") || /<!\s*(?:DOCTYPE|ENTITY)\b/i.test(input)) return false;
  let value = input.replace(/^\uFEFF/, "").trimStart();
  if (/^<\?xml[\t\r\n ]/.test(value)) {
    const end = value.indexOf("?>");
    if (end < 0 || /encoding\s*=\s*['"](?!utf-8['"]|us-ascii['"])/i.test(value.slice(0, end))) return false;
    value = value.slice(end + 2).trimStart();
  }
  while (value.startsWith("<!--")) {
    const end = value.indexOf("-->");
    if (end < 0) return false;
    value = value.slice(end + 3).trimStart();
  }
  const root = /^<((?:[A-Za-z_][\w.-]*:)?svg)(?=[\t\r\n />])/.exec(value);
  if (!root) return false;
  let rest = value.slice(root[0].length), namespace: string | undefined;
  const namespaceAttribute = root[1].includes(":") ? "xmlns:" + root[1].split(":")[0] : "xmlns";
  const attributes = new Set<string>();
  while (!/^\s*\/?>/.test(rest)) {
    const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
    if (!attr || attributes.has(attr[1])) return false;
    attributes.add(attr[1]);
    if (attr[1] === namespaceAttribute) namespace = attr[2] ?? attr[3];
    rest = rest.slice(attr[0].length);
  }
  return namespace === "http://www.w3.org/2000/svg";
}
