"use client";

// useModeration — the device-local suppression predicates a post surface applies to a list.
//
// Two hard suppressions live here (block a person, hide a post); mute is deliberately NOT here — mute
// stays a per-card COLLAPSE owned by PostCard (a reversible "Show" stub), whereas block + hide REMOVE
// the item from the list entirely. Subscribes to both device-local sets, so a caller re-renders the
// moment the viewer blocks/hides/unblocks/unhides on any tab.
//
// `filterPosts` is the one the list surfaces call (Timeline, ThreadView replies, who-to-follow via its
// own author filter). `isBlocked` is also read directly by PostCard (the blocked focal stub) and the
// people/notification folds.

import { useMemo } from "react";
import { useBlockedSet } from "@/lib/blockStore";
import { useHiddenSet } from "@/lib/hiddenStore";
import type { CognoPost, Ss58 } from "@/lib/types";

export interface Moderation {
  isBlocked: (addr: Ss58 | null | undefined) => boolean;
  isHidden: (id: bigint | null | undefined) => boolean;
  /** Drop blocked authors + hidden posts from a list — the hard suppression. */
  filterPosts: <T extends CognoPost>(posts: T[]) => T[];
}

/** The pure list filter: remove a post when its author is blocked OR the post id is hidden. */
export function filterModerated<T extends CognoPost>(
  posts: T[],
  blocked: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): T[] {
  return posts.filter((p) => !blocked.has(p.author) && !hidden.has(String(p.id)));
}

export function useModeration(me: Ss58 | null): Moderation {
  const blocked = useBlockedSet(me);
  const hidden = useHiddenSet(me);
  return useMemo(
    () => ({
      isBlocked: (addr) => addr != null && blocked.has(addr),
      isHidden: (id) => id != null && hidden.has(String(id)),
      filterPosts: (posts) => filterModerated(posts, blocked, hidden),
    }),
    [blocked, hidden],
  );
}
