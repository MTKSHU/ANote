import {useEffect, useState} from "react";
import type {Editor} from "@tiptap/core";

// setEditable emits an update without changing the document's nodes. Node
// views must subscribe so their form controls also follow reading mode.
export function useEditorEditable(editor: Editor) {
  const [editable, setEditable] = useState(editor.isEditable);
  useEffect(() => {
    const update = () => setEditable(editor.isEditable);
    editor.on("update", update);
    update();
    return () => { editor.off("update", update); };
  }, [editor]);
  return editable;
}
