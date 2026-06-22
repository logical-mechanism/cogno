"use client";

// ThemeToggle — the dark/light switch (doc 02 §9, locked decision 3: dark-first + a working toggle).
//
// A single icon button: IconMoon when dark (click → light), IconSun when light (click → dark). It
// drives useTheme(), which flips the `data-theme` attribute on <html> and persists 'cg-theme'. The
// pre-paint boot script in the root layout sets the attribute before first paint (no flash); this only
// flips it at runtime. Presentational; no chain access.

import styles from "./ThemeToggle.module.css";
import { useTheme } from "@/hooks/useTheme";
import { IconSun, IconMoon } from "./icons";

export interface ThemeToggleProps {
  /** Show a text label beside the icon (LeftNav footer); icon-only otherwise. */
  withLabel?: boolean;
}

export function ThemeToggle({ withLabel }: ThemeToggleProps) {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next} mode`;

  return (
    <button
      type="button"
      className={styles.btn}
      onClick={toggle}
      aria-label={label}
      title={label}
    >
      {theme === "dark" ? (
        <IconMoon size="var(--cg-icon-md)" />
      ) : (
        <IconSun size="var(--cg-icon-md)" />
      )}
      {withLabel && <span className={styles.label}>{theme === "dark" ? "Dark" : "Light"}</span>}
    </button>
  );
}
