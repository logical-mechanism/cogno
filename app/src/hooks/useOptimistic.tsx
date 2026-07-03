"use client";

// useOptimistic — the app-wide optimistic overlay context. The write hooks (useVote / useRepost /
// useFollow / usePoll / useThread / the composer) apply a delta here immediately, then clear it on
// confirm or roll it back on failure. The read hooks (useOptimisticFeed / useViewerStates) merge it
// on top of chain truth so the next feed poll never clobbers an unconfirmed action mid-flight.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_OVERLAY,
  profilePatchSettled,
  type Overlay,
  type CountPatch,
  type ViewerPatch,
  type PendingPost,
  type ProfilePatch,
} from "@/lib/optimistic";
import type { CognoPost, ProfileView } from "@/lib/types";

export interface OptimisticApi {
  overlay: Overlay;
  /** Insert a pending optimistic post (new post / reply / quote). Returns its clientId. */
  addPending: (post: CognoPost, parentId?: bigint) => string;
  /** Drop a pending card (called on confirm — the real row now carries it). */
  dropPending: (clientId: string) => void;
  /** Mark a pending card failed then drop it (rollback). */
  failPending: (clientId: string) => void;
  /** Merge a count delta for a post (additive over any existing patch). */
  patchCounts: (postId: bigint, patch: CountPatch) => void;
  /** Set the viewer's optimistic state on a post. */
  patchViewer: (postId: bigint, patch: ViewerPatch) => void;
  /**
   * A vote has CONFIRMED (inBestBlock). Hand the stake-weighted count delta off to the chain read
   * (the feed now carries `VoteTally`), but KEEP the viewer (colour) patch — flagged `expected` — so
   * the colour does not drop to a stale read. The read layer retires it once a fresh read agrees.
   */
  confirmPost: (postId: bigint) => void;
  /** Clear a post's count + viewer patches (rollback on error, or after a confirmed vote settles). */
  clearPost: (postId: bigint) => void;
  /** Apply an optimistic profile overwrite for an ss58 (set_profile / clear_profile). */
  patchProfile: (ss58: string, patch: Omit<ProfilePatch, "expected">) => void;
  /**
   * A profile write has CONFIRMED (inBestBlock). KEEP the patch — flagged `expected` — so the header
   * doesn't flash back to the pre-edit values before a fresh read re-observes it; the read layer
   * retires it once a fresh read agrees, with a TTL backstop.
   */
  confirmProfile: (ss58: string) => void;
  /** Roll back an optimistic profile patch (write failed). */
  rollbackProfile: (ss58: string) => void;
  /** Retire a confirmed profile patch once a fresh read already carries the same fields. */
  reconcileProfile: (ss58: string, view: ProfileView) => void;
}

const Ctx = createContext<OptimisticApi | null>(null);

function addCountPatch(a: CountPatch | undefined, b: CountPatch): CountPatch {
  return {
    upCountDelta: (a?.upCountDelta ?? 0) + (b.upCountDelta ?? 0),
    downCountDelta: (a?.downCountDelta ?? 0) + (b.downCountDelta ?? 0),
    upWeightDelta: (a?.upWeightDelta ?? 0n) + (b.upWeightDelta ?? 0n),
    downWeightDelta: (a?.downWeightDelta ?? 0n) + (b.downWeightDelta ?? 0n),
    repostCountDelta: (a?.repostCountDelta ?? 0) + (b.repostCountDelta ?? 0),
  };
}

// Safety valve: a confirmed vote patch should retire when a fresh read agrees, but never wedge the
// chip if that read somehow never lands (reorg, stalled subscription) — force-clear after this grace.
const CONFIRM_TTL_MS = 15_000;

// A confirmed profile patch is kept until a fresh read agrees; this backstop retires it if that read
// never lands (surface unmounted, stalled subscription). Longer than a vote's — a profile read can be
// indexer-derived (slower to reflect) and there's no per-field chip to wedge, only stale display text.
const PROFILE_CONFIRM_TTL_MS = 20_000;

