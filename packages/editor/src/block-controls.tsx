import { t as translateUI } from "@anote/i18n";
import React from "react";
import type { NodeViewProps } from "@tiptap/react";
import { Extension, type Editor } from "@tiptap/core";
import { NodeSelection } from "@tiptap/pm/state";
import { yUndoPluginKey } from "@tiptap/y-tiptap";

type BlockProps = Pick<NodeViewProps, "editor" | "getPos">;

export function selectBlock({ editor, getPos }: BlockProps) {
  const pos = getPos();
  if (!editor.isEditable || typeof pos !== "number") return false;
  const node = editor.state.doc.nodeAt(pos);
  if (!node || !["codeBlock", "mindMap", "imageComparison"].includes(node.type.name)) return false;
  if (!editor.commands.setNodeSelection(pos)) return false;
  editor.view.focus();
  return true;
}

function deleteSelectedBlock(editor: Editor) {
  const selection = editor.state.selection;
  if (!editor.isEditable || editor.view.composing || !(selection instanceof NodeSelection) || !["codeBlock", "mindMap", "imageComparison"].includes(selection.node.type.name)) return false;
  // A structural deletion is one undo step, even immediately after creating
  // or typing in the block. Never capture it with the preceding text changes.
  const manager = yUndoPluginKey.getState(editor.state)?.undoManager;
  manager?.stopCapturing();
  const result = editor.commands.deleteSelection();
  manager?.stopCapturing();
  return result;
}

export const BlockSelection = Extension.create({
  name: "wholeBlockSelection",
  priority: 1100,
  addKeyboardShortcuts() {
    return { Delete: () => deleteSelectedBlock(this.editor), Backspace: () => deleteSelectedBlock(this.editor) };
  },
});

export function BlockControls({ editor, getPos, selected, label }: BlockProps & Pick<NodeViewProps, "selected"> & { label: string }) {
  if (!editor.isEditable) return null;
  return <div className="editor-block-actions" role="group" aria-label={translateUI("{0}整块操作", [label])}>
    <button type="button" aria-label={translateUI("选中整个{0}", [label])} aria-pressed={selected} title={translateUI("选中整块，按 Delete 或 Backspace 删除")} onMouseDown={event => event.preventDefault()} onClick={() => selectBlock({ editor, getPos })}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="3" width="16" height="16" rx="1" strokeDasharray="3 2"/><path d="m12 12 8 3-4 1-1 4-3-8Z"/></svg>
    </button>
    <button type="button" className="delete-editor-block" aria-label={translateUI("删除整个{0}", [label])} title={translateUI("删除整个{0}（可撤销）", [label])} onMouseDown={event => event.preventDefault()} onClick={() => { if (selectBlock({ editor, getPos })) deleteSelectedBlock(editor); }}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7"/></svg>
    </button>
  </div>;
}
