import type MarkdownIt from "markdown-it";
export function mathMarkdown(md: MarkdownIt) {
  md.inline.ruler.before("escape", "math_inline", (state, silent) => {
    const start = state.pos;
    if (state.src[start] !== "$" || state.src[start + 1] === "$") return false;
    let end = start + 1;
    while (
      (end = state.src.indexOf("$", end)) >= 0 &&
      state.src[end - 1] === "\\"
    )
      end++;
    if (
      end < 0 ||
      end === start + 1 ||
      state.src.slice(start, end).includes("\n")
    )
      return false;
    if (!silent) {
      const token = state.push("math_inline", "", 0);
      token.content = state.src.slice(start + 1, end).trim();
    }
    state.pos = end + 1;
    return true;
  });
  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      const start = state.bMarks[startLine] + state.tShift[startLine],
        first = state.src.slice(start, state.eMarks[startLine]);
      if (!first.startsWith("$$")) return false;
      let last = startLine,
        source = first.slice(2);
      if (source.trimEnd().endsWith("$$"))
        source = source.trimEnd().slice(0, -2);
      else {
        let closed = false;
        for (last = startLine + 1; last < endLine; last++) {
          const line = state.src.slice(
            state.bMarks[last] + state.tShift[last],
            state.eMarks[last],
          );
          if (line.trimEnd().endsWith("$$")) {
            source += "\n" + line.trimEnd().slice(0, -2);
            closed = true;
            break;
          }
          source += "\n" + line;
        }
        if (!closed) return false;
      }
      if (!source.trim() || silent) return !!source.trim();
      const token = state.push("math_block", "", 0);
      token.content = source.trim();
      token.block = true;
      token.map = [startLine, last + 1];
      state.line = last + 1;
      return true;
    },
  );
  md.renderer.rules.math_inline = (tokens, index) =>
    '<span data-inline-math data-latex="' +
    md.utils.escapeHtml(tokens[index].content) +
    '"></span>';
  md.renderer.rules.math_block = (tokens, index) =>
    '<div data-math-block data-latex="' +
    md.utils.escapeHtml(tokens[index].content) +
    '"></div>';
}
