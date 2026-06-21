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

/** Merge the overlay onto a feed snapshot: prepend pending cards, patch counts on existing rows. */
export function mergeFeed(posts: CognoPost[], overlay: Overlay): CognoPost[] {
  const patched = posts.map((p) => applyCountPatch(p, overlay.counts[String(p.id)]));
  const pendingCards = overlay.pending
    .filter((pp) => pp.status === "pending" && pp.parentId === undefined)
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
