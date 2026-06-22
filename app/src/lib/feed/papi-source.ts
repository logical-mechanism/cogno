// The PAPI-direct FeedSource: the always-available fallback reader. It wraps the EXISTING chain
// reads (watchFeed, buildThreadIndex, getPost) plus direct storage lookups, behind the same
// FeedSource interface as the indexer.
//
// CHAIN-TRUTH for the things the indexer derives:
//   - revocation = `CognoGate.PkhOf[account]` ABSENT (revoke removes the binding; the posts stay).
//   - identity-hash → account is the reverse `CognoGate.AccountOf[hash]` map.
//   - weight is `TalkStake.AllowedStake[account]` (Cardano-sourced lovelace, M2d).
//   - vote/poll tallies + the viewer's own state come from the aggregate maps (social-reads.ts).
//
// What it CANNOT do, honestly (caps say so; the UI hides these — it never greys-with-explanation):
//   - substring search / cursor pagination (no indexer),
//   - the reverse followers LIST + ranked who-to-follow + display names / bios / avatars (reverse-
//     index aggregation / denormalized Author fields).
// What it DOES now serve from chain storage (the forward follow graph): the viewer's followees, the
// follow-state, the Following feed, and the FollowerCount / FollowingCount counters — so follows is
// on. No surface renders the followers list (only the counts), so [] for followers stays honest.
//
// This file does NOT modify reads.ts — it only consumes it (+ social-reads.ts).

