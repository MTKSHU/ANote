import * as Y from "yjs";
import {
  initProseMirrorDoc,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import { schema } from "./model.js";
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
    const a = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(anchor.from),
        doc,
      ),
      b = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(anchor.to),
        doc,
      );
    if (
      !a ||
      !b ||
      !(a.type instanceof Y.XmlText) ||
      !(b.type instanceof Y.XmlText)
    )
      return { text: "", orphaned: true };
    if (a.type !== b.type) {
      const fragment = doc.getXmlFragment("default"),
        { doc: prose, meta } = initProseMirrorDoc(fragment, schema),
        start = relativePositionToAbsolutePosition(
          doc,
          fragment,
          Y.createRelativePositionFromJSON(anchor.from),
          meta.mapping,
        ),
        end = relativePositionToAbsolutePosition(
          doc,
          fragment,
          Y.createRelativePositionFromJSON(anchor.to),
          meta.mapping,
        );
      if (start === null || end === null || end <= start)
        return { text: "", orphaned: true };
      return {
        text: prose.textBetween(start, end, "\n"),
        orphaned: false,
        start,
        end,
      };
    }
    if (b.index <= a.index) return { text: "", orphaned: true };
    return {
      text: plain(a.type).slice(a.index, b.index),
      orphaned: false,
      start: a.index,
      end: b.index,
    };
  } catch {
    return { text: "", orphaned: true };
  }
}
