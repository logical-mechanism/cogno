// Live reads: the feed, the head positions (best vs finalized), a thread index, and a
// single-post fetch. All read paths are keyless — reading the Civic Ledger never needs a key.
//
// `watchFeed` rebuilds the WHOLE feed from `watchEntries().entries` on every emission:
// `entries` is the authoritative full current set; `deltas` can be null and is NOT trusted
// for correctness. Sorted newest-first by post id.

import type { PolkadotClient } from "polkadot-api";
import { Observable, combineLatest, map, startWith } from "rxjs";
import type {
  CognoApi,
  CognoPost,
  FeedSnapshot,
  ChainHeads,
  BlockRef,
  AnchorCheckpoint,
} from "@/lib/types";

/** A single live entry from `Posts.watchEntries()`: storage key + decoded value. */
interface RawPostEntry {
  args: [bigint];
  value: {
    author: string;
    text: { asText: () => string };
    parent?: bigint;
    at: number;
  };
}

/** Decode one raw storage entry into the shared CognoPost shape (text → UTF-8). */
function toCognoPost(entry: RawPostEntry): CognoPost {
  return {
    id: entry.args[0],
    author: entry.value.author,
    text: entry.value.text.asText(),
    parent: entry.value.parent,
    at: entry.value.at,
  };
}

/** Newest-first by id (bigint-safe comparator). */
function byIdDesc(a: CognoPost, b: CognoPost): number {
  if (a.id < b.id) return 1;
  if (a.id > b.id) return -1;
  return 0;
}

/**
 * The live feed: every `watchEntries` emission rebuilds the full post set (entries is
 * authoritative), decodes each post, and sorts newest-first. `asOf` is the block the
 * snapshot reflects.
 */
export function watchFeed(api: CognoApi): Observable<FeedSnapshot> {
  return api.query.Microblog.Posts.watchEntries().pipe(
    map((ev): FeedSnapshot => {
      const entries = ev.entries as unknown as RawPostEntry[];
      const posts = entries.map(toCognoPost).sort(byIdDesc);
      return { posts, asOf: ev.block?.number ?? null };
    }),
  );
}

/** Project a PAPI BlockInfo into the minimal BlockRef the UI labels with. */
function toBlockRef(info: { number: number; hash: string } | null): BlockRef | null {
  return info ? { number: info.number, hash: info.hash } : null;
}

/**
 * Live head positions for honest best-vs-finalized labeling. Combines the best-block tip
 * (`bestBlocks$[0]`) with the latest finalized block. `startWith(null)` on each stream lets
 * the combined observable emit as soon as either head is known, instead of waiting for both.
 */
export function watchHeads(client: PolkadotClient): Observable<ChainHeads> {
  const best$ = client.bestBlocks$.pipe(
    map((blocks) => (blocks.length > 0 ? blocks[0] : null)),
    startWith(null),
  );
  const finalized$ = client.finalizedBlock$.pipe(startWith(null));

  return combineLatest([best$, finalized$]).pipe(
    map(([best, finalized]): ChainHeads => ({
      best: toBlockRef(best),
      finalized: toBlockRef(finalized),
    })),
  );
}

/** The raw `Anchor.LastCheckpoint` value as PAPI decodes it (snake_case struct fields). */
interface RawCheckpoint {
  block_number: number;
  finalized_root: { asHex: () => string };
  cardano_txhash: { asHex: () => string };
  post_count: bigint;
  timestamp: bigint;
}

/**
 * The live Cardano anchor checkpoint (`Anchor.LastCheckpoint`, M3 Tier-A). Emits `null` until the
 * relayer has anchored at least once, then the latest checkpoint on every change. Watched at the
 * best head so the UI updates the moment `anchor_ack` lands (it is a record, not consensus state).
 */
export function watchAnchor(api: CognoApi): Observable<AnchorCheckpoint | null> {
  return api.query.Anchor.LastCheckpoint.watchValue("best").pipe(
    map((cp): AnchorCheckpoint | null => {
      if (!cp) return null;
      const c = cp as unknown as RawCheckpoint;
      return {
        blockNumber: c.block_number,
        finalizedRoot: c.finalized_root.asHex(),
        cardanoTxHash: c.cardano_txhash.asHex(),
        postCount: c.post_count,
        timestamp: c.timestamp,
      };
    }),
  );
}

/** Key under which top-level posts (no parent) are grouped in the thread index. */
export const THREAD_ROOT_KEY = "root";

/**
 * Group posts into a parent → children index. Top-level posts (no `parent`) live under
 * {@link THREAD_ROOT_KEY}; replies live under `String(parentId)`. A post whose parent id is
 * not present in the set (dangling / the parent was deleted/tombstoned) is STILL grouped by
 * its parent key — it is never dropped — so the UI can render it under a "missing parent"
 * affordance and the conversation never silently loses a node.
 */
export function buildThreadIndex(posts: CognoPost[]): Map<string, CognoPost[]> {
  const index = new Map<string, CognoPost[]>();
  for (const post of posts) {
    const key =
      post.parent === undefined ? THREAD_ROOT_KEY : String(post.parent);
    const bucket = index.get(key);
    if (bucket) {
      bucket.push(post);
    } else {
      index.set(key, [post]);
    }
  }
  return index;
}

/** Fetch a single post by id, or undefined if it does not exist / was deleted. */
export async function getPost(
  api: CognoApi,
  id: bigint,
): Promise<CognoPost | undefined> {
  const value = await api.query.Microblog.Posts.getValue(id);
  if (!value) return undefined;
  return toCognoPost({ args: [id], value: value as unknown as RawPostEntry["value"] });
}
