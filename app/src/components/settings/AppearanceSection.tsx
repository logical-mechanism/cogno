"use client";

// AppearanceSection — Settings "Appearance": device-local theme (light/dark), plus the discoverable
// entry point for the keyboard shortcuts. Purely client-side (localStorage['cg-theme'] via useTheme); no
// chain state. Lives here so mobile/tablet users — and anyone on the Settings surface — can switch theme
// even though the RightRail toggle is desktop-only.
//
// The shortcuts row exists because "?" is only discoverable if you already know to press it. It renders
// its OWN dialog rather than reaching for AppShell's: this section is reachable on touch devices that
// have no keyboard at all, so the list is documentation here, not an accelerator.

import { useState } from "react";
import styles from "./AppearanceSection.module.css";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ShortcutsDialog } from "@/components/ShortcutsDialog";

export function AppearanceSection() {
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  return (
    <div className={styles.card}>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.label}>Theme</span>
          <span className={styles.hint}>Saved on this device.</span>
        </div>
        <ThemeToggle withLabel />
      </div>
      <div className={styles.row}>
        <div className={styles.rowText}>
          <span className={styles.label}>Keyboard shortcuts</span>
          <span className={styles.hint}>Press ? anywhere to see these.</span>
        </div>
        <button type="button" className={styles.action} onClick={() => setShortcutsOpen(true)}>
          View
        </button>
      </div>
      {shortcutsOpen && <ShortcutsDialog onClose={() => setShortcutsOpen(false)} />}
    </div>
  );
}
