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
