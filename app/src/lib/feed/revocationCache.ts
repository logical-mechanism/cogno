// A per-author memo for the seam's one remaining uncached per-author read.
//
// `flagRevocations` stamps `authorRevoked` onto every post in a page by reading `CognoGate.PkhOf` once
// per DISTINCT AUTHOR — which sounds bounded, and is, per page. The problem is that a page is not the
// unit of work: /post re-reads its thread on EVERY block, so a five-participant thread left open
// sustained five `PkhOf` reads every ~6 seconds, forever, for an answer that is a committee-gated
// tombstone and effectively never moves. `lib/feed/constants.ts` opens by saying a node-served page
// "comes back in ONE state_call (no ~5-reads-per-post fan-out)"; this was the fan-out that survived,
// while the four sibling per-author facts (reputation, weight, profile, nested quote) all go through
// `createChainCache`.
//
// It cannot literally use `createChainCache`: that is a React provider read through a hook, and this
// runs inside `createPapiFeedSource`, a plain data-layer function. So this is the same idea at the
// seam's own layer — one read per author, shared by every page, thread re-read and profile read that
// asks for it.
//
// WHY A TTL AT ALL, when the sibling caches are session-lived. A revocation is the one per-author fact
// with a suppression consequence: it dims the author and shows a "restricted" chip. Caching "not
// revoked" for a whole session would leave a freshly-revoked account rendering normally until the tab
// is reloaded. Five minutes turns one-read-per-participant-per-block into one-per-participant-per-five-
// minutes and still converges on its own.

/** How long an answer is reused. Long against a 6s block, short against a session. */
export const REVOCATION_TTL_MS = 5 * 60 * 1000;

/**
 * Entry count at which a miss also SWEEPS the expired entries.
 *
 * The TTL alone bounds staleness, not size: an expired entry is only ever replaced when that same author
 * is asked for again, so a reader scrolling the firehose past thousands of distinct authors retained one
 * `{at, Promise}` per author for the life of the WebSocket session (`createRevocationCache` is called
 * once per `createPapiFeedSource`, which `useFeedSource` memoizes on `api`) — none of which would be read
 * again. Sweeping on a miss keeps the map at roughly the authors actually seen within one TTL, which is
 * the working set the "one read per author" argument is about.
 */
export const SWEEP_AT = 512;

export interface RevocationCache {
  /** The cached answer for `account`, reading through on a miss or an expired entry. */
  get: (account: string) => Promise<boolean>;
  /** Entries currently held. Exported so the size bound is assertable, like the injected clock. */
  size: () => number;
}

/**
 * @param read the underlying single-account read (`isRevoked`).
 * @param ttlMs how long an answer is reused.
 * @param now injectable clock, for the test.
 */
export function createRevocationCache(
  read: (account: string) => Promise<boolean>,
  ttlMs: number = REVOCATION_TTL_MS,
  now: () => number = Date.now,
): RevocationCache {
  const entries = new Map<string, { at: number; value: Promise<boolean> }>();

  function get(account: string): Promise<boolean> {
    const hit = entries.get(account);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    // A miss is about to add an entry, so it is the right moment to drop the ones that can no longer be
    // served. Deleting during a Map iteration is well-defined; entries added after this point are not
    // visited. Only past SWEEP_AT, so the common small-feed case stays a plain get/set.
    if (entries.size >= SWEEP_AT) {
      const cutoff = now() - ttlMs;
      for (const [k, v] of entries) if (v.at <= cutoff) entries.delete(k);
    }
    // The PROMISE is cached, not the resolved value, so several posts by the same author inside one
    // page — or two surfaces asking in the same tick — share one in-flight read rather than racing.
    const value = read(account).catch((e: unknown) => {
      // A failed read must not stick: it would pin every post by that author to a guessed answer for
      // the whole TTL. Drop it so the next asker tries again, and let the caller see the rejection
      // exactly as it did before this cache existed.
      if (entries.get(account)?.value === value) entries.delete(account);
      throw e;
    });
    entries.set(account, { at: now(), value });
    return value;
  }

  return { get, size: () => entries.size };
}
