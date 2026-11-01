import React from "react";
const paths: Record<string, string> = {
  fullscreen:"M8 3H3v5 M16 3h5v5 M21 16v5h-5 M3 16v5h5",
  fit:"M3 8V3h5 M16 3h5v5 M21 16v5h-5 M8 21H3v-5 M8 8h8v8H8z",
  sun: "M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.6 5.6 7 7 M17 17l1.4 1.4 M5.6 18.4 7 17 M17 7l1.4-1.4 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  moon: "M20.8 13.3A9 9 0 0 1 10.7 3.2 9 9 0 1 0 20.8 13.3Z",
  monitor: "M3 4h18v13H3z M8 21h8 M12 17v4 M6 8h12",
  highlighter: "m4 15 7-10 8 6-7 9-5-1-3-4 M4 15l3 4 M3 21h15",
  "clear-format": "M4 4h16 M12 4v12 M8 16h5 M17 14l5 7 M22 14l-5 7",
  "row-before": "M4 11h16v10H4z M4 16h16 M12 11v10 M12 2v6 M9 5h6",
  "row-after": "M4 3h16v10H4z M4 8h16 M12 3v10 M12 16v6 M9 19h6",
  "row-delete": "M4 3h16v10H4z M4 8h16 M12 3v10 M8 19h8",
  "column-before": "M11 4h10v16H11z M16 4v16 M11 12h10 M2 12h6 M5 9v6",
  "column-after": "M3 4h10v16H3z M8 4v16 M3 12h10 M16 12h6 M19 9v6",
  "column-delete": "M3 4h10v16H3z M8 4v16 M3 12h10 M16 12h6",
  "cells-merge": "M3 4h18v16H3z M5 12h5 M8 9l3 3-3 3 M19 12h-5 M16 9l-3 3 3 3",
  "cells-split":
    "M3 4h18v16H3z M12 4v16 M9 12H5 M7 9l-3 3 3 3 M15 12h4 M17 9l3 3-3 3",
  book: "M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4z M13 7a3 3 0 0 1 3-3h5v15h-5a4 4 0 0 0-3 2",
  pin: "M9 3h6 M10 3v6l-4 4v2h12v-2l-4-4V3 M12 15v7",
  home: "m3 10 9-7 9 7 M5 9v11h5v-6h4v6h5V9",
  user: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M4 21v-2a8 8 0 0 1 16 0v2",
  users:
    "M15 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0 M5 21v-3a7 7 0 0 1 14 0v3 M19 4a3 3 0 0 1 0 6 M21 14a5 5 0 0 1 2 4",
  folder: "M3 6h6l2 2h10v12H3z M3 6V4h6l2 2",
  file: "M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6",
  search: "M20 20l-5-5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
  plus: "M12 5v14 M5 12h14",
  chevron: "m9 5 7 7-7 7",
  back: "m14 5-7 7 7 7",
  down: "m5 9 7 7 7-7",
  more: "M4 12h.01 M12 12h.01 M20 12h.01",
  comment: "M4 4h16v12H9l-5 4z",
  history: "M3 11a9 9 0 1 1 2 7 M3 4v7h7 M12 7v5l3 2",
  share: "M9 12 20 3 M13 3h7v7 M10 4H4v16h16v-6",
  settings:
    "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1z",
  archive: "M3 3h18v5H3z M5 8v13h14V8 M9 12h6",
  trash: "M4 6h16 M9 6V3h6v3 M6 6l1 15h10l1-15 M10 10v7 M14 10v7",
  check: "m5 12 4 4L19 6",
  close: "m6 6 12 12 M18 6 6 18",
  menu: "M4 6h16 M4 12h16 M4 18h16",
  lamp: "M5 21h14 M12 21v-6 M7 15h10l-3-9h-4z M17 15v3 M17 18h.01",
  "panel-close": "M4 4h16v16H4z M9 4v16 M16 9l-3 3 3 3",
  "panel-open": "M4 4h16v16H4z M9 4v16 M13 9l3 3-3 3",
  "list-collapse": "M10 6h10 M10 12h10 M10 18h10 M6 9l-3 3 3 3",
  "list-expand": "M10 6h10 M10 12h10 M10 18h10 M3 9l3 3-3 3",
  left: "M4 5h16 M4 10h10 M4 15h16 M4 20h10",
  center: "M4 5h16 M7 10h10 M4 15h16 M7 20h10",
  right: "M4 5h16 M10 10h10 M4 15h16 M10 20h10",
  justify: "M4 5h16 M4 10h16 M4 15h16 M4 20h16",
  list: "M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01",
  ordered: "M9 6h12 M9 12h12 M9 18h12 M3 3h1v6 M2 13h3l-3 6h3",
  code: "m8 6-6 6 6 6 M16 6l6 6-6 6 M14 3l-4 18",
  table: "M3 4h18v16H3z M3 9h18 M3 14h18 M9 4v16 M15 4v16",
  attachment: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8",
  image: "M3 3h18v18H3z m0 14 6-6 5 5 3-3 4 4 M15 7h.01",
  quote: "M5 7h5v6H5v-6 M5 13v4h3 M14 7h5v6h-5v-6 M14 13v4h3",
  divider: "M3 12h18",
  read: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12 M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0",
  edit: "m15 4 5 5 M4 20l5-1L21 7l-5-5L4 14z M4 20h16",
  sync: "M4 8a8 8 0 0 1 14-3l3 3 M21 3v5h-5 M20 16a8 8 0 0 1-14 3l-3-3 M3 21v-5h5",
  logout: "M9 3H4v18h5 M13 7l5 5-5 5 M8 12h13",
};
export function Icon({
  name,
  size = 18,
  ...props
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d={paths[name] || paths.file} />
    </svg>
  );
}
