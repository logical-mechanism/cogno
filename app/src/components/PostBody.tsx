"use client";

// PostBody — render a post's text (D1).
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
//   - #hashtag links — a `#tag` links to /explore/?q=%23tag, which renders the TOPIC surface (an
//     exact-tag feed built on the node's substring search — see lib/topics). The link carries the
//     ASCII-folded canonical tag so `#Cardano` and `#cardano` are one topic; the label keeps the
//     author's casing.
//   - NO markdown.
// Line breaks are preserved (white-space: pre-wrap) and long unbroken strings wrap
// (overflow-wrap: break-word). The node tree is built from PARSED SEGMENTS — never
// dangerouslySetInnerHTML — so the text is XSS-safe; the only links we emit are anchors with
// rel="noopener noreferrer nofollow", target=_blank, styled in --cg-accent.
// The raw body is first run through `sanitizeText` (lib/sanitize) to defuse the VISUAL abuse React does
// NOT stop — bidi-override spoofing (Trojan Source), invisible separators, Zalgo mark-stacking — and the
// container is dir="auto" so genuine RTL still lays out. Sanitizing here (not at the data layer) keeps
// the byte-identical text on the search / write paths untouched.

import { useMemo } from "react";
import Link from "next/link";
import { resolveImageSrc } from "@/lib/media";
import { sanitizeText } from "@/lib/sanitize";
import { segment } from "@/lib/postText";
import { canonicalTag, tagSearchTerm } from "@/lib/topics";
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

// The tokenizer (URL / image / #hashtag / @mention segmentation) lives in @/lib/postText so the topic
// parser (@/lib/topics) splits a body EXACTLY the way this renders it — a second regex would let a post
// linkify `#cardano` here while being absent from the `#cardano` topic feed.

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
  const segs = useMemo(() => segment(sanitizeText(text)), [text]);

  // Empty body ⇒ render nothing (no empty box / spacing). A governance poll's post text is optional — its
  // subject is the tagged proposal — so a legitimately empty body reaches here; don't leave a gap for it.
  if (segs.length === 0) return null;

  const cls = [styles.body, size === "lg" ? styles.lg : styles.base, dim ? styles.dim : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} dir="auto">
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
          // Link to the CANONICAL (ASCII-folded) topic so `#Cardano` and `#cardano` reach one feed,
          // while the label keeps the author's own casing. An unusable tag (over-length) canonicalizes
          // to null and renders as plain text rather than a link to a topic that can't resolve.
          const topic = canonicalTag(s.value);
          if (topic === null) return <Highlight key={i} text={s.value} query={highlight} />;
          return (
            <Link
              key={i}
              className={styles.link}
              href={`/explore/?q=${encodeURIComponent(tagSearchTerm(topic))}`}
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
