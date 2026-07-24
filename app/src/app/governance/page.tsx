"use client";

// GovernancePage — /governance. A discovery surface for the chain's action-tagged governance polls, so a
// pre-submission Cardano temperature check isn't lost in a busy timeline. A compact, scannable list (NOT a
// full timeline): each row is the action type + the question + the close state + a "you can vote" flag for a
// viewer whose observed role is in a chamber that decides it. Tapping a row opens the poll's detail, where
// the per-chamber readout + the vote controls live.
//
// Reads are public, so this works for a guest (they just funnel to /welcome to cast). Sorted open →
// closed → final; newest-first within each group (from the read). Reach: the Governance nav item in
// LeftNav (desktop/tablet) and the Governance tab in the mobile bottom bar.

import { useMemo } from "react";
import Link from "next/link";
import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { Loading } from "@/components/Loading";
import { ProposalTitle } from "@/components/ProposalTitle";
import { useSession } from "@/components/Providers";
import { useGovernancePolls } from "@/hooks/useGovernancePolls";
import { GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import { eligibleToVote, govCloseState } from "@/lib/chain/governance-feed";
import styles from "./page.module.css";

const STATE_LABEL = { open: "Open", provisional: "Closed", final: "Final" } as const;
const RANK = { open: 0, provisional: 1, final: 2 } as const;

export default function GovernancePage() {
  const { api, viewerRoles, bestBlock } = useSession();
  const { polls, error, reload } = useGovernancePolls(api);

  // Sort open first, then closed-unfinalized, then final; the read already ordered newest-first, and the
  // sort is stable, so that ordering is preserved within each group.
  const sorted = useMemo(() => {
    if (!polls) return [];
    return [...polls].sort(
      (a, b) => RANK[govCloseState(a, bestBlock)] - RANK[govCloseState(b, bestBlock)],
    );
  }, [polls, bestBlock]);

  return (
    <>
      <StickyHeader title="Governance" subtitle="Cardano temperature checks" />

      {polls == null && !error ? (
        <Loading label="Loading governance polls…" />
      ) : error ? (
        <EmptyState
          title="Couldn't load governance polls"
          description="Check your connection and try again."
          action={{ label: "Retry", onClick: reload }}
        />
      ) : sorted.length === 0 ? (
        <EmptyState
          title="No governance polls yet"
          description="Governance polls are pre-submission temperature checks on Cardano governance actions. Tag one when you create a poll."
        />
      ) : (
        <ul className={styles.list}>
          {sorted.map((p) => {
            const state = govCloseState(p, bestBlock);
            const eligible = eligibleToVote(p.actionType, viewerRoles);
            return (
              <li key={p.hostId.toString()}>
                <Link href={`/post/${p.hostId}/`} className={styles.row}>
                  <div className={styles.head}>
                    <span className={styles.action}>{GOV_ACTION_LABEL[p.actionType]}</span>
                    <span className={styles.state} data-state={state}>
                      {STATE_LABEL[state]}
                    </span>
                  </div>
                  {/* The linked proposal's title identifies the row — NOT the poll's raw post text. Fetched
                      at a glance only for neutral hosts (privacy); otherwise a muted default. */}
                  <ProposalTitle anchorUrl={p.anchorUrl} className={styles.question} />
                  {eligible && <span className={styles.eligible}>You can vote</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
