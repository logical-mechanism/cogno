"use client";

// useAccountVote — the stake-weighted reputation vote ON an account (the profile page's ▲ score ▼
// control, the anti-Sybil / anti-impersonation signal). Fuses the post-vote optimistic primitive
// (`voteDelta`) with `useFollow`'s local, target-keyed scoping: this is a single-target, single-surface
// feature, so it keeps its OWN optimistic state and never touches the app-wide `useOptimistic` overlay.
//
// `myWeight` is the viewer's `TalkStake.VotingPower` snapshot (same source as `useVote`). A zero-stake
// voter still registers `myVote` + a count bump but adds 0 weight (the chain accepts a zero-weight vote).
// A re-vote reverses the previous vote's weight before applying the new one, mirroring the chain's
// drift-free tally. On confirm the optimistic override is KEPT (no flash); the surface drops it via
// `reset(target)` once a fresh profile read reflects the vote.

import { useCallback, useState } from "react";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { voteDelta } from "@/lib/optimistic";
import { submitVoteAccount, submitClearAccountVote } from "@/lib/chain/mutations";
import type { CognoApi, PostingSigner, Ss58 } from "@/lib/types";

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
  /** Layer any optimistic override for `target` over the read base → the view the control renders. */
  merge: (target: Ss58, base: AccountVoteBase) => AccountVoteMerged;
  /** Drop the optimistic override for `target` (call when a fresh base read lands). */
  reset: (target: Ss58) => void;
  pending: boolean;
}

export function useAccountVote(
  api: CognoApi | null,
  signer: PostingSigner | null,
  myWeight: bigint,
): UseAccountVote {
  const { run, pending } = useMutation();
  const { fail } = useActionToast();
  const [optimistic, setOptimistic] = useState<Record<string, OptimisticEntry>>({});

  const doVote = useCallback(
    (target: Ss58, current: "Up" | "Down" | null, next: "Up" | "Down" | null) => {
      if (!api || !signer) return;
      if (current === next) return; // no-op
      const d = voteDelta(current, next, myWeight);
      setOptimistic((p) => ({
        ...p,
        [target]: {
          myVote: next,
          upCountDelta: d.upCountDelta ?? 0,
          downCountDelta: d.downCountDelta ?? 0,
          upWeightDelta: d.upWeightDelta ?? 0n,
          downWeightDelta: d.downWeightDelta ?? 0n,
        },
      }));
      const stream =
        next === null
          ? submitClearAccountVote(api, signer, target)
          : submitVoteAccount(api, signer, target, next);
      void run(stream, {
        // Keep the optimistic override on confirm; the surface retires it via reset() on the next read.
        onError: (message) => {
          setOptimistic((p) => {
            const { [target]: _drop, ...rest } = p;
            return rest;
          });
          fail(message);
        },
      }).catch(() => {
        /* failure surfaced via fail(); optimistic rolled back in onError */
      });
    },
    [api, signer, myWeight, run, fail],
  );

  const merge = useCallback(
    (target: Ss58, base: AccountVoteBase): AccountVoteMerged => {
      const o = optimistic[target];
      if (!o) {
        return {
          myVote: base.myVote,
          score: base.upWeight - base.downWeight,
          upCount: base.upCount,
          downCount: base.downCount,
        };
      }
      const upWeight = base.upWeight + o.upWeightDelta;
      const downWeight = base.downWeight + o.downWeightDelta;
      return {
        myVote: o.myVote,
        score: upWeight - downWeight,
        upCount: Math.max(0, base.upCount + o.upCountDelta),
        downCount: Math.max(0, base.downCount + o.downCountDelta),
      };
    },
    [optimistic],
  );

  const reset = useCallback((target: Ss58) => {
    setOptimistic((p) => {
      if (!(target in p)) return p;
      const { [target]: _drop, ...rest } = p;
      return rest;
    });
  }, []);

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

  return { upvote, downvote, clear, merge, reset, pending };
}
