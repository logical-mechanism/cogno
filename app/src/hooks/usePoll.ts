"use client";

// usePoll — fetch a poll's options + stake-weighted tallies AND the viewer's existing choice, then
// cast/re-cast the viewer's vote optimistically. Weighted results are derived LIVE by the node (they
// re-price as stake moves), so a re-cast moves the viewer's choice and the numbers float — UNTIL the poll
// is closed. A poll MAY carry a block-number `closeAt` deadline (spec 205): once the best block reaches it
// voting stops, and anyone may permissionlessly `close_poll` to FREEZE the weighted result.
//
// RECONCILE (why this isn't a single reload-on-confirm): a vote confirms at `inBestBlock`, and the reads
// target the best block — but there's still a narrow window where the read can resolve a hair before the
// best-block pointer includes the vote. A blind reload there would clobber the optimistic count back to
// pre-vote and drop the ✓ (the "reverts then only fixes on refresh" bug). So after confirm we KEEP the
// optimistic count and re-read each block until the read actually reflects the cast option (bounded), then
// hand off to the true weighted tally.
//
// Loading the prior choice (`viewerPollChoice`, keyed on the connected `who`) is what lets a poll you have
// ALREADY voted on render its results + a ✓ on reload, instead of re-offering empty radio rows — and it
// blocks a same-option re-click so the optimistic count never transiently double-bumps.

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { submitPollVote, submitClosePoll } from "@/lib/chain/mutations";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi, PostingSigner, PollView, Ss58 } from "@/lib/types";

export interface UsePoll {
  poll: PollView | null;
  myChoice: number | null;
  castVote: (option: number) => void;
  loading: boolean;
  error: string | null;
  /** Voting is over: the deadline has passed (or the result is already frozen). No more casts. */
  closed: boolean;
  /** Past the deadline but NOT yet finalized — the result reads live and `finalize()` can freeze it. */
  provisional: boolean;
  /** Permissionlessly finalize a provisional poll (`close_poll`), freezing its weighted result. */
  finalize: () => void;
  /** A `close_poll` is in flight. */
  finalizing: boolean;
  /** Re-run the initial load — for an inline error row's Retry (a failed cold read never retries alone). */
  reload: () => void;
}

/** Give up waiting for the read to reflect a cast after this many block re-reads (accept chain truth). */
const MAX_RECONCILE_TRIES = 8;

