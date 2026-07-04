"use client";

// useAccountVote — the stake-weighted reputation vote ON an account (the profile page's ▲ score ▼
// control, the anti-Sybil / anti-impersonation signal). Single-target, single-surface, so it keeps its
// OWN target-keyed optimistic state (like useFollow) rather than the app-wide post-keyed useOptimistic
// overlay — but it mirrors that overlay's proven reconcile semantics:
//
//   • COMPOSE deltas (never replace): a re-vote before the read reconciles accumulates
//     voteDelta(prev→next) onto the running delta, so Up→Down nets −w, not −2w.
//   • SETTLE ON AGREEMENT: the override is IGNORED (merge returns the base) and retired the moment a
//     fresh read of the viewer's own vote (`base.myVote`) matches the optimistic `myVote` — so the read
//     catching up never double-counts, and a net-return-to-original (delta 0, same myVote) resolves.
//   • TTL BACKSTOP: if that agreeing read never lands (dropped tx with no error, stalled subscription),
//     the override self-heals after CONFIRM_TTL_MS instead of wedging the highlight forever.
//
// `myWeight` is the viewer's TalkStake.VotingPower snapshot (same source as useVote); a zero-stake voter
// still registers `myVote` + a count bump but adds 0 weight (the chain accepts a zero-weight vote).

import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { voteDelta } from "@/lib/optimistic";
import { submitVoteAccount, submitClearAccountVote } from "@/lib/chain/mutations";
import type { CognoApi, PostingSigner, Ss58 } from "@/lib/types";

/** The self-healing backstop (matches useOptimistic's CONFIRM_TTL_MS): retire an override this old. */
const CONFIRM_TTL_MS = 15_000;

/** The on-chain base tally + the viewer's own vote for one account (from the profile read). */
export interface AccountVoteBase {
  myVote: "Up" | "Down" | null;
  upWeight: bigint;
  downWeight: bigint;
  upCount: number;
  downCount: number;
}

/** The merged (base + optimistic) view the control renders. */
export interface AccountVoteMerged {
  myVote: "Up" | "Down" | null;
  score: bigint; // upWeight − downWeight; may be negative
  upCount: number;
  downCount: number;
}

/** A running, COMPOSED delta over the base tally, plus the viewer's optimistic vote. */
interface OptimisticEntry {
  myVote: "Up" | "Down" | null;
  upCountDelta: number;
  downCountDelta: number;
  upWeightDelta: bigint;
  downWeightDelta: bigint;
}

export interface UseAccountVote {
  /** Toggle the up vote for `target` (up → clear, else → up). `current` is the viewer's shown vote. */
  upvote: (target: Ss58, current: "Up" | "Down" | null) => void;
  /** Toggle the down vote for `target` (down → clear, else → down). */
  downvote: (target: Ss58, current: "Up" | "Down" | null) => void;
  /** Explicitly clear the viewer's vote on `target`. */
  clear: (target: Ss58, current: "Up" | "Down" | null) => void;
  /** Layer any (unsettled) optimistic override for `target` over the read base → the rendered view. */
  merge: (target: Ss58, base: AccountVoteBase) => AccountVoteMerged;
  /** True iff `target` currently carries an in-flight optimistic override (scopes the pending UI). */
  isOptimistic: (target: Ss58) => boolean;
  /** Drop the optimistic override for `target` (call once a fresh read agrees, or on a profile switch). */
  reset: (target: Ss58) => void;
  pending: boolean;
}

const baseView = (base: AccountVoteBase): AccountVoteMerged => ({
  myVote: base.myVote,
  score: base.upWeight - base.downWeight,
  upCount: base.upCount,
  downCount: base.downCount,
});

