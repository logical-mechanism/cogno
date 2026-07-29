"use client";

// PowerUps — Step 4 of onboarding. The identity is bound (the Sybil gate). Exactly ONE required step
// remains:
//
//   Lock ADA → talk-capacity. A bound account with zero locked ADA has zero capacity and every post is
//   refused by CheckCapacity, so this is the one thing that is genuinely required to post. After submit
//   the timed PendingCapacityNotice shows the "posting unlocks in ~N min" credit.
//
//   done — posting power > 0 → "You're all set" + "Go to your timeline".
//
// VaultCard — lock ADA into the L1 vault to GET posting capacity (useVault.lock). When no Cardano
//             provider is configured the lock is disabled with a Settings link.
// StakeCard — bind the wallet's stake key to earn vote WEIGHT (useIdentity.bindStake). OPTIONAL, and
//             offered alongside the lock rather than in front of it.
//
// THE STAKE BIND USED TO GATE THIS WHOLE SCREEN, and that was the worst bug in the funnel. It was
// ordered first and hard-blocked on `stakeBound === false`, on the reasoning that it is feeless and
// fails fast, so a wallet that cannot sign over a reward address would find out before spending 100
// ADA. But `link_stake_signed` writes TalkStake::VotingPower and nothing else — the chain never asks
// for it to post. The early return sat ABOVE VaultCard, so such a wallet (Nami and friends) could not
// reach the lock at all, and was permanently unable to post, with a "use a different wallet" dead end
// as its only exit. Both the block and that dead end are gone. Keep them gone.
//
// NO honesty chrome: no battery, no block numbers, no anchor UI, no trust labels.
//

import { useEffect } from "react";
import styles from "./PowerUps.module.css";
import { Spinner } from "@/components/icons";
import { StepFlow } from "./StepFlow";
import { CardanoTxLink } from "@/components/CardanoTxLink";
import { PendingCapacityNotice, pendingTitle } from "@/components/PendingCapacityNotice";
import { pendingLockActions } from "@/lib/pendingLockStore";
import { useSession } from "@/components/Providers";
import { useStabilityWindow } from "@/hooks/useStabilityWindow";
import { formatAda } from "@/lib/format";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/blueprint";
import type { PendingCapacityStatus } from "@/hooks/usePendingCapacity";
import type { ObserverHealth } from "@/lib/chain/observer";
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
  signing: "Approve the signature in your wallet…",
  submitting: "Submitting your voting power…",
  confirming: "Confirming on-chain…",
};

