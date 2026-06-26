// The optimistic overlay (doc 04 §2.11 / §3.3). A pure, app-wide overlay merged on top of the
// watched feed snapshot + the viewer-state reads, so an optimistic action (a just-posted card, a
// like, a repost) renders INSTANTLY and is not clobbered by the next feed poll before it confirms.
// On confirm the overlay entry is cleared (the real row/tally now carries it); on failure it is
// rolled back. Keyed by post id (String) so the reconciling read wins once it lands.
//
// This module is pure (no React) and unit-testable: the apply/merge math (re-vote weight reversal,
// count clamping, score recompute) lives here; useOptimistic.tsx wires it into a context.

import type { CognoPost, ViewerPostState } from "@/lib/types";

/** A delta over a post's aggregate tallies (applied on top of the read tally). */
export interface CountPatch {
  upCountDelta?: number;
  downCountDelta?: number;
  upWeightDelta?: bigint;
  downWeightDelta?: bigint;
  repostCountDelta?: number;
}

/** The viewer's own optimistic state on a post (overrides the read ViewerPostState). */
export interface ViewerPatch {
  myVote?: "Up" | "Down" | null;
  reposted?: boolean;
  /**
   * Set once the write has CONFIRMED (inBestBlock). The patch is then kept — not cleared — until a
   * FRESH read of the viewer's own vote agrees with it (see {@link viewerPatchSettled}), so the
   * optimistic colour never drops to a stale read in the gap between confirm and re-observation.
   */
  expected?: boolean;
}

/** A pending (not-yet-confirmed) optimistic post — a new post / reply / quote. */
export interface PendingPost {
  clientId: string;
  /** A synthetic CognoPost with a placeholder id, shown until the real row arrives. */
  post: CognoPost;
  /** For replies: the thread this pending card belongs under. */
  parentId?: bigint;
  status: "pending" | "failed";
}

export interface Overlay {
  pending: PendingPost[];
  counts: Record<string, CountPatch>;
  viewer: Record<string, ViewerPatch>;
}

export const EMPTY_OVERLAY: Overlay = { pending: [], counts: {}, viewer: {} };

/** Apply a count patch to a post's tallies (counts clamp at 0; score recomputed from weights). */
export function applyCountPatch(post: CognoPost, patch: CountPatch | undefined): CognoPost {
  if (!patch) return post;
  const upWeight = (post.upWeight ?? 0n) + (patch.upWeightDelta ?? 0n);
  const downWeight = (post.downWeight ?? 0n) + (patch.downWeightDelta ?? 0n);
  return {
    ...post,
    upCount: Math.max(0, (post.upCount ?? 0) + (patch.upCountDelta ?? 0)),
    downCount: Math.max(0, (post.downCount ?? 0) + (patch.downCountDelta ?? 0)),
    upWeight,
    downWeight,
    repostCount: Math.max(0, (post.repostCount ?? 0) + (patch.repostCountDelta ?? 0)),
    score: upWeight - downWeight,
  };
}

/**
 * Reconcile-by-fresh-read: a confirmed (`expected`) vote patch is redundant once an authoritative
 * read of the viewer's own vote already agrees with it, and should then be retired. The CALLER must
 * only evaluate this against a read taken AFTER the confirm (a fresh post-confirm refetch) — gating
 * on freshness, not on value equality alone, is what stops a clear-to-null / zero-weight / coincident
 * patch from retiring against a stale base (which would re-open the very gap this closes).
 */
export function viewerPatchSettled(
  base: ViewerPostState,
  patch: ViewerPatch | undefined,
): boolean {
  return patch?.expected === true && base.myVote === (patch.myVote ?? null);
}

/** Apply a viewer patch over a read ViewerPostState (undefined fields keep the base value). */
export function applyViewerPatch(
  base: ViewerPostState,
  patch: ViewerPatch | undefined,
): ViewerPostState {
  if (!patch) return base;
  return {
    myVote: patch.myVote !== undefined ? patch.myVote : base.myVote,
    reposted: patch.reposted !== undefined ? patch.reposted : base.reposted,
  };
}

/**
 * The identity key used to match an optimistic pending card to its real chain twin (the chain assigns
 * a fresh id, so a pending card — which has a placeholder negative id — can only be reconciled by
 * author + text). The SINGLE source of this key, shared by {@link mergeFeed}'s dedup and the
 * presence-reconcile in the live feed, so the two can never drift.
 */
export function pendingKey(post: { author: string; text: string }): string {
  return `${post.author}\n${post.text}`;
}

/** Merge the overlay onto a feed snapshot: prepend pending cards, patch counts on existing rows. */
export function mergeFeed(posts: CognoPost[], overlay: Overlay): CognoPost[] {
  const patched = posts.map((p) => applyCountPatch(p, overlay.counts[String(p.id)]));
  // Suppress a pending card once its confirmed twin (same author + text) is already in the snapshot.
  // Without this the optimistic→real handoff flickers: dropPending() can fire a beat before the feed
  // poll lands the real row, so the card would briefly vanish then reappear. De-duping here makes the
  // swap seamless regardless of which arrives first.
  const realKeys = new Set(patched.map(pendingKey));
  const pendingCards = overlay.pending
    .filter((pp) => pp.status === "pending" && pp.parentId === undefined)
    .filter((pp) => !realKeys.has(pendingKey(pp.post)))
    .map((pp) => pp.post);
  return [...pendingCards, ...patched];
}

/**
 * The delta to optimistically apply a vote (or re-vote / clear). Reverses the previous vote's
 * weight before applying the new one, mirroring the chain's drift-free tally adjustment. Used by
 * useVote so a re-vote (Up→Down) is exact.
 */
export function voteDelta(
  prev: "Up" | "Down" | null,
  next: "Up" | "Down" | null,
  myWeight: bigint,
): CountPatch {
  const patch: CountPatch = {
    upCountDelta: 0,
    downCountDelta: 0,
    upWeightDelta: 0n,
    downWeightDelta: 0n,
  };
  // reverse the previous vote
  if (prev === "Up") {
    patch.upCountDelta! -= 1;
    patch.upWeightDelta! -= myWeight;
  } else if (prev === "Down") {
    patch.downCountDelta! -= 1;
    patch.downWeightDelta! -= myWeight;
  }
  // apply the new vote
  if (next === "Up") {
    patch.upCountDelta! += 1;
    patch.upWeightDelta! += myWeight;
  } else if (next === "Down") {
    patch.downCountDelta! += 1;
    patch.downWeightDelta! += myWeight;
  }
  return patch;
}
