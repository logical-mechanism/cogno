"use client";

// PersonResult — a single People-tab result. A thin wrapper over the shared PersonRow so the People
// list and the RightRail who-to-follow share one row shape (surface 10 §6). Search shows EVERYONE
// matching the term (including the viewer + already-followed) — no self/edge filtering here (unlike
// who-to-follow); FollowButton itself returns null for the viewer's own row.

import { PersonRow } from "./PersonRow";
import type { Suggestion, Viewer } from "@/components/kit";

export interface PersonResultProps {
  person: Suggestion;
  viewer: Viewer;
  isFollowing: boolean;
  onToggleFollow: (target: string, next: boolean) => void;
  /** The active query, <mark>ed in the display name. */
  highlight?: string;
}

export function PersonResult({
  person,
  viewer,
  isFollowing,
  onToggleFollow,
  highlight,
}: PersonResultProps) {
  return (
    <PersonRow
      person={person}
      viewer={viewer}
      isFollowing={isFollowing}
      onToggleFollow={onToggleFollow}
      highlight={highlight}
    />
  );
}