const VAULT_STEPS: { key: Exclude<VaultStep, "idle">; label: string }[] = [
  { key: "preparing", label: "Prepare the transaction" },
  { key: "signing", label: "Sign in your wallet" },
  { key: "submitting", label: "Submit to Cardano" },
];
const VAULT_NARRATION: Record<Exclude<VaultStep, "idle">, string> = {
  preparing: "Preparing the lock transaction…",
  signing: "Approve the transaction in your wallet…",
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
  /**
   * Observer liveness (useObserverHealth). Threaded through because a stalled observer makes every
   * timing claim in the pending notice untrue: the frontier the countdown counts toward is not moving,
   * and a brand-new user watching an ETA expire with nothing happening has no other way to find out.
   */
  observer?: ObserverHealth;
  /** the ss58 whose pending record can be dismissed (an overdue lock that never credits). */
  ss58?: string | null;
  onGoToTimeline: () => void;
  onOpenSettings: () => void;
  /** The user has already dismissed the voting-power step on this device (per account). */
  stakeSkipped?: boolean;
  /** Remember the dismissal, so a 36-hour wait does not re-ask on every reload. */
  onSkipVotingPower: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function PowerUps({
  vault,
  walletId,
  stake,
  postingPower,
  pending,
  observer,
  ss58,
  onGoToTimeline,
  onOpenSettings,
  stakeSkipped = false,
  onSkipVotingPower,
  headingRef,
}: PowerUpsProps) {
  const hasPostingPower = (postingPower ?? 0n) > 0n;
  const stakeBound = stake.stakeBound;

  // ── THE VOTING-POWER STEP ────────────────────────────────────────────────────────────────────
  //
  // Placed AFTER the lock, on purpose, and it is a STEP rather than a card beside another one.
  //
  // Two mistakes to avoid here, and this screen exists because both were made in turn. The first was
  // making it REQUIRED and ordering it first: a wallet that cannot sign over a reward address then hit
  // an early return sitting above VaultCard and could never reach the lock at all. The second was
  // over-correcting into "optional" and parking it as a card next to the lock — which under-sold the
  // thing voting runs on, put two cards under a heading that says "One step left", and left new users
  // sailing past it to cast votes worth nothing.
  //
  // So: not required, but not decoration either. It gets its own screen, with the bind as the primary
  // action and a quiet skip. It lands DURING THE WAIT because that is dead time the user is already
  // sitting in (10 minutes to 36 hours), the bind is feeless and instant, and they have just committed
  // real ADA so they are as invested as they will ever be. Skipping is remembered per account so a
  // 36-hour wait does not re-ask on every reload.
  const showStakeStep = stakeBound === false && !stakeSkipped && (pending.kind !== "none" || hasPostingPower);

  if (showStakeStep) {
    const settling = pending.kind !== "none";
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <div className={styles.banner}>
          <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
            {settling ? "While your lock settles" : "One more thing"}
          </h1>
          <p className={styles.bannerLede}>
            {settling
              ? "Your ADA is on its way. Here is the last piece, and it is free."
              : "You can post now. Here is the last piece, and it is free."}
          </p>
        </div>

        <div className={styles.cards}>
          <StakeCard stake={stake} walletId={walletId} />
          {settling && (
            <PendingCapacityNotice
              status={pending}
              observer={observer}
              variant="card"
              hideTitle
              onDismiss={ss58 ? () => pendingLockActions.clear(ss58) : undefined}
            />
          )}
        </div>

        <button type="button" className={styles.readOnly} onClick={onSkipVotingPower}>
          Skip for now
        </button>
      </section>
    );
  }

  // DONE: posting power > 0, and the voting-power step is either finished or skipped.
  if (hasPostingPower) {
    return (
      <section className={styles.step} aria-labelledby="welcome-heading">
        <DoneBanner onGoToTimeline={onGoToTimeline} headingRef={headingRef} />
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
            {pendingTitle(pending, observer) ?? "Almost there"}
          </h1>
        </div>
        <div className={styles.cards}>
          <PendingCapacityNotice
            status={pending}
            observer={observer}
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

  // THE required step: lock ADA (postingPower === 0n, none pending). ONE card, so the heading is true.
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <div className={styles.banner}>
        <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
          One step left to post
        </h1>
        <p className={styles.bannerLede}>Reading is always open.</p>
      </div>

      <div className={styles.cards}>
        <VaultCard vault={vault} walletId={walletId} onOpenSettings={onOpenSettings} />
      </div>

      <button type="button" className={styles.readOnly} onClick={onGoToTimeline}>
        Browse the timeline
      </button>
    </section>
  );
}

// ── DoneBanner ───────────────────────────────────────────────────────────────────────────────────

function DoneBanner({
  onGoToTimeline,
  headingRef,
}: {
  onGoToTimeline: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}) {
  return (
    <div className={styles.banner}>
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        You&apos;re all set
      </h1>
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
  const { api, boot } = useSession();
  const stabilityWindow = useStabilityWindow(api);

  // Read the vault before offering to lock. This card used to offer one with NO vault read behind it
  // at all: it gated on posting power plus a device-local pending record, so a second device, cleared
  // storage, or a dismissed overdue notice re-armed the Lock button for someone already locked.
  // Settings has always inspected and gated on `lockedKnown`; /welcome is the page new users land on.
  //
  // Gated on `boot` for the same reason Settings is: the vault ADDRESS is built from the Cardano
  // network the chain names, so inspecting before the boot probe settles throws "still connecting",
  // lands in phase="error" — which this card renders ahead of "Already locked" — and, because neither
  // dep moves when the network arrives, never retries. `boot` flips once, when the probe has settled.
  useEffect(() => {
    if (boot && walletId && vault.available) vault.inspect(walletId);
    // `inspect` is a stable useCallback; re-running on every vault change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot, walletId, vault.available]);

  const alreadyLocked = vault.lockedKnown && vault.locked != null && vault.locked > 0n;
  // Never offer a lock we could not verify. `lockedKnown` is false when the provider read failed,
  // which is not the same as "no vault" — see fetchVaultState.
  const canLock = Boolean(walletId) && vault.lockedKnown && !alreadyLocked && !vault.busy;

  const lock = () => {
    if (walletId && canLock) vault.lock(walletId);
  };
  const retry = () => {
    vault.reset();
    if (walletId) vault.inspect(walletId);
  };

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Lock ADA to post</h2>
      <p className={styles.cardBody}>
        Lock {LOCK_ADA_WHOLE} ADA to earn posting power. You can get your ADA back anytime.
        {/* The wait is a chain parameter, not a fixed phrase: ~10 minutes on preprod, ~36 hours at the
            mainnet stability window. Omitted entirely until the read resolves rather than guessed. */}
        {stabilityWindow ? ` Posting power arrives ${stabilityWindow} after your lock confirms.` : ""}
      </p>

      {vault.phase === "submitted" ? (
        <>
          <p className={styles.cardOk}>Locked. Crediting your posting power…</p>
          {vault.txHash && <CardanoTxLink txHash={vault.txHash} label="Lock transaction" />}
        </>
      ) : !vault.available ? (
        <div className={styles.cardActions}>
          <button type="button" className={styles.cardCta} disabled aria-disabled>
            Lock {LOCK_ADA_WHOLE} ADA
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
      ) : alreadyLocked ? (
        <div className={styles.cardActions}>
          <button type="button" className={styles.cardCta} disabled aria-disabled>
            Already locked
          </button>
          <p className={styles.cardNote}>
            You have {formatAda(vault.locked)} locked. Manage it in{" "}
            <button type="button" className={styles.inlineLink} onClick={onOpenSettings}>
              Settings
            </button>
            .
          </p>
        </div>
      ) : (
        <div className={styles.cardRow}>
          <button
            type="button"
            className={styles.cardCta}
            onClick={lock}
            disabled={!canLock}
            aria-busy={vault.busy || undefined}
          >
            {vault.busy ? (
              <>
                <Spinner size="sm" /> Locking…
              </>
            ) : !vault.lockedKnown ? (
              <>
                <Spinner size="sm" /> Checking…
              </>
            ) : (
              `Lock ${LOCK_ADA_WHOLE} ADA`
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
}: {
  stake: PowerUpsProps["stake"];
  walletId: string | null;
}) {
  const add = () => {
    if (walletId) stake.bindStake(walletId);
  };

  // A stake-signing failure (wallet won't sign over a reward address — e.g. Nami) is NOT a block. It
  // used to be, because the step was required and there was no skip, so the only exit offered was
  // "use a different wallet" — which for a user who had already burned the permanent identity bind on
  // this wallet was not an exit at all. The step is optional now, so this states the real consequence
  // (votes weigh nothing) and gets out of the way. Any other error falls through to the generic
  // "couldn't add voting power" retry copy.
  const cantStakeSign =
    !!stake.stakeError &&
    /reward address|stake-sign|no reward|exposes no reward|script stake|cannot prove/i.test(
      stake.stakeError,
    );

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Add voting power (optional)</h2>
      <p className={styles.cardBody}>
        Prove your wallet&apos;s stake so your votes count for more. You can post without this.
      </p>

      {stake.stakeBound === true ? (
        <p className={styles.cardOk}>
          Voting power added.{" "}
          {(stake.votingPower ?? 0n) > 0n
            ? "Your votes now count."
            : "Your votes will carry weight shortly."}
        </p>
      ) : cantStakeSign ? (
        <p className={styles.cardBody} role="status">
          This wallet cannot prove its stake, so your votes will count as one voice. Everything else
          works normally. Eternl and Lace can prove stake if you want vote weight later.
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
