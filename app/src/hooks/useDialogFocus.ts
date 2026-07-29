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

import { useEffect, type RefObject } from "react";

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
  useEffect(() => {
    if (!open) return;

    // Read the opener BEFORE moving focus, or we would remember the dialog's own control.
    const opener = document.activeElement as HTMLElement | null;
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
