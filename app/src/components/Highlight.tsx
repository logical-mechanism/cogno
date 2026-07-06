// Highlight — render text with the search term marked. Wraps every case-insensitive occurrence of
// `query` in a <mark>, matching the node's literal-substring search (the WHOLE term, not per-word), so
// a result shows exactly why it matched. Pure text in / React nodes out — never
// dangerouslySetInnerHTML — so it stays XSS-safe like the rest of the render path.

import { Fragment, type ReactNode } from "react";
import styles from "./Highlight.module.css";

/** Escape a user-supplied string for literal use inside a RegExp. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface HighlightProps {
  /** The text to render. */
  text: string;
  /** The (normalized) query whose case-insensitive occurrences get a <mark>. Empty/absent → plain text. */
  query?: string;
}

export function Highlight({ text, query }: HighlightProps) {
  const q = query?.trim() ?? "";
  if (q.length === 0 || text.length === 0) return <>{text}</>;

  const re = new RegExp(escapeRegExp(q), "gi");
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push(<Fragment key={key++}>{text.slice(last, start)}</Fragment>);
    out.push(
      <mark key={key++} className={styles.mark}>
        {m[0]}
      </mark>,
    );
    last = start + m[0].length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return <>{out}</>;
}
