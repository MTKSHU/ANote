import { Extension, InputRule } from "@tiptap/core";
import { DOMParser } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import MarkdownIt from "markdown-it";
import { mathMarkdown } from "@anote/sync-core/math-markdown";
import { taskMarkdown } from "@anote/sync-core/task-markdown";

const markdown = new MarkdownIt({ html: false, linkify: true });
markdown.use(mathMarkdown);
markdown.use(taskMarkdown);
// Remote image references stay editable text; attachments use the upload flow.
markdown.renderer.rules.image = (tokens, index) => {
  const token = tokens[index],
    title = token.attrGet("title");
  return markdown.utils.escapeHtml(
    `![${token.content}](${token.attrGet("src") || ""}${title ? " " + JSON.stringify(title) : ""})`,
  );
};
const looksLikeMarkdown = (text: string) =>
  /^(?: {0,3})(?:#{1,5}[ \t]|[-+*][ \t]|\d{1,9}[.)][ \t]|>[ \t]|`{3}|~{3}|-{3,}\s*$)/m.test(
    text,
  ) || /\*\*[^*\n]+\*\*|\*[^*\n]+\*|~~[^~\n]+~~|`[^`\n]+`|\$[^$]+\$|\[[^\]\n]+\]\([^\n]+\)|https?:\/\//.test(text);

export const MarkdownShortcuts = Extension.create({
  name: "academicMarkdownShortcuts",
  priority:1000,
  addInputRules() {
    return [
      new InputRule({
        find:/^(?:[-+*][ \t]+)?\[([ xX]?)\][ \t]+(\S[^\n]*)?$/,
        handler:({state,range,match,chain})=>{
          if(state.selection.$from.parent.type.name!=="paragraph")return null;
          const commands=chain().deleteRange(range).toggleTaskList().updateAttributes("taskItem",{checked:match[1].toLowerCase()==="x"});
          if(match[2])commands.insertContent({type:"text",text:match[2]});commands.run();
        },
      }),
      new InputRule({
        find: /(?<!!|\\)\[([^\]\n]+)\]\((https?:\/\/[^\s<>]+|mailto:[^\s<>]+)\)$/i,
        handler: ({ state, range, match }) => {
          if (state.selection.$from.parent.type.spec.code || !state.schema.marks.link) return null;
          // Validate with the same Markdown parser used for paste; unsafe URL
          // schemes never become executable links.
          const tokens = markdown.parseInline(match[0], {}),
            href = tokens[0]?.children?.find(token => token.type === "link_open")?.attrGet("href");
          if (!href || !/^(https?:\/\/|mailto:)/i.test(href)) return null;
          state.tr.replaceWith(range.from, range.to,
            state.schema.text(match[1], [state.schema.marks.link.create({ href, target: "_blank", rel: "noopener noreferrer nofollow" })]));
          state.tr.removeStoredMark(state.schema.marks.link);
        },
      }),
      new InputRule({
        // Explicit boundary support for Chinese labels such as “地址：https://… ”.
        find: /(https?:\/\/[^\s<>，。；：！？、]+)[ \t]$/i,
        handler: ({state,range,match}) => {
          if(state.selection.$from.parent.type.spec.code || !state.schema.marks.link) return null;
          const href=match[1].replace(/[.,!?;:]+$/,"");
          if(!markdown.validateLink(href)) return null;
          state.tr.replaceWith(range.from,range.to,[state.schema.text(href,[state.schema.marks.link.create({href,target:"_blank",rel:"noopener noreferrer nofollow"})]),state.schema.text(match[0].slice(href.length))]);
          state.tr.removeStoredMark(state.schema.marks.link);
        },
      }),
      new InputRule({
        // IMEs and insertText can commit the prefix and body in one event.
        find: /^(#{1,5})[ \t\u3000]+(\S[^\n]*)$/,
        handler: ({ state, range, match }) => {
          const $start = state.doc.resolve(range.from),
            type = state.schema.nodes.heading;
          if (
            $start.parent.type.name !== "paragraph" ||
            !$start
              .node(-1)
              .canReplaceWith($start.index(-1), $start.indexAfter(-1), type)
          )
            return null;
          state.tr
            .delete(range.from, range.from + match[0].length - match[2].length)
            .setBlockType(range.from, range.from, type, {
              ...$start.parent.attrs,
              level: match[1].length,
            });
        },
      }),
    ];
  },
  addProseMirrorPlugins() {
    let source: string | null = null;
    let literal = false;
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            paste: (view, event) => {
              literal = false;
              const clipboard = (event as ClipboardEvent).clipboardData;
              source =
                view.editable &&
                !clipboard?.files.length &&
                !clipboard?.getData("text/html")
                  ? clipboard?.getData("text/plain") || null
                  : null;
              return false;
            },
          },
          transformPastedText(text, plain) {
            // This hook distinguishes explicit plain paste from an ordinary
            // text-only clipboard; transformPasted's flag does not.
            literal = plain;
            return text;
          },
          transformPasted(slice, view) {
            const text = source,
              asLiteral = literal;
            source = null;
            literal = false;
            // Preserve rich clipboard content, explicit plain-text paste and code.
            if (
              asLiteral ||
              !text ||
              text.length > 200_000 ||
              view.state.selection.$from.parent.type.spec.code ||
              !looksLikeMarkdown(text)
            )
              return slice;
            const container = view.dom.ownerDocument.createElement("div");
            container.innerHTML = markdown.render(text);
            return DOMParser.fromSchema(view.state.schema).parseSlice(
              container,
              {
                preserveWhitespace: true,
                context: view.state.selection.$from,
              },
            );
          },
        },
      }),
    ];
  },
});
