"use client";

// useNotifications — DEFERRED (doc 04 §5.4). Notifications are NOT built in v1, but the indexer
// already carries the edges that make a clean follow-up: votes / reposts / follows / replies
// (Post.parent) / quotes (Post.quote) TARGETING the viewer. This hook slot is named so a future
// surface can wire it (a NotificationsBell, a /notifications route) without re-plumbing the seam.
// It returns an inert, not-yet-implemented shape today. Every relevant surface leaves a
// `// HOOK: notifications` comment where the bell/badge would mount.

import type { Ss58 } from "@/lib/types";

export interface NotificationItem {
  kind: "vote" | "repost" | "follow" | "reply" | "quote";
  postId?: bigint;
  actor: Ss58;
  at: number;
}

export interface UseNotifications {
  notifications: NotificationItem[];
  unreadCount: number;
  loading: boolean;
  /** false in v1 — the feature is deferred. */
  enabled: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useNotifications(_who: Ss58 | null): UseNotifications {
  // HOOK: notifications — deferred. Wire to the indexer's vote/repost/follow/reply/quote edges
  // targeting `_who` when this ships.
  return { notifications: [], unreadCount: 0, loading: false, enabled: false };
}
