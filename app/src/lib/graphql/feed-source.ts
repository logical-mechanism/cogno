// The SubQuery-GraphQL FeedSource: the indexer-backed reader. It serves search, cursor
// pagination, threads, profiles, and the spec-113 social aggregates (vote/poll tallies, the
// viewer's own vote/repost state, follow edges, who-to-follow) the PAPI-direct path cannot,
// plus a poll-backed live `watch()` (the indexer has no subscription transport here, so we
// honest-poll the recent feed). All node→seam mapping happens HERE, at the indexer boundary:
//   - id / parentId / quote.id / weight / score are STRINGS → BigInt(...)  (u64/u128; NEVER Number)
//   - CognoPost.at = blockHeight  (NOT timestamp)
//   - authorRevoked = author.banned === true  (revoke leaves posts intact — we FLAG, never drop)
// There is NO `deleted` field (removed at spec 113; the column does not exist).

import { Observable, timer, switchMap, map, catchError, of } from "rxjs";
import { gqlRequest, GraphqlError } from "./client";
import {
  FEED,
  PROFILE_BY_IDENTITY,
  PROFILE_BY_ACCOUNT,
  PROFILE_REPLIES,
  PROFILE_LIKES,
  THREAD,
  POLL,
  VIEWER_STATES,
  FOLLOW_EDGES,
  WHO_TO_FOLLOW,
  SEARCH_PEOPLE,
} from "./queries";
import type {
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
  QuotedRef,
  Ss58,
} from "@/lib/types";
import type { FeedSource, FeedCaps, ProfileArgs } from "@/lib/feed/source";

/** How often the live watch re-fetches the recent feed. */
const POLL_MS = 6_000;
/** How many posts the live watch pulls per poll. */
const WATCH_LIMIT = 50;
/** Cap on the Following-timeline followee `in`-list (beyond this, paginate the set — v1 out of scope). */
const FOLLOWEE_CAP = 1000;

// ── GraphQL response shapes (only the fields we select) ──────────────────────────────────

interface NodeAuthor {
  id: string;
  banned: boolean;
  identityHash?: string | null;
  weight?: string | null;
  displayName?: string | null;
  avatar?: string | null;
}

interface QuoteNode {
  id: string;
  text: string;
  author: NodeAuthor;
}

/** The social fields common to every post node. */
interface SocialNode {
  id: string;
  authorId: string;
  text: string;
  parentId: string | null;
  blockHeight: number;
  isPoll?: boolean | null;
  upWeight?: string | null;
  downWeight?: string | null;
  upCount?: number | null;
  downCount?: number | null;
  score?: string | null;
  repostCount?: number | null;
  quote?: QuoteNode | null;
}

/** A top-level feed/thread node (carries its own author object). */
interface FeedNode extends SocialNode {
  author?: NodeAuthor | null;
  /** Present on thread reply nodes — the reply's own direct-child count, for the inline expander. */
  replies?: { totalCount: number } | null;
}

interface FeedResponse {
  posts: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ cursor: string; node: FeedNode }>;
  };
}

/** The author profile shell (denormalized profile fields + counts). */
interface AuthorShell {
  id: string;
  banned: boolean;
  identityHash: string | null;
  weight: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatar?: string | null;
  pinnedPostId?: string | null;
  postCount: number;
  followerCount?: number | null;
  followingCount?: number | null;
  posts?: {
    totalCount: number;
    pageInfo?: { hasNextPage: boolean; endCursor: string | null };
    nodes: SocialNode[];
  };
}

interface ProfileByIdentityResponse {
  authors: { nodes: AuthorShell[] };
}
interface ProfileByAccountResponse {
  author: AuthorShell | null;
}
interface ProfileLikesResponse {
  author: AuthorShell | null;
  votes: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ post: FeedNode | null }>;
  };
}

interface ThreadResponse {
  post: {
    id: string;
    authorId: string;
    text: string;
    parentId: string | null;
    blockHeight: number;
    isPoll?: boolean | null;
    upWeight?: string | null;
    downWeight?: string | null;
    upCount?: number | null;
    downCount?: number | null;
    score?: string | null;
    repostCount?: number | null;
    author?: NodeAuthor | null;
    quote?: QuoteNode | null;
    parent?: { id: string; authorId: string; text: string; author?: NodeAuthor | null } | null;
    replies: { totalCount: number; nodes: FeedNode[] };
  } | null;
}

interface PollResponse {
  poll: {
    id: string;
    options: Array<{ index: number; label: string; weight: string | null; count: number | null }>;
    votes?: { totalCount: number } | null;
  } | null;
}

