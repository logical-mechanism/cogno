"use client";

// useTheme — dark-first theme toggle. Reads/writes the `data-theme` attribute on
// the root <html> and persists the choice to localStorage['cg-theme']. The pre-paint boot
// script in the root layout sets the attribute before first paint (no flash); this hook keeps
// React in sync and flips it on toggle. Default is "dark".
//
// Backed by the SHARED persistent store, not a private useState. Two ThemeToggles are mounted at once
// on desktop /settings (the RightRail one and AppearanceSection's), and with per-instance state,
// toggling one left the other rendering the wrong icon, the wrong label, and an aria-label that
// actively lied ("Switch to light mode" on a page that was already light). `crossTab` keeps a second
// window in sync too.
//
// localStorage is the single source of truth: the layout's boot script derives the attribute from
// exactly this key with exactly this default, so the store and the DOM cannot disagree at boot.

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { createPersistentStore } from "@/lib/persistentStore";

export type Theme = "dark" | "light";

const store = createPersistentStore<Theme>({
  key: "cg-theme",
  empty: "dark", // also the SSG/first-paint snapshot
  parse: (raw) => (raw === "light" || raw === "dark" ? raw : "dark"),
  serialize: (t) => t,
  crossTab: true,
});

export interface UseTheme {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

export function useTheme(): UseTheme {
  const theme = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);

  // Mirror the store onto the document. This must run for EVERY change, not only ones this tab made:
  // a `storage` event from another tab updates our store but cannot touch our document, so without it
  // the icon would flip while the page kept its old colours.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => store.commit(t), []);
  const toggle = useCallback(() => store.commit(store.read() === "dark" ? "light" : "dark"), []);

  return { theme, setTheme, toggle };
}
