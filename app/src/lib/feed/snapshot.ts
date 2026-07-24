"use client";

// snapshot — an in-memory hold of the Home feed, so browser Back does not throw it away.
//
// THE PROBLEM. AppShell keeps the socket, the rails and the live subscription across a client
// navigation, but only <main> survives — HomePage itself unmounts. useLiveFeed's setup effect then
// resets unconditionally on remount (loaded, buffered, cursor, ready all cleared) and re-seeds page 1.
// So the single most common gesture in a timeline app — open a post, press Back — costs a fresh
// 50-post state_call, discards every "load more" page the reader had paged in, and, because Next's
// history scroll-restore fires against a document that is momentarily EMPTY, drops them at the top of
// the feed with their place gone.
//
// WHY IN MEMORY AND NOTHING ELSE. A feed page carries `myVote` (per-viewer), `authorRevoked` (flips
// when the committee revokes) and role badges (rewritten by the observer inherent) — all liveness
// facts with no id-linked invalidation, where a stale value is a false attestation rather than a
// cosmetic miss. Held only for the lifetime of the tab, none of that can outlive the session that
// produced it, there is no quota to compete with the block/mute stores for, and nothing about what the
// reader read is written to their disk. The tradeoff is deliberate: this fixes the navigation that
// happens constantly and declines the one that happens rarely.
//
// Restoring is not trusting: the caller re-arms its head-id subscription, which brings the feed current
// on the next tick, so a restored page is a fast first paint that is immediately revalidated.

import type { CognoPost } from "@/lib/types";

export interface FeedSnapshot {
  posts: CognoPost[];
  /** the cursor the next "load more" continues from (null = at the tail). */
  cursor: string | null;
  /** document scrollY at the moment the surface unmounted. */
  scrollY: number;
}

/**
 * One slot. Home is the only surface with a paged tail worth preserving, and holding a map keyed by
 * query would keep the previous viewer's posts alive after an account switch for no benefit.
 */
let held: { key: string; snap: FeedSnapshot } | null = null;

/**
 * The identity of a feed. MUST include the viewer: a page fetched with `viewer: me` carries that
 * viewer's `myVote` overlay baked into every row, so replaying it for a different account (a wallet
 * switch, a sign-out on a shared device) would show them someone else's filled hearts.
 */
export function feedSnapshotKey(tab: string, viewer: string | null): string {
  return `${tab}|${viewer ?? "anon"}`;
}

export function saveFeedSnapshot(key: string, snap: FeedSnapshot): void {
  // An empty list is not worth restoring — it would suppress the loading state on the next mount and
  // paint an "empty feed" that is really "not loaded yet".
  if (snap.posts.length === 0) return;
  held = { key, snap };
}

/**
 * Take the snapshot for `key`, if it is the one held. Consuming: a snapshot is a hand-off from one
 * mount to the next, and leaving it in place would let a THIRD mount replay a page that is two
 * navigations stale.
 */
export function takeFeedSnapshot(key: string): FeedSnapshot | null {
  if (!held || held.key !== key) return null;
  const { snap } = held;
  held = null;
  return snap;
}

/** Drop whatever is held (sign-out / account switch). */
export function clearFeedSnapshot(): void {
  held = null;
}