export function useAccountVote(
  api: CognoApi | null,
  signer: PostingSigner | null,
  myWeight: bigint,
): UseAccountVote {
  const { run, pending } = useMutation();
  const { fail } = useActionToast();
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticEntry>>({});
  // Per-target TTL timers; cleared on reset / re-vote / unmount so a stale override can't wedge.
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const clearTimer = useCallback((target: Ss58) => {
    const t = timers.current[target];
    if (t !== undefined) {
      clearTimeout(t);
      delete timers.current[target];
    }
  }, []);

  const reset = useCallback(
    (target: Ss58) => {
      clearTimer(target);
      setOptimistic((p) => {
        if (!(target in p)) return p;
        const { [target]: _drop, ...rest } = p;
        return rest;
      });
    },
    [clearTimer],
  );

  // Clear all timers on unmount (React 19 tolerates the setState, but drop the timers so they can't fire).
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of Object.values(map)) clearTimeout(t);
    };
  }, []);

  const doVote = useCallback(
    (target: Ss58, current: "Up" | "Down" | null, next: "Up" | "Down" | null) => {
      if (!api || !signer) return;
      if (current === next) return; // no-op
      const d = voteDelta(current, next, myWeight);
      // COMPOSE onto the running delta (never replace): `current` is the shown vote, so the reversal it
      // encodes only nets out correctly when added to the prior delta, mirroring useOptimistic's addCountPatch.
      setOptimistic((p) => {
        const prev = p[target];
        return {
          ...p,
          [target]: {
            myVote: next,
            upCountDelta: (prev?.upCountDelta ?? 0) + (d.upCountDelta ?? 0),
            downCountDelta: (prev?.downCountDelta ?? 0) + (d.downCountDelta ?? 0),
            upWeightDelta: (prev?.upWeightDelta ?? 0n) + (d.upWeightDelta ?? 0n),
            downWeightDelta: (prev?.downWeightDelta ?? 0n) + (d.downWeightDelta ?? 0n),
          },
        };
      });
      // Arm the self-healing TTL (reset any prior one for this target first).
      clearTimer(target);
      timers.current[target] = setTimeout(() => reset(target), CONFIRM_TTL_MS);
      const stream =
        next === null
          ? submitClearAccountVote(api, signer, target)
          : submitVoteAccount(api, signer, target, next);
      void run(stream, {
        // Keep the override on confirm; `merge` retires it once the fresh read agrees (settle-on-agreement).
        onError: (message) => {
          reset(target);
          fail(message);
        },
      }).catch(() => {
        /* failure surfaced via fail(); optimistic rolled back in onError */
      });
    },
    [api, signer, myWeight, run, fail, reset, clearTimer],
  );

  const merge = useCallback(
    (target: Ss58, base: AccountVoteBase): AccountVoteMerged => {
      const o = optimistic[target];
      // No override, or the fresh read's own-vote already matches the optimistic vote (SETTLED — the read
      // caught up, so its tally is authoritative): render the base and ignore the now-redundant delta.
      if (!o || base.myVote === o.myVote) return baseView(base);
      // Clamp weights at 0 like the chain's `saturating_sub`: composing a reversal at a DIFFERENT
      // `myWeight` than the vote was cast at (e.g. a vote cast while VotingPower was still loading = 0,
      // then a re-vote after it loaded) can over-subtract below 0; the floor keeps the shown weight and
      // score sane until the read reconciles. Counts are likewise floored.
      const upWeight = base.upWeight + o.upWeightDelta;
      const downWeight = base.downWeight + o.downWeightDelta;
      const upClamped = upWeight < 0n ? 0n : upWeight;
      const downClamped = downWeight < 0n ? 0n : downWeight;
      return {
        myVote: o.myVote,
        score: upClamped - downClamped,
        upCount: Math.max(0, base.upCount + o.upCountDelta),
        downCount: Math.max(0, base.downCount + o.downCountDelta),
      };
    },
    [optimistic],
  );

  const isOptimistic = useCallback((target: Ss58) => target in optimistic, [optimistic]);

  const upvote = useCallback(
    (target: Ss58, current: "Up" | "Down" | null) =>
      doVote(target, current, current === "Up" ? null : "Up"),
    [doVote],
  );
  const downvote = useCallback(
    (target: Ss58, current: "Up" | "Down" | null) =>
      doVote(target, current, current === "Down" ? null : "Down"),
    [doVote],
  );
  const clear = useCallback(
    (target: Ss58, current: "Up" | "Down" | null) => doVote(target, current, null),
    [doVote],
  );

  return { upvote, downvote, clear, merge, isOptimistic, reset, pending };
}
