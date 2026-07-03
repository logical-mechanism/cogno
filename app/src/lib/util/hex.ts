// lib/util/hex — tiny, dependency-free hex helpers shared across the chain read/write and feed code.
// Kept standalone (not exported from a heavier module) so importing it never drags in write-side deps.

/** Decode a hex string (with or without a leading `0x`) to bytes. Assumes even, valid hex. */
export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
