// The PAPI-direct FeedSource — the ONE reader. It serves feed / thread / profile / search / people /
// replies out of the node's `MicroblogApi` runtime API, plus direct storage lookups for the social
// aggregates, behind the FeedSource interface.
//
// SCALING: this reader NEVER pulls the full `Posts` set. Feeds are cursor-paged by post id; threads
// read ONE parent's children via the `RepliesByParent` reverse map + the `ReplyCount` aggregate;
// liveness rides `NextPostId.watchValue` (`liveHeadId`), NOT `Posts.watchEntries()`.
//
// CHAIN-TRUTH for the things the indexer derives:
//   - revocation = `CognoGate.PkhOf[account]` ABSENT (revoke removes the binding; the posts stay).
//   - identity-hash → account is the reverse `CognoGate.AccountOf[hash]` map.
//   - weight is `TalkStake.AllowedStake[account]` (Cardano-sourced lovelace, M2d).
//   - vote/poll tallies + the viewer's own state come from the aggregate maps (social-reads.ts).
//
// Since the all-Rust restart there is NO indexer: the node serves EVERYTHING the SubQuery indexer used
// to. The last three folded in at P8b are substring post search + people search
// (`MicroblogApi.search_posts` / `search_people`, the in-runtime linear scan) and the reverse Replies
// tab (`author_replies_page`).
//
// The keyed pre-spec-120 fallback path this reader used to carry is GONE — see feed/source.ts. The one
// remaining fallback, in `thread()`, is a RESILIENCE path (a viral post can blow the state_call limit),
// not a compatibility one.
//
// This file does NOT modify reads.ts — it only consumes it (+ social-reads.ts).

