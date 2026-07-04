// Node-served reads (spec-120): one enriched, viewer-aware feed / thread / profile page per
// `state_call`, via the `MicroblogApi` runtime API. This REPLACES the ~5-reads-per-post `enrichPosts`
// fan-out (reads.ts) AND the per-card `Reposts.getEntries` viewer-state scan (social-reads.ts) with a
// SINGLE call that returns everything a card renders — tallies, counts, the poll flag, the author
// profile snapshot, a one-level quote summary, and (when a `viewer` is passed) the viewer's own
// vote/repost overlay — atomic at one block.
//
// This is the PREFERRED path on a spec-120 node; the PAPI-direct source RUNTIME-DETECTS support
// (papi-source.ts `supportsNodeFeedApi`) and keeps the keyed `getGlobalFeedPage`/`getAuthorFeedPage`/
// `getThread` reads (reads.ts) as the fallback for pre-120 nodes. The two paths MUST agree: the
// mapping here mirrors `enrichPosts` exactly (same CognoPost shape; `score = upWeight - downWeight`,
// the SAME derivation as `readPostTally`/`toCognoPost`), proven by the parity test in reads.test.ts.

import { Binary } from "polkadot-api";
import { binTextOpt, type IdPage, type RawThread } from "./reads";
import type { CognoApi, CognoPost, Ss58, QuotedRef, ViewerPostState, Suggestion } from "@/lib/types";

const MAX_PAGE = 100;

/** PAPI v2's byte type as the API returns it: a `Vec<u8>` decodes to a `Uint8Array` (decode via `Binary.toText`). */
type BinaryLike = Uint8Array;

/** One `EnrichedPost` exactly as `api.apis.MicroblogApi.*` decodes it (snake_case; `text`/profile = Binary). */
interface EnrichedPost {
  id: bigint;
  author: SS58Like;
  text: BinaryLike;
  parent?: bigint;
  quote?: bigint;
  at: number;
  up_weight: bigint;
  down_weight: bigint;
  up_count: number;
  down_count: number;
  repost_count: number;
  reply_count: number;
  is_poll: boolean;
  my_vote?: { type: "Up" | "Down" };
  reposted: boolean;
  author_display_name: BinaryLike;
  author_avatar: BinaryLike;
  quoted?: {
    id: bigint;
    author: SS58Like;
    text: BinaryLike;
    author_display_name: BinaryLike;
    author_avatar: BinaryLike;
  };
}

/** PAPI returns SS58 author fields as plain strings; alias for intent. */
type SS58Like = Ss58;

interface FeedPageRaw {
  posts: EnrichedPost[];
  next_cursor?: bigint;
}

interface ThreadRaw {
  ancestors: EnrichedPost[];
  focal?: EnrichedPost;
  replies: EnrichedPost[];
}

/** One `PersonSummary` exactly as `MicroblogApi.search_people`/`who_to_follow` decodes it (snake_case;
 *  `display_name`/`avatar` = Binary; `weight` = u128 bigint; `follower_count` = u32). */
interface PersonSummaryRaw {
  account: SS58Like;
  display_name: BinaryLike;
  avatar: BinaryLike;
  weight: bigint;
  follower_count: number;
  /** spec-202: the account's reputation tally (stake-weighted up/down votes ON it). */
  account_tally: {
    up_weight: bigint;
    down_weight: bigint;
    up_count: number;
    down_count: number;
  };
}

/**
 * Read at the BEST block, not the runtime-API default (finalized). Writes confirm at `inBestBlock`,
 * several blocks before finalization, so a finalized feed read of a just-cast vote/repost is STALE and
 * the optimistic overlay can't reconcile until finalization (a vote appears to revert). This chain is
 * single-producer (best never reorgs), so best is fresh AND safe. Passed to the tally-bearing feed
 * reads (a read-after-write reconciliation depends on them); search / who-to-follow keep the default.
 */
const BEST = { at: "best" } as const;
type AtBest = typeof BEST;

