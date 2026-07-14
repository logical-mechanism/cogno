// The write-gate session state machine. Pure + testable: derives the single
// SessionState the whole app gates write affordances on, from the two existing hooks' state
// (useSigner + useIdentity). Other docs cite these state names verbatim.
//
// There is NO funded / insufficient-balance state: under spec 117 EVERY write (posts, votes,
// follows, polls AND profile edits) is feeless + capacity-metered. The only gates are
// `bound` (the identity bind) and capacity (surfaced as a rate limit, never a funding wall).

/** The canonical session states (cited by every surface). */
export type SessionState =
  | "disconnected" // no wallet, no dev account chosen        → read-only
  | "connecting" // sign-to-derive in flight
  | "connected_unbound" // posting key derived, NOT identity-bound  → read + can bind, cannot write
  | "binding" // CIP-8 identity bind in flight
  | "bound" // identity-bound                            → full write
  | "bound_no_stake" // bound but no stake credential             → can write; votes carry 0 weight
  | "bound_staked"; // bound + stake credential bound            → votes carry weight

/** The slice of `useSigner` the derivation needs. */
export interface SignerState {
  deriving: boolean;
  postingEnabled: boolean;
  walletConnected: boolean;
}

/** The slice of `useIdentity` the derivation needs. */
export interface IdentityState {
  bound: boolean | null;
  binding: boolean;
  stakeBound: boolean | null;
}

/**
 * Derive the session state. Edge order is load-bearing: deriving → not-enabled → binding →
 * unbound → bound(±stake). `bound === null` (still loading) is treated as not-yet-writable.
 */
export function deriveSessionState(s: SignerState, id: IdentityState): SessionState {
  if (s.deriving) return "connecting";
  if (!s.postingEnabled) return "disconnected";
  if (id.binding) return "binding";
  if (id.bound === false) return "connected_unbound";
  if (id.bound === true) return id.stakeBound ? "bound_staked" : "bound_no_stake";
  return "disconnected"; // bound === null (loading): not yet writable
}


// canWrite() and voteCarriesWeight() lived here and are GONE. Both had zero consumers, and
// voteCarriesWeight was WRONG: it keyed on `state === "bound_staked"`, i.e. the mere PRESENCE of a bound
// stake credential (CognoGate.StakeCredOf). What ships keys on `votingPower > 0n`
// (TalkStake.VotingPower). Those disagree for a stake-bound account with zero observed Cardano stake —
// which is not a corner case but the GUARANTEED state for several blocks after every stake bind, since
// VotingPower is written asynchronously by the cardano-observer inherent. `votingPower > 0n` is the rule;
// it is the one that ships, and it is the one that is right.
