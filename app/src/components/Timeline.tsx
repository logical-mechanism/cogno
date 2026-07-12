"use client";

// Timeline — the Home post list (doc 06 §3 / §7 / §8, doc 03 §22.1).
//
// Renders a column of `PostCard variant="timeline"` (the cards own their hairline divider + hover
// tint), and handles the three list states: loading → Skeleton×8, empty → EmptyState, tail →
// infinite-scroll Spinner when the source cursor-paginates (caps.pagination — true on the node path
// since spec-119) and another page exists.
//
// It OWNS the Home feed keyboard nav (doc 06 §8): j/k move focus between cards (roving tabIndex +
// a 2px --cg-accent left-border focus marker), n composes, Enter/o opens the focused post, l likes,
// r replies, . flushes the new-posts pill. Shortcuts are
// DISABLED while focus is in a text input (the composer), so typing n/l/j types characters.
//
// Poll cards need no wiring here: InlinePoll (inside PostCard) is the sole poll owner and pulls the
// session itself. Timeline used to mount a <PollHost> that fetched the poll and passed it down — which
// double-mounted usePoll, because the surface read starts null and PostCard fell through to InlinePoll
// on the first render anyway.

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./Timeline.module.css";
import { PostCard } from "./PostCard";
import { NO_VIEWER } from "@/lib/optimistic";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Spinner } from "./icons";
import type {
  CognoPost,
  EmptyStateVariant,
  Viewer,
  ViewerPostState,
  PostActionCallbacks,
} from "./kit";

export interface TimelineProps {
  posts: CognoPost[];
  gate: Viewer;
  /** Map of the viewer's own vote/repost over the visible post ids. */
  viewerStates: Map<bigint, ViewerPostState>;
  handlers: PostActionCallbacks;
  /** Initial-load skeleton. */
  loading: boolean;
  /** A passive read-failure message (shown as a retry row above the cards; never a toast). */
  error?: string | null;
  onRetry?: () => void;
  /** Cursor pagination available (caps.pagination). */
  hasMore: boolean;
  onLoadMore?: () => void;
  /** Tail spinner while a load-more page is in flight. */
  loadingMore?: boolean;
  /** Source cursor-paginates (caps.pagination) → show the infinite-scroll tail. */
  paginationCapable: boolean;
  /**
   * EmptyState variant for THIS tab. The full EmptyStateVariant — it was narrowed to `feed | follows`,
   * which meant the profile view (whose tabs are `profile | replies`) could not pass its own variant at
   * all and silently fell through to the `feed` default, rendering "Find some people to follow" on
   * someone's profile.
   */
  emptyVariant?: EmptyStateVariant;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: { label: string; onClick: () => void };
  /** Flush the new-posts pill (the `.` shortcut). */
  onFlush?: () => void;
  /** Open the composer (the `n` shortcut). */
  onCompose?: () => void;
  /** Search term to <mark> in each card's body (set only on the search-results Timeline). */
  highlight?: string;
}

