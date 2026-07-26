// Who runs this deployment, as data rather than as nine string literals scattered through the JSX.
//
// This exists for the same reason lib/cardano/network.ts does: the abuse address, the legal name and
// the age floor are each rendered on more than one surface (/policy, /legal, /privacy, the report
// action in a post's ··· menu, Settings → About), and a contact address that is right on one page and
// stale on another is worse than one that is missing, because a report sent to it is silently lost.
// One constant, every surface.
//
// NOT endpoint-style config. There is deliberately no localStorage override and no NEXT_PUBLIC_ seed:
// the WS endpoint and the Blockfrost id are user-configurable because neutrality requires it, whereas
// "who is legally answerable for this deployment" is a property of the deployment and a visitor must
// not be able to rewrite it in their own browser. A fork changes these values by editing this file,
// which is also the moment they should be thinking about whether the rest of /legal still describes
// them.

/** The legal person operating this deployment. Matches the NOTICE / LICENSE copyright holder. */
export const OPERATOR_LEGAL_NAME = "Logical Mechanism LLC";

/** Where a report of abuse or illegal content goes. Same address as the root POLICY.md. */
export const ABUSE_EMAIL = "support@logicalmechanism.io";

/**
 * Minimum age to use the app.
 *
 * 13 is the conventional floor (it is the line US COPPA draws, and the one most services state). It is
 * stated as a NUMBER rather than baked into prose so /policy and /legal cannot drift apart on it, which
 * is the failure mode that makes an age statement worthless.
 */
export const MIN_AGE = 13;

/** The canonical public source, linked from /legal and /policy. */
export const REPO_URL = "https://github.com/logical-mechanism/cogno";

/**
 * A `mailto:` for a report about one post or account, pre-filled with the permalink so the reporter
 * does not have to construct one and we do not have to ask for it.
 *
 * The body is left short on purpose. A long template reads as a form to be completed, which is enough
 * friction to lose a report that somebody is sending while annoyed; the one thing that is genuinely
 * hard to recover without is the link, and that is filled in already.
 */
export function reportMailto(subject: string, permalink: string): string {
  const body = [
    permalink,
    "",
    "What is wrong with it:",
    "",
  ].join("\n");
  return `mailto:${ABUSE_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
