// The data-layer SEAM for reading the social feed. Since the all-Rust restart there is exactly ONE
// reader — the PAPI-direct node source — and the seam is retained only so the React layer touches an
// interface, never a concrete reader (no call-site churn if a second reader is ever reintroduced).
//
// `caps` lets the UI light up ONLY the affordances a source can honestly serve. The node serves the
// WHOLE surface now: feed / thread / profile, the follow graph, profile counts/fields, the Following /
// Likes / Replies tabs, who-to-follow, AND substring post + people search — the last two (search,
// profileReplies) folded into the spec-200 MicroblogApi at P6/P8b, retiring the SubQuery indexer. The
// UI never shows a "reads: indexer" badge; it HIDES (never greys-with-explanation) anything a reader
// cannot serve, which — on the node source — is now nothing.

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
 * prepends new posts / drives the "N new posts" pill from this WITHOUT a full `watchEntries`. Kept an
 * OPTIONAL method on the seam: consumers feature-detect it and fall back to `watch()` when it is absent
 * (the sole reader today, the node source, always implements it).
 */
export interface LiveHeadSource {
  /** Emits the newest post id on every change (null while the chain has no posts). */
  liveHeadId(): Observable<bigint | null>;
}

/** What a feed source can do — drives which UI affordances are shown (never faked). */
export interface FeedCaps {
  /** case-insensitive substring search over post bodies. (node-served — spec-200 MicroblogApi.search_posts) */
  search: boolean;
  /** cursor (`after`) pagination beyond the first page. (node-served — the feed pages by post id) */
  pagination: boolean;
  /** thread reconstruction (root + direct replies). (node-served) */
  threads: boolean;
  /** author-revocation flagging on posts. (node-served — `CognoGate.PkhOf` absence) */
  revocation: boolean;
  // ── spec-113 social ──
  /** vote/poll weight tallies + counts + the viewer's own vote/repost state. (node-served — the aggregate maps) */
  tallies: boolean;
  /** follow edges + follower/following counts. (node-served — spec-118 Followers reverse map + counters) */
  follows: boolean;
  /** display name / bio / avatar / pinned. (node-served — pallet-profile stores these on-chain) */
  profiles: boolean;
  /** the profile Replies reverse tab (replies-by-author). (node-served — spec-200 MicroblogApi.author_replies_page) */
  profileReplies: boolean;
  /** the profile Likes reverse tab (votes-by-author). (node-served — spec-118 VotesByAccount reverse map) */
  profileLikes: boolean;
  /** ranked who-to-follow suggestion list. (node-served — spec-118 FollowerCount ranking) */
  whoToFollow: boolean;
  /**
   * The connected node serves enriched, viewer-aware feed/thread/profile pages (and search/replies) in
   * ONE `state_call` via the `MicroblogApi` runtime API (replacing the ~5-reads-per-post `enrichPosts`
   * fan-out AND the per-card `Reposts.getEntries` viewer-state scan). RUNTIME-DETECTED: a pre-120 node
   * (no `MicroblogApi` in its metadata) reports `false` and the reader degrades to the keyed
   * `getGlobalFeedPage`/`getThread` path (search/replies have no keyed fallback — they throw). When
   * `true`, an API-served page already carries each post's `myVote`/`reposted` overlay, so
   * `useViewerStates` skips its per-card `viewerPostState` read.
   */
  nodeFeedApi: boolean;
}

/** Arguments for {@link FeedSource.profile} — by account or by identity hash. */
export interface ProfileArgs {
  author?: string;
  identityHash?: string;
  /** Which posts tab the profile view folds into `page` (Posts / Following / Replies / Likes). */
  tab?: "forYou" | "following" | "replies" | "likes";
  /**
   * The connected account, when known. A `caps.nodeFeedApi` source threads it into the Posts-tab
   * `MicroblogApi` page so each post carries the viewer's `myVote`/`reposted` overlay. The keyed
   * fallback path ignores it (the overlay is fetched per-card by `useViewerStates`).
   */
  viewer?: Ss58;
}

/**
 * A swappable reader for the feed/thread/profile/social views. `kind` is "papi" (node-direct) — the
 * sole reader since the all-Rust restart. It is diagnostic only — not rendered and not behaviourally
 * read (every affordance gates on `caps`, never on `kind`). The rest is the read surface. Every method
 * beyond the original four is gated by a `caps` flag; calling a method a reader cannot serve throws
 * {@link UnsupportedQuery} (a logic-slip guard — the UI gates on `caps` so it never gets there).
 */
export interface FeedSource {
  kind: "papi";
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
 * Thrown when a {@link FeedQuery} / social method asks for something the connected node cannot serve —
 * e.g. substring search, people search, or the reverse Replies tab against a pre-spec-200 node (they
 * have no keyed fallback). The UI gates these on `caps` (advertised `true` for the node reader), so on
 * a spec-200 node this is a guard against a logic slip, not an expected user-facing state.
 */
export class UnsupportedQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQuery";
  }
}
