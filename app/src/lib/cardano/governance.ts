// governance.ts — CIP-1694 governance knowledge: which bodies decide each action type, the ratification
// threshold each applies, and the canonical Yes/No/Abstain choice model. A cogno governance poll uses this
// to present a temperature check the way the REAL vote resolves — chamber by chamber, against the real bar —
// instead of a plain opinion poll.
//
// Three deciding bodies:
//  • SPO  — stake-weighted (delegated pool stake). Cogno observes + tallies it (role claims).
//  • dRep — stake-weighted (delegated voting stake). Cogno observes + tallies it.
//  • CC   — the Constitutional Committee. NOT stake-weighted: each member casts one Yes/No against a member
//           QUORUM. Cogno CANNOT observe CC (script hot keys, no CIP-8), so CC is a REFERENCE gate here,
//           never a cogno tally.
//
// Thresholds are Cardano PROTOCOL PARAMETERS (themselves governance-set), read live from Blockfrost when
// available (govParams.ts) and falling back to the shipped snapshot below. A threshold is the fraction of a
// chamber's Yes / (Yes + No) stake — abstain EXCLUDED — required to ratify. This module is pure knowledge
// (no fetch, no DOM), unit-tested once so the components stay presentational.

import type { GovActionType, PollOptionView } from "@/lib/types";

/** Human labels for the seven CIP-1694 governance-action types (the poll tag + the discovery list chip). */
export const GOV_ACTION_LABEL: Record<GovActionType, string> = {
  Info: "Info",
  NoConfidence: "Motion of no-confidence",
  UpdateCommittee: "Update the committee",
  NewConstitution: "New Constitution",
  HardFork: "Hard-fork initiation",
  ParamChange: "Protocol-parameter change",
  TreasuryWithdrawal: "Treasury withdrawal",
};

/** A ratification threshold as a fraction, possibly a RANGE — ParamChange's dRep threshold varies by the
 *  parameter group (network/economic/technical 0.67, governance 0.75) and a poll doesn't pin the group. */
export interface Threshold {
  min: number;
  max: number;
}

/** Conway voting thresholds (fractions 0..1). Keys mirror `PoolVotingThresholds` / `DRepVotingThresholds`. */
export interface VotingThresholds {
  spo: {
    motionNoConfidence: number;
    committeeNormal: number;
    committeeNoConfidence: number;
    hardForkInitiation: number;
    ppSecurityGroup: number;
  };
  drep: {
    motionNoConfidence: number;
    committeeNormal: number;
    committeeNoConfidence: number;
    updateToConstitution: number;
    hardForkInitiation: number;
    ppNetworkGroup: number;
    ppEconomicGroup: number;
    ppTechnicalGroup: number;
    ppGovGroup: number;
    treasuryWithdrawal: number;
  };
}

/** Shipped fallback = current Conway mainnet values, used when the live Blockfrost read is unavailable.
 *  Display-only reference; the live read (govParams.ts) is always preferred. */
export const FALLBACK_THRESHOLDS: VotingThresholds = {
  spo: {
    motionNoConfidence: 0.51,
    committeeNormal: 0.51,
    committeeNoConfidence: 0.51,
    hardForkInitiation: 0.51,
    ppSecurityGroup: 0.51,
  },
  drep: {
    motionNoConfidence: 0.67,
    committeeNormal: 0.67,
    committeeNoConfidence: 0.6,
    updateToConstitution: 0.75,
    hardForkInitiation: 0.6,
    ppNetworkGroup: 0.67,
    ppEconomicGroup: 0.67,
    ppTechnicalGroup: 0.67,
    ppGovGroup: 0.75,
    treasuryWithdrawal: 0.67,
  },
};

// ── Canonical governance choices ─────────────────────────────────────────────────────────────────────
// A governance vote is Yes / No / Abstain. Abstain is EXCLUDED from the ratification ratio (the CIP-1694
// denominator is Yes + No), so the poll options must be canonical for the numbers to be comparable to the
// real vote — the composer locks these for an action-tagged poll.
export const GOV_CHOICES = ["Yes", "No", "Abstain"] as const;

/** Classify a poll option label as a canonical governance choice (case/space-insensitive), or "other". */
export function classifyChoice(label: string): "yes" | "no" | "abstain" | "other" {
  const s = label.trim().toLowerCase();
  if (s === "yes") return "yes";
  if (s === "no") return "no";
  if (s === "abstain") return "abstain";
  return "other";
}

/** The approval ratio Yes / (Yes + No) as a fraction, or null when no Yes/No weight has been cast (abstain
 *  is deliberately not in the denominator, mirroring CIP-1694). */
