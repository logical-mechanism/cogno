// poll.ts — the pure poll-lens + chamber-gate logic shared by the poll surfaces (PollCard / InlinePoll).
//
// A poll's PRIMARY result is read through one LENS. `Stake` and `Governance` polls headline the HOLDER
// lens (each voter's own stake); a single-chamber `Spo` / `Drep` poll instead reads out THAT chamber
// directly (delegated pool / voting stake) as its headline bars — the holder lens is noise there, since
// the whole point is the SPO or dRep temperature check. A `Governance` poll keeps the holder headline and
// shows BOTH chambers as a supplementary block beneath it.
//
// A single-chamber poll is also GATED: only an account that holds that chamber's live Cardano role can
// cast (a non-dRep's vote would never enter the dRep tally, so we block it rather than record a phantom
// vote in the overall count). These helpers are pure so the gate/lens decisions are unit-tested once and
// the components stay presentational.

import type { PollKindName, PollOptionView } from "@/lib/types";
import type { RoleKindType } from "@/lib/chain/roles";
import { SECS_PER_BLOCK } from "@/lib/chain/capacity";

/** Which lens a poll's PRIMARY (headline) result bars read. */
export type PollLens = "holder" | "spo" | "drep";

/**
 * The lens whose tally is the poll's headline bars. A single-chamber poll (`Spo` / `Drep`) reads out that
 * chamber directly; `Stake` and `Governance` keep the holder (own-stake) lens as the headline (a
 * `Governance` poll surfaces both chambers separately, beneath — see {@link showsChamberBlock}).
 */
export function primaryLens(kind: PollKindName): PollLens {
  return kind === "Spo" ? "spo" : kind === "Drep" ? "drep" : "holder";
}

/** Whether a poll renders the supplementary SPO+dRep chamber block beneath its headline. Only a
 *  `Governance` poll does — a single-chamber poll's chamber IS its headline, so re-showing it would be
 *  redundant, and a plain `Stake` poll has no chambers. */
export function showsChamberBlock(kind: PollKindName): boolean {
  return kind === "Governance";
}

/**
 * The observed Cardano role an account MUST hold to cast on a single-chamber poll, or `null` when the poll
 * is open to every bound account (`Stake` / `Governance` — both tally the holder lens, so anyone's own
 * stake counts). `Spo` → the SPO role; `Drep` → the dRep role.
 */
export function chamberRequiredRole(kind: PollKindName): RoleKindType | null {
  return kind === "Spo" ? "Spo" : kind === "Drep" ? "DRep" : null;
}

/** One option's weight under `lens` (chamber weight for spo/drep, holder weight otherwise). */
export function lensWeight(o: PollOptionView, lens: PollLens): bigint {
  return lens === "spo" ? o.spoWeight : lens === "drep" ? o.drepWeight : o.weight;
}

/** One option's distinct-voter count under `lens` (distinct pools / dReps, or holder accounts). */
export function lensCount(o: PollOptionView, lens: PollLens): number {
  return lens === "spo" ? o.spoCount : lens === "drep" ? o.drepCount : o.count;
}

/** The singular noun for one voter in a lens: a pool (SPO), a dRep, or a generic voter (holder). */
export function lensVoterUnit(lens: PollLens): string {
  return lens === "spo" ? "pool" : lens === "drep" ? "dRep" : "voter";
}

/** `n` voters of a lens, pluralized: `1 dRep`, `3 dReps`, `0 pools`, `1 voter`. */
export function lensVoters(n: number, lens: PollLens): string {
  const unit = lensVoterUnit(lens);
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** A short human label for a chamber role, for the gate copy (`Spo` → "SPO", `DRep` → "dRep"). */
export function roleLabel(role: RoleKindType): string {
  return role === "Spo" ? "SPO" : role === "DRep" ? "dRep" : "committee";
}

/**
 * The label of the option at `index`, or null when there is nothing to show.
 *
 * `labels` is in on-chain index order (the runtime documents `PollView.options` that way and `index` as
 * the matching 0-based option index), so array position IS the option index. Null covers all three ways
 * there is no answer: the account has not cast (`index == null`), the poll's options have not loaded or
 * were withheld (empty `labels`), and an index the option list does not reach — the last of which should
 * be unreachable but would otherwise render `undefined` into the page.
 *
 * The label is returned RAW. Sanitizing is display-only and belongs at the render site.
 */
export function pollChoiceLabel(
  labels: readonly string[],
  index: number | null | undefined,
): string | null {
  if (index == null) return null;
  return labels[index] ?? null;
}

/**
 * How long an open poll has left, as a phrase a reader takes in at a glance ("in about 3 hours").
 *
 * A poll's deadline is a BLOCK NUMBER, not a timestamp, so the remaining wall time is the block gap
 * times the runtime's block time — the same conversion `lib/feed/rank.ts` uses for post age. That is
 * why this is approximate and says so: block production is nominal, not guaranteed, so an exact
 * "closes at 14:32" would be a precision the chain does not actually offer.
 *
 * `null` whenever there is nothing truthful to say: a floating poll (no deadline), an unknown head
 * (still connecting), or a deadline already reached — the caller renders its Closed/Final state
 * instead, and a countdown that has run out must never linger next to it.
 *
 * Kept separate from `RateLimitNotice.formatRetry`, which deliberately tops out at hours: a rate-limit
 * wait is always minutes, so days would be dead code there, and a poll deadline is routinely days out.
 */
export function pollClosesIn(
  closeAt: number | undefined,
  bestBlock: number | null,
): string | null {
  if (closeAt == null || bestBlock == null) return null;
  const blocks = closeAt - bestBlock;
  if (blocks <= 0) return null;

  const secs = blocks * SECS_PER_BLOCK;
  if (secs < 60) return "in under a minute";

  const mins = Math.round(secs / 60);
  if (mins < 60) return `in about ${mins} ${mins === 1 ? "minute" : "minutes"}`;

  // Hours stay the unit up to two days, so "in about 30 hours" beats a rounded "in about 1 day" for
  // someone deciding whether to vote tonight or tomorrow.
  const hours = Math.round(mins / 60);
  if (hours < 48) return `in about ${hours} ${hours === 1 ? "hour" : "hours"}`;

  const days = Math.round(hours / 24);
  return `in about ${days} ${days === 1 ? "day" : "days"}`;
}

/**
 * Whether the viewer is BLOCKED from voting on a poll of `kind` because it is a single-chamber poll and
 * they do not hold that chamber's live Cardano role.
 *
 * `viewerRoles === null` (unknown / still loading, or not connected) is fail-OPEN: a member is never
 * wrongly blocked while their roles resolve — only a CONFIRMED non-member (a known role set that lacks the
 * required role) is blocked. An open poll (`Stake` / `Governance`) is never blocked.
 */
export function chamberBlocksViewer(
  kind: PollKindName,
  viewerRoles: readonly RoleKindType[] | null,
): boolean {
  const required = chamberRequiredRole(kind);
  if (required === null) return false; // open poll — no chamber gate
  if (viewerRoles === null) return false; // unknown → fail open (don't block a member mid-load)
  return !viewerRoles.includes(required);
}
