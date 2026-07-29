"use client";

// SignInSheet — the in-place answer to a write a viewer cannot make yet.
//
// Mounted ONCE, in AppShell, beside ModalRouteHost. It opens over the current surface rather than
// navigating, so <main> stays mounted and the reader keeps their feed, their scroll and their place.
// See lib/signInPromptStore for why it does not replay the action afterwards.
//
// IT BRANCHES ON THE REAL SESSION STATE, because "you can't do that" has four different honest
// answers and the old blanket redirect to /welcome gave one:
//
//   not-connected       → they have done nothing yet. Name the price here, before they invest, and
//                         send them to /welcome.
//   not-identity-bound  → mid-signup, one step in. Resume, do not restart.
//   ready + !writeReady → bound but no posting power. The lock is the missing piece, and if one is
//                         already settling the honest answer is "wait", not "go lock again" — so this
//                         reads `setupStatus`, the same funnel the Settings card and /welcome use,
//                         rather than inventing a fifth opinion about what is missing.
//
// The focus trap is copied from ConfirmDialog on purpose: aria-modal alone does not stop Tab escaping
// to the obscured page behind the scrim, and that file's comment says so.

import { useCallback, useEffect, useRef } from "react";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { useRouter } from "next/navigation";
import styles from "./SignInSheet.module.css";
import { useSession } from "@/components/Providers";
import { useSignInPrompt, signInPromptActions, type SignInReason } from "@/lib/signInPromptStore";
import { usePendingCapacity } from "@/hooks/usePendingCapacity";
import { useStabilityWindow } from "@/hooks/useStabilityWindow";
import { setupStatus } from "@/lib/setup-status";
import { viewerBucket } from "@/lib/viewerBucket";
import { LOCK_ADA_WHOLE } from "@/lib/cardano/lockAmount";

/** What they reached for, in the second person, so the heading names it. */
const REASON_TITLE: Record<SignInReason, string> = {
  post: "Sign in to post",
  reply: "Sign in to reply",
  quote: "Sign in to quote",
  vote: "Sign in to vote",
  follow: "Sign in to follow",
};

export function SignInSheet() {
  const { open, reason } = useSignInPrompt();
  const router = useRouter();
  const { api, viewer, sessionState, votingPower, postingPower } = useSession();
  const stabilityWindow = useStabilityWindow(api);
  // `open ? api : null`, and the REAL posting power rather than a hardcoded null. This component is
  // mounted once in AppShell and lives on every route, so both arguments matter:
  //
  //   • Passing `api` unconditionally opened a `LastReference` watch, an `EnforceWeight` watch and a
  //     1 s ticker on every surface for anyone holding a pending-lock record, alongside the identical
  //     pair NoPostingPowerNotice opens inside each composer. A closed sheet has nothing to narrate;
  //     null-api parks the hook and both subscriptions close. They reopen when it opens.
  //   • `null` for the stake meant `shouldClearPendingLock` could never return true here, so on a route
  //     with no other consumer this instance held a credited record open indefinitely. The session
  //     already watches AllowedStake for `viewer.writeReady`; read that instead of asserting ignorance.
  const pending = usePendingCapacity(open ? api : null, viewerBucket(viewer), postingPower);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = useCallback(() => signInPromptActions.close(), []);

  // This sheet stays mounted and toggles, so the hook is driven by `open` rather than by mount: focus
  // moves in on each open and returns to whatever opened it on each close.
  useDialogFocus(open, closeRef);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // Trap Tab inside the sheet. aria-modal does not do this on its own; without it Tab wraps to the
      // document and lands on the obscured page behind the scrim (same trap as ConfirmDialog).
      if (e.key === "Tab") {
        const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, [tabindex]:not([tabindex="-1"])',
        );
        if (!focusables || focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    [close],
  );

  // Belt and braces: if the viewer becomes able to write while the sheet is open (a lock credits, or
  // another tab finishes setup), the sheet is answering a question that no longer exists.
  useEffect(() => {
    if (open && viewer.writeReady) close();
  }, [open, viewer.writeReady, close]);

  if (!open) return null;

  const go = (href: string) => {
    close();
    router.push(href);
  };

  // The one canonical funnel, so this cannot disagree with /welcome or the Settings card about what
  // is actually missing. `votingPower` is passed only as the advisory field; it gates nothing.
  const status = setupStatus(
    sessionState,
    viewer.writeReady ? 1n : 0n,
    votingPower === null ? null : votingPower > 0n,
    pending.kind !== "none",
    stabilityWindow,
  );

  const body =
    viewer.status === "not-connected" ? (
      <>
        Reading is free forever. To {reason}, sign in with a Cardano wallet and lock {LOCK_ADA_WHOLE}{" "}
        ADA you can take back whenever you want.
      </>
    ) : viewer.status === "not-identity-bound" ? (
      <>You are part way through setup. One signature registers your account, and it is free.</>
    ) : pending.kind !== "none" ? (
      <>
        Your lock is settling on Cardano.{" "}
        {stabilityWindow
          ? `Posting power arrives ${stabilityWindow} after it confirms.`
          : "Posting power arrives once the network credits it."}{" "}
        There is nothing to do but wait.
      </>
    ) : (
      <>{status.detail}</>
    );

  // A viewer whose lock is already settling has no action to take, so do not offer one.
  const settling = viewer.status === "ready" && pending.kind !== "none";
  const ctaLabel =
    viewer.status === "not-connected"
      ? "Sign in"
      : viewer.status === "not-identity-bound"
        ? "Finish setup"
        : (status.next?.label ?? "Finish setup");

  return (
    <div
      className={styles.scrim}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cg-signin-title"
        onKeyDown={onKeyDown}
      >
        <h2 id="cg-signin-title" className={styles.title}>
          {viewer.status === "not-connected" ? REASON_TITLE[reason] : "Almost there"}
        </h2>
        <p className={styles.body}>{body}</p>

        <div className={styles.actions}>
          <button ref={closeRef} type="button" className={styles.ghost} onClick={close}>
            {settling ? "Close" : "Not now"}
          </button>
          {!settling && (
            <button type="button" className={styles.cta} onClick={() => go("/welcome/")}>
              {ctaLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default SignInSheet;
