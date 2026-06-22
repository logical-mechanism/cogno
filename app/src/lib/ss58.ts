// lib/ss58 — pure ss58 helpers (no React, no network).
//
// There are NO unique @handles on cogno-chain (D6); the "handle" is the account's ss58 address,
// truncated. These helpers are the single source of that truncation + a cheap plausibility check
// used by the static-export dynamic routes (/u/[address]) before they render a profile.

/** Truncate an ss58 address to a middle-ellipsis `5CBE…oFC`. Pure + stable. */
export function truncateSs58(
  address: string,
  opts: { head?: number; tail?: number } = {},
): string {
  const head = opts.head ?? 4;
  const tail = opts.tail ?? 4;
  if (!address) return "";
  // Already short enough → return as-is (the ellipsis would lengthen it).
  if (address.length <= head + tail + 1) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

/** The `@5CBE…oFC` handle string for a post/profile author. */
export function handleOf(address: string): string {
  return `@${truncateSs58(address)}`;
}

/**
 * The display-name fallback when an account has no Profile.display_name (D6): a short, stable
 * `cogno-<6 chars>` label derived from the address. Deterministic + offline.
 */
export function fallbackDisplayName(address: string): string {
  if (!address) return "cogno-anon";
  // Use a slice of the address itself so it is stable + readable; strip the prefix char.
  return `cogno-${address.slice(1, 7)}`;
}

// ss58 alphabet (base58, Bitcoin/Polkadot variant). Used only for a cheap plausibility gate on the
// dynamic /u/[address] route param — NOT a cryptographic checksum validation.
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

/**
 * Cheap plausibility check for an ss58 address arriving as a static-export route param. Returns true
 * for a base58 string of plausible length. This is intentionally loose (no checksum decode): the
 * route renders a not-found inline for obviously-bogus params; the chain read is the real validator.
 */
export function isPlausibleSs58(value: string | null | undefined): boolean {
  return typeof value === "string" && SS58_RE.test(value);
}
