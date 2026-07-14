"use client";

// BindStep — Step 3 of onboarding. The REQUIRED identity bind:
// "Register account" → useIdentity.bind(walletId), which signs a CIP-8 self-proof ONCE and submits a
// FEELESS, BARE (unsigned) link_identity_signed extrinsic — no fee, no transaction. On bound===true
// the page auto-advances to power-ups. While binding the CTA is a disabled Spinner + "Approve the
// signature…" narration. On error we surface the inline states with Try again; the
// bound-to-another-account case is a hard danger that does not advance.
//
// Writes are gated on chain readiness: when the chain isn't connected or the boot guard is failing,
// the CTA is disabled with the copy (no honesty framing — just "try again later").

import { useMemo } from "react";
import styles from "./BindStep.module.css";
import { Spinner } from "@/components/icons";
import { StepFlow } from "./StepFlow";
import type { BindPhase } from "@/hooks/useIdentity";

export interface BindStepProps {
  binding: boolean;
  /** the phase of the in-flight bind — drives the background-step indicator. */
  bindPhase: BindPhase;
  /** the LAST bind attempt's error string (useIdentity.error). null when clear. */
  error: string | null;
  /** api && client ready. */
  chainReady: boolean;
  /** boot guard ok (encoding compatible). */
  bootOk: boolean;
  onRegister: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

interface BindError {
  copy: string;
  danger: boolean;
}

// Map the hook's stringified error to the canonical copy. The hook throws specific messages we
// can key on; anything else falls through to the submit-rejected line with the raw reason.
function classifyError(raw: string): BindError {
  const m = raw.toLowerCase();
  if (/declin|cancel|reject.*sign|user.*denied|sign.*declin/.test(m) && !/network/.test(m)) {
    return { copy: "Signature declined. Try again.", danger: false };
  }
  if (/different account|registered to another|refusing to claim|already.*linked/.test(m)) {
    return {
      copy: "That wallet is already linked to a different posting key. Use a different wallet.",
      danger: true,
    };
  }
  if (/could not produce|cip-8|proof|malformed|script payment|extended key|not a 32-byte|exceeds the/.test(m)) {
    return { copy: `Couldn't create the proof: ${raw}`, danger: false };
  }
  if (/still shows your account unbound|didn'?t take|still unbound/.test(m)) {
    return { copy: "Registration didn't take. Try again.", danger: false };
  }
  return { copy: `The network rejected it: ${raw}`, danger: false };
}

// The three background steps a bind actually runs (useIdentity.bind). Surfaced as a live step list so
// the multi-second on-chain wait after signing doesn't read as "stuck".
const BIND_STEPS: { key: Exclude<BindPhase, "idle">; label: string }[] = [
  { key: "signing", label: "Sign in your wallet" },
  { key: "submitting", label: "Submit registration" },
  { key: "confirming", label: "Confirm on-chain" },
];

const BIND_NARRATION: Record<Exclude<BindPhase, "idle">, string> = {
  signing: "Approve the signature in your wallet…",
  submitting: "Submitting your registration to the network…",
  confirming: "Confirming on-chain…",
};

export function BindStep({
  binding,
  bindPhase,
  error,
  chainReady,
  bootOk,
  onRegister,
  headingRef,
}: BindStepProps) {
  const bindError = useMemo(() => (error ? classifyError(error) : null), [error]);

  const disabledReason = !bootOk
    ? "The app needs an update to register. Reading still works."
    : !chainReady
      ? "Connecting to the network…"
      : null;
  const disabled = binding || !!disabledReason;

  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        Register your account
      </h1>

      <p className={styles.body}>
        Register to claim this account. Your wallet signs once to prove it&apos;s yours.
      </p>

      {/* The consent block. Every line below is a property of the chain, not a policy we could soften:
          - the bind is 1:1 and public (CognoGate.PkhOf / AccountOf), and the stake bind that follows
            writes your 28-byte Cardano stake credential in the clear (CognoGate.StakeCredOf);
          - there is no delete_post — Microblog call_index 1 is permanently vacant, content is append-only;
          - there is no user-callable unbind: `revoke` is committee-origin only, and it writes a
            permanent `Tombstoned` entry that `link_identity_signed` then refuses to bind again.
          Do not soften this into a tooltip or a docs link. It is the last screen before it is true. */}
      <div className={styles.consent} role="note">
        <p className={styles.consentLead}>This is permanent. There is no undo.</p>
        <ul className={styles.consentList}>
          <li>
            <strong>Your wallet becomes public.</strong> This account is linked 1:1 to your Cardano
            wallet on-chain, and the stake step that follows publishes your stake credential — from it
            anyone can read the balances, NFTs and staking history behind everything you ever post.
          </li>
          <li>
            <strong>Posts can never be deleted.</strong> Not by you, not by anyone. The chain has no
            delete.
          </li>
          <li>
            <strong>You cannot unregister.</strong> Only the chain&apos;s committee can revoke a
            binding, and a revoked wallet is blocked from ever registering again.
          </li>
        </ul>
      </div>

      <button
        type="button"
        className={styles.primary}
        onClick={onRegister}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        aria-busy={binding || undefined}
        title={disabledReason ?? undefined}
      >
        {binding ? (
          <>
            <Spinner size="sm" /> Registering…
          </>
        ) : (
          "Register account"
        )}
      </button>

      {binding && (
        <div className={styles.progress}>
          <StepFlow
            steps={BIND_STEPS}
            active={BIND_STEPS.findIndex((s) => s.key === (bindPhase === "idle" ? "signing" : bindPhase))}
            ariaLabel="Registration progress"
          />
          <p className={styles.narration} aria-live="polite">
            {BIND_NARRATION[bindPhase === "idle" ? "signing" : bindPhase]}
          </p>
        </div>
      )}

      {disabledReason && !binding && (
        <p className={styles.muted} aria-live="polite">
          {disabledReason}
        </p>
      )}

      {bindError && !binding && (
        <div className={`${styles.errorRow} ${bindError.danger ? styles.danger : ""}`} role="alert">
          <span className={styles.errorMark} aria-hidden>
            ⚠
          </span>
          <span className={styles.errorCopy}>{bindError.copy}</span>
          {!bindError.danger && (
            <button type="button" className={styles.retry} onClick={onRegister} disabled={disabled}>
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}