/** The runtime-API surface this module calls (a subset of `api.apis.MicroblogApi`). */
interface MicroblogApiCalls {
  feed_page(
    beforeId: bigint | undefined,
    limit: number,
    viewer: Ss58 | undefined,
    opts?: AtBest,
  ): Promise<FeedPageRaw>;
  author_feed_page(
    author: Ss58,
    beforeId: bigint | undefined,
    limit: number,
    viewer: Ss58 | undefined,
    opts?: AtBest,
  ): Promise<FeedPageRaw>;
  following_feed_page(
    viewer: Ss58,
    beforeId: bigint | undefined,
    limit: number,
    opts?: AtBest,
  ): Promise<FeedPageRaw>;
  thread(focal: bigint, viewer: Ss58 | undefined, opts?: AtBest): Promise<ThreadRaw>;
  author_post_count(author: Ss58): Promise<number>;
  // ── the all-Rust restart: the SubQuery indexer reads folded into the node (fork/all-rust, P6) ──
  /** One author's REPLIES (`parent != None`), newest-first, paged below `beforeId` (a post id). */
  author_replies_page(
    author: Ss58,
    beforeId: bigint | undefined,
    limit: number,
    viewer: Ss58 | undefined,
    opts?: AtBest,
  ): Promise<FeedPageRaw>;
  /** Full-text post search: ASCII-case-insensitive substring on `term` (a `Vec<u8>` ⇒ `Uint8Array`). */
  search_posts(
    term: Uint8Array,
    beforeId: bigint | undefined,
    limit: number,
    viewer: Ss58 | undefined,
  ): Promise<FeedPageRaw>;
  /** People search by display-name substring (`term` ⇒ `Uint8Array`), ranked by follower count. */
  search_people(term: Uint8Array, limit: number): Promise<PersonSummaryRaw[]>;
  /** Ranked who-to-follow suggestions (ByAuthor members, ranked by follower count — INCLUDES 0-follower
   *  authors, so the panel is non-empty on a fresh-genesis chain). */
  who_to_follow(limit: number): Promise<PersonSummaryRaw[]>;
  /** The posts `who` has up-voted (the profile Likes tab), newest-first, paged below `beforeId`. */
  likes_page(
    who: Ss58,
    beforeId: bigint | undefined,
    limit: number,
    viewer: Ss58 | undefined,
    opts?: AtBest,
  ): Promise<FeedPageRaw>;
}

/** The typed `MicroblogApi` off the api (present on a spec-120 node; detected before any call). */
function microblogApi(api: CognoApi): MicroblogApiCalls {
  return (api.apis as unknown as { MicroblogApi: MicroblogApiCalls }).MicroblogApi;
}

/** Map the API's one-level `quoted` summary to the client `QuotedRef` (author name/avatar carried). */
function mapQuoted(q: EnrichedPost["quoted"]): QuotedRef | undefined {
  if (!q) return undefined;
  return {
    id: q.id,
    author: q.author,
    text: Binary.toText(q.text),
    // The API does not return the quoted author's revocation (not enriched in the summary); the
    // keyed path also leaves a resolved quote ref `authorRevoked:false` — matched here.
    authorRevoked: false,
    displayName: binTextOpt(q.author_display_name),
    avatar: binTextOpt(q.author_avatar),
  };
}

/**
 * Map one `EnrichedPost` → the client `CognoPost`, the SAME shape `enrichPosts` produces: id/author/
 * text/parent/quote/at + the tally (with `score = upWeight - downWeight`, identical to `readPostTally`)
 * + repostCount/replyCount/isPoll + the author profile snapshot + the one-level quote ref.
 *
 * `hasViewer` says whether the request actually carried a `viewer`. The runtime returns
 * `my_vote: None` / `reposted: false` REGARDLESS of whether a viewer was supplied, so the payload
 * alone can't tell "no viewer" apart from "viewer, but no vote/repost". Only when `hasViewer` is true
 * do we stamp the `myVote`/`reposted` overlay; otherwise we leave both keys UNSET (`undefined`, exactly
 * as the keyed path does), so `carriedViewerStates` excludes the post and `useViewerStates` reads it
 * per-card. Without this, a viewer-less node fetch for a logged-in account would carry a `myVote: null`
 * that the overlay-bypass would wrongly trust, hiding the user's real votes/reposts.
 */
