// Notifications fold — assemble the viewer's activity feed CLIENT-SIDE from the reverse indexes the
// chain already maintains, with ZERO chain change. There is no notifications runtime read (a scalable
// reverse-index is deferred), so this is a bounded scan of the maps the node serves directly:
//
//   Replies to me      RepliesByParent[myPostId] over ByAuthor[me]     → the reply post (author + at)
//   Likes on my posts  Votes.getEntries(myPostId)                      → each voter (edge; no chain time)
//   Reputation on me    AccountVotes.getEntries(me)                     → each voter (edge)
//   New followers       Followers.getEntries(me)                        → each follower (edge)
//   Poll votes on mine  PollVotes.getEntries(myPollId)                  → each voter (edge)
//   Mentions of me      source.page({ search: <my ss58> })             → posts embedding my ss58 (@mention)
//
// Post-based signals (reply/mention) carry the actor's Post.at (real chain-time); edge signals carry no
// timestamp and are ordered device-locally by first-seen (see notificationReadState + compareNotifs).
// The scan is BOUNDED (MAX_MY_POSTS) — `truncated` is surfaced so a capped scan never reads as complete.

import type { CognoApi, Ss58 } from "@/lib/types";
import type { FeedSource } from "@/lib/feed/source";

/** Read at BEST (like the social reads): a just-cast like/follow shows up immediately, and this
 *  single-producer chain never reorgs best, so best is both fresh and safe. */
const BEST = { at: "best" } as const;

/** Cap the reverse-index scan: the newest N of the viewer's posts are examined for replies/likes/poll
 *  votes. Bounded on purpose (the scalable reverse-index is out of scope); `truncated` reports a cap hit. */
export const MAX_MY_POSTS = 120;
/** How many recent mention hits to pull from the body-substring search. */
export const MENTION_LIMIT = 40;

export type NotifKind = "reply" | "mention" | "like" | "reputation" | "follow" | "pollvote";

/** One folded notification (pre-ordering / pre-enrichment). `key` is stable across folds (read-state). */
export interface Notif {
  /** stable unique id used for read-state + React keys. */
  key: string;
  kind: NotifKind;
  /** the account that acted (already self-filtered — never the viewer). */
  actor: Ss58;
  /** the post to open: my post that was liked/poll-voted, or the reply/mention post itself. */
  postId?: bigint;
  /** block height for post-based signals (reply/mention); undefined for timeless edge signals. */
  at?: number;
  /** vote direction for like / reputation signals. */
  dir?: "Up" | "Down";
  /** chosen option index for a poll vote. */
  option?: number;
}

/** The result of one fold. `truncated` = the viewer has more posts than MAX_MY_POSTS (scan was capped). */
export interface NotifLoad {
  notifs: Notif[];
  truncated: boolean;
}

interface StorageEntry {
  keyArgs: unknown[];
  value: unknown;
}
interface VoteValue {
  dir: { type: "Up" | "Down" };
  weight: bigint;
}
interface PollVoteValue {
  option: number;
  weight: bigint;
}
interface RawPost {
  author: Ss58;
  at: number;
}

const byIdDesc = (a: bigint, b: bigint): number => (a < b ? 1 : a > b ? -1 : 0);

/**
 * Fold the viewer's notifications. `me` MUST be the viewer's own ss58. Returns bounded, self-filtered
 * signals (mute + ordering + read-state are applied by the caller). Any partial read failure degrades
 * to fewer signals rather than throwing — a notifications panel is best-effort, never load-bearing.
 */
