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

/** One chamber's Yes/No/Abstain stake + distinct voter count, folded from the poll options by their
 *  canonical label. `total` = the participating chamber stake (the coverage numerator). */
export interface ChamberVote {
  yes: bigint;
  no: bigint;
  abstain: bigint;
  total: bigint;
  voters: number;
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
  for (const o of options) {
    const weight = w(o);
    total += weight;
    voters += c(o);
    const cls = classifyChoice(o.label);
    if (cls === "yes") yes += weight;
    else if (cls === "no") no += weight;
    else if (cls === "abstain") abstain += weight;
  }
  return { yes, no, abstain, total, voters };
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