import type { Observable } from "rxjs";
import type { SizedHex } from "polkadot-api";
import {
  authorPostCount,
  getThread,
  watchLatestPostId,
  binTextOpt,
  type IdPage,
} from "@/lib/chain/reads";
import {
  nodeGlobalFeedPage,
  nodeAuthorFeedPage,
  nodeFollowingFeedPage,
  nodeThread,
  nodeAuthorPostCount,
  nodeSearchPosts,
  nodeAuthorRepliesPage,
  nodeSearchPeople,
  nodeWhoToFollow,
  nodeLikesPage,
} from "@/lib/chain/node-reads";
import {
  readPoll,
  readViewerPostState,
  readViewerPollChoice,
} from "@/lib/chain/social-reads";
import type {
  CognoApi,
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
import type { FeedSource, ProfileArgs } from "./source";
import { FEED_PAGE_SIZE } from "./constants";
import { normalizeQuery } from "@/lib/search";

// The seam's first-page / default window (profile Posts first page + global `page()` default).
// Shared with the hooks' "load more" size so first paint and load-more match.
const DEFAULT_FIRST = FEED_PAGE_SIZE;

/** Is this account's identity binding still live? `PkhOf` present ⇒ not revoked. */
async function isRevoked(api: CognoApi, account: Ss58): Promise<boolean> {
  const v = await api.query.CognoGate.PkhOf.getValue(account);
  return v === undefined;
}

/** The Cardano-sourced talk weight (lovelace) for an account, when set. */
async function readWeight(api: CognoApi, account: Ss58): Promise<bigint | undefined> {
  const v = await api.query.TalkStake.AllowedStake.getValue(account);
  return v == null ? undefined : BigInt(v);
}

/** The accounts `who` follows — the forward `Following` double-map (key2 = followee). */
async function readFollowees(api: CognoApi, who: Ss58): Promise<Ss58[]> {
  const entries = await api.query.Microblog.Following.getEntries(who);
  return entries.map((e) => e.keyArgs[1] as Ss58);
}

/** The accounts following `who` — the reverse `Followers` double-map (key2 = follower; spec-118). */
async function readFollowers(api: CognoApi, who: Ss58): Promise<Ss58[]> {
  const entries = await api.query.Microblog.Followers.getEntries(who);
  return entries.map((e) => e.keyArgs[1] as Ss58);
}

/** Decode a pallet-profile `BoundedVec<u8>` field (PAPI Binary) to a trimmed string, or undefined.
 *  The shared decoder (reads.ts `binTextOpt`) so feed + profile reads can't disagree on empty/trim. */
const profileText = binTextOpt;

export function createPapiFeedSource(api: CognoApi): FeedSource {

  /** Stamp the revocation flag onto a set of posts, reading PkhOf once per distinct author. */
  async function flagRevocations(posts: CognoPost[]): Promise<CognoPost[]> {
    const authors = Array.from(new Set(posts.map((p) => p.author)));
    const revokedEntries = await Promise.all(
      authors.map(async (a) => [a, await isRevoked(api, a)] as const),
    );
    const revoked = new Map(revokedEntries);
    return posts.map((p) => ({ ...p, authorRevoked: revoked.get(p.author) === true }));
  }

  /** Wrap an id-paged result (+ revocation flags) into the FeedPage shape the seam returns. */
  async function toFeedPage(idp: IdPage): Promise<FeedPage> {
    const posts = await flagRevocations(idp.posts);
    return {
      posts,
      endCursor: idp.nextCursor != null ? String(idp.nextCursor) : null,
      hasNextPage: idp.nextCursor != null,
      asOf: null,
    };
  }

  // A FRESH empty page each call (never a shared singleton a caller could mutate in place).
  const emptyPage = (): FeedPage => ({
    posts: [],
    endCursor: null,
    hasNextPage: false,
    totalCount: 0,
    asOf: null,
  });

  async function page(q: FeedQuery): Promise<FeedPage> {
    const first = q.first ?? DEFAULT_FIRST;
    // The cursor is the highest post id NOT yet returned (encoded decimal). Decode it to a beforeId.
    const beforeId = q.after != null ? BigInt(q.after) : undefined;
    const viewer = q.viewer;

    // Search: ASCII-case-insensitive substring scan over post bodies (MicroblogApi.search_posts, the
    // in-runtime linear scan). A whitespace-only term falls through to the global feed (matching the
    // old `if (q.search)` empty-string behaviour, no throw).
    if (q.search && q.search.trim().length > 0) {
      return toFeedPage(
        await nodeSearchPosts(api, q.search.trim(), {
          beforeId,
          limit: first,
          viewer,
          maxHops: q.maxHops,
        }),
      );
    }

    // Replies tab (profile): one author's replies (`parent != None`), newest-first
    // (MicroblogApi.author_replies_page). DEFENSIVE + forward-compatible: today the Replies first page
    // is built in profile() and useProfile gates replies load-more OFF (its load-more query omits
    // `tab`), so no caller reaches here — but it is placed BEFORE the `q.authorId` author-feed branch
    // so that IF a `{tab:"replies", authorId, after}` page is ever issued it routes to replies.
    if (q.tab === "replies" && q.authorId) {
      return toFeedPage(
        await nodeAuthorRepliesPage(api, q.authorId, { beforeId, limit: first, viewer }),
      );
    }

    // Following feed: top-level posts authored by the accounts `target` follows.
    if (q.tab === "following" || q.followeeOf) {
      const target = q.followeeOf ?? q.authorId;
      if (!target) return emptyPage();
      // The runtime merges ByAuthor over Following[target] node-side (no id-walk filter).
      return toFeedPage(await nodeFollowingFeedPage(api, target, { beforeId, limit: first }));
    }

    // Author feed: one author's top-level posts.
    if (q.authorId) {
      return toFeedPage(
        await nodeAuthorFeedPage(api, q.authorId, { beforeId, limit: first, viewer }),
      );
    }

    // Global feed (forYou / default): newest top-level posts.
    return toFeedPage(await nodeGlobalFeedPage(api, { beforeId, limit: first, viewer }));
  }

  async function thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView> {
    // MicroblogApi: focal + ancestors + replies enriched + viewer-overlaid in one state_call.
    //
    // The keyed `getThread` fallback below is a RESILIENCE path, not a compatibility one, and it stays:
    // a thread read carries no cursor, so falling back is always position-safe, and if the state_call
    // FAILS (a viral post with tens of thousands of replies can hit a resource limit — `thread`
    // enumerates them all in one shot) the keyed per-card reads fetch incrementally and can succeed
    // where one big call can't. (The feed paths are deliberately NOT wrapped this way: their node
    // cursor is a `TopLevelPosts` seq but the keyed cursor is a post id, so a mid-page fallback would
    // cross-wire the cursor.)
    const raw = await nodeThread(api, rootId, viewer).catch(() => getThread(api, rootId));
    const { root: rootRaw, ancestors: ancestorsRaw, replies: repliesRaw, replyCount } = raw;
    const flagged = await flagRevocations([rootRaw, ...ancestorsRaw, ...repliesRaw]);
    const root = flagged[0];
    const ancestors = flagged.slice(1, 1 + ancestorsRaw.length);
    const replies = flagged.slice(1 + ancestorsRaw.length);
    const lastActivity = [root, ...replies].reduce(
      (max, p) => (p.at > max ? p.at : max),
      root.at,
    );
    return { root, ancestors, replies, replyCount, lastActivity };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
    // Both reverse tabs are node-served since the all-Rust restart: Replies via the spec-200
    // `author_replies_page` (below), Likes via the spec-118 `VotesByAccount` reverse index (below).
    // Resolve to an account: directly, or via the reverse AccountOf[identityHash] map.
    let account: Ss58 | undefined = args.author;
    if (!account && args.identityHash) {
      // PAPI v2: the `[u8;32]` storage key is supplied as a 0x-hex string (SizedHex<32>), not a FixedSizeBinary.
      account = await api.query.CognoGate.AccountOf.getValue(args.identityHash as SizedHex<32>);
    }
    if (!account) {
      return {
        author: null,
        identityHash: args.identityHash ?? null,
        postCount: 0,
        banned: false,
        page: { posts: [], endCursor: null, hasNextPage: false, totalCount: 0, asOf: null },
      };
    }

    const [
      postCount,
      pkh,
      weight,
      followerCount,
      followingCount,
      profileRec,
      pinned,
    ] = await Promise.all([
        // The header "N posts" is the author's TOP-LEVEL post count, matching the top-level cards in
        // the Posts tab below — served O(1) off the on-chain `TopLevelByAuthor` counter. The keyed
        // `authorPostCount` catch is a resilience path (its ByAuthor length counts replies too, so it
        // is a slightly looser number — acceptable only as a degradation, never as the primary).
        nodeAuthorPostCount(api, account).catch(() => authorPostCount(api, account)),
        api.query.CognoGate.PkhOf.getValue(account),
        readWeight(api, account),
        api.query.Microblog.FollowerCount.getValue(account),
        api.query.Microblog.FollowingCount.getValue(account),
        // At BEST, alone among the reads in this batch, because this is the one row here that is
        // READ-AFTER-WRITE: saving or clearing a profile invalidates the hover cache (ProfileHoverCard's
        // `invalidateHoverProfile`, called on the line after `invalidateAccountProfile`) from an
        // `onConfirm` that fires at `inBestBlock` — blocks before finalization. At PAPI's finalized
        // default the refill returns the PRE-save row and the hover cache, which has no TTL, pins it for
        // the session: the old name, or a name the user just CLEARED, keeps rendering. Same rule and same
        // reason as the sibling read in useAccountProfile; see `BEST` in lib/chain/node-reads.
        api.query.Profile.Profiles.getValue(account, { at: "best" }),
        api.query.Profile.PinnedPost.getValue(account),
        // (The spec-202 account reputation tally + the viewer's own vote used to be read here. They now
        // live in their own session cache — `useAccountVoteState` — because the vote control needs them
        // FRESH after a write and this read is not invalidated by one. Reading them here as well meant a
        // profile page re-read both storage keys every block and threw the results away.)
      ]);
    const banned = pkh === undefined;
    // PAPI v2: PkhOf's `[u8;32]` value decodes to a 0x-hex string, not a Binary with `.asHex()`.
    const identityHash = args.identityHash ?? pkh ?? null;

    // Posts tab: the author's own top-level posts, FIRST PAGE only (load-more continues via
    // `page({authorId, after})`). Likes tab: the posts this account up-voted (spec-118 reverse map).
    let posts: CognoPost[];
    let endCursor: string | null = null;
    let hasNextPage = false;
    if (args.tab === "likes") {
      // Likes tab (likes_page): one bounded, viewer-overlaid FIRST page — matching the Replies tab's
      // first-page-only pattern (useProfile gates load-more off for reverse tabs). Liked posts are by
      // OTHER authors → flag each by its own author's revocation.
      const pg = await nodeLikesPage(api, account, { limit: DEFAULT_FIRST, viewer: args.viewer });
      posts = await flagRevocations(pg.posts);
      endCursor = pg.nextCursor != null ? String(pg.nextCursor) : null;
      hasNextPage = pg.nextCursor != null;
    } else if (args.tab === "replies") {
      // Replies tab: the author's own replies (`parent != None`), newest-first (author_replies_page).
      // FIRST PAGE only here; useProfile gates load-more off for this tab (its load-more query omits
      // `tab`, so it would route to the top-level author feed).
      const pg = await nodeAuthorRepliesPage(api, account, {
        limit: DEFAULT_FIRST,
        viewer: args.viewer,
      });
      // The author's own replies → stamp the author's revocation directly (all the same author).
      posts = pg.posts.map((p) => ({ ...p, authorRevoked: banned }));
      endCursor = pg.nextCursor != null ? String(pg.nextCursor) : null;
      hasNextPage = pg.nextCursor != null;
    } else {
      // Posts tab: the author's top-level posts, enriched + viewer-overlaid in one state_call.
      // `args.viewer` (the connected account) threads the overlay through when present.
      const pg = await nodeAuthorFeedPage(api, account, {
        limit: DEFAULT_FIRST,
        viewer: args.viewer,
      });
      // The author's own posts → stamp the author's revocation directly (all the same author).
      posts = pg.posts.map((p) => ({ ...p, authorRevoked: banned }));
      endCursor = pg.nextCursor != null ? String(pg.nextCursor) : null;
      hasNextPage = pg.nextCursor != null;
    }

    return {
      author: account,
      identityHash,
      postCount,
      banned,
      weight,
      // display fields + counts are ALL node-served now (pallet-profile + the follow counters + the
      displayName: profileText(profileRec?.display_name),
      bio: profileText(profileRec?.bio),
      avatar: profileText(profileRec?.avatar),
      banner: profileText(profileRec?.banner),
      location: profileText(profileRec?.location),
      website: profileText(profileRec?.website),
      pinnedPostId: pinned == null ? undefined : BigInt(pinned),
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
      page: {
        posts,
        endCursor,
        hasNextPage,
        totalCount: posts.length,
        asOf: null,
      },
    };
  }

  // ── spec-113 social: the node serves these from the aggregate maps ──
  function poll(hostId: bigint): Promise<PollView> {
    return readPoll(api, hostId);
  }

  function viewerPollChoice(hostId: bigint, who: Ss58): Promise<number | null> {
    return readViewerPollChoice(api, hostId, who);
  }

  function viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState> {
    return readViewerPostState(api, post, who);
  }

  // ── follow graph: both directions node-served (forward Following + reverse Followers, spec-118) ──
  async function followEdges(who: Ss58): Promise<FollowEdges> {
    const [following, followers, followerCount, followingCount] = await Promise.all([
      readFollowees(api, who),
      readFollowers(api, who),
      api.query.Microblog.FollowerCount.getValue(who),
      api.query.Microblog.FollowingCount.getValue(who),
    ]);
    return {
      following,
      followers,
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
    };
  }

  // ── who-to-follow: `who_to_follow` — ByAuthor members ranked by follower count, INCLUDING
  // 0-follower authors, so the panel is non-empty on a fresh-genesis chain (where nobody has followers
  // yet). The hook filters out self + already-followed. ──
  async function whoToFollow(_who: Ss58 | null, limit: number): Promise<Suggestion[]> {
    return nodeWhoToFollow(api, limit);
  }

  // ── people search: `MicroblogApi.search_people` — display-name substring, ranked by follower count. ──
  async function searchPeople(q: string, limit: number): Promise<Suggestion[]> {
    // Normalize at the source so every caller (Explore, a future typeahead) shares one cache key /
    // result set; an empty term after normalization has no matches to scan for.
    const term = normalizeQuery(q);
    if (term.length === 0) return [];
    return nodeSearchPeople(api, term, limit);
  }

  // The liveness signal the home feed pages off (a new post bumps NextPostId). No `watchEntries`.
  function liveHeadId(): Observable<bigint | null> {
    return watchLatestPostId(api);
  }

  return {
    liveHeadId,
    page,
    thread,
    profile,
    poll,
    viewerPollChoice,
    viewerPostState,
    followEdges,
    whoToFollow,
    searchPeople,
  };
}
