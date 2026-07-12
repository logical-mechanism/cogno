// Live + paged chain reads: id-paged feed pages, keyed thread reconstruction, the head positions
// (best vs finalized), and a single-post fetch. All read paths are keyless — reading the Civic
// Ledger never needs a key.
//
// SCALING POSTURE (spec 119): the feed NEVER pulls the full `Posts` set. Posts have a sequential
// `NextPostId` counter, so the global/author feeds PAGE by id with keyed `Posts.getValue(id)` reads
// (O(page) memory + transfer), and threads read ONE parent's children via the `RepliesByParent`
// reverse map (keyed `getEntries(parent)`) + the `ReplyCount` aggregate — never a full-snapshot scan.
// Liveness rides `NextPostId.watchValue` (a new post bumps the counter), NOT `Posts.watchEntries()`.

import { Binary, type PolkadotClient } from "polkadot-api";
import { Observable, combineLatest, distinctUntilChanged, map, startWith } from "rxjs";
import { readPostTally } from "./social-reads";
import type {
  CognoApi,
  CognoPost,
  ChainHeads,
  BlockRef,
  Ss58,
} from "@/lib/types";

/** A single decoded `Posts` storage value (PAPI v2 shape; `text` is a `Vec<u8>` → `Uint8Array`). */
interface RawPostValue {
  author: string;
  text: Uint8Array;
  parent?: bigint;
  /** Quoted post id (`Post.quote: Option<u64>`, storage v1); undefined for plain posts/replies. */
  quote?: bigint;
  at: number;
}

/** A decoded post value paired with its storage-key id (the unit `enrichPosts` consumes). */
interface RawPostWithId {
  id: bigint;
  value: RawPostValue;
}

/** Decode one raw storage value into the shared CognoPost shape (text → UTF-8). */
function toCognoPost(id: bigint, value: RawPostValue): CognoPost {
  return {
    id,
    author: value.author,
    text: Binary.toText(value.text),
    parent: value.parent,
    at: value.at,
  };
}

/** A compact reference to the quoted post, resolved from another decoded post (carries its name/avatar). */
function quoteRefOf(
  quoted: CognoPost,
  prof: { displayName?: string; avatar?: string } | undefined,
) {
  return {
    id: quoted.id,
    author: quoted.author,
    text: quoted.text,
    authorRevoked: quoted.authorRevoked === true,
    displayName: prof?.displayName,
    avatar: prof?.avatar,
  };
}

/** A single `Profile.Profiles` value (display name / bio / avatar are BoundedVec<u8> → Uint8Array). */
interface RawProfile {
  display_name: Uint8Array;
  bio: Uint8Array;
  avatar: Uint8Array;
}

/** Decode a `Vec<u8>` profile field (PAPI v2 Uint8Array) to a trimmed UTF-8 string, or undefined when empty/absent. */
export function binTextOpt(v?: Uint8Array): string | undefined {
  const s = v != null ? Binary.toText(v).trim() : undefined;
  return s ? s : undefined;
}

// ── liveness + the id cursor ────────────────────────────────────────────────────────────────────

/**
 * The id of the latest post, or null when the chain has none. `NextPostId` is the id that WILL be
 * assigned next (`post_message` reads it, then `put(id + 1)`), so the newest existing id is
 * `NextPostId - 1`. This is the cursor the global feed pages down from.
 */
export async function latestPostId(api: CognoApi): Promise<bigint | null> {
  const next = (await api.query.Microblog.NextPostId.getValue()) as unknown as bigint;
  const n = BigInt(next ?? 0n);
  return n > 0n ? n - 1n : null;
}

/**
 * Live head-id stream: emits the newest post id on every `NextPostId` change at the best head. A new
 * post bumps the counter, so this is the liveness signal that drives the "N new posts" pill / prepend
 * WITHOUT a full `watchEntries`. Emits null while the chain has no posts.
 */
export function watchLatestPostId(api: CognoApi): Observable<bigint | null> {
  return api.query.Microblog.NextPostId.watchValue({ at: "best" }).pipe(
    map(({ value: next }): bigint | null => {
      const n = BigInt((next ?? 0n) as bigint);
      return n > 0n ? n - 1n : null;
    }),
    // PAPI v2 watchValue emits every poll (not only on change); dedupe so a new post — not every
    // block — drives the "N new posts" prepend / feed re-page (preserves the v1 emit-on-change semantics).
    distinctUntilChanged(),
  );
}

