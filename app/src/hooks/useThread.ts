"use client";

// useThread — fetch a thread (root + "replying to" parent + direct replies), keep it LIVE, and merge
// any pending optimistic replies (addOptimisticReply) so a just-submitted reply shows instantly.
//
// LIVENESS (mirrors useLiveFeed's fold): the focal + ancestors + already-shown replies re-read on every
// best-block tick, so vote/tally counts refresh in place without a manual refresh. NEW replies from
// SOMEONE ELSE wait behind an "N new replies" pill (`newReplyCount` / `flushReplies`) so the scroll
// never jumps; the viewer's OWN replies are promoted into the revealed set as soon as they land, so they
// show at once and stay shown even if the wallet later disconnects. Best-block is a value from
// useSession (one shared head subscription), so there is no per-thread subscription to leak — only
// in-flight fetches, guarded by a load generation + a mounted flag. (Per-block full-thread re-reads are
// fine on this preprod single-producer chain; a mainnet optimization would watch VoteTally /
// RepliesByParent per id instead.)
//
// OPTIMISTIC HANDOFF: `confirmReply(clientId)` re-reads the thread FIRST and retires the pending card in
// the same React commit, so a just-posted reply never blinks out and never double-renders. It is keyed
// by clientId (not author+text), so replying twice with the same short text ("gm", "+1") still shows
// each optimistic card; and the retire runs even if the read fails or you navigated away — no overlay leak.
//
// Focal-nav model: a screen is one focal (root) + its ancestors + direct replies; deeper replies open
// their own /post/[id]/ focal. Every reply is authored as a reply-to-focal (parentId === rootId), so the
// pending merge below (filtered on parentId === rootId) surfaces ALL optimistic replies.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOptimistic } from "./useOptimistic";
import type { FeedSource } from "@/lib/feed/source";
import { readErrorCopy } from "@/lib/chain/errors";
import type { CognoPost, ThreadView, Ss58 } from "@/lib/types";

export interface UseThread {
  thread: ThreadView | null;
  loading: boolean;
  error: string | null;
  /** Insert a pending optimistic reply under this thread; returns its clientId. */
  addOptimisticReply: (post: CognoPost) => string;
  /** A reply's tx confirmed: land the real reply, then retire its pending card in the same commit. */
  confirmReply: (clientId: string) => void;
  /** New replies from OTHERS waiting behind the "N new replies" pill (own/pending replies show at once). */
  newReplyCount: number;
  /** Reveal the buffered new replies (the pill). */
  flushReplies: () => void;
  /**
   * Re-run the initial load. The error card's Retry needs this: a FAILED cold read leaves
   * `seeded.current === false`, and the per-block live refetch early-returns on exactly that, so the
   * thread could never recover on its own. (The Retry it had called `router.refresh()`, which under
   * `output: 'export'` has no RSC payload to refetch and did nothing at all.)
   */
  reload: () => void;
}

