// The SubQuery-GraphQL FeedSource: the indexer-backed reader. It serves search, cursor
// pagination, threads, and profile views the PAPI-direct path cannot, and a poll-backed
// live `watch()` (the indexer has no subscription transport in this deployment, so we honest-
// poll the recent feed). All node→CognoPost mapping happens HERE, at the indexer boundary:
//   - `id` / `parentId` are STRINGS → BigInt(...) (u64; never round-trip through Number)
//   - `CognoPost.at = blockHeight`  (NOT timestamp)
//   - `authorRevoked = author.banned === true`  (revoke leaves posts intact — we FLAG them)
//
// Errors from the client (unreachable / CORS / GraphQL errors) propagate; callers surface
// them honestly so the feed degrades to a clear error state instead of silently blanking.

import { Observable, timer, switchMap, map, catchError, of } from "rxjs";
import { gqlRequest } from "./client";
import { FEED, PROFILE_BY_IDENTITY, PROFILE_BY_ACCOUNT, THREAD } from "./queries";
import type {
  CognoPost,
  FeedSnapshot,
  FeedPage,
  FeedQuery,
  ThreadView,
  ProfileView,
} from "@/lib/types";
import type { FeedSource, FeedCaps, ProfileArgs } from "@/lib/feed/source";

/** How often the live watch re-fetches the recent feed. */
const POLL_MS = 6_000;
/** How many posts the live watch pulls per poll. */
const WATCH_LIMIT = 50;

// ── GraphQL response shapes (only the fields we select) ──────────────────────────────────

interface NodeAuthor {
  id: string;
  banned: boolean;
  identityHash: string | null;
}

interface FeedNode {
  id: string;
  authorId: string;
  text: string;
  parentId: string | null;
  blockHeight: number;
  deleted: boolean;
  author?: NodeAuthor | null;
}

interface FeedResponse {
  posts: {
    totalCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    edges: Array<{ cursor: string; node: FeedNode }>;
  };
}

/** A post node as it appears nested under an Author (no nested `author`/`authorId`). */
interface AuthorPostNode {
  id: string;
  text: string;
  parentId: string | null;
  blockHeight: number;
  deleted: boolean;
}

interface AuthorNode {
  id: string;
  banned: boolean;
  identityHash: string | null;
  postCount: number;
  weight: string | null;
  posts: { totalCount: number; nodes: AuthorPostNode[] };
}

interface ProfileByIdentityResponse {
  authors: { nodes: AuthorNode[] };
}
interface ProfileByAccountResponse {
  author: AuthorNode | null;
}

interface ThreadResponse {
  post: {
    id: string;
    authorId: string;
    text: string;
    blockHeight: number;
    deleted: boolean;
    author?: NodeAuthor | null;
    replies: { totalCount: number; nodes: FeedNode[] };
  } | null;
}

// ── mapping: indexer node → shared CognoPost (the seam) ──────────────────────────────────

/** A top-level feed/thread node (carries its own author + parent id). */
function nodeToPost(n: FeedNode): CognoPost {
  return {
    id: BigInt(n.id),
    author: n.authorId,
    text: n.text,
    parent: n.parentId == null ? undefined : BigInt(n.parentId),
    at: n.blockHeight,
    deleted: n.deleted === true,
    authorRevoked: n.author?.banned === true,
  };
}

/** A post nested under its author (the author's `banned` is carried in from the parent). */
function authorPostToPost(
  n: AuthorPostNode,
  authorId: string,
  banned: boolean,
): CognoPost {
  return {
    id: BigInt(n.id),
    author: authorId,
    text: n.text,
    parent: n.parentId == null ? undefined : BigInt(n.parentId),
    at: n.blockHeight,
    deleted: n.deleted === true,
    authorRevoked: banned === true,
  };
}

function authorToProfile(a: AuthorNode): ProfileView {
  const posts = a.posts.nodes.map((n) => authorPostToPost(n, a.id, a.banned));
  return {
    author: a.id,
    identityHash: a.identityHash,
    postCount: a.postCount,
    banned: a.banned === true,
    weight: a.weight == null ? undefined : BigInt(a.weight),
    page: {
      posts,
      endCursor: null,
      hasNextPage: false,
      totalCount: a.posts.totalCount,
      asOf: null,
    },
  };
}

