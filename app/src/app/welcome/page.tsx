"use client";

// WelcomePage — /welcome (doc 01 §1, surface 11). STUB: the connect → derive → CIP-8 bind stepper is
// surface 11. The foundation mounts the shell + a placeholder; the write-intent gate routes unbound
// users here. Surface 11 wires ConnectWalletButton + the bind stepper.

import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

export default function WelcomePage() {
  return (
    <>
      <StickyHeader title="Welcome" />
      <EmptyState
        title="Welcome to cogno-chain"
        description="Connect a Cardano wallet to start posting. The full onboarding lands here."
      />
    </>
  );
}
