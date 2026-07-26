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
//
// The OPERATOR's serve denylist rides the same predicate, and that is deliberate even though the data
// layer already applies it (lib/feed/denylist-source.ts). Two reasons, both concrete: the "N new posts"
// pill counts `moderate(buffer)`, so a denied post reaching that buffer would promise a row that never
// renders; and a permalinked card is rendered directly rather than through a filtered list, so the
// stub decision has to be answerable here. It is defence in depth, not the primary mechanism.
//
// Note the asymmetry, which is the point of keeping them separate concepts: block/hide are the
// VIEWER's own choices, stored on their device, reversible by them. The denylist is the operator's,
// baked into the build, and not something a reader can undo. They suppress by the same mechanic and
// mean entirely different things.

import { useMemo } from "react";
import { useBlockedSet } from "@/lib/blockStore";
import { useHiddenSet } from "@/lib/hiddenStore";
import { isDenied, isDeniedAuthor, isDeniedPost } from "@/lib/config/denylist";
import type { CognoPost, Ss58 } from "@/lib/types";

export interface Moderation {
  isBlocked: (addr: Ss58 | null | undefined) => boolean;
  isHidden: (id: bigint | null | undefined) => boolean;
  /** On the OPERATOR's serve denylist: not this viewer's choice, and not undoable by them. */
  isDenied: (post: { id: bigint; author: string } | null | undefined) => boolean;
  /** Drop blocked authors, hidden posts, and anything this deployment declines to serve. */
  filterPosts: <T extends CognoPost>(posts: T[]) => T[];
}

/**
 * The pure list filter: remove a post when its author is blocked, the post id is hidden, or either is
 * on the operator's serve denylist.
 *
 * The denylist is read from the module rather than passed in, which keeps `useModeration`'s memo deps
 * at `[blocked, hidden]` and therefore keeps `filterPosts` referentially stable. That stability is
 * load-bearing: Home hands the identity to useLiveFeed and /explore closes over it, so a fresh
 * function per render would re-run their effects on every block.
 */
export function filterModerated<T extends CognoPost>(
  posts: T[],
  blocked: ReadonlySet<string>,
  hidden: ReadonlySet<string>,
): T[] {
  return posts.filter((p) => !blocked.has(p.author) && !hidden.has(String(p.id)) && !isDenied(p));
}

export function useModeration(me: Ss58 | null): Moderation {
  const blocked = useBlockedSet(me);
  const hidden = useHiddenSet(me);
  return useMemo(
    () => ({
      isBlocked: (addr) => addr != null && blocked.has(addr),
      isHidden: (id) => id != null && hidden.has(String(id)),
      isDenied: (post) => post != null && (isDeniedPost(post.id) || isDeniedAuthor(post.author)),
      filterPosts: (posts) => filterModerated(posts, blocked, hidden),
    }),
    [blocked, hidden],
  );
}
