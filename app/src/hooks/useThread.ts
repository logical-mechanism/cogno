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
// OLDER REPLIES (spec 216): the node's `thread()` returns the NEWEST page (512) plus a cursor, and
// `loadOlderReplies` walks BACK down the focal's reply spine one page per user request
// (`MicroblogApi.replies_page`). Before that read existed, `thread()` returned the OLDEST 512 with no
// cursor at all: past the cap a conversation was permanently missing its most recent end — the end this
// surface renders at the bottom — so it looked complete and was not, and a reply you had just posted
// never came back from the confirm re-read.
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

/** How many older replies one "Show older" fetch pulls off the chain. */
const OLDER_REPLIES_PAGE = 50;

/**
 * The fetched older-replies window: `posts` covers reply seqs `[cursor, anchor)`, chronologically, and
 * the thread's own newest page covers `[anchor, replyCount)`. `null` means seq 0 on either side —
 * "reaches the conversation's first reply".
 */
export interface OlderReplies {
  posts: CognoPost[];
  /** Exclusive seq the next older page starts below; null once the first reply is loaded. */
  cursor: bigint | null;
  /** The `repliesCursor` this window was built against — where the newest page currently starts. */
  anchor: bigint | null;
}

/**
 * Re-anchor the older-replies window against a freshly-read thread, keeping the two halves ADJACENT.
 *
 * The runtime computes `Thread.repliesCursor` as `replyCount - MAX_THREAD_REPLIES`, so on a thread past
 * 512 replies it advances by ONE PER NEW REPLY. Each advance slides the newest page up the spine and
 * pushes its oldest entries out of it; those replies are in neither half unless they are moved here, and
 * a hole in the middle of a conversation is invisible to the reader.
 *
 * They need no fetch: the replies that fell out are the ones the page being replaced held and the
 * fresh page no longer does. Carry them.
 *
 * Identified by SET DIFFERENCE against the fresh page, not by slicing `prevReplies` at the seq delta.
 * The delta counts SPINE SLOTS while the slice counts ARRAY ELEMENTS, and those agree only while the
 * page is dense over its seq span. `withServeDenylist.thread()` filters replies out of the page while
 * passing `repliesCursor` through unshortened (deliberately — the cursor is a spine position), so on a
 * deployment with a non-empty denylist the slice took a reply the fresh page STILL holds and rendered
 * it twice, under a duplicate React key, compounding on every slide. The difference is exact under any
 * filtering, because both pages are filtered the same way.
 *
 * Still bounded by the slot delta: at most `slid` replies can have left the page, so a reply that
 * vanished for any OTHER reason (the runtime denylist arriving between two reads) is not carried back in.
 *
 * Returns the SAME window object when nothing slid, which is every thread under one page (both cursors
 * stay null) — so the common case causes no re-render.
 */
export function reanchorReplyWindow(
  win: OlderReplies,
  freshCursor: bigint | null,
  prevReplies: CognoPost[] | null,
  freshReplies: CognoPost[] | null,
): OlderReplies {
  if (win.anchor === freshCursor) return win;
  const from = win.anchor ?? 0n;
  const to = freshCursor ?? 0n;
  const slid = to > from ? Number(to - from) : 0;
  if (slid > 0 && prevReplies && prevReplies.length >= slid) {
    const kept = new Set((freshReplies ?? []).map((p) => String(p.id)));
    const fell = prevReplies.filter((p) => !kept.has(String(p.id))).slice(0, slid);
    return { ...win, posts: [...win.posts, ...fell], anchor: freshCursor };
  }
  // Nothing to carry (a first load), or the previous page cannot cover the gap (the count moved by more
  // than a whole page between two reads). Re-anchor EMPTY: a window that visibly starts again is honest,
  // where one spliced across a hole reads as a complete conversation and is not.
  return { posts: [], cursor: freshCursor, anchor: freshCursor };
}

