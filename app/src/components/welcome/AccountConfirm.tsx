"use client";

// AccountConfirm — Step 2 of onboarding. Shows the derived posting account
// the user is about to register: a big identicon Avatar (from signer.ss58), the DisplayName fallback
// + a copyable Handle, and "derived from <wallet>". Primary "Continue" → subStep 'bind'; secondary
// "Use a different wallet" → useSigner.disconnect() (back to Step 1). Display-only, no chain call.

import styles from "./AccountConfirm.module.css";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { Handle } from "@/components/Handle";

export interface AccountConfirmProps {
  ss58: string;
  /** the wallet id the key was derived from (for "derived from <wallet>"). */
  walletName: string;
  onContinue: () => void;
  onUseDifferent: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
}

export function AccountConfirm({
  ss58,
  walletName,
  onContinue,
  onUseDifferent,
  headingRef,
}: AccountConfirmProps) {
  return (
    <section className={styles.step} aria-labelledby="welcome-heading">
      <h1 id="welcome-heading" className={styles.heading} tabIndex={-1} ref={headingRef}>
        This is your account
      </h1>

      <div className={styles.account}>
        <Avatar address={ss58} size="xl" name="Your account avatar" />
        <DisplayName address={ss58} truncate={false} />
        <Handle address={ss58} copyable />
        <p className={styles.derived}>derived from {walletName}</p>
      </div>

      <p className={styles.note}>
        Your posting key was created from your wallet signature.
      </p>

      <button type="button" className={styles.primary} onClick={onContinue}>
        Continue
      </button>
      <button type="button" className={styles.ghost} onClick={onUseDifferent}>
        Use a different wallet
      </button>
    </section>
  );
}
