"use client";

// SettingsShell — the master/detail (desktop ≥1020) + drill-down (mobile/tablet ≤1019) shell for the
// Settings sections (doc 12 §1/§9). ONE React tree switched by CSS-Modules width classes — no
// per-section routes (the static export has no /settings/[section]). The same `active` state drives
// both layouts; the parent (SettingsPage) owns the hash mirror.
//
// A11y: the master index is role=tablist (vertical); each row role=tab with aria-selected; the detail
// is role=tabpanel labelled by the active tab; arrow-up/down moves between sections, Enter/Space
// activates. On mobile, tapping a row drills in (a back arrow returns to the list, owned by the page).

import { useCallback, useEffect, useRef } from "react";
import styles from "./SettingsShell.module.css";
import { IconBack } from "@/components/icons";
import { AccountSection } from "./AccountSection";
import { ProfileSection } from "./ProfileSection";
import { VaultSection } from "./VaultSection";
import { DiagnosticsSection } from "./DiagnosticsSection";
import { AboutSection } from "./AboutSection";

export type SectionId =
  | "account"
  | "profile"
  | "vault"
  | "diagnostics"
  | "about";

export const SECTIONS: { id: SectionId; heading: string }[] = [
  { id: "account", heading: "Account" },
  { id: "profile", heading: "Profile" },
  { id: "vault", heading: "Vault & posting power" },
  { id: "diagnostics", heading: "Diagnostics" },
  { id: "about", heading: "About" },
  // NOTE: Notifications preferences (reply/vote/repost/follow/quote) is a DEFERRED follow-up — see
  // doc 12 §11. No section is rendered for it in v1; leave this seam.
];

export function SettingsShell({
  active,
  onSelect,
  /** Mobile/tablet drill-down: true once a section is opened (the list is hidden, the panel shows). */
  drilled,
  /** Mobile/tablet: return from a panel to the section list. */
  onBack,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  drilled: boolean;
  onBack: () => void;
}) {
  const tablistRef = useRef<HTMLDivElement | null>(null);
  const panelHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // On drilling into a panel (mobile/tablet), move focus to the panel heading (a11y §10).
  useEffect(() => {
    if (drilled) panelHeadingRef.current?.focus();
  }, [drilled, active]);

  const activeHeading = SECTIONS.find((s) => s.id === active)?.heading ?? "Settings";

  // Roving arrow-key navigation between the master rows (a11y §10).
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const idx = SECTIONS.findIndex((s) => s.id === active);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = SECTIONS[(idx + delta + SECTIONS.length) % SECTIONS.length];
        onSelect(next.id);
        const row = tablistRef.current?.querySelector<HTMLElement>(`[data-section="${next.id}"]`);
        row?.focus();
      }
    },
    [active, onSelect],
  );

  const detail = renderSection(active, onSelect);

  return (
    <div className={`${styles.shell} ${drilled ? styles.drilled : ""}`}>
      {/* Master index */}
      <div
        className={styles.master}
        role="tablist"
        aria-orientation="vertical"
        aria-label="Settings sections"
        ref={tablistRef}
        onKeyDown={onKeyDown}
      >
        {SECTIONS.map((s) => {
          const isActive = s.id === active;
          return (
            <button
              key={s.id}
              type="button"
              role="tab"
              id={`settings-tab-${s.id}`}
              aria-selected={isActive}
              // Only ONE tabpanel is rendered (id=settings-panel-<active>); point aria-controls at it
              // solely from the active tab so the other tabs don't reference a non-existent element.
              aria-controls={isActive ? `settings-panel-${s.id}` : undefined}
              tabIndex={isActive ? 0 : -1}
              data-section={s.id}
              className={`${styles.row} ${isActive ? styles.rowActive : ""}`}
              onClick={() => onSelect(s.id)}
            >
              <span className={styles.rowLabel}>{s.heading}</span>
              <span className={styles.chevron} aria-hidden>
                ›
              </span>
            </button>
          );
        })}
      </div>

      {/* Detail panel */}
      <div
        className={styles.detail}
        role="tabpanel"
        id={`settings-panel-${active}`}
        aria-labelledby={`settings-tab-${active}`}
        tabIndex={0}
      >
        {/* Mobile/tablet-only back bar (the master list is hidden when drilled). */}
        <div className={styles.panelBar}>
          <button
            type="button"
            className={styles.backBtn}
            onClick={onBack}
            aria-label="Back to settings"
          >
            <IconBack size="var(--cg-icon-md)" />
          </button>
          <h2 className={styles.panelHeading} tabIndex={-1} ref={panelHeadingRef}>
            {activeHeading}
          </h2>
        </div>
        {detail}
      </div>
    </div>
  );
}

function renderSection(id: SectionId, onSelect: (id: SectionId) => void) {
  switch (id) {
    case "account":
      return <AccountSection onGoVault={() => onSelect("vault")} />;
    case "profile":
      return <ProfileSection />;
    case "vault":
      return <VaultSection />;
    case "diagnostics":
      return <DiagnosticsSection />;
    case "about":
      return <AboutSection />;
  }
}
