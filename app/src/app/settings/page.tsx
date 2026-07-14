"use client";

// SettingsPage — /settings. The master/detail (desktop ≥1020) + drill-down (mobile/tablet
// ≤1019) shell over the five sections. Owns `activeSection` + the `drilled` flag (mobile only) + the
// hash mirror (history.replaceState('/settings#<id>')) so a row is deep-linkable and the back button is
// sane. RightRail suppression on /settings is orchestrator-owned (nav) — not touched here.
//
// Standalone fallback: /settings/ is the EditProfileModal deep-link fallback. The modal opens only via
// the in-app modalActions.openEditProfile() (ModalRouteHost never opens itself from the URL on a cold
// load), so a cold /settings/ simply shows the sections; #<id> deep-links a specific section.

import { useCallback, useEffect, useState } from "react";
import { StickyHeader } from "@/components/AppShell";
import { SettingsShell, SECTIONS, type SectionId } from "@/components/settings/SettingsShell";

const VALID = new Set<SectionId>(SECTIONS.map((s) => s.id));

function sectionFromHash(): SectionId | null {
  if (typeof window === "undefined") return null;
  const raw = window.location.hash.replace(/^#/, "") as SectionId;
  return VALID.has(raw) ? raw : null;
}

export default function SettingsPage() {
  const [active, setActive] = useState<SectionId>("account");
  // Mobile/tablet drill-down: true once a section is opened (the list is hidden, the panel shows). On
  // desktop the CSS ignores this (both panes always render).
  const [drilled, setDrilled] = useState(false);

  // Deep-link: read the hash once on mount (e.g. /settings#vault from a Composer no_weight link).
  useEffect(() => {
    const fromHash = sectionFromHash();
    if (fromHash) {
      setActive(fromHash);
      setDrilled(true);
    }
  }, []);

  // Mirror the active section into the hash without a route change (deep-linkable; sane back button).
  const select = useCallback((id: SectionId) => {
    setActive(id);
    setDrilled(true);
    try {
      window.history.replaceState(window.history.state, "", `/settings#${id}`);
    } catch {
      /* history may be unavailable in some embeds; the in-page state still drives the UI */
    }
  }, []);

  // Mobile/tablet back: return from a panel to the section list.
  const backToList = useCallback(() => {
    setDrilled(false);
    try {
      window.history.replaceState(window.history.state, "", "/settings");
    } catch {
      /* non-fatal */
    }
  }, []);

  return (
    <>
      <StickyHeader title="Settings" />
      <SettingsShell active={active} onSelect={select} drilled={drilled} onBack={backToList} />
    </>
  );
}
