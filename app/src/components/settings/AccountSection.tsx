"use client";

// AccountSection — Settings §2 (doc 12). Session-state-driven sub-cards: the connected wallet (+
// Disconnect), the derived posting account (Handle + Copy → clipboard + success Toast), the identity
// bind status (Finish setup → identity.bind), and voting power (Add voting power → identity.bindStake).
// Display + disconnect only — the binds reuse useIdentity exactly as /welcome does. NO honesty copy.

import { useCallback, useEffect, useState } from "react";
import styles from "./AccountSection.module.css";
import { Handle } from "@/components/Handle";
import { Spinner } from "@/components/icons";
import { Skeleton } from "@/components/Skeleton";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { truncateSs58 } from "@/lib/ss58";
import { setupStatus } from "@/lib/setup-status";
import { formatAda } from "@/lib/format";

export function AccountSection({ onGoVault }: { onGoVault?: () => void }) {
  const { api, signerCtl, identity, sessionState } = useSession();
  const { toast } = useToaster();

  const walletConnected = signerCtl.walletConnected;
  const postingEnabled = signerCtl.postingEnabled;
  const ss58 = signerCtl.signer.ss58;
  const walletId = signerCtl.connectedWalletId;

  // Posting power (TalkStake.AllowedStake = locked-ADA weight). Feeds the canonical setup status so the
  // banner says "you can post" only once it's non-zero — a registered account with zero locked ADA has
  // zero talk-capacity and cannot post. null while loading → a neutral "checking" verdict.
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

  // A lock crediting → the setup status says "crediting", not "lock ADA" (called before any early
  // return to satisfy the Rules of Hooks).
  const pending = usePendingCapacity(api, ss58, postingPower);

  const copyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ss58);
      toast({ kind: "success", message: "Copied" });
    } catch {
      toast({ kind: "error", message: "Couldn't copy address" });
    }
  }, [ss58, toast]);

  const copyWalletAddress = useCallback(async () => {
    const addr = signerCtl.walletAddress;
    if (!addr) return;
    try {
      await navigator.clipboard.writeText(addr);
      toast({ kind: "success", message: "Copied" });
    } catch {
      toast({ kind: "error", message: "Couldn't copy address" });
    }
  }, [signerCtl.walletAddress, toast]);

  // disconnected (no wallet, no dev account): a single card with a connect prompt. The connect button
  // lives in the global Account control (bottom-left) — no need to duplicate it on every settings panel.
  if (!postingEnabled) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <p className={styles.prompt}>Connect a Cardano wallet to post.</p>
        </div>
      </div>
    );
  }

  // connecting (sign-to-derive in flight).
  if (signerCtl.deriving) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <span className={styles.signingIn}>
            <Spinner size="sm" label="Signing in" /> Signing in…
          </span>
        </div>
      </div>
    );
  }

  const loadingBound = identity.bound === null;
  const loadingVote = identity.votingPower === null;
  const status = setupStatus(sessionState, postingPower, pending.kind !== "none");

  return (
    <div className={styles.cards}>
      {/* The single canonical setup status — one headline + the ONE next required step (when any).
          Everything below is detail/optional, so "am I all set?" has a single answer here. The
          posting-power read resolves async (checking → "Lock ADA"), so announce the verdict politely. */}
      <div className={`${styles.card} ${styles.statusCard}`} aria-live="polite">
        <p className={styles.statusHeadline}>
          {status.ready ? "✓ " : ""}
          {status.headline}
        </p>
        <p className={styles.statusDetail}>{status.detail}</p>
        {status.next?.kind === "bind" && (
          <button
            type="button"
            className={styles.primaryBtn}
            onClick={() => walletId && identity.bind(walletId)}
            disabled={identity.binding || !walletId}
          >
            {identity.binding ? (
              <>
                <Spinner size="sm" label="Registering" /> Registering…
              </>
            ) : (
              status.next.label
            )}
          </button>
        )}
        {status.next?.kind === "lock" && onGoVault && (
          <button type="button" className={styles.primaryBtn} onClick={onGoVault}>
            {status.next.label}
          </button>
        )}
        {identity.error && (
          <p className={styles.error} role="alert">
            {identity.error}
          </p>
        )}
      </div>

      {/* Connected wallet card (only when a real wallet is connected, not a dev account) */}
      {walletConnected && walletId && (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>Connected wallet</h3>
          <div className={styles.walletRow}>
            <span className={styles.walletName}>
              {walletId}
              {signerCtl.walletAddress && (
                <>
                  <span className={styles.walletSep} aria-hidden>
                    {" · "}
                  </span>
                  <button
                    type="button"
                    className={styles.walletAddr}
                    onClick={copyWalletAddress}
                    title={signerCtl.walletAddress}
                    aria-label={`Copy wallet address ${signerCtl.walletAddress}`}
                  >
                    {truncateSs58(signerCtl.walletAddress)}
                  </button>
                </>
              )}
            </span>
            <button type="button" className={styles.outlineBtn} onClick={signerCtl.disconnect}>
              Disconnect
            </button>
          </div>
        </div>
      )}

      {/* Posting account card */}
      <div className={styles.card}>
        <h3 className={styles.cardTitle}>Posting account</h3>

        <div className={styles.acctRow}>
          <Handle address={ss58} truncate="middle" />
          <button
            type="button"
            className={styles.copyBtn}
            onClick={copyAddress}
            aria-label="Copy posting account address"
          >
            Copy
          </button>
        </div>

        {/* Identity — display only; the status banner above owns the "Finish setup" action. */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Identity</span>
          {loadingBound ? (
            <Skeleton variant="line" width="96px" />
          ) : identity.bound ? (
            <span className={styles.statValue}>✓ Registered</span>
          ) : (
            <span className={styles.statMuted}>Not registered yet</span>
          )}
        </div>

        {/* Voting power — OPTIONAL boost, only meaningful once registered. */}
        {identity.bound && (
          <>
            <p className={styles.optionalNote}>
              Only affects how much weight your votes carry.
            </p>
            <div className={styles.statRow}>
              <span className={styles.statLabel}>Voting power</span>
              {loadingVote ? (
                <Skeleton variant="line" width="80px" />
              ) : (
                <span className={styles.statValue}>{formatAda(identity.votingPower)}</span>
              )}
            </div>

            <div className={styles.statRow}>
              <span className={styles.statLabel}>Stake key</span>
              {identity.stakeBound ? (
                <span className={styles.statValue}>✓ Linked</span>
              ) : (
                <button
                  type="button"
                  className={styles.outlineBtn}
                  onClick={() => walletId && identity.bindStake(walletId)}
                  disabled={identity.stakeBinding || !walletId}
                >
                  {identity.stakeBinding ? (
                    <>
                      <Spinner size="sm" label="Linking" /> Linking…
                    </>
                  ) : (
                    "Add voting power"
                  )}
                </button>
              )}
            </div>
            {identity.stakeError && (
              <p className={styles.error} role="alert">
                {identity.stakeError}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