export interface UseThread {
  thread: ThreadView | null;
  /**
   * Direct replies the chain says exist that are not loaded yet — the ones OLDER than the page the
   * node returned, still reachable with {@link UseThread.loadOlderReplies}. Drives the count on the
   * "Show N older replies" control.
   *
   * Derived from the RAW read, deliberately, and not from `thread` — by the time the returned
   * `thread` is assembled its `replies` have been narrowed by the new-reply pill (`shownIds`) and
   * widened by the optimistic overlay, so comparing its own two fields reports a phantom shortfall
   * every time a reply is buffered behind the pill. `base` plus the loaded older pages is the only
   * place the numbers mean what they look like: `replyCount` is the exact on-chain `ReplyCount`
   * aggregate, and the two lists are what the node actually returned.
   *
   * Before spec 216 this was `unreachableReplies` and it meant what it said: `thread()` sorted reply
   * ids ascending, took the first 512 and had no cursor, so a thread past the cap was permanently
   * missing its most recent end — the end this surface renders at the bottom. It now returns the
   * NEWEST page plus a cursor, so nothing is unreachable and this is only "not fetched yet".
   */
  unloadedReplies: number;
  /** Whether the chain holds older replies this hook has not fetched (the control's enabled state). */
  hasOlderReplies: boolean;
  /** Fetch the next page of OLDER replies and prepend them. No-op while one is in flight. */
  loadOlderReplies: () => void;
  /** An older-replies page is in flight. */
  loadingOlder: boolean;
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
  // Replies OLDER than `base.replies`, fetched a page at a time and kept chronological (oldest first).
  //
  // `cursor` is the exclusive seq the next page starts below (null ⇒ the conversation's first reply is
  // loaded). `anchor` is the `base.repliesCursor` this window was built against, so these posts cover
  // seqs `[cursor, anchor)` and `base.replies` covers `[anchor, replyCount)`. Keeping those two ranges
  // ADJACENT is the whole job: `base.replies` is the newest page, so it slides UP the spine as replies
  // land, and anything it slides past is in neither list — a silent hole in the middle of a
  // conversation.
  //
  // The cursor moves by ONE PER REPLY, not once per page: the runtime computes it as
  // `replyCount - MAX_THREAD_REPLIES`, so on any thread past 512 replies every single new reply
  // re-anchors. `reanchorOlder` therefore CARRIES the replies that fell out of the base window into
  // this list rather than dropping the list and starting over — they are exactly the oldest entries of
  // the base page we are replacing, so no fetch is needed to recover them. (Dropping was the first cut,
  // written against the belief that a re-anchor took 512 new replies. It takes one, which on a busy
  // thread meant the older half could never be assembled at all.)
  //
  // These pages are NOT re-read per block: the live tick is about the newest end of a conversation, and
  // re-reading every page a reader has walked back through would cost a state_call per page every ~6s
  // to move tallies nobody is looking at.
  const [older, setOlder] = useState<OlderReplies>({ posts: [], cursor: null, anchor: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const olderRef = useRef(older);
  olderRef.current = older;
  const loadingOlderRef = useRef(false);
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

  // Keep the older-replies window adjacent to the page `base` actually returned. Pure, and exported, so
  // the carry logic is directly testable: `vitest` runs in a `node` environment here, so no hook can be
  // rendered and this is the only way to pin behaviour that only appears past 512 replies.
  const reanchorOlder = useCallback((t: ThreadView, prev: ThreadView | null) => {
    setOlder((win) => reanchorReplyWindow(win, t.repliesCursor, prev?.replies ?? null, t.replies));
  }, []);

  // Apply a freshly-read thread: chain truth for the focal/ancestors/tallies, plus own-reply promotion.
  //
  // `baseRef` is advanced HERE rather than left to the render-time assignment, so it names the page
  // actually replaced even when two reads settle in the same tick (a `confirmReply` re-read landing
  // beside a best-block refetch — `refetching` only stops refetches stacking on each other). Reading a
  // render-stale ref there would have handed the re-anchor a page from the wrong position and carried
  // the wrong replies across.
  const applyFresh = useCallback(
    (t: ThreadView) => {
      const prev = baseRef.current;
      baseRef.current = t;
      setBase(t);
      promoteOwn(t.replies);
      reanchorOlder(t, prev);
    },
    [promoteOwn, reanchorOlder],
  );

  // ── initial / nav / connect load ──
  useEffect(() => {
    loadGen.current += 1;
    if (!source || rootId == null) {
      seeded.current = false;
      refetching.current = false;
      setBase(null);
      baseRef.current = null; // kept in step with `base` — the re-anchor reads it as the previous page
      setOlder({ posts: [], cursor: null, anchor: null });
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
      baseRef.current = null;
      // The older-replies window belongs to the focal we are leaving — its cursor is a seq in THAT
      // post's reply spine and means nothing under another one.
      setOlder({ posts: [], cursor: null, anchor: null });
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
          baseRef.current = t;
          setShownIds(new Set(t.replies.map((r) => String(r.id))));
          // A first load of this root has nothing to carry — the window is empty by construction here
          // (both the deselect and the nav branch above clear it), so this only adopts the anchor.
          reanchorOlder(t, null);
          seededRoot.current = rootId;
        } else {
          applyFresh(t);
        }
        seeded.current = true;
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (cold) setError(readErrorCopy(e, "Couldn't load this thread."));
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
  }, [source, rootId, viewer, applyFresh, reanchorOlder, retryNonce]);

  // ── older replies: walk BACK down the focal's reply spine, a page per user request ──
  // Cursor-paged off `MicroblogApi.replies_page`, so a conversation of any length is fully readable.
  // Never automatic: a thread's older end is only fetched when someone asks for it.
  const loadOlderReplies = useCallback(() => {
    const src = sourceRef.current;
    const rid = rootIdRef.current;
    const win = olderRef.current;
    if (!src || rid == null || win.cursor == null || loadingOlderRef.current) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const gen = loadGen.current;
    src
      .repliesPage(rid, win.cursor, OLDER_REPLIES_PAGE, viewerRef.current ?? undefined)
      .then((page) => {
        if (!mounted.current || loadGen.current !== gen || rootIdRef.current !== rid) return;
        setOlder((prev) => {
          // Drop the page if the OLDER end moved under this fetch — that is the end it splices onto,
          // so anywhere else it would sit at a position it no longer belongs at. The control is still
          // there to ask again.
          //
          // `anchor` deliberately does NOT gate this. It moves once per new reply on any thread past
          // the page size (the runtime derives the cursor as `replyCount - MAX_THREAD_REPLIES`), and the
          // carry branch of `reanchorReplyWindow` moves ONLY `anchor`, appending at the opposite end and
          // leaving `cursor` alone. Gating on it threw away a page that was still exactly adjacent, so
          // on a busy thread the fetch could lose the race indefinitely and the tap read as dead.
          if (prev.cursor !== win.cursor) return prev;
          const seen = new Set(prev.posts.map((p) => String(p.id)));
          // The page arrives newest-first; this list is chronological, and it grows at the FRONT.
          const fresh = page.posts.filter((p) => !seen.has(String(p.id))).reverse();
          return { ...prev, posts: [...fresh, ...prev.posts], cursor: page.nextCursor };
        });
      })
      .catch(() => {
        // Transient read failure. Deliberately silent and deliberately NOT advancing the cursor: the
        // control stays exactly where it was, so tapping it again retries the same page.
      })
      .finally(() => {
        loadingOlderRef.current = false;
        if (mounted.current) setLoadingOlder(false);
      });
  }, []);

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
    if (
      pendingReplies.length === 0 &&
      shownReplies.length === base.replies.length &&
      older.posts.length === 0
    ) {
      return base;
    }
    return {
      ...base,
      // Fetched older pages first: the whole list stays chronological, so the tail slice ThreadView
      // renders is still the newest end of the conversation.
      replies: [...older.posts, ...shownReplies, ...pendingReplies],
      replyCount: base.replyCount + pendingReplies.length,
    };
  }, [base, shownIds, overlay, rootId, me, older.posts]);

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

  // See the doc on `UseThread.unloadedReplies` for why this reads `base` + the fetched pages and never
  // the assembled `thread`.
  const unloadedReplies = useMemo(
    () =>
      base ? Math.max(0, base.replyCount - base.replies.length - older.posts.length) : 0,
    [base, older.posts.length],
  );

  return {
    thread,
    unloadedReplies,
    hasOlderReplies: older.cursor != null,
    loadOlderReplies,
    loadingOlder,
    loading,
    error,
    addOptimisticReply: (post: CognoPost) => addPending(post, rootId ?? undefined),
    confirmReply,
    newReplyCount,
    flushReplies,
    reload,
  };
}