export function usePoll(
  source: FeedSource | null,
  hostId: bigint | null,
  api: CognoApi | null,
  signer: PostingSigner | null,
  /** The CONNECTED viewer's address (gate.address) — NOT the background signer; null when unconnected. */
  who: Ss58 | null,
  /** Best-block number — ticks the post-cast reconcile re-read until the chain reflects the vote. */
  bestBlock?: number | null,
): UsePoll {
  const { run } = useMutation();
  const { fail } = useActionToast();
  const [poll, setPoll] = useState<PollView | null>(null);
  const [myChoice, setMyChoice] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After a cast: the option we're waiting for the chain read to confirm. While set, the optimistic
  // count is held and re-reads only "take" once the read reflects this option (or the retry budget runs).
  const [pendingOption, setPendingOption] = useState<number | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const triesRef = useRef(0);
  // Bumped by `reload()` to re-arm the initial-load effect (an inline error row's Retry — a failed cold
  // read otherwise never retries, since the reconcile loop only runs after a cast).
  const [retryNonce, setRetryNonce] = useState(0);
  const reload = useCallback(() => setRetryNonce((n) => n + 1), []);

  // Close state, derived from the poll's `closeAt` deadline + the current best block + its finalized flag.
  // `closed` (voting over) = already finalized OR the best block has reached the deadline. `provisional` =
  // past the deadline but not yet frozen (reads live; anyone may `finalize()`).
  const finalized = poll?.finalized ?? false;
  const pastDeadline =
    poll?.closeAt != null && bestBlock != null && bestBlock >= poll.closeAt;
  const closed = finalized || !!pastDeadline;
  const provisional = !!pastDeadline && !finalized;

  // One read of the poll's tallies + the viewer's prior choice (null-soft on the choice read).
  const read = useCallback(async (): Promise<{ poll: PollView; choice: number | null } | null> => {
    if (!source || hostId == null ) return null;
    const [p, choice] = await Promise.all([
      source.poll(hostId),
      who ? source.viewerPollChoice(hostId, who).catch(() => null) : Promise.resolve(null),
    ]);
    return { poll: p, choice };
  }, [source, hostId, who]);

  // Initial / context load — accepts unconditionally (no cast in flight). Only the poll() read surfaces
  // an error; a missing/erroring choice fails soft to null. Re-runs when source / hostId / who changes.
  useEffect(() => {
    if (!source || hostId == null) {
      setPoll(null);
      setMyChoice(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    read()
      .then((r) => {
        if (cancelled || !r) return;
        setPoll(r.poll);
        setMyChoice(r.choice);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "could not load the poll");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [read, source, hostId, retryNonce]);

  const castVote = useCallback(
    (option: number) => {
      if (!api || !signer || hostId == null) return;
      // A closed poll accepts no votes — the chain rejects it `PollClosed`, so don't optimistically move.
      if (closed) return;
      const prev = myChoice;
      setMyChoice(option);
      // Optimistic: move the count from the previous option to the new one (true weights reconcile later).
      setPoll((cur) => {
        if (!cur) return cur;
        const options = cur.options.map((o) => {
          let count = o.count;
          if (prev === o.index) count = Math.max(0, count - 1);
          if (option === o.index) count += 1;
          return { ...o, count };
        });
        return { ...cur, options, totalCount: options.reduce((s, o) => s + o.count, 0) };
      });
      void run(submitPollVote(api, signer, hostId, option), {
        onConfirm: () => {
          // Start the reconcile-reload loop — keep the optimistic count until a read reflects the cast.
          triesRef.current = 0;
          setPendingOption(option);
        },
        onError: (message) => {
          setPendingOption(null);
          setMyChoice(prev);
          // Revert the optimistic count DIRECTLY (inverse of the forward delta, same Math.max(0) clamp)
          // so a rejected vote never leaves an inflated tally when the reconcile read below ALSO fails
          // (unlike useVote's pure-local rollback, this used to depend entirely on that fallible read).
          setPoll((cur) => {
            if (!cur) return cur;
            const options = cur.options.map((o) => {
              let count = o.count;
              if (option === o.index) count = Math.max(0, count - 1); // undo the optimistic +1
              if (prev === o.index) count += 1; // restore the previous option's vote
              return { ...o, count };
            });
            return { ...cur, options, totalCount: options.reduce((s, o) => s + o.count, 0) };
          });
          // Best-effort reconcile to chain truth on top (authoritative when it lands).
          read()
            .then((r) => {
              if (!r) return;
              setPoll(r.poll);
              setMyChoice(r.choice);
            })
            .catch(() => {});
          // ...and TELL the user. Without this the option silently slid back with no toast, no
          // console, nothing — the only mutation hook that surfaced a rejection to no one.
          // `fail` routes a rate-limit to its dedicated toast and everything else to a generic error.
          fail(message);
        },
      });
    },
    [api, signer, hostId, closed, myChoice, run, read, fail],
  );

  // Permissionlessly finalize a provisional poll: `close_poll` freezes the weighted result. On confirm,
  // re-read so the card flips to the frozen "Final" state. Idempotent on-chain, so a race is harmless.
  const finalize = useCallback(() => {
    if (!api || !signer || hostId == null || !provisional || finalizing) return;
    setFinalizing(true);
    void run(submitClosePoll(api, signer, hostId), {
      onConfirm: () => {
        setFinalizing(false);
        read()
          .then((r) => {
            if (!r) return;
            setPoll(r.poll);
            setMyChoice(r.choice);
          })
          .catch(() => {});
      },
      onError: (message) => {
        setFinalizing(false);
        fail(message);
      },
    });
  }, [api, signer, hostId, provisional, finalizing, run, read, fail]);

  // Reconcile-reload: after a cast, re-read each block until the read reflects the cast option (or the
  // retry budget runs), then accept the true weighted tally + ✓. Silent (no loading flicker).
  useEffect(() => {
    if (pendingOption == null) return;
    let cancelled = false;
    read()
      .then((r) => {
        if (cancelled || !r) return;
        triesRef.current += 1;
        if (r.choice === pendingOption || triesRef.current >= MAX_RECONCILE_TRIES) {
          setPoll(r.poll);
          setMyChoice(r.choice);
          setPendingOption(null);
        }
        // else: the read predates the vote — hold the optimistic count, retry on the next block tick.
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pendingOption, bestBlock, read]);

  return { poll, myChoice, castVote, loading, error, closed, provisional, finalize, finalizing, reload };
}
