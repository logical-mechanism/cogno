"use client";

// PostBody — render a post's text (doc 03 §4, D1).
//
// TEXT ONLY. We auto-link bare http(s) URLs and render NOTHING else specially:
//   - NO media (images/video/GIF) — there is no media field on-chain.
//   - NO @mention links — handles are non-unique truncated ss58, NOT addressable text, so a
//     literal `@5CBE…` in a body is plain text (divergence from X, by design).
//   - NO #hashtag links — there is no Topics surface (out of scope); a `#tag` is plain text.
//   - NO markdown.
// Line breaks are preserved (white-space: pre-wrap) and long unbroken strings wrap
// (overflow-wrap: break-word). The node tree is built from PARSED SEGMENTS — never
// dangerouslySetInnerHTML — so the text is XSS-safe; the only links we emit are http(s) anchors with
// rel="noopener noreferrer nofollow", target=_blank, styled in --cg-accent.

import { Fragment, useMemo } from "react";
import styles from "./PostBody.module.css";

export interface PostBodyProps {
  /** Raw UTF-8 post body. */
  text: string;
  /** `lg` is the larger detail-variant body (--cg-fs-md); default is the 15px base. */
  size?: "base" | "lg";
  /** Banned-author dimming (D10): muted body. */
  dim?: boolean;
}

// Match http(s) URLs. Stop the run at whitespace; trailing sentence punctuation is trimmed below so a
// URL at the end of a sentence ("see https://x.org.") doesn't swallow the period.
const URL_RE = /https?:\/\/[^\s]+/gi;
const TRAILING_PUNCT = /[.,!?:;)\]}'"»”’]+$/;

interface Seg {
  kind: "text" | "url";
  value: string;
}

/** Split a body into plain-text + url segments (pure; no DOM). */
function segment(text: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Re-attach trailing sentence punctuation that isn't part of the URL to the following text run.
    const trail = url.match(TRAILING_PUNCT)?.[0] ?? "";
    if (trail) url = url.slice(0, url.length - trail.length);
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    segs.push({ kind: "url", value: url });
    if (trail) segs.push({ kind: "text", value: trail });
    last = start + m[0].length;
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) });
  return segs;
}

/**
 * X-style shortened LABEL for a long URL: host + first path segment + `…`. The full URL stays the
 * href; only the visible text is shortened. Short URLs render as-is (minus the scheme).
 */
function urlLabel(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  const host = u.host.replace(/^www\./, "");
  const path = u.pathname === "/" ? "" : u.pathname;
  const seg1 = path.split("/").filter(Boolean)[0];
  const tail = u.search || u.hash;
  if (!seg1 && !tail) return host;
  if (seg1 && (path.split("/").filter(Boolean).length > 1 || tail)) {
    return `${host}/${seg1}/…`;
  }
  if (seg1) return `${host}/${seg1}`;
  return `${host}/…`;
}

export function PostBody({ text, size = "base", dim }: PostBodyProps) {
  const segs = useMemo(() => segment(text), [text]);

  const cls = [styles.body, size === "lg" ? styles.lg : styles.base, dim ? styles.dim : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {segs.map((s, i) =>
        s.kind === "url" ? (
          <a
            key={i}
            className={styles.link}
            href={s.value}
            target="_blank"
            rel="noopener noreferrer nofollow"
            // Links inside a clickable PostCard row must not also trigger the row navigation.
            onClick={(e) => e.stopPropagation()}
            title={s.value}
          >
            {urlLabel(s.value)}
          </a>
        ) : (
          <Fragment key={i}>{s.value}</Fragment>
        ),
      )}
    </div>
  );
}
