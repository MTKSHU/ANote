import { t as translateUI } from "@anote/i18n";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Editor } from "@tiptap/core";
import type { Node as ProseNode } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  findTable,
  addRow,
  addColumn,
  columnResizingPluginKey,
} from "@tiptap/pm/tables";
import { SelectionToolbar, TableToolbar } from "./selection-toolbar";
import { Icon } from "./icons";
type Grid = {
  element: HTMLTableElement;
  node: ProseNode;
  pos: number;
  start: number;
  map: TableMap;
  left: number;
  right: number;
  top: number;
  bottom: number;
  columns: number[];
  rows: number[];
  clip: { left: number; right: number; top: number; bottom: number };
};
type Bar = {
  left: number;
  top: number;
  dock: boolean;
  text: boolean;
  label: string;
  key: string;
};
type Hover = { axis: "row" | "column"; index: number } | null;
function gridFor(editor: Editor, element: HTMLTableElement): Grid | null {
  try {
    const cell = element.querySelector("td,th");
    if (!cell) return null;
    const table = findTable(
      editor.state.doc.resolve(editor.view.posAtDOM(cell, 0)),
    );
    if (!table) return null;
    const dom = editor.view.nodeDOM(table.pos) as HTMLElement;
    if (
      (dom.tagName === "TABLE" ? dom : dom.querySelector("table")) !== element
    )
      return null;
    const map = TableMap.get(table.node),
      box = element.getBoundingClientRect();
    const columns: Array<number | undefined> = Array(map.width + 1);
    columns[0] = box.left;
    columns[map.width] = box.right;
    const cols = Array.from(
      element.querySelectorAll(":scope > colgroup > col"),
    );
    cols.forEach((col, i) => {
      const r = col.getBoundingClientRect();
      if (i < map.width && r.width > 0) {
        columns[i] = r.left;
        columns[i + 1] = r.right;
      }
    });
    if (
      Array.from(columns).some((v) => v === undefined) ||
      cols.length !== map.width
    ) {
      for (const offset of new Set(map.map)) {
        const rect = map.findCell(offset),
          cellDOM = editor.view.nodeDOM(table.start + offset) as HTMLElement;
        if (!cellDOM) continue;
        const r = cellDOM.getBoundingClientRect();
        columns[rect.left] = r.left;
        columns[rect.right] = r.right;
      }
      for (let i = 0; i <= map.width; i++)
        if (columns[i] === undefined) {
          let end = i + 1;
          while (columns[end] === undefined) end++;
          let start = i - 1;
          while (columns[start] === undefined) start--;
          columns[i] =
            columns[start]! +
            ((columns[end]! - columns[start]!) * (i - start)) / (end - start);
        }
    }
    const rowDOM = Array.from(element.rows),
      rows = rowDOM.map((r) => r.getBoundingClientRect().top);
    rows.push(box.bottom);
    if (rows.length !== map.height + 1) return null;
    const region = element.closest(".document-region")!.getBoundingClientRect(),
      header = element
        .closest(".document-region")!
        .querySelector(".document-header")!
        .getBoundingClientRect(),
      wrapper = element.closest(".tableWrapper")?.getBoundingClientRect();
    return {
      element,
      node: table.node,
      pos: table.pos,
      start: table.start,
      map,
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      columns: columns as number[],
      rows,
      clip: {
        left: Math.max(0, region.left, wrapper?.left ?? 0),
        right: Math.min(innerWidth, region.right, wrapper?.right ?? innerWidth),
        top: Math.max(0, region.top, header.bottom),
        bottom: Math.min(innerHeight, region.bottom),
      },
    };
  } catch {
    return null;
  }
}
const inside = (x: number, y: number, grid: Grid, margin = 0) =>
  x >= grid.left - margin &&
  x <= grid.right + margin &&
  y >= grid.top - margin &&
  y <= grid.bottom + margin;
