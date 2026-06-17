"use client";

// Feed — the live ledger of posts, newest-first. Threads are built with
// buildThreadIndex (key "root" or String(parentId)); a reply renders indented one
// level under its parent, and a reply whose parent is gone (tombstoned/dangling)
// still renders at root rather than vanishing — we never silently drop content.
//
// The empty state is honest: "no posts yet" is shown ONLY once the feed is ready
// AND the chain is actually advancing. While connecting, or during a finality/best
// stall, we say so instead of falsely claiming the ledger is empty.

import { useMemo } from "react";
import { buildThreadIndex } from "@/lib/chain/reads";
import type { CognoPost, FeedSnapshot, Ss58, ConnStatus } from "@/lib/types";
import { PostItem } from "./PostItem";
import styles from "./Feed.module.css";

export interface FeedProps {
  snapshot: FeedSnapshot;
  /** false until the first watchFeed emission lands. */
  ready: boolean;
  status: ConnStatus;
  mySs58: Ss58;
  busy: boolean;
  onReply: (id: bigint) => void;
  onDelete: (id: bigint) => void;
  /**
   * A live feed-source error (e.g. the indexer is unreachable). Surfaced honestly so the feed
   * degrades to a clear notice instead of falsely claiming the ledger is empty. M4.
   */
  error?: string | null;
  /**
   * Paginated mode (indexer search / "load more"): when set, the feed renders THIS error/
   * affordance for the page instead of the live empty-state logic. Live mode leaves these
   * undefined and behaves exactly as before. M4.
   */
  paginated?: boolean;
  hasNextPage?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
}

interface Row {
  post: CognoPost;
  isReply: boolean;
}

// Flatten the thread index into a render list: each root, immediately followed by
// its direct replies (one level of indent — M1 keeps threading shallow & legible).
function toRows(posts: CognoPost[]): Row[] {
  const index = buildThreadIndex(posts);
  const byId = new Map<string, CognoPost>();
  for (const p of posts) byId.set(String(p.id), p);

  // A post is a "root" row when it is top-level OR its parent is gone (dangling).
  const roots = posts.filter(
    (p) => p.parent == null || !byId.has(String(p.parent)),
  );
  // posts is already newest-first; keep that ordering for roots.

  const rows: Row[] = [];
  for (const root of roots) {
    rows.push({ post: root, isReply: false });
    const children = index.get(String(root.id)) ?? [];
    // Replies oldest-first reads more naturally under a parent.
    const ordered = [...children].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    for (const child of ordered) rows.push({ post: child, isReply: true });
  }
  return rows;
}

export function Feed({
  snapshot,
  ready,
  status,
  mySs58,
  busy,
  onReply,
  onDelete,
  error = null,
  paginated = false,
  hasNextPage = false,
  loadingMore = false,
  onLoadMore,
}: FeedProps) {
  const rows = useMemo(() => toRows(snapshot.posts), [snapshot.posts]);
  const hasPosts = snapshot.posts.length > 0;

  return (
    <section className={styles.feed} aria-label="Posts">
      <header className={styles.head}>
        <h2 className={styles.title}>ledger</h2>
        {snapshot.asOf != null && (
          <span className={styles.asOf} aria-live="polite">
            as of #{snapshot.asOf}
          </span>
        )}
      </header>

      {hasPosts ? (
        <div className={styles.list}>
          {rows.map((r) => (
            <PostItem
              key={String(r.post.id)}
              post={r.post}
              mySs58={mySs58}
              busy={busy}
              isReply={r.isReply}
              onReply={onReply}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : !ready || status === "connecting" ? (
        <p className={styles.state}>reading the ledger…</p>
      ) : error ? (
        <p className={styles.state}>
          can&apos;t reach the indexer right now — {error}. Clear the GraphQL
          endpoint in settings to read directly from the node.
        </p>
      ) : status === "reconnecting" || status === "error" ? (
        <p className={styles.state}>
          can&apos;t reach the node right now — the ledger may not be empty, just
          unreachable.
        </p>
      ) : paginated ? (
        <p className={styles.state}>no posts match.</p>
      ) : (
        <p className={styles.state}>
          no posts yet. write the first one above — it lands in a block.
        </p>
      )}

      {/* The indexer can keep handing pages; the live PAPI feed is always one full snapshot. */}
      {paginated && hasPosts && hasNextPage && (
        <div className={styles.more}>
          <button
            type="button"
            className={styles.moreButton}
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "loading…" : "load more"}
          </button>
        </div>
      )}

      {/* A non-fatal error while we still have posts to show: keep them, but say what's wrong. */}
      {hasPosts && error && (
        <p className={styles.notice} role="status">
          the indexer errored — {error}
        </p>
      )}
    </section>
  );
}

export default Feed;
