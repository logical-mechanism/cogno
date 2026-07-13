"use client";

// useAccountVote — the stake-weighted REPUTATION vote ON an account (spec-202): the anti-Sybil /
// anti-impersonation signal, cast from the profile header AND from a profile hover card.
//
// Two halves, split on purpose:
//
//   AccountVoteProvider — the WRITE side. Mounted once, never unmounts. It holds the viewer's declared
//     intents (see lib/accountVote) and owns the useMutation subscription.
//
//     This provider is not architectural taste, it is a hard requirement. useMutation tears down its
//     subscriptions when the CALLING hook unmounts, firing `onCancel` and never `onConfirm`. A hover
//     card unmounts ~200ms after you move the mouse off it — so a vote cast from a hover card, with the
//     write side inside the popover, would lose its confirm callback (nothing would ever refresh the
//     tally) AND its failure toast (a rejected vote would fail silently). Voting from a surface more
//     transient than the transaction is only safe if the writer outlives the surface.
//
//   useAccountVoteFor(target) — the READ side, per surface. Composes the two shared caches (the account
//     tally + the viewer's own vote) into a base, rebases the intent over it, and hands back a ready-to-
//     render view plus the two click handlers.
//
// Both surfaces call the same hook, so a vote cast in a hover card is already showing when you open that
// account's profile — it is one app-wide store, not two per-surface copies.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/Providers";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { useAccountTally, useInvalidateReputation } from "./useReputation";
import { useAccountVoteState, useInvalidateAccountVoteState } from "./useAccountVoteState";
import { rebaseAccountVote, ZERO_BASE, type AccountVoteBase, type AccountVoteIntent, type AccountVoteMerged } from "@/lib/accountVote";
import { submitVoteAccount, submitClearAccountVote } from "@/lib/chain/mutations";
import type { Ss58 } from "@/lib/types";

/**
 * Backstop only: retire an intent this old. With a live base the rebase settles by itself the moment the
 * chain catches up, so this fires only when a tx dies silently — no confirm, no error (a dropped tx, a
 * stalled subscription). It is the difference between a stuck highlight and a self-healing one.
 */
const INTENT_TTL_MS = 15_000;

interface AccountVoteCtx {
  intents: Record<string, AccountVoteIntent>;
  cast: (target: Ss58, current: "Up" | "Down" | null, next: "Up" | "Down" | null) => void;
  reset: (target: Ss58) => void;
}

const Context = createContext<AccountVoteCtx | null>(null);

