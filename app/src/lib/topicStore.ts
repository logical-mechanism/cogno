"use client";

// topicStore — the viewer's followed TOPICS, device-local (client-only; NO chain state, nothing written
// to the chain or to Cardano). Scoped per account and mirrored across this device's tabs, like bookmarks
// and mutes, via the shared viewer-scoped set store.
//
// Deliberately NOT on chain. A topic follow is not verifiable, carries no weight, and — on a ledger with
// no delete — would publish a permanent, unremovable interest graph to buy nothing. Following a topic is
// a reading preference, so it lives where reading preferences live: this device.
//
// `isCanonicalTag` is load-bearing on BOTH paths, not cosmetic: a stored topic is interpolated into a
// `?q=` URL and into a node search term, so a junk value would produce a broken link and a wasted
// chain-wide scan. Values are stored CANONICAL (ASCII-folded, no leading '#') — see lib/topics for why
// the fold is ASCII-only.

import { createViewerScopedStringSetStore } from "./stringSetStore";
import { canonicalTag, isCanonicalTag } from "./topics";
import type { Ss58 } from "./types";

/**
 * How many followed topics the merged strip previews at once.
 *
 * This is a COST bound, not a taste bound. Each previewed topic is its own `search_posts` scan, and
 * every one of those rebuilds `staker_weights()` over up to `MaxObserved` (1024) accounts node-side. The
 * strip therefore previews the first few and links the rest rather than fanning out over all of them.
 */
export const MAX_PREVIEWED_TOPICS = 3;

const store = createViewerScopedStringSetStore({
  prefix: "cg-topics",
  isValid: isCanonicalTag,
});

/** Follow actions bound to `who` (null = the signed-out device bucket). Input may carry a leading '#'. */
export function topicActionsFor(who: Ss58 | null) {
  const a = store.actionsFor(who);
  // Canonicalize at the boundary so a caller can pass `#Cardano`, `Cardano` or `cardano` and the store
  // holds one value. An uncanonicalizable tag is dropped, never stored raw.
  const withTopic = (raw: string, fn: (t: string) => void) => {
    const t = canonicalTag(raw);
    if (t !== null) fn(t);
  };
  return {
    follow: (raw: string) => withTopic(raw, a.add),
    unfollow: (raw: string) => withTopic(raw, a.remove),
    toggle: (raw: string) => withTopic(raw, a.toggle),
  };
}

/** Is `raw` followed by `who`? Subscribes, so the caller re-renders when the set changes. */
export function useTopicFollowed(raw: string | null | undefined, who: Ss58 | null): boolean {
  const snap = store.useSet(who);
  if (raw == null) return false;
  const t = canonicalTag(raw);
  return t !== null && snap.has(t);
}

/** `who`'s followed topics, sorted for a stable render order. */
export function useFollowedTopics(who: Ss58 | null): string[] {
  const snap = store.useSet(who);
  return [...snap].sort();
}

/** Non-React read, for tests and for one-shot reads outside a component. */
export function readFollowedTopics(who: Ss58 | null): string[] {
  return [...store.readFor(who)].sort();
}
