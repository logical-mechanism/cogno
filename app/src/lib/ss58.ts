// lib/ss58 — ss58 helpers (no React, no network).
//
// There are NO unique @handles on cogno-chain (D6); the "handle" is the account's ss58 address,
// truncated. These helpers are the single source of that truncation + a cheap plausibility check
// used by the static-export dynamic routes (/u/[address]) before they render a profile.

import { ss58Decode, ss58Encode } from "@polkadot-labs/hdkd-helpers";
import { toHex } from "@polkadot-api/utils";

/** The cogno-chain ss58 prefix (42 — the generic-substrate value the chain + signer use). */
const CHAIN_SS58_PREFIX = 42;

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

/**
 * If `value` is a checksum-valid ss58 AccountId32, return it re-encoded to the chain's canonical
 * prefix (42, so any-prefix input normalises to how the app keys accounts); otherwise null.
 *
 * The STRICT gate (a full blake2b-checksummed 32-byte AccountId has ~zero false positives) behind
 * both {@link profileRouteForQuery} and @mention linkification (`lib/mentions`): a bare `@<ss58>` in a
 * post body can be turned into a real mention link with confidence, and anything that isn't a genuine
 * address is rejected rather than mis-linked.
 */
export function normalizeSs58(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Cheap reject before the checksum decode (ss58Decode throws on malformed input).
  if (!isPlausibleSs58(trimmed)) return null;
  try {
    const [payload] = ss58Decode(trimmed);
    // Only an AccountId32 addresses a profile / a person; reject other key lengths (e.g. an ecdsa 33-byte key).
    if (payload.length !== 32) return null;
    return ss58Encode(toHex(payload), CHAIN_SS58_PREFIX);
  } catch {
    return null;
  }
}

/**
 * If `value` is a checksum-valid ss58 account address (a 32-byte AccountId32), return the canonical
 * profile route for it (`/u/<addr>/`, re-encoded to the chain prefix so it matches how the app keys
 * accounts). Otherwise null.
 *
 * This is what lets the search box double as a "jump to account" affordance: users can click-to-copy
 * an account's ss58 address anywhere in the app, and pasting it into search lands on that profile —
 * the node-served body/display-name substring search never matches a raw address, so without this a
 * pasted address is a dead end. The strict checksum decode (not the loose isPlausibleSs58 regex) means
 * only a genuinely complete, valid address ever redirects; anything else falls through to text search.
 */
export function profileRouteForQuery(value: string | null | undefined): string | null {
  const addr = normalizeSs58(value);
  return addr ? `/u/${addr}/` : null;
}