export function OptimisticProvider({ children }: { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const seq = useRef(0);
  // Per-post TTL timers for confirmed-but-not-yet-reconciled vote patches.
  const confirmTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Per-ss58 TTL timers for confirmed-but-not-yet-reconciled profile patches.
  const profileTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const addPending = useCallback((post: CognoPost, parentId?: bigint): string => {
    const clientId = `pending-${seq.current++}`;
    const entry: PendingPost = { clientId, post, parentId, status: "pending" };
    setOverlay((o) => ({ ...o, pending: [entry, ...o.pending] }));
    return clientId;
  }, []);

  const dropPending = useCallback((clientId: string) => {
    setOverlay((o) => ({ ...o, pending: o.pending.filter((p) => p.clientId !== clientId) }));
  }, []);

  const failPending = useCallback((clientId: string) => {
    // Mark failed (for a brief styling beat if the surface wants it), then drop on the next tick.
    setOverlay((o) => ({
      ...o,
      pending: o.pending.map((p) => (p.clientId === clientId ? { ...p, status: "failed" } : p)),
    }));
    setOverlay((o) => ({ ...o, pending: o.pending.filter((p) => p.clientId !== clientId) }));
  }, []);

  const patchCounts = useCallback((postId: bigint, patch: CountPatch) => {
    const key = String(postId);
    setOverlay((o) => ({ ...o, counts: { ...o.counts, [key]: addCountPatch(o.counts[key], patch) } }));
  }, []);

  const patchViewer = useCallback((postId: bigint, patch: ViewerPatch) => {
    const key = String(postId);
    setOverlay((o) => ({ ...o, viewer: { ...o.viewer, [key]: { ...o.viewer[key], ...patch } } }));
  }, []);

  const clearPost = useCallback((postId: bigint) => {
    const key = String(postId);
    const timer = confirmTimers.current.get(key);
    if (timer) {
      clearTimeout(timer);
      confirmTimers.current.delete(key);
    }
    setOverlay((o) => {
      const counts = { ...o.counts };
      const viewer = { ...o.viewer };
      delete counts[key];
      delete viewer[key];
      return { ...o, counts, viewer };
    });
  }, []);

  const confirmPost = useCallback(
    (postId: bigint) => {
      const key = String(postId);
      setOverlay((o) => {
        // KEEP the count patch — do NOT hand it to the read yet. The home feed is head-id driven and a
        // vote creates no new post, so it does NOT refetch on a vote; dropping the count here would snap
        // the tally back to the pre-vote value (the "goes to 0" bug). Both the count AND viewer patches
        // are retired TOGETHER (clearPost) once a fresh read actually reflects the vote — the feed's
        // reconcile-refetch (useLiveFeed) or the per-card read (useViewerStates) does that. We only flag
        // the viewer (colour) patch `expected` so the reconcile can fire; the TTL is the last-resort valve.
        const v = o.viewer[key];
        if (!v) return o;
        return { ...o, viewer: { ...o.viewer, [key]: { ...v, expected: true } } };
      });
      const prev = confirmTimers.current.get(key);
      if (prev) clearTimeout(prev);
      confirmTimers.current.set(
        key,
        setTimeout(() => {
          confirmTimers.current.delete(key);
          clearPost(postId);
        }, CONFIRM_TTL_MS),
      );
    },
    [clearPost],
  );

  // ── profile overlay (set_profile / clear_profile) ──────────────────────────────────────────────
  const clearProfilePatch = useCallback((ss58: string) => {
    const timer = profileTimers.current.get(ss58);
    if (timer) {
      clearTimeout(timer);
      profileTimers.current.delete(ss58);
    }
    setOverlay((o) => {
      if (!o.profiles[ss58]) return o;
      const profiles = { ...o.profiles };
      delete profiles[ss58];
      return { ...o, profiles };
    });
  }, []);

  const patchProfile = useCallback((ss58: string, patch: Omit<ProfilePatch, "expected">) => {
    // A fresh apply supersedes any prior pending patch/timer for this account.
    const prev = profileTimers.current.get(ss58);
    if (prev) {
      clearTimeout(prev);
      profileTimers.current.delete(ss58);
    }
    setOverlay((o) => ({ ...o, profiles: { ...o.profiles, [ss58]: { ...patch, expected: false } } }));
  }, []);

  const confirmProfile = useCallback(
    (ss58: string) => {
      setOverlay((o) => {
        const p = o.profiles[ss58];
        if (!p) return o;
        return { ...o, profiles: { ...o.profiles, [ss58]: { ...p, expected: true } } };
      });
      const prev = profileTimers.current.get(ss58);
      if (prev) clearTimeout(prev);
      profileTimers.current.set(
        ss58,
        setTimeout(() => {
          profileTimers.current.delete(ss58);
          clearProfilePatch(ss58);
        }, PROFILE_CONFIRM_TTL_MS),
      );
    },
    [clearProfilePatch],
  );

  const rollbackProfile = useCallback(
    (ss58: string) => clearProfilePatch(ss58),
    [clearProfilePatch],
  );

  const reconcileProfile = useCallback(
    (ss58: string, view: ProfileView) => {
      // Only retire once the write has confirmed AND a fresh read already carries the same fields.
      if (profilePatchSettled(view, overlay.profiles[ss58])) clearProfilePatch(ss58);
    },
    [overlay.profiles, clearProfilePatch],
  );

  // Tear down any pending TTL timers on unmount (a timer outliving the provider is a leak).
  useEffect(() => {
    const timers = confirmTimers.current;
    const pTimers = profileTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      pTimers.forEach((t) => clearTimeout(t));
      pTimers.clear();
    };
  }, []);

  const value = useMemo<OptimisticApi>(
    () => ({
      overlay,
      addPending,
      dropPending,
      failPending,
      patchCounts,
      patchViewer,
      confirmPost,
      clearPost,
      patchProfile,
      confirmProfile,
      rollbackProfile,
      reconcileProfile,
    }),
    [
      overlay,
      addPending,
      dropPending,
      failPending,
      patchCounts,
      patchViewer,
      confirmPost,
      clearPost,
      patchProfile,
      confirmProfile,
      rollbackProfile,
      reconcileProfile,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Access the optimistic overlay. Returns a no-op overlay when no provider is mounted (SSG-safe). */
export function useOptimistic(): OptimisticApi {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return {
    overlay: EMPTY_OVERLAY,
    addPending: () => "",
    dropPending: () => {},
    failPending: () => {},
    patchCounts: () => {},
    patchViewer: () => {},
    confirmPost: () => {},
    clearPost: () => {},
    patchProfile: () => {},
    confirmProfile: () => {},
    rollbackProfile: () => {},
    reconcileProfile: () => {},
  };
}
