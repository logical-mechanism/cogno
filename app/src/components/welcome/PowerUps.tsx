"use client";

// PowerUps — Step 4 of onboarding. The identity is bound (the Sybil
// gate). Two REQUIRED steps remain, in order, and neither is skippable:
//
//   1. Add voting power (bind the stake key). Mandatory and shown FIRST — it is feeless and fails fast
//      on a wallet that can't sign over its reward address (Eternl/Lace can), so the user learns their
//      wallet can't finish BEFORE locking 100 ADA. On that failure the card hard-blocks with a "use a
//      different wallet" affordance (disconnect → wallet picker). Reading stays open (read-only escape).
//   2. Lock 100 ADA → talk-capacity. Shown only once the stake key is bound. A bound account with zero
//      locked ADA has zero capacity and every post is refused by CheckCapacity, so this is required to
//      post. After submit the timed PendingCapacityNotice shows the "posting unlocks in ~N min" credit.
//
//   done — stake bound AND posting power > 0 → "You're all set" + "Go to your timeline".
//
// VaultCard — lock 100 ADA into the L1 vault to GET posting capacity (useVault.lock). When no Cardano
//             provider is configured the lock is disabled with a Settings link.
// StakeCard — bind the wallet's stake key to earn voting weight (useIdentity.bindStake). REQUIRED; a
//             wallet that can't sign over a reward address hard-blocks with "use a different wallet".
//
// NO honesty chrome: no battery, no block numbers, no anchor UI, no trust labels.
//

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
  /** Disconnect and return to the wallet picker — the escape when the wallet can't sign its stake. */
  onUseDifferentWallet: () => void;
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
  onUseDifferentWallet,
  headingRef,
}: PowerUpsProps) {
  const hasPostingPower = (postingPower ?? 0n) > 0n;
  const stakeBound = stake.stakeBound;

  // DONE: both mandatory steps complete (stake bound + posting power). No StakeCard — stake is already
  // linked; just the "you're all set" banner.
  if (stakeBound === true && hasPostingPower) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <DoneBanner welcomeBack={welcomeBack} onGoToTimeline={onGoToTimeline} headingRef={headingRef} />
      </section>
    );
  }

  // Stake read still loading → neutral "checking" (a returning stake-bound user never flashes the
  // stake step before the read resolves).
  if (stakeBound === null) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <div className={styles.banner}>
          <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
            Almost there
          </h1>
          <p className={styles.bannerLede} aria-live="polite">
            Checking your setup…
          </p>
        </div>
      </section>
    );
  }

  // STEP 1 (mandatory, first): bind the stake key. Ordered before the lock so a wallet that can't sign
  // over its reward address is caught BEFORE 100 ADA is locked. No skip. Reading stays open.
  if (stakeBound === false) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <div className={styles.banner}>
          <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
            Add voting power to continue
          </h1>
          <p className={styles.bannerLede}>
            Prove your wallet&apos;s stake to finish setting up. It&apos;s required, and comes before
            locking ADA.
          </p>
        </div>

        <div className={styles.cards}>
          <StakeCard stake={stake} walletId={walletId} onUseDifferentWallet={onUseDifferentWallet} />
        </div>

        <button type="button" className={styles.readOnly} onClick={onGoToTimeline}>
          Browse the timeline (read-only)
        </button>
      </section>
    );
  }

  // Stake bound from here on. STEP 2 is the lock.
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

  // STEP 2 (mandatory): lock ADA (stake bound, postingPower === 0n, none pending). Reading stays open.
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
      </div>

      <button type="button" className={styles.readOnly} onClick={onGoToTimeline}>
        Browse the timeline (read-only)
      </button>
    </section>
  );
}

// ── DoneBanner ───────────────────────────────────────────────────────────────────────────────────

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
      <p className={styles.bannerLede}>You can post, reply, quote, vote, and follow.</p>
      <button type="button" className={styles.primary} onClick={onGoToTimeline}>
        Go to your timeline
      </button>
    </div>
  );
}

// ── VaultCard ────────────────────────────────────────────────────────────────────────────────────

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
      <h2 className={styles.cardTitle}>Lock ADA to post</h2>
      <p className={styles.cardBody}>
        Lock 100 ADA in the vault to get posting capacity. You can unlock it anytime.
      </p>

      {vault.phase === "submitted" ? (
        <>
          <p className={styles.cardOk}>Locked ✓. Crediting your posting power…</p>
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

// ── StakeCard ────────────────────────────────────────────────────────────────────────────────────

function StakeCard({
  stake,
  walletId,
  onUseDifferentWallet,
}: {
  stake: PowerUpsProps["stake"];
  walletId: string | null;
  onUseDifferentWallet: () => void;
}) {
  const add = () => {
    if (walletId) stake.bindStake(walletId);
  };

  // A stake-signing failure (wallet won't sign over a reward address — e.g. Nami) is a HARD block now
  // that the step is required: there is no "skip", so guide the user to reconnect with a stake-signing
  // wallet. Any other error falls through to the generic "couldn't add voting power" retry copy.
  const cantStakeSign =
    !!stake.stakeError &&
    /reward address|stake-sign|no reward|exposes no reward|script stake|cannot prove/i.test(
      stake.stakeError,
    );

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Add voting power</h2>
      <p className={styles.cardBody}>
        Prove your wallet&apos;s stake so your votes carry weight. This is required to finish setting up.
      </p>

      {stake.stakeBound === true ? (
        <p className={styles.cardOk}>
          Voting power added.{" "}
          {(stake.votingPower ?? 0n) > 0n
            ? "Your votes now count."
            : "Your votes will carry weight shortly."}
        </p>
      ) : cantStakeSign ? (
        <div className={styles.cardActions}>
          <p className={styles.cardError} role="alert">
            This wallet can&apos;t prove its stake. Reconnect with Eternl or Lace to finish setting up.
          </p>
          <div className={styles.cardRow}>
            <button type="button" className={styles.cardCta} onClick={onUseDifferentWallet}>
              Use a different wallet
            </button>
          </div>
        </div>
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
              Couldn&apos;t add voting power: {stake.stakeError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
