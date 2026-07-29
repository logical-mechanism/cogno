"use client";

// ConnectWalletButton — the LeftNav entry into onboarding. Label/target derive from `viewer.status`:
//   not-connected      → "Sign in"      → /welcome (step 1 is the wallet picker)
//   not-identity-bound → "Finish setup" → /welcome (resumes at the bind step)
//   ready              → renders NOTHING (the LeftNav shows the account chip instead)
//
// IT USED TO OPEN ITS OWN INLINE WALLET PICKER, and that was a second door onto the same first step.
// Both doors listed the same `listCardanoWallets()` and ran the same `connectWallet()` derive; the
// difference was only where you landed. This one dropped you back on the timeline as
// `connected_unbound`, having spent a wallet signature, with every write control now reading "Finish
// setup" and this button relabelled to the same thing. The only move left was to press it again and go
// where the other door went directly. Three things were wrong with that:
//
//   • It ended in a state where nothing worked, as the outcome of a first interaction.
//   • It bypassed the cost disclosure. `SetupCostNote` lives in /welcome's WalletPicker, so a desktop
//     user signing here never saw what setup costs before committing — the exact consent gap that
//     panel exists to close, left open on one of the two paths.
//   • It was DESKTOP ONLY (Account.module.css hides this pill at ≤1019px, and mobile has no LeftNav),
//     so tablet and mobile users already had exactly one door. This makes desktop match them.
//
// "Connect wallet" went with the popover. In most of web3 that phrase means the whole auth; here it
// meant step 1 of 4, and naming a partial step like a complete one is a good part of why a new user
// could not tell the two buttons apart. Reading always works unauthenticated, so neither label is a
// wall — it is an invitation.

import styles from "./ConnectWalletButton.module.css";
import type { ControlSize, Viewer } from "./kit";

export interface ConnectWalletButtonProps {
  viewer: Viewer;
  /** Open onboarding (/welcome). It resolves its own step from session state, so one target serves both. */
  onStart?: () => void;
  size?: ControlSize;
}

export function ConnectWalletButton({ viewer, onStart, size = "md" }: ConnectWalletButtonProps) {
  if (viewer.status === "ready") return null;

  const cls = [styles.btn, size === "sm" ? styles.sm : styles.md].join(" ");
  // Connected but not bound → they are mid-flow, so name the resumption rather than re-inviting them.
  const label = viewer.status === "not-identity-bound" ? "Finish setup" : "Sign in";

  return (
    <button type="button" className={cls} onClick={onStart}>
      {label}
    </button>
  );
}