export function useThread(
  source: FeedSource | null,
  rootId: bigint | null,
  /** The connected account, when known — threaded into the seam so the node stamps the `myVote`
   *  overlay node-side, and used to promote the viewer's OWN replies into the revealed set (others'
   *  new replies buffer behind the pill). */
  viewer?: Ss58 | null,
  /** Best-block number — ticks the live re-read that refreshes tallies + surfaces new replies. */
  bestBlock?: number | null,
): UseThread {
  const [base, setBase] = useState<ThreadView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Reply ids currently revealed to the viewer: every reply present at the first successful load of this
  // root, plus the viewer's own replies as they land, plus anything `flushReplies` reveals. A live tick
  // never adds others' replies here — that's what keeps them behind the pill.
  const [shownIds, setShownIds] = useState<Set<string>>(new Set());
  const { overlay, addPending, dropPending } = useOptimistic();
  const prevRootId = useRef<bigint | null>(null);
  // The rootId whose `shownIds` are seeded, checked at FETCH-RESOLVE time. Deliberately NOT derived from
  // `prevRootId`: that ref is advanced by the null-source early return (a cold load, where `source` is
  // null until the socket connects) and by StrictMode's cancelled first pass — either would make the
  // real load look like a same-root re-load, skip seeding, and hide every existing reply behind the pill.
  const seededRoot = useRef<bigint | null>(null);

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
  // Bumped by `reload()` to re-arm the initial-load effect (the error card's Retry).
  const [retryNonce, setRetryNonce] = useState(0);
  const reload = useCallback(() => setRetryNonce((n) => n + 1), []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Promote the viewer's OWN replies into `shownIds` the moment they land on-chain. Without this they
  // would be held visible only by the volatile `r.author === me` branch below, so disconnecting the
  // wallet (or switching accounts) would re-buffer your own just-posted reply behind the pill.
  const promoteOwn = useCallback((replies: CognoPost[]) => {
    const meNow = viewerRef.current;
    if (!meNow) return;
    setShownIds((prev) => {
      let next: Set<string> | null = null;
      for (const r of replies) {
        const k = String(r.id);
        if (r.author === meNow && !prev.has(k)) (next ??= new Set(prev)).add(k);
      }
      return next ?? prev; // same reference when nothing changed → no re-render
    });
  }, []);

  // Apply a freshly-read thread: chain truth for the focal/ancestors/tallies, plus own-reply promotion.
  const applyFresh = useCallback(
    (t: ThreadView) => {
      setBase(t);
      promoteOwn(t.replies);
    },
    [promoteOwn],
  );

  // ── initial / nav / connect load ──
  useEffect(() => {
    loadGen.current += 1;
    if (!source || rootId == null) {
      seeded.current = false;
      refetching.current = false;
      setBase(null);
      // Drop any stale error when the target is DESELECTED (rootId null → e.g. a reply/quote modal
      // closed) so it can't survive to the next target: ModalRouteHost degrades to a plain composer on
      // `error`, and a leftover error from a prior failed target would flash a false "unavailable" on the
      // first (pre-effect) render of the next one. Scoped to rootId==null so a transient source drop on a
      // live thread (rootId still set) keeps its error card.
      if (rootId == null) setError(null);
      prevRootId.current = rootId;
      return;
    }
    const freshRoot = prevRootId.current !== rootId;
    // A COLD load has nothing on screen for this root (a real nav, or the first load once the socket
    // connected). Only a cold load may surface the error card: a failed same-root re-read (wallet
    // connect, source rebuild) must NOT replace an already-rendered conversation — the next tick retries.
    const cold = freshRoot || baseRef.current == null;
    if (freshRoot) {
      // Clear the stale thread only on a real root change (A→B nav) — an unconditional clear would
      // flash a skeleton over an already-loaded thread on a viewer/source re-run. Re-arm the seed too:
      // a root we are presenting afresh (incl. A → null → A, which callers do by passing a null rootId)
      // must reveal every reply that exists NOW, not stay pinned to the set seeded on its last visit.
      seeded.current = false;
      refetching.current = false;
      seededRoot.current = null;
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
        if (seededRoot.current !== rootId) {
          // First successful load of this root: reveal every existing reply. Later same-root re-loads
          // keep the pill buffer intact (only `flushReplies` reveals what arrived since).
          setBase(t);
          setShownIds(new Set(t.replies.map((r) => String(r.id))));
          seededRoot.current = rootId;
        } else {
          applyFresh(t);
        }
        seeded.current = true;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (cold) setError(readErrorCopy(e, "Could not load the thread."));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // `retryNonce` re-arms this effect for the error card's Retry. No seed refs need resetting: a cold
    // failure leaves base=null / seeded=false / seededRoot=null, which is exactly the state a re-run
    // expects — it recomputes `cold` from baseRef and re-seeds shownIds on success.
  }, [source, rootId, viewer, applyFresh, retryNonce]);

  // ── live re-read: refresh tallies in place + surface new replies (buffered behind the pill) ──
  // Silent (no `loading`, errors swallowed), so the "Refreshing replies" indicator doesn't blink and a
  // transient failure never replaces the conversation — the next best-block tick retries.
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
        if (mounted.current && loadGen.current === gen && rootIdRef.current === rid) applyFresh(fresh);
      })
      .catch(() => {
        // Transient live-read failure — the next best-block tick retries.
      })
      .finally(() => {
        refetching.current = false;
      });
  }, [applyFresh]);

  useEffect(() => {
    refetch();
  }, [bestBlock, refetch]);

  // Land the confirmed reply BEFORE retiring its optimistic card: `setBase` (which now carries the real
  // reply, promoted into `shownIds` as the viewer's own) and `dropPending` are dispatched in the same
  // microtask, so React batches them into ONE commit — the card never blinks out and never doubles. The
  // drop runs unconditionally (failed read, unmounted, navigated away), so no pending entry can leak.
  const confirmReply = useCallback(
    (clientId: string) => {
      const src = sourceRef.current;
      const rid = rootIdRef.current;
      if (!src || rid == null) {
        dropPending(clientId);
        return;
      }
      const gen = loadGen.current;
      // `applyFresh` and `dropPending` run in ONE synchronous block (not across .then/.finally
      // microtasks), so React commits them together: the real reply appears in the very frame the
      // optimistic card disappears. A failed read still retires the card — the live tick brings it in.
      const settle = (fresh?: ThreadView) => {
        if (fresh && mounted.current && loadGen.current === gen && rootIdRef.current === rid) {
          applyFresh(fresh);
        }
        dropPending(clientId);
      };
      src.thread(rid, viewerRef.current ?? undefined).then(
        (fresh) => settle(fresh),
        () => settle(),
      );
    },
    [dropPending, applyFresh],
  );

  const me = viewer ?? null;

  // The displayed thread: focal + ancestors always from the freshest fetch (live tallies); replies =
  // the revealed set + optimistic pending. Others' new replies are withheld (they count toward
  // `newReplyCount`) until flushed. The `r.author === me` branch covers the render between an own reply
  // landing and `promoteOwn`'s state commit; `shownIds` is what keeps it visible thereafter.
  const thread = useMemo<ThreadView | null>(() => {
    if (!base) return null;
    const shownReplies = base.replies.filter(
      (r) => shownIds.has(String(r.id)) || (me != null && r.author === me),
    );
    const pendingReplies = overlay.pending
      .filter((p) => p.parentId === rootId)
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
    confirmReply,
    newReplyCount,
    flushReplies,
    reload,
  };
}