export function Timeline({
  posts,
  gate,
  viewerStates,
  handlers,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  loadingMore,
  paginationCapable,
  emptyVariant = "feed",
  emptyTitle,
  emptyDescription,
  emptyAction,
  onFlush,
  onCompose,
  highlight,
}: TimelineProps) {
  // Index of the keyboard-focused card (roving tabIndex). -1 = none focused yet.
  const [focusIdx, setFocusIdx] = useState(-1);
  const cardRefs = useRef<(HTMLElement | null)[]>([]);

  // Keep the focus index in range when the list shrinks.
  useEffect(() => {
    if (focusIdx >= posts.length) setFocusIdx(posts.length - 1);
  }, [posts.length, focusIdx]);

  const focusCard = useCallback((idx: number) => {
    setFocusIdx(idx);
    cardRefs.current[idx]?.focus();
  }, []);

  // ── feed keyboard nav (doc 06 §8). Disabled while focus is in a text input. ──
  const onKeyDownList = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const t = e.target as HTMLElement;
      const tag = t.tagName;
      const editable =
        tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
      if (editable) return; // typing — let the character through

      const cur = focusIdx < 0 ? 0 : focusIdx;
      const focused = focusIdx >= 0 ? posts[focusIdx] : undefined;

      switch (e.key) {
        case "j": {
          e.preventDefault();
          focusCard(Math.min(cur + (focusIdx < 0 ? 0 : 1), posts.length - 1));
          break;
        }
        case "k": {
          e.preventDefault();
          focusCard(Math.max(cur - 1, 0));
          break;
        }
        case "n": {
          e.preventDefault();
          onCompose?.();
          break;
        }
        case ".": {
          e.preventDefault();
          onFlush?.();
          break;
        }
        case "Enter":
        case "o": {
          if (!focused) return;
          e.preventDefault();
          handlers.onOpen(focused.id);
          break;
        }
        case "l": {
          if (!focused) return;
          e.preventDefault();
          const cur0 = viewerStates.get(focused.id) ?? NO_VIEWER;
          handlers.onLike(focused, cur0.myVote !== "Up");
          break;
        }
        case "r": {
          if (!focused) return;
          e.preventDefault();
          handlers.onReply(focused);
          break;
        }
        default:
          break;
      }
    },
    [focusIdx, posts, handlers, viewerStates, focusCard, onCompose, onFlush],
  );

  // ── loading (initial) ──
  // Carry the same id/role/aria-label as the populated panel so the TimelineTabs' aria-controls
  // relationship stays valid while the feed is loading or empty (only one branch renders at a time).
  if (loading && posts.length === 0) {
    return (
      <div id="cg-timeline-panel" role="tabpanel" aria-label="Timeline" className={styles.list} aria-busy="true">
        <Skeleton variant="post" count={8} />
      </div>
    );
  }

  // ── empty ──
  if (posts.length === 0) {
    return (
      <div id="cg-timeline-panel" role="tabpanel" aria-label="Timeline" className={styles.list}>
        {error && <ErrorRow message={error} onRetry={onRetry} />}
        <EmptyState
          variant={emptyVariant}
          title={emptyTitle}
          description={emptyDescription}
          action={emptyAction}
        />
      </div>
    );
  }

  // ── populated ──
  return (
    <div
      id="cg-timeline-panel"
      role="tabpanel"
      aria-label="Timeline"
      className={styles.list}
      onKeyDown={onKeyDownList}
    >
      {error && <ErrorRow message={error} onRetry={onRetry} />}

      {posts.map((post, i) => {
        const pending = post.id < 0n;
        const focused = i === focusIdx;
        const vs = viewerStates.get(post.id) ?? NO_VIEWER;
        return (
          <div
            key={String(post.id)}
            ref={(el) => {
              cardRefs.current[i] = el;
            }}
            tabIndex={focused ? 0 : -1}
            className={`${styles.cardSlot} ${focused ? styles.focused : ""}`}
            onFocus={() => setFocusIdx(i)}
          >
            <PostCard
              post={post}
              viewer={vs}
              gate={gate}
              handlers={handlers}
              variant="timeline"
              pending={pending}
              highlight={highlight}
            />
          </div>
        );
      })}

      {/* tail — the infinite-scroll "load more" sentinel, shown when the source paginates
          (caps.pagination — true on the node path since spec-119) and another page exists. */}
      {paginationCapable && hasMore && (
        <LoadMoreTail loading={loadingMore} onLoadMore={onLoadMore} />
      )}
    </div>
  );
}

/** A passive read-failure row (never a toast). Keeps already-rendered cards. */
function ErrorRow({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className={styles.errorRow} role="status">
      <span className={styles.errorText}>{message}</span>
      {onRetry && (
        <button type="button" className={styles.retry} onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/** The infinite-scroll tail: an IntersectionObserver auto-loads, the Spinner shows progress. */
function LoadMoreTail({ loading, onLoadMore }: { loading?: boolean; onLoadMore?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onLoadMore) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) onLoadMore();
      },
      { rootMargin: "600px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [onLoadMore]);

  return (
    <div ref={ref} className={styles.tail}>
      {loading && <Spinner size="md" label="Loading more posts" />}
    </div>
  );
}

