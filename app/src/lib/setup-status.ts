// setup-status.ts — the SINGLE source of truth for "am I able to post, and if not, what's my ONE
// next step?" It collapses the rich SessionState — plus the account's posting power
// (locked-ADA weight) — into a plain-language funnel so any surface that consumes it answers the
// question consistently instead of re-interpreting connected/bound/locked ad hoc. (Today the Settings
// Account card is the consumer; the welcome flow mirrors the same model with its own UI.)
//
// Posting requires ALL THREE gates, in order:
//   1. the CIP-8 identity bind        — the Sybil/identity gate (free, feeless, instant)
//   2. the stake-key bind             — voting power; a MANDATORY onboarding step (feeless, before lock)
//   3. locked ADA → talk-capacity     — the posting gate (capacity = weight·CapRatio; weight 0 ⇒ 0)
// A bound account with ZERO locked ADA has zero talk-capacity, so every post is refused at the pool by
// CheckCapacity (pallet-microblog); an account that has not bound its stake key is treated as setup-
// incomplete and cannot write either. "You can post" (ready) is true only once the account is identity-
// bound AND stake-bound AND posting power > 0. Reading is always open at every phase.
//
// The stake bind is ordered BEFORE the lock because it is feeless and fails fast on wallets that can't
// sign over a reward address (Eternl/Lace can) — so the user learns their wallet can't finish BEFORE
// spending 100 ADA. It was formerly optional; it is now required.

import type { SessionState } from "./session";

export type SetupPhase =
  | "disconnected"
  | "connecting"
  | "unbound"
  | "binding"
  | "needs_voting_power" // bound but stake key not linked — the mandatory voting-power step (before lock)
  | "checking_power"
  | "crediting" // locked ADA, waiting out the observer's stability window before weight is credited
  | "needs_power"
  | "ready";

/** The single next REQUIRED action toward being able to post (null when ready or mid-flight). */
export type SetupAction =
  | { kind: "connect"; label: string } // open the wallet picker → derive the posting key
  | { kind: "bind"; label: string } // register the CIP-8 identity
  | { kind: "stake"; label: string } // bind the stake key (voting power) — mandatory, before the lock
  | { kind: "lock"; label: string }; // lock ADA to earn posting capacity

export interface SetupStatus {
  phase: SetupPhase;
  /** true once ALL required setup is complete — the account can read AND post. */
  ready: boolean;
  /** Short status headline. */
  headline: string;
  /** One plain-language line: what this phase means / what's needed next. */
  detail: string;
  /** The single next REQUIRED action, or null when ready or a step is in flight. */
  next: SetupAction | null;
}

/**
 * Map a SessionState (+ the account's posting power) to the one canonical setup status every surface
 * renders from.
 *
 * `postingPower` is the on-chain `TalkStake.AllowedStake` (lovelace of locked-ADA weight) and is
 * REQUIRED so no caller can accidentally render a "you can post" verdict without checking locked ADA:
 *   - `> 0n`  → can post (all set)
 *   - `0n`    → bound but no posting power yet → the next required step is to lock ADA
 *   - `null`  → still loading → a neutral "checking" state (no false "all set" / "lock now" flash)
 * It is only consulted in the bound states; the pre-bind phases ignore it (pass `null`).
 *
 * `stakeBound` is the on-chain `CognoGate.StakeCredOf` presence (`true` linked / `false` not / `null`
 * loading). Because the stake bind is now a MANDATORY step ordered before the lock, the bound branch
 * checks it first: `false` → the "add voting power" step; `null` → neutral checking (no flash).
 */
export function setupStatus(
  state: SessionState,
  postingPower: bigint | null,
  stakeBound: boolean | null,
  /** a lock is in flight/crediting (usePendingCapacity) — so a bound, zero-power account is WAITING on
   *  its lock, not missing one: show "crediting", not "lock ADA". */
  pending = false,
): SetupStatus {
  switch (state) {
    case "disconnected":
      return {
        phase: "disconnected",
        ready: false,
        headline: "Not connected",
        detail: "Connect a Cardano wallet to post. Reading is always open.",
        next: { kind: "connect", label: "Connect wallet" },
      };
    case "connecting":
      return {
        phase: "connecting",
        ready: false,
        headline: "Connecting…",
        detail: "Approve the signature in your wallet to sign in.",
        next: null,
      };
    case "connected_unbound":
      return {
        phase: "unbound",
        ready: false,
        headline: "Register your account",
        detail: "Register your identity to claim this account.",
        next: { kind: "bind", label: "Finish setup" },
      };
    case "binding":
      return {
        phase: "binding",
        ready: false,
        headline: "Finishing setup…",
        detail: "Registering your identity on the network.",
        next: null,
      };
    case "bound":
    case "bound_no_stake":
    case "bound_staked":
      return boundStatus(stakeBound, postingPower, pending);
  }
}

/**
 * The bound branch: identity is registered (Sybil gate passed), but two required steps remain, in
 * order: (1) bind the stake key (voting power), then (2) lock ADA for talk-capacity. "All set / you can
 * post" is true only once the stake key is linked AND posting power is non-zero.
 */
function boundStatus(
  stakeBound: boolean | null,
  postingPower: bigint | null,
  pending: boolean,
): SetupStatus {
  // Stake read still loading → neutral (never flash "add voting power" before the read resolves).
  if (stakeBound === null) {
    return {
      phase: "checking_power",
      ready: false,
      headline: "Almost there",
      detail: "You're registered. Checking your setup…",
      next: null,
    };
  }
  // Stake key not linked → the mandatory voting-power step, which comes BEFORE the lock.
  if (!stakeBound) {
    return {
      phase: "needs_voting_power",
      ready: false,
      headline: "Add voting power to continue",
      detail: "Prove your wallet's stake to finish setting up your account.",
      next: { kind: "stake", label: "Add voting power" },
    };
  }
  // Stake linked → the posting-power (lock) step.
  // Has posting power → genuinely all set.
  if (postingPower != null && postingPower > 0n) {
    return {
      phase: "ready",
      ready: true,
      headline: "You're all set",
      detail: "You can post, reply, quote, vote, and follow.",
      next: null,
    };
  }
  // Still loading the weight → neutral, no action yet (avoid flashing a wrong verdict either way).
  if (postingPower === null) {
    return {
      phase: "checking_power",
      ready: false,
      headline: "Almost there",
      detail: "You're registered. Checking your posting power…",
      next: null,
    };
  }
  // postingPower === 0n but a lock IS crediting → waiting on the observer, not missing a lock. Don't
  // tell a just-locked user to lock again; there's no action, the wait resolves itself.
  if (pending) {
    return {
      phase: "crediting",
      ready: false,
      headline: "Posting power crediting",
      detail: "Your lock is confirmed on Cardano. Posting unlocks once the chain settles it.",
      next: null,
    };
  }
  // postingPower === 0n → registered but no posting power: the one required step is to lock ADA.
  return {
    phase: "needs_power",
    ready: false,
    headline: "One step left to post",
    detail: "You're registered. Lock ADA to get posting capacity.",
    next: { kind: "lock", label: "Lock ADA" },
  };
}
