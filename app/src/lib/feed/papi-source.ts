// The PAPI-direct FeedSource: the always-available fallback reader. It wraps the id-paged chain reads
// (getGlobalFeedPage / getAuthorFeedPage / getThread / getPost) plus direct storage lookups, behind
// the same FeedSource interface as the indexer.
//
// SCALING (spec 119): this reader NEVER pulls the full `Posts` set. The global/author feeds PAGE by
// post id (keyed `Posts.getValue` walks, O(page)); threads read ONE parent's children via the
// `RepliesByParent` reverse map + the `ReplyCount` aggregate; liveness rides `NextPostId.watchValue`
// (`liveHeadId`), NOT `Posts.watchEntries()`. So `caps.pagination` is now TRUE.
//
// CHAIN-TRUTH for the things the indexer derives:
//   - revocation = `CognoGate.PkhOf[account]` ABSENT (revoke removes the binding; the posts stay).
//   - identity-hash → account is the reverse `CognoGate.AccountOf[hash]` map.
//   - weight is `TalkStake.AllowedStake[account]` (Cardano-sourced lovelace, M2d).
//   - vote/poll tallies + the viewer's own state come from the aggregate maps (social-reads.ts).
//
// Since the all-Rust restart (spec 200) there is NO indexer and NO remaining indexer-only capability:
// the node serves EVERYTHING the SubQuery indexer used to. The last three folded in at P8b are
// substring post search + people search (`MicroblogApi.search_posts` / `search_people`, the Option-1
// in-runtime linear scan) and the reverse Replies tab (`author_replies_page`). Every `caps` flag is now
// node-served (the spec-200 read API is runtime-detected per node — see `nodeFeedApiReady`).
//
// This file does NOT modify reads.ts — it only consumes it (+ social-reads.ts).

