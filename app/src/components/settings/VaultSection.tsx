"use client";

// VaultSection — Settings. Lock / exit the 100-ADA L1 vault that earns POSTING POWER
// (talk-capacity weight). Framed plainly as "posting power" — NEVER a battery, NO app-chain
// block/finalization chrome. The ONE exception (by request): after a lock/exit submits, we link the
// resulting Cardano transaction on Cardanoscan — it's a real L1 tx the user initiated, so it
// shouldn't just vanish while the on-chain weight settles.
//
// Reads useVault (Blockfrost) for lock/exit + the on-chain TalkStake.AllowedStake(ss58) watch for the
// granted weight (lags the lock by a few blocks). When no Cardano provider is configured the whole
// lock/exit block is hidden with a one-line prompt to configure one.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./VaultSection.module.css";
import { Spinner } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";
import { CardanoTxLink } from "@/components/CardanoTxLink";
import { useSession } from "@/components/Providers";
import { useVault } from "@/hooks/useVault";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { usePendingLockSync } from "@/hooks/usePendingLockSync";
import { PendingCapacityNotice } from "@/components/PendingCapacityNotice";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { useActionToast } from "@/hooks/useActionToast";
import { formatAda } from "@/lib/format";

const LOCK_AMOUNT = 100_000_000n; // 100 ADA in lovelace

