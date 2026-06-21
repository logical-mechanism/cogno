"use client";

// useTheme — dark-first theme toggle (doc 02 §9). Reads/writes the `data-theme` attribute on
// the root <html> and persists the choice to localStorage['cg-theme']. The pre-paint boot
// script in the root layout sets the attribute before first paint (no flash); this hook keeps
// React in sync and flips it on toggle. Default is "dark".

import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";
const STORAGE_KEY = "cg-theme";

function readStoredTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.getAttribute("data-theme");
    if (attr === "light" || attr === "dark") return attr;
  }
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      /* storage blocked — fall through to default */
    }
  }
  return "dark";
}

export interface UseTheme {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
}

export function useTheme(): UseTheme {
  // Default to "dark" for SSG/first paint; reconcile with the stored/attribute value on mount.
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    setThemeState(readStoredTheme());
  }, []);

  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    if (typeof document !== "undefined") {
      document.documentElement.setAttribute("data-theme", t);
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, t);
    } catch {
      /* storage blocked — the attribute still applies for this session */
    }
  }, []);

  const toggle = useCallback(() => {
    setTheme(readStoredTheme() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggle };
}