interface ViewerStatesResponse {
  votes: { nodes: Array<{ postId: string; dir: string }> };
  reposts: { nodes: Array<{ postId: string }> };
}

interface FollowEdgesResponse {
  author: { followerCount?: number | null; followingCount?: number | null } | null;
  following: { nodes: Array<{ followeeId: string }> };
  followers: { nodes: Array<{ followerId: string }> };
}

interface SuggestionsResponse {
  authors: {
    nodes: Array<{
      id: string;
      displayName?: string | null;
      avatar?: string | null;
      weight?: string | null;
      followerCount?: number | null;
    }>;
  };
}

// ── mapping helpers ──────────────────────────────────────────────────────────────────────

/** u64/u128 string → bigint, defaulting null/undefined to 0n (never Number()). */
function big(s: string | null | undefined): bigint {
  return s == null ? 0n : BigInt(s);
}

function quoteToRef(q: QuoteNode | null | undefined): QuotedRef | undefined {
  if (q == null) return undefined;
  return {
    id: BigInt(q.id),
    author: q.author.id,
    text: q.text,
    authorRevoked: q.author.banned === true,
    displayName: q.author.displayName ?? undefined,
    avatar: q.author.avatar ?? undefined,
  };
}

/** Author metadata resolved either from a node's own `author{}` or from a profile shell. */
interface AuthorMeta {
  banned: boolean;
  displayName?: string | null;
  avatar?: string | null;
  weight?: string | null;
}

/** Map any social node + its resolved author meta into the shared CognoPost. */
function mapPost(n: SocialNode, meta: AuthorMeta): CognoPost {
  return {
    id: BigInt(n.id),
    author: n.authorId,
    text: n.text,
    parent: n.parentId == null ? undefined : BigInt(n.parentId),
    at: n.blockHeight,
    authorRevoked: meta.banned === true,
    isPoll: n.isPoll === true,
    upWeight: big(n.upWeight),
    downWeight: big(n.downWeight),
    upCount: n.upCount ?? 0,
    downCount: n.downCount ?? 0,
    score: big(n.score),
    repostCount: n.repostCount ?? 0,
    authorDisplayName: meta.displayName ?? undefined,
    authorAvatar: meta.avatar ?? undefined,
    authorWeight: meta.weight == null ? undefined : BigInt(meta.weight),
    quote: quoteToRef(n.quote),
  };
}

/** A top-level node carrying its own author object. */
function nodeToPost(n: FeedNode): CognoPost {
  return mapPost(n, {
    banned: n.author?.banned === true,
    displayName: n.author?.displayName,
    avatar: n.author?.avatar,
    weight: n.author?.weight,
  });
}

/** A post nested under its author shell (author meta carried in from the shell). */
function shellPostToPost(n: SocialNode, shell: AuthorShell): CognoPost {
  return mapPost(n, {
    banned: shell.banned === true,
    displayName: shell.displayName,
    avatar: shell.avatar,
    weight: shell.weight,
  });
}

function shellToProfile(a: AuthorShell, fallbackArgs: ProfileArgs): ProfileView {
  const nodes = a.posts?.nodes ?? [];
  const posts = nodes.map((n) => shellPostToPost(n, a));
  return {
    author: a.id,
    identityHash: a.identityHash,
    postCount: a.postCount,
    banned: a.banned === true,
    weight: a.weight == null ? undefined : BigInt(a.weight),
    displayName: a.displayName ?? undefined,
    bio: a.bio ?? undefined,
    avatar: a.avatar ?? undefined,
    pinnedPostId: a.pinnedPostId == null ? undefined : BigInt(a.pinnedPostId),
    followerCount: a.followerCount ?? undefined,
    followingCount: a.followingCount ?? undefined,
    page: {
      posts,
      endCursor: a.posts?.pageInfo?.endCursor ?? null,
      hasNextPage: a.posts?.pageInfo?.hasNextPage ?? false,
      totalCount: a.posts?.totalCount ?? posts.length,
      asOf: null,
    },
  };
}

function emptyProfile(args: ProfileArgs): ProfileView {
  return {
    author: args.author ?? null,
    identityHash: args.identityHash ?? null,
    postCount: 0,
    banned: false,
    page: { posts: [], endCursor: null, hasNextPage: false, totalCount: 0, asOf: null },
  };
}

// ── the source ───────────────────────────────────────────────────────────────────────────

