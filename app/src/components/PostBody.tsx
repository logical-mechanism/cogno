"use client";

// PostBody — render a post's text (doc 03 §4, D1).
//
// TEXT ONLY, with one exception: a media LINK (an http(s)/ipfs:// URL ending in an image/video/audio
// extension, or a bare ipfs:// CID) renders behind a click-to-reveal cover (RevealImage / RevealVideo /
// RevealAudio) so the browser never auto-fetches an arbitrary host — there is still no media FIELD
// on-chain; the URL's extension IS the format, classified in @/lib/media. Everything else:
//   - bare http(s)/ipfs:// URLs auto-link (ipfs:// resolved to a gateway). Third-party embeds
//     (YouTube/tweets) stay plain links by design — no live iframe (arbitrary third-party JS).
//   - NO @mention links — handles are non-unique truncated ss58, NOT addressable text, so a
//     literal `@5CBE…` in a body is plain text (divergence from X, by design).
//   - #hashtag links — a `#tag` links to /explore/?q=%23tag (a case-insensitive substring search).
//     There is still no Topics surface; the link just runs the search that `#tag` matches.
//   - NO markdown.
// Line breaks are preserved (white-space: pre-wrap) and long unbroken strings wrap
// (overflow-wrap: break-word). The node tree is built from PARSED SEGMENTS — never
// dangerouslySetInnerHTML — so the text is XSS-safe; the only links we emit are anchors with
// rel="noopener noreferrer nofollow", target=_blank, styled in --cg-accent.

import { useMemo } from "react";
import Link from "next/link";
import { classifyMedia, resolveMediaSrc, URL_RE, TRAILING_PUNCT } from "@/lib/media";
import { RevealImage } from "./RevealImage";
import { RevealVideo } from "./RevealVideo";
import { RevealAudio } from "./RevealAudio";
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
// A #hashtag: '#' + Unicode letters/numbers/underscore. Scanned ONLY inside plain-text runs (never
// inside a matched URL), so a fragment like `https://x.org/#section` is never re-linkified.
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;

interface Seg {
  kind: "text" | "url" | "image" | "video" | "audio" | "hashtag";
  value: string;
}

/** Push a plain-text run onto `segs`, further split into text + #hashtag segments. */
function pushText(segs: Seg[], text: string): void {
  let last = 0;
  for (const m of text.matchAll(HASHTAG_RE)) {
    const start = m.index ?? 0;
    if (start > last) segs.push({ kind: "text", value: text.slice(last, start) });
    segs.push({ kind: "hashtag", value: m[0] });
    last = start + m[0].length;
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
    segs.push({ kind: classifyMedia(url) ?? "url", value: url });
    if (trail) segs.push({ kind: "text", value: trail });
    last = start + m[0].length;
  }
  if (last < text.length) pushText(segs, text.slice(last));
  return segs;
}

/** The href a (non-media) link segment opens — ipfs:// links resolve to a gateway so they work. */
function linkHref(raw: string): string {
  return /^ipfs:\/\//i.test(raw) ? resolveMediaSrc(raw) : raw;
}

/** A short accessible name for a linked media asset — its filename, else a per-kind generic label
 *  (never the whole URL). */
function mediaAlt(raw: string, kind: "image" | "video" | "audio"): string {
  const path = raw.split(/[?#]/, 1)[0].replace(/\/+$/, "");
  const slash = path.lastIndexOf("/");
  const name = slash >= 0 ? path.slice(slash + 1) : "";
  if (name) return name;
  return kind === "video" ? "Linked video" : kind === "audio" ? "Linked audio" : "Linked image";
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
        if (s.kind === "image" || s.kind === "video" || s.kind === "audio") {
          const resolved = resolveMediaSrc(s.value);
          const alt = mediaAlt(s.value, s.kind);
          if (s.kind === "video") {
            return (
              <span key={i} className={styles.media}>
                <RevealVideo src={resolved} alt={alt} />
              </span>
            );
          }
          if (s.kind === "audio") {
            return (
              <span key={i} className={styles.mediaAudio}>
                <RevealAudio src={resolved} alt={alt} />
              </span>
            );
          }
          // image: keep the new-tab link (the image stays inspectable at its source).
          return (
            <span key={i} className={styles.media}>
              <RevealImage src={resolved} alt={alt} href={resolved} />
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
        return <Highlight key={i} text={s.value} query={highlight} />;
      })}
    </div>
  );
}
