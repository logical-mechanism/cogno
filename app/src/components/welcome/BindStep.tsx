"use client";

// BindStep — Step 3 of onboarding (surface 11 §3.4 / §7.3 / §14). The REQUIRED identity bind:
// "Register account" → useIdentity.bind(walletId), which signs a CIP-8 self-proof ONCE and submits a
// FEELESS, BARE (unsigned) link_identity_signed extrinsic — no fee, no transaction. On bound===true
// the page auto-advances to power-ups. While binding the CTA is a disabled Spinner + "Approve the
// signature…" narration. On error we surface the §7.3 inline states with Try again; the
// bound-to-another-account case is a hard danger that does not advance.
//
// Writes are gated on chain readiness: when the chain isn't connected or the boot guard is failing,
// the CTA is disabled with the §14 copy (no honesty framing — just "try again later").

import { useMemo } from "react";
import styles from "./BindStep.module.css";
import { Spinner } from "@/components/icons";
import { truncateSs58 } from "@/lib/ss58";

export interface BindStepProps {
  ss58: string;
  binding: boolean;
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

// Map the hook's stringified error to the canonical §14 copy. The hook throws specific messages we
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

export function BindStep({
  ss58,
  binding,
  error,
  chainReady,
  bootOk,
  onRegister,
  headingRef,
}: BindStepProps) {
  const shortHandle = truncateSs58(ss58);
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
        Register <span className={styles.handle}>@{shortHandle}</span> to claim this account. Your
        wallet signs once to prove it&apos;s yours. You&apos;ll add posting power next.
      </p>

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
        <p className={styles.narration} aria-live="polite">
          Approve the signature in your wallet…
        </p>
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
