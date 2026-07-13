"use client";

// PostBody — render a post's text (doc 03 §4, D1).
//
// TEXT ONLY, with one exception: an image LINK (an http(s)/ipfs:// URL ending in an image extension,
// or a bare ipfs:// CID) renders behind a click-to-reveal cover (RevealImage) so the browser never
// auto-fetches an arbitrary host — there is still no media FIELD on-chain. Everything else:
//   - bare http(s)/ipfs:// URLs auto-link (ipfs:// resolved to a gateway).
//   - @mention links — a `@<full-ss58>` (a checksum-valid AccountId32, ~48 base58 chars) links to that
//     person's profile as a `<MentionChip>`: their CURRENT display name as plain inline text, with the
//     same ProfileHoverCard quick-view the post's author line has. Only a FULL checksummed ss58
//     linkifies (near-zero false positives); a truncated handle stays plain text. A
//     mention refers to a unique PERSON encoded in the body itself (no side-field) — the ss58 IS the
//     addressable value even though the cosmetic truncated handle is not (`lib/mentions`).
//   - #hashtag links — a `#tag` links to /explore/?q=%23tag (a case-insensitive substring search).
//     There is still no Topics surface; the link just runs the search that `#tag` matches.
//   - NO markdown.
// Line breaks are preserved (white-space: pre-wrap) and long unbroken strings wrap
// (overflow-wrap: break-word). The node tree is built from PARSED SEGMENTS — never
// dangerouslySetInnerHTML — so the text is XSS-safe; the only links we emit are anchors with
// rel="noopener noreferrer nofollow", target=_blank, styled in --cg-accent.

import { useMemo } from "react";
import Link from "next/link";
import { isImageUrl, resolveImageSrc, URL_RE, TRAILING_PUNCT } from "@/lib/media";
import { validSs58Prefix } from "@/lib/mentions";
import { RevealImage } from "./RevealImage";
import { MentionChip } from "./MentionChip";
import { Highlight } from "./Highlight";
import styles from "./PostBody.module.css";

export interface PostBodyProps {
  /** Raw UTF-8 post body. */
  text: string;
  /** `lg` is the larger detail-variant body (--cg-fs-md); default is the 15px base. */
  size?: "base" | "lg";
  /** Banned-author dimming (D10): muted body. */
  dim?: boolean;
  /** Search term to <mark> in the plain-text / hashtag runs (URLs + images stay untouched). */
  highlight?: string;
}

// URL_RE + TRAILING_PUNCT (the http(s)/ipfs run matcher + trailing-punctuation strip) live in
// @/lib/media so the composer's image-link chip classifies links identically to what we render here.
// TOKEN_RE matches, inside a PLAIN-TEXT run (never inside a matched URL — so `https://x.org/#section`
// and `https://x.org/@handle` are never re-tokenized), either:
//   - a #hashtag: '#' + Unicode letters/numbers/underscore, or
//   - a mention candidate: '@' + a ≥44-char base58 run (checksum-validated below via validSs58Prefix).
const TOKEN_RE = /#[\p{L}\p{N}_]+|@[1-9A-HJ-NP-Za-km-z]{44,}/gu;

interface Seg {
  kind: "text" | "url" | "image" | "hashtag" | "mention";
  /** the run text (text/url/image/hashtag); for a mention, the canonical prefix-42 ss58. */
  value: string;
}

/** Push a plain-text run onto `segs`, further split into text + #hashtag + @mention segments. */
function pushText(segs: Seg[], text: string): void {
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    const start = m.index ?? 0;
    const tok = m[0];
    if (tok[0] === "@") {
      // Only a checksum-valid ss58 PREFIX linkifies; a look-alike run stays plain text. A base58 char
      // glued to the address (no separator) is not consumed — validSs58Prefix returns just the address.
      const hit = validSs58Prefix(tok.slice(1));
      if (!hit) continue; // leave as plain text — emitted by the next slice / final tail
      if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
      segs.push({ kind: "mention", value: hit.ss58 });
      last = start + 1 + hit.length; // consumed '@' + the address only
      continue;
    }
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    segs.push({ kind: "hashtag", value: tok });
    last = start + tok.length;
  }
  if (last < text.length) segs.push({ kind: "text", value: text.slice(last) });
}

/** Split a body into plain-text + url + image + hashtag segments (pure; no DOM). */
function segment(text: string): Seg[] {
  const segs: Seg[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    let url = m[0];
    // Re-attach trailing sentence punctuation that isn't part of the URL to the following text run.
    const trail = url.match(TRAILING_PUNCT)?.[0] ?? "";
    if (trail) url = url.slice(0, url.length - trail.length);
    if (start > last) pushText(segs, text.slice(last, start));
    segs.push({ kind: isImageUrl(url) ? "image" : "url", value: url });
    if (trail) segs.push({ kind: "text", value: trail });
    last = start + m[0].length;
  }
  if (last < text.length) pushText(segs, text.slice(last));
  return segs;
}

/** The href a (non-image) link segment opens — ipfs:// links resolve to a gateway so they work. */
function linkHref(raw: string): string {
  return /^ipfs:\/\//i.test(raw) ? resolveImageSrc(raw) : raw;
}

/** A short alt for a linked image — its filename, else a generic label (never the whole URL). */
function imageAlt(raw: string): string {
  const path = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const slash = path.lastIndexOf("/");
  return (slash >= 0 ? path.slice(slash + 1) : "") || "Linked image";
}

/**
 * X-style shortened LABEL for a long URL: host + first path segment + `…`. The full URL stays the
 * href; only the visible text is shortened. Short URLs render as-is (minus the scheme).
 */
function urlLabel(raw: string): string {
  if (/^ipfs:\/\//i.test(raw)) {
    const cid = raw.replace(/^ipfs:\/\//i, "");
    return cid.length > 18 ? `ipfs://${cid.slice(0, 16)}…` : raw;
  }
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

export function PostBody({ text, size = "base", dim, highlight }: PostBodyProps) {
  const segs = useMemo(() => segment(text), [text]);

  const cls = [styles.body, size === "lg" ? styles.lg : styles.base, dim ? styles.dim : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls}>
      {segs.map((s, i) => {
        if (s.kind === "image") {
          const resolved = resolveImageSrc(s.value);
          return (
            <span key={i} className={styles.media}>
              <RevealImage src={resolved} alt={imageAlt(s.value)} href={resolved} />
            </span>
          );
        }
        if (s.kind === "url") {
          return (
            <a
              key={i}
              className={styles.link}
              href={linkHref(s.value)}
              target="_blank"
              rel="noopener noreferrer nofollow"
              // Links inside a clickable PostCard row must not also trigger the row navigation.
              onClick={(e) => e.stopPropagation()}
              title={s.value}
            >
              {urlLabel(s.value)}
            </a>
          );
        }
        if (s.kind === "hashtag") {
          return (
            <Link
              key={i}
              className={styles.link}
              href={`/explore/?q=${encodeURIComponent(s.value)}`}
              // Inside a clickable PostCard row — don't also trigger the row navigation.
              onClick={(e) => e.stopPropagation()}
            >
              <Highlight text={s.value} query={highlight} />
            </Link>
          );
        }
        if (s.kind === "mention") {
          // s.value is the canonical ss58; the chip resolves the current display name + hover card.
          return <MentionChip key={i} ss58={s.value} />;
        }
        return <Highlight key={i} text={s.value} query={highlight} />;
      })}
    </div>
  );
}