export function mapEnrichedPost(e: EnrichedPost, hasViewer: boolean): CognoPost {
  const upWeight = BigInt(e.up_weight ?? 0n);
  const downWeight = BigInt(e.down_weight ?? 0n);
  const post: CognoPost = {
    id: e.id,
    author: e.author,
    text: Binary.toText(e.text),
    parent: e.parent,
    at: e.at,
    upWeight,
    downWeight,
    upCount: e.up_count ?? 0,
    downCount: e.down_count ?? 0,
    score: upWeight - downWeight, // SAME derivation as readPostTally / toCognoPost
    repostCount: e.repost_count ?? 0,
    replyCount: e.reply_count ?? 0,
    authorDisplayName: binTextOpt(e.author_display_name),
    authorAvatar: binTextOpt(e.author_avatar),
  };
  // The viewer overlay, stamped node-side — lets useViewerStates skip its per-card Reposts scan.
  // Only set it when a viewer was actually in the request (see the doc comment above).
  if (hasViewer) {
    post.myVote = e.my_vote ? e.my_vote.type : null;
    post.reposted = e.reposted === true;
  }
  // Set `isPoll` only when true — mirror `enrichPosts` (`if (pollRec) post.isPoll = true`), which
  // leaves it `undefined` on a non-poll, so the keyed + node CognoPost shapes stay byte-identical.
  if (e.is_poll === true) post.isPoll = true;
  if (e.quote != null) {
    post.quote =
      mapQuoted(e.quoted) ??
      // The quoted post was unresolvable node-side (e.g. absent) — mirror the keyed path's stub.
      { id: e.quote, author: "" as Ss58, text: "", authorRevoked: false };
  }
  return post;
}

/**
 * Build the viewer-overlay map (id-string → {@link ViewerPostState}) `useViewerStates` consumes to
 * SKIP its per-card `viewerPostState` read. Only posts carrying a node-stamped overlay (`myVote`
 * defined — the spec-120 path passed a `viewer`) are included; keyed/indexer posts (`myVote`
 * undefined) are omitted, so those ids fall back to the per-card read, unchanged.
 */
export function carriedViewerStates(posts: CognoPost[]): Map<string, ViewerPostState> {
  const out = new Map<string, ViewerPostState>();
  for (const p of posts) {
    if (p.myVote !== undefined) {
      out.set(String(p.id), { myVote: p.myVote, reposted: p.reposted === true });
    }
  }
  return out;
}

/** Clamp a requested page size to the runtime's `MAX_PAGE` (the API clamps too; keep them in step). */
function clampLimit(limit: number): number {
  return Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
}

/** Backstop on cursor hops per page once the page is NON-empty (some posts collected): a partial
 *  page + cursor is fine to surface, the UI advances past it. The cursor strictly decreases each hop. */
const MAX_CHASE_HOPS = 64;
/** Harder backstop while the page is STILL EMPTY (e.g. a sparse Following range whose followees have
 *  no recent top-level posts). We chase further before yielding an empty page + cursor — which renders
 *  as "nothing, but load more" and makes the user re-trigger the scan — so the pathology is rare. */
const MAX_EMPTY_CHASE_HOPS = 256;

