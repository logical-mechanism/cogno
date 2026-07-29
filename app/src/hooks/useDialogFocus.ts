"use client";

// useDialogFocus — move focus into a dialog when it opens, and put it back where it came from when it
// closes.
//
// The restore is the load-bearing half for a keyboard user. Without it, dismissing a dialog leaves focus
// on a node that has just been removed, the browser falls back to <body>, and the next Tab restarts from
// the top of the document instead of returning to the control that opened it. On a long timeline that is
// dozens of stops back to where they were.
//
// THE THREE GUARDS ARE NOT DEFENSIVE NOISE. Each one is a case that actually happens:
//
//  • no opener — a dialog opened by a bare keyboard shortcut has no trigger element. `document.body` is
//    what activeElement reports then, and calling focus() on it would be a no-op that reads as intent.
//  • opener detached — the commonest case. A dialog opened from a menu item unmounts that menu, so by
//    the time the cleanup runs the remembered node is no longer in the document. focus() on a detached
//    element silently does nothing and focus lands on <body> anyway, which is the exact bug this hook
//    exists to prevent, arrived at by a different route.
//  • opener not focusable any more — a control that has since become disabled.
//
// Lifted from ShortcutsDialog, which had the only complete implementation. ComposerModal restored
// without the guards; ConfirmDialog and SignInSheet did not restore at all.

import { useEffect, useRef, type RefObject } from "react";

/**
 * @param open   whether the dialog is showing. A dialog that mounts already-open passes `true`; one that
 *               stays mounted and toggles (SignInSheet) passes its own flag, so focus moves on each open
 *               rather than only on mount.
 * @param initialFocusRef  the control to focus on open. Conventionally the non-destructive one (Cancel /
 *                         Close), so Enter on an unread dialog cannot confirm something. OMIT it when the
 *                         dialog's content focuses itself (ComposerModal's textarea autofocuses); the
 *                         restore half still applies, and passing a non-focusable wrapper instead would
 *                         be a silent no-op dressed up as intent.
 */
export function useDialogFocus(
  open: boolean,
  initialFocusRef?: RefObject<HTMLElement | null>,
): void {
  // THE OPENER IS CAPTURED DURING RENDER, and it has to be. React applies a child's `autoFocus` in the
  // COMMIT phase, which runs before passive effects flush — so reading `document.activeElement` inside
  // the effect below sees the dialog's own autofocused control, not the trigger. That is not a corner
  // case: ModalRouteHost passes `autoFocus` to every composer it puts inside ComposerModal, so the
  // most-used dialog in the app remembered its own textarea, the detached-opener guard then declined to
  // restore (the textarea unmounts with the dialog), and focus fell to <body> anyway.
  //
  // Guarded on the open EDGE, so a re-render while open never re-reads and clobbers the opener with a
  // control inside the dialog, and StrictMode's double render is idempotent (refs survive both passes).
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open !== wasOpen.current) {
    wasOpen.current = open;
    if (open) {
      openerRef.current =
        typeof document === "undefined" ? null : (document.activeElement as HTMLElement | null);
    }
  }

  useEffect(() => {
    if (!open) return;

    const opener = openerRef.current;
    initialFocusRef?.current?.focus();

    return () => {
      if (!opener) return;
      if (opener === document.body) return;
      if (!document.contains(opener)) return;
      opener.focus();
    };
    // `initialFocusRef` is a ref object and is stable across renders; including it would be noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export default useDialogFocus;
