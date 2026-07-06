"use client";

// useSearchHotkey — the app-wide "/" shortcut that focuses the SearchBar (X parity, surface 10 §9).
// Mounted once in AppShell so it works on EVERY surface (the RightRail box on Home/profile, the Explore
// header box) — it used to live inside /explore only, so "/" did nothing elsewhere. Ignores "/" while
// the user is typing in a field or a modal/dialog is open, and focuses the first [role='search'] search
// input on the page.

import { useEffect } from "react";

export function useSearchHotkey(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable === true;
      if (typing) return;
      // A modal/composer open → don't steal the slash.
      if (document.querySelector("[role='dialog']")) return;
      const input = document.querySelector<HTMLInputElement>(
        "[role='search'] input[type='search']",
      );
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