/**
 * Assemble one full page by following `next_cursor` until the page holds `limit` posts or the feed
 * ends — so a node-served page matches the keyed path's FULL-page semantics. The runtime bounds each
 * call's scan (`MAX_SCAN_FACTOR`) and may hand back a SHORT (even empty) page + a cursor on a sparse
 * (filtered) range; chasing the cursor coalesces those into one rendered page (no posts lost). Each
 * hop requests only the REMAINING count, so the result never overshoots `limit` and the final
 * `nextCursor` continues below the last kept post. Bounded: the cursor strictly decreases per hop. On
 * a pathologically sparse Following range it can still return an empty page + a (strictly-smaller)
 * cursor after `MAX_EMPTY_CHASE_HOPS` — the UI can always advance past it, since the cursor walks down
 * to the end. (The deeper fix is a runtime-side k-way merge of `TopLevelByAuthor[followee]`.)
 */
async function chasePage(
  fetchPage: (beforeId: bigint | undefined, limit: number) => Promise<FeedPageRaw>,
  beforeId: bigint | undefined,
  limit: number,
  hasViewer: boolean,
): Promise<IdPage> {
  const target = clampLimit(limit);
  const posts: CognoPost[] = [];
  let cursor = beforeId;
  let nextCursor: bigint | null = null;
  for (let hop = 0; ; hop++) {
    const raw = await fetchPage(cursor, target - posts.length);
    for (const e of raw.posts) posts.push(mapEnrichedPost(e, hasViewer));
    nextCursor = raw.next_cursor != null ? BigInt(raw.next_cursor) : null;
    if (nextCursor === null || posts.length >= target) break;
    // Keep chasing rather than surface an empty page + cursor; allow more hops while still empty.
    const cap = posts.length === 0 ? MAX_EMPTY_CHASE_HOPS : MAX_CHASE_HOPS;
    if (hop + 1 >= cap) break;
    cursor = nextCursor;
  }
  return { posts, nextCursor };
}

/** The global "For-you" feed (top-level posts, newest-first), node-served + viewer-overlaid. */
export async function nodeGlobalFeedPage(
  api: CognoApi,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).feed_page(beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
  );
}

/** One author's top-level posts (the profile Posts tab), node-served + viewer-overlaid. */
export async function nodeAuthorFeedPage(
  api: CognoApi,
  author: Ss58,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).author_feed_page(author, beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
  );
}

/** The Following timeline (posts by accounts `viewer` follows), node-served (viewer is the timeline owner). */
export async function nodeFollowingFeedPage(
  api: CognoApi,
  viewer: Ss58,
  opts: { beforeId?: bigint; limit: number },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).following_feed_page(viewer, beforeId, limit, BEST),
    opts.beforeId,
    opts.limit,
    // The Following timeline is always read AS its owner, so the overlay is always stamped.
    true,
  );
}

/**
 * Reconstruct a thread node-side: the focal post + its (depth-capped) ancestor chain + its direct
 * replies, all enriched + viewer-overlaid. Mirrors the keyed `getThread` `RawThread` shape (root +
 * top-down ancestors + replies + the focal's `replyCount`). Throws if the focal is absent, exactly
 * as `getThread` does, so the thread hook's not-found handling is unchanged.
 */
export async function nodeThread(
  api: CognoApi,
  focalId: bigint,
  viewer?: Ss58,
): Promise<RawThread> {
  const raw = await microblogApi(api).thread(focalId, viewer, BEST);
  if (!raw.focal) throw new Error(`thread root #${focalId} not found on the node`);
  const hasViewer = viewer != null;
  const root = mapEnrichedPost(raw.focal, hasViewer);
  return {
    root,
    ancestors: raw.ancestors.map((e) => mapEnrichedPost(e, hasViewer)), // already top-down from the runtime
    replies: raw.replies.map((e) => mapEnrichedPost(e, hasViewer)),
    replyCount: root.replyCount ?? 0,
  };
}

/**
 * The author's TOP-LEVEL post count (replies excluded) — the correct profile `postCount`, served
 * node-side from `TopLevelByAuthor` (spec-121). Replaces the keyed `authorPostCount` (which counts
 * ALL of the author's posts, replies included) so the header matches the visible top-level cards.
 */
export async function nodeAuthorPostCount(api: CognoApi, author: Ss58): Promise<number> {
  return microblogApi(api).author_post_count(author);
}

