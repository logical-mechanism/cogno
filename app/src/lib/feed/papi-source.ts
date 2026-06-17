// The PAPI-direct FeedSource: the always-available fallback reader. It wraps the EXISTING
// chain reads (watchFeed, buildThreadIndex, getPost) plus a few direct storage lookups, and
// presents them behind the same FeedSource interface as the indexer.
//
// CHAIN-TRUTH for the things the indexer derives:
//   - revocation = `CognoGate.PkhOf[account]` ABSENT (revoke removes the binding; the posts
//     stay), NOT a per-post field. We read it live per author.
//   - identity-hash → account is the reverse `CognoGate.AccountOf[hash]` map.
//   - weight is `TalkStake.AllowedStake[account]` (Cardano-sourced lovelace, M2d).
//
// What it canNOT do, honestly: substring search and cursor pagination (no indexer). `caps`
// says so; `page()` throws UnsupportedQuery if asked for either, and the UI gates on `caps`.
//
// This file does NOT modify reads.ts — it only consumes it.

import { firstValueFrom, type Observable } from "rxjs";
import { FixedSizeBinary } from "polkadot-api";
import { watchFeed, buildThreadIndex, getPost } from "@/lib/chain/reads";
import type {
  CognoApi,
  CognoPost,
  FeedSnapshot,
  FeedPage,
  FeedQuery,
  ThreadView,
  ProfileView,
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

export function createPapiFeedSource(api: CognoApi): FeedSource {
  const caps: FeedCaps = {
    search: false,
    pagination: false,
    threads: true,
    revocation: true,
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
    const childrenRaw = (index.get(String(rootId)) ?? [])
      .slice()
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const [root, ...replies] = await flagRevocations([rootRaw, ...childrenRaw]);
    const lastActivity = [root, ...replies].reduce(
      (max, p) => (p.at > max ? p.at : max),
      root.at,
    );
    return { root, replies, replyCount: replies.length, lastActivity };
  }

  async function profile(args: ProfileArgs): Promise<ProfileView> {
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

    const [ids, pkh, weight] = await Promise.all([
      api.query.Microblog.ByAuthor.getValue(account),
      api.query.CognoGate.PkhOf.getValue(account),
      readWeight(api, account),
    ]);
    const banned = pkh === undefined;
    const identityHash =
      args.identityHash ??
      (pkh ? (pkh as unknown as { asHex: () => string }).asHex() : null);

    const postIds = (ids ?? []) as unknown as bigint[];
    const fetched = await Promise.all(postIds.map((id) => getPost(api, id)));
    const posts = fetched
      .filter((p): p is CognoPost => p !== undefined)
      .map((p) => ({ ...p, authorRevoked: banned }))
      .sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));

    return {
      author: account,
      identityHash,
      postCount: posts.length,
      banned,
      weight,
      page: {
        posts,
        endCursor: null,
        hasNextPage: false,
        totalCount: posts.length,
        asOf: null,
      },
    };
  }

  function watch(): Observable<FeedSnapshot> {
    return watchFeed(api);
  }

  return { kind: "papi", caps, watch, page, thread, profile };
}
