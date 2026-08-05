"use client";

// useSearchHotkey — the app-wide "/" shortcut that focuses the SearchBar (X parity).
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
      // `alertdialog` as well as `dialog`: ConfirmDialog and EditProfileModal use the former, and on the
      // real /compose route (a deep-link and refresh target for the URL ModalRouteHost pushes) the
      // discard confirm has no enclosing role="dialog" to cover for it. Without this, "/" moved focus to
      // the RightRail search box BEHIND the scrim of an aria-modal dialog.
      if (document.querySelector("[role='dialog'],[role='alertdialog']")) return;
      // Pick the first VISIBLE search box: on ≤1226px the RightRail SearchBar is display:none but stays
      // mounted, and focus() on a hidden element is a no-op — which would swallow "/" with no effect.
      // offsetParent is null for a display:none-nested element, so skip those.
      const inputs = document.querySelectorAll<HTMLInputElement>(
        "[role='search'] input[type='search']",
      );
      const input = Array.from(inputs).find((el) => el.offsetParent !== null);
      if (input) {
        e.preventDefault();
        input.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
