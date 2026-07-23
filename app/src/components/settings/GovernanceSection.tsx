"use client";

// GovernanceSection — Settings "Governance": the mobile reach for the /governance discovery list (the bottom
// bar is a locked set, so it can't live there; desktop/tablet use the LeftNav item). A launcher only — the
// governance polls render on the /governance route, not inline.

import { useRouter } from "next/navigation";
import { EmptyState } from "@/components/EmptyState";

export function GovernanceSection() {
  const router = useRouter();
  return (
    <EmptyState
      title="Governance polls"
      description="Pre-submission temperature checks on Cardano governance actions — the SPO and dRep chambers weigh in against the real CIP-1694 thresholds. Surfaced here so they don't get lost in a busy timeline."
      action={{ label: "Open governance", onClick: () => router.push("/governance/") }}
    />
  );
}
