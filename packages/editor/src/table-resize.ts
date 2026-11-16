import {Table,TableView} from '@tiptap/extension-table';
import type {Editor} from '@tiptap/core';
import type {Node as ProseNode} from '@tiptap/pm/model';
import {columnResizing,columnResizingPluginKey,updateColumnsOnResize,tableEditingKey,cellAround,CellSelection} from '@tiptap/pm/tables';
import {Plugin,TextSelection,Selection} from '@tiptap/pm/state';
import {yUndoPluginKey} from '@tiptap/y-tiptap';

export const TABLE_COLUMN_MIN_WIDTH=48;

export class StableTableView extends TableView {
  update(node:ProseNode){
    if(node.type!==this.node.type)return false;
    if(node.firstChild!==this.node.firstChild){
      let column=0;
      node.firstChild?.forEach(cell=>{
        for(let index=0;index<cell.attrs.colspan;index++,column++){
          const col=this.colgroup.children[column] as HTMLTableColElement|undefined;if(!col)continue;
          // Tiptap sets min-width when a width is undone, but leaves the old
          // width behind. Keep the two properties mutually exclusive.
          if(!cell.attrs.colwidth?.[index]){col.style.width='';col.style.minWidth=this.cellMinWidth+'px';}
          else col.style.minWidth='';
        }
      });
    }
    return super.update(node);
  }
}

function cancelResize(editor:Editor){
  const resizing=columnResizingPluginKey.getState(editor.state);
  if(!resizing||resizing.activeHandle<0)return;
  if(resizing.dragging){
    const cell=editor.state.doc.resolve(resizing.activeHandle),node=cell.node(-1),dom=editor.view.nodeDOM(cell.start(-1)-1) as HTMLElement|null;
    const table=dom?.querySelector('table'),cols=table?.querySelector('colgroup');
    if(table&&cols)updateColumnsOnResize(node,cols,table,TABLE_COLUMN_MIN_WIDTH);
  }
  editor.view.dispatch(editor.state.tr.setMeta(columnResizingPluginKey,{setHandle:-1}).setMeta('addToHistory',false));
}

// The stock table registers resizing only when the editor starts editable.
// Notes start read-only while preparing, so keep the plugin and its table view
// installed in both modes. Its mouse handlers already respect view.editable.
export const InteractiveTable=Table.extend({
  addOptions(){return {...this.parent!(),View:StableTableView};},
  addProseMirrorPlugins(){
    const plugins=(this.parent?.()||[]).map(plugin=>{
      if(plugin.spec.key!==tableEditingKey)return plugin;
      const original=plugin.props.handleDOMEvents?.mousedown;
      return new Plugin({...plugin.spec,props:{...plugin.props,
        handleDOMEvents:{...plugin.props.handleDOMEvents,mousedown:(view,event)=>{
          const target=event.target instanceof Element?event.target:null;
          const cell=target?.closest('td,th');
          // Default left-drag is text selection throughout a cell. Structural
          // selection starts from explicit grips/buttons, then Shift extends it.
          // Column resizing runs before this handler and keeps its own gesture.
          if(cell&&!(event.shiftKey&&view.state.selection instanceof CellSelection))return false;
          return original?.call(plugin,view,event)||false;
        }},
        createSelectionBetween:(view,anchor,head)=>{
          // The table plugin owns explicit cell drags; do not reinterpret
          // their native selection notifications as a text gesture.
          if(tableEditingKey.getState(view.state)!=null)return null;
          const start=cellAround(anchor),end=cellAround(head);
          if(!start||start.pos===end?.pos)return null;
          // ProseMirror normalizes cross-cell text ranges to a whole
          // paragraph. Clamp a text gesture to its originating cell instead,
          // preserving the partial anchor even if the pointer slips outside.
          const node=start.nodeAfter!;
          const edge=Selection.near(view.state.doc.resolve(head.pos<anchor.pos?start.pos+1:start.pos+node.nodeSize-1),head.pos<anchor.pos?1:-1);
          return TextSelection.between(anchor,edge.$head);
        },
      }});
    });
    if(this.options.resizable&&!plugins.some(plugin=>plugin.spec.key===columnResizingPluginKey))plugins.unshift(columnResizing({handleWidth:this.options.handleWidth,cellMinWidth:this.options.cellMinWidth,defaultCellMinWidth:this.options.cellMinWidth,View:this.options.View,lastColumnResizable:this.options.lastColumnResizable}));
    return plugins;
  },
  addNodeView(){return this.options.resizable?null:this.parent?.()||null;},
  onTransaction({transaction}){
    const dragging=transaction.getMeta(columnResizingPluginKey)?.setDragging;
    if(dragging!==undefined){
      yUndoPluginKey.getState(this.editor.state)?.undoManager?.stopCapturing();
      if(dragging)this.editor.view.focus();
    }
  },
  onUpdate(){if(!this.editor.isEditable)cancelResize(this.editor);},
});
