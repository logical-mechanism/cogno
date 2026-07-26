"use client";

// useVault — the L1 vault lock/exit state for a connected Cardano wallet (M8). Locking ADA at the
// talk_vault mints the owner's beacon; the app-chain's consensus observer then reads it (once it is
// older than the stability window) and credits the bound account its talk-capacity weight. So a
// successful lock here is "submitted", NOT "you can post now": capacity appears after the observed
// Cardano frontier passes the lock's slot (see usePendingCapacity, which narrates that wait).
//
// Purely Cardano-side — it needs no chain api. The wallet id comes from the wallet picker in the UI.
// `lastAction` lets a caller persist a pending-lock record on a lock (and clear it on an exit).

import { useCallback, useEffect, useRef, useState } from "react";
import {
  lockIntoVault,
  exitVault,
  fetchVaultState,
  fetchLegacyVaults,
  type VaultInfo,
  type LegacyVaultBalance,
} from "@/lib/cardano/vault";
import { hasCardanoProvider } from "@/lib/cardano/provider";
import { isUserRejection } from "@/lib/cardano/cip8";

export type VaultPhase = "idle" | "working" | "submitted" | "error";

/** Which action produced the current tx state — so a caller can tell a lock (start crediting) from an
 *  exit (stop crediting) when reacting to `phase === "submitted"`.
 *
 *  `"exit-legacy"` is a THIRD value rather than a reuse of `"exit"`, and the distinction is
 *  load-bearing: `usePendingLockSync` bridges this field to the persistent pending-lock record, and a
 *  legacy exit touches a RETIRED script, so it must move neither half of that record. Reusing "exit"
 *  would CLEAR an in-flight lock's countdown; leaving it on "lock" would RE-RECORD the pending lock
 *  against the legacy exit's tx hash, so the countdown would then poll the wrong transaction for its
 *  Cardano slot. Both are wrong, so the honest answer is a value that bridge ignores. */
export type VaultAction = "lock" | "exit" | "exit-legacy";

/** The fine-grained sub-phase of the in-flight `working` tx, for a live step indicator. `preparing`
 *  = building the tx (wallet enable + UTxO fetch + script eval), then the wallet sign, then the
 *  Cardano submit. `idle` when no tx is in flight. */
export type VaultStep = "idle" | "preparing" | "signing" | "submitting";

export interface UseVault {
  /** a Cardano provider (Blockfrost) is configured ⇒ the lock/exit actions are usable. */
  available: boolean;
  phase: VaultPhase;
  /** the in-flight sub-phase while `phase === "working"` (drives the step indicator). */
  step: VaultStep;
  busy: boolean;
  error: string | null;
  txHash: string | null;
  /** which action produced the current `txHash`/phase (`lock` vs `exit`), or null when idle. */
  lastAction: VaultAction | null;
  /** the resolved owner/vault for the connected wallet (address, beacon, …). */
  info: VaultInfo | null;
  /** lovelace currently locked (null = none), once inspected. */
  locked: bigint | null;
  lockedKnown: boolean;
  /** count of EXTRA vault UTxOs beyond the credited one (0 normally); >0 means ADA earning nothing. */
  extraVaults: number;
  /**
   * Balances found at RETIRED vault scripts. Empty while talk_vault has only ever been deployed once,
   * which is today. Kept SEPARATE from `locked` on purpose: a legacy balance is real ADA and exactly
   * zero posting power (the chain credits one policy id), so folding it into `locked` would tell three
   * different surfaces that an uncreditable balance is posting power.
   */
  legacy: LegacyVaultBalance[];
  /** True only during the post-submit confirm poll — drives the "Confirming…" UI without leaning on the
   *  sticky `submitted` phase (which never clears). */
  confirming: boolean;
  /**
   * Resolve the vault state for a wallet without sending a tx. A no-op while a lock/exit (or its
   * confirm poll) is running — that path owns this state and is already re-reading. Safe to call
   * repeatedly and across a wallet switch: only the newest read commits.
   */
  inspect: (walletId: string) => void;
  lock: (walletId: string, lovelace?: bigint) => void;
  exit: (walletId: string) => void;
  /** Empty a RETIRED vault script by hash. Same machinery as `exit`, different script witness. */
  exitLegacy: (walletId: string, scriptHash: string) => void;
  reset: () => void;
}

