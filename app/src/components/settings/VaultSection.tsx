"use client";

// VaultSection — Settings §4 (doc 12). Lock / exit the 100-ADA L1 vault that earns POSTING POWER
// (talk-capacity weight). Framed plainly as "posting power" — NEVER a battery, NO tx/block chrome.
//
// Reads useVault (Blockfrost) for lock/exit + the on-chain TalkStake.AllowedStake(ss58) watch for the
// granted weight (lags the lock by a few blocks). When no Cardano provider is configured the whole
// lock/exit block is hidden with a one-line link to Network.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./VaultSection.module.css";
import { Spinner } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { useSession } from "@/components/Providers";
import { useVault } from "@/hooks/useVault";
import { useActionToast } from "@/hooks/useActionToast";

const LOCK_AMOUNT = 100_000_000n; // 100 ADA in lovelace

/** lovelace → "N.N ADA"; "—" for 0/null. */
function formatAda(lovelace: bigint | null): string {
  if (lovelace == null || lovelace === 0n) return "—";
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n) / 100_000n;
  return `${whole.toLocaleString()}.${frac} ADA`;
}

export function VaultSection({ onGoNetwork }: { onGoNetwork?: () => void }) {
  const { api, signerCtl } = useSession();
  const vault = useVault();
  const { fail, ok } = useActionToast();
  const actionRef = useRef<"lock" | "exit" | null>(null);
  const walletId = signerCtl.connectedWalletId;
  const ss58 = signerCtl.signer.ss58;
  const connected = signerCtl.walletConnected && !!walletId;

  // On-chain posting power (the weight the follower/inherent granted). Watched — it lands a few blocks
  // after a lock. This is the ONLY chain read here.
  const [postingPower, setPostingPower] = useState<bigint | null>(null);
  useEffect(() => {
    if (!api) {
      setPostingPower(null);
      return;
    }
    const sub = api.query.TalkStake.AllowedStake.watchValue(ss58, "best").subscribe(
      (w) => setPostingPower((w as bigint) ?? 0n),
      () => setPostingPower(null),
    );
    return () => sub.unsubscribe();
  }, [api, ss58]);

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
      ok(action === "lock" ? "Lock submitted — posting power updates shortly" : "Exit submitted — updating shortly");
      actionRef.current = null;
    } else if (vault.phase === "error" && vault.error) {
      fail(vault.error);
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

  return (
    <div className={styles.cards}>
      {/* Posting power (on-chain weight) */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Posting power</h3>
        {postingPower === null ? (
          <Skeleton variant="line" width="120px" />
        ) : postingPower > 0n ? (
          <p className={styles.power}>{formatAda(postingPower)} locked</p>
        ) : (
          <p className={styles.powerMuted}>No posting power yet</p>
        )}
        <p className={styles.note}>Lock ADA below to start posting without hitting the rate limit.</p>
      </div>

      {/* Provider unavailable → hide lock/exit, link to Network */}
      {!vault.available ? (
        <div className={styles.card}>
          <p className={styles.prompt}>
            Set a Cardano provider in{" "}
            {onGoNetwork ? (
              <button type="button" className={styles.inlineLink} onClick={onGoNetwork}>
                Network
              </button>
            ) : (
              "Network"
            )}{" "}
            to lock ADA.
          </p>
        </div>
      ) : !connected ? (
        <div className={styles.card}>
          <p className={styles.prompt}>Connect a wallet to lock ADA.</p>
          <ConnectWalletButton viewer={{ status: "not-connected", hasVotingPower: false }} />
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
            ) : (
              <span className={styles.statusMuted}>No vault yet</span>
            )}
          </div>

          <div className={styles.btnRow}>
            <button
              type="button"
              className={styles.primaryBtn}
              onClick={onLock}
              disabled={working || hasLock || !vault.lockedKnown}
            >
              {working ? (
                <>
                  <Spinner size="sm" label="Submitting lock" /> Submitting lock…
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
              disabled={working || !hasLock}
            >
              {working ? (
                <>
                  <Spinner size="sm" label="Submitting exit" /> Submitting exit…
                </>
              ) : (
                "Exit vault"
              )}
            </button>
          </div>

          {vault.phase === "submitted" && (
            <p className={styles.submitted}>Submitted — updating shortly</p>
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
