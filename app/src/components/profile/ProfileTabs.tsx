"use client";

// ProfileTabs — the Posts / Replies / Likes strip under the profile header (doc 07 §5, doc 03 §22.3).
//
// A real role="tablist" with arrow-key roving focus; the active tab carries the NEUTRAL underline
// indicator (the locked monochrome direction — the accent is the Post CTA + focus ring ONLY; doc 00).
//
// NO "Media" tab (D1): X has a Media tab, but cogno-chain posts are text-only (≤512 bytes, no media
// field) — a Media tab would always be empty, so it is deliberately omitted. X's "Highlights" /
// "Articles" tabs are likewise out.
//
// CAPS-DRIVEN VISIBILITY: when the active reader can't serve profiles (PAPI-direct,
// caps.profiles === false), Replies + Likes need reverse indexes the PAPI path lacks, so only the
// Posts tab is shown (never shown-then-errored — doc 07 §5.4). The surface passes `showAll`.
//
// Presentational: the active tab is client state in the surface; this only renders + reports onChange.

import { useCallback, useMemo, useRef } from "react";
import styles from "./ProfileTabs.module.css";

export type ProfileTab = "posts" | "replies" | "likes";

export interface ProfileTabsProps {
  active: ProfileTab;
  onChange: (tab: ProfileTab) => void;
  /** Render Replies + Likes. False on PAPI-direct (caps.profiles === false) → Posts only. */
  showAll: boolean;
}

interface TabDef {
  id: ProfileTab;
  label: string;
}

export function ProfileTabs({ active, onChange, showAll }: ProfileTabsProps) {
  const tabs = useMemo<TabDef[]>(
    () =>
      showAll
        ? [
            { id: "posts", label: "Posts" },
            { id: "replies", label: "Replies" },
            { id: "likes", label: "Likes" },
            // NOTE: no "Media" tab (D1) — the chain is text-only, so it would always be empty.
          ]
        : [{ id: "posts", label: "Posts" }],
    [showAll],
  );

  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      const idx = tabs.findIndex((t) => t.id === active);
      if (idx < 0) return;
      let nextIdx = idx;
      if (e.key === "ArrowRight") nextIdx = (idx + 1) % tabs.length;
      else if (e.key === "ArrowLeft") nextIdx = (idx - 1 + tabs.length) % tabs.length;
      else return;
      e.preventDefault();
      const next = tabs[nextIdx];
      onChange(next.id);
      refs.current[next.id]?.focus();
    },
    [tabs, active, onChange],
  );

  return (
    <div className={styles.tablist} role="tablist" aria-label="Profile sections">
      {tabs.map((t) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`cg-ptab-${t.id}`}
            aria-selected={selected}
            aria-controls="cg-profile-panel"
            tabIndex={selected ? 0 : -1}
            className={`${styles.tab} ${selected ? styles.active : ""}`}
            onClick={() => onChange(t.id)}
            onKeyDown={onKeyDown}
          >
            <span className={styles.label}>{t.label}</span>
            {selected && <span className={styles.indicator} aria-hidden />}
          </button>
        );
      })}
    </div>
  );
}
