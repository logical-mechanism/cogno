"use client";

// AppearanceSection — Settings "Appearance": device-local theme (light/dark). Purely client-side
// (localStorage['cg-theme'] via useTheme); no chain state. Lives here so mobile/tablet users — and
// anyone on the Settings surface — can switch theme even though the RightRail toggle is desktop-only.

import styles from "./AppearanceSection.module.css";
import { ThemeToggle } from "@/components/ThemeToggle";

export function AppearanceSection() {
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.label}>Theme</span>
          <span className={styles.hint}>Saved on this device.</span>
        </div>
        <ThemeToggle withLabel />
      </div>
    </div>
  );
}
