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

/** A compact reference to the quoted post, resolved from another decoded post (carries its name/avatar). */
function quoteRefOf(quoted: CognoPost) {
  return {
    id: quoted.id,
    author: quoted.author,
    text: quoted.text,
    authorRevoked: quoted.authorRevoked === true,
    displayName: quoted.authorDisplayName,
    avatar: quoted.authorAvatar,
  };
}

/** A single `Profile.Profiles` entry (display name / bio / avatar are BoundedVec<u8> → Binary). */
interface RawProfileEntry {
  args: [string];
  value: {
    display_name: { asText: () => string };
    bio: { asText: () => string };
    avatar: { asText: () => string };
  };
}

/** Decode a Binary profile field to a trimmed string, or undefined when empty/absent. */
function binTextOpt(v?: { asText: () => string }): string | undefined {
  const s = v?.asText().trim();
  return s ? s : undefined;
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
  // Watch Posts + Polls + Profiles together so each emission can flag poll-posts, stamp author
  // display name/avatar, and resolve quote refs — all from the same authoritative snapshot, with no
  // per-post round-trips. (Profiles regenerate the feed when a name/avatar changes, too.)
  const posts$ = api.query.Microblog.Posts.watchEntries();
  const polls$ = api.query.Microblog.Polls.watchEntries().pipe(
    startWith({ entries: [] as { args: [bigint] }[] }),
  );
  const profiles$ = api.query.Profile.Profiles.watchEntries().pipe(
    startWith({ entries: [] as RawProfileEntry[] }),
  );
  return combineLatest([posts$, polls$, profiles$]).pipe(
    map(([pev, qev, prev]): FeedSnapshot => {
      const entries = pev.entries as unknown as RawPostEntry[];
      const pollIds = new Set(
        (qev.entries as unknown as { args: [bigint] }[]).map((e) => e.args[0]),
      );
      const profileByAuthor = new Map<string, { displayName?: string; avatar?: string }>();
      for (const e of prev.entries as unknown as RawProfileEntry[]) {
        profileByAuthor.set(e.args[0], {
          displayName: binTextOpt(e.value.display_name),
          avatar: binTextOpt(e.value.avatar),
        });
      }
      const posts = entries.map(toCognoPost);
      const byId = new Map(posts.map((p) => [p.id, p] as const));
      // Pass 1: poll flag + author display name/avatar.
      posts.forEach((p) => {
        if (pollIds.has(p.id)) p.isPoll = true;
        const prof = profileByAuthor.get(p.author);
        if (prof) {
          p.authorDisplayName = prof.displayName;
          p.authorAvatar = prof.avatar;
        }
      });
      // Pass 2: quote refs (authors already stamped above, so the embed shows their name/avatar too).
      posts.forEach((p, i) => {
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

  // A post is a poll iff a Polls[id] entry exists; resolve a quoted post (one level) for the embed;
  // stamp the author's display name/avatar so the detail header shows the real name, not just a handle.
  const [pollRec, quoted, prof] = await Promise.all([
    api.query.Microblog.Polls.getValue(id),
    value.quote != null
      ? api.query.Microblog.Posts.getValue(BigInt(value.quote))
      : Promise.resolve(undefined),
    api.query.Profile.Profiles.getValue(post.author),
  ]);
  if (pollRec) post.isPoll = true;
  if (prof) {
    const p = prof as unknown as RawProfileEntry["value"];
    post.authorDisplayName = binTextOpt(p.display_name);
    post.authorAvatar = binTextOpt(p.avatar);
  }
  if (value.quote != null) {
    post.quote = quoted
      ? quoteRefOf(toCognoPost({ args: [BigInt(value.quote)], value: quoted as unknown as RawPostEntry["value"] }))
      : { id: BigInt(value.quote), author: "" as Ss58, text: "", authorRevoked: false };
  }
  return post;
}
