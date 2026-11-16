type PrintTitle = { previous: string; title: string; restore: () => void };
let printing: PrintTitle | null = null;

export function setPageTitle(title: string) {
  if (printing) printing.previous = title;
  else document.title = title;
}

// Chromium uses the top-level title for PDFs printed from an iframe.
export function beginPrintTitle(title: string) {
  printing?.restore();
  const state: PrintTitle = {
    previous: document.title,
    title,
    restore() {
      if (printing !== state) return;
      printing = null;
      if (document.title === state.title) document.title = state.previous;
    },
  };
  printing = state;
  document.title = title;
  // HTML normalizes whitespace when reading document.title.
  state.title = document.title;
  return state.restore;
}
