"use client";

// PowerUps — Step 4 of onboarding (surface 11 §3.5 / §7.4 / §14). The account is bound (can post,
// reply, repost, follow now). This step is OPTIONAL and never blocks "Go to your timeline".
//
//   DoneBanner — "You're all set" + primary "Go to your timeline" (→ '/').
//   VaultCard   — lock 100 ADA into the L1 vault to raise the posting limit (useVault.lock). The
//                 capacity lands a few blocks later — we say "shortly", NEVER a battery/block/tx.
//                 When no Cardano provider is configured the lock is disabled with a Settings link.
//   StakeCard   — bind the wallet's stake key to earn voting weight (useIdentity.bindStake). Gated on
//                 a stake-signing wallet (Eternl/Lace); requires bound===true (the step guarantees it).
//
// "Skip for now" collapses each card; neither blocks Done. NO honesty chrome: no battery, no block
// numbers, no anchor UI, no trust labels.
//
// NOTIFICATIONS (DEFERRED — leave the seam): onboarding is the natural place to later prompt "turn on
// notifications" via a future useNotifications(who) (doc 04 §5.4) folding the indexer's
// Voted/Reposted/Followed/reply/quote edges targeting the viewer into a /notifications surface. Do
// NOT build it now — this is the named slot.

import { useState } from "react";
import styles from "./PowerUps.module.css";
import { Spinner } from "@/components/icons";
import type { UseVault } from "@/hooks/useVault";

export interface PowerUpsProps {
  vault: UseVault;
  /** the connected Cardano wallet id (drives lock + stake bind). null in the dev-account edge. */
  walletId: string | null;
  /** identity.bindStake bound-state + action. */
  stake: {
    stakeBound: boolean | null;
    stakeBinding: boolean;
    stakeError: string | null;
    votingPower: bigint | null;
    bindStake: (walletId: string) => void;
  };
  welcomeBack?: boolean;
  onGoToTimeline: () => void;
  onOpenSettings: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function PowerUps({
  vault,
  walletId,
  stake,
  welcomeBack,
  onGoToTimeline,
  onOpenSettings,
  headingRef,
}: PowerUpsProps) {
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <DoneBanner welcomeBack={welcomeBack} onGoToTimeline={onGoToTimeline} headingRef={headingRef} />

      <div className={styles.cards}>
        <VaultCard vault={vault} walletId={walletId} onOpenSettings={onOpenSettings} />
        <StakeCard stake={stake} walletId={walletId} />
      </div>

      <p className={styles.later}>You can do these later in Settings.</p>
    </section>
  );
}

// ── DoneBanner ─────────────────────────────────────────────────────────────────────────────────

function DoneBanner({
  welcomeBack,
  onGoToTimeline,
  headingRef,
}: {
  welcomeBack?: boolean;
  onGoToTimeline: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className={styles.banner}>
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        {welcomeBack ? "Welcome back" : "You're all set"}
      </h1>
      <p className={styles.bannerLede}>You can post, reply, repost, and follow right now.</p>
      <button type="button" className={styles.primary} onClick={onGoToTimeline}>
        Go to your timeline
      </button>
    </div>
  );
}

// ── VaultCard ──────────────────────────────────────────────────────────────────────────────────

function VaultCard({
  vault,
  walletId,
  onOpenSettings,
}: {
  vault: UseVault;
  walletId: string | null;
  onOpenSettings: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) return null;

  const lock = () => {
    if (walletId) vault.lock(walletId);
  };
  const retry = () => {
    vault.reset();
    lock();
  };

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Lock ADA to post more</h2>
      <p className={styles.cardBody}>
        Lock 100 ADA in the vault to raise your posting limit. You can unlock it anytime.
      </p>

      {vault.phase === "submitted" ? (
        <p className={styles.cardOk}>Locked. Your posting limit will rise shortly.</p>
      ) : !vault.available ? (
        <div className={styles.cardActions}>
          <button type="button" className={styles.cardCta} disabled aria-disabled>
            Lock 100 ADA
          </button>
          <p className={styles.cardNote}>
            Add a Cardano provider in{" "}
            <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
              Settings
            </button>{" "}
            to lock.
          </p>
        </div>
      ) : vault.phase === "error" ? (
        <div className={styles.cardActions}>
          <p className={styles.cardError} role="alert">
            {vault.error ?? "Couldn't lock. Try again."}
          </p>
          <div className={styles.cardRow}>
            <button type="button" className={styles.cardCta} onClick={retry} disabled={!walletId}>
              Retry
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.cardRow}>
          <button
            type="button"
            className={styles.cardCta}
            onClick={lock}
            disabled={vault.busy || !walletId}
            aria-busy={vault.busy || undefined}
          >
            {vault.busy ? (
              <>
                <Spinner size="sm" /> Locking…
              </>
            ) : (
              "Lock 100 ADA"
            )}
          </button>
          {!vault.busy && (
            <button type="button" className={styles.skip} onClick={() => setCollapsed(true)}>
              Skip for now
            </button>
          )}
        </div>
      )}

      {vault.busy && (
        <p className={styles.narration} aria-live="polite">
          Confirm the transaction in your wallet…
        </p>
      )}
    </div>
  );
}

// ── StakeCard ──────────────────────────────────────────────────────────────────────────────────

function StakeCard({
  stake,
  walletId,
}: {
  stake: PowerUpsProps["stake"];
  walletId: string | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  if (collapsed) return null;

  const add = () => {
    if (walletId) stake.bindStake(walletId);
  };

  // A stake-signing failure (wallet won't sign over a reward address — e.g. Nami) gets the specific
  // §14 line; any other error falls through to the generic "couldn't add voting power" copy.
  const cantStakeSign =
    !!stake.stakeError &&
    /reward address|stake-sign|no reward|exposes no reward|script stake|cannot prove/i.test(
      stake.stakeError,
    );

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Add voting power</h2>
      <p className={styles.cardBody}>Prove your wallet&apos;s stake to make your votes count.</p>

      {stake.stakeBound === true ? (
        <p className={styles.cardOk}>
          Voting power added.{" "}
          {(stake.votingPower ?? 0n) > 0n
            ? "Your votes now count."
            : "Your votes will carry weight shortly."}
        </p>
      ) : (
        <>
          <div className={styles.cardRow}>
            <button
              type="button"
              className={styles.cardCta}
              onClick={add}
              disabled={stake.stakeBinding || !walletId}
              aria-busy={stake.stakeBinding || undefined}
            >
              {stake.stakeBinding ? (
                <>
                  <Spinner size="sm" /> Adding voting power…
                </>
              ) : (
                "Add voting power"
              )}
            </button>
            {!stake.stakeBinding && (
              <button type="button" className={styles.skip} onClick={() => setCollapsed(true)}>
                Skip for now
              </button>
            )}
          </div>

          {stake.stakeBinding && (
            <p className={styles.narration} aria-live="polite">
              Approve the stake signature in your wallet…
            </p>
          )}

          {stake.stakeError && !stake.stakeBinding && (
            <p className={styles.cardError} role="alert">
              {cantStakeSign
                ? "This wallet can't prove its stake. Try Eternl or Lace."
                : `Couldn't add voting power — ${stake.stakeError}.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