import { type Observable, from, startWith, switchMap } from "rxjs";
import { CompatibilityLevel, type SizedHex } from "polkadot-api";
import {
  getPost,
  getGlobalFeedPage,
  getAuthorFeedPage,
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
import { byIdDesc } from "@/lib/feed/live";
import {
  readPoll,
  readViewerPostState,
  readViewerPollChoice,
  readAccountVoteTally,
  readViewerAccountVote,
} from "@/lib/chain/social-reads";
import type {
  CognoApi,
  CognoPost,
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
import {
  type FeedSource,
  type FeedCaps,
  type ProfileArgs,
  UnsupportedQuery,
} from "./source";
import { FEED_PAGE_SIZE } from "./constants";
import { normalizeQuery } from "@/lib/search";

// The seam's first-page / default window (profile Posts first page + global `page()` default + the
// `watch()` live window). Shared with the hooks' "load more" size so first paint and load-more match.
const DEFAULT_FIRST = FEED_PAGE_SIZE;

/** Is this account's identity binding still live? `PkhOf` present ⇒ not revoked. */
async function isRevoked(api: CognoApi, account: Ss58): Promise<boolean> {
  const v = await api.query.CognoGate.PkhOf.getValue(account);
  return v === undefined;
}

/** The Cardano-sourced talk weight (lovelace) for an account, when set. */
async function readWeight(api: CognoApi, account: Ss58): Promise<bigint | undefined> {
  const v = await api.query.TalkStake.AllowedStake.getValue(account);
  return v == null ? undefined : BigInt(v as unknown as bigint);
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

/**
 * RUNTIME-DETECT whether the connected node serves the spec-120 `MicroblogApi` reads. PAPI's
 * `isCompatible` compares the call against the node's live metadata: a pre-120 node (no `MicroblogApi`
 * entry) reports `Incompatible` ⇒ `false` WITHOUT throwing, so the reader degrades to the keyed path.
 * Any throw (transport blip, older PAPI) is caught ⇒ `false` (fail-closed onto the always-available
 * keyed fallback). The result is memoized as a `Promise<boolean>` so the probe runs at most once per
 * source; `page()`/`thread()`/`profile()` await it before choosing a read path.
 */
function detectNodeFeedApi(api: CognoApi): Promise<boolean> {
  // Probe the NEWEST method the flag authorizes (`search_posts`, spec-200) — NOT `feed_page` (spec-120).
  // This one boolean gates feed_page AND the spec-200 search/replies/people methods, so it must probe the
  // latest of them: a node with feed_page but not the P8b methods must report false (degrade to the keyed
  // path) rather than true (which would throw a raw runtime-method error on the missing search/replies calls).
  //
  // PAPI v2 moved the per-call compat check off the RuntimeCall and onto the static-apis snapshot:
  // `getStaticApis()` pulls the node's live metadata, then `.compat.apis.MicroblogApi.search_posts
  // .isCompatible(level)` is a SYNCHRONOUS boolean. A pre-200 node (no `MicroblogApi` entry) reports
  // Incompatible ⇒ false WITHOUT throwing; any throw (transport blip, stale descriptors) is caught ⇒
  // false, failing closed onto the always-available keyed fallback.
  return api
    .getStaticApis()
    .then((s) =>
      s.compat.apis.MicroblogApi.search_posts.isCompatible(CompatibilityLevel.BackwardsCompatible),
    )
    .catch(() => false);
}

export function createPapiFeedSource(api: CognoApi): FeedSource {
  // Lazy, memoized detection — the probe fires on the first read that consults it, not at construction
  // (createPapiFeedSource stays synchronous, as the selector + tests expect).
  let nodeFeedApi$: Promise<boolean> | undefined;
  const nodeFeedApiReady = (): Promise<boolean> => (nodeFeedApi$ ??= detectNodeFeedApi(api));

  const caps: FeedCaps = {
    // Substring post search is node-served since the all-Rust restart (spec-200 MicroblogApi.search_posts,
    // the Option-1 in-runtime linear scan) — the per-call path runtime-detects the API (nodeFeedApiReady).
    search: true,
    // The feed pages by post id now (keyed `Posts.getValue` walks down the `NextPostId` counter), so
    // cursor "load more" is served node-direct — no indexer needed.
    pagination: true,
    threads: true,
    revocation: true,
    // The node serves the aggregate tally/poll/viewer maps directly → tallies on.
    tallies: true,
    // The node serves the full follow graph directly: followees + followers (spec-118 Followers
    // reverse map) + follow-state + the Following feed + the FollowerCount/FollowingCount counters.
    follows: true,
    // pallet-profile stores display name / bio / avatar / banner / location / website / pinned → node.
    profiles: true,
    // the Replies reverse tab is node-served since the all-Rust restart (spec-200 author_replies_page
    // scans the author's own ByAuthor index in reverse — parent != None only, no reverse map needed).
    profileReplies: true,
    // the Likes reverse tab is node-served via the spec-118 VotesByAccount reverse index.
    profileLikes: true,
    // who-to-follow is ranked node-direct by the FollowerCount map (a popularity proxy; no SCORE).
    whoToFollow: true,
    // The PAPI-direct reader CAN serve enriched, viewer-aware pages via the spec-120 MicroblogApi —
    // when the connected node supports it. This advertises the capability; whether the LIVE node
    // actually has the API is detected per-source (`nodeFeedApiReady`) and falls back to the keyed
    // reads on a pre-120 node. The overlay-bypass in useViewerStates keys on each post's `myVote`
    // presence (data-driven), so a fallback page is handled correctly regardless of this flag.
    nodeFeedApi: true,
  };

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
    // Prefer the spec-200 MicroblogApi (one state_call, viewer overlay stamped node-side) when the
    // connected node serves it; otherwise fall through to the keyed reads UNCHANGED.
    const nodeApi = await nodeFeedApiReady();

    // Search: node-served ASCII-case-insensitive substring scan over post bodies (spec-200
    // MicroblogApi.search_posts, the Option-1 in-runtime linear scan). Search has NO keyed fallback —
    // there is no on-chain text index — so a pre-200 node throws; the caller gates on caps.search (the
    // SearchBar/explore only query with a non-empty term). A whitespace-only term falls through to the
    // global feed (matching the old `if (q.search)` empty-string behaviour, no throw).
    if (q.search && q.search.trim().length > 0) {
      if (!nodeApi) {
        throw new UnsupportedQuery("search needs a spec-200 node (MicroblogApi.search_posts).");
      }
      return toFeedPage(
        await nodeSearchPosts(api, q.search.trim(), { beforeId, limit: first, viewer }),
      );
    }

    // Replies tab (profile): one author's replies (`parent != None`), newest-first, node-served
    // (spec-200 MicroblogApi.author_replies_page). No keyed fallback (replies-by-author is a spec-200
    // node read). DEFENSIVE + forward-compatible: today the Replies first page is built in profile()
    // and useProfile gates replies load-more OFF (its load-more query omits `tab`), so no caller
    // reaches here — but it is placed BEFORE the `q.authorId` author-feed branch so that IF a
    // `{tab:"replies", authorId, after}` page is ever issued it routes to replies, not the author feed.
    if (q.tab === "replies" && q.authorId) {
      if (!nodeApi) {
        throw new UnsupportedQuery(
          "the Replies tab needs a spec-200 node (MicroblogApi.author_replies_page).",
        );
      }
      return toFeedPage(
        await nodeAuthorRepliesPage(api, q.authorId, { beforeId, limit: first, viewer }),
      );
    }

    // Following feed: top-level posts authored by the accounts `target` follows.
    if (q.tab === "following" || q.followeeOf) {
      const target = q.followeeOf ?? q.authorId;
      if (!target) return emptyPage();
      // Node path: the runtime merges ByAuthor over Following[target] node-side (no id-walk filter).
      if (nodeApi) {
        return toFeedPage(await nodeFollowingFeedPage(api, target, { beforeId, limit: first }));
      }
      // Keyed fallback: page down the id counter with a followee-set filter (forward Following map +
      // the keyed id walk — no full snapshot). Sparse followees ⇒ a longer walk, same cost class.
      const followees = new Set(await readFollowees(api, target));
      if (followees.size === 0) return emptyPage();
      return toFeedPage(
        await getGlobalFeedPage(api, {
          beforeId,
          limit: first,
          keep: (v) => followees.has(v.author),
        }),
      );
    }

    // Author feed: one author's top-level posts.
    if (q.authorId) {
      if (nodeApi) {
        return toFeedPage(
          await nodeAuthorFeedPage(api, q.authorId, { beforeId, limit: first, viewer }),
        );
      }
      // Keyed fallback: page over the author's ByAuthor id list.
      return toFeedPage(await getAuthorFeedPage(api, q.authorId, { beforeId, limit: first }));
    }

    // Global feed (forYou / default): newest top-level posts.
    if (nodeApi) {
      return toFeedPage(await nodeGlobalFeedPage(api, { beforeId, limit: first, viewer }));
    }
    // Keyed fallback: page down the NextPostId counter.
    return toFeedPage(await getGlobalFeedPage(api, { beforeId, limit: first }));
  }

  async function thread(rootId: bigint, viewer?: Ss58): Promise<ThreadView> {
    // Node path (spec-120): focal + ancestors + replies enriched + viewer-overlaid in one state_call.
    // Keyed fallback: focal + ancestor walk + the focal's direct replies from `RepliesByParent` (one
    // parent's children) + the `ReplyCount` aggregate — no full-snapshot scan (reads.ts).
    //
    // A thread read carries no cursor, so falling back is always position-safe: if the node-served
    // call FAILS (e.g. a state_call hitting a resource limit on a viral post with tens of thousands of
    // replies — `thread` enumerates them all in one shot), drop to the keyed per-card reads, which
    // fetch incrementally and can succeed where one big state_call can't. (The feed paths are NOT
    // wrapped this way: their node cursor is a `TopLevelPosts` seq but the keyed cursor is a post id,
    // so a mid-page fallback would cross-wire the cursor — and a `feed_page` failure is far less likely.)
    const raw = (await nodeFeedApiReady())
      ? await nodeThread(api, rootId, viewer).catch(() => getThread(api, rootId))
      : await getThread(api, rootId);
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

    const nodeApiForCount = await nodeFeedApiReady();
    const [
      postCount,
      pkh,
      weight,
      followerCount,
      followingCount,
      profileRec,
      pinned,
      accountTally,
      myAccountVote,
    ] = await Promise.all([
        // The header "N posts" is the author's TOP-LEVEL post count, matching the top-level cards in the
        // Posts tab below. spec-121 added the on-chain `TopLevelByAuthor` counter, so the node serves an
        // exact O(1) top-level count (`author_post_count`); on a pre-121 node we fall back to the keyed
        // `authorPostCount` (the ByAuthor length = ALL posts incl. replies, the documented older tradeoff).
        nodeApiForCount
          ? nodeAuthorPostCount(api, account).catch(() => authorPostCount(api, account))
          : authorPostCount(api, account),
        api.query.CognoGate.PkhOf.getValue(account),
        readWeight(api, account),
        api.query.Microblog.FollowerCount.getValue(account),
        api.query.Microblog.FollowingCount.getValue(account),
        api.query.Profile.Profiles.getValue(account),
        api.query.Profile.PinnedPost.getValue(account),
        // spec-202 account reputation tally + (when a viewer is known) their own vote on this account.
        // No viewer ⇒ `undefined` (unknown), NOT `null` (which means "known viewer, has not voted").
        readAccountVoteTally(api, account),
        args.viewer
          ? readViewerAccountVote(api, account, args.viewer)
          : Promise.resolve<"Up" | "Down" | null | undefined>(undefined),
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
      // Node-served Likes tab (spec-200 likes_page): one bounded, viewer-overlaid FIRST page — matching the
      // Replies tab's first-page-only pattern (useProfile gates load-more off for reverse tabs) — instead of
      // the unbounded VotesByAccount.getEntries + per-id getPost fan-out. Liked posts are by OTHER authors →
      // flag each by its own author's revocation. Keyed fallback (pre-200) reads the reverse map directly.
      if (await nodeFeedApiReady()) {
        const pg = await nodeLikesPage(api, account, { limit: DEFAULT_FIRST, viewer: args.viewer });
        posts = await flagRevocations(pg.posts);
        endCursor = pg.nextCursor != null ? String(pg.nextCursor) : null;
        hasNextPage = pg.nextCursor != null;
      } else {
        const likedIds = (await api.query.Microblog.VotesByAccount.getEntries(account)).map(
          (e) => e.keyArgs[1] as bigint,
        );
        const likedPosts = (await Promise.all(likedIds.map((id) => getPost(api, id))))
          .filter((p): p is CognoPost => p !== undefined)
          .sort(byIdDesc);
        posts = await flagRevocations(likedPosts);
      }
    } else if (args.tab === "replies") {
      // Replies tab: the author's own replies (`parent != None`), newest-first, node-served (spec-200
      // author_replies_page). FIRST PAGE only here; useProfile gates load-more off for this tab (its
      // load-more query omits `tab`, so it would route to the top-level author feed). No keyed fallback.
      if (!(await nodeFeedApiReady())) {
        throw new UnsupportedQuery(
          "the Replies tab needs a spec-200 node (MicroblogApi.author_replies_page).",
        );
      }
      const pg = await nodeAuthorRepliesPage(api, account, {
        limit: DEFAULT_FIRST,
        viewer: args.viewer,
      });
      // The author's own replies → stamp the author's revocation directly (all the same author).
      posts = pg.posts.map((p) => ({ ...p, authorRevoked: banned }));
      endCursor = pg.nextCursor != null ? String(pg.nextCursor) : null;
      hasNextPage = pg.nextCursor != null;
    } else {
      // Posts tab: the author's top-level posts. Node path (spec-120) enriches + viewer-overlays in
      // one state_call; the keyed path pages over the ByAuthor id list. `args.viewer` (the connected
      // account) threads the overlay through when present.
      const pg = (await nodeFeedApiReady())
        ? await nodeAuthorFeedPage(api, account, { limit: DEFAULT_FIRST, viewer: args.viewer })
        : await getAuthorFeedPage(api, account, { limit: DEFAULT_FIRST });
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
      // spec-118 reverse maps); only the Replies tab still needs the indexer (caps.profileReplies).
      displayName: profileText(profileRec?.display_name),
      bio: profileText(profileRec?.bio),
      avatar: profileText(profileRec?.avatar),
      banner: profileText(profileRec?.banner),
      location: profileText(profileRec?.location),
      website: profileText(profileRec?.website),
      pinnedPostId: pinned == null ? undefined : BigInt(pinned as unknown as bigint),
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
      // spec-202 account reputation: the tally + the viewer's own vote (drives the header control).
      accountScore: accountTally.score,
      accountUpWeight: accountTally.upWeight,
      accountDownWeight: accountTally.downWeight,
      accountUpCount: accountTally.upCount,
      accountDownCount: accountTally.downCount,
      myAccountVote,
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

  // ── who-to-follow: node-served ranking (spec-200 `who_to_follow`) — ByAuthor members ranked by follower
  // count, INCLUDING 0-follower authors, so the panel is non-empty on a fresh-genesis chain (where nobody
  // has followers yet). The hook filters out self + already-followed. Falls back to the keyed FollowerCount
  // scan only on a pre-200 node — which necessarily excludes 0-follower accounts (a pre-200 limitation,
  // not the live spec-200 chain). ──
  async function whoToFollow(_who: Ss58 | null, limit: number): Promise<Suggestion[]> {
    if (await nodeFeedApiReady()) {
      return nodeWhoToFollow(api, limit);
    }
    const entries = await api.query.Microblog.FollowerCount.getEntries();
    const ranked = entries
      .map((e) => ({ account: e.keyArgs[0] as Ss58, count: Number(e.value ?? 0) }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
    return Promise.all(
      ranked.map(async (r) => {
        const [profileRec, weight] = await Promise.all([
          api.query.Profile.Profiles.getValue(r.account),
          readWeight(api, r.account),
        ]);
        return {
          author: r.account,
          displayName: profileText(profileRec?.display_name),
          avatar: profileText(profileRec?.avatar),
          weight,
          followerCount: r.count,
        };
      }),
    );
  }

  // ── people search: node-served since the all-Rust restart (spec-200 MicroblogApi.search_people —
  // display-name substring, ranked by follower count). Gated on caps.search (+ caps.profiles) by the
  // caller; a pre-200 node throws (there is no on-chain name index to fall back to). ──
  async function searchPeople(q: string, limit: number): Promise<Suggestion[]> {
    if (!(await nodeFeedApiReady())) {
      throw new UnsupportedQuery("people search needs a spec-200 node (MicroblogApi.search_people).");
    }
    // Normalize at the source so every caller (Explore, a future typeahead) shares one cache key /
    // result set; an empty term after normalization has no matches to scan for.
    const term = normalizeQuery(q);
    if (term.length === 0) return [];
    return nodeSearchPeople(api, term, limit);
  }

  // The live feed snapshot, NextPostId-driven (NOT `watchEntries`): each counter change re-reads the
  // newest page by id. Home/profile use `liveHeadId` + `page` directly (incremental prepend); this is
  // the seam's generic `watch()` for any consumer that wants a whole live window.
  function watch(): Observable<FeedSnapshot> {
    return watchLatestPostId(api).pipe(
      switchMap(() =>
        from(page({ first: DEFAULT_FIRST }).then((p): FeedSnapshot => ({ posts: p.posts, asOf: p.asOf }))),
      ),
      startWith({ posts: [] as CognoPost[], asOf: null } as FeedSnapshot),
    );
  }

  // The liveness signal the home feed pages off (a new post bumps NextPostId). No `watchEntries`.
  function liveHeadId(): Observable<bigint | null> {
    return watchLatestPostId(api);
  }

  return {
    kind: "papi",
    caps,
    watch,
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