export function approvalRatio(yesWeight: bigint, noWeight: bigint): number | null {
  const denom = yesWeight + noWeight;
  if (denom <= 0n) return null;
  // Scale to keep precision on large lovelace sums, then to a 0..1 float.
  return Number((yesWeight * 1_000_000n) / denom) / 1_000_000;
}

/** Where a chamber's approval ratio sits relative to its ratification threshold — comparing DISPLAYED
 *  (rounded) percentages so the verdict always matches the shown numbers (an exact 0.505 shown as "51%"
 *  must never read "below 51%").
 *
 *  For a single-value threshold this is a plain meets/below. For a RANGE (ParamChange, whose dRep bar
 *  varies by parameter group and a poll can't pin the group) a ratio inside `[min, max)` is `"partial"` —
 *  it ratifies for SOME groups but not the strictest — reported honestly instead of a flat "meets" against
 *  the range floor (which would over-signal ratification). A null ratio (no Yes/No cast) is `"below"`. */
export function ratificationVerdict(
  ratio: number | null,
  t: Threshold,
): "meets" | "partial" | "below" {
  if (ratio === null) return "below";
  const pr = Math.round(ratio * 100);
  if (pr >= Math.round(t.max * 100)) return "meets"; // clears even the strictest group → truly ratifies
  if (pr < Math.round(t.min * 100)) return "below"; // under the loosest group → clears nothing
  return "partial"; // inside the range → ratifies for some parameter groups, not all
}

/** One chamber's Yes/No/Abstain stake + distinct voter count, folded from the poll options by their
 *  canonical label. `total` = the participating chamber stake (the coverage numerator). */
export interface ChamberVote {
  yes: bigint;
  no: bigint;
  abstain: bigint;
  total: bigint;
  voters: number;
  /**
   * The same Yes/No/Abstain fold by HEAD COUNT rather than stake.
   *
   * Carried because the weighted fold goes blind exactly when a chamber's stake is 0: `approvalRatio` is
   * null, the gauge has nothing to draw, and a readout with only `voters` can say that two dReps voted
   * but not that both voted Yes. Direction is the entire point of a temperature check, and the chain has
   * always known it — the per-option counts were simply summed away here.
   *
   * NOT a substitute for the weighted ratio and never used to draw the bar: a chamber ratifies by stake,
   * so one whale and one dust holder are not "50% Yes". This is only for saying which way the people who
   * turned out actually voted, and it is surfaced when the weighted view cannot speak.
   */
  yesVoters: number;
  noVoters: number;
  abstainVoters: number;
}

/** Fold the poll options into a chamber's Yes/No/Abstain stake + voter count, reading that chamber's lens
 *  (SPO = delegated pool stake, dRep = delegated voting stake). A non-canonical option contributes its
 *  stake to neither Yes nor No (so it can't sway the ratio) but still to `total`/`voters`. */
export function chamberVote(options: PollOptionView[], body: "spo" | "drep"): ChamberVote {
  const w = (o: PollOptionView) => (body === "spo" ? o.spoWeight : o.drepWeight);
  const c = (o: PollOptionView) => (body === "spo" ? o.spoCount : o.drepCount);
  let yes = 0n;
  let no = 0n;
  let abstain = 0n;
  let total = 0n;
  let voters = 0;
  let yesVoters = 0;
  let noVoters = 0;
  let abstainVoters = 0;
  for (const o of options) {
    const weight = w(o);
    const count = c(o);
    total += weight;
    voters += count;
    const cls = classifyChoice(o.label);
    if (cls === "yes") {
      yes += weight;
      yesVoters += count;
    } else if (cls === "no") {
      no += weight;
      noVoters += count;
    } else if (cls === "abstain") {
      abstain += weight;
      abstainVoters += count;
    }
  }
  return { yes, no, abstain, total, voters, yesVoters, noVoters, abstainVoters };
}

/** The canonical buckets that actually drew a voter, in CIP-1694 order (the order the option rows use). */
function occupiedBuckets(v: ChamberVote): [string, number][] {
  return (
    [
      ["Yes", v.yesVoters],
      ["No", v.noVoters],
      ["Abstain", v.abstainVoters],
    ] as [string, number][]
  ).filter(([, n]) => n > 0);
}

/**
 * The single choice EVERY voter in this chamber made ("Yes"), or null when they split, nobody voted, or
 * they all picked non-canonical options.
 *
 * Split from {@link countDirection} because the two belong in different sentences. A unanimous chamber
 * reads as a phrase — "1 dRep voted Yes" — where pasting the tally in would give the redundant "1 dRep
 * voted 1 Yes". A split chamber has no such phrase and needs the tally instead.
 */
