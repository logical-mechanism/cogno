// media — pure helpers for the reveal-cover media pipeline (image-reveal feature).
//
// The chain is text-only; a media URL pasted into a post/bio (or set as an avatar/banner) points at an
// ARBITRARY host. These helpers classify which links are renderable media — image, video, or audio (so
// the UI can gate them behind a click-to-reveal cover instead of auto-fetching) and resolve ipfs:// URIs
// to a public gateway. No DOM, no network — unit-tested in media.test.ts.

/** Image file extensions we render behind a reveal cover (lower-case, no dot). `gif` stays here: an
 *  animated GIF is an `<img>` that auto-animates the instant it mounts — "plays when revealed". */
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"] as const;

/** Video file extensions we render behind a reveal cover. Deliberately TRIMMED to formats browsers
 *  decode broadly — do NOT add mov/ogv/mkv (playback the browser often can't deliver; unknown
 *  extensions degrade to a plain link, and a mis-guess to the broken-media fallback). */
export const VIDEO_EXTENSIONS = ["mp4", "webm"] as const;

/** Audio file extensions we render behind a reveal cover (same broadly-decodable trim; no aac/flac). */
export const AUDIO_EXTENSIONS = ["mp3", "ogg", "wav", "m4a"] as const;

/** What a media URL renders as. `null` (from {@link classifyMedia}) means "a plain link, not media". */
export type MediaKind = "image" | "video" | "audio";

/** Public IPFS gateway used to fetch ipfs:// content once the user reveals it. */
export const IPFS_GATEWAY = "https://ipfs.io/ipfs/";

const EXT_RE = /\.([a-z0-9]+)$/;
const IMAGE_EXT_SET: ReadonlySet<string> = new Set(IMAGE_EXTENSIONS);
const VIDEO_EXT_SET: ReadonlySet<string> = new Set(VIDEO_EXTENSIONS);
const AUDIO_EXT_SET: ReadonlySet<string> = new Set(AUDIO_EXTENSIONS);

/** Map a lower-cased file extension to its MediaKind, or null when it's not a type we render. */
function kindForExt(ext: string): MediaKind | null {
  if (IMAGE_EXT_SET.has(ext)) return "image";
  if (VIDEO_EXT_SET.has(ext)) return "video";
  if (AUDIO_EXT_SET.has(ext)) return "audio";
  return null;
}

/** The lower-cased file extension of a path-like string (query/hash already stripped), or null. */
function extensionOf(pathLike: string): string | null {
  const m = pathLike.toLowerCase().match(EXT_RE);
  return m ? m[1] : null;
}

/**
 * Classify a URL as renderable media (rendered behind a reveal cover), or null for a plain link:
 *   - http(s): mapped by its file extension (image/video/audio sets); no or unknown extension → null
 *     (a generic link stays a link).
 *   - ipfs://: mapped by extension too, so `ipfs://<cid>/clip.mp4` → "video"; a bare CID with NO
 *     extension is assumed to be an image (a wrong guess degrades to the broken-media fallback, never
 *     an auto-fetch, because the cover gates the load).
 * Query string and hash fragment are ignored when reading the extension. A non-http/ipfs scheme
 * (ftp:/mailto:/javascript:/data:) is never media.
 */
export function classifyMedia(url: string): MediaKind | null {
  const path = url.split(/[?#]/, 1)[0];
  if (/^ipfs:\/\//i.test(path)) {
    // Require a non-empty CID (`ipfs://` / `ipfs://ipfs/` alone is not media).
    const cid = path.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "");
    if (!cid) return null;
    const ext = extensionOf(path);
    return ext === null ? "image" : kindForExt(ext);
  }
  if (/^https?:\/\//i.test(path)) {
    const ext = extensionOf(path);
    return ext === null ? null : kindForExt(ext);
  }
  return null;
}

/** True when `url` should be rendered as an image. A thin wrapper over {@link classifyMedia} kept so
 *  the profile/avatar image paths and tests read naturally. */
export function isImageUrl(url: string): boolean {
  return classifyMedia(url) === "image";
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

/** Media-type-agnostic alias of {@link resolveImageSrc} (ipfs:// → gateway, http(s) passthrough) — the
 *  renderer resolves image, video, and audio srcs through the same normaliser + gateway-root guard. */
export const resolveMediaSrc = resolveImageSrc;

// URL tokenizer shared with the post renderer (PostBody.segment) and the composer's image-link chip, so
// the two never drift on which links count as images. Match http(s) AND ipfs:// URLs, stopping the run
// at whitespace; trailing sentence punctuation is trimmed so a URL at the end of a sentence
// ("see https://x.org.") doesn't swallow the period.
export const URL_RE = /(?:https?|ipfs):\/\/[^\s]+/gi;
export const TRAILING_PUNCT = /[.,!?:;)\]}'"»”’]+$/;

/** How many URLs in `text` render as images (same classification the renderer applies). Used by the
 *  composer to show the "N image links — shown when opened" chip without re-deriving the URL scan. */
export function countImageUrls(text: string): number {
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (isImageUrl(m[0].replace(TRAILING_PUNCT, ""))) n += 1;
  }
  return n;
}

/** How many URLs in `text` render as media of ANY kind (image/video/audio) — the same classification
 *  the renderer applies. Used by the composer's "N media links — shown when opened" chip. */
export function countMediaUrls(text: string): number {
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (classifyMedia(m[0].replace(TRAILING_PUNCT, "")) !== null) n += 1;
  }
  return n;
}
