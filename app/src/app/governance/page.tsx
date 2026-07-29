"use client";

// GovernancePage — /governance. A discovery surface for the chain's action-tagged governance polls, so a
// pre-submission Cardano temperature check isn't lost in a busy timeline. A compact, scannable list (NOT a
// full timeline): each row is the action type + the question + the close state + a "you can vote" flag for a
// viewer whose observed role is in a chamber that decides it. Tapping a row opens the poll's detail, where
// the per-chamber readout + the vote controls live.
//
// Threads here are USER-MADE. Anyone can open one about an upcoming or ongoing Cardano action, and several
// can cover the same action, so the list's job is to let the one that took off rise. That is what the four
// axes are for: status, action type, deciding chamber, and order. Every axis lives in the URL, so a
// filtered view is shareable and the back button works.
//
// Reads are public, so this works for a guest (they just funnel to /welcome to cast). Reach: the Governance
// nav item in LeftNav (desktop/tablet) and the Governance tab in the mobile bottom bar.

import { Suspense, useCallback, useMemo } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";
import { Loading } from "@/components/Loading";
import { ProposalTitle } from "@/components/ProposalTitle";
import { GovernanceControls } from "@/components/governance/GovernanceControls";
import { useSession, useBestBlock } from "@/components/Providers";
import { useGovernancePolls } from "@/hooks/useGovernancePolls";
import { GOV_ACTION_LABEL } from "@/lib/cardano/governance";
import { eligibleToVote, govCloseState } from "@/lib/chain/governance-feed";
import { pollClosesIn } from "@/lib/poll";
import { useViewerPollVotes } from "@/hooks/useViewerPollVotes";
import { viewerBucket } from "@/lib/viewerBucket";
import {
  buildGovernanceUrl,
  filterGovPolls,
  govAxesAreDefault,
  parseGovAction,
  parseGovChamber,
  parseGovLens,
  parseGovSort,
  parseGovStatus,
  sortGovPolls,
  type GovAxes,
} from "@/lib/governanceFilters";
import styles from "./page.module.css";

const STATE_LABEL = { open: "Open", provisional: "Closed", final: "Final" } as const;

function GovernanceView() {
  const { api, viewerRoles, viewer } = useSession();
  const bestBlock = useBestBlock();
  const { polls, error, reload } = useGovernancePolls(api);
  const router = useRouter();
  const searchParams = useSearchParams();

  // The URL is the single source of truth for the axes. There is deliberately no stored per-account
  // preference: `buildGovernanceUrl` omits defaults, so a stored sort would re-apply itself to a URL
  // that had just cleared it and the default chip would look dead.
  const axes: GovAxes = useMemo(
    () => ({
      status: parseGovStatus(searchParams.get("t")),
      action: parseGovAction(searchParams.get("a")),
      chamber: parseGovChamber(searchParams.get("c")),
      sort: parseGovSort(searchParams.get("s")),
      lens: parseGovLens(searchParams.get("v")),
    }),
    [searchParams],
  );

  const setAxes = useCallback(
    (next: GovAxes) => router.replace(buildGovernanceUrl(next)),
    [router],
  );

  // The status axis is the only one that needs the chain head, and it is null for a moment on a cold
  // load. Filtering during that window would resolve every unfinalized poll to "open", so a shared
  // `?t=closed` link would paint a false "nothing matches" and then flip. Hold the list instead.
  const awaitingHead = bestBlock == null && axes.status !== "all";

  // Which of these the viewer has already cast in. Read for the WHOLE list rather than the filtered one,
  // so toggling the lens never re-fires it.
  const allIds = useMemo(() => (polls ?? []).map((p) => p.hostId), [polls]);
  // viewerBucket is the one correct "who am I" expression for a viewer-relative chain read.
  const voted = useViewerPollVotes(api, allIds, viewerBucket(viewer));

  const shown = useMemo(() => {
    if (!polls || awaitingHead) return [];
    const filtered = filterGovPolls(polls, axes, bestBlock, { roles: viewerRoles, voted });
    return sortGovPolls(filtered, axes.sort, bestBlock);
  }, [polls, axes, bestBlock, awaitingHead, viewerRoles, voted]);

  const loading = (polls == null || awaitingHead) && !error;

  return (
    <>
      <StickyHeader
        title="Governance"
        subtitle="Cardano temperature checks"
        // Rendered from the first paint, not gated on the read, so the header does not grow by four
        // rows and shove the list down when the polls land.
        tabs={
          <GovernanceControls
            axes={axes}
            onChange={setAxes}
            shown={shown.length}
            total={polls?.length ?? 0}
            hasViewer={viewerRoles != null}
          />
        }
      />

      {loading ? (
        <Loading label="Loading governance polls…" />
      ) : error ? (
        <EmptyState
          title="Couldn't load governance polls"
          description="Check your connection and try again."
          action={{ label: "Retry", onClick: reload }}
        />
      ) : shown.length === 0 ? (
        govAxesAreDefault(axes) ? (
          <EmptyState
            title="No governance polls yet"
            description="Tag a Cardano governance action when you create a poll, and it shows up here."
          />
        ) : (
          <EmptyState
            title="No polls match these filters"
            description="Try a wider set, or clear the filters to see everything."
            // Through the builder, like every other write, so clearing cannot drift from what the
            // default axes actually are.
            action={{
              label: "Clear filters",
              onClick: () => router.replace(buildGovernanceUrl({ ...axes, ...DEFAULTS })),
            }}
          />
        )
      ) : (
        <ul className={styles.list}>
          {shown.map((p) => {
            const state = govCloseState(p, bestBlock);
            const eligible = eligibleToVote(p.actionType, viewerRoles);
            // Sorting puts open polls on top, but "open" spans everything from minutes left to weeks.
            // The countdown is what turns this list into something you act on rather than browse.
            const closesIn = state === "open" ? pollClosesIn(p.closeAt, bestBlock) : null;
            return (
              <li key={p.hostId.toString()}>
                {/* prefetch off: the list renders every open poll on arrival, so the default put each
                    host post id in the relay's access log for a reader who opened none of them. */}
                <Link href={`/post/${p.hostId}/`} className={styles.row} prefetch={false}>
                  <div className={styles.head}>
                    <span className={styles.action}>{GOV_ACTION_LABEL[p.actionType]}</span>
                    <span className={styles.state} data-state={state}>
                      {STATE_LABEL[state]}
                    </span>
                    {closesIn && <span className={styles.closesIn}>closes {closesIn}</span>}
                  </div>
                  {/* The linked proposal's title identifies the row when we can resolve it (neutral hosts
                      only, for privacy); otherwise the poll's own question keeps the row distinguishable. */}
                  <ProposalTitle
                    anchorUrl={p.anchorUrl}
                    fallback={p.question}
                    className={styles.question}
                  />
                  <span className={styles.meta}>
                    {p.replyCount > 0 && (
                      <>
                        {p.replyCount} {p.replyCount === 1 ? "reply" : "replies"}
                      </>
                    )}
                    {eligible && <span className={styles.eligible}>You can vote</span>}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

/** The axes a "Clear filters" returns to. Spread over the current axes so the reset is total. */
const DEFAULTS = { status: "all", action: null, chamber: "all", sort: "latest", lens: "all" } as const;

export default function GovernancePage() {
  // `useSearchParams` must sit under a Suspense boundary for `output: 'export'` to prerender this
  // route. Without it `next build` fails outright, so this wrapper is required rather than stylistic.
  return (
    <Suspense fallback={<Loading label="Loading governance polls…" />}>
      <GovernanceView />
    </Suspense>
  );
}
