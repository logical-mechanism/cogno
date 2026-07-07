"use client";

// PowerUps — Step 4 of onboarding (surface 11 §3.5 / §7.4 / §14). The identity is bound (the Sybil
// gate), but posting ALSO requires locked-ADA talk-capacity: a bound account with zero locked ADA has
// zero capacity and every post is refused by CheckCapacity. So this step does NOT claim "you can post"
// up front — it foregrounds locking ADA as the REQUIRED next step to post, while keeping reading open.
//
//   notReady (no posting power, none pending) — heading "One step left to post"; the VaultCard is the
//                 REQUIRED primary action (lock 100 ADA → posting capacity), the StakeCard (voting power)
//                 is the only OPTIONAL boost, and a quiet "Browse the timeline (read-only)" link never
//                 blocks reading.
//   pending       — a lock is in flight/crediting (usePendingCapacity, driven by the persisted pending
//                 record so it survives reload / follows a relock) → the timed PendingCapacityNotice with
//                 a live "posting unlocks in ~N min" ETA + progress, plus "go to your timeline" (reading
//                 stays open). Replaces the old ephemeral "Almost there / arrives shortly".
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
import { StepFlow } from "./StepFlow";
import { CardanoTxLink } from "@/components/CardanoTxLink";
import { PendingCapacityNotice, pendingTitle } from "@/components/PendingCapacityNotice";
import { pendingLockActions } from "@/lib/pendingLockStore";
import type { PendingCapacityStatus } from "@/hooks/usePendingCapacity";
import type { UseVault, VaultStep } from "@/hooks/useVault";
import type { BindPhase } from "@/hooks/useIdentity";

// ── shared step-flow configs (mirror the hook phases) ────────────────────────────────────────────

// Same three-phase shape as the register bind (BIND_STEPS) — both are the one feeless app-chain bind
// tx (sign → submit-to-finalization → on-chain readback), so they read identically in the UI.
const STAKE_STEPS: { key: Exclude<BindPhase, "idle">; label: string }[] = [
  { key: "signing", label: "Sign in your wallet" },
  { key: "submitting", label: "Submit voting power" },
  { key: "confirming", label: "Confirm on-chain" },
];
const STAKE_NARRATION: Record<Exclude<BindPhase, "idle">, string> = {
  signing: "Approve the stake signature in your wallet…",
  submitting: "Submitting your voting power to the network…",
  confirming: "Confirming on-chain…",
};

const VAULT_STEPS: { key: Exclude<VaultStep, "idle">; label: string }[] = [
  { key: "preparing", label: "Prepare the transaction" },
  { key: "signing", label: "Sign in your wallet" },
  { key: "submitting", label: "Submit to Cardano" },
];
const VAULT_NARRATION: Record<Exclude<VaultStep, "idle">, string> = {
  preparing: "Building the lock transaction…",
  signing: "Confirm the transaction in your wallet…",
  submitting: "Submitting to Cardano…",
};

export interface PowerUpsProps {
  vault: UseVault;
  /** the connected Cardano wallet id (drives lock + stake bind). null in the dev-account edge. */
  walletId: string | null;
  /** identity.bindStake bound-state + action. */
  stake: {
    stakeBound: boolean | null;
    stakeBinding: boolean;
    stakeBindPhase: BindPhase;
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
  /** the timed lock→credit pending state (usePendingCapacity), driven by the persisted pending record. */
  pending: PendingCapacityStatus;
  /** the ss58 whose pending record can be dismissed (an overdue lock that never credits). */
  ss58?: string | null;
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
  pending,
  ss58,
  welcomeBack,
  onGoToTimeline,
  onOpenSettings,
  headingRef,
}: PowerUpsProps) {
  const hasPostingPower = (postingPower ?? 0n) > 0n;

  // Already postable → a done banner + the optional voting boost.
  if (hasPostingPower) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <DoneBanner welcomeBack={welcomeBack} onGoToTimeline={onGoToTimeline} headingRef={headingRef} />
        <div className={styles.cards}>
          <StakeCard stake={stake} walletId={walletId} />
        </div>
        <p className={styles.later}>You can manage voting power anytime in Settings.</p>
      </section>
    );
  }

  // A lock is in flight/crediting → the explained, timed pending state (survives reload / follows the
  // user here from a relock). Reading stays open, so keep the "go to your timeline" invite.
  if (pending.kind !== "none") {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <div className={styles.banner}>
          <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
            {pendingTitle(pending) ?? "Almost there"}
          </h1>
        </div>
        <div className={styles.cards}>
          <PendingCapacityNotice
            status={pending}
            variant="card"
            hideTitle
            onDismiss={ss58 ? () => pendingLockActions.clear(ss58) : undefined}
          />
        </div>
        <button type="button" className={styles.primary} onClick={onGoToTimeline}>
          Go to your timeline
        </button>
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
          You can read right now. To post, lock ADA for posting capacity.
        </p>
      </div>

      <div className={styles.cards}>
        <VaultCard vault={vault} walletId={walletId} onOpenSettings={onOpenSettings} />
        <StakeCard stake={stake} walletId={walletId} />
      </div>

      <p className={styles.later}>You can manage voting power anytime in Settings.</p>

      <button type="button" className={styles.readOnly} onClick={onGoToTimeline}>
        Browse the timeline (read-only)
      </button>
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
      <p className={styles.bannerLede}>You can post, reply, repost, vote, and follow.</p>
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
        <>
          <p className={styles.cardOk}>Locked ✓ — crediting your posting power…</p>
          {vault.txHash && <CardanoTxLink txHash={vault.txHash} label="Lock transaction" />}
        </>
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
        <div className={styles.progress}>
          <StepFlow
            steps={VAULT_STEPS}
            active={VAULT_STEPS.findIndex(
              (s) => s.key === (vault.step === "idle" ? "preparing" : vault.step),
            )}
            ariaLabel="Lock progress"
          />
          <p className={styles.narration} aria-live="polite">
            {VAULT_NARRATION[vault.step === "idle" ? "preparing" : vault.step]}
          </p>
        </div>
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
        <span
          className={styles.optionalChip}
          title="You can post without this. Voting power lets your votes and polls carry weight in Cogno — without it, they count for zero."
        >
          Optional
        </span>
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
            <div className={styles.progress}>
              <StepFlow
                steps={STAKE_STEPS}
                active={STAKE_STEPS.findIndex(
                  (s) => s.key === (stake.stakeBindPhase === "idle" ? "signing" : stake.stakeBindPhase),
                )}
                ariaLabel="Voting-power progress"
              />
              <p className={styles.narration} aria-live="polite">
                {STAKE_NARRATION[stake.stakeBindPhase === "idle" ? "signing" : stake.stakeBindPhase]}
              </p>
            </div>
          )}

          {stake.stakeError && !stake.stakeBinding && (
            <p className={styles.cardError} role="alert">
              {cantStakeSign
                ? "This wallet can't prove its stake. Try Eternl or Lace."
                : `Couldn't add voting power: ${stake.stakeError}`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