/** An empty profile (the looked-up author/identity has no record on the indexer yet). */
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

/** Build the `PostFilter` for a feed/page query (always excludes soft-deleted posts). */
function feedFilter(q: FeedQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = { deleted: { equalTo: false } };
  if (q.search && q.search.trim().length > 0) {
    filter.text = { includesInsensitive: q.search.trim() };
  }
  if (q.authorId) {
    filter.authorId = { equalTo: q.authorId };
  }
  return filter;
}

export function createGraphqlFeedSource(endpoint: string): FeedSource {
  const caps: FeedCaps = {
    search: true,
    pagination: true,
    threads: true,
    revocation: true,
  };

  async function page(q: FeedQuery): Promise<FeedPage> {
    const first = q.first ?? WATCH_LIMIT;
    const data = await gqlRequest<FeedResponse>(endpoint, FEED, {
      first,
      after: q.after ?? null,
      orderBy: ["ID_DESC"],
      filter: feedFilter(q),
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
    const rootNode: FeedNode = {
      id: data.post.id,
      authorId: data.post.authorId,
      text: data.post.text,
      parentId: null,
      blockHeight: data.post.blockHeight,
      deleted: data.post.deleted,
      author: data.post.author,
    };
    const root = nodeToPost(rootNode);
    const replies = data.post.replies.nodes.map(nodeToPost);
    const lastActivity = [root, ...replies].reduce(
      (max, p) => (p.at > max ? p.at : max),
      root.at,
    );
    return {
      root,
      replies,
      replyCount: data.post.replies.totalCount,
      lastActivity,
    };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
    if (args.identityHash) {
      const data = await gqlRequest<ProfileByIdentityResponse>(
        endpoint,
        PROFILE_BY_IDENTITY,
        { hex: args.identityHash },
      );
      const node = data.authors.nodes[0];
      return node ? authorToProfile(node) : emptyProfile(args);
    }
    if (args.author) {
      const data = await gqlRequest<ProfileByAccountResponse>(
        endpoint,
        PROFILE_BY_ACCOUNT,
        { ss58: args.author },
      );
      return data.author ? authorToProfile(data.author) : emptyProfile(args);
    }
    return emptyProfile(args);
  }

  function watch(): Observable<FeedSnapshot> {
    // A transient poll failure (indexer blip / CORS hiccup) must NOT terminate the live stream —
    // RxJS `error()` is terminal, so a single failed fetch would kill the feed forever with no
    // recovery. We `catchError` PER POLL and re-emit the last good snapshot, so the timer keeps
    // ticking and the feed self-heals on the next successful poll. Persistent indexer outages
    // still surface honestly on the interactive search / load-more path (useFeedPage throws).
    let lastGood: FeedSnapshot = { posts: [], asOf: null };
    return timer(0, POLL_MS).pipe(
      switchMap(() => {
        const ac = new AbortController();
        const poll$ = new Observable<FeedSnapshot>((sub) => {
          gqlRequest<FeedResponse>(
            endpoint,
            FEED,
            {
              first: WATCH_LIMIT,
              after: null,
              orderBy: ["ID_DESC"],
              filter: { deleted: { equalTo: false } },
            },
            ac.signal,
          ).then(
            (data) => {
              lastGood = { posts: data.posts.edges.map((e) => nodeToPost(e.node)), asOf: null };
              sub.next(lastGood);
              sub.complete();
            },
            (err) => sub.error(err),
          );
          // Abort the in-flight fetch if the poll re-fires / unsubscribes before it resolves.
          return () => ac.abort();
        });
        return poll$.pipe(
          catchError((err) => {
            // eslint-disable-next-line no-console
            console.warn("cogno: indexer feed poll failed, retaining last snapshot:", err?.message ?? err);
            return of(lastGood);
          }),
        );
      }),
    );
  }

  return { kind: "graphql", caps, watch, page, thread, profile };
}
