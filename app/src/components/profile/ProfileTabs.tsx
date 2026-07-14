"use client";

// ProfileTabs — the Posts / Replies / Likes strip under the profile header.
//
// Composes the tab LIST (each tab is gated on the reader advertising it) and hands it to the shared
// <Tabs> strip — whose CSS module was, before the merge, byte-identical to TimelineTabs' apart from the
// leading comment. See components/ui/Tabs.tsx.
//
// NO "Media" tab (D1): X has one, but cogno-chain posts are text-only (≤512 bytes, no media field), so a
// Media tab would always be empty and is deliberately omitted. X's "Highlights" / "Articles" likewise.
//
// Presentational: the active tab is client state in the surface; this only renders + reports onChange.

import { useMemo } from "react";
import { Tabs, type TabDef } from "@/components/ui/Tabs";

export type ProfileTab = "posts" | "replies" | "likes";

export interface ProfileTabsProps {
  active: ProfileTab;
  onChange: (tab: ProfileTab) => void;
  /** Show the Replies tab (node-served — `MicroblogApi.author_replies_page`). */
  showReplies: boolean;
  /** Show the Likes tab (node-direct, via the `VotesByAccount` reverse index). */
  showLikes: boolean;
}

export function ProfileTabs({ active, onChange, showReplies, showLikes }: ProfileTabsProps) {
  // Posts is always shown; Replies/Likes appear per their cap. (No "Media" tab, D1 — text-only chain.)
  const tabs = useMemo<TabDef<ProfileTab>[]>(() => {
    const out: TabDef<ProfileTab>[] = [{ id: "posts", label: "Posts" }];
    if (showReplies) out.push({ id: "replies", label: "Replies" });
    if (showLikes) out.push({ id: "likes", label: "Likes" });
    return out;
  }, [showReplies, showLikes]);

  return (
    <Tabs
      tabs={tabs}
      active={active}
      onChange={onChange}
      idPrefix="cg-ptab"
      panelId="cg-profile-panel"
      ariaLabel="Profile sections"
    />
  );
}