/**
 * The id of the post that `id` itself quotes, or null when `id` doesn't quote / doesn't exist. The
 * node feed API's one-level `quoted` summary drops this field, so the FE can't tell a quote-of-a-quote
 * apart from a plain quote without this extra keyed read (`useNestedQuote` batches + caches it, keyed by
 * id, once per session). Read at BEST, not the finalized default: a freshly-posted quote is visible in
 * the feed (best-head) before it finalizes, and `useNestedQuote` commits the id after one read, so a
 * finalized-lag `null` would wrongly, permanently suppress the pill for that embed this session.
 */
export async function readPostQuoteId(api: CognoApi, id: bigint): Promise<bigint | null> {
  const v = (await api.query.Microblog.Posts.getValue(id, { at: "best" })) as unknown as
    | RawPostValue
    | undefined;
  return v?.quote != null ? BigInt(v.quote) : null;
}

// ── per-post enrichment (batched, page-bounded) ──────────────────────────────────────────────────

/**
 * Stamp the social aggregates + author profile + quote ref onto a batch of decoded posts, reading
 * each aggregate by KEY (never iterating a whole map). Profiles + quoted posts are de-duped across
 * the page (one read per distinct author / quoted id); the per-post aggregates (VoteTally,
 * ReplyCount, Polls flag) are read per id. Revocation is NOT stamped here — the PAPI
 * source flags it once per distinct author via `CognoGate.PkhOf`.
 */
export async function enrichPosts(
  api: CognoApi,
  raw: RawPostWithId[],
): Promise<CognoPost[]> {
  if (raw.length === 0) return [];

  // Resolve quoted posts (one level) so a quote embed carries the quoted author's name/avatar.
  const quotedIds = Array.from(
    new Set(raw.filter((r) => r.value.quote != null).map((r) => BigInt(r.value.quote!))),
  );
  const quotedById = new Map<bigint, CognoPost>();
  await Promise.all(
    quotedIds.map(async (qid) => {
      const v = (await api.query.Microblog.Posts.getValue(qid)) as unknown as
        | RawPostValue
        | undefined;
      if (v) quotedById.set(qid, toCognoPost(qid, v));
    }),
  );

  // Distinct authors (page posts + quoted posts) → one Profile read each.
  const authors = new Set<string>();
  raw.forEach((r) => authors.add(r.value.author));
  quotedById.forEach((q) => authors.add(q.author));
  const profileByAuthor = new Map<string, { displayName?: string; avatar?: string }>();
  await Promise.all(
    Array.from(authors).map(async (a) => {
      const prof = (await api.query.Profile.Profiles.getValue(a)) as unknown as
        | RawProfile
        | undefined;
      if (prof) {
        profileByAuthor.set(a, {
          displayName: binTextOpt(prof.display_name),
          avatar: binTextOpt(prof.avatar),
        });
      }
    }),
  );

  // Per-post aggregates (keyed reads — never a map scan).
  return Promise.all(
    raw.map(async (r) => {
      const post = toCognoPost(r.id, r.value);
      // Reuse the single tally/repost decoders (social-reads.ts) so the feed score can never drift
      // from a per-post read; ReplyCount + the poll flag are read alongside.
      const [tally, replyCount, pollRec] = await Promise.all([
        readPostTally(api, r.id),
        api.query.Microblog.ReplyCount.getValue(r.id) as Promise<number>,
        api.query.Microblog.Polls.getValue(r.id),
      ]);
      post.upWeight = tally.upWeight;
      post.downWeight = tally.downWeight;
      post.upCount = tally.upCount;
      post.downCount = tally.downCount;
      post.score = tally.score;
      post.replyCount = Number(replyCount ?? 0);
      if (pollRec) post.isPoll = true;
      const prof = profileByAuthor.get(post.author);
      if (prof) {
        post.authorDisplayName = prof.displayName;
        post.authorAvatar = prof.avatar;
      }
      if (r.value.quote != null) {
        const q = quotedById.get(BigInt(r.value.quote));
        post.quote = q
          ? quoteRefOf(q, profileByAuthor.get(q.author))
          : { id: BigInt(r.value.quote), author: "" as Ss58, text: "", authorRevoked: false };
      }
      return post;
    }),
  );
}