export function unanimousChoice(v: ChamberVote): string | null {
  const buckets = occupiedBuckets(v);
  return buckets.length === 1 ? buckets[0][0] : null;
}

/**
 * Which way the members who turned out voted, BY HEAD COUNT — "2 Yes, 1 No" — or null when they did not
 * split (a unanimous chamber is said as a phrase, see {@link unanimousChoice}) or nobody voted.
 *
 * Exists for the case the weighted readout cannot cover: a chamber with voters and no counted stake has
 * no ratio, so without this the surface can report that somebody voted but never which way. Empty
 * buckets are omitted, so nothing ever reads "2 Yes, 0 No, 0 Abstain".
 */
export function countDirection(v: ChamberVote): string | null {
  const buckets = occupiedBuckets(v);
  return buckets.length > 1 ? buckets.map(([k, n]) => `${n} ${k}`).join(", ") : null;
}

// ── Deciding bodies per action type ──────────────────────────────────────────────────────────────────

const one = (n: number): Threshold => ({ min: n, max: n });
const spread = (...ns: number[]): Threshold => ({ min: Math.min(...ns), max: Math.max(...ns) });

/** One cogno-tallied (stake) chamber for an action: which body + the threshold to mark (null for an Info
 *  action, which has no ratification bar). */
export interface TalliedChamber {
  body: "spo" | "drep";
  threshold: Threshold | null;
}

/** The stake chambers cogno tallies for an action type. `advisory` (Info) = the bodies vote but nothing
 *  ratifies, so no threshold bar is drawn. */
export interface GovChambers {
  tallied: TalliedChamber[];
  advisory: boolean;
}

/**
 * The stake chambers cogno tallies for `action`, each with its ratification threshold resolved from `t`.
 * Encodes CIP-1694: SPOs do NOT vote on NewConstitution / TreasuryWithdrawal / non-security ParamChange, so
 * those surface the dRep chamber only; Info is advisory (no threshold). (The Constitutional Committee also
 * ratifies every action except NoConfidence / UpdateCommittee, but cogno can't observe it, so it is not
 * surfaced here.)
 */
export function actionChambers(action: GovActionType, t: VotingThresholds): GovChambers {
  const spo = (thr: Threshold | null): TalliedChamber => ({ body: "spo", threshold: thr });
  const drep = (thr: Threshold | null): TalliedChamber => ({ body: "drep", threshold: thr });
  switch (action) {
    case "Info":
      return { tallied: [spo(null), drep(null)], advisory: true };
    case "NoConfidence":
      return {
        tallied: [spo(one(t.spo.motionNoConfidence)), drep(one(t.drep.motionNoConfidence))],
        advisory: false,
      };
    case "UpdateCommittee":
      return {
        tallied: [spo(one(t.spo.committeeNormal)), drep(one(t.drep.committeeNormal))],
        advisory: false,
      };
    case "NewConstitution":
      return { tallied: [drep(one(t.drep.updateToConstitution))], advisory: false };
    case "HardFork":
      return {
        tallied: [spo(one(t.spo.hardForkInitiation)), drep(one(t.drep.hardForkInitiation))],
        advisory: false,
      };
    case "ParamChange":
      // The dRep threshold varies by parameter group (network/economic/technical/governance) and a poll
      // can't pin the group, so show the full span across ALL four — not just network..gov.
      return {
        tallied: [
          drep(
            spread(
              t.drep.ppNetworkGroup,
              t.drep.ppEconomicGroup,
              t.drep.ppTechnicalGroup,
              t.drep.ppGovGroup,
            ),
          ),
        ],
        advisory: false,
      };
    case "TreasuryWithdrawal":
      return { tallied: [drep(one(t.drep.treasuryWithdrawal))], advisory: false };
  }
}

/** The stake bodies (SPO / dRep) cogno tallies for an action — threshold-independent, for eligibility /
 *  discovery ("can this viewer vote?"). Same list `actionChambers` produces, without needing thresholds. */
export function actionBodies(action: GovActionType): ("spo" | "drep")[] {
  return actionChambers(action, FALLBACK_THRESHOLDS).tallied.map((c) => c.body);
}

/**
 * The poll KIND the composer stores so the backend tallies exactly the stake chambers this action needs:
 * `Governance` (SPO + dRep) for the actions both stake bodies decide, `Drep` for the dRep-led ones. (No
 * action is SPO-only, and CC is never backend-tallied.)
 */
export function actionKind(action: GovActionType): "Governance" | "Drep" {
  switch (action) {
    case "Info":
    case "NoConfidence":
    case "UpdateCommittee":
    case "HardFork":
      return "Governance";
    case "NewConstitution":
    case "ParamChange":
    case "TreasuryWithdrawal":
      return "Drep";
  }
}
