// poll-voters — the PAGED voter roster, read straight off the `PollVotes` storage prefix.
//
// WHY THIS IS NOT `getEntries`. The roster used to call `PollVotes.getEntries(hostId)`, which pulls the
// ENTIRE prefix over the wire and then throws away all but the first 200 client-side. A `PollVotes` key is
// 104 bytes (two `Blake2_128Concat` hashers), and `state_queryStorageAt` echoes the key back with every
// value, so each voter costs about 0.42 KB round trip:
//
//     200 voters  ~0.08 MB        1,000 voters  ~0.41 MB
//  10,000 voters  ~4.1 MB       100,000 voters  ~41 MB      (all of it, to render 200)
//
// The relay caps requests at 8 MB and responses at 10 MB, so at scale that stops being slow and starts
// being a failed read. Worse, the 200 that survived were sorted by ss58 — an alphabetical sample wearing
// a roster's clothes. Paging fetches only what is on screen: ~21 KB for a 50-row page, at any poll size.
//
// WHY NOT A RUNTIME API. Everything else in this app pages node-side through `MicroblogApi` because it
// needs the node to FILTER and ENRICH (moderation, author profiles, live weights). A roster does none of
// that — it is a flat prefix walk with no per-row work — so it needs no runtime support, and adding some
// would mean a spec bump and an upgrade to serve a read the node already answers. If the roster ever
// needs per-voter WEIGHT (which no read exposes today), that is the point to revisit.
//
// THE PREFIX IS THE DANGEROUS PART. A wrong prefix does not error: `state_getKeysPaged` returns an empty
// array, which is indistinguishable from "nobody voted". That is the same shape as the `#[storage_alias]`
// trap in CLAUDE.md, where a migration read a prefix nothing had written and reported success over zero
// rows. So `pollVotesPrefix` is pinned by tests against known-good bytes, and was verified against the
// live chain before anything was built on it: poll 29 -> its 2 voters, poll 41 -> its 1, poll 7 -> its 3,
// each with the option `PollVotes` holds.

import { Twox128, Blake2128Concat } from "@polkadot-api/substrate-bindings";
import { ss58Encode } from "@polkadot-labs/hdkd-helpers";
import type { Ss58 } from "@/lib/types";
import type { PollVoter } from "@/lib/chain/social-reads";

/** The cogno-chain ss58 prefix (42), mirroring lib/ss58.ts. */
const CHAIN_SS58_PREFIX = 42;

/** Rows per page. Big enough that scrolling rarely waits, small enough that a page is ~21 KB. */
export const POLL_VOTERS_PAGE = 50;

/** The minimal RPC seam this needs, so the read is unit-testable without a live client. */
export type RawRequest = <T>(method: string, params: unknown[]) => Promise<T>;

const textEncoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = "0x";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * SCALE encodes a `u64` LITTLE-endian, and getting this backwards is the silent failure this module
 * exists to avoid: a big-endian host id hashes to a prefix nothing ever wrote, so every poll reads as
 * having no voters and nothing anywhere reports a problem.
 */
function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

/**
 * The storage prefix for one poll's votes: `twox128("Microblog") ++ twox128("PollVotes") ++
 * blake2_128concat(hostId)`.
 *
 * `Blake2_128Concat` is a TRANSPARENT hasher (16-byte hash followed by the raw key), which is what makes
 * this whole approach work: the account is recoverable from the key, so a page of keys already names its
 * voters before any value is fetched.
 */
export function pollVotesPrefix(hostId: bigint): string {
  const pallet = Twox128(textEncoder.encode("Microblog"));
  const item = Twox128(textEncoder.encode("PollVotes"));
  const key = Blake2128Concat(u64le(hostId));
  const out = new Uint8Array(pallet.length + item.length + key.length);
  out.set(pallet, 0);
  out.set(item, pallet.length);
  out.set(key, pallet.length + item.length);
  return toHex(out);
}

/**
 * The voter an entry key names. The account is the trailing 32 bytes — everything before it is pallet
 * prefix, item prefix, the hashed host id, and this account's own 16-byte hash.
 */
export function voterFromKey(key: string): Ss58 | null {
  const raw = key.startsWith("0x") ? key.slice(2) : key;
  if (raw.length < 64) return null;
  try {
    return ss58Encode(`0x${raw.slice(-64)}`, CHAIN_SS58_PREFIX) as Ss58;
  } catch {
    return null; // a malformed key is skipped, never rendered as a bogus address
  }
}

export interface PollVoterPage {
  voters: PollVoter[];
  /**
   * The storage key to resume after, or null at the end of the prefix.
   *
   * `state_getKeysPaged`'s start key is EXCLUSIVE (verified against the live chain), so this is simply
   * the last key of this page and the next call resumes cleanly with no overlap and no gap.
   */
  nextCursor: string | null;
}

/**
 * One page of a poll's voters, in storage (hash) order.
 *
 * Order is arbitrary but STABLE, which is what paging needs: appending page 2 under page 1 never
 * reshuffles page 1. It is deliberately not "meaningful" order — there is no per-voter weight read and
 * no per-vote block height on chain, so no ranking exists to sort by. A surface must not imply one.
 *
 * Never throws: any failure yields an empty page and a null cursor, which the caller renders as "no more"
 * rather than a broken list.
 */
export async function readPollVotersPage(
  request: RawRequest,
  hostId: bigint,
  opts: { after?: string | null; limit?: number } = {},
): Promise<PollVoterPage> {
  const limit = opts.limit ?? POLL_VOTERS_PAGE;
  const prefix = pollVotesPrefix(hostId);
  try {
    const keys = await request<string[]>("state_getKeysPaged", [prefix, limit, opts.after ?? null]);
    if (!Array.isArray(keys) || keys.length === 0) return { voters: [], nextCursor: null };

    const at = await request<{ changes: [string, string | null][] }[]>("state_queryStorageAt", [keys]);
    // Mapped BY KEY, never by position: `state_queryStorageAt` gives no ordering guarantee, and pairing
    // by index would silently attach each voter to somebody else's choice — a wrong answer that looks
    // completely normal.
    const byKey = new Map<string, string | null>(at?.[0]?.changes ?? []);

    const voters: PollVoter[] = [];
    for (const key of keys) {
      const who = voterFromKey(key);
      const value = byKey.get(key);
      // `PollVoteRecord { option: u8 }` is a single SCALE byte. A null value means the vote was removed
      // between the two calls; skip it rather than invent option 0.
      if (who == null || value == null) continue;
      const option = parseInt(value.slice(2, 4), 16);
      if (Number.isNaN(option)) continue;
      voters.push({ who, option });
    }
    // A SHORT page means the prefix is exhausted. Testing `keys.length` (not `voters.length`) is what
    // keeps that true when a row is dropped above: a page whose entries were all skipped still has more
    // keys behind it, and reporting "no more" there would silently truncate the roster.
    const nextCursor = keys.length < limit ? null : keys[keys.length - 1];
    return { voters, nextCursor };
  } catch {
    return { voters: [], nextCursor: null };
  }
}
