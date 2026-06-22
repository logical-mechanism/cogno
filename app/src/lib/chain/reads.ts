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
  Ss58,
} from "@/lib/types";

/** A single live entry from `Posts.watchEntries()`: storage key + decoded value. */
interface RawPostEntry {
  args: [bigint];
  value: {
    author: string;
    text: { asText: () => string };
    parent?: bigint;
    /** Quoted post id (`Post.quote: Option<u64>`, storage v1); undefined for plain posts/replies. */
    quote?: bigint;
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

/** A compact reference to the quoted post, resolved from another decoded post. */
function quoteRefOf(quoted: CognoPost) {
  return {
    id: quoted.id,
    author: quoted.author,
    text: quoted.text,
    authorRevoked: quoted.authorRevoked === true,
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
  // Also watch Polls so we can flag poll-posts (a post is a poll iff a Polls[id] entry exists) and
  // resolve quote refs — both from the same authoritative snapshot, no per-post round-trips.
  const posts$ = api.query.Microblog.Posts.watchEntries();
  const polls$ = api.query.Microblog.Polls.watchEntries().pipe(
    startWith({ entries: [] as { args: [bigint] }[] }),
  );
  return combineLatest([posts$, polls$]).pipe(
    map(([pev, qev]): FeedSnapshot => {
      const entries = pev.entries as unknown as RawPostEntry[];
      const pollIds = new Set(
        (qev.entries as unknown as { args: [bigint] }[]).map((e) => e.args[0]),
      );
      const posts = entries.map(toCognoPost);
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      // Decorate each post with its poll flag + resolved quote ref (from the snapshot itself).
      posts.forEach((p, i) => {
        if (pollIds.has(p.id)) p.isPoll = true;
        const qid = entries[i].value.quote;
        if (qid != null) {
          const q = byId.get(BigInt(qid));
          p.quote = q
            ? quoteRefOf(q)
            : { id: BigInt(qid), author: "" as Ss58, text: "", authorRevoked: false };
        }
      });
      posts.sort(byIdDesc);
      return { posts, asOf: pev.block?.number ?? null };
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
  const raw = await api.query.Microblog.Posts.getValue(id);
  if (!raw) return undefined;
  const value = raw as unknown as RawPostEntry["value"];
  const post = toCognoPost({ args: [id], value });

  // A post is a poll iff a Polls[id] entry exists; resolve a quoted post (one level) for the embed.
  const [pollRec, quoted] = await Promise.all([
    api.query.Microblog.Polls.getValue(id),
    value.quote != null
      ? api.query.Microblog.Posts.getValue(BigInt(value.quote))
      : Promise.resolve(undefined),
  ]);
  if (pollRec) post.isPoll = true;
  if (value.quote != null) {
    post.quote = quoted
      ? quoteRefOf(toCognoPost({ args: [BigInt(value.quote)], value: quoted as unknown as RawPostEntry["value"] }))
      : { id: BigInt(value.quote), author: "" as Ss58, text: "", authorRevoked: false };
  }
  return post;
}
