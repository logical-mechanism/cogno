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
import { useSession, useBestBlock } from "@/components/Providers";
import { useVault, type VaultAction } from "@/hooks/useVault";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { useObserverHealth } from "@/hooks/useObserverHealth";
import { usePendingLockSync } from "@/hooks/usePendingLockSync";
import { usePendingLockRecover } from "@/hooks/usePendingLockRecover";
import { PendingCapacityNotice } from "@/components/PendingCapacityNotice";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { useActionToast } from "@/hooks/useActionToast";
import { formatAda } from "@/lib/format";
import { useStabilityWindow } from "@/hooks/useStabilityWindow";
import { MIN_LOCK } from "@/lib/cardano/blueprint";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/lockAmount";

// The script's own enforced floor, never a literal. This was a hardcoded `100_000_000n`, which is a
// worse hazard than the copy alongside it: a redeploy that moves `minLock` would leave this building
// transactions for the wrong amount, silently under- or over-paying the vault.
const LOCK_AMOUNT = MIN_LOCK;

export function VaultSection() {
  const { api, signerCtl, boot } = useSession();
  const bestBlock = useBestBlock();
  // The lock-to-credit wait is a chain parameter (~10 min on preprod, ~36 h at the mainnet window),
  // so it is read rather than asserted. See useStabilityWindow.
  const stabilityWindow = useStabilityWindow(api);
  const vault = useVault();
  const { fail, ok } = useActionToast();
  // Every vault action sets this, INCLUDING the legacy exit. It used to be `"lock" | "exit"` and
  // `onExitLegacy` did not exist, so the effect below early-returned on `!action` and a legacy exit was
  // the one vault operation that produced neither a success nor a failure toast — a wallet or Ogmios
  // failure surfaced only as the inline error line.
  const actionRef = useRef<VaultAction | null>(null);
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
  usePendingLockSync(vault, ss58, api);
  // Same recovery as the welcome flow: this section already has vault state loaded, so it is one of
  // the two places that can rebuild a record for a lock placed on another device.
  usePendingLockRecover(vault, ss58, postingPower);
  const pending = usePendingCapacity(api, ss58, postingPower);
  // Observer liveness, so this panel does not narrate a countdown against a frontier that has stopped
  // moving. `useBestBlock` is the shared, visibility-frozen head — never a private useHeads here.
  const observer = useObserverHealth(api, bestBlock);

  // Inspect the vault once on mount / wallet change — but only once the chain has answered. The vault
  // ADDRESS is built from the Cardano network the chain names (lib/cardano/network.ts), so inspecting
  // while the boot probe is still in flight throws "still connecting" and never retries. `boot` is the
  // signal that the probe has settled (its Cardano resolve rides the same promise), and it flips once.
  useEffect(() => {
    if (boot && connected && walletId) vault.inspect(walletId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, connected, walletId]);

  // Toast the slow Cardano lock/exit settle (the in-flight spinner already shows inline on the button).
  useEffect(() => {
    const action = actionRef.current;
    if (!action) return;
    if (vault.phase === "submitted") {
      ok(
        action === "lock"
          ? "Lock submitted. Crediting your posting power"
          : action === "exit-legacy"
            ? "Submitted. Your ADA is on its way back"
            : "Exit submitted",
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
  const onExitLegacy = useCallback(
    (scriptHash: string) => {
      if (walletId) {
        actionRef.current = "exit-legacy";
        vault.exitLegacy(walletId, scriptHash);
      }
    },
    [vault, walletId],
  );

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
            observer={observer}
            variant="inline"
            onDismiss={() => pendingLockActions.clear(ss58)}
          />
        ) : (
          <p className={styles.powerMuted}>No posting power yet</p>
        )}
        {!showingPending && (
          <p className={styles.note}>
            Posting power comes from locked ADA.
            {stabilityWindow ? ` It lands ${stabilityWindow} after your lock confirms on Cardano.` : ""}
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
                `Lock ${LOCK_ADA_WHOLE} ADA`
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
              Exiting returns your {LOCK_ADA_WHOLE} ADA and removes your posting power until you lock
              again.
            </p>
          )}
          {/* A second vault UTxO is pure loss of use: the chain credits the largest one and never sums,
              so the extra ADA earns nothing and no other screen mentions it. Exit spends the largest,
              which is why getting it all back takes one exit per vault. */}
          {hasLock && vault.extraVaults > 0 && (
            <p className={styles.note}>
              You have {vault.extraVaults + 1} vaults holding ADA. Only the largest one earns posting
              power. Exit once for each vault to get all of it back.
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

          {/* Older vaults. This renders nothing today and is not speculative: talk_vault has been
              deployed once, so the retired-script list is empty. The point is that the day it is not
              empty — the day a vulnerability forces a redeploy while real ADA is locked — the recovery
              path already exists, already ships and already has tests, instead of having to be written
              under exactly the time pressure where that goes wrong.

              Rendered ONLY on a confirmed balance (`known && lovelace > 0`). An unreadable legacy
              script must never render as an empty one, which is the same rule the current-script read
              follows, and a row that appears and disappears with Blockfrost's mood would be worse than
              no row at all. */}
          {vault.legacy
            .filter((l) => l.known && l.lovelace != null && l.lovelace > 0n)
            .map((l) => (
              <div key={l.hash} className={styles.legacy}>
                <p className={styles.note}>
                  You have {formatAda(l.lovelace)} in an older vault. It does not earn posting power,
                  because the network only counts the current one. Getting it back is its own
                  transaction.
                </p>
                {/* Disabled for the CONFIRM window too, not just the in-flight tx. The hook holds one
                    transaction's worth of state, so starting this while a lock or exit is still
                    confirming would take `lastAction` off the action the interlock above is reading
                    and re-enable "Lock 100 ADA" mid-confirm. The hook refuses it as well; this is the
                    half that says so rather than doing nothing on the click. */}
                <button
                  type="button"
                  className={styles.outlineBtn}
                  onClick={() => onExitLegacy(l.hash)}
                  disabled={vault.busy || vault.confirming || !walletId}
                >
                  {vault.busy || vault.confirming ? (
                    <>
                      <Spinner size="sm" label="Working" /> Working…
                    </>
                  ) : (
                    "Get this ADA back"
                  )}
                </button>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