/** One page of feed posts + the cursor (a post id) for the next, older page (null when exhausted). */
export interface IdPage {
  posts: CognoPost[];
  /** The highest id NOT yet returned — pass as `beforeId` for the next page. Null when at the end. */
  nextCursor: bigint | null;
}

/** The total number of posts an author has authored (the `ByAuthor` index length — one keyed read). */
export async function authorPostCount(api: CognoApi, account: Ss58): Promise<number> {
  const rawIds = (await api.query.Microblog.ByAuthor.getValue(account)) as unknown as
    | bigint[]
    | undefined;
  return (rawIds ?? []).length;
}

// ── thread reconstruction (keyed reverse lookup — no full-snapshot scan) ──────────────────────────

/** Max ancestors to walk up from a focal post (cycle/cost guard). */
const MAX_ANCESTOR_DEPTH = 64;

/** A reconstructed thread's raw parts: enriched focal + ancestor chain (top-down) + direct replies. */
export interface RawThread {
  root: CognoPost;
  ancestors: CognoPost[];
  replies: CognoPost[];
  replyCount: number;
}

/**
 * Reconstruct a thread by KEY: the focal post, its ancestor chain (walk `parent` up, depth/cycle
 * guarded), and its direct replies from the `RepliesByParent[focal]` reverse map (`getEntries` over
 * ONE parent's children) — never a full-`Posts` scan. `replyCount` is the keyed `ReplyCount[focal]`
 * aggregate. All parts are enriched (tallies/counts/profile/quote); each reply also carries its OWN
 * `replyCount` (stamped by `enrichPosts`) so the UI can offer an inline "Show replies" expander.
 */
export async function getThread(api: CognoApi, focalId: bigint): Promise<RawThread> {
  const focalVal = (await api.query.Microblog.Posts.getValue(focalId)) as unknown as
    | RawPostValue
    | undefined;
  if (!focalVal) throw new Error(`thread root #${focalId} not found on the node`);

  // Ancestor chain: walk `parent` up from the focal, guarding cycles + bounding depth. A dangling
  // parent (absent on the node) stops the walk. Collected deepest-first, returned top-down.
  const ancestorsRaw: RawPostWithId[] = [];
  const seen = new Set<bigint>([focalId]);
  let cursor = focalVal.parent;
  let depth = 0;
  while (cursor != null && !seen.has(cursor) && depth < MAX_ANCESTOR_DEPTH) {
    seen.add(cursor);
    depth++;
    const v = (await api.query.Microblog.Posts.getValue(cursor)) as unknown as
      | RawPostValue
      | undefined;
    if (!v) break;
    ancestorsRaw.push({ id: cursor, value: v });
    cursor = v.parent;
  }
  ancestorsRaw.reverse(); // top-down (conversation root first)

  // Direct replies: ONE parent's children via the reverse map, then read each value.
  const replyEntries = (await api.query.Microblog.RepliesByParent.getEntries(focalId)) as unknown as {
    keyArgs: unknown[];
  }[];
  const replyIds = replyEntries
    .map((e) => e.keyArgs[e.keyArgs.length - 1] as bigint)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // replies oldest-first
  const replyValues = await Promise.all(
    replyIds.map((id) => api.query.Microblog.Posts.getValue(id) as Promise<RawPostValue | undefined>),
  );
  const repliesRaw: RawPostWithId[] = replyIds
    .map((id, i) => ({ id, value: replyValues[i] }))
    .filter((r): r is RawPostWithId => r.value !== undefined);

  // Enrich the whole thread in one batched pass, then split back into its parts. `enrichPosts` already
  // stamps each post's keyed `ReplyCount`, so the focal's reply count comes off the enriched root — no
  // separate `ReplyCount.getValue(focalId)` read.
  const enriched = await enrichPosts(api, [
    { id: focalId, value: focalVal },
    ...ancestorsRaw,
    ...repliesRaw,
  ]);
  const root = enriched[0];
  const ancestors = enriched.slice(1, 1 + ancestorsRaw.length);
  const replies = enriched.slice(1 + ancestorsRaw.length);
  return { root, ancestors, replies, replyCount: root.replyCount ?? 0 };
}

// ── head positions (unchanged from the load-all era) ──────────────────────────────────────────────

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
