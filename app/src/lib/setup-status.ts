// setup-status.ts — the SINGLE source of truth for "am I all set, and if not, what's my ONE next
// step?" It collapses the rich SessionState (doc 04 §5) into a plain-language funnel so the nav
// widget, the welcome screen, and Settings all answer the question identically instead of each
// re-interpreting connected/bound/staked on their own.
//
// The ONLY required milestone is the identity bind → read + post, feeless (spec 117: every write is
// feeless + capacity-metered). Locking ADA (posting power, raises the rate limit) and binding stake
// (voting power, weights your votes) are OPTIONAL boosts that never gate participation — they are
// surfaced separately and must never read as required steps.

import type { SessionState } from "./session";

export type SetupPhase = "disconnected" | "connecting" | "unbound" | "binding" | "ready";

/** The single next REQUIRED action toward being able to post (null when ready or mid-flight). */
export type SetupAction =
  | { kind: "connect"; label: string } // open the wallet picker → derive the posting key
  | { kind: "bind"; label: string }; // register the CIP-8 identity

export interface SetupStatus {
  phase: SetupPhase;
  /** true once the required setup is complete — the account can read AND post. */
  ready: boolean;
  /** Short status headline. */
  headline: string;
  /** One plain-language line: what this phase means / what's needed next. */
  detail: string;
  /** The single next REQUIRED action, or null when ready or a step is in flight. */
  next: SetupAction | null;
}

/** Map a SessionState to the one canonical setup status every surface renders from. */
export function setupStatus(state: SessionState): SetupStatus {
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
        headline: "One step left",
        detail: "Register your identity to start posting — it's free and only takes a moment.",
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
      return {
        phase: "ready",
        ready: true,
        headline: "You're all set",
        detail: "You can post, reply, repost, vote, and follow.",
        next: null,
      };
  }
}
