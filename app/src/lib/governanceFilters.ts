// governanceFilters.ts — the axis model behind /governance: which polls a reader is looking at, and in
// what order. Pure and React-free so every rule is unit-tested once and the surface stays presentational.
//
// WHY AXES AT ALL. Cogno's governance threads are USER-MADE. Anyone can open a thread about an upcoming
// or ongoing Cardano action, several threads can cover the same action, and the point of the list is to
// let the one that took off rise. A single hardcoded ordering cannot do that.
//
// THE URL IS THE STATE. Every axis lives in a query param, so a filtered view is shareable and
// bookmarkable and the back button works. There is deliberately no persisted per-account preference:
// the builder omits defaults to keep URLs clean, which means a stored preference would silently
// re-apply itself to a URL that had just cleared it, leaving the default chip looking dead.
//
// The CHAMBER axis is the one dreptalk structurally cannot have, because it only knows dReps. It filters
// by which body DECIDES an action under CIP-1694, via `actionBodies` — the same map that drives the
// tally, so the filter and the readout can never disagree.

import type { GovActionType } from "@/lib/types";
import { GOV_ACTION_LABEL, actionBodies } from "@/lib/cardano/governance";
import { govCloseState, type GovPollSummary } from "@/lib/chain/governance-feed";

// ── axes ─────────────────────────────────────────────────────────────────────────────────────────

export const GOV_STATUSES = ["all", "open", "closed", "final"] as const;
export type GovStatus = (typeof GOV_STATUSES)[number];

export const GOV_CHAMBERS = ["all", "spo", "drep"] as const;
export type GovChamber = (typeof GOV_CHAMBERS)[number];

export const GOV_SORTS = ["latest", "closing", "discussed"] as const;
export type GovSort = (typeof GOV_SORTS)[number];

/**
 * URL slug per CIP-1694 action type. Written out rather than derived from the type name so the slugs are
 * a stable, readable URL contract that renaming a variant cannot silently break.
 */
export const GOV_ACTION_SLUG: Record<GovActionType, string> = {
  Info: "info",
  NoConfidence: "no-confidence",
  UpdateCommittee: "committee",
  NewConstitution: "constitution",
  HardFork: "hard-fork",
  ParamChange: "params",
  TreasuryWithdrawal: "treasury",
};

const ACTION_BY_SLUG = new Map<string, GovActionType>(
  (Object.keys(GOV_ACTION_LABEL) as GovActionType[]).map((t) => [GOV_ACTION_SLUG[t], t]),
);

// ── parsers ──────────────────────────────────────────────────────────────────────────────────────
//
// Every parser is an allowlist that falls back to the default, never a cast. A query string is reader
// input: an unknown token must render the default view, not an empty one.

export function parseGovStatus(raw: string | null | undefined): GovStatus {
  return GOV_STATUSES.includes(raw as GovStatus) ? (raw as GovStatus) : "all";
}

export function parseGovChamber(raw: string | null | undefined): GovChamber {
  return GOV_CHAMBERS.includes(raw as GovChamber) ? (raw as GovChamber) : "all";
}

export function parseGovSort(raw: string | null | undefined): GovSort {
  return GOV_SORTS.includes(raw as GovSort) ? (raw as GovSort) : "latest";
}

/** The action type for a slug, or null for "every type" (the default) and for an unknown slug. */
export function parseGovAction(raw: string | null | undefined): GovActionType | null {
  return (raw && ACTION_BY_SLUG.get(raw)) || null;
}

// ── URL ──────────────────────────────────────────────────────────────────────────────────────────

export interface GovAxes {
  status: GovStatus;
  action: GovActionType | null;
  chamber: GovChamber;
  sort: GovSort;
}

export const GOV_DEFAULT_AXES: GovAxes = {
  status: "all",
  action: null,
  chamber: "all",
  sort: "latest",
};