/**
 * How a run differs from the plain lock/exit case. Everything else — the re-entrancy guard, the
 * phase/step machine, the user-rejection branch, the toasts callers hang off `phase` — is shared, and
 * has to be: this used to be a `run` plus a 30-line hand-copy of it for the legacy path, so a fix to
 * one silently did not reach the other (the copy had already lost the `inspectedWallet` line).
 */
interface RunOpts {
  /** Which balance the confirm poll should watch after a submit, or `null` to skip polling. */
  poll: VaultAction | null;
  /** Commit the action's resolved `VaultInfo` as the connected wallet's current vault. */
  commitInfo: boolean;
  /** Ran once the tx is submitted, before the poll starts. */
  onSubmitted?: () => void;
}

export function useVault(): UseVault {
  // Computed after mount to avoid an SSR/first-paint hydration mismatch (it reads localStorage/env).
  const [available, setAvailable] = useState(false);
  useEffect(() => setAvailable(hasCardanoProvider()), []);

  const [phase, setPhase] = useState<VaultPhase>("idle");
  const [step, setStep] = useState<VaultStep>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [lastAction, setLastAction] = useState<VaultAction | null>(null);
  const [info, setInfo] = useState<VaultInfo | null>(null);
  const [locked, setLocked] = useState<bigint | null>(null);
  const [lockedKnown, setLockedKnown] = useState(false);
  // >0 ⇒ this owner has a second vault UTxO that earns nothing (the observer credits largest-wins and
  // never sums). Surfaced so the UI can say so instead of silently showing one of them.
  const [extraVaults, setExtraVaults] = useState(0);
  // Retired-script balances. Read ONCE per inspected wallet rather than on every inspect tick: each
  // entry is another Blockfrost call, `inspect` fires on mount on two surfaces, and the confirm poll
  // re-reads every 6 seconds — so putting these on that path would multiply the quota pressure on a
  // project id that ships in the bundle by design. Nothing about a retired script changes fast enough
  // to need polling.
  const [legacy, setLegacy] = useState<LegacyVaultBalance[]>([]);
  // True only while pollUntilSettled is actively re-reading after a submit (the confirm window), so the UI
  // can show "Confirming…" for exactly that span. Deliberately NOT derived from `phase === "submitted"`,
  // which never resets — that left the card frozen on "Confirming exit…" long after the exit had landed.
  const [confirming, setConfirming] = useState(false);

  // Re-entrancy guard for a tx run. MUST NOT live inside a setState updater: React StrictMode
  // double-invokes updater functions in dev, so launching the wallet interaction from there fired
  // the tx twice — the second collided with the still-open wallet prompt and threw a spurious
  // "user declined". A plain ref keeps the guard in the event-handler body (not double-invoked).
  const inFlight = useRef(false);
  // Bounded re-read poll after a submit (see pollUntilSettled). Cleared on unmount / reset / a new run.
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollTries = useRef(0);
  // Monotonic id of the newest inspect, and the wallet it was issued for. Two vault reads can be out
  // at once (a wallet switch, an endpoint change re-firing the effect) and they do NOT come back in
  // order, so only the newest may commit.
  const inspectSeq = useRef(0);
  const inspectedWallet = useRef<string | null>(null);

  const busy = phase === "working";

  const clearPoll = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollTries.current = 0;
    setConfirming(false);
  }, []);
  // Clear any in-flight poll on unmount so it can't set state on a gone component.
  useEffect(() => clearPoll, [clearPoll]);

  const inspect = useCallback(
    (walletId: string) => {
      // A lock/exit run OWNS this state: it drives the phase the caller is toasting off. A background
      // inspect firing mid-tx (an endpoint change re-runs the caller's effect) would set phase="error"
      // on a read failure and toast a FAILURE for a transaction that is still running and about to
      // succeed — while cancelling the real "Lock submitted" toast on the way past.
      if (inFlight.current) return;
      if (pollTimer.current !== null) {
        // The confirm poll is re-reading this wallet on its own schedule; leave it to it. But if the
        // wallet has CHANGED, it is confirming a tx for an account no longer on screen, and letting it
        // keep writing would paint the previous wallet's balance onto this one.
        if (inspectedWallet.current === walletId) return;
        clearPoll();
      }

      const seq = ++inspectSeq.current;
      if (inspectedWallet.current !== walletId) {
        // A different wallet's answer must never sit on screen as this one's: "100 ADA locked" from the
        // previous wallet reads as this wallet's balance for the whole round trip, and if this read
        // then fails it stays there permanently. Clear first, re-assert only what THIS wallet confirms.
        inspectedWallet.current = walletId;
        setInfo(null);
        setLocked(null);
        setLockedKnown(false);
        setExtraVaults(0);
        setLegacy([]);
      }
      setError(null);
      // Retired-script balances, read INDEPENDENTLY of the current-script read and never gated on it.
      // This used to sit after the `!res.known` early return below, which meant a rate-limited read of
      // the CURRENT vault address also hid a stranded legacy balance — at the exact moment somebody is
      // trying to recover funds and one provider read has already failed. The two are separate
      // addresses and separate requests; one failing says nothing about the other. Its own failure is
      // swallowed: a legacy read must never be able to turn a good current-script read into an error.
      // Returns [] without touching the provider while the retired list is empty.
      void fetchLegacyVaults(walletId)
        .then((l) => seq === inspectSeq.current && setLegacy(l))
        .catch(() => seq === inspectSeq.current && setLegacy([]));
      void (async () => {
        try {
          const res = await fetchVaultState(walletId);
          if (seq !== inspectSeq.current) return; // superseded by a newer inspect
          setInfo(res.info);
          // `known: false` = the provider could not be read, which is NOT "no vault" — so NOTHING about
          // the balance may be written from it. Installing `locked = null` here destroyed the last
          // CONFIRMED balance on any rate-limited read, which disabled "Exit vault" for someone whose
          // 100 ADA was sitting right there. A failed refresh does not un-confirm an earlier successful
          // one, so the last confirmed answer stays on screen (it was true when it was read) and the
          // error plus Retry says the refresh is what failed. Same rule pollUntilSettled follows.
          if (!res.known) {
            setError("Can't check your vault right now. Try again in a moment.");
            setPhase("error");
            return;
          }
          setLocked(res.locked);
          setExtraVaults(res.extraVaults);
          setLockedKnown(true);
          setPhase((p) => (p === "error" ? "idle" : p)); // a successful re-read clears a stale failure
        } catch (e) {
          if (seq !== inspectSeq.current) return;
          // Raise the phase too, not just the message: the card only renders `error` in the `error`
          // phase, so a message with no phase left the status on its loading skeleton with a
          // permanently disabled Lock button and nothing to explain why. This is the state the Retry
          // button is attached to. Confirmed state is left alone here for the same reason as above.
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      })();
    },
    [clearPoll],
  );

  // Re-read the vault until it reflects the submitted action, then stop. A lock/exit confirms on Cardano
  // over several blocks (~20–60s on preprod); the old single 5s re-read almost always fired too early and
  // left the card stale — still "No vault yet" after a lock (with a LIVE Lock button, inviting a duplicate
  // 100-ADA lock) or still "100 ADA locked" after an exit. Bounded so a never-confirming tx can't poll
  // forever; early-exit the instant the state matches so we don't hammer Blockfrost.
  const POLL_EVERY_MS = 6000;
  const POLL_MAX = 10; // ~60s of coverage
  const pollUntilSettled = useCallback(
    (walletId: string, kind: VaultAction) => {
      clearPoll();
      setConfirming(true);
      const settled = (l: bigint | null) =>
        kind === "lock" ? l != null && l > 0n : l == null || l === 0n;
      const tick = () => {
        pollTries.current += 1;
        void (async () => {
          try {
            const res = await fetchVaultState(walletId);
            setInfo(res.info);
            // An unreadable provider is a transient poll failure, not a settled state: keep the
            // previous known-ness and keep polling within the budget rather than claiming an answer.
            if (res.known) {
              setLocked(res.locked);
              setExtraVaults(res.extraVaults);
              setLockedKnown(true);
              if (settled(res.locked)) return clearPoll();
            }
          } catch {
            /* transient read failure — keep polling within the budget */
          }
          if (pollTries.current < POLL_MAX) pollTimer.current = setTimeout(tick, POLL_EVERY_MS);
          else clearPoll();
        })();
      };
      pollTimer.current = setTimeout(tick, POLL_EVERY_MS);
    },
    [clearPoll],
  );

  const run = useCallback(
    (
      action: () => Promise<{ txHash: string; info: VaultInfo }>,
      walletId: string,
      kind: VaultAction,
      opts: RunOpts,
    ) => {
      if (inFlight.current) return; // already running (double-click / re-render); never start twice
      // A SUBMITTED tx's confirm poll owns this state until it settles, and this state has room for
      // exactly one transaction: one `phase`, one `txHash`, one `lastAction`. Starting a second tx
      // during that window overwrote `lastAction`, which is what VaultSection derives its
      // `lockInFlight` / `exitInFlight` interlock from — so a legacy exit clicked while a fresh lock
      // was still confirming re-enabled "Lock 100 ADA", and lockIntoVault's own duplicate guard reads
      // the not-yet-confirmed vault as empty and lets it through. That is a second 100 ADA locked into
      // a UTxO that earns nothing (the observer credits largest-wins and never sums), which is the
      // exact failure `confirming` was added to prevent. Serialize instead: one tx at a time, confirm
      // window included. The UI disables the affected buttons for the same window.
      if (pollTimer.current !== null) return;
      inFlight.current = true;
      // This run and its confirm poll speak for THIS wallet, so record it: an inspect for the same
      // wallet then defers to the poll, and one for a different wallet takes the state over instead of
      // silently inheriting it.
      inspectedWallet.current = walletId;
      setLastAction(kind);
      setError(null);
      setTxHash(null);
      setStep("preparing");
      setPhase("working");
      void (async () => {
        try {
          const res = await action();
          if (opts.commitInfo) setInfo(res.info);
          setTxHash(res.txHash);
          setPhase("submitted");
          opts.onSubmitted?.();
          // Re-read until the vault reflects this action (bounded); keeps the card + buttons truthful.
          if (opts.poll) pollUntilSettled(walletId, opts.poll);
        } catch (e) {
          // A user-declined wallet prompt is an expected cancel, not a failure: return to idle so the
          // user can just try again — no red "error" wall (matches the connect + CIP-8 bind flows). A
          // genuine failure still surfaces as phase="error" with the message.
          if (isUserRejection(e)) {
            setPhase("idle");
          } else {
            setError(e instanceof Error ? e.message : String(e));
            setPhase("error");
          }
        } finally {
          setStep("idle");
          inFlight.current = false;
        }
      })();
    },
    [pollUntilSettled],
  );

  const lock = useCallback(
    (walletId: string, lovelace?: bigint) => {
      run(() => lockIntoVault(walletId, lovelace, (p) => setStep(p)), walletId, "lock", {
        poll: "lock",
        commitInfo: true,
      });
    },
    [run],
  );
  const exit = useCallback(
    (walletId: string) => {
      run(() => exitVault(walletId, (p) => setStep(p)), walletId, "exit", {
        poll: "exit",
        commitInfo: true,
      });
    },
    [run],
  );
  // A legacy exit is the same run with two things switched off.
  //
  // NO POLL: pollUntilSettled's settled() predicate watches the CURRENT script's balance, which a
  // legacy exit does not move, so it would burn its full budget and time out on a transaction that
  // succeeded. The legacy row is re-read by the next inspect instead.
  //
  // NO INFO COMMIT: `info` is the connected wallet's CURRENT vault (address, beacon). exitVault against
  // a retired script resolves the retired one, and writing that here would point the card's vault
  // identity at a script the chain does not credit.
  //
  // And the kind is "exit-legacy", NOT "exit": this must not move the current vault's pending-lock
  // record in either direction. See the VaultAction doc — "exit" would clear an in-flight lock's
  // countdown, and "lock" would re-record that lock against this exit's tx hash. usePendingLockSync
  // ignores any third value, which is what makes this correct.
  const exitLegacy = useCallback(
    (walletId: string, scriptHash: string) => {
      run(() => exitVault(walletId, (p) => setStep(p), scriptHash), walletId, "exit-legacy", {
        poll: null,
        commitInfo: false,
        // Optimistically drop the row we just emptied. The tx is submitted, not yet confirmed, so
        // this is a claim about intent; the next inspect re-reads it from the provider either way.
        onSubmitted: () => setLegacy((cur) => cur.filter((l) => l.hash !== scriptHash)),
      });
    },
    [run],
  );
  const reset = useCallback(() => {
    clearPoll();
    setPhase("idle");
    setStep("idle");
    setError(null);
    setTxHash(null);
    setLastAction(null);
    inFlight.current = false;
  }, [clearPoll]);

  return { available, phase, step, busy, error, txHash, lastAction, info, locked, lockedKnown, extraVaults, legacy, confirming, inspect, lock, exit, exitLegacy, reset };
}
