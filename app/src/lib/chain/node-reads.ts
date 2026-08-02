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
import type {
  CognoApi,
  CognoPost,
  Ss58,
  QuotedRef,
  ViewerPostState,
  Suggestion,
  FollowEdges,
} from "@/lib/types";
import { mapObservedRolePairs, type RoleKindType } from "@/lib/chain/roles";

/** The runtime's own per-call page ceiling, mirrored here so `clampLimit` and the runtime agree.
 *  Exported so a window that must fit in ONE read (the ranked window — see lib/feed/rank) can pin
 *  itself against it in a test rather than restating the literal. */
export const MAX_PAGE = 100;

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
    authorRoles: mapObservedRolePairs(q.author_roles),
  };
}

/**
 * Map one `EnrichedPost` → the client `CognoPost`, the SAME shape `enrichPosts` produces: id/author/
 * text/parent/quote/at + the tally (with `score = upWeight - downWeight`, identical to `readPostTally`)
 * + replyCount/isPoll + the author profile snapshot + the one-level quote ref.
 *
 * `hasViewer` says whether the request actually carried a `viewer`. The runtime returns
 * `my_vote: None` REGARDLESS of whether a viewer was supplied, so the payload
 * alone can't tell "no viewer" apart from "viewer, but no vote". Only when `hasViewer` is true
 * do we stamp the `myVote` overlay; otherwise we leave the key UNSET (`undefined`, exactly
 * as the keyed path does), so `carriedViewerStates` excludes the post and `useViewerStates` reads it
 * per-card. Without this, a viewer-less node fetch for a logged-in account would carry a `myVote: null`
 * that the overlay-bypass would wrongly trust, hiding the user's real votes.
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
    authorRoles: mapObservedRolePairs(e.author_roles),
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
 * defined — the read passed a `viewer`) are included; the rest are omitted, so those ids fall back to
 * the per-card read.
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
  /**
   * A TOTAL hop budget, overriding both default caps. For a RENDERED feed the defaults are right — the
   * user is looking at the page and wants it filled. For a BACKGROUND probe they are not: the
   * notifications fold searches for the viewer's own address, and a viewer with no mentions never fills
   * the page, so it chases every hop it is allowed down towards post id 0.
   *
   * It must bound BOTH branches. Capping only the empty branch bounds exactly the viewers who have no
   * mentions and leaves anyone who HAS one chasing to the end of the chain under MAX_CHASE_HOPS.
   */
  maxHops?: number,
  /**
   * An optional CLIENT-SIDE lens: keep only the posts it accepts. Applied inside the chase (not to the
   * finished page) so a filtered feed still fills to `limit` instead of handing back a page silently
   * shrunk below the requested size.
   *
   * A filtering caller MUST pass `maxHops`. The hop budget is chosen from `posts.length`, so a lens that
   * rejects everything never leaves the still-empty branch and would run to MAX_EMPTY_CHASE_HOPS (256)
   * state_calls — each of which rebuilds `staker_weights()` node-side — to render nothing.
   */
  keep?: (post: CognoPost) => boolean,
): Promise<IdPage> {
  const target = clampLimit(limit);
  const posts: CognoPost[] = [];
  let cursor = beforeId;
  let nextCursor: bigint | null = null;
  for (let hop = 0; ; hop++) {
    const raw = await fetchPage(cursor, target - posts.length);
    for (const e of raw.posts) {
      const post = mapEnrichedPost(e, hasViewer);
      if (keep === undefined || keep(post)) posts.push(post);
    }
    nextCursor = raw.next_cursor != null ? BigInt(raw.next_cursor) : null;
    if (nextCursor === null || posts.length >= target) break;
    // Keep chasing rather than surface an empty page + cursor; allow more hops while still empty.
    const cap =
      maxHops ?? (posts.length === 0 ? MAX_EMPTY_CHASE_HOPS : MAX_CHASE_HOPS);
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

/**
 * Hop budget for a CLIENT-FILTERED lens (the role scopes). Deliberately small: every hop is a
 * `state_call` that rebuilds `staker_weights()` over up to `MaxObserved` (1024) accounts node-side, and
 * a lens over a low-density role would otherwise chase for hundreds of hops. A sparse lens surfaces a
 * SHORT page plus a cursor — honest, and "load more" advances it — rather than burning the node to fill.
 */
const FILTERED_LENS_MAX_HOPS = 6;

/**
 * Posts whose author currently holds `role` — the SPO / dRep lens.
 *
 * Implemented as the existing firehose plus a client-side filter on `authorRoles`, which the runtime
 * ALREADY stamps on every enriched post (`enrich_author_profiles`), so this costs no extra read per
 * post and reuses ONE cursor domain.
 *
 * It is deliberately NOT a k-way merge over `ObservedRoles`: that map is `Blake2_128Concat`-keyed, so
 * capping the holder set would drop verified holders in storage-hash order with no user-visible signal,
 * each holder's `author_feed_page` would independently rebuild `staker_weights()`, and falling back to
 * the firehose past a holder cap would cross-wire the post-id and `TopLevelPosts`-seq cursor families.
 *
 * Degrades honestly: the lens shows what it found in the window it scanned, and the UI says so.
 */
export async function nodeRoleFeedPage(
  api: CognoApi,
  role: RoleKindType,
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58; maxHops?: number },
): Promise<IdPage> {
  return chasePage(
    (beforeId, limit) => microblogApi(api).feed_page(beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
    opts.maxHops ?? FILTERED_LENS_MAX_HOPS,
    (p) => (p.authorRoles ?? []).some((r) => r.kind === role),
  );
}

/**
 * Most members a list timeline will fan out over. A list can hold more (the store caps at 64); beyond
 * this the timeline reads the first `MAX_FEED_MEMBERS` and the UI SURFACES the truncation rather than
 * silently showing a partial list as if it were whole.
 */
export const MAX_FEED_MEMBERS = 32;

/**
 * The error a list page throws when it cannot honestly return one.
 *
 * It RETHROWS the underlying member rejection rather than a wrapper of our own, because the thrown
 * value is what `readErrorCopy` classifies: a dropped socket carries "WebSocket closed", which becomes
 * the actionable "Can't reach cogno…" line, while a wrapper string like "list timeline: a member read
 * failed" is classified `raw` and rendered VERBATIM into the feed's error row — an internal sentence in
 * front of the reader, and the real cause discarded. The generic fallback covers the (theoretical) case
 * where nothing rejected but the page still has no truthful cursor to hand back.
 */
function memberReadFailure(settled: PromiseSettledResult<IdPage>[]): Error {
  for (const r of settled) {
    if (r.status === "rejected" && r.reason instanceof Error) return r.reason;
  }
  return new Error("Couldn't load this list's posts.");
}

/**
 * A timeline of just these accounts' top-level posts — the list feed.
 *
 * A fan-out (one `author_feed_page` per member, merged newest-first), NOT a filtered firehose: a
 * handful of members is arbitrarily sparse in the global timeline, so a filter would chase for hundreds
 * of hops to find them. Each member's own `TopLevelByAuthor` index is dense by construction.
 *
 * Exactly ONE hop per member: `author_feed_page` returns a `next_cursor` only when it filled the limit,
 * so a short page means the author's index was exhausted and `chasePage` stops.
 *
 * Cursor math: every member's returned posts are strictly below `beforeId`, so the minimum id in the
 * merged slice is a safe next `beforeId` — a member truncated at the limit has its own lowest returned
 * id at or below that minimum, so nothing can be skipped.
 */
export async function nodeMembersFeedPage(
  api: CognoApi,
  members: readonly Ss58[],
  opts: { beforeId?: bigint; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  const scoped = members.slice(0, MAX_FEED_MEMBERS);
  if (scoped.length === 0) return { posts: [], nextCursor: null };
  const target = clampLimit(opts.limit);

  // allSettled, NOT all: one member's failed state_call (a transient RPC blip on any of up to
  // MAX_FEED_MEMBERS reads) would otherwise reject the whole page and blank a timeline that could still
  // show every other member. A rejected member is treated as "unknown, possibly more" below so its posts
  // are never silently declared absent.
  const settled = await Promise.allSettled(
    scoped.map((m) =>
      nodeAuthorFeedPage(api, m, { beforeId: opts.beforeId, limit: target, viewer: opts.viewer }),
    ),
  );
  const pages = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const anyMemberFailed = settled.length !== pages.length;
  // Every member failed ⇒ a read failure, not an empty list. Surface it rather than rendering an
  // authoritative-looking "nobody posted" over a page we never actually read.
  //
  // A PARTIAL FIRST PAGE fails loud too, and that is the subtle one. Keeping the cursor alive is NOT
  // enough to make a failed member recoverable: the cursor is the minimum id across the members that
  // SUCCEEDED, so the failed member's posts ABOVE that cursor are never requested again. Since at least
  // one member succeeded nothing would throw, so the timeline would render as if complete with a hole
  // punched out of the middle and no signal anywhere. A later page degrades more gracefully — the reader
  // has already seen the newer posts and the cursor keeps descending — but page one must not lie, and a
  // later page still fails loud when it cannot produce a cursor at all (see below).
  if (pages.length === 0 || (anyMemberFailed && opts.beforeId === undefined)) {
    throw memberReadFailure(settled);
  }

  const merged = pages
    .flatMap((p) => p.posts)
    .sort((a, b) => (a.id === b.id ? 0 : a.id > b.id ? -1 : 1));
  const slice = merged.slice(0, target);

  // Nothing more to read only when we returned EVERYTHING we fetched AND every member was exhausted AND
  // no member's read failed (a failed member may hold older posts we haven't seen).
  const anyMemberHasMore = pages.some((p) => p.nextCursor !== null);
  const truncated = merged.length > slice.length;
  const hasMore = truncated || anyMemberHasMore || anyMemberFailed;

  // The cursor IS the lowest id we returned, so an empty slice has no id to page from. Handing back
  // `null` there would declare the end of the list — burying a failed member's older posts under a
  // terminal "no posts" state, the same silent hole the first-page throw above exists to prevent. We
  // cannot page and we cannot honestly stop, so fail loud and let Retry re-read.
  if (hasMore && slice.length === 0) throw memberReadFailure(settled);

  return { posts: slice, nextCursor: hasMore ? slice[slice.length - 1].id : null };
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
    // spec 216: `replies` is the NEWEST page, not the whole conversation. The cursor is a
    // `RepliesByParentSeq` seq, so it is only ever valid passed back to `nodeRepliesPage` — never to a
    // post-id-cursored read.
    repliesCursor: raw.replies_next_cursor != null ? BigInt(raw.replies_next_cursor) : null,
  };
}

/**
 * One page of a post's DIRECT replies, newest-first, node-served + viewer-overlaid
 * (`MicroblogApi.replies_page`). The continuation of {@link nodeThread}: seed `beforeSeq` from its
 * `repliesCursor` and pass each returned `nextCursor` back here to walk a conversation of any size.
 *
 * NOT run through `chasePage`, unlike every other paged read here. That helper exists to fill a page a
 * FILTERED scan left short, and it re-feeds `next_cursor` on the assumption that the cursor and the
 * page semantics match its id-cursored callers. This read filters nothing: the runtime walks the
 * parent's own dense seq spine, so a full page is exactly `limit` replies and a short one means the
 * spine ended. Chasing it would spend extra state_calls to discover the same thing.
 */
export async function nodeRepliesPage(
  api: CognoApi,
  parent: bigint,
  opts: { beforeSeq?: bigint | null; limit: number; viewer?: Ss58 },
): Promise<IdPage> {
  const raw = await microblogApi(api).replies_page(
    parent,
    opts.beforeSeq ?? undefined,
    clampLimit(opts.limit),
    opts.viewer,
    BEST,
  );
  return {
    posts: raw.posts.map((e) => mapEnrichedPost(e, opts.viewer != null)),
    nextCursor: raw.next_cursor != null ? BigInt(raw.next_cursor) : null,
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

// ── search: substring post search, people search, and the reverse Replies tab ────────────────────

/**
 * Full-text post search (`MicroblogApi.search_posts`): an ASCII-case-insensitive substring match on
 * `term`, newest-first, node-served + viewer-overlaid. `term` is a runtime `Vec<u8>`, passed as a
 * `Binary`. The runtime bounds each call's scan (`limit · MAX_SCAN_FACTOR` ids) and hands back a
 * `next_cursor` on a sparse-match range; `chasePage` follows it to fill a full page — the SAME
 * cursor-chasing as the feeds, so a no-match dense stretch never yields an empty-but-more page early.
 * Read at BEST (like the feeds): Latest results carry the viewer overlay, so the read-after-write
 * reconciliation of a just-cast vote on a result needs the fresh best block (see `BEST`).
 */
export async function nodeSearchPosts(
  api: CognoApi,
  term: string,
  opts: {
    beforeId?: bigint;
    limit: number;
    viewer?: Ss58;
    maxHops?: number;
    /**
     * An optional client-side narrowing of the node's matches — used by the TOPIC feed, where the
     * node's substring scan for `#cardano` is a superset of the topic (it also matches `#cardanoNFT`
     * and a `.../#cardano` URL fragment). Applied inside the chase so the page still fills.
     */
    keep?: (post: CognoPost) => boolean;
  },
): Promise<IdPage> {
  const termBin = Binary.fromText(term);
  return chasePage(
    (beforeId, limit) => microblogApi(api).search_posts(termBin, beforeId, limit, opts.viewer, BEST),
    opts.beforeId,
    opts.limit,
    opts.viewer != null,
    // A narrowed search is a filtered lens, so it needs a hop budget for the same reason the role lens
    // does — a term whose matches are mostly non-topic would otherwise chase the empty branch.
    opts.maxHops ?? (opts.keep !== undefined ? FILTERED_LENS_MAX_HOPS : undefined),
    opts.keep,
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
 * People search (`MicroblogApi.search_people`): a case-insensitive substring match on the display name.
 * The runtime ranks WITHIN each page and hands back a cursor; `chasePeoplePage` follows it and ranks the
 * union, so the caller still gets one ordered window. Maps each `PersonSummary` → the client
 * `Suggestion`: `display_name`/`avatar`
 * Binary → trimmed string via `binTextOpt`, `weight` u128 → bigint (0 ⇒ `undefined`, matching the
 * who-to-follow producer), the exact `follower_count`. `term` is a runtime `Vec<u8>`, passed as a
 * `Binary`.
 */
export async function nodeSearchPeople(
  api: CognoApi,
  term: string,
  limit: number,
): Promise<Suggestion[]> {
  return chasePeoplePage(
    (after, want) => microblogApi(api).search_people(Binary.fromText(term), want, after),
    limit,
  );
}

/** Cursor hops a people read will follow before giving up. See `chasePeoplePage`. */
const MAX_PEOPLE_HOPS = 8;

/**
 * Assemble one page of people by following `next_cursor` (spec 217).
 *
 * `search_people` and `who_to_follow` walk a hash-ordered map under a per-call budget of 10,000
 * EXAMINED rows, and both FILTER inside that budget (the display-name match, the bound-account gate).
 * So a short page is not the end of the matches, it is the end of the budget — before the cursor
 * existed, a bound account whose address hashed past position 10,000 was unreachable through any read
 * and Explore said "No people found" for a name that was right there on chain.
 *
 * The hop budget is deliberately much smaller than `chasePage`'s. Each hop is a separate `state_call`
 * that re-walks 10,000 rows AND rebuilds the node's staker-weight list, so chasing hard is a real cost
 * paid on a public unmetered read — and unlike a feed, a people read that comes back short is usually
 * short because there genuinely are no more matches. Stopping early can under-fill the page; it cannot
 * make a person permanently invisible, which was the actual defect.
 *
 * Ranking is PER PAGE on the runtime side, so ranking the union here is what makes the assembled page
 * ordered as a whole. Sorting by follower count then reputation mirrors the runtime's own key.
 */
async function chasePeoplePage(
  fetchPage: (
    after: Ss58 | undefined,
    limit: number,
  ) => Promise<{ people: PersonSummaryRaw[]; next_cursor: Ss58 | undefined }>,
  limit: number,
): Promise<Suggestion[]> {
  const target = clampLimit(limit);
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  let after: Ss58 | undefined = undefined;
  for (let hop = 0; hop < MAX_PEOPLE_HOPS; hop++) {
    const page = await fetchPage(after, target);
    for (const row of page.people) {
      const s = personSummaryToSuggestion(row);
      // A profile written between two pages can shift the walk, so the same account can arrive twice.
      if (seen.has(s.author)) continue;
      seen.add(s.author);
      out.push(s);
    }
    if (page.next_cursor == null || out.length >= target) break;
    after = page.next_cursor;
  }
  // Each page was ranked only within itself; rank the union so the assembled page reads as one list.
  out.sort((a, b) => b.followerCount - a.followerCount);
  return out.slice(0, target);
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
  return chasePeoplePage((after, want) => microblogApi(api).who_to_follow(want, after), limit);
}

/**
 * One account's follow graph — both directions plus the exact counters — in ONE `state_call`
 * (`MicroblogApi.follow_edges`).
 *
 * This replaces a four-read fan-out: `Following.getEntries(who)` and `Followers.getEntries(who)` are
 * both FULL prefix scans of the account's edge set, and each came with its own counter read. The
 * runtime API was already generated and on the wire; it simply had no caller.
 *
 * BEST, not the runtime-API finalized default: this IS a read-after-write surface. `useFollow`
 * invalidates the shared follow-edges cache from an `onConfirm` that fires at `inBestBlock`, blocks
 * before finalization — at the finalized default that re-read returns the PRE-follow graph and the
 * cache COMMITS it, so the Following tab keeps saying "Not following anyone yet" and who-to-follow
 * keeps suggesting the account you just followed, for the rest of the session. `useFollow`'s own
 * optimistic map does not cover those two (they read the cache directly, with no override).
 */
export async function nodeFollowEdges(api: CognoApi, who: Ss58): Promise<FollowEdges> {
  try {
    const e = await microblogApi(api).follow_edges(who, BEST);
    return {
      following: e.following as Ss58[],
      followers: e.followers as Ss58[],
      followerCount: Number(e.follower_count ?? 0),
      followingCount: Number(e.following_count ?? 0),
    };
  } catch {
    // The keyed fallback lives HERE, not in one caller: an account with a very large edge set can blow
    // the state_call resource limit, and both callers (papi-source's `followEdges` and the shared
    // useFollowEdges cache) need to survive that. The cache's error policy is `retry`, which for a
    // permanently-over-limit account means an already-mounted Follow button never resolves at all.
    // A follow-graph read carries no cursor, so falling back to the two prefix scans is safe.
    const [following, followers, followerCount, followingCount] = await Promise.all([
      api.query.Microblog.Following.getEntries(who, BEST),
      api.query.Microblog.Followers.getEntries(who, BEST),
      api.query.Microblog.FollowerCount.getValue(who, BEST),
      api.query.Microblog.FollowingCount.getValue(who, BEST),
    ]);
    return {
      following: following.map((e) => e.keyArgs[1] as Ss58),
      followers: followers.map((e) => e.keyArgs[1] as Ss58),
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
    };
  }
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
