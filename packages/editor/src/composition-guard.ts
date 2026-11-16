import {Extension} from "@tiptap/core";
import {Plugin} from "@tiptap/pm/state";
import type {EditorView} from "@tiptap/pm/view";

/** Keep an unsuccessful shortcut probe from resetting the IME's DOM selection. */
export const CompositionGuard = Extension.create({
  name:"compositionGuard",
  priority:1200,
  addProseMirrorPlugins() {
    let view:EditorView|null=null;
    return [new Plugin({
      view(current) { view=current;return {destroy(){view=null;}}; },
      filterTransaction(transaction) {
        // When preedit text shrinks, ProseMirror's DOM observer probes the
        // Backspace keymaps before applying the DOM change. Tiptap commands
        // dispatch an empty transaction even when the shortcut returns false.
        // Applying it resets the still-old selection and cancels Chrome's IME.
        // Preserve all actual edits, selection/mark changes and plugin metadata.
        const composing=view?.composing || view?.dom.dataset.composing==="true";
        return !(composing && transaction.isGeneric && !transaction.docChanged && !transaction.selectionSet && !transaction.storedMarksSet);
      },
    })];
  },
});
