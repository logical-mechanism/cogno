"use client";

// SetupCostNote — what setting up actually costs, said BEFORE anything is spent or signed.
//
// WHY IT EXISTS. The onboarding flow used to disclose the lock at step 4, on the screen that asks for
// it. The screen before that (BindStep) takes the CIP-8 identity bind, which is PERMANENT and is
// labelled as such: "This is permanent. There is no undo." So a user committed irreversibly, in
// public, on the strength of a flow that had not yet mentioned it would then ask them for 100 ADA and
// a wait measured in hours. That ordering is a consent problem, not a conversion problem. It is worth
// losing the people who were never going to lock, at the step where leaving is still free.
//
// TWO PLACEMENTS, ONE SOURCE. `variant="full"` sits under the wallet list on step 1 (before a single
// signature). `variant="brief"` restates it on BindStep, next to the permanence block but visually
// apart from it: that block is about what cannot be undone, and the lock is the one part of setup that
// CAN be (the ADA is refundable, with no timelock and no cooldown). Folding the two together would
// misrepresent both.
//
// "FIRST TIME HERE?" IS A LABEL, NOT A DETECTION, and that is deliberate. Step 1 is also where a
// RETURNING user lands: nothing is stored, so re-deriving the posting key means picking a wallet
// again, and a signup checklist over that reads as "you are making a second account". The obvious fix
// is to detect a returning user from the `cg-session` record and hide this. That detection is wrong in
// both directions: someone who signed out or cleared storage looks new, and worse, a genuine
// first-timer who looks returning would have the price hidden from them, which is the precise failure
// this panel exists to prevent. A heading a returning user can skip past costs nothing and cannot
// misfire, so the panel stays visible for everyone and the heading alone carries who it is for.
//
// THE WAIT IS A CHAIN PARAMETER, NEVER A PHRASE. `useStabilityWindow` reads `StabilitySlots` off the
// observer config: about 10 minutes on preprod, about 36 hours on mainnet. When the read has not
// resolved the sentence is OMITTED rather than guessed — the same rule PowerUps and setup-status
// already follow. A hardcoded "a few minutes" would be a ~200x understatement of the mainnet window,
// which is precisely the number someone is weighing before committing real ADA.

import Link from "next/link";
import { useSession } from "@/components/Providers";
import { useStabilityWindow } from "@/hooks/useStabilityWindow";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/blueprint";
import styles from "./SetupCostNote.module.css";

export function SetupCostNote({ variant = "full" }: { variant?: "full" | "brief" }) {
  const { api } = useSession();
  const stabilityWindow = useStabilityWindow(api);

  const timing = stabilityWindow
    ? `Posting power arrives ${stabilityWindow} after your lock confirms.`
    : "";

  if (variant === "brief") {
    return (
      <div className={styles.brief} role="note">
        <p className={styles.briefLead}>What comes next</p>
        <p className={styles.briefBody}>
          Lock {LOCK_ADA_WHOLE} ADA to earn posting power. Your ADA stays yours and you can take it
          back whenever you want. {timing}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.full}>
      <p className={styles.fullLead}>First time here?</p>
      <ol className={styles.steps}>
        <li>
          <strong>Sign in with your wallet.</strong> Two signatures, no fees.
        </li>
        <li>
          <strong>Lock {LOCK_ADA_WHOLE} ADA on Cardano.</strong> This is a deposit, not a payment. You
          can take it back whenever you want, and it keeps earning your normal staking rewards.
        </li>
        {timing && (
          <li>
            <strong>Wait for it to settle.</strong> {timing}
          </li>
        )}
      </ol>
      <p className={styles.freeNote}>
        Reading is free and always open. You do not need any of this to browse.{" "}
        <Link href="/legal/#cost" className={styles.link}>
          More about the lock
        </Link>
      </p>
    </div>
  );
}

export default SetupCostNote;