export function AccountVoteProvider({ children }: { children: ReactNode }) {
  const { api, signer, viewer, votingPower, bestBlock } = useSession();
  const me = viewer.address ?? null;
  const { run } = useMutation();
  const { fail } = useActionToast();
  const invalidateTally = useInvalidateReputation();
  const invalidateVoteState = useInvalidateAccountVoteState();

  const [intents, setIntents] = useState<Record<string, AccountVoteIntent>>({});
  // Readable from the per-block catch-up effect without making it re-run on every intent change.
  const intentsRef = useRef(intents);
  intentsRef.current = intents;
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
      setIntents((p) => {
        if (!(target in p)) return p;
        const { [target]: _drop, ...rest } = p;
        return rest;
      });
    },
    [clearTimer],
  );

  // Drop every timer on unmount (the provider only unmounts with the app, but a stray timer firing into
  // a torn-down tree is the kind of thing that only shows up in a test).
  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const t of Object.values(map)) clearTimeout(t);
    };
  }, []);

  // A viewer switch voids every intent: an intent records THIS viewer's vote, and the store is app-wide.
  // (The own-vote cache needs no purge — the viewer is part of its key.)
  useEffect(() => {
    for (const t of Object.values(timers.current)) clearTimeout(t);
    timers.current = {};
    setIntents({});
  }, [me]);

  // CATCH-UP POLL. `onConfirm` fires at inBestBlock and the caches read at { at: "best" } — if the
  // client's head has not yet advanced to the block carrying the tx, that read commits a PRE-vote value,
  // and createChainCache never re-requests a committed key on its own. The intent would then never settle,
  // ride the TTL out, and vanish — the vote silently un-doing itself, intermittently.
  //
  // So while any target has an intent outstanding, re-read its keys every block. Self-terminating (the
  // settle below drops the intent), and it costs two point reads per block for the block or two a vote is
  // in flight. If a vote ever "reverts after ~15 seconds, but only sometimes" — this is what broke.
  useEffect(() => {
    if (bestBlock == null) return;
    const targets = Object.keys(intentsRef.current) as Ss58[];
    if (targets.length === 0) return;
    for (const t of targets) {
      invalidateTally(t); // the feed's badge + avatar ring
      if (me) invalidateVoteState({ target: t, viewer: me }); // the vote control's own base
    }
  }, [bestBlock, me, invalidateTally, invalidateVoteState]);

  const cast = useCallback(
    (target: Ss58, current: "Up" | "Down" | null, next: "Up" | "Down" | null) => {
      if (!api || !signer || !me) return;
      if (current === next) return; // no-op

      // Declare the intent. `weight` is the viewer's voting power at click time — the magnitude the chain
      // will record. A zero-stake voter still registers a vote and a count, adding no weight.
      setIntents((p) => ({
        ...p,
        [target]: { myVote: next, weight: votingPower ?? 0n, inFlight: (p[target]?.inFlight ?? 0) + 1 },
      }));
      clearTimer(target);
      timers.current[target] = setTimeout(() => reset(target), INTENT_TTL_MS);

      void run(
        next === null
          ? submitClearAccountVote(api, signer, target)
          : submitVoteAccount(api, signer, target, next),
        {
          // The vote is in a block: re-read both keys. `invalidate` re-QUEUES, so this refreshes an
          // already-open hover card in place AND leaves a fresh value for the next one to mount. The
          // tally cache is the same one the feed's reputation badges and avatar rings read, so they
          // update here too, with no reload.
          onConfirm: () => {
            setIntents((p) => {
              const cur = p[target];
              if (!cur) return p;
              return { ...p, [target]: { ...cur, inFlight: Math.max(0, cur.inFlight - 1) } };
            });
            invalidateTally(target); // the feed's badge + avatar ring read this one
            invalidateVoteState({ target, viewer: me }); // the vote control reads this one
          },
          // Roll back ONLY when nothing else is in flight for this target. On a fast Up→Down the Up can
          // fail after the Down was already sent; dropping the intent then would erase a Down the chain
          // is still going to apply (vote_account SETS the vote, it does not accumulate).
          onError: (error) => {
            setIntents((p) => {
              const cur = p[target];
              if (!cur) return p;
              const inFlight = Math.max(0, cur.inFlight - 1);
              if (inFlight > 0) return { ...p, [target]: { ...cur, inFlight } };
              clearTimer(target);
              const { [target]: _drop, ...rest } = p;
              return rest;
            });
            fail(error);
          },
        },
      );
    },
    [api, signer, me, votingPower, run, fail, reset, clearTimer, invalidateTally, invalidateVoteState],
  );

  const value = useMemo<AccountVoteCtx>(() => ({ intents, cast, reset }), [intents, cast, reset]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export interface UseAccountVoteFor {
  /** The merged view to render (chain base + the viewer's declared intent). */
  vote: AccountVoteMerged;
  /**
   * Both reads have landed. FALSE means "we do not know yet" — render nothing rather than a fabricated
   * zero score with an unlit arrow, which reads as "nobody has voted and neither have you" and invites a
   * duplicate vote.
   */
  ready: boolean;
  /** A vote on THIS target is in flight (per-target: a vote on A never disables B's arrows). */
  pending: boolean;
  onUp: () => void;
  onDown: () => void;
}

/**
 * The account reputation vote for one target, ready to render.
 *
 * `liveKey` (pass `bestBlock`) re-reads the tally each block, so OTHER people's votes land without a
 * reload. The profile page — a surface you sit on — passes it; a hover card does not (it is open for a
 * few seconds, and it already gets its own vote back through the confirm invalidation).
 */
export function useAccountVoteFor(
  target: Ss58 | undefined,
  opts?: { liveKey?: number | null },
): UseAccountVoteFor {
  const ctx = useContext(Context);
  const { viewer } = useSession();
  const router = useRouter();
  const me = viewer.address ?? null;
  const liveKey = opts?.liveKey ?? null;

  const invalidateTally = useInvalidateReputation();
  const invalidateVoteState = useInvalidateAccountVoteState();

  const stateKey = useMemo(
    () => (target && me ? { target, viewer: me } : undefined),
    [target, me],
  );

  // A SIGNED-IN viewer takes the whole base — tally AND own vote — from ONE cache entry, read together
  // and committed together. Reading them from two caches would let the tally land a render before the
  // own vote, and in that window the rebase re-applies the viewer's weight on top of a tally that
  // already contains it (score = base + 2× your weight, then a snap back). See useAccountVoteState.
  //
  // A SIGNED-OUT viewer has no own vote to read, so it just borrows the address-keyed tally the feed's
  // badges and avatar rings already keep warm.
  const state = useAccountVoteState(stateKey);
  const tallyOnly = useAccountTally(stateKey === undefined ? target : undefined);

  const ready = stateKey === undefined ? tallyOnly != null : state != null;

  let base: AccountVoteBase = ZERO_BASE;
  if (stateKey !== undefined && state) {
    base = {
      myVote: state.myVote,
      upWeight: state.tally.upWeight,
      downWeight: state.tally.downWeight,
      upCount: state.tally.upCount,
      downCount: state.tally.downCount,
    };
  } else if (stateKey === undefined && tallyOnly) {
    base = {
      myVote: null,
      upWeight: tallyOnly.upWeight,
      downWeight: tallyOnly.downWeight,
      upCount: tallyOnly.upCount,
      downCount: tallyOnly.downCount,
    };
  }

  const intent = target ? ctx?.intents[target] : undefined;
  const vote = rebaseAccountVote(base, intent);

  // Retire a settled intent. The rebase already renders the base once they agree (that is an identity,
  // not a rule), so this is hygiene: it stops the provider's per-block catch-up poll and disarms the TTL.
  // Gated on inFlight === 0 so a mid-sequence re-vote keeps its intent.
  const reset = ctx?.reset;
  useEffect(() => {
    if (!reset || !target || !intent || !ready) return;
    if (intent.inFlight === 0 && base.myVote === intent.myVote) reset(target);
  }, [reset, target, intent, ready, base.myVote]);

  // Watch the target live (profile page): re-read each block so a STRANGER's vote shows up without a
  // reload. Both keys, so the header's control and the badge beside their name never disagree.
  useEffect(() => {
    if (liveKey == null || !target) return;
    invalidateTally(target);
    if (stateKey) invalidateVoteState(stateKey);
  }, [liveKey, target, stateKey, invalidateTally, invalidateVoteState]);

  const act = useCallback(
    (dir: "Up" | "Down") => {
      if (!target || !ctx) return;
      // Not set up to write → finish setup. (The buttons stay enabled: the click is the teaching moment.)
      if (!viewer.writeReady) {
        router.push("/welcome/");
        return;
      }
      ctx.cast(target, vote.myVote, vote.myVote === dir ? null : dir); // toggle
    },
    [target, ctx, viewer.writeReady, router, vote.myVote],
  );

  const onUp = useCallback(() => act("Up"), [act]);
  const onDown = useCallback(() => act("Down"), [act]);

  return { vote, ready, pending: (intent?.inFlight ?? 0) > 0, onUp, onDown };
}
