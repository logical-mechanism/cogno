"use client";

// AppearanceSection — Settings §5 (doc 12). Theme (dark/light), persisted via useTheme (cg-theme).
// A single two-option segmented radiogroup backed by setTheme (the one canonical Settings control;
// the quick flip lives in the right-rail footer next to About). Private-mode degrades silently
// (useTheme swallows the storage error).

import styles from "./AppearanceSection.module.css";
import { useTheme, type Theme } from "@/hooks/useTheme";
import { IconMoon, IconSun } from "@/components/icons";

const OPTIONS: { value: Theme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <div className={styles.card}>
      <h3 className={styles.cardTitle}>Theme</h3>

      <div className={styles.segmented} role="radiogroup" aria-label="Theme">
        {OPTIONS.map((opt) => {
          const active = theme === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              className={`${styles.segment} ${active ? styles.active : ""}`}
              onClick={() => setTheme(opt.value)}
            >
              {opt.value === "dark" ? (
                <IconMoon size="var(--cg-icon-sm)" />
              ) : (
                <IconSun size="var(--cg-icon-sm)" />
              )}
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
