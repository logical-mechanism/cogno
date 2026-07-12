// Node-served reads (spec-120): one enriched, viewer-aware feed / thread / profile page per
// `state_call`, via the `MicroblogApi` runtime API. This REPLACES the ~5-reads-per-post `enrichPosts`
// fan-out (reads.ts) with a SINGLE call that returns everything a card renders — tallies, counts, the
// poll flag, the author profile snapshot, a one-level quote summary, and (when a `viewer` is passed)
// the viewer's own vote overlay — atomic at one block.
//
// This is the PRIMARY read path. reads.ts is NOT a dead compat layer: papi-source.ts keeps its keyed
// `getThread` and `authorPostCount` as live RESILIENCE fallbacks (`nodeThread(...).catch(() =>
// getThread(...))`), because a viral post with tens of thousands of replies can blow the `state_call`
// resource limit, and a thread read carries no cursor so falling back is position-safe. Do not delete
// them as "unused" — the `.catch()` is their only caller by design. reads.ts also owns the liveness
// signal (`watchLatestPostId`) and the profile-text decoder outright.
//
// The two paths MUST agree: the mapping here mirrors `enrichPosts` exactly (same CognoPost shape;
// `score = upWeight - downWeight`, the SAME derivation as `readPostTally`/`toCognoPost`), proven by
// the parity test in reads.test.ts.
//
// The raw wire shapes are DERIVED from the generated descriptors (see chain/descriptors.ts) — there is
// no hand-written mirror of the runtime API here, so it cannot drift from the chain.

import { Binary } from "polkadot-api";
import { binTextOpt, type IdPage, type RawThread } from "./reads";
import type { EnrichedPost, FeedPageRaw, PersonSummaryRaw } from "./descriptors";
import type { CognoApi, CognoPost, Ss58, QuotedRef, ViewerPostState, Suggestion } from "@/lib/types";

const MAX_PAGE = 100;

/**
 * Read at the BEST block, not the runtime-API default (finalized). Writes confirm at `inBestBlock`,
 * several blocks before finalization, so a finalized feed read of a just-cast vote is STALE and the
 * optimistic overlay can't reconcile until finalization (a vote appears to revert). This chain is
 * single-producer (best never reorgs), so best is fresh AND safe. Passed to the tally-bearing reads
 * whose viewer overlay a read-after-write reconciliation depends on — the feeds AND `search_posts`
 * (Latest results carry the myVote overlay, so a finalized read would make a just-cast vote on a
 * result appear to revert). `search_people` / `who_to_follow` have no per-viewer overlay, so they
 * DELIBERATELY keep the finalized default — do not "helpfully" add BEST to them.
 */
const BEST = { at: "best" } as const;

/** The `MicroblogApi` runtime-API surface, typed by the generated descriptors (no cast, no mirror). */
function microblogApi(api: CognoApi) {
  return api.apis.MicroblogApi;
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
 * + replyCount/isPoll + the author profile snapshot + the one-level quote ref.
 *
 * `hasViewer` says whether the request actually carried a `viewer`. The runtime returns
 * `my_vote: None` REGARDLESS of whether a viewer was supplied, so the payload
 * alone can't tell "no viewer" apart from "viewer, but no vote/repost". Only when `hasViewer` is true
 * do we stamp the `myVote` overlay; otherwise we leave the key UNSET (`undefined`, exactly
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
    replyCount: e.reply_count ?? 0,
    authorDisplayName: binTextOpt(e.author_display_name),
    authorAvatar: binTextOpt(e.author_avatar),
  };
  // The viewer overlay, stamped node-side — lets useViewerStates skip its per-card vote read.
  // Only set it when a viewer was actually in the request (see the doc comment above).
  if (hasViewer) {
    post.myVote = e.my_vote ? e.my_vote.type : null;
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
      out.set(String(p.id), { myVote: p.myVote });
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

// ── the all-Rust restart (fork/all-rust, P8b): the last three indexer-only reads, folded into the node ──

/**
 * Full-text post search (`MicroblogApi.search_posts`): an ASCII-case-insensitive substring match on
 * `term`, newest-first, node-served + viewer-overlaid. `term` is a runtime `Vec<u8>`, passed as a
 * `Binary`. The runtime bounds each call's scan (`limit · MAX_SCAN_FACTOR` ids) and hands back a
 * `next_cursor` on a sparse-match range; `chasePage` follows it to fill a full page — the SAME
 * cursor-chasing as the feeds, so a no-match dense stretch never yields an empty-but-more page early.
 * Read at BEST (like the feeds): Latest results carry the viewer overlay, so the read-after-write
 * reconciliation of a just-cast vote/repost on a result needs the fresh best block (see `BEST`).
 */
export async function nodeSearchPosts(
  api: CognoApi,
  term: string,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  const termBin = Binary.fromText(term);
  return chasePage(
    (beforeId, limit) => microblogApi(api).search_posts(termBin, beforeId, limit, opts.viewer, BEST),
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
  const rows = await microblogApi(api).search_people(Binary.fromText(term), clampLimit(limit));
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
    // Net stake-weighted reputation (up − down); the row shows it only when non-zero. `undefined` when
    // the node omits `account_tally` (a pre-spec-202 node) — "unknown", NOT a genuine net-zero score.
    accountScore: t ? BigInt(t.up_weight) - BigInt(t.down_weight) : undefined,
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
