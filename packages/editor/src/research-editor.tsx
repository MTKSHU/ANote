import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import { ComparisonView } from "./comparison-view.js";
import { MarkdownShortcuts } from "./markdown-shortcuts.js";
import { HighlightedCode, CodeView } from "./code-view.js";
import { MindMapView } from "./mind-map-view.js";
import { MathInput, MathView } from "./math-view.js";
import { MediaView } from "./media-view.js";
import { ParagraphFormat } from "./paragraph-format.js";
import { BlockSelection } from "./block-controls.js";
import { TextSelection } from "@tiptap/pm/state";
import * as Y from "yjs";
import {
  ySyncPluginKey,
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
} from "@tiptap/y-tiptap";
import { resolveAnchor } from "@anote/document-model/anchors";
import "@tiptap/starter-kit";
import "@tiptap/extension-table";
import {
  Editor as TiptapEditor,
  EditorContent,
  ReactNodeViewRenderer,
} from "@tiptap/react";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCaret from "@tiptap/extension-collaboration-caret";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { Doc } from "yjs";
import {
  extensions,
  ImageComparison,
  MediaResource,
  MindMap,
  MathBlock,
  InlineMath,
  TaskItem,
} from "@anote/document-model";
export type EditorUser = { id: string; name: string; color?: string };
export function useResearchEditor({
  document,
  provider,
  user,
  editable = true,
  onUpdate,
  canToggleTasks=editable,
}: {
  document: Doc;
  provider?: HocuspocusProvider;
  user: EditorUser;
  editable?: boolean;
  onUpdate?: () => void;
  canToggleTasks?: boolean;
}) {
  const config=useRef({onUpdate,canToggleTasks});config.current={onUpdate,canToggleTasks};
  const [editor,setEditor]=useState<Editor|null>(null);
  useEffect(()=>{
    const instance=new TiptapEditor({
      extensions: [
        BlockSelection,
        MarkdownShortcuts,
        MathInput,
        ...extensions()
          .filter(
            (e) =>
              ![
                "imageComparison",
                "mediaResource",
                "mindMap",
                "mathBlock",
                "inlineMath",
                "taskItem",
              ].includes(e.name),
          )
          .map((e) =>
            e.name === "starterKit" ? e.configure({ codeBlock: false }) : e,
          ),
        TaskItem.extend({addNodeView(){
          const parent=this.parent!();
          return props=>{
            const view=parent!(props);
            const permission=()=>view.dom.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(input=>{input.disabled=!config.current.canToggleTasks;});
            const update=view.update;
            if(update)view.update=(...args)=>{const result=update(...args);permission();return result;};
            permission();
            // The stock read-only callback receives the node from creation,
            // which becomes stale after typing. Resolve the current position.
            view.dom.addEventListener("change",event=>{
              if(props.editor.isEditable)return;
              const input=event.target as HTMLInputElement;
              if(input.type!=="checkbox"||input.closest('li[data-type="taskItem"]')!==view.dom)return;
              event.stopImmediatePropagation();
              const pos=props.getPos(),node=typeof pos==="number"?props.editor.state.doc.nodeAt(pos):null;
              if(!config.current.canToggleTasks||!node){input.checked=!!node?.attrs.checked;return;}
              props.editor.view.dispatch(props.editor.state.tr.setNodeMarkup(pos!,undefined,{...node.attrs,checked:input.checked}));
            },true);
            return view;
          };
        }}).configure({nested:true,HTMLAttributes:{"data-type":"taskItem"},a11y:{checkboxLabel:node=>translateUI("待办：{0}", [(node.firstChild?.textContent||translateUI("空白待办"))])}}),
        MathBlock.extend({
          addNodeView() {
            return ReactNodeViewRenderer(MathView);
          },
        }),
        InlineMath.extend({
          addNodeView() {
            return ReactNodeViewRenderer(MathView);
          },
        }),
        HighlightedCode.extend({
          addNodeView() {
            return ReactNodeViewRenderer(CodeView);
          },
        }),
        MindMap.extend({
          // Nodes are edited with the visual controls, never with a caret in
          // the hidden ProseMirror content. Keep the entire map selectable.
          atom: true,
          addNodeView() {
            return ReactNodeViewRenderer(MindMapView);
          },
        }),
        MediaResource.extend({
          addNodeView() {
            return ReactNodeViewRenderer(MediaView);
          },
        }),
        ImageComparison.extend({
          addNodeView() {
            return ReactNodeViewRenderer(ComparisonView);
          },
        }),
        Collaboration.configure({ document, field: "default" }),
        ...(provider
          ? [
              CollaborationCaret.configure({
                provider,
                user: { ...user, color: user.color || "#34715d" },
              }),
            ]
          : []),
      ],
      editable,
      editorProps: {
        attributes: { class: "research-editor", "data-testid": "editor" },
        handleClick(view, _pos, event) {
          const link = (event.target as Element).closest("a[href]");
          if (
            !link ||
            !view.dom.contains(link) ||
            link.closest(".media-resource,.comparison")
          )
            return false;
          event.preventDefault();
          const href = link.getAttribute("href") || "";
          if (!/^(https?:\/\/|mailto:)/i.test(href)) return true;
          if (!view.editable || event.ctrlKey || event.metaKey) {
            window.open(href, "_blank", "noopener,noreferrer");
          } else {
            view.dom.dispatchEvent(new CustomEvent("anote-link", { detail: { href, rect: link.getBoundingClientRect().toJSON() } }));
          }
          return true;
        },
        handleKeyDown(view, event) {
          // Browsers can deliver Enter before the selectionchange caused by
          // End/arrow keys. Split at the actual caret, including collapsed
          // selections whose model position still points inside the line.
          const selection = view.state.selection;
          if (
            event.key === "Enter" &&
            !event.isComposing &&
            !view.composing &&
            selection instanceof TextSelection &&
            view.hasFocus()
          ) {
            const native = view.dom.ownerDocument.getSelection();
            if (
              native?.isCollapsed &&
              native.anchorNode &&
              view.dom.contains(native.anchorNode)
            ) {
              const position = view.posAtDOM(
                native.anchorNode,
                native.anchorOffset,
              );
              if (view.state.doc.resolve(position).parent.inlineContent && (!selection.empty || position !== selection.from))
                view.dispatch(
                  view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, position),
                  ),
                );
            }
          }
          return false;
        },
      },
      onUpdate:()=>config.current.onUpdate?.(),
    });
    const start=()=>{instance.view.dom.dataset.composing="true";};
    const end=()=>{delete instance.view.dom.dataset.composing;};
    instance.view.dom.addEventListener("compositionstart",start,true);instance.view.dom.addEventListener("compositionend",end,true);
    setEditor(instance);
    return ()=>{instance.view.dom.removeEventListener("compositionstart",start,true);instance.view.dom.removeEventListener("compositionend",end,true);instance.destroy();};
  },[document,provider]);
  useEffect(()=>{if(editor&&!editor.isDestroyed&&editor.isEditable!==editable)editor.setEditable(editable);},[editor,editable]);
  useEffect(()=>{if(!editor)return;const update=()=>{editor.view.dom.dataset.taskInteractive=String(canToggleTasks);editor.view.dom.querySelectorAll<HTMLInputElement>('li[data-type="taskItem"] input[type="checkbox"]').forEach(input=>{input.disabled=!canToggleTasks;});};editor.on("transaction",update);update();return ()=>{editor.off("transaction",update);};},[editor,canToggleTasks]);
  useEffect(()=>{provider?.awareness?.setLocalStateField("user",{...user,color:user.color||"#3669d6"});},[provider,user.name,user.color]);
  return editor;
}
export function ResearchEditorContent(props: React.ComponentProps<typeof EditorContent>) {
  const [link, setLink] = useState<{ href: string; left: number; top: number } | null>(null);
  useEffect(() => {
    const editor = props.editor;
    if (!editor) return;
    const dom = editor.view.dom;
    const open = (event: Event) => {
      const { href, rect } = (event as CustomEvent).detail;
      setLink({ href, left: Math.max(8, Math.min(rect.left, window.innerWidth - 348)), top: rect.bottom + 100 < window.innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - 90) });
    };
    const close = () => setLink(null);
    const outside = (event: PointerEvent) => { if (!(event.target as Element).closest(".editor-link-popover")) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    dom.addEventListener("anote-link", open);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", escape);
    dom.addEventListener("keydown", close);
    return () => {
      dom.removeEventListener("anote-link", open);
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", escape);
      dom.removeEventListener("keydown", close);
    };
  }, [props.editor]);
  return <><EditorContent {...props} />{props.editor && <ParagraphFormat editor={props.editor}/>} {link && createPortal(
    <div className="editor-link-popover" role="dialog" aria-label={translateUI("链接操作")} style={{ left: link.left, top: link.top }}>
      <span title={link.href}>{link.href}</span>
      <a href={link.href} target="_blank" rel="noopener noreferrer" onClick={() => setLink(null)}>{translateUI("打开链接 ↗")}</a>
      <button type="button" aria-label={translateUI("关闭链接操作")} onClick={() => setLink(null)}>×</button>
    </div>, document.body)}</>;
}
export function selectionAnchor(editor: Editor, document: Y.Doc) {
  const { from, to } = editor.state.selection;
  return rangeAnchor(editor, document, from, to);
}
function rangeAnchor(
  editor: Editor,
  document: Y.Doc,
  from: number,
  to: number,
) {
  if (from === to) return null;
  const binding = ySyncPluginKey.getState(editor.state)?.binding;
  if (!binding) return null;
  const start = Y.createAbsolutePositionFromRelativePosition(
      absolutePositionToRelativePosition(from, binding.type, binding.mapping),
      document,
    ),
    end = Y.createAbsolutePositionFromRelativePosition(
      absolutePositionToRelativePosition(to, binding.type, binding.mapping),
      document,
    );
  if (!(start?.type instanceof Y.XmlText) || !(end?.type instanceof Y.XmlText))
    return null;
  const anchor = {
    from: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(start.type, start.index, 0),
    ),
    to: Y.relativePositionToJSON(
      Y.createRelativePositionFromTypeIndex(end.type, end.index, -1),
    ),
    quote: editor.state.doc.textBetween(from, to, "\n"),
  };
  const resolved = resolveAnchor(document, anchor);
  return !resolved.orphaned && resolved.text === anchor.quote ? anchor : null;
}
/** Capture the selection, or the paragraph at the caret, without changing it. */
export function contextAnchor(editor: Editor, document: Y.Doc) {
  if (!editor.state.selection.empty) return selectionAnchor(editor, document);
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (!node.isTextblock) continue;
    if (node.attrs.blockId) {
      const anchor = { blockId: node.attrs.blockId },
        resolved = resolveAnchor(document, anchor);
      if (!resolved.orphaned) return { ...anchor, quote: resolved.text };
    }
    if (node.content.size)
      return rangeAnchor(
        editor,
        document,
        $from.start(depth),
        $from.end(depth),
      );
  }
  const node = editor.state.doc.child(
    Math.min($from.index(0), editor.state.doc.childCount - 1),
  );
  if (!node.attrs.blockId) return null;
  const anchor = { blockId: node.attrs.blockId },
    resolved = resolveAnchor(document, anchor);
  return resolved.orphaned ? null : { ...anchor, quote: resolved.text };
}
/** Positions are resolved against the live editor binding, never quote search. */
export function anchorRange(
  editor: Editor,
  document: Y.Doc,
  anchor: any,
): { from: number; to: number; block?: boolean } | null {
  try {
    if (resolveAnchor(document, anchor).orphaned) return null;
    if (anchor.blockId) {
      let found: { from: number; to: number; block: boolean } | null = null;
      editor.state.doc.forEach((node, pos) => {
        if (node.attrs.blockId === anchor.blockId)
          found = { from: pos, to: pos + node.nodeSize, block: true };
      });
      return found;
    }
    const binding = ySyncPluginKey.getState(editor.state)?.binding;
    if (!binding) return null;
    const from = relativePositionToAbsolutePosition(
        document,
        binding.type,
        Y.createRelativePositionFromJSON(anchor.from),
        binding.mapping,
      ),
      to = relativePositionToAbsolutePosition(
        document,
        binding.type,
        Y.createRelativePositionFromJSON(anchor.to),
        binding.mapping,
      );
    if (
      from === null ||
      to === null ||
      to <= from ||
      from < 0 ||
      to > editor.state.doc.content.size
    )
      return null;
    return { from, to };
  } catch {
    return null;
  }
}