/** True when nothing is filtered and the order is the default (so "Clear filters" can be hidden). */
export function govAxesAreDefault(a: GovAxes): boolean {
  return (
    a.status === GOV_DEFAULT_AXES.status &&
    a.action === GOV_DEFAULT_AXES.action &&
    a.chamber === GOV_DEFAULT_AXES.chamber &&
    a.sort === GOV_DEFAULT_AXES.sort
  );
}

/**
 * The canonical URL for a set of axes. Defaults are OMITTED, so the unfiltered view is a bare
 * `/governance/` and a shared link carries only what the sharer actually changed.
 *
 * Key order is fixed rather than insertion-ordered so the same view always produces the same string,
 * which is what keeps `router.replace` from churning history on a no-op change.
 */
export function buildGovernanceUrl(a: GovAxes): string {
  const q = new URLSearchParams();
  if (a.status !== GOV_DEFAULT_AXES.status) q.set("t", a.status);
  if (a.action !== null) q.set("a", GOV_ACTION_SLUG[a.action]);
  if (a.chamber !== GOV_DEFAULT_AXES.chamber) q.set("c", a.chamber);
  if (a.sort !== GOV_DEFAULT_AXES.sort) q.set("s", a.sort);
  const s = q.toString();
  return s ? `/governance/?${s}` : "/governance/";
}

// ── filter ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Apply the three filter axes. `bestBlock` is only consulted by the status axis (through the same
 * `govCloseState` the rows render), so a chamber or type filter works before the chain head is known.
 */
export function filterGovPolls(
  polls: readonly GovPollSummary[],
  axes: Pick<GovAxes, "status" | "action" | "chamber">,
  bestBlock: number | null,
): GovPollSummary[] {
  return polls.filter((p) => {
    if (axes.action !== null && p.actionType !== axes.action) return false;
    if (axes.chamber !== "all" && !actionBodies(p.actionType).includes(axes.chamber)) return false;
    if (axes.status !== "all") {
      const state = govCloseState(p, bestBlock);
      const want = axes.status === "closed" ? "provisional" : axes.status;
      if (state !== want) return false;
    }
    return true;
  });
}

// ── sort ─────────────────────────────────────────────────────────────────────────────────────────

/** Newest first. The final tiebreak on every ordering, so a tie can never render differently twice. */
const byIdDesc = (a: GovPollSummary, b: GovPollSummary) => (a.hostId < b.hostId ? 1 : a.hostId > b.hostId ? -1 : 0);

/** Open first, then past-deadline, then finalized. */
const STATE_RANK = { open: 0, provisional: 1, final: 2 } as const;

/**
 * Order a filtered list. Always returns a NEW array.
 *
 * Every ordering keeps the open-first grouping, because a closed poll is not something a reader can act
 * on and promoting one above an open poll would bury the only actionable rows. The sort chooses what
 * happens WITHIN the open group.
 */
export function sortGovPolls(
  polls: readonly GovPollSummary[],
  sort: GovSort,
  bestBlock: number | null,
): GovPollSummary[] {
  const state = new Map(polls.map((p) => [p.hostId, govCloseState(p, bestBlock)]));
  const rank = (p: GovPollSummary) => STATE_RANK[state.get(p.hostId) ?? "open"];

  return [...polls].sort((a, b) => {
    const g = rank(a) - rank(b);
    if (g !== 0) return g;

    if (sort === "closing") {
      // Soonest deadline first, but ONLY inside the open group: for a closed or finalized poll the
      // deadline is in the past, so applying it there would silently flip those sections to oldest
      // first. A floating poll (no deadline) never closes, so it sorts last within its group rather
      // than being coerced to 0 and reading as "closing now".
      if (rank(a) === STATE_RANK.open) {
        const ac = a.closeAt ?? Number.POSITIVE_INFINITY;
        const bc = b.closeAt ?? Number.POSITIVE_INFINITY;
        if (ac !== bc) return ac - bc;
      }
      return byIdDesc(a, b);
    }

    if (sort === "discussed") {
      const d = (b.replyCount ?? 0) - (a.replyCount ?? 0);
      if (d !== 0) return d;
      return byIdDesc(a, b);
    }

    return byIdDesc(a, b);
  });
}
