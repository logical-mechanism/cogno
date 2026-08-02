// The data-layer SEAM for reading the social feed. There is exactly ONE reader — the PAPI-direct node
// source (feed/papi-source.ts) — and the seam is retained only so the React layer touches an
// interface, never a concrete reader. Endpoint neutrality is unaffected: the app reads whatever node
// the user points it at (lib/config/endpoints.ts).
//
// The reader keeps ONE fallback, in `thread()`: if the enriched state_call fails on a viral post (it
// enumerates every reply in one shot, which can hit a resource limit) it drops to incremental keyed
// reads. That is a RESILIENCE path, not a compatibility one, and it stays.

import type { Observable } from "rxjs";
import type {
  CognoPost,
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
import type { PollChoices, PollRoster, PollVoter } from "@/lib/chain/social-reads";

/** Arguments for {@link FeedSource.profile} — by account or by identity hash. */
export interface ProfileArgs {
  author?: string;
  identityHash?: string;
  /** Which posts tab the profile view folds into `page` (Posts / Following / Replies / Likes). */
  tab?: "forYou" | "following" | "replies" | "likes";
  /**
   * The connected account, when known. Threaded into the `MicroblogApi` page so each post carries the
   * viewer's `myVote` overlay, stamped node-side in the same state_call.
   */
  viewer?: Ss58;
}

/** The read surface for the feed / thread / profile / social views. */
export interface FeedSource {
  /**
   * The newest post id, on every change — the liveness signal, via `NextPostId.watchValue` (a new post
   * bumps the counter). The home feed pages by id and drives the "N new posts" pill off this, so it
   * never needs a full `watchEntries`.
   */
  liveHeadId(): Observable<bigint | null>;
  /** One page of the feed (global, search, author-scoped, or a home/profile tab). */
  page(q: FeedQuery): Promise<FeedPage>;
  /**
   * A reconstructed thread for `rootId`: the focal post, its ancestors, and the NEWEST page of its
   * direct replies. `viewer` (the connected account, when known) lets the source stamp each post's
   * `myVote` overlay node-side in the same state_call.
   *
   * `repliesCursor` continues into {@link FeedSource.repliesPage} when the conversation is longer than
   * one page.
   */
  thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView>;
  /**
   * One page of `parentId`'s direct replies, OLDER than `beforeSeq`, newest-first. Seeded from a
   * thread's `repliesCursor` and continued by each returned `nextCursor`; `nextCursor` is null at the
   * conversation's first reply.
   *
   * The cursor is a reply SEQUENCE NUMBER, not a post id — endpoint-scoped like every other cursor
   * here, and not interchangeable with the `beforeId` the feed reads page by.
   */
  repliesPage(
    parentId: bigint,
    beforeSeq: bigint | null,
    limit: number,
    viewer?: Ss58,
  ): Promise<{ posts: CognoPost[]; nextCursor: bigint | null }>;
  /** One author's profile + posts. */
  profile(args: ProfileArgs): Promise<ProfileView>;
  /** Options + per-option stake-weighted tally for a poll host id. */
  poll(hostId: bigint): Promise<PollView>;
  /** The viewer's chosen option index for a poll, or null if they have not cast. */
  viewerPollChoice(hostId: bigint, who: Ss58): Promise<number | null>;
  /**
   * Option labels plus the current choice of each NAMED account in a poll. The account list is bounded
   * by the caller (the replies actually on screen), so this never enumerates a poll's whole voter set.
   * Empty labels when the host is not a poll.
   */
  pollChoices(hostId: bigint, authors: readonly Ss58[]): Promise<PollChoices>;
  /**
   * Everyone who has cast in a poll, with their current choice, the option labels, and whether the read
   * hit its cap. `truncated` rides along rather than being inferred from `voters.length` downstream,
   * because a wrapper (the serve denylist) can shorten the list after the cap has already bitten.
   */
  pollVoters(hostId: bigint): Promise<PollRoster>;
  /**
   * ONE PAGE of a poll's voters, resuming after `after` (null to start). The roster surface uses this;
   * {@link FeedSource.pollVoters} remains for callers that genuinely want a bounded one-shot.
   *
   * Paged because the one-shot pulls the whole `PollVotes` prefix — about 0.42 KB per voter, so ~4 MB at
   * ten thousand — and then renders 200 of it. See lib/chain/poll-voters.
   *
   * `nextCursor` is null at the end of the prefix.
   *
   * `labels` comes back ONLY on the first page (`after` null/absent) and is undefined thereafter: the
   * option names are a property of the poll, not of a page, and re-sending them with every page would
   * pay for them once per scroll. The caller holds the first page's copy.
   */
  /**
   * The TRUE per-option voter counts for a poll, from `PollTally`.
   *
   * Split from {@link FeedSource.pollVotersPage} because the two have completely different cost shapes
   * and therefore different eagerness. This is BOUNDED — one row per option, so a handful however large
   * the electorate — and is read up front so the roster can say how many voted before anyone opens it.
   * The voter pages are unbounded and stay lazy. Folding this into the first page created a
   * chicken-and-egg: the disclosure needs the count to render, and the count only arrived once opened.
   */
  pollVoterTotals(hostId: bigint): Promise<{ label: string; count: number }[]>;
  pollVotersPage(
    hostId: bigint,
    opts?: { after?: string | null; limit?: number },
  ): Promise<{
    voters: PollVoter[];
    nextCursor: string | null;
    labels?: string[];
  }>;
  /** The viewer's own vote state on a post. */
  viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState>;
  /** Followers/following ids + counts for an account. */
  followEdges(who: Ss58): Promise<FollowEdges>;
  /** Ranked who-to-follow suggestions. */
  whoToFollow(who: Ss58 | null, limit: number): Promise<Suggestion[]>;
  /** Author search by display name. */
  searchPeople(q: string, limit: number): Promise<Suggestion[]>;
}
