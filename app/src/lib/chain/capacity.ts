// Client-side talk-capacity replay (L5 §8.5 / L4 §5.2).
//
// ⛔ ADVISORY ONLY. The authoritative gate is the runtime's `CheckCapacity::validate()`
// (pallet-microblog §5). This replays `current_capacity()` VERBATIM so the battery and the
// composer can show honest, live estimates — never to decide truth. All constants are read
// from PAPI metadata (`api.constants.Microblog.*`), never hardcoded, so a `spec_version` bump
// that retunes capacity retunes the UI too (fail-closed on a missing constant).

import type { CognoApi, Ss58 } from "@/lib/types";

/** Capacity constants, read from runtime metadata (all micro-capacity units / lovelace). */
export interface CapacityConsts {
  capRatio: bigint;
  regenPerBlock: bigint;
  ceiling: bigint;
  baseCost: bigint;
  perByteCost: bigint;
}

/** The lazy token-bucket row (`Microblog.Capacity`), or null for a never-bound account. */
export interface CapacityBucket {
  capLast: bigint;
  lastBlock: number;
}

/** Inputs the replay needs for one account. */
export interface CapacityInputs {
  weight: bigint; // TalkStake.AllowedStake (0 if unbound/unlocked)
  bucket: CapacityBucket | null; // Microblog.Capacity (null = first-touch)
}

/** A computed, point-in-time capacity view for rendering. */
export interface CapacityView {
  weight: bigint;
  bucket: CapacityBucket | null;
  /** capped-linear ceiling: min(weight·capRatio, ceiling). */
  cap: bigint;
  /** regenerated capacity available *as of* `at`. */
  have: bigint;
  /** regeneration per block: weight·regenPerBlock. */
  ratePerBlock: bigint;
  /** the block this view reflects. */
  at: number;
}

/** Read the capacity constants from metadata. Throws if any are missing (fail-closed). */
export async function readCapacityConsts(api: CognoApi): Promise<CapacityConsts> {
  const [capRatio, regenPerBlock, ceiling, baseCost, perByteCost] = await Promise.all([
    api.constants.Microblog.CapRatio(),
    api.constants.Microblog.RegenPerBlock(),
    api.constants.Microblog.Ceiling(),
    api.constants.Microblog.BaseCost(),
    api.constants.Microblog.PerByteCost(),
  ]);
  return { capRatio, regenPerBlock, ceiling, baseCost, perByteCost };
}

/** Read the live capacity inputs for one account. */
export async function readCapacityInputs(api: CognoApi, who: Ss58): Promise<CapacityInputs> {
  const [weight, row] = await Promise.all([
    api.query.TalkStake.AllowedStake.getValue(who),
    api.query.Microblog.Capacity.getValue(who),
  ]);
  return {
    weight: weight ?? 0n,
    bucket: row ? { capLast: row.cap_last, lastBlock: row.last_block } : null,
  };
}

/** The capped-linear cap for a weight: `min(weight·capRatio, ceiling)`. */
export function capOf(weight: bigint, K: CapacityConsts): bigint {
  const linear = weight * K.capRatio;
  return linear < K.ceiling ? linear : K.ceiling;
}

/** The capacity cost of a post of `byteLen` bytes: `baseCost + perByteCost·len`. */
export function postCost(byteLen: number, K: CapacityConsts): bigint {
  return K.baseCost + K.perByteCost * BigInt(byteLen);
}

/**
 * `current_capacity()` replayed VERBATIM (pallet-microblog `current_capacity`):
 *   cap  = min(weight·capRatio, ceiling)
 *   None ⇒ 0 (first-touch is EMPTY, not full)
 *   else min(cap, cap_last + weight·regenPerBlock·elapsed)
 * All bigint + clamped, matching the runtime's saturating arithmetic.
 */
export function currentCapacity(inputs: CapacityInputs, at: number, K: CapacityConsts): bigint {
  const cap = capOf(inputs.weight, K);
  if (!inputs.bucket) return 0n; // ⛔ None ⇒ 0, NOT cap
  const elapsed = BigInt(Math.max(0, at - inputs.bucket.lastBlock));
  const filled = inputs.bucket.capLast + inputs.weight * K.regenPerBlock * elapsed;
  return filled < cap ? filled : cap;
}

/** Build a full view for rendering. */
export function computeView(inputs: CapacityInputs, at: number, K: CapacityConsts): CapacityView {
  return {
    weight: inputs.weight,
    bucket: inputs.bucket,
    cap: capOf(inputs.weight, K),
    have: currentCapacity(inputs, at, K),
    ratePerBlock: inputs.weight * K.regenPerBlock,
    at,
  };
}

/** Whether (and when) a draft of `byteLen` bytes can be posted. Edge order is load-bearing. */
export type DraftStatus =
  | { kind: "ok"; have: bigint; need: bigint }
  | { kind: "no_weight"; need: bigint } // weight 0 → needs an operator grant (dev) / locked ADA (prod)
  | { kind: "too_long"; need: bigint; cap: bigint } // need > cap → never postable at this length
  | { kind: "charging"; have: bigint; need: bigint; blocks: number } // first-touch, regenerating from 0
  | { kind: "wait"; have: bigint; need: bigint; blocks: number }; // under budget; postable in N blocks

/**
 * Classify a draft against a view. ⛔ Order matters (L5 §8.5): check weight==0 first (never a
 * timer), then need>cap (never at this length), then guard rate==0 BEFORE the ceil-division.
 */
/**
 * Block time. The runtime's `MILLI_SECS_PER_BLOCK` is 6000, and the whole app already assumes it —
 * PostTime renders a post's age as `(best − at) × 6s`. Shared from here because this module is where
 * "how long until I can post" is computed, and a countdown that disagreed with the age stamps would be
 * a visible contradiction.
 */
export const SECS_PER_BLOCK = 6;

export function draftStatus(view: CapacityView, byteLen: number, K: CapacityConsts): DraftStatus {
  const need = postCost(byteLen, K);
  if (view.weight === 0n) return { kind: "no_weight", need }; // ⛔ no timer — needs weight
  if (need > view.cap) return { kind: "too_long", need, cap: view.cap }; // ⛔ never at this length
  if (view.have >= need) return { kind: "ok", have: view.have, need };
  const rate = view.ratePerBlock;
  if (rate === 0n) return { kind: "no_weight", need }; // ⛔ guard /0n
  const blocks = Number((need - view.have + rate - 1n) / rate); // ceil-div, rate>0 guaranteed
  return view.bucket
    ? { kind: "wait", have: view.have, need, blocks }
    : { kind: "charging", have: view.have, need, blocks };
}

/** Whole-post headroom (for segment counts / "N posts" copy). */
export function postsOf(amount: bigint, K: CapacityConsts): number {
  if (K.baseCost === 0n) return 0;
  return Number(amount / K.baseCost);
}
