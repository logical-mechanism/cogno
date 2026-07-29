// writeAffordance — how a write control (reply, quote, vote, follow, poll) should present itself to
// THIS viewer, in one place, so the four surfaces that render those controls cannot disagree.
//
// THE BUG THIS FIXES. Every one of those surfaces keyed its disabled/tooltip state on
// `gate.status === "not-identity-bound"`. That is one specific mid-signup state, and it misses two
// entire populations who also cannot write:
//
//   1. A SIGNED-OUT GUEST is `"not-connected"`, so Like / Reply / Quote / Follow rendered fully
//      ENABLED, with `title="Upvote"`. A screen reader was told this is an upvote button. It is a
//      sign-in button.
//   2. A BOUND ACCOUNT WITH ZERO LOCKED ADA is `"ready"` — `viewerStatusOf` maps `bound`,
//      `bound_no_stake` and `bound_staked` all to `"ready"` — but `writeReady` is false. Same fully
//      enabled controls, same wrong tooltip. A fix keyed only on `not-connected` leaves half the
//      defect in place, which is why this keys on `writeReady` FIRST.
//
// WHY GUESTS STAY ENABLED. `useAccountVote` argues "the buttons stay enabled: the click is the
// teaching moment", and that survives for a guest: disabling is the worst of both worlds, stripping
// the affordance that makes the product legible while leaving a stranger nothing to click. What did
// NOT survive is the button lying about what it does at rest. So `invite` keeps the control live and
// changes only what it CLAIMS. A viewer who is mid-setup gets `blocked` instead, because for them the
// honest answer is a specific unfinished step, not an invitation.
//
// ACCESSIBILITY RULE FOR `invite`: change `title` only. Keep `aria-label` as the action name and never
// set `aria-disabled` on an enabled button. FollowButton carries a WCAG 2.5.3 Label-in-Name comment
// explaining why its accessible name must keep matching its visible label; this must not break that.

/** The coarse viewer status (components/kit.ts `ViewerStatus`), narrowed to what this needs. */
type Status = "not-connected" | "not-identity-bound" | "ready";

export type AffordanceMode =
  /** All required setup is done. Normal control, normal labels. */
  | "live"
  /** Signed out. Control stays ENABLED and reads as a sign-in prompt. */
  | "invite"
  /** Connected but cannot write yet (unbound, or bound with no posting power). Disabled + a reason. */
  | "blocked";

export interface AffordanceInput {
  status: Status;
  /** `viewer.writeReady` — identity bound AND posting power > 0. */
  writeReady: boolean;
}

/**
 * ORDER IS LOAD-BEARING. `writeReady` is checked before `status`, because `status === "ready"` is true
 * for a bound account with no locked ADA and would otherwise return "live" for someone every write
 * will be refused for.
 */
export function affordanceFor({ status, writeReady }: AffordanceInput): AffordanceMode {
  if (writeReady) return "live";
  if (status === "not-connected") return "invite";
  return "blocked";
}

/** Actions a write control can offer, for wording the `title`. */
export type WriteAction = "reply" | "quote" | "vote" | "follow" | "post";

const VERB: Record<WriteAction, string> = {
  reply: "reply",
  quote: "quote",
  vote: "vote",
  follow: "follow",
  post: "post",
};

/**
 * The `title` for a control in a non-live mode, or undefined when it should carry its normal one.
 *
 * `blocked` deliberately does NOT name the specific missing step (bind vs lock). This function has no
 * way to tell them apart, and guessing wrong is worse than being general: the surfaces that DO know
 * (the welcome flow, NoPostingPowerNotice, setup-status) say it precisely. Plain language, no em
 * dashes, per CLAUDE.md.
 */
export function affordanceTitle(mode: AffordanceMode, action: WriteAction): string | undefined {
  if (mode === "live") return undefined;
  if (mode === "invite") return `Sign in to ${VERB[action]}`;
  return `Finish setup to ${VERB[action]}`;
}
