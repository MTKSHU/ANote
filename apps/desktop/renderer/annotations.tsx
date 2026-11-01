import { t as translateUI, getLocale as uiLocale } from "@anote/i18n";
import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type * as Y from "yjs";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { anchorRange, contextAnchor } from "@anote/editor";
import { resolveAnchor } from "@anote/document-model/anchors";
import { request } from "./native";
import { Icon } from "./icons";
import { NotePanelHeader } from "./note-panel-header";
const annotationKey = new PluginKey("academicAnnotations");
type Position = {
  id: string;
  top: number;
  x?: number;
  y?: number;
  orphaned: boolean;
};
type Layout = {
  items: Position[];
  height: number;
  left: number;
  margin: { top: number; left: number } | null;
};

export function Annotations({
  editor,
  document: ydoc,
  id,
  comments,
  open,
  onOpen,
  onClose,
  canComment,
  offline,
  onRefresh,
  commentRequest,
}: {
  editor: Editor;
  document: Y.Doc;
  id: string;
  comments: any[];
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  canComment: boolean;
  offline: boolean;
  onRefresh: () => Promise<void>;
  commentRequest: number;
}) {
  const [active, setActive] = useState(""),
    [draft, setDraft] = useState<any>(null),
    [text, setText] = useState(""),
    [replies, setReplies] = useState<Record<string, string>>({}),
    [filter, setFilter] = useState("open"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [layout, setLayout] = useState<Layout>({
    items: [],
    height: 600,
    left: 0,
    margin: null,
  });
  const rail = useRef<HTMLElement>(null),
    cards = useRef(new Map<string, HTMLElement>()),
    overview = useRef<HTMLDivElement>(null),
    measureRef = useRef<() => void>(() => {}),
    resizeRef = useRef<ResizeObserver | null>(null),
    beginRef = useRef<() => void>(() => {});
  const roots = comments.filter((c) => !c.parent_id),
    visible = roots.filter(
      (c) =>
        filter === "all" || (filter === "resolved" ? c.resolved : !c.resolved),
    );
  const ui = useRef({ comments: roots, visible, active, draft, open });
  ui.current = { comments: roots, visible, active, draft, open };
  function begin() {
    if (!canComment || offline) return;
    // DOM selection is also supported in read-only comment mode.
    const native = getSelection();
    if (
      native?.anchorNode &&
      native.focusNode &&
      editor.view.dom.contains(native.anchorNode) &&
      editor.view.dom.contains(native.focusNode)
    ) {
      try {
        const a = editor.view.posAtDOM(native.anchorNode, native.anchorOffset),
          b = editor.view.posAtDOM(native.focusNode, native.focusOffset);
        editor.commands.setTextSelection({
          from: Math.min(a, b),
          to: Math.max(a, b),
        });
      } catch {}
    }
    const anchor = contextAnchor(editor, ydoc);
    if (!anchor) {
      setError(translateUI("请先在正文中放置光标或选择要批注的文字。"));
      onOpen();
      return;
    }
    // Keep a written draft until it is sent or explicitly cancelled.
    if (draft && text.trim()) {
      setActive("draft");
      onOpen();
      rail.current
        ?.querySelector<HTMLTextAreaElement>(translateUI("[aria-label=\"评论内容\"]"))
        ?.focus();
      return;
    }
    setDraft(anchor);
    setActive("draft");
    setError("");
    onOpen();
  }
  beginRef.current = begin;
  const decorationSignature = JSON.stringify({
    comments: roots
      .filter((c) => !c.resolved || (open && active === c.id))
      .map((c) => ({ id: c.id, anchor: c.anchor })),
    draft,
    active,
    open,
  });
  useEffect(() => {
    if (commentRequest) beginRef.current();
  }, [commentRequest]);
  useEffect(() => {
    if (!open || !draft || active !== "draft") return;
    // Wait for the narrower paper and card positions to settle before focusing
    // a draft near the end of a long document.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        cards.current.get("draft")?.scrollIntoView({ block: "nearest" });
        rail.current
          ?.querySelector<HTMLTextAreaElement>(translateUI("[aria-label=\"评论内容\"]"))
          ?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, draft]);
  function locate(comment: any, scroll = true) {
    setActive(comment.id);
    onOpen();
    const range = anchorRange(editor, ydoc, comment.anchor);
    if (!range) return;
    if (scroll) {
      const target = editor.view.nodeDOM(
        range.block
          ? range.from
          : editor.state.doc.resolve(range.from).before(1),
      );
      (target instanceof HTMLElement ? target : editor.view.dom).scrollIntoView(
        { block: "center", behavior: "smooth" },
      );
    }
  }
  const locateRef = useRef(locate);
  locateRef.current = locate;
  useEffect(() => {
    const plugin = new Plugin({
      key: annotationKey,
      props: {
        decorations() {
          const values: Decoration[] = [];
          const current = ui.current;
          for (const c of [
            ...current.comments.filter(
              (c) => !c.resolved || (current.open && current.active === c.id),
            ),
            ...(current.draft ? [{ id: "draft", anchor: current.draft }] : []),
          ]) {
            const range = anchorRange(editor, ydoc, c.anchor);
            if (!range) continue;
            const attrs = {
              class:
                "annotation-source" +
                (current.open && current.active === c.id
                  ? " annotation-source-active"
                  : ""),
              "data-comment-id": c.id,
              title: translateUI("查看批注"),
            };
            const node = range.block
              ? editor.state.doc.nodeAt(range.from)
              : null;
            values.push(
              range.block && node?.isTextblock && node.content.size
                ? Decoration.inline(range.from + 1, range.to - 1, attrs)
                : range.block
                  ? Decoration.node(range.from, range.to, attrs)
                  : Decoration.inline(range.from, range.to, attrs),
            );
          }
          return DecorationSet.create(editor.state.doc, values);
        },
        handleClick(_view, _pos, event) {
          const target = (event.target as Element).closest?.(
            "[data-comment-id]",
          );
          if (!target) return false;
          const key = target.getAttribute("data-comment-id");
          const c = ui.current.comments.find((c) => c.id === key);
          if (c) locateRef.current(c, false);
          else if (key === "draft") {
            setActive("draft");
            onOpen();
          }
          return false;
        },
      },
    });
    editor.registerPlugin(plugin);
    const key = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.altKey &&
        event.key.toLowerCase() === "m"
      ) {
        if (!canComment || offline) return;
        event.preventDefault();
        beginRef.current();
      }
    };
    const dom=editor.view.dom;
    dom.addEventListener("keydown", key);
    return () => {
      dom.removeEventListener("keydown", key);
      if (!editor.isDestroyed) editor.unregisterPlugin(annotationKey);
    };
  }, [editor, ydoc, canComment, offline]);
  useEffect(() => {
    // Refresh decorations without dispatching a transaction: a metadata-only
    // transaction can overwrite a DOM selection still awaiting the editor's
    // selection observer, particularly while opening the rail.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dom=editor.view.dom;
    const update = () => {
      if (!editor.isDestroyed && !editor.view.composing)
        editor.view.updateState(editor.state);
      measureRef.current();
    };
    const afterComposition = () => {
      timer = setTimeout(update, 40);
    };
    if (editor.view.composing)
      dom.addEventListener("compositionend", afterComposition, {
        once: true,
      });
    else update();
    measureRef.current();
    return () => {
      clearTimeout(timer);
      dom.removeEventListener("compositionend", afterComposition);
    };
  }, [editor, decorationSignature]);
  useEffect(() => {
    let frame = 0;
    const measure = () => {
      if (editor.isDestroyed) return;
      const workspace = editor.view.dom.closest(
          ".editing-columns",
        ) as HTMLElement,
        paper = editor.view.dom.closest(".paper") as HTMLElement;
      if (!workspace || !paper) return;
      const box = workspace.getBoundingClientRect(),
        paperBox = paper.getBoundingClientRect(),
        railBox = rail.current?.getBoundingClientRect();
      const point = (anchor: any) => {
        const range = anchorRange(editor, ydoc, anchor);
        if (!range) return null;
        try {
          let { from, to } = range,
            rect: DOMRect | undefined;
          if (range.block) {
            const node = editor.state.doc.nodeAt(from);
            if (node?.isTextblock) {
              from++;
              to--;
            } else
              rect = (
                editor.view.nodeDOM(from) as HTMLElement
              )?.getBoundingClientRect();
          }
          if (!rect && to > from) {
            const a = editor.view.domAtPos(from),
              b = editor.view.domAtPos(to),
              native = document.createRange();
            native.setStart(a.node, a.offset);
            native.setEnd(b.node, b.offset);
            rect = Array.from(native.getClientRects()).find(
              (r) => r.height > 0 && r.width > 0,
            );
          }
          rect = rect || (editor.view.coordsAtPos(from) as DOMRect);
          return {
            x: Math.round(Math.min(rect.right, paperBox.right - 12) - box.left),
            y: Math.round(
              rect.top - box.top + Math.min(rect.bottom - rect.top, 30) / 2,
            ),
          };
        } catch {
          return null;
        }
      };
      const current = ui.current,
        items = [
          ...current.visible.map((c) => ({ id: c.id, anchor: c.anchor })),
          ...(current.draft ? [{ id: "draft", anchor: current.draft }] : []),
        ].map((c) => ({ ...c, point: point(c.anchor) }));
      items.sort((a, b) => (a.point?.y ?? Infinity) - (b.point?.y ?? Infinity));
      let bottom = (overview.current?.offsetHeight || 50) + 12;
      const positions: Position[] = [];
      for (const item of items) {
        const top = Math.max(bottom, item.point ? item.point.y - 20 : bottom),
          height = cards.current.get(item.id)?.offsetHeight || 125;
        positions.push({
          id: item.id,
          top,
          ...item.point,
          orphaned: !item.point,
        });
        bottom = top + height + 14;
      }
      const selection = getSelection(),
        focus = document.activeElement;
      let margin: Layout["margin"] = null;
      if (
        canComment &&
        !offline &&
        selection?.anchorNode &&
        editor.view.dom.contains(selection.anchorNode) &&
        !focus?.closest(".annotation-rail,.academic-floating-tools")
      ) {
        try {
          const head = editor.view.posAtDOM(
              selection.focusNode!,
              selection.focusOffset,
            ),
            rect = editor.view.coordsAtPos(head);
          margin = {
            top: Math.round(rect.top - box.top),
            left: Math.round(paperBox.right - box.left - 35),
          };
        } catch {}
      }
      const next = {
        items: positions,
        height: Math.ceil(
          Math.max(editor.view.dom.offsetHeight, bottom + 20, 400),
        ),
        left: Math.round((railBox?.left || paperBox.right) - box.left + 14),
        margin,
      };
      setLayout((old) =>
        JSON.stringify(old) === JSON.stringify(next) ? old : next,
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measureRef.current = schedule;
    const observer = new ResizeObserver(schedule);
    resizeRef.current = observer;
    observer.observe(editor.view.dom);
    if (overview.current) observer.observe(overview.current);
    editor.on("transaction", schedule);
    document.addEventListener("selectionchange", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeRef.current = null;
      editor.off("transaction", schedule);
      document.removeEventListener("selectionchange", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
    };
  }, [editor, ydoc, open, canComment, offline]);
  useLayoutEffect(() => {
    cards.current.forEach((card) => resizeRef.current?.observe(card));
    if (overview.current) resizeRef.current?.observe(overview.current);
    measureRef.current();
  });
  async function mutate(key: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(key);
    setError("");
    try {
      await action();
      await onRefresh();
    } catch (e) {
      setError(translateUI((e as Error).message));
    } finally {
      setBusy("");
    }
  }
  const position = (key: string) => ({
    top: layout.items.find((i) => i.id === key)?.top || 70,
  });
  const quote = (anchor: any) => {
    const resolved = resolveAnchor(ydoc, anchor);
    return resolved.orphaned ? translateUI("引用已失效，批注保留") : resolved.text;
  };
  const count = roots.filter((c) => !c.resolved).length;
  return (
    <>
      {layout.margin && (
        <button
          className="margin-comment"
          style={layout.margin}
          aria-label={translateUI("批注当前选区或段落")}
          title={translateUI("添加批注（Ctrl / ⌘ + Alt + M）")}
          onMouseDown={(e) => e.preventDefault()}
          onClick={begin}
        >
          <Icon name="comment" size={17} />
          <sup>＋</sup>
        </button>
      )}
      {open && (
        <>
          <svg
            className="annotation-connectors"
            aria-hidden="true"
            width="100%"
            height={layout.height}
          >
            {layout.items
              .filter((p) => !p.orphaned)
              .map((p) => (
                <path
                  key={p.id}
                  data-thread-id={p.id}
                  className={active === p.id ? "active" : ""}
                  d={`M ${p.x} ${p.y} H ${Math.max((p.x || 0) + 12, layout.left - 24)} L ${layout.left - 8} ${p.top + 22} H ${layout.left}`}
                />
              ))}
          </svg>
          <aside
            className="inspector annotation-rail"
            aria-label={translateUI("正文评论")}
            ref={rail}
            style={{ height: layout.height }}
          >
            <div className="inspector-content annotation-content">
              <div className="annotation-overview" ref={overview}>
                <NotePanelHeader title={translateUI("评论")} count={count} className="annotation-header" onClose={onClose} actions={<button
                    type="button"
                    aria-label={translateUI("新建批注")}
                    title={translateUI("在选区或当前段落添加批注")}
                    disabled={!canComment || offline}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={begin}
                  >
                    <Icon name="plus" size={17} />
                  </button>}/>
                <div className="annotation-filter">
                  <select
                    aria-label={translateUI("批注筛选")}
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                  >
                    <option value="open">{translateUI("未解决")}</option>
                    <option value="all">{translateUI("全部批注")}</option>
                    <option value="resolved">{translateUI("已解决")}</option>
                  </select>
                  <small>{translateUI("点击原文标记或卡片可互相定位")}</small>
                </div>
                {error && (
                  <p className="annotation-error" role="alert">
                    {error}
                  </p>
                )}
                {!visible.length && !draft && (
                  <p className="annotation-empty">{translateUI("在正文放置光标或选择文字，点击旁边的批注图标。 ")}</p>
                )}
              </div>
              {visible.map((c) => {
                const orphaned = !anchorRange(editor, ydoc, c.anchor);
                return (
                  <article
                    key={c.id}
                    ref={(node) => {
                      if (node) cards.current.set(c.id, node);
                      else cards.current.delete(c.id);
                    }}
                    style={position(c.id)}
                    data-comment-id={c.id}
                    className={
                      "annotation-card" +
                      (active === c.id ? " active" : "") +
                      (c.resolved ? " resolved" : "")
                    }
                    onClick={(e) => {
                      if (
                        !(e.target as Element).closest("button,input,textarea")
                      )
                        locate(c);
                    }}
                  >
                    <header>
                      <span className="annotation-avatar">
                        {(c.author_name || translateUI("评")).slice(0, 1)}
                      </span>
                      <div>
                        <b>{c.author_name || c.author}</b>
                        <time>
                          {new Date(c.created_at).toLocaleString(uiLocale(), {
                            month: "numeric",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                      {c.resolved && <small>{translateUI("已解决")}</small>}
                      <button
                        aria-label={translateUI("定位原文")}
                        title={orphaned ? translateUI("引用已失效") : translateUI("定位原文")}
                        disabled={orphaned}
                        onClick={() => locate(c)}
                      >
                        <Icon name="quote" size={15} />
                      </button>
                    </header>
                    <blockquote className={orphaned ? "orphaned" : ""}>
                      {quote(c.anchor)}
                    </blockquote>
                    <p className="annotation-message">{c.body}</p>
                    {comments
                      .filter((r) => r.parent_id === c.id)
                      .map((r) => (
                        <div className="annotation-reply" key={r.id}>
                          <b>{r.author_name || r.author}</b>
                          <p>{r.body}</p>
                        </div>
                      ))}
                    {active !== c.id && (
                      <button
                        className="annotation-expand"
                        onClick={() => locate(c)}
                      >{translateUI("查看讨论 ")}{comments.filter((r) => r.parent_id === c.id).length
                          ? translateUI(" · {0} 条回复", [comments.filter((r) => r.parent_id === c.id).length])
                          : ""}
                      </button>
                    )}
                    {active === c.id && canComment && (
                      <div className="annotation-reply-form">
                        <input
                          aria-label={translateUI("回复 {0}", [c.id])}
                          placeholder={translateUI("回复这条批注…")}
                          value={replies[c.id] || ""}
                          onChange={(e) =>
                            setReplies({ ...replies, [c.id]: e.target.value })
                          }
                        />
                        <div>
                          <button
                            disabled={
                              offline || !!busy || !replies[c.id]?.trim()
                            }
                            onClick={() =>
                              void mutate(c.id, async () => {
                                await request(
                                  `documents/${id}/comments`,
                                  "POST",
                                  { parent_id: c.id, text: replies[c.id] },
                                );
                                setReplies((old) => ({ ...old, [c.id]: "" }));
                              })
                            }
                          >{translateUI("回复 ")}</button>
                          <button
                            disabled={offline || !!busy}
                            onClick={() =>
                              void mutate(c.id, async () => {
                                await request(
                                  `documents/${id}/comments/${c.id}`,
                                  "PATCH",
                                  { resolved: !c.resolved },
                                );
                                setActive("");
                              })
                            }
                          >
                            {c.resolved ? translateUI("重新打开") : translateUI("解决评论")}
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                );
              })}
              {draft && (
                <article
                  className="annotation-card annotation-draft active"
                  aria-label={translateUI("新建批注")}
                  style={position("draft")}
                  ref={(node) => {
                    if (node) cards.current.set("draft", node);
                    else cards.current.delete("draft");
                  }}
                >
                  <header>
                    <Icon name="comment" size={17} />
                    <b>{translateUI("新建批注")}</b>
                    <button
                      aria-label={translateUI("取消批注")}
                      onClick={() => {
                        setDraft(null);
                        setText("");
                        setActive("");
                        setError("");
                      }}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </header>
                  <blockquote aria-label={translateUI("评论原文")}>{quote(draft)}</blockquote>
                  <textarea
                    rows={3}
                    aria-label={translateUI("评论内容")}
                    placeholder={translateUI("写下评论、观察或建议…")}
                    value={text}
                    maxLength={4000}
                    onChange={(e) => setText(e.target.value)}
                  />
                  <footer>
                    <span>{draft.blockId ? translateUI("段落批注") : translateUI("选区批注")}</span>
                    <button
                      className="annotation-send"
                      disabled={
                        offline || !!busy || !text.trim() || !canComment
                      }
                      onClick={() =>
                        void mutate("draft", async () => {
                          const resolved = resolveAnchor(ydoc, draft);
                          if (resolved.orphaned)
                            throw new Error(
                              translateUI("引用已失效，请取消后重新选择；草稿已保留。"),
                            );
                          const c = await request(
                            `documents/${id}/comments`,
                            "POST",
                            {
                              anchor: { ...draft, quote: resolved.text },
                              text,
                            },
                          );
                          setDraft(null);
                          setText("");
                          setFilter("open");
                          setActive(c.id);
                        })
                      }
                    >
                      {busy === "draft" ? translateUI("发送中…") : translateUI("添加评论")}
                    </button>
                  </footer>
                </article>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
