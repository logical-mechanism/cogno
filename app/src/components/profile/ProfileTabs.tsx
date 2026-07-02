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
// CAPS-DRIVEN VISIBILITY: each tab is gated on the reader advertising it (showReplies/showLikes). The
// node serves all three now (Posts + Likes via the spec-118 reverse maps, Replies via spec-200
// author_replies_page), so all show; a reader that couldn't would hide them (never shown-then-errored,
// doc 07 §5.4).
//
// Presentational: the active tab is client state in the surface; this only renders + reports onChange.

import { useCallback, useMemo, useRef } from "react";
import styles from "./ProfileTabs.module.css";

export type ProfileTab = "posts" | "replies" | "likes";

export interface ProfileTabsProps {
  active: ProfileTab;
  onChange: (tab: ProfileTab) => void;
  /** Show the Replies tab (node-served — spec-200 MicroblogApi.author_replies_page). */
  showReplies: boolean;
  /** Show the Likes tab (node-direct since spec-118's VotesByAccount reverse index). */
  showLikes: boolean;
}

interface TabDef {
  id: ProfileTab;
  label: string;
}

export function ProfileTabs({ active, onChange, showReplies, showLikes }: ProfileTabsProps) {
  // Posts is always shown; Replies/Likes appear per their cap. (No "Media" tab, D1 — text-only chain.)
  const tabs = useMemo<TabDef[]>(() => {
    const list: TabDef[] = [{ id: "posts", label: "Posts" }];
    if (showReplies) list.push({ id: "replies", label: "Replies" });
    if (showLikes) list.push({ id: "likes", label: "Likes" });
    return list;
  }, [showReplies, showLikes]);

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
