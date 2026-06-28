// The data-layer SEAM for reading the social feed. Two readers implement it: the SubQuery
// GraphQL indexer (search + cursor pagination + thread/profile/social aggregates) and the
// always-available PAPI-direct fallback. The React layer only ever touches this interface,
// never a concrete reader, so the read path is swappable with no call-site churn.
//
// `caps` lets the UI light up ONLY the affordances a source can honestly serve. With the
// honesty/trust layer dropped, the UI does NOT show a "reads: indexer" badge — it simply
// HIDES (never greys-with-explanation) what a reader cannot serve (e.g. the Following tab,
// who-to-follow rail, and profile counts vanish on PAPI-direct).

import type { Observable } from "rxjs";
import type {
  FeedSnapshot,
  FeedPage,
  FeedQuery,
  ThreadView,
  ProfileView,
  PollView,
  ViewerPostState,
  FollowEdges,
  Suggestion,
  Ss58,
} from "@/lib/types";

/**
 * A source that can stream the newest post id (the liveness signal). The PAPI-direct reader provides
 * it via `NextPostId.watchValue` — a new post bumps the counter — so the home feed pages by id and
 * prepends new posts / drives the "N new posts" pill from this WITHOUT a full `watchEntries`. The
 * indexer reader does NOT implement it (it keeps its own poll-driven `watch()`); consumers feature-
 * detect it and fall back to `watch()` when it is absent.
 */
export interface LiveHeadSource {
  /** Emits the newest post id on every change (null while the chain has no posts). */
  liveHeadId(): Observable<bigint | null>;
}

/** What a feed source can do — drives which UI affordances are shown (never faked). */
export interface FeedCaps {
  /** case-insensitive substring search over post bodies. (indexer-only) */
  search: boolean;
  /** cursor (`after`) pagination beyond the first page. (indexer-only) */
  pagination: boolean;
  /** thread reconstruction (root + direct replies). (both) */
  threads: boolean;
  /** author-revocation flagging on posts. (both) */
  revocation: boolean;
  // ── spec-113 social ──
  /** vote/poll weight tallies + counts + the viewer's own vote/repost state. (both — PAPI reads the aggregate maps) */
  tallies: boolean;
  /** follow edges + follower/following counts. (both — spec-118 Followers reverse map + counters) */
  follows: boolean;
  /** display name / bio / avatar / pinned. (both — pallet-profile stores these on-chain) */
  profiles: boolean;
  /** the profile Replies reverse tab (replies-by-author). (indexer-only — no reverse replies map) */
  profileReplies: boolean;
  /** the profile Likes reverse tab (votes-by-author). (both — spec-118 VotesByAccount reverse map) */
  profileLikes: boolean;
  /** ranked who-to-follow suggestion list. (both — spec-118 FollowerCount ranking served node-direct) */
  whoToFollow: boolean;
  /**
   * The connected node serves enriched, viewer-aware feed/thread/profile pages in ONE `state_call`
   * via the spec-120 `MicroblogApi` runtime API (replacing the ~5-reads-per-post `enrichPosts`
   * fan-out AND the per-card `Reposts.getEntries` viewer-state scan). PAPI-direct only, and
   * RUNTIME-DETECTED: a pre-120 node (no `MicroblogApi` in its metadata) reports `false` and the
   * reader degrades to the keyed `getGlobalFeedPage`/`getThread` path. The indexer reports `false`
   * (it has its own GraphQL surface). When `true`, an API-served page already carries each post's
   * `myVote`/`reposted` overlay, so `useViewerStates` skips its per-card `viewerPostState` read.
   */
  nodeFeedApi: boolean;
}

/** Arguments for {@link FeedSource.profile} — by account or by identity hash. */
export interface ProfileArgs {
  author?: string;
  identityHash?: string;
  /** Which posts tab to fold into `page` (the indexer applies it as filter + orderBy). */
  tab?: "forYou" | "following" | "replies" | "likes";
  /**
   * The connected account, when known. A `caps.nodeFeedApi` source threads it into the Posts-tab
   * `MicroblogApi` page so each post carries the viewer's `myVote`/`reposted` overlay. The keyed +
   * indexer paths ignore it (the overlay is fetched per-card by `useViewerStates`).
   */
  viewer?: Ss58;
}

/**
 * A swappable reader for the feed/thread/profile/social views. `kind` is retained only for
 * internal diagnostics (NOT rendered — the trust layer is dropped); the rest is the read
 * surface. Every method beyond the original four is gated by a `caps` flag; calling a method a
 * reader cannot serve throws {@link UnsupportedQuery} (a logic-slip guard — the UI gates on
 * `caps` so it never gets there).
 */
export interface FeedSource {
  kind: "papi" | "graphql";
  caps: FeedCaps;
  /** The live feed — a continuously-updating snapshot, newest-first. */
  watch(): Observable<FeedSnapshot>;
  /**
   * Optional liveness signal: the newest post id, on every change ({@link LiveHeadSource}). Present on
   * the PAPI-direct reader (`NextPostId.watchValue`), absent on the indexer reader. The home feed uses
   * it to page by id + prepend new posts; consumers fall back to {@link watch} when it is undefined.
   */
  liveHeadId?(): Observable<bigint | null>;
  /** One page of the feed (global, search, author-scoped, or a home/profile tab). */
  page(q: FeedQuery): Promise<FeedPage>;
  /**
   * A reconstructed thread for `rootId`. (gated on `caps.threads`)
   *
   * `viewer` (the connected account, when known) lets a `caps.nodeFeedApi` source stamp each post's
   * `myVote`/`reposted` overlay node-side in the same `state_call`; the keyed fallback ignores it
   * (the overlay is fetched per-card by `useViewerStates`, exactly as before).
   */
  thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView>;
  /** One author's profile + posts. (display fields gated on `caps.profiles`) */
  profile(args: ProfileArgs): Promise<ProfileView>;
  // ── spec-113 social ──
  /** Options + per-option stake-weighted tally for a poll host id. (gated on `caps.tallies`) */
  poll(hostId: bigint): Promise<PollView>;
  /** The viewer's chosen option index for a poll, or null if they have not cast. (gated on `caps.tallies`) */
  viewerPollChoice(hostId: bigint, who: Ss58): Promise<number | null>;
  /** The viewer's own vote/repost state on a post. (gated on `caps.tallies`) */
  viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState>;
  /** Followers/following ids + counts for an account. (gated on `caps.follows`) */
  followEdges(who: Ss58): Promise<FollowEdges>;
  /** Ranked who-to-follow suggestions. (gated on `caps.whoToFollow`) */
  whoToFollow(who: Ss58 | null, limit: number): Promise<Suggestion[]>;
  /** Author search by display name. (gated on `caps.search && caps.profiles`) */
  searchPeople(q: string, limit: number): Promise<Suggestion[]>;
}

/**
 * Thrown when a {@link FeedQuery} / social method asks for something a source cannot honestly
 * serve — e.g. search, cursor pagination, or follow edges on the PAPI-direct path. The UI gates
 * these on `caps`, so this is a guard against a logic slip, not an expected user-facing state.
 */
export class UnsupportedQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQuery";
  }
}