export async function loadNotifications(
  api: CognoApi,
  source: FeedSource | null,
  me: Ss58,
): Promise<NotifLoad> {
  // 1. The viewer's post ids (all posts incl. replies), newest-first, capped.
  const rawIds = (await api.query.Microblog.ByAuthor.getValue(me).catch(() => undefined)) as
    | bigint[]
    | undefined;
  const myPostIds = (rawIds ?? []).map((x) => BigInt(x)).sort(byIdDesc);
  const scanned = myPostIds.slice(0, MAX_MY_POSTS);
  const truncated = myPostIds.length > scanned.length;

  const q = api.query.Microblog;

  // 2. Per-post reverse-index reads (likes / replies / poll votes) + the account-scoped reads +
  //    the mention search, all in parallel. Individual failures resolve to empties.
  const [voteEntries, replyEntries, pollEntries, accountVotes, followers, mentionPage] =
    await Promise.all([
      Promise.all(scanned.map((id) => q.Votes.getEntries(id, BEST).catch(() => [] as StorageEntry[]))),
      Promise.all(
        scanned.map((id) => q.RepliesByParent.getEntries(id, BEST).catch(() => [] as StorageEntry[])),
      ),
      Promise.all(
        scanned.map((id) => q.PollVotes.getEntries(id, BEST).catch(() => [] as StorageEntry[])),
      ),
      (q.AccountVotes.getEntries(me, BEST) as Promise<StorageEntry[]>).catch(() => [] as StorageEntry[]),
      (q.Followers.getEntries(me, BEST) as Promise<StorageEntry[]>).catch(() => [] as StorageEntry[]),
      source && source.caps.search
        ? source.page({ search: me, viewer: me, first: MENTION_LIMIT }).catch(() => null)
        : Promise.resolve(null),
    ]);

  const notifs: Notif[] = [];

  // Likes on my posts (edge). actor = voter.
  scanned.forEach((postId, i) => {
    for (const e of voteEntries[i] as StorageEntry[]) {
      const voter = e.keyArgs[e.keyArgs.length - 1] as Ss58;
      if (voter === me) continue;
      const v = e.value as VoteValue;
      notifs.push({ key: `like:${postId}:${voter}`, kind: "like", actor: voter, postId, dir: v?.dir?.type });
    }
  });

  // Poll votes on my polls (edge). Non-poll posts return no entries.
  scanned.forEach((postId, i) => {
    for (const e of pollEntries[i] as StorageEntry[]) {
      const voter = e.keyArgs[e.keyArgs.length - 1] as Ss58;
      if (voter === me) continue;
      const v = e.value as PollVoteValue;
      notifs.push({ key: `poll:${postId}:${voter}`, kind: "pollvote", actor: voter, postId, option: v?.option });
    }
  });

  // Replies to me (post-based). Collect distinct reply ids, then read each reply for its author + at.
  const replyIds = new Set<bigint>();
  for (const entries of replyEntries) {
    for (const e of entries as StorageEntry[]) {
      const rid = e.keyArgs[e.keyArgs.length - 1] as bigint;
      replyIds.add(BigInt(rid));
    }
  }
  const replyIdList = Array.from(replyIds);
  const replyPosts = await Promise.all(
    replyIdList.map((id) => (q.Posts.getValue(id, BEST) as Promise<RawPost | undefined>).catch(() => undefined)),
  );
  replyIdList.forEach((rid, i) => {
    const p = replyPosts[i];
    if (!p || p.author === me) return;
    notifs.push({ key: `reply:${rid}`, kind: "reply", actor: p.author, postId: rid, at: p.at });
  });

  // Reputation votes ON me (edge). actor = voter; the double-map is prefixed by the target (me).
  for (const e of accountVotes) {
    const voter = e.keyArgs[e.keyArgs.length - 1] as Ss58;
    if (voter === me) continue;
    const v = e.value as VoteValue;
    notifs.push({ key: `rep:${voter}`, kind: "reputation", actor: voter, dir: v?.dir?.type });
  }

  // New followers (edge). actor = follower.
  for (const e of followers) {
    const follower = e.keyArgs[e.keyArgs.length - 1] as Ss58;
    if (follower === me) continue;
    notifs.push({ key: `follow:${follower}`, kind: "follow", actor: follower });
  }

  // Mentions of me (post-based): posts whose body embeds my ss58 (`@<me>`), self-filtered.
  if (mentionPage) {
    for (const p of mentionPage.posts) {
      if (p.author === me) continue;
      notifs.push({ key: `mention:${p.id}`, kind: "mention", actor: p.author, postId: p.id, at: p.at });
    }
  }

  return { notifs, truncated };
}

/**
 * Deterministic newest-first order for the merged list. PRIMARY key is device-local first-seen (so a
 * newly-observed signal floats to the top regardless of kind); within one fold (equal first-seen),
 * post-based signals sort by Post.at desc (real chain-time) ABOVE the timeless edge signals, which fall
 * back to a stable key order. Pure + unit-tested.
 */
export function compareNotifs(a: Notif, b: Notif, firstSeen: Record<string, number>): number {
  const fa = firstSeen[a.key] ?? 0;
  const fb = firstSeen[b.key] ?? 0;
  if (fa !== fb) return fb - fa; // newer first-seen first
  const aPost = a.at != null;
  const bPost = b.at != null;
  if (aPost && bPost) return (b.at as number) - (a.at as number);
  if (aPost !== bPost) return aPost ? -1 : 1; // post-based (chain-timed) above timeless edges
  return a.key < b.key ? 1 : a.key > b.key ? -1 : 0; // stable order for edges
}

/** Order + filter a folded set: drop muted actors, then sort newest-first. Pure. */
export function orderNotifs(
  notifs: Notif[],
  firstSeen: Record<string, number>,
  mutedSet: ReadonlySet<string>,
): Notif[] {
  return notifs
    .filter((n) => !mutedSet.has(n.actor))
    .sort((a, b) => compareNotifs(a, b, firstSeen));
}
