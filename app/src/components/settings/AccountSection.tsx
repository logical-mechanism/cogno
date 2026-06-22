"use client";

// AccountSection — Settings §2 (doc 12). Session-state-driven sub-cards: the connected wallet (+
// Disconnect), the derived posting account (Handle + Copy → clipboard + success Toast), the identity
// bind status (Finish setup → identity.bind), and voting power (Add voting power → identity.bindStake).
// Display + disconnect only — the binds reuse useIdentity exactly as /welcome does. NO honesty copy.

import { useCallback } from "react";
import styles from "./AccountSection.module.css";
import { Handle } from "@/components/Handle";
import { Spinner } from "@/components/icons";
import { ConnectWalletButton } from "@/components/ConnectWalletButton";
import { Skeleton } from "@/components/Skeleton";
import { useSession } from "@/components/Providers";
import { useToaster } from "@/components/toast/ToasterProvider";
import { truncateSs58 } from "@/lib/ss58";

/** lovelace → "N.N ADA" (voting power display); "—" when 0/null. */
function formatAda(lovelace: bigint | null): string {
  if (lovelace == null || lovelace === 0n) return "—";
  const whole = lovelace / 1_000_000n;
  const frac = (lovelace % 1_000_000n) / 100_000n; // one decimal place
  return `${whole.toLocaleString()}.${frac} ADA`;
}

export function AccountSection() {
  const { signerCtl, identity } = useSession();
  const { toast } = useToaster();

  const walletConnected = signerCtl.walletConnected;
  const postingEnabled = signerCtl.postingEnabled;
  const ss58 = signerCtl.signer.ss58;
  const walletId = signerCtl.connectedWalletId;

  const copyAddress = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(ss58);
      toast({ kind: "success", message: "Copied" });
    } catch {
      toast({ kind: "error", message: "Couldn't copy address" });
    }
  }, [ss58, toast]);

  // disconnected (no wallet, no dev account): a single empty card + the connect affordance.
  if (!postingEnabled) {
    return (
      <div className={styles.cards}>
        <div className={styles.card}>
          <p className={styles.prompt}>Connect a Cardano wallet to post.</p>
          <ConnectWalletButton viewer={{ status: "not-connected", hasVotingPower: false }} />
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

  return (
    <div className={styles.cards}>
      {/* Connected wallet card (only when a real wallet is connected, not a dev account) */}
      {walletConnected && walletId && (
        <div className={styles.card}>
          <h3 className={styles.cardTitle}>Connected wallet</h3>
          <div className={styles.walletRow}>
            <span className={styles.walletName}>
              {walletId}
              {signerCtl.walletAddress && (
                <span className={styles.walletAddr}> · {truncateSs58(signerCtl.walletAddress)}</span>
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

        {/* Identity */}
        <div className={styles.statRow}>
          <span className={styles.statLabel}>Identity</span>
          {loadingBound ? (
            <Skeleton variant="line" width="96px" />
          ) : identity.bound ? (
            <span className={styles.statValue}>✓ Registered</span>
          ) : (
            <div className={styles.statAction}>
              <span className={styles.statMuted}>Not registered</span>
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
                  "Finish setup"
                )}
              </button>
            </div>
          )}
        </div>
        {identity.error && (
          <p className={styles.error} role="alert">
            {identity.error}
          </p>
        )}

        {/* Voting power (only meaningful once registered) */}
        {identity.bound && (
          <>
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