import { firstValueFrom, type Observable } from "rxjs";
import { FixedSizeBinary } from "polkadot-api";
import { watchFeed, buildThreadIndex, getPost } from "@/lib/chain/reads";
import {
  readPoll,
  readViewerPostState,
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

/** Decode a pallet-profile `BoundedVec<u8>` field (PAPI Binary) to a trimmed string, or undefined. */
function profileText(v: { asText: () => string } | undefined): string | undefined {
  const s = v?.asText().trim();
  return s ? s : undefined;
}

export function createPapiFeedSource(api: CognoApi): FeedSource {
  const caps: FeedCaps = {
    search: false,
    pagination: false,
    threads: true,
    revocation: true,
    // The node serves the aggregate tally/poll/viewer maps directly → tallies on.
    tallies: true,
    // The node serves the FORWARD follow graph directly (followees + follow-state + Following feed +
    // the FollowerCount/FollowingCount counters). The reverse followers LIST it can't (no reverse
    // map), but no surface renders that list — only counts — so follows is honestly on.
    follows: true,
    // pallet-profile stores display name / bio / avatar / pinned on-chain → node-served.
    profiles: true,
    // the Replies + Likes reverse tabs (replies-/votes-by-author) still need the indexer.
    profileTabs: false,
    // ranked who-to-follow still needs the indexer.
    whoToFollow: false,
  };

  /** One authoritative snapshot (the first watchFeed emission — entries is the full set). */
  function snapshot(): Promise<FeedSnapshot> {
    return firstValueFrom(watchFeed(api));
  }

  /** Stamp the revocation flag onto a set of posts, reading PkhOf once per distinct author. */
  async function flagRevocations(posts: CognoPost[]): Promise<CognoPost[]> {
    const authors = Array.from(new Set(posts.map((p) => p.author)));
    const revokedEntries = await Promise.all(
      authors.map(async (a) => [a, await isRevoked(api, a)] as const),
    );
    const revoked = new Map(revokedEntries);
    return posts.map((p) => ({ ...p, authorRevoked: revoked.get(p.author) === true }));
  }

  async function page(q: FeedQuery): Promise<FeedPage> {
    if (q.search) {
      throw new UnsupportedQuery(
        "search needs the indexer — set a GraphQL endpoint, or read the live feed.",
      );
    }
    if (q.after) {
      throw new UnsupportedQuery(
        "cursor pagination needs the indexer — the direct-node feed is a single live snapshot.",
      );
    }
    // Following feed: posts authored by the accounts `followeeOf` follows. Served from the forward
    // Following map + the live snapshot — first page only (no cursor; caps.pagination is off).
    if (q.tab === "following" || q.followeeOf) {
      const target = q.followeeOf ?? q.authorId;
      if (!target) {
        return { posts: [], endCursor: null, hasNextPage: false, totalCount: 0, asOf: null };
      }
      const [followees, snap] = await Promise.all([readFollowees(api, target), snapshot()]);
      const set = new Set(followees);
      const matched = snap.posts.filter((p) => set.has(p.author));
      const first = q.first ?? DEFAULT_FIRST;
      const sliced = await flagRevocations(matched.slice(0, first));
      return {
        posts: sliced,
        endCursor: null,
        hasNextPage: matched.length > first,
        totalCount: matched.length,
        asOf: snap.asOf,
      };
    }
    const snap = await snapshot();
    let posts = snap.posts;
    if (q.authorId) {
      posts = posts.filter((p) => p.author === q.authorId);
    }
    const first = q.first ?? DEFAULT_FIRST;
    const sliced = await flagRevocations(posts.slice(0, first));
    return {
      posts: sliced,
      endCursor: null,
      hasNextPage: posts.length > first,
      totalCount: posts.length,
      asOf: snap.asOf,
    };
  }

  async function thread(rootId: bigint): Promise<ThreadView> {
    const [rootRaw, snap] = await Promise.all([getPost(api, rootId), snapshot()]);
    if (!rootRaw) {
      throw new Error(`thread root #${rootId} not found on the node`);
    }
    const index = buildThreadIndex(snap.posts);
    const byId = new Map(snap.posts.map((p) => [p.id, p] as const));

    // Ancestor chain: walk `parent` up from the focal, guarding against cycles (`seen`) and dangling
    // parents (one outside the snapshot stops the walk). Collected deepest-first, returned top-down.
    const ancestorsDeep: CognoPost[] = [];
    const seen = new Set<bigint>([rootRaw.id]);
    let cursor = rootRaw.parent;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const anc = byId.get(cursor);
      if (!anc) break;
      ancestorsDeep.push(anc);
      cursor = anc.parent;
    }
    const ancestorsRaw = ancestorsDeep.reverse();

    // Direct replies, oldest-first, each annotated with its OWN child count (drives the expander).
    const childrenRaw = (index.get(String(rootId)) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((r) => ({ ...r, replyCount: index.get(String(r.id))?.length ?? 0 }));

    const flagged = await flagRevocations([rootRaw, ...ancestorsRaw, ...childrenRaw]);
    const root = flagged[0];
    const ancestors = flagged.slice(1, 1 + ancestorsRaw.length);
    const replies = flagged.slice(1 + ancestorsRaw.length);
    const lastActivity = [root, ...replies].reduce(
      (max, p) => (p.at > max ? p.at : max),
      root.at,
    );
    return { root, ancestors, replies, replyCount: replies.length, lastActivity };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
    // Replies/Likes tabs need the indexer (reverse indexes) — the UI hides them on PAPI-direct.
    if (args.tab === "replies" || args.tab === "likes") {
      throw new UnsupportedQuery(
        "the Replies/Likes tabs need the indexer — set a GraphQL endpoint.",
      );
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

    const [ids, pkh, weight, followerCount, followingCount, profileRec, pinned] =
      await Promise.all([
        api.query.Microblog.ByAuthor.getValue(account),
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

    const postIds = (ids ?? []) as unknown as bigint[];
    const fetched = await Promise.all(postIds.map((id) => getPost(api, id)));
    const posts = fetched
      .filter((p): p is CognoPost => p !== undefined)
      // Posts tab: top-level only (parentId null), matching the indexer Posts tab.
      .filter((p) => p.parent === undefined)
      .map((p) => ({ ...p, authorRevoked: banned }))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    return {
      author: account,
      identityHash,
      postCount: posts.length,
      banned,
      weight,
      // display fields + counts are ALL node-served now (pallet-profile + the follow counters);
      // only the reverse Replies/Likes tabs still need the indexer (caps.profileTabs:false).
      displayName: profileText(profileRec?.display_name),
      bio: profileText(profileRec?.bio),
      avatar: profileText(profileRec?.avatar),
      pinnedPostId: pinned == null ? undefined : BigInt(pinned as unknown as bigint),
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
      page: {
        posts,
        endCursor: null,
        hasNextPage: false,
        totalCount: posts.length,
        asOf: null,
      },
    };
  }

  // ── spec-113 social: the node serves these from the aggregate maps ──
  function poll(hostId: bigint): Promise<PollView> {
    return readPoll(api, hostId);
  }

  function viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState> {
    return readViewerPostState(api, post, who);
  }

  // ── follow graph: the FORWARD direction is node-served (caps.follows on) ──
  async function followEdges(who: Ss58): Promise<FollowEdges> {
    const [following, followerCount, followingCount] = await Promise.all([
      readFollowees(api, who),
      api.query.Microblog.FollowerCount.getValue(who),
      api.query.Microblog.FollowingCount.getValue(who),
    ]);
    return {
      following,
      // The reverse list (who follows `who`) needs an index the node lacks; only the COUNT is
      // stored. No surface renders the followers list — just the count — so [] is honest here.
      followers: [],
      followerCount: Number(followerCount ?? 0),
      followingCount: Number(followingCount ?? 0),
    };
  }

  // ── indexer-only: caps say so; calling these is a logic slip ──
  function whoToFollow(): Promise<Suggestion[]> {
    throw new UnsupportedQuery("who-to-follow needs the indexer — set a GraphQL endpoint.");
  }
  function searchPeople(): Promise<Suggestion[]> {
    throw new UnsupportedQuery("people search needs the indexer — set a GraphQL endpoint.");
  }

  function watch(): Observable<FeedSnapshot> {
    return watchFeed(api);
  }

  return {
    kind: "papi",
    caps,
    watch,
    page,
    thread,
    profile,
    poll,
    viewerPostState,
    followEdges,
    whoToFollow,
    searchPeople,
  };
}
