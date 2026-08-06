// media — pure helpers for the image reveal-cover (image-reveal feature).
//
// The chain is text-only; an image URL pasted into a post/bio (or set as an avatar/banner) points at
// an ARBITRARY host. These helpers classify which links are images (so the UI can gate them behind a
// click-to-reveal cover instead of auto-fetching) and resolve ipfs:// URIs to a public gateway. No
// DOM, no network — unit-tested in media.test.ts.

/** Image file extensions we render behind a reveal cover (lower-case, no dot). */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"] as const;

/** Public IPFS gateway used to fetch ipfs:// content once the user reveals it. */
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

const EXT_RE = /\.([a-z0-9]+)$/;
const IMAGE_EXT_SET: ReadonlySet<string> = new Set(IMAGE_EXTENSIONS);

/** The lower-cased file extension of a path-like string (query/hash already stripped), or null. */
function extensionOf(pathLike: string): string | null {
  const m = pathLike.toLowerCase().match(EXT_RE);
  return m ? m[1] : null;
}

/**
 * True when `url` should be rendered as an image (behind a reveal cover):
 *   - http(s): must end in a known image extension (a generic link stays a link).
 *   - ipfs://: counts when it carries an image extension OR no extension at all (a bare CID is
 *     assumed to be an image — a wrong guess degrades to the broken-image fallback, never an
 *     auto-fetch, because the cover gates the load).
 * Query string and hash fragment are ignored when reading the extension.
 */
export function isImageUrl(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0];
  if (/^ipfs:\/\//i.test(path)) {
    // Require a non-empty CID (`ipfs://` / `ipfs://ipfs/` alone is not an image).
    const cid = path.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    if (!cid) return false;
    const ext = extensionOf(path);
    return ext === null || IMAGE_EXT_SET.has(ext);
  }
  if (/^https?:\/\//i.test(path)) {
    const ext = extensionOf(path);
    return ext !== null && IMAGE_EXT_SET.has(ext);
  }
  return false;
}

/**
 * Resolve an ipfs:// URI to an {@link IPFS_GATEWAY} http(s) URL so a browser <img> can load it;
 * http(s) URLs pass through unchanged. Normalises both `ipfs://<cid>` and the `ipfs://ipfs/<cid>`
 * double-prefix form.
 */
export function resolveImageSrc(url: string): string {
  const m = url.match(/^ipfs:\/\/(.+)$/i);
  if (!m) return url;
  // Strip an `ipfs/` prefix and any leading slash / dot-segment so a crafted path can't dangle
  // outside the gateway's /ipfs/ root, then resolve against the gateway base and REQUIRE the result to
  // stay under the gateway root — a crafted absolute path (e.g. a `scheme:` prefix smuggled in after
  // `ipfs://`) would otherwise make new URL ignore the base and yield a foreign origin.
  const path = m[1].replace(/^ipfs\//i, "").replace(/^[./]+/, "").trim();
  if (!path) return url; // `ipfs://` / `ipfs://ipfs/` with no CID — leave untouched, don't hit the root
  try {
    const out = new URL(path, IPFS_GATEWAY).toString();
    return out.startsWith(IPFS_GATEWAY) ? out : url;
  } catch {
    return url;
  }
}

// URL tokenizer shared with the post renderer (PostBody.segment) and the composer's image-link chip, so
// the two never drift on which links count as images. Match http(s) AND ipfs:// URLs, stopping the run
// at whitespace; trailing sentence punctuation is trimmed so a URL at the end of a sentence
// ("see https://x.org.") doesn't swallow the period.
export const URL_RE = /(?:https?|ipfs):\/\/[^\s]+/gi;
export const TRAILING_PUNCT = /[.,!?:;)\]}'"»”’]+$/;

/**
 * The X-style shortened LABEL for a URL: host + first path segment + `…`. The full URL stays the href;
 * only the visible text shortens. Short URLs render as-is, minus the scheme.
 *
 * THE HOST COMES FROM `new URL().host`, AND THAT IS THE SECURITY PROPERTY, not a convenience. The
 * browser's parser is what decides where a link actually goes, so deriving the label from it is the only
 * way the label cannot lie:
 *   • `https://good.com@evil.com/login` → `evil.com/login`. Stripping the scheme with a regex instead
 *     yields `good.com@evil.com/login`, which leads with the wrong host.
 *   • `https://аpple.com` (Cyrillic а) → `xn--pple-43d.com`. A regex strip yields `аpple.com`, which is
 *     pixel-identical to `apple.com` — a clean homograph spoof.
 * This lived privately inside PostBody while ProfileHeader hand-rolled a regex version, and the profile
 * website field carried both spoofs above. One implementation, every surface.
 */
export function urlLabel(raw: string): string {
  if (/^ipfs:\/\//i.test(raw)) {
    const cid = raw.replace(/^ipfs:\/\//i, "");
    return cid.length > 18 ? `ipfs://${cid.slice(0, 16)}…` : raw;
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw; // unparseable — show it verbatim rather than inventing a host
  }
  const host = u.host.replace(/^www\./, "");
  const path = u.pathname === "/" ? "" : u.pathname;
  const seg1 = clampSeg(path.split("/").filter(Boolean)[0]);
  const tail = u.search || u.hash;
  if (!seg1 && !tail) return host;
  if (seg1 && (path.split("/").filter(Boolean).length > 1 || tail)) return `${host}/${seg1}/…`;
  if (seg1) return `${host}/${seg1}`;
  return `${host}/…`;
}

/** Longest first-path-segment kept in a label before it is elided. */
const MAX_LABEL_SEG = 24;

/**
 * Shorten an over-long first path segment.
 *
 * ⚑ THE HOST IS DELIBERATELY NEVER TRUNCATED, and that asymmetry is the point. A host reads
 * right-to-left — the registrable domain is at the END — so eliding its tail is exactly the spoof this
 * function exists to prevent: `good.com.evil.com` clipped to `good.com…` names the attacker's victim
 * instead of the attacker. A path segment carries no such meaning and is the only unbounded part left,
 * so it is the only part that gets clipped. A real host is bounded by DNS to 253 characters and is
 * almost always far shorter; a 460-character path is one keystroke.
 */
function clampSeg(seg: string | undefined): string | undefined {
  if (seg === undefined) return undefined;
  return seg.length > MAX_LABEL_SEG ? `${seg.slice(0, MAX_LABEL_SEG)}…` : seg;
}

/** How many URLs in `text` render as images (same classification the renderer applies). Used by the
 *  composer to show the "N image links — shown when opened" chip without re-deriving the URL scan. */
export function countImageUrls(text: string): number {
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (isImageUrl(m[0].replace(TRAILING_PUNCT, ""))) n += 1;
  }
  return n;
}
