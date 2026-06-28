"use client";

// useOptimistic — the app-wide optimistic overlay context. The write hooks (useVote / useRepost /
// useFollow / usePoll / useThread / the composer) apply a delta here immediately, then clear it on
// confirm or roll it back on failure. The read hooks (useOptimisticFeed / useViewerStates) merge it
// on top of chain truth so the next feed poll never clobbers an unconfirmed action mid-flight.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  EMPTY_OVERLAY,
  type Overlay,
  type CountPatch,
  type ViewerPatch,
  type PendingPost,
} from "@/lib/optimistic";
import type { CognoPost } from "@/lib/types";

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

export function OptimisticProvider({ children }: { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay>(EMPTY_OVERLAY);
  const seq = useRef(0);
  // Per-post TTL timers for confirmed-but-not-yet-reconciled vote patches.
  const confirmTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

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
        // Hand the vote's stake-weighted count delta to the chain read (the feed carries VoteTally
        // now), but PRESERVE any co-pending repost count on the same post, and keep the viewer
        // (colour) patch flagged `expected` so it survives until a fresh read re-observes the vote.
        const counts = { ...o.counts };
        const existing = counts[key];
        if (existing) {
          if (existing.repostCountDelta) counts[key] = { repostCountDelta: existing.repostCountDelta };
          else delete counts[key];
        }
        const v = o.viewer[key];
        const viewer = v ? { ...o.viewer, [key]: { ...v, expected: true } } : o.viewer;
        return { ...o, counts, viewer };
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

  // Tear down any pending TTL timers on unmount (a timer outliving the provider is a leak).
  useEffect(() => {
    const timers = confirmTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

  const value = useMemo<OptimisticApi>(
    () => ({ overlay, addPending, dropPending, failPending, patchCounts, patchViewer, confirmPost, clearPost }),
    [overlay, addPending, dropPending, failPending, patchCounts, patchViewer, confirmPost, clearPost],
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
  };
}
