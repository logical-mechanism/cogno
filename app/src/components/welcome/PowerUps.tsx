"use client";

// PowerUps — Step 4 of onboarding (surface 11 §3.5 / §7.4 / §14). The identity is bound (the Sybil
// gate), but posting ALSO requires locked-ADA talk-capacity: a bound account with zero locked ADA has
// zero capacity and every post is refused by CheckCapacity. So this step does NOT claim "you can post"
// up front — it foregrounds locking ADA as the REQUIRED next step to post, while keeping reading open.
//
//   notReady (no posting power yet) — heading "One step left to post"; the VaultCard is the REQUIRED
//                 primary action (lock 100 ADA → posting capacity), the StakeCard (voting power) is the
//                 only OPTIONAL boost, and a quiet "Browse the timeline (read-only)" link never blocks
//                 reading. We never say a battery/block/tx — capacity "arrives shortly".
//   justLocked    — the lock was submitted; capacity lands a few blocks later → "Almost there".
//   canPost       — posting power > 0 → "You're all set" + "Go to your timeline" (+ optional voting power).
//
// VaultCard — lock 100 ADA into the L1 vault to GET posting capacity (useVault.lock). When no Cardano
//             provider is configured the lock is disabled with a Settings link.
// StakeCard — bind the wallet's stake key to earn voting weight (useIdentity.bindStake). Genuinely
//             optional; gated on a stake-signing wallet (Eternl/Lace).
//
// NO honesty chrome: no battery, no block numbers, no anchor UI, no trust labels.
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
  /**
   * On-chain posting power (TalkStake.AllowedStake): `> 0n` can post, `0n` registered-but-unlocked,
   * `null` still loading. We pass the raw value (not a collapsed boolean) so a returning, already-
   * locked user shows a neutral "checking" state instead of flashing "One step left to post".
   */
  postingPower: bigint | null;
  welcomeBack?: boolean;
  onGoToTimeline: () => void;
  onOpenSettings: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function PowerUps({
  vault,
  walletId,
  stake,
  postingPower,
  welcomeBack,
  onGoToTimeline,
  onOpenSettings,
  headingRef,
}: PowerUpsProps) {
  const hasPostingPower = (postingPower ?? 0n) > 0n;
  const justLocked = !hasPostingPower && vault.phase === "submitted";

  // Already postable (or the lock just landed) → a done/almost-done banner + the optional voting boost.
  if (hasPostingPower || justLocked) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <DoneBanner
          welcomeBack={welcomeBack}
          justLocked={justLocked}
          onGoToTimeline={onGoToTimeline}
          headingRef={headingRef}
        />
        <div className={styles.cards}>
          <StakeCard stake={stake} walletId={walletId} />
        </div>
        <p className={styles.later}>You can manage voting power anytime in Settings.</p>
      </section>
    );
  }

  // Posting power still loading → neutral "checking" banner, so a returning already-locked user never
  // flashes the "Lock ADA to post" required UI before the read resolves (mirrors setupStatus checking).
  if (postingPower === null) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <div className={styles.banner}>
          <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
            Almost there
          </h1>
          <p className={styles.bannerLede} aria-live="polite">
            Checking your posting power…
          </p>
        </div>
      </section>
    );
  }

  // Not postable yet (postingPower === 0n): locking ADA is the REQUIRED next step (reading stays open).
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <div className={styles.banner}>
        <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
          One step left to post
        </h1>
        <p className={styles.bannerLede}>
          You can read right now. To post, lock ADA for posting capacity — reading always stays open.
        </p>
      </div>

      <div className={styles.cards}>
        <VaultCard vault={vault} walletId={walletId} onOpenSettings={onOpenSettings} />
        <StakeCard stake={stake} walletId={walletId} />
      </div>

      <button type="button" className={styles.readOnly} onClick={onGoToTimeline}>
        Browse the timeline (read-only)
      </button>
    </section>
  );
}

// ── DoneBanner ─────────────────────────────────────────────────────────────────────────────────

function DoneBanner({
  welcomeBack,
  justLocked,
  onGoToTimeline,
  headingRef,
}: {
  welcomeBack?: boolean;
  justLocked: boolean;
  onGoToTimeline: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  const heading = justLocked ? "Almost there" : welcomeBack ? "Welcome back" : "You're all set";
  const lede = justLocked
    ? "Locked — your posting capacity arrives in a moment. You can read in the meantime."
    : "You can post, reply, repost, and follow.";
  return (
    <div className={styles.banner}>
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        {heading}
      </h1>
      <p className={styles.bannerLede}>{lede}</p>
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
  const lock = () => {
    if (walletId) vault.lock(walletId);
  };
  const retry = () => {
    vault.reset();
    lock();
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardTitleRow}>
        <h2 className={styles.cardTitle}>Lock ADA to post</h2>
        <span className={styles.requiredChip}>Required to post</span>
      </div>
      <p className={styles.cardBody}>
        Lock 100 ADA in the vault to get posting capacity. You can unlock it anytime.
      </p>

      {vault.phase === "submitted" ? (
        <p className={styles.cardOk}>Locked. Your posting capacity arrives shortly.</p>
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
      <div className={styles.cardTitleRow}>
        <h2 className={styles.cardTitle}>Add voting power</h2>
        <span className={styles.optionalChip}>Optional</span>
      </div>
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
