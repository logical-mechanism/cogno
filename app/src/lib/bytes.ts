// bytes — the UTF-8 byte measure every bounded text field is gated on (D1).
//
// The chain bounds text in BYTES, not characters: a post body is `BoundedVec<u8, MaxLength = 512>`,
// and a BoundedVec accepts `len == bound`. A draft sitting EXACTLY on the cap is therefore a legal,
// postable value — so `over` is strictly-greater, and the composer's CTA stays live at 512/512.
// (It was `>=`, which greyed the Post button on the very last byte the textarea let you type:
// `clampToBytes` fills up to the cap INCLUSIVE, so every clamped paste landed in the dead zone.)
//
// Pure + node-safe: this is the half of the ByteCounter the unit tests can reach.

/** The byte measurement a ByteCounter reports up to its Composer (UTF-8 bytes, never `.length`). */
export interface ByteMeasure {
  bytes: number;
  remaining: number;
  /** STRICTLY over the cap → the write is illegal. Exactly at the cap is legal (see above). */
  over: boolean;
}

const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

/** UTF-8 byte length of a string — the canonical D1 measure. */
export function utf8Bytes(s: string): number {
  if (encoder) return encoder.encode(s).length;
  // SSR/edge fallback (no TextEncoder): approximate via encodeURIComponent.
  return unescape(encodeURIComponent(s)).length;
}

/**
 * Clamp a string to at most `maxBytes` UTF-8 bytes WITHOUT splitting a multibyte code point (D1).
 * Walks code points (for..of iterates by code point, not UTF-16 unit) and accumulates bytes. The cap
 * is INCLUSIVE — a clamped string may measure exactly `maxBytes`, and `measureBytes` must accept it.
 */
export function clampToBytes(s: string, maxBytes: number): string {
  let total = 0;
  let out = "";
  for (const ch of s) {
    const b = utf8Bytes(ch);
    if (total + b > maxBytes) break;
    total += b;
    out += ch;
  }
  return out;
}

/** Measure `value` against `maxBytes`. The single source of truth the ring shows AND the CTA gates on. */
export function measureBytes(value: string, maxBytes: number): ByteMeasure {
  const bytes = utf8Bytes(value);
  return { bytes, remaining: maxBytes - bytes, over: bytes > maxBytes };
}