export function createGraphqlFeedSource(endpoint: string): FeedSource {
  const caps: FeedCaps = {
    search: true,
    pagination: true,
    threads: true,
    revocation: true,
    tallies: true,
    follows: true,
    profiles: true,
    whoToFollow: true,
  };

  function orderBy(order: FeedQuery["order"]): string[] {
    return order === "score" ? ["SCORE_DESC", "ID_DESC"] : ["ID_DESC"];
  }

  async function followEdges(who: Ss58): Promise<FollowEdges> {
    const data = await gqlRequest<FollowEdgesResponse>(endpoint, FOLLOW_EDGES, { who });
    const following = data.following.nodes.map((n) => n.followeeId);
    const followers = data.followers.nodes.map((n) => n.followerId);
    return {
      following,
      followers,
      followingCount: data.author?.followingCount ?? following.length,
      followerCount: data.author?.followerCount ?? followers.length,
    };
  }

  /** Build the `PostFilter` for a feed/page query (no `deleted`; may be empty). */
  async function feedFilter(q: FeedQuery): Promise<Record<string, unknown>> {
    const filter: Record<string, unknown> = {};
    if (q.search && q.search.trim().length > 0) {
      filter.text = { includesInsensitive: q.search.trim() };
    }
    if (q.authorId) {
      filter.authorId = { equalTo: q.authorId };
    }
    if (q.tab === "following" && q.followeeOf) {
      const { following } = await followEdges(q.followeeOf);
      // Empty followee set ⇒ an impossible filter so the page is empty (not "all posts").
      filter.authorId = { in: following.slice(0, FOLLOWEE_CAP) };
    }
    return filter;
  }

  async function page(q: FeedQuery): Promise<FeedPage> {
    const first = q.first ?? WATCH_LIMIT;
    const data = await gqlRequest<FeedResponse>(endpoint, FEED, {
      first,
      after: q.after ?? null,
      orderBy: orderBy(q.order),
      filter: await feedFilter(q),
    });
    return {
      posts: data.posts.edges.map((e) => nodeToPost(e.node)),
      endCursor: data.posts.pageInfo.endCursor,
      hasNextPage: data.posts.pageInfo.hasNextPage,
      totalCount: data.posts.totalCount,
      asOf: null,
    };
  }

  async function thread(rootId: bigint): Promise<ThreadView> {
    const data = await gqlRequest<ThreadResponse>(endpoint, THREAD, {
      rootId: String(rootId),
    });
    if (!data.post) {
      throw new Error(`thread root #${rootId} not found on the indexer`);
    }
    const root = nodeToPost({ ...data.post, parentId: data.post.parentId ?? null });
    const replies = data.post.replies.nodes.map((n) =>
      n.replies ? { ...nodeToPost(n), replyCount: n.replies.totalCount } : nodeToPost(n),
    );
    const parent: QuotedRef | undefined = data.post.parent
      ? {
          id: BigInt(data.post.parent.id),
          author: data.post.parent.authorId,
          text: data.post.parent.text,
          authorRevoked: data.post.parent.author?.banned === true,
          displayName: data.post.parent.author?.displayName ?? undefined,
          avatar: data.post.parent.author?.avatar ?? undefined,
        }
      : undefined;
    // Connected ancestor chain. The THREAD query resolves the immediate parent only, so the chain is
    // one-deep on the indexer path (PAPI-direct walks the full chain from the snapshot).
    const ancestors: CognoPost[] = parent
      ? [
          {
            id: parent.id,
            author: parent.author,
            text: parent.text,
            at: 0,
            authorRevoked: parent.authorRevoked,
            authorDisplayName: parent.displayName,
            authorAvatar: parent.avatar,
          },
        ]
      : [];
    const lastActivity = [root, ...replies].reduce(
      (max, p) => (p.at > max ? p.at : max),
      root.at,
    );
    return {
      root,
      ancestors,
      replies,
      replyCount: data.post.replies.totalCount,
      parent,
      lastActivity,
    };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
    // Likes tab: this author's UP votes → the liked posts (+ the author shell for the header).
    if (args.tab === "likes" && args.author) {
      const data = await gqlRequest<ProfileLikesResponse>(endpoint, PROFILE_LIKES, {
        ss58: args.author,
        first: WATCH_LIMIT,
        after: null,
      });
      if (!data.author) return emptyProfile(args);
      const posts = data.votes.nodes
        .map((v) => v.post)
        .filter((p): p is FeedNode => p != null)
        .map(nodeToPost);
      const base = shellToProfile({ ...data.author, posts: undefined }, args);
      return {
        ...base,
        page: {
          posts,
          endCursor: data.votes.pageInfo.endCursor,
          hasNextPage: data.votes.pageInfo.hasNextPage,
          totalCount: data.votes.totalCount,
          asOf: null,
        },
      };
    }

    // Replies tab.
    if (args.tab === "replies" && args.author) {
      const data = await gqlRequest<ProfileByAccountResponse>(endpoint, PROFILE_REPLIES, {
        ss58: args.author,
        first: WATCH_LIMIT,
        after: null,
      });
      return data.author ? shellToProfile(data.author, args) : emptyProfile(args);
    }

    // Posts tab by identity hash.
    if (args.identityHash) {
      const data = await gqlRequest<ProfileByIdentityResponse>(endpoint, PROFILE_BY_IDENTITY, {
        hex: args.identityHash,
        first: WATCH_LIMIT,
        after: null,
      });
      const node = data.authors.nodes[0];
      return node ? shellToProfile(node, args) : emptyProfile(args);
    }

    // Posts tab by account (default).
    if (args.author) {
      const data = await gqlRequest<ProfileByAccountResponse>(endpoint, PROFILE_BY_ACCOUNT, {
        ss58: args.author,
        first: WATCH_LIMIT,
        after: null,
      });
      return data.author ? shellToProfile(data.author, args) : emptyProfile(args);
    }
    return emptyProfile(args);
  }

  async function poll(hostId: bigint): Promise<PollView> {
    const data = await gqlRequest<PollResponse>(endpoint, POLL, { hostId: String(hostId) });
    const options = (data.poll?.options ?? []).map((o) => ({
      index: o.index,
      label: o.label,
      weight: big(o.weight),
      count: o.count ?? 0,
    }));
    const totalWeight = options.reduce((s, o) => s + o.weight, 0n);
    const totalCount = options.reduce((s, o) => s + o.count, 0);
    return { hostId, options, totalWeight, totalCount };
  }

  async function viewerPostState(post: bigint, who: Ss58): Promise<ViewerPostState> {
    const data = await gqlRequest<ViewerStatesResponse>(endpoint, VIEWER_STATES, {
      who,
      postIds: [String(post)],
    });
    const vote = data.votes.nodes.find((n) => n.postId === String(post));
    const reposted = data.reposts.nodes.some((n) => n.postId === String(post));
    const myVote = vote ? (vote.dir === "Down" ? "Down" : "Up") : null;
    return { myVote, reposted };
  }

  async function whoToFollow(_who: Ss58 | null, limit: number): Promise<Suggestion[]> {
    const data = await gqlRequest<SuggestionsResponse>(endpoint, WHO_TO_FOLLOW, { limit });
    return data.authors.nodes.map((n) => ({
      author: n.id,
      displayName: n.displayName ?? undefined,
      avatar: n.avatar ?? undefined,
      weight: n.weight == null ? undefined : BigInt(n.weight),
      followerCount: n.followerCount ?? 0,
    }));
  }

  async function searchPeople(q: string, limit: number): Promise<Suggestion[]> {
    const data = await gqlRequest<SuggestionsResponse>(endpoint, SEARCH_PEOPLE, {
      term: q.trim(),
      limit,
    });
    return data.authors.nodes.map((n) => ({
      author: n.id,
      displayName: n.displayName ?? undefined,
      avatar: n.avatar ?? undefined,
      weight: n.weight == null ? undefined : BigInt(n.weight),
      followerCount: n.followerCount ?? 0,
    }));
  }

  function watch(): Observable<FeedSnapshot> {
    // A transient poll failure (indexer blip / CORS hiccup) must NOT terminate the live stream —
    // RxJS error() is terminal, so a single failed fetch would kill the feed forever. We
    // catchError PER POLL and re-emit the last good snapshot, so the timer keeps ticking and the
    // feed self-heals on the next successful poll.
    let lastGood: FeedSnapshot = { posts: [], asOf: null };
    return timer(0, POLL_MS).pipe(
      switchMap(() => {
        const ac = new AbortController();
        const poll$ = new Observable<FeedSnapshot>((sub) => {
          gqlRequest<FeedResponse>(
            endpoint,
            FEED,
            { first: WATCH_LIMIT, after: null, orderBy: ["ID_DESC"], filter: {} },
            ac.signal,
          ).then(
            (data) => {
              lastGood = { posts: data.posts.edges.map((e) => nodeToPost(e.node)), asOf: null };
              sub.next(lastGood);
              sub.complete();
            },
            (err) => sub.error(err),
          );
          return () => ac.abort();
        });
        return poll$.pipe(
          catchError((err) => {
            const kind = err instanceof GraphqlError ? err.kind : "unknown";
            const status =
              err instanceof GraphqlError && err.status != null ? ` status=${err.status}` : "";
            // eslint-disable-next-line no-console
            console.warn(
              `cogno: indexer feed poll failed (kind=${kind}${status}, endpoint=${endpoint}), retaining last snapshot:`,
              err?.message ?? err,
            );
            return of(lastGood);
          }),
        );
      }),
    );
  }

  return {
    kind: "graphql",
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
