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
import type { PollChoices, PollRoster } from "@/lib/chain/social-reads";

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
   * A reconstructed thread for `rootId`. `viewer` (the connected account, when known) lets the source
   * stamp each post's `myVote` overlay node-side in the same state_call.
   */
  thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView>;
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
  /** The viewer's own vote state on a post. */
  viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState>;
  /** Followers/following ids + counts for an account. */
  followEdges(who: Ss58): Promise<FollowEdges>;
  /** Ranked who-to-follow suggestions. */
  whoToFollow(who: Ss58 | null, limit: number): Promise<Suggestion[]>;
  /** Author search by display name. */
  searchPeople(q: string, limit: number): Promise<Suggestion[]>;
}