export function TableControls({
  editor,
  onComment,
  offline,
}: {
  editor: Editor;
  onComment?: () => void;
  offline: boolean;
}) {
  const [grid, setGrid] = useState<Grid | null>(null),
    [hot, setHot] = useState<Hover>(null),
    [bar, setBar] = useState<Bar | null>(null),
    [scope, setScope] = useState<{ rows: number[]; columns: number[] }>({
      rows: [],
      columns: [],
    });
  const hovered = useRef<HTMLTableElement | null>(null),
    pointer = useRef<{ x: number; y: number; down: boolean } | null>(null),
    toolbar = useRef<HTMLDivElement>(null),
    barRef = useRef<Bar | null>(null),
    scheduleRef = useRef<() => void>(() => {}),
    dockLock = useRef(false);
  const container = editor.view.dom.closest(".document-region"),
    header = container?.querySelector<HTMLElement>(".document-header") || null;
  function selectedGrid() {
    const table = findTable(editor.state.selection.$from);
    if (!table) return null;
    const dom = editor.view.nodeDOM(table.pos) as HTMLElement | null;
    return (
      dom?.querySelector<HTMLTableElement>("table") ||
      (dom?.tagName === "TABLE" ? (dom as HTMLTableElement) : null)
    );
  }
  useEffect(() => {
    let frame = 0;
    const dom = editor.view.dom;
    const update = () => {
      if (editor.isDestroyed || !editor.isEditable) {
        setGrid(null);
        setHot(null);
        setBar(null);
        barRef.current = null;
        dockLock.current = false;
        return;
      }
      const selection = editor.state.selection,
        selected = selectedGrid(),
        cellSelection = selection instanceof CellSelection,
        text = selection.ranges.some(
          (r) =>
            !!editor.state.doc.textBetween(r.$from.pos, r.$to.pos, " ").trim(),
        );
      const target =
        (hovered.current?.isConnected ? hovered.current : null) || selected;
      const next = target ? gridFor(editor, target) : null;
      const selectedTable = selected ? gridFor(editor, selected) : null;
      const focus = document.activeElement,
        toolsFocused = !!focus?.closest(
          ".table-context-toolbar,.table-edge-controls",
        ),
        focused = editor.view.hasFocus() || toolsFocused;
      const show =
        !!selectedTable &&
        focused &&
        (cellSelection || (!selection.empty && text));
      let rows: number[] = [],
        columns: number[] = [];
      if (cellSelection && selectedTable) {
        const r = selectedTable.map.rectBetween(
          selection.$anchorCell.pos - selectedTable.start,
          selection.$headCell.pos - selectedTable.start,
        );
        if (selection.isRowSelection())
          rows = Array.from({ length: r.bottom - r.top }, (_, i) => r.top + i);
        if (selection.isColSelection())
          columns = Array.from(
            { length: r.right - r.left },
            (_, i) => r.left + i,
          );
      }
      setScope((old) =>
        JSON.stringify(old.rows) === JSON.stringify(rows) &&
        JSON.stringify(old.columns) === JSON.stringify(columns)
          ? old
          : { rows, columns },
      );
      if (show && selectedTable && header) {
        const g = selectedTable,
          h = toolbar.current?.offsetHeight || (text ? 80 : 44),
          w =
            toolbar.current?.offsetWidth ||
            Math.min(820, g.clip.right - g.clip.left - 24),
          headerBox = header.getBoundingClientRect();
        const key = g.pos + ":" + (cellSelection ? "cell" : "text");
        if (barRef.current?.key !== key) dockLock.current = false;
        const outerBottom = Math.max(
          g.bottom,
          g.element.closest(".tableWrapper")?.getBoundingClientRect().bottom ||
            g.bottom,
        );
        let top = g.top - h - 32,
          dock = dockLock.current;
        if (top < headerBox.bottom + 5) {
          if (outerBottom + h + 12 <= g.clip.bottom) top = outerBottom + 12;
          else dock = true;
        }
        if (top + h > g.clip.bottom) dock = true;
        if (dock) dockLock.current = true;
        const label = cellSelection
          ? rows.length && columns.length
            ? translateUI("整张表格")
            : rows.length
              ? translateUI("已选 {0} 行", [rows.length])
              : columns.length
                ? translateUI("已选 {0} 列", [columns.length])
                : translateUI("单元格选区")
          : translateUI("表格文字");
        const value = {
          key,
          label,
          text,
          dock,
          top: Math.max(0, top),
          left: Math.max(
            g.clip.left + 12,
            Math.min(g.left, g.clip.right - w - 12),
          ),
        };
        barRef.current = value;
        setBar((old) =>
          JSON.stringify(old) === JSON.stringify(value) ? old : value,
        );
      } else {
        barRef.current = null;
        setBar(null);
        dockLock.current = false;
      }
      const resizing = columnResizingPluginKey.getState(editor.state)?.dragging;
      const p = pointer.current,
        retain =
          !!p &&
          !!next &&
          inside(p.x, p.y, next, 27) &&
          p.x >= next.clip.left - 22 &&
          p.x <= next.clip.right + 3 &&
          p.y >= next.clip.top - 20 &&
          p.y <= next.clip.bottom;
      const showEdges =
        !!next &&
        next.bottom > next.clip.top &&
        next.top < next.clip.bottom &&
        (retain || (show && selected === target));
      setGrid(showEdges ? next : null);
      let boundary: Hover = null;
      if (showEdges && p && !p.down && !resizing && next) {
        if (
          next.top >= next.clip.top + 18 &&
          next.top <= next.clip.bottom &&
          p.y >= next.top - 26 &&
          p.y <= next.top - 1
        ) {
          const index = next.columns.findIndex(
            (x) =>
              x >= next.clip.left &&
              x <= next.clip.right &&
              Math.abs(p.x - x) <= 11,
          );
          if (index >= 0) boundary = { axis: "column", index };
        }
        if (
          next.left >= next.clip.left &&
          p.x >= next.left - 26 &&
          p.x <= next.left - 1
        ) {
          const index = next.rows.findIndex(
            (y) =>
              y >= next.clip.top + 12 &&
              y <= next.clip.bottom - 12 &&
              Math.abs(p.y - y) <= 11,
          );
          if (index >= 0) boundary = { axis: "row", index };
        }
      }
      setHot(boundary);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    scheduleRef.current = schedule;
    const move = (event: PointerEvent) => {
      pointer.current = {
        x: event.clientX,
        y: event.clientY,
        down: !!(event.buttons & 1),
      };
      const target = (event.target as Element).closest?.("table");
      if (target && dom.contains(target))
        hovered.current = target as HTMLTableElement;
      else if (
        !(event.target as Element).closest?.(
          ".table-edge-controls,.table-context-toolbar",
        )
      ) {
        const current = hovered.current?.getBoundingClientRect();
        if (
          !current ||
          event.clientX < current.left - 27 ||
          event.clientX > current.right + 6 ||
          event.clientY < current.top - 27 ||
          event.clientY > current.bottom + 6
        )
          hovered.current = null;
      }
      schedule();
    };
    const selectCell = (element: Element | null) => {
      if (!element) return false;
      const cell = element.closest("td,th");
      if (!cell || !dom.contains(cell)) return false;
      try {
        const pos = editor.view.posAtDOM(cell, 0) - 1;
        editor.view.dispatch(
          editor.state.tr.setSelection(
            CellSelection.create(editor.state.doc, pos),
          ),
        );
        editor.view.focus();
        hovered.current = cell.closest("table")!;
        schedule();
        return true;
      } catch {
        return false;
      }
    };
    const context = (event: MouseEvent) => {
      if (
        !editor.state.selection.empty &&
        !(editor.state.selection instanceof CellSelection)
      )
        return;
      if (editor.isEditable && selectCell(event.target as Element))
        event.preventDefault();
    };
    const key = (event: KeyboardEvent) => {
      if (
        (event.key === "ContextMenu" ||
          (event.key === "F10" && event.shiftKey)) &&
        editor.isActive("table")
      ) {
        const node = editor.view.domAtPos(editor.state.selection.from).node;
        if (
          selectCell(
            node.nodeType === 1 ? (node as Element) : node.parentElement,
          )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
      if (
        event.key === "Escape" &&
        editor.isActive("table") &&
        !editor.state.selection.empty
      ) {
        const selection = editor.state.selection;
        editor.view.dispatch(
          editor.state.tr.setSelection(
            TextSelection.near(
              editor.state.doc.resolve(
                selection instanceof CellSelection
                  ? selection.$headCell.pos + 1
                  : selection.head,
              ),
            ),
          ),
        );
        event.preventDefault();
        schedule();
      }
    };
    const blur = (event: PointerEvent) => {
      if (
        !(event.target as Element).closest?.(
          ".table-edge-controls,.table-context-toolbar",
        ) &&
        !dom.contains(event.target as Node)
      ) {
        setBar(null);
        barRef.current = null;
        setGrid(null);
        hovered.current = null;
      }
    };
    const leave = () => {
      hovered.current = null;
      pointer.current = null;
      schedule();
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(dom);
    if (header) observer.observe(header);
    editor.on("transaction", schedule);
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerdown", blur);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerup", schedule);
    document.addEventListener("pointerleave", leave);
    dom.addEventListener("contextmenu", context);
    dom.addEventListener("keydown", key, true);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      editor.off("transaction", schedule);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerdown", blur);
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerup", schedule);
      document.removeEventListener("pointerleave", leave);
      dom.removeEventListener("contextmenu", context);
      dom.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, header]);
  useLayoutEffect(() => {
    scheduleRef.current();
  }, [bar?.dock, bar?.text]);
  function select(axis: "row" | "column" | "table", index = 0, extend = false) {
    const g = grid && gridFor(editor, grid.element);
    if (!g) return;
    const state = editor.state,
      head = state.doc.resolve(
        g.start + g.map.map[axis === "row" ? index * g.map.width : index],
      );
    const prior = state.selection,
      anchor =
        extend &&
        prior instanceof CellSelection &&
        findTable(prior.$anchorCell)?.pos === g.pos
          ? prior.$anchorCell
          : head;
    const selection =
      axis === "row"
        ? CellSelection.rowSelection(anchor, head)
        : axis === "column"
          ? CellSelection.colSelection(anchor, head)
          : CellSelection.create(
              state.doc,
              g.start + g.map.map[0],
              g.start + g.map.map.at(-1)!,
            );
    editor.view.dispatch(state.tr.setSelection(selection));
    editor.view.focus();
    hovered.current = g.element;
    dockLock.current = false;
    scheduleRef.current();
  }
  function insert(axis: "row" | "column", index: number) {
    const g = grid && gridFor(editor, grid.element);
    if (!g) return;
    const state = editor.state,
      bookmark = state.selection.getBookmark(),
      marks = state.storedMarks,
      tr = state.tr;
    const rect = {
      map: g.map,
      table: g.node,
      tableStart: g.start,
      left: 0,
      right: g.map.width,
      top: 0,
      bottom: g.map.height,
    };
    if (axis === "row") addRow(tr, rect, index);
    else addColumn(tr, rect, index);
    tr.setSelection(bookmark.map(tr.mapping).resolve(tr.doc));
    if (tr.selection.empty && marks) tr.setStoredMarks(marks);
    editor.view.dispatch(tr);
    editor.view.focus();
    setHot(null);
    scheduleRef.current();
  }
  const toolbarNode = bar && (
    <div
      ref={toolbar}
      role="group"
      aria-label={translateUI("表格选区工具")}
      data-placement={bar.dock ? "header" : "outside-table"}
      className={
        "table-context-toolbar " +
        (bar.dock
          ? "table-context-dock"
          : "academic-floating-tools table-context-floating")
      }
      style={
        bar.dock
          ? undefined
          : {
              left: bar.left,
              top: bar.top,
              maxWidth: Math.max(
                260,
                (container?.getBoundingClientRect().width || innerWidth) - 24,
              ),
            }
      }
      onMouseDown={(event) => {
        if (!(event.target as Element).closest("input,select"))
          event.preventDefault();
      }}
    >
      <span className="table-selection-label">
        {bar.label}
        <small>{translateUI("Esc 返回编辑")}</small>
      </span>
      <div className="table-command-groups">
        {bar.text && (
          <SelectionToolbar
            editor={editor}
            preserveScroll
            onComment={
              offline || editor.state.selection instanceof CellSelection
                ? undefined
                : onComment
            }
          />
        )}
        <TableToolbar editor={editor} />
      </div>
    </div>
  );
  return (
    <>
      {grid && (
        <div
          className="table-edge-controls"
          aria-label={translateUI("表格边缘操作")}
          onMouseDown={(event) => event.preventDefault()}
        >
          {grid.top >= grid.clip.top + 18 && grid.top <= grid.clip.bottom && (
            <>
              {grid.columns.slice(0, -1).map((x, i) => {
                const left = Math.max(x + 2, grid.clip.left),
                  right = Math.min(grid.columns[i + 1] - 2, grid.clip.right);
                return (
                  right - left >= 8 && (
                    <button
                      key={"col" + i}
                      className={
                        "table-column-grip" +
                        (scope.columns.includes(i) ? " selected" : "")
                      }
                      aria-label={translateUI("选择第 {0} 列", [i + 1])}
                      title={translateUI("选择第 {0} 列；Shift 连选", [i + 1])}
                      style={{ left, top: grid.top - 15, width: right - left }}
                      onClick={(e) => select("column", i, e.shiftKey)}
                    />
                  )
                );
              })}
              {grid.left >= grid.clip.left && (
                <button
                  className="table-corner-grip"
                  aria-label={translateUI("选择整张表格")}
                  title={translateUI("选择整张表格")}
                  style={{ left: grid.left - 23, top: grid.top - 23 }}
                  onClick={() => select("table")}
                >
                  <Icon name="table" size={14} />
                </button>
              )}
            </>
          )}
          {grid.left >= grid.clip.left &&
            grid.rows.slice(0, -1).map((y, i) => {
              const top = Math.max(y + 2, grid.clip.top + 2),
                bottom = Math.min(grid.rows[i + 1] - 2, grid.clip.bottom);
              return (
                bottom - top >= 8 && (
                  <button
                    key={"row" + i}
                    className={
                      "table-row-grip" +
                      (scope.rows.includes(i) ? " selected" : "")
                    }
                    aria-label={translateUI("选择第 {0} 行", [i + 1])}
                    title={translateUI("选择第 {0} 行；Shift 连选", [i + 1])}
                    style={{ left: grid.left - 15, top, height: bottom - top }}
                    onClick={(e) => select("row", i, e.shiftKey)}
                  />
                )
              );
            })}
          {hot && (
            <>
              <div
                className="table-insertion-line"
                style={
                  hot.axis === "column"
                    ? {
                        left: grid.columns[hot.index],
                        top: Math.max(grid.top, grid.clip.top),
                        height:
                          Math.min(grid.bottom, grid.clip.bottom) -
                          Math.max(grid.top, grid.clip.top),
                        width: 2,
                      }
                    : {
                        left: Math.max(grid.left, grid.clip.left),
                        top: grid.rows[hot.index],
                        width:
                          Math.min(grid.right, grid.clip.right) -
                          Math.max(grid.left, grid.clip.left),
                        height: 2,
                      }
                }
              />
              <button
                className="table-insert-button"
                aria-label={
                  hot.axis === "column"
                    ? hot.index === grid.map.width
                      ? translateUI("在表格末尾插入列")
                      : translateUI("在第 {0} 列前插入", [hot.index + 1])
                    : hot.index === grid.map.height
                      ? translateUI("在表格末尾插入行")
                      : translateUI("在第 {0} 行前插入", [hot.index + 1])
                }
                title={hot.axis === "column" ? translateUI("插入列") : translateUI("插入行")}
                style={
                  hot.axis === "column"
                    ? { left: grid.columns[hot.index] - 11, top: grid.top - 25 }
                    : { left: grid.left - 25, top: grid.rows[hot.index] - 11 }
                }
                onClick={() => insert(hot.axis, hot.index)}
              >
                <Icon name="plus" size={16} />
              </button>
            </>
          )}
        </div>
      )}
      {bar?.dock && header ? createPortal(toolbarNode, header) : toolbarNode}
    </>
  );
}
