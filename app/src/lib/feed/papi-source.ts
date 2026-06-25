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
// What it CANNOT do, honestly (caps say so; the UI hides these — it never greys-with-explanation):
//   - substring search (no indexer),
//   - the reverse followers LIST + ranked who-to-follow display names / bios / avatars beyond chain
//     storage (reverse-index aggregation / denormalized Author fields).
//
// This file does NOT modify reads.ts — it only consumes it (+ social-reads.ts).

import { type Observable, from, startWith, switchMap } from "rxjs";
import { FixedSizeBinary } from "polkadot-api";
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
import { byIdDesc } from "@/lib/feed/live";
import {
  readPoll,
  readViewerPostState,
  readViewerPollChoice,
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

const DEFAULT_FIRST = 50;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

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

export function createPapiFeedSource(api: CognoApi): FeedSource {
  const caps: FeedCaps = {
    search: false,
    // The feed pages by post id now (keyed `Posts.getValue` walks down the `NextPostId` counter), so
    // cursor "load more" is served node-direct — no indexer needed. (Search still needs the indexer.)
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
    // the Replies reverse tab still needs the indexer (no reverse replies-by-author map on-chain).
    profileReplies: false,
    // the Likes reverse tab is node-served via the spec-118 VotesByAccount reverse index.
    profileLikes: true,
    // who-to-follow is ranked node-direct by the FollowerCount map (a popularity proxy; no SCORE).
    whoToFollow: true,
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
    if (q.search) {
      throw new UnsupportedQuery(
        "search needs the indexer — set a GraphQL endpoint, or read the live feed.",
      );
    }
    const first = q.first ?? DEFAULT_FIRST;
    // The cursor is the highest post id NOT yet returned (encoded decimal). Decode it to a beforeId.
    const beforeId = q.after != null ? BigInt(q.after) : undefined;

    // Following feed: top-level posts authored by the accounts `target` follows, paged down the id
    // counter with a followee-set filter (the forward Following map + the keyed id walk — no full
    // snapshot). Sparse followees ⇒ a longer walk, same cost class as the old full-set filter.
    if (q.tab === "following" || q.followeeOf) {
      const target = q.followeeOf ?? q.authorId;
      if (!target) return emptyPage();
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

    // Author feed: one author's top-level posts, paged over their ByAuthor id list.
    if (q.authorId) {
      return toFeedPage(await getAuthorFeedPage(api, q.authorId, { beforeId, limit: first }));
    }

    // Global feed (forYou / default): newest top-level posts, paged down the NextPostId counter.
    return toFeedPage(await getGlobalFeedPage(api, { beforeId, limit: first }));
  }

  async function thread(rootId: bigint): Promise<ThreadView> {
    // Keyed thread read: focal + ancestor walk + the focal's direct replies from `RepliesByParent`
    // (one parent's children) + the `ReplyCount` aggregate — no full-snapshot scan (reads.ts).
    const { root: rootRaw, ancestors: ancestorsRaw, replies: repliesRaw, replyCount } =
      await getThread(api, rootId);
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
    // The Replies tab needs the indexer (no reverse replies-by-author map on-chain) — the UI hides it
    // node-direct. The Likes tab IS node-served below (spec-118 VotesByAccount reverse index).
    if (args.tab === "replies") {
      throw new UnsupportedQuery("the Replies tab needs the indexer — set a GraphQL endpoint.");
    }
    // Resolve to an account: directly, or via the reverse AccountOf[identityHash] map.
    let account: Ss58 | undefined = args.author;
    if (!account && args.identityHash) {
      account = await api.query.CognoGate.AccountOf.getValue(
        FixedSizeBinary.fromBytes(hexToBytes(args.identityHash)),
      );
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

    const [postCount, pkh, weight, followerCount, followingCount, profileRec, pinned] =
      await Promise.all([
        // The header "N posts" = the ByAuthor index length: an O(1) count of ALL the author's posts
        // (replies/quotes included). DELIBERATE TRADEOFF: the Posts tab below lists top-level only, so
        // the header can exceed the visible top-level cards for an author who replies — but the exact
        // top-level count has no O(1) source on-chain (it required loading every post, the full-set read
        // this change removes). Total-authored is the honest, scalable stat; a precise top-level count
        // would need a new on-chain counter. The indexer reader can still report its own count.
        authorPostCount(api, account),
        api.query.CognoGate.PkhOf.getValue(account),
        readWeight(api, account),
        api.query.Microblog.FollowerCount.getValue(account),
        api.query.Microblog.FollowingCount.getValue(account),
        api.query.Profile.Profiles.getValue(account),
        api.query.Profile.PinnedPost.getValue(account),
      ]);
    const banned = pkh === undefined;
    const identityHash =
      args.identityHash ??
      (pkh ? (pkh as unknown as { asHex: () => string }).asHex() : null);

    // Posts tab: the author's own top-level posts, FIRST PAGE only (load-more continues via
    // `page({authorId, after})`). Likes tab: the posts this account up-voted (spec-118 reverse map).
    let posts: CognoPost[];
    let endCursor: string | null = null;
    let hasNextPage = false;
    if (args.tab === "likes") {
      const likedIds = (await api.query.Microblog.VotesByAccount.getEntries(account)).map(
        (e) => e.keyArgs[1] as bigint,
      );
      const likedPosts = (await Promise.all(likedIds.map((id) => getPost(api, id))))
        .filter((p): p is CognoPost => p !== undefined)
        .sort(byIdDesc);
      // Liked posts are by OTHER authors → flag each by its own author's revocation, not `account`.
      posts = await flagRevocations(likedPosts);
    } else {
      const pg = await getAuthorFeedPage(api, account, { limit: DEFAULT_FIRST });
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

  // ── who-to-follow: ranked node-direct by the FollowerCount map (popularity proxy — the node has no
  // SCORE). The hook filters out self + already-followed, so we just return the top-N by follower
  // count with display fields. getEntries() scans the whole counter map — fine on a testnet; the
  // indexer is the scalable path. ──
  async function whoToFollow(_who: Ss58 | null, limit: number): Promise<Suggestion[]> {
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

  // ── still indexer-only: caps say so; calling this is a logic slip ──
  function searchPeople(): Promise<Suggestion[]> {
    throw new UnsupportedQuery("people search needs the indexer — set a GraphQL endpoint.");
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