export function VaultSection() {
  const { api, signerCtl } = useSession();
  const vault = useVault();
  const { fail, ok } = useActionToast();
  const actionRef = useRef<"lock" | "exit" | null>(null);
  const walletId = signerCtl.connectedWalletId;
  const ss58 = signerCtl.signer.ss58;
  // `walletSession`, not `walletConnected`: locking and exiting the vault are `wallet.signTx` +
  // `wallet.submitTx` on the CARDANO key, which a restored session has exactly as much access to as a
  // freshly-derived one. Keying this on `walletConnected` told every returning user to "connect a
  // wallet" they were already connected to, and hid the vault controls behind a refresh.
  const connected = signerCtl.walletSession && !!walletId;

  // On-chain posting power (the weight the observer inherent granted). Watched — it lands only after the
  // lock clears the observer's stability window (see usePendingCapacity, which shows the ETA).
  const [postingPower, setPostingPower] = useState<bigint | null>(null);
  useEffect(() => {
    if (!api) {
      setPostingPower(null);
      return;
    }
    // PAPI v2: watchValue takes an options object and emits { block, value } (destructure .value).
    const sub = api.query.TalkStake.AllowedStake.watchValue(ss58, { at: "best" }).subscribe(
      ({ value: w }) => setPostingPower((w as bigint) ?? 0n),
      () => setPostingPower(null),
    );
    return () => sub.unsubscribe();
  }, [api, ss58]);

  // Persist the in-flight lock + surface the explained, timed "crediting" state (survives reload,
  // covers relock). Mirrors the welcome flow so both places tell the same story.
  usePendingLockSync(vault, ss58);
  const pending = usePendingCapacity(api, ss58, postingPower);

  // Inspect the vault once on mount / wallet change.
  useEffect(() => {
    if (connected && walletId) vault.inspect(walletId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, walletId]);

  // Toast the slow Cardano lock/exit settle (the in-flight spinner already shows inline on the button).
  useEffect(() => {
    const action = actionRef.current;
    if (!action) return;
    if (vault.phase === "submitted") {
      ok(
        action === "lock"
          ? "Lock submitted. Crediting your posting power"
          : "Exit submitted. Your posting power will update",
      );
      actionRef.current = null;
    } else if (vault.phase === "error" && vault.error) {
      // A CARDANO L1 failure (wallet rejection, Ogmios submit), not a chain dispatch error — so it has
      // no pallet to classify against and carries its own prose. `raw` is the honest kind here; it can
      // never be mistaken for the capacity rate limit, which is a cogno-chain concept.
      fail({ kind: "raw", detail: vault.error });
      actionRef.current = null;
    }
  }, [vault.phase, vault.error, fail, ok]);

  const onLock = useCallback(() => {
    if (walletId) {
      actionRef.current = "lock";
      vault.lock(walletId, LOCK_AMOUNT);
    }
  }, [vault, walletId]);
  const onExit = useCallback(() => {
    if (walletId) {
      actionRef.current = "exit";
      vault.exit(walletId);
    }
  }, [vault, walletId]);

  const locked = vault.locked;
  const hasLock = locked != null && locked > 0n;
  const working = vault.phase === "working";
  // After a submit the Cardano tx is still confirming — useVault polls the vault until it settles and
  // exposes `confirming` for exactly that window. Gate BOTH actions on the in-flight action so a
  // just-locked user can't click Lock again (a duplicate 100-ADA lock) and a just-exited user can't
  // re-click Exit while the row still reads "100 ADA locked". (Deriving these from `phase === "submitted"`
  // — which never resets — froze "Confirming exit…" on the card long after the exit had landed.)
  const lockInFlight = vault.confirming && vault.lastAction === "lock";
  const exitInFlight = vault.confirming && vault.lastAction === "exit";
  // The pending "crediting" notice replaces "No posting power yet" (and its lock-below note) while a
  // lock is in flight — the user already locked; don't tell them to lock again.
  const showingPending = postingPower != null && postingPower <= 0n && pending.kind !== "none";

  return (
    <div className={styles.cards}>
      {/* Posting power (on-chain weight) */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Posting power</h3>
        {postingPower === null ? (
          <Skeleton variant="line" width="120px" />
        ) : postingPower > 0n ? (
          <p className={styles.power}>{formatAda(postingPower)} locked</p>
        ) : showingPending ? (
          <PendingCapacityNotice
            status={pending}
            variant="inline"
            onDismiss={() => pendingLockActions.clear(ss58)}
          />
        ) : (
          <p className={styles.powerMuted}>No posting power yet</p>
        )}
        {!showingPending && (
          <p className={styles.note}>
            Posting requires locked ADA. Lock below to earn the posting power every post spends. It
            becomes available a few minutes after your lock confirms on Cardano.
          </p>
        )}
      </div>

      {/* Provider unavailable → hide lock/exit, prompt to configure one */}
      {!vault.available ? (
        <div className={styles.card}>
          <p className={styles.prompt}>Set a Cardano provider to lock ADA.</p>
        </div>
      ) : !connected ? (
        <div className={styles.card}>
          <p className={styles.prompt}>Connect a wallet to lock ADA.</p>
        </div>
      ) : (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>Vault</h3>
          <div className={styles.statusRow}>
            <span className={styles.statusLabel}>Status</span>
            {!vault.lockedKnown ? (
              <Skeleton variant="line" width="100px" />
            ) : hasLock ? (
              <span className={styles.statusValue}>{formatAda(locked)} locked</span>
            ) : lockInFlight ? (
              <span className={styles.statusMuted}>Confirming lock…</span>
            ) : exitInFlight ? (
              <span className={styles.statusMuted}>Confirming exit…</span>
            ) : (
              <span className={styles.statusMuted}>No vault yet</span>
            )}
          </div>

          <div className={styles.btnRow}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={onLock}
              disabled={working || lockInFlight || hasLock || !vault.lockedKnown}
            >
              {working && vault.lastAction === "lock" ? (
                <>
                  <Spinner size="sm" label="Submitting lock" /> Submitting lock…
                </>
              ) : lockInFlight ? (
                <>
                  <Spinner size="sm" label="Confirming lock" /> Confirming…
                </>
              ) : hasLock ? (
                "Already locked"
              ) : (
                "Lock 100 ADA"
              )}
            </button>
            <button
              type="button"
              className={styles.outlineBtn}
              onClick={onExit}
              disabled={working || exitInFlight || !hasLock}
            >
              {working && vault.lastAction === "exit" ? (
                <>
                  <Spinner size="sm" label="Submitting exit" /> Submitting exit…
                </>
              ) : exitInFlight ? (
                <>
                  <Spinner size="sm" label="Confirming exit" /> Confirming…
                </>
              ) : (
                "Exit vault"
              )}
            </button>
          </div>
          {hasLock && !exitInFlight && (
            <p className={styles.note}>
              Exiting returns your 100 ADA and removes your posting power until you lock again.
            </p>
          )}

          {vault.phase === "submitted" && (
            <div className={styles.submittedRow}>
              <p className={styles.submitted}>Submitted ✓</p>
              {vault.txHash && <CardanoTxLink txHash={vault.txHash} />}
            </div>
          )}
          {vault.phase === "error" && vault.error && (
            <p className={styles.error} role="alert">
              {vault.error}{" "}
              <button type="button" className={styles.retry} onClick={() => walletId && vault.inspect(walletId)}>
                Retry
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
