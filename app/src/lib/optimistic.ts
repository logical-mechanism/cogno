// The optimistic overlay (doc 04 §2.11 / §3.3). A pure, app-wide overlay merged on top of the
// watched feed snapshot + the viewer-state reads, so an optimistic action (a just-posted card, a
// like, a repost) renders INSTANTLY and is not clobbered by the next feed poll before it confirms.
// On confirm the overlay entry is cleared (the real row/tally now carries it); on failure it is
// rolled back. Keyed by post id (String) so the reconciling read wins once it lands.
//
// This module is pure (no React) and unit-testable: the apply/merge math (re-vote weight reversal,
// count clamping, score recompute) lives here; useOptimistic.tsx wires it into a context.

import type { CognoPost, ProfileView, ViewerPostState } from "@/lib/types";

/** A delta over a post's aggregate tallies (applied on top of the read tally). */
export interface CountPatch {
  upCountDelta?: number;
  downCountDelta?: number;
  upWeightDelta?: bigint;
  downWeightDelta?: bigint;
}

/** The viewer's own optimistic state on a post (overrides the read ViewerPostState). */
export interface ViewerPatch {
  myVote?: "Up" | "Down" | null;
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

/**
 * An optimistic profile overwrite, keyed by ss58. `set_profile` replaces the WHOLE record, so a patch
 * carries all six display fields (an empty string = a cleared field). `expected` is set once the write
 * CONFIRMS (inBestBlock); the patch is then KEPT — not cleared — until a fresh read of the profile
 * already agrees (see {@link profilePatchSettled}), so the header/preview never flash back to the
 * pre-edit values in the gap between confirm and re-observation.
 */
export interface ProfilePatch {
  displayName: string;
  bio: string;
  avatar: string;
  banner: string;
  location: string;
  website: string;
  expected?: boolean;
}

export interface Overlay {
  pending: PendingPost[];
  counts: Record<string, CountPatch>;
  viewer: Record<string, ViewerPatch>;
  /** Optimistic profile overwrites, keyed by ss58 (set_profile / clear_profile). */
  profiles: Record<string, ProfilePatch>;
}

export const EMPTY_OVERLAY: Overlay = { pending: [], counts: {}, viewer: {}, profiles: {} };

/** A read field (`undefined` | "") and a patch field ("") are equal-absent; trim for a stable compare. */
function normProfileField(s: string | undefined): string {
  return (s ?? "").trim();
}

/**
 * Overlay a profile patch on a read ProfileView: `set_profile` overwrites all six DISPLAY fields (an
 * empty string clears that field). Counts / postCount / pinnedPostId / banned are untouched — those
 * aren't set_profile's to change.
 */
export function applyProfilePatch(view: ProfileView, patch: ProfilePatch | undefined): ProfileView {
  if (!patch) return view;
  return {
    ...view,
    displayName: normProfileField(patch.displayName) || undefined,
    bio: normProfileField(patch.bio) || undefined,
    avatar: normProfileField(patch.avatar) || undefined,
    banner: normProfileField(patch.banner) || undefined,
    location: normProfileField(patch.location) || undefined,
    website: normProfileField(patch.website) || undefined,
  };
}

/**
 * Reconcile-by-fresh-read: a CONFIRMED (`expected`) profile patch is redundant once an authoritative
 * read already carries the same six fields, and should then be retired. The CALLER must only evaluate
 * this against a read taken AFTER the confirm (a fresh post-confirm refetch) — gating on the `expected`
 * flag is what stops a still-pending patch from retiring against a not-yet-updated read.
 */
export function profilePatchSettled(view: ProfileView, patch: ProfilePatch | undefined): boolean {
  if (!patch?.expected) return false;
  return (
    normProfileField(view.displayName) === normProfileField(patch.displayName) &&
    normProfileField(view.bio) === normProfileField(patch.bio) &&
    normProfileField(view.avatar) === normProfileField(patch.avatar) &&
    normProfileField(view.banner) === normProfileField(patch.banner) &&
    normProfileField(view.location) === normProfileField(patch.location) &&
    normProfileField(view.website) === normProfileField(patch.website)
  );
}

/** Apply a count patch to a post's tallies (counts AND weights clamp at 0; score recomputed from weights). */
export function applyCountPatch(post: CognoPost, patch: CountPatch | undefined): CognoPost {
  if (!patch) return post;
  // Clamp weights at 0 like the chain's `saturating_sub`. Composing a reversal at a DIFFERENT weight
  // than the vote was cast at over-subtracts below zero: every surface passes `votingPower ?? 0n`, so a
  // vote cast while VotingPower is still loading applies +0, and reversing it once the real power has
  // loaded applies -N against a base of 0 — rendering a NEGATIVE weight and a doubly-negative score.
  // `useAccountVote.merge` has floored this since it shipped; the post path never did.
  const upSum = (post.upWeight ?? 0n) + (patch.upWeightDelta ?? 0n);
  const downSum = (post.downWeight ?? 0n) + (patch.downWeightDelta ?? 0n);
  const upWeight = upSum < 0n ? 0n : upSum;
  const downWeight = downSum < 0n ? 0n : downSum;
  return {
    ...post,
    upCount: Math.max(0, (post.upCount ?? 0) + (patch.upCountDelta ?? 0)),
    downCount: Math.max(0, (post.downCount ?? 0) + (patch.downCountDelta ?? 0)),
    upWeight,
    downWeight,
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

/**
 * "This viewer has no relationship to this post" — the fallback for a post whose viewer state hasn't
 * been read yet, or for a signed-out reader.
 *
 * ONE frozen object, not seven. It was declared verbatim in six surfaces (as `NO_VIEWER`) plus a
 * seventh under a different name (`NONE`, in useViewerStates), and every one of them minted a fresh
 * `{ myVote: null }` — so an unread card handed `PostCard` a new object identity on every render, which
 * is exactly what a memoized card cannot tolerate. Lives here rather than in components/kit.ts, which
 * is type-only: putting a runtime value there would force hooks to import from components.
 */
export const NO_VIEWER: ViewerPostState = Object.freeze({ myVote: null });

/** Apply a viewer patch over a read ViewerPostState (undefined fields keep the base value). */
export function applyViewerPatch(
  base: ViewerPostState,
  patch: ViewerPatch | undefined,
): ViewerPostState {
  if (!patch) return base;
  return {
    myVote: patch.myVote !== undefined ? patch.myVote : base.myVote,
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

/**
 * A monotonic, strictly-NEGATIVE placeholder id for an optimistic pending post. Negative so it never
 * collides with a real (non-negative) chain post id — the load-bearing "pending" marker that Timeline
 * and the inline-poll gate branch on (`post.id < 0n`) — and unique per call so two posts submitted in
 * the SAME millisecond never share a React key (which the old `-BigInt(Date.now())` scheme could).
 */
let pendingIdSeq = 0;
export function nextPendingId(): bigint {
  return -BigInt(++pendingIdSeq);
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
