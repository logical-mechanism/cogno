"use client";

// useThread — fetch a thread (root + "replying to" parent + direct replies), keep it LIVE, and merge
// any pending optimistic replies (addOptimisticReply) so a just-submitted reply shows instantly.
//
// LIVENESS (mirrors useLiveFeed's fold): the focal + ancestors + already-shown replies re-read on every
// best-block tick, so vote/tally counts update in place without a manual refresh. NEW replies from
// SOMEONE ELSE wait behind an "N new replies" pill (`newReplyCount` / `flushReplies`) so the scroll
// never jumps; the viewer's OWN new reply shows immediately (`r.author === me`), handed off from its
// optimistic card once it lands on-chain. Best-block is a value from useSession (one shared head
// subscription), so there is no per-thread subscription to leak — only in-flight fetches, guarded by a
// load generation + a mounted flag. (Per-block full-thread re-reads are fine on this preprod
// single-producer chain; a mainnet optimization would watch VoteTally / RepliesByParent per id instead.)
//
// Optimistic replies are retired by clientId when their tx CONFIRMS (the surface's phase toast, which is
// app-level so it fires even after you navigate away — no overlay leak) rather than by an author+text
// key, so replying with the same short text twice ("gm", "+1") still shows each optimistic card.
//
// Focal-nav model: a screen is one focal (root) + its ancestors + direct replies; deeper replies open
// their own /post/[id]/ focal. Every reply is authored as a reply-to-focal (parentId === rootId), so the
// pending merge below (filtered on parentId === rootId) surfaces ALL optimistic replies.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoPost, ThreadView, Ss58 } from "@/lib/types";

export interface UseThread {
  thread: ThreadView | null;
  loading: boolean;
  error: string | null;
  /** Insert a pending optimistic reply under this thread; returns its clientId. */
  addOptimisticReply: (post: CognoPost) => string;
  /** New replies from OTHERS waiting behind the "N new replies" pill (own/pending replies show at once). */
  newReplyCount: number;
  /** Reveal the buffered new replies (the pill). */
  flushReplies: () => void;
}

export function useThread(
  source: FeedSource | null,
  rootId: bigint | null,
  /** The connected account, when known — threaded into the seam so a spec-120 node stamps the
   *  myVote/reposted overlay node-side (keyed/indexer paths ignore it), and used to tell the viewer's
   *  OWN new replies (show at once) from others' (buffer behind the pill). */
  viewer?: Ss58 | null,
  /** Best-block number — ticks the live re-read that refreshes tallies + surfaces new replies. */
  bestBlock?: number | null,
): UseThread {
  const [base, setBase] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reply ids currently revealed to the viewer. Seeded to EVERY reply on a real ROOT change; a live tick
  // (and a same-root viewer/source re-load) never touches it, so replies buffered behind the pill stay
  // buffered until `flushReplies`. Own replies are shown via the author check below, never via this set.
  const [shownIds, setShownIds] = useState<Set<string>>(new Set());
  const { overlay, addPending } = useOptimistic();
  const prevRootId = useRef<bigint | null>(null);

  // Latest values reachable inside the stable, best-block-driven refetch without re-subscribing.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const rootIdRef = useRef(rootId);
  rootIdRef.current = rootId;
  const viewerRef = useRef(viewer ?? null);
  viewerRef.current = viewer ?? null;
  const baseRef = useRef(base);
  baseRef.current = base;
  const seeded = useRef(false); // the initial fetch for the current rootId has landed
  const refetching = useRef(false); // a background live refetch is in flight (don't stack them)
  // Bumped on every (re)load (root / viewer / source change). A refetch captures it at call time and
  // drops its result if a newer load superseded it — so a stale-viewer refetch can't clobber a fresher,
  // viewer-stamped fetch on the same root.
  const loadGen = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // ── initial / nav / connect load — sets the baseline; reveals every existing reply ONLY on a real
  //    root change (a same-root viewer/source re-load must not silently flush the pill buffer). ──
  useEffect(() => {
    loadGen.current += 1;
    if (!source || rootId == null) {
      seeded.current = false;
      refetching.current = false;
      setBase(null);
      prevRootId.current = rootId;
      return;
    }
    const freshRoot = prevRootId.current !== rootId;
    // Clear the stale thread only on a real root change (A→B nav), NOT on viewer/source re-runs with the
    // same root — an unconditional clear would flash a skeleton over an already-loaded thread.
    if (freshRoot) {
      seeded.current = false;
      refetching.current = false;
      setBase(null);
    }
    prevRootId.current = rootId;
    let cancelled = false;
    setLoading(true);
    setError(null);
    source
      .thread(rootId, viewer ?? undefined)
      .then((t) => {
        if (cancelled) return;
        setBase(t);
        // Reveal everything only on a real root change; a same-root re-load keeps the pill buffer intact.
        if (freshRoot) setShownIds(new Set(t.replies.map((r) => String(r.id))));
        seeded.current = true;
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load the thread");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [source, rootId, viewer]);

  // ── live re-read: refresh tallies in place + surface new replies (buffered behind the pill) ──
  // Silent (no `loading`), so the "Refreshing replies" indicator doesn't blink every block.
  const refetch = useCallback(() => {
    const src = sourceRef.current;
    const rid = rootIdRef.current;
    const gen = loadGen.current;
    if (!src || rid == null || !seeded.current || refetching.current) return;
    refetching.current = true;
    src
      .thread(rid, viewerRef.current ?? undefined)
      .then((fresh) => {
        // Drop the result if we unmounted, navigated to another focal, or a newer (re)load superseded us.
        if (mounted.current && loadGen.current === gen && rootIdRef.current === rid) setBase(fresh);
      })
      .catch(() => {
        // Transient live-read failure — the next best-block tick retries.
      })
      .finally(() => {
        refetching.current = false;
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [bestBlock, refetch]);

  const me = viewer ?? null;

  // The displayed thread: focal + ancestors always from the freshest fetch (live tallies); replies =
  // the revealed set (shown ∪ the viewer's own) + optimistic pending. New others' replies are withheld
  // (they count toward `newReplyCount`) until flushed. A pending reply is retired by clientId on
  // tx-confirm (see the surface), so it's appended unconditionally here — no author+text dedup that
  // would swallow a duplicate-text reply.
  const thread = useMemo<ThreadView | null>(() => {
    if (!base) return null;
    const shownReplies = base.replies.filter(
      (r) => shownIds.has(String(r.id)) || (me != null && r.author === me),
    );
    const pendingReplies = overlay.pending
      .filter((p) => p.status === "pending" && p.parentId === rootId)
      .map((p) => p.post);
    if (pendingReplies.length === 0 && shownReplies.length === base.replies.length) return base;
    return {
      ...base,
      replies: [...shownReplies, ...pendingReplies],
      replyCount: base.replyCount + pendingReplies.length,
    };
  }, [base, shownIds, overlay, rootId, me]);

  const newReplyCount = useMemo(() => {
    if (!base) return 0;
    return base.replies.filter(
      (r) => !shownIds.has(String(r.id)) && !(me != null && r.author === me),
    ).length;
  }, [base, shownIds, me]);

  const flushReplies = useCallback(() => {
    const b = baseRef.current;
    if (!b) return;
    setShownIds(new Set(b.replies.map((r) => String(r.id))));
  }, []);

  return {
    thread,
    loading,
    error,
    addOptimisticReply: (post: CognoPost) => addPending(post, rootId ?? undefined),
    newReplyCount,
    flushReplies,
  };
}
