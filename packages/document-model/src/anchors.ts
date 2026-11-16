import * as Y from "yjs";
import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import { schema } from "./model.js";

type ProseProjection = ReturnType<typeof initProseMirrorDoc>;
const projections = new WeakMap<Y.Doc, { value: ProseProjection | null }>();
function projection(document: Y.Doc): ProseProjection {
  if (document.isDestroyed) throw new Error("Cannot project a destroyed document");
  let cached = projections.get(document);
  if (!cached) {
    const entry: { value: ProseProjection | null } = { value: null };
    // Delete-only transactions can change positions without advancing clocks.
    const invalidate = () => { entry.value = null; };
    const destroy = () => {
      invalidate();
      projections.delete(document);
      document.off("afterTransaction", invalidate);
      document.off("destroy", destroy);
    };
    document.on("afterTransaction", invalidate);
    document.on("destroy", destroy);
    projections.set(document, entry);
    cached = entry;
  }
  return cached.value ?? (cached.value = initProseMirrorDoc(document.getXmlFragment("default"), schema));
}
export function plain(text: Y.XmlText): string {
  return text
    .toDelta()
    .map((p: any) => (typeof p.insert === "string" ? p.insert : ""))
    .join("");
}
export function findAnchor(
  doc: Y.Doc,
  quote: string,
): { from: any; to: any; quote: string } | null {
  const walk = (type: Y.XmlFragment | Y.XmlElement): any => {
    for (const child of type.toArray()) {
      if (child instanceof Y.XmlText) {
        const at = plain(child).indexOf(quote);
        if (at >= 0)
          return {
            from: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(child, at, 0),
            ),
            to: Y.relativePositionToJSON(
              Y.createRelativePositionFromTypeIndex(
                child,
                at + quote.length,
                -1,
              ),
            ),
            quote,
          };
      } else if (child instanceof Y.XmlElement) {
        const match = walk(child);
        if (match) return match;
      }
    }
    return null;
  };
  return walk(doc.getXmlFragment("default"));
}
export function resolveAnchor(
  doc: Y.Doc,
  anchor: { from?: any; to?: any; blockId?: string },
): { text: string; orphaned: boolean; start?: number; end?: number } {
  try {
    if (anchor.blockId) {
      const block = doc
        .getXmlFragment("default")
        .toArray()
        .find(
          (child) =>
            child instanceof Y.XmlElement &&
            child.getAttribute("blockId") === anchor.blockId,
        );
      if (!(block instanceof Y.XmlElement)) return { text: "", orphaned: true };
      const read = (node: Y.XmlElement): string =>
        node
          .toArray()
          .map((child) =>
            child instanceof Y.XmlText
              ? plain(child)
              : child instanceof Y.XmlElement
                ? read(child)
                : "",
          )
          .join("\n");
      return {
        text:
          read(block) || String(block.getAttribute("caption") || "空白内容"),
        orphaned: false,
      };
    }
    const relativeFrom = Y.createRelativePositionFromJSON(anchor.from),
      relativeTo = Y.createRelativePositionFromJSON(anchor.to),
      a = Y.createAbsolutePositionFromRelativePosition(
        relativeFrom,
        doc,
      ),
      b = Y.createAbsolutePositionFromRelativePosition(
        relativeTo,
        doc,
      );
    // Preserve the common same-text path and its text-local start/end values.
    // Structural edits can replace that XmlText while keeping the anchor's
    // original IDs in the library's synchronized position-migration history.
    if (a && b && a.type instanceof Y.XmlText && b.type === a.type && b.index > a.index) {
      return {
        text: plain(a.type).slice(a.index, b.index),
        orphaned: false,
        start: a.index,
        end: b.index,
      };
    }
    // A dead/collapsed raw XML position is not yet proof of deletion. Use the
    // public resolver to follow existing migrations; do not disable migration
    // or rewrite the persisted anchor identities.
    const fragment = doc.getXmlFragment("default"),
      { doc: prose, meta } = projection(doc),
      start = relativePositionToAbsolutePosition(doc, fragment, relativeFrom, meta.mapping),
      end = relativePositionToAbsolutePosition(doc, fragment, relativeTo, meta.mapping);
    if (start === null || end === null || end <= start)
      return { text: "", orphaned: true };
    return {
      text: prose.textBetween(start, end, "\n"),
      orphaned: false,
      start,
      end,
    };
  } catch {
    return { text: "", orphaned: true };
  }
}
