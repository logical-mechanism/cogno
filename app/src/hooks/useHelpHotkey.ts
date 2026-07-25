"use client";

// useHelpHotkey — the app-wide "?" shortcut that opens the keyboard-shortcuts sheet.
//
// Mounted once in AppShell, next to useSearchHotkey, and it copies that hook's guards deliberately:
// bail on a modifier chord, bail while the user is typing in a field, and bail when a modal/dialog is
// already open (so "?" typed into a composer stays a question mark, and the sheet cannot stack on top of
// another dialog). Those three guards are the whole correctness surface of a global key handler.
//
// "?" is Shift+/ on most layouts, so `e.key === "?"` is the right test — checking `e.shiftKey && e.key
// === "/"` would miss layouts where ? sits elsewhere, and `e.code` would be wrong on non-US layouts.

import { useEffect } from "react";

export function useHelpHotkey(onOpen: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "?" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true;
      if (typing) return;
      // A modal/composer/dialog is open → don't steal the key, and don't stack a second dialog.
      if (document.querySelector("[role='dialog']")) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