// ── the all-Rust restart (fork/all-rust, P8b): the last three indexer-only caps, folded into the node ──

/**
 * Full-text post search (`MicroblogApi.search_posts`): an ASCII-case-insensitive substring match on
 * `term`, newest-first, node-served + viewer-overlaid. `term` is a runtime `Vec<u8>`, passed as a
 * `Binary`. The runtime bounds each call's scan (`limit · MAX_SCAN_FACTOR` ids) and hands back a
 * `next_cursor` on a sparse-match range; `chasePage` follows it to fill a full page — the SAME
 * cursor-chasing as the feeds, so a no-match dense stretch never yields an empty-but-more page early.
 */
export async function nodeSearchPosts(
  api: CognoApi,
  term: string,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  const termBin = Binary.fromText(term);
  return chasePage(
    (beforeId, limit) => microblogApi(api).search_posts(termBin, beforeId, limit, opts.viewer),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
  );
}

/**
 * One author's REPLIES (the profile Replies tab): their posts with `parent != None`, newest-first,
 * node-served + viewer-overlaid (`MicroblogApi.author_replies_page`). Paged below `beforeId` (a post
 * id) via `chasePage`, identical page semantics to the author feed — the runtime scans the author's
 * own `ByAuthor` index in reverse (bounded by their post count), skipping top-level posts.
 */
export async function nodeAuthorRepliesPage(
  api: CognoApi,
  author: Ss58,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).author_replies_page(author, beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
  );
}

/**
 * People search (`MicroblogApi.search_people`): a case-insensitive substring match on the display name,
 * ranked by follower count. Maps each `PersonSummary` → the client `Suggestion` (the same shape the old
 * indexer `searchPeople` returned): `display_name`/`avatar` Binary → trimmed string via `binTextOpt`,
 * `weight` u128 → bigint (0 ⇒ `undefined`, matching the who-to-follow / indexer producers), the exact
 * `follower_count`. `term` is a runtime `Vec<u8>`, passed as a `Binary`.
 */
export async function nodeSearchPeople(
  api: CognoApi,
  term: string,
  limit: number,
): Promise<Suggestion[]> {
  const rows = await microblogApi(api).search_people(Binary.fromText(term), limit);
  return rows.map(personSummaryToSuggestion);
}

/** Map one `PersonSummary` → the client `Suggestion` (shared by people-search + who-to-follow). */
function personSummaryToSuggestion(r: PersonSummaryRaw): Suggestion {
  const t = r.account_tally;
  return {
    author: r.account,
    displayName: binTextOpt(r.display_name),
    avatar: binTextOpt(r.avatar),
    weight: r.weight > 0n ? r.weight : undefined,
    followerCount: r.follower_count,
    // Net stake-weighted reputation (up − down); the row shows it only when non-zero.
    accountScore: BigInt(t?.up_weight ?? 0n) - BigInt(t?.down_weight ?? 0n),
  };
}

/**
 * Ranked who-to-follow suggestions (`MicroblogApi.who_to_follow`): ByAuthor members ranked by follower
 * count. Unlike the keyed `FollowerCount` scan it INCLUDES 0-follower authors, so the panel is non-empty
 * on a fresh-genesis chain where nobody has followers yet. The hook filters out self + already-followed.
 */
export async function nodeWhoToFollow(api: CognoApi, limit: number): Promise<Suggestion[]> {
  const rows = await microblogApi(api).who_to_follow(clampLimit(limit));
  return rows.map(personSummaryToSuggestion);
}

/**
 * The posts `who` has up-voted (the profile Likes tab), newest-first, node-served + viewer-overlaid
 * (`MicroblogApi.likes_page`). Paged below `beforeId` via `chasePage` — replaces the unbounded
 * `VotesByAccount.getEntries` + per-id `getPost` fan-out with one bounded page.
 */
export async function nodeLikesPage(
  api: CognoApi,
  who: Ss58,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).likes_page(who, beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
  );
}
