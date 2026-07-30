"use client";

// usePollVoters — the roster behind a governance poll, read LAZILY and a page at a time.
//
// LAZY IS THE POINT. This used to fire in an effect the moment a poll rendered, so every reader who
// opened a poll paid a full `PollVotes` prefix enumeration — about 0.42 KB per voter, whether or not
// they ever scrolled far enough to see a single name. `enabled` puts the first read behind the reader
// actually asking for it, which is the one change that matters at any poll size.
//
// PAGED, not capped. The old read pulled everything and sliced the first 200 client-side, so a large
// poll cost megabytes to render an ss58-alphabetical sample, and `truncated` had to admit the rest was
// unreachable. Now a page is a page: ~50 rows, resumed by storage cursor, with no cap and nothing hidden.
//
// Order is storage (hash) order — arbitrary but STABLE, so appending page 2 never reshuffles page 1.
// It is deliberately not ranked: there is no per-voter weight read and no per-vote block height on
// chain, so no meaningful ranking exists and the surface must not imply one.
//
// Read once per poll, not per block, for the same reason the reply vote chip is: a roster refreshing
// every 6 seconds would be the hottest reader on the page and would still disagree with the bars above
// it. `nonce` forces a re-read after the viewer's own cast, the one change they expect to see at once.
//
// Never throws: a failed page leaves what has loaded and stops, rather than blanking the list. "Nobody
// voted" is not a claim to make on a failed read.

import { useCallback, useEffect, useRef, useState } from "react";
import type { FeedSource } from "@/lib/feed/source";
import type { PollVoter } from "@/lib/chain/social-reads";

export interface UsePollVoters {
  /** Loaded so far, in storage order. `null` until the first page lands (or while disabled). */
  voters: PollVoter[] | null;
  /** The poll's option labels, in on-chain index order. Arrives with the first page; empty until then. */
  labels: string[];
  /**
   * TRUE per-option voter counts from `PollTally` — the real split, not a count of what has loaded.
   *
   * Read EAGERLY, unlike the voter pages, because the two have different cost shapes: this is one row
   * per option (a handful, whatever the electorate) while a page is unbounded. It also has to be eager
   * or the disclosure has nothing to offer — "Show who voted (N)" needs N before anyone has opened it.
   */
  totals: { label: string; count: number }[];
  /** A page request is in flight (the first one, or a `loadMore`). */
  loading: boolean;
  /** The prefix has more behind the cursor. */
  hasMore: boolean;
  /** Fetch the next page. No-op while loading, when exhausted, or while disabled. */
  loadMore: () => void;
  /** The first page failed and nothing is loaded — the surface offers a retry rather than "nobody". */
  failed: boolean;
}

export function usePollVoters(
  source: FeedSource | null,
  hostId: bigint | null,
  isPoll: boolean,
  /** The reader has asked to see the roster. FALSE ⇒ nothing is read at all. */
  enabled: boolean,
  nonce = 0,
): UsePollVoters {
  const [voters, setVoters] = useState<PollVoter[] | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [totals, setTotals] = useState<{ label: string; count: number }[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // Exhaustion is STATE, mirrored into a ref. The ref is what the fetch closure reads (state would be
  // stale there); the state is what renders. A ref alone looked fine because a successful page also
  // calls setVoters, so a render always followed — but the FAILURE path sets no changed state, so
  // `hasMore` would stay true on screen with a "Load more" button that silently did nothing.
  const [exhausted, setExhausted] = useState(false);
  const cursor = useRef<string | null>(null);
  const done = useRef(false);
  // Guards against a `loadMore` racing the effect, and against two in flight at once — either would
  // append the same page twice, since the cursor only advances when a page resolves.
  const inFlight = useRef(false);
  // Identifies the current (source, host, nonce) generation. A page that resolves after the poll or the
  // account changed must not append to the new list; comparing a captured id to this ref drops it.
  const generation = useRef(0);

  const reset = useCallback(() => {
    generation.current += 1;
    cursor.current = null;
    done.current = false;
    inFlight.current = false;
    setVoters(null);
    setLabels([]);
    setLoading(false);
    setFailed(false);
    setExhausted(false);
  }, []);

  const fetchPage = useCallback(async () => {
    if (!source || hostId == null || !isPoll || !enabled) return;
    if (inFlight.current || done.current) return;
    const gen = generation.current;
    inFlight.current = true;
    setLoading(true);
    try {
      const page = await source.pollVotersPage(hostId, { after: cursor.current });
      if (gen !== generation.current) return; // a different poll/account owns the state now
      cursor.current = page.nextCursor;
      if (page.nextCursor == null) {
        done.current = true;
        setExhausted(true);
      }
      setVoters((prev) => [...(prev ?? []), ...page.voters]);
      // Only the first page carries them; later pages leave the captured copy alone.
      if (page.labels) setLabels(page.labels);
      setFailed(false);
    } catch {
      if (gen !== generation.current) return;
      // Stop rather than spin: without this the "load more" button would retry forever on a dead
      // endpoint. `failed` only claims a dead end when nothing at all loaded.
      done.current = true;
      setExhausted(true);
      setFailed((prevFailed) => prevFailed || cursor.current === null);
    } finally {
      if (gen === generation.current) {
        inFlight.current = false;
        setLoading(false);
      }
    }
  }, [source, hostId, isPoll, enabled]);

  // The BOUNDED aggregate, read as soon as the post is known to be a poll and regardless of `enabled`.
  // This is the one read that is deliberately not lazy: it is a handful of rows, and the disclosure
  // cannot say how many voted without it. A failure leaves it empty, which renders no section at all —
  // the same as a poll nobody has voted in, and the honest reading of "we could not find out".
  useEffect(() => {
    let alive = true;
    setTotals([]);
    if (!source || hostId == null || !isPoll) return;
    source
      .pollVoterTotals(hostId)
      .then((t) => {
        if (alive) setTotals(t);
      })
      .catch(() => {
        if (alive) setTotals([]);
      });
    return () => {
      alive = false;
    };
  }, [source, hostId, isPoll, nonce]);

  // Reset on every identity change, then load the FIRST page only once enabled. Resetting before the
  // guard is what stops one poll's roster flashing under another's heading after a navigation.
  useEffect(() => {
    reset();
    if (!source || hostId == null || !isPoll || !enabled) return;
    void fetchPage();
    // `fetchPage` is stable across the same (source, hostId, isPoll, enabled), so this runs once per
    // generation rather than on every render.
  }, [source, hostId, isPoll, enabled, nonce, reset, fetchPage]);

  const loadMore = useCallback(() => {
    void fetchPage();
  }, [fetchPage]);

  return {
    voters,
    labels,
    totals,
    loading,
    hasMore: !exhausted,
    loadMore,
    failed,
  };
}

export default usePollVoters;
