"use client";

// SettingsPage — /settings (doc 01 §1, surface 12). STUB: the seven sections (Account / Profile /
// Vault & posting power / Appearance / Network / Advanced / About) are surface 12. The foundation
// mounts the shell + a placeholder (the ThemeToggle already lives in the LeftNav footer).

import { StickyHeader } from "@/components/AppShell";
import { EmptyState } from "@/components/EmptyState";

export default function SettingsPage() {
  return (
    <>
      <StickyHeader title="Settings" />
      <EmptyState title="Settings are coming soon" description="Account, appearance, network, and vault controls land here." />
    </>
  );
}
