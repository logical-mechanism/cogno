// setup-status.ts — the SINGLE source of truth for "am I able to post, and if not, what's my ONE
// next step?" It collapses the rich SessionState — plus the account's posting power
// (locked-ADA weight) — into a plain-language funnel so any surface that consumes it answers the
// question consistently instead of re-interpreting connected/bound/locked ad hoc. (Today the Settings
// Account card is the consumer; the welcome flow mirrors the same model with its own UI.)
//
// Posting requires exactly TWO gates, and they are the two the RUNTIME enforces:
//   1. the CIP-8 identity bind        — the Sybil/identity gate (free, feeless, instant).
//                                       pallet-microblog: `IdentityGate::is_allowed` → `NotAllowed`
//   2. locked ADA → talk-capacity     — the posting gate (capacity = weight·CapRatio; weight 0 ⇒ 0).
//                                       `CheckCapacity::validate` → `ExhaustsResources` at the pool
// A bound account with ZERO locked ADA has zero talk-capacity, so every post is refused at the pool.
// "You can post" (ready) is true once the account is identity-bound AND posting power > 0. Reading is
// always open at every phase.
//
// THE STAKE BIND IS NOT ONE OF THESE GATES. `link_stake_signed` writes `TalkStake::VotingPower` and
// nothing else; `CheckCapacity` never reads `StakeCredOf`. It was briefly modelled here as a mandatory
// step ordered before the lock, on the reasoning that it is feeless and fails fast on wallets that
// cannot sign over a reward address, so a user would learn their wallet "can't finish" before spending
// 100 ADA. That reasoning only holds if the step is required — and it is not. What it actually did was
// permanently block every such wallet (Nami and friends) from posting on a step the chain never asks
// for, and, because the welcome flow gated the lock card behind it, from even reaching the lock.
// It is now what it always was on chain: OPTIONAL, and worth exactly vote weight. It is reported here
// as the advisory `votingPowerLinked` flag, never as a `next` action.

import type { SessionState } from "./session";
import { LOCK_ADA_WHOLE } from "./cardano/lockAmount";

export type SetupPhase =
  | "disconnected"
  | "connecting"
  | "unbound"
  | "binding"
  | "checking_power"
  | "crediting" // locked ADA, waiting out the observer's stability window before weight is credited
  | "needs_power"
  | "ready";

/**
 * The single next REQUIRED action toward being able to post (null when ready or mid-flight).
 *
 * There is deliberately no `stake` member. The stake bind is optional and never blocks posting, so it
 * can never be the "one next REQUIRED action"; surfaces render it from `votingPowerLinked` instead.
 */
export type SetupAction =
  | { kind: "connect"; label: string } // open the wallet picker → derive the posting key
  | { kind: "bind"; label: string } // register the CIP-8 identity
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
  /**
   * ADVISORY: is the stake key linked (`CognoGate.StakeCredOf` present)? `null` while the read is in
   * flight. This gates NOTHING. It exists so a surface can offer the optional "add voting power"
   * add-on and explain that votes carry no weight without it. Never let it block a write, and never
   * promote it into `next`.
   */
  votingPowerLinked: boolean | null;
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
 * loading). It is reported straight back out as the advisory `votingPowerLinked` and is NOT consulted
 * for `phase`, `ready` or `next`: the stake bind grants vote weight, never the ability to post.
 */
export function setupStatus(
  state: SessionState,
  postingPower: bigint | null,
  stakeBound: boolean | null,
  /** a lock is in flight/crediting (usePendingCapacity) — so a bound, zero-power account is WAITING on
   *  its lock, not missing one: show "crediting", not "lock ADA". */
  pending = false,
  /** the lock-to-credit wait as copy ("about 36 hours"), read from the chain via useStabilityWindow.
   *  Omitted from the sentence when unknown rather than replaced with a guess — the old hardcoded
   *  "a few minutes" is right on preprod and a ~200x understatement at the mainnet window. */
  creditWindow: string | null = null,
): SetupStatus {
  switch (state) {
    case "disconnected":
      return {
        phase: "disconnected",
        ready: false,
        headline: "Not connected",
        detail: "Connect a Cardano wallet to post.",
        next: { kind: "connect", label: "Connect wallet" },
        votingPowerLinked: stakeBound,
      };
    case "connecting":
      return {
        phase: "connecting",
        ready: false,
        headline: "Connecting…",
        detail: "Approve the signature in your wallet.",
        next: null,
        votingPowerLinked: stakeBound,
      };
    case "connected_unbound":
      return {
        phase: "unbound",
        ready: false,
        headline: "Register your account",
        detail: "Your wallet signs once to prove it's yours.",
        next: { kind: "bind", label: "Finish setup" },
        votingPowerLinked: stakeBound,
      };
    case "binding":
      return {
        phase: "binding",
        ready: false,
        headline: "Finishing setup…",
        detail: "Registering your identity.",
        next: null,
        votingPowerLinked: stakeBound,
      };
    case "bound":
    case "bound_no_stake":
    case "bound_staked":
      return boundStatus(stakeBound, postingPower, pending, creditWindow);
  }
}

/**
 * The bound branch: identity is registered (Sybil gate passed), so exactly ONE required step remains,
 * locking ADA for talk-capacity. "All set / you can post" is true once posting power is non-zero.
 *
 * `stakeBound` is deliberately NOT branched on here. It used to lead this function and short-circuit
 * everything below it, which is what made a wallet that cannot stake-sign unable to reach the lock at
 * all. It now only rides out as `votingPowerLinked`.
 */
function boundStatus(
  stakeBound: boolean | null,
  postingPower: bigint | null,
  pending: boolean,
  creditWindow: string | null,
): SetupStatus {
  // Has posting power → genuinely all set. True with or without a stake bind; a stake-less account
  // posts normally and only its VOTES weigh zero.
  if (postingPower != null && postingPower > 0n) {
    return {
      phase: "ready",
      ready: true,
      headline: "You're all set",
      detail: "You can post, vote, and follow.",
      next: null,
      votingPowerLinked: stakeBound,
    };
  }
  // Still loading the weight → neutral, no action yet (avoid flashing a wrong verdict either way).
  if (postingPower === null) {
    return {
      phase: "checking_power",
      ready: false,
      headline: "Almost there",
      detail: "Checking your posting power…",
      next: null,
      votingPowerLinked: stakeBound,
    };
  }
  // postingPower === 0n but a lock IS crediting → waiting on the observer, not missing a lock. Don't
  // tell a just-locked user to lock again; there's no action, the wait resolves itself.
  if (pending) {
    return {
      phase: "crediting",
      ready: false,
      headline: "Posting power crediting",
      detail: creditWindow
        ? `Lock confirmed on Cardano. Posting unlocks ${creditWindow} after it confirmed.`
        : "Lock confirmed on Cardano. Posting unlocks once the network credits it.",
      next: null,
      votingPowerLinked: stakeBound,
    };
  }
  // postingPower === 0n → registered but no posting power: the one required step is to lock ADA.
  return {
    phase: "needs_power",
    ready: false,
    headline: "One step left to post",
    detail: `Lock ${LOCK_ADA_WHOLE} ADA to get posting power.`,
    next: { kind: "lock", label: "Lock ADA" },
    votingPowerLinked: stakeBound,
  };
}
