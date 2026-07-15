"use client";

// PinnedPostBlock — the author's pinned post hoisted above the Posts list.
//
// Profile.pinnedPostId is a bare on-chain id, NOT existence-validated; the surface resolves the single
// post (via source.thread(id).root — the seam has no ONE_POST, so thread().root IS the one-post
// resolver) and renders it here as a PostCard with a "Pinned" headerExtra marker. If the id 404s /
// throws / isn't the author's, the surface silently omits this block (no error). The post is de-duped
// out of the first page of the Posts tab by the surface.
//
// It reuses the SAME PostActionCallbacks bundle + viewer state as the tab cards, so Like/Reply/Quote
// behave identically. Polls aren't wired here (a pinned poll still renders its body + actions; the live
// poll results surface on the tab card / detail).

import styles from "./PinnedPostBlock.module.css";
import { PostCard } from "@/components/PostCard";
import { useBlocked } from "@/lib/blockStore";
import { useHidden } from "@/lib/hiddenStore";
import type { CognoPost, ViewerPostState, Viewer, PostActionCallbacks } from "@/components/kit";

export interface PinnedPostBlockProps {
  post: CognoPost;
  viewer: ViewerPostState;
  gate: Viewer;
  handlers: PostActionCallbacks;
}

/** Inline pushpin glyph — the shared icons module has no pin (read-only), so it lives here. */
function PinGlyph() {
  return (
    <svg
      className={styles.pinIcon}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable="false"
    >
      <path d="M7 4a1 1 0 0 1 1-1h8a1 1 0 0 1 .8 1.6L15 7v4l2.6 2.6A1 1 0 0 1 17 15h-4v5a1 1 0 1 1-2 0v-5H7a1 1 0 0 1-.8-1.6L9 11V7L7.2 4.6A1 1 0 0 1 7 4z" />
    </svg>
  );
}

export function PinnedPostBlock({ post, viewer, gate, handlers }: PinnedPostBlockProps) {
  // Respect the viewer's own suppression: a hidden pinned post, or one by a blocked author, is dropped
  // (the Posts tab below is filtered the same way by Timeline). Mute is left to PostCard's collapse.
  const me = gate.status === "ready" ? (gate.address ?? null) : null;
  const blocked = useBlocked(post.author, me);
  const hidden = useHidden(post.id, me);
  if (blocked || hidden) return null;

  return (
    <PostCard
      post={post}
      viewer={viewer}
      gate={gate}
      handlers={handlers}
      variant="timeline"
      headerExtra={
        <span className={styles.pinned}>
          <PinGlyph />
          Pinned
        </span>
      }
    />
  );
}
