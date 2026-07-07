// Highlight — render text with the search term marked. Wraps every occurrence of `query` in a <mark>,
// matching the node's search semantics: a literal substring, case-insensitive over ASCII ONLY (the
// node uses eq_ignore_ascii_case, so é≠É). A JS `gi` regex would fold non-ASCII case pairs and mark
// substrings the node never counted, so we fold only A–Z here. Pure text in / React nodes out — never
// dangerouslySetInnerHTML — so it stays XSS-safe like the rest of the render path.

import { Fragment, useMemo, type ReactNode } from "react";
import styles from "./Highlight.module.css";

/** Lowercase only ASCII A–Z. Length-preserving (so indices map 1:1 back onto the original), leaving
 *  every non-ASCII byte untouched — the exact fold the node's `eq_ignore_ascii_case` performs. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export interface HighlightProps {
  /** The text to render. */
  text: string;
  /** The (normalized) query whose ASCII-case-insensitive occurrences get a <mark>. Empty → plain text. */
  query?: string;
}

export function Highlight({ text, query }: HighlightProps) {
  const q = query?.trim() ?? "";
  const nodes = useMemo<ReactNode>(() => {
    if (q.length === 0 || text.length === 0) return text;
    const hay = asciiLower(text);
    const needle = asciiLower(q);
    const out: ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (let idx = hay.indexOf(needle, last); idx !== -1; idx = hay.indexOf(needle, last)) {
      if (idx > last) out.push(<Fragment key={key++}>{text.slice(last, idx)}</Fragment>);
      out.push(
        <mark key={key++} className={styles.mark}>
          {text.slice(idx, idx + needle.length)}
        </mark>,
      );
      last = idx + needle.length;
    }
    if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
    return out;
  }, [text, q]);

  return <>{nodes}</>;
}
