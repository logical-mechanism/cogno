"use client";

// HiddenSection — Settings "Hidden posts": manage the device-local hidden-post set (see lib/hiddenStore).
// Hiding is client-only and removes ONE post from your feeds on THIS device — it never deletes anything
// or changes what anyone else sees. Hide from the ··· menu on a post; unhide here (or from the post's
// own permalink, which still shows it).
//
// The store holds only ids, so each is resolved to its live post (source.thread(id).root — the same
// one-post read /bookmarks uses) to show a recognizable row. A compact management list, not a feed: no
// full cards, no pagination.
//
// Resolve model mirrors BookmarksPage: a per-id cache of SUCCESSFUL resolves, so unhiding a row reorders
// from cache with NO refetch of the survivors (the old code re-resolved every remaining id over the
// network on each unhide, so the just-unhidden row lingered until an unrelated round-trip finished). A
// failed resolve is left UNCACHED (retryable) and surfaces as an error row + a still-manageable fallback
// row, instead of silently vanishing an id you could then never unhide.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import styles from "./HiddenSection.module.css";
import { Avatar } from "@/components/Avatar";
import { Handle } from "@/components/Handle";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useHiddenList, hiddenActionsFor } from "@/lib/hiddenStore";
import { sanitizeInline } from "@/lib/sanitize";
import type { CognoPost } from "@/lib/types";

export function HiddenSection() {
  const { source, viewer } = useSession();
  const me = viewer.address ?? null;
  const hiddenIds = useHiddenList(me);
  const idsKey = useMemo(() => hiddenIds.map(String).sort().join(","), [hiddenIds]);

  const resolvedRef = useRef<Map<string, CognoPost>>(new Map());
  const meRef = useRef<string | null>(me);
  const [posts, setPosts] = useState<CognoPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const onRetry = useCallback(() => setRetryNonce((n) => n + 1), []);

  // Newest-first order (hidden ids are post ids; higher = newer).
  const orderedIds = useMemo(
    () => [...hiddenIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)),
    [hiddenIds],
  );

  useEffect(() => {
    if (!source) return; // wait for the reader

    // Drop the cache on an account switch (root carries the me-stamped overlay).
    if (meRef.current !== me) {
      meRef.current = me;
      resolvedRef.current = new Map();
      setPosts([]);
      setLoading(true);
    }

    // Sort inside the effect (newest-first) keyed on the stable content hash `idsKey`, not the
    // `hiddenIds`/`orderedIds` reference — a store hook can hand back an equal-but-new array each render,
    // which as an effect dep would refetch in a loop (the BookmarksPage resolve pattern).
    const ids = [...hiddenIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    if (ids.length === 0) {
      resolvedRef.current = new Map();
      setPosts([]);
      setLoading(false);
      setError(null);
      return;
    }

    const rebuild = () =>
      setPosts(ids.map((id) => resolvedRef.current.get(String(id))).filter((p): p is CognoPost => p != null));

    const missing = ids.filter((id) => !resolvedRef.current.has(String(id)));
    if (missing.length === 0) {
      rebuild();
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    Promise.all(
      missing.map((id) =>
        source
          .thread(id, me ?? undefined)
          .then((t) => ({ id, post: t.root, ok: true as const }))
          .catch(() => ({ id, post: null, ok: false as const })),
      ),
    )
      .then((results) => {
        if (cancelled) return;
        results.forEach((r) => {
          if (r.ok && r.post) resolvedRef.current.set(String(r.id), r.post); // cache successes only
        });
        rebuild();
        setLoading(false);
        const failed = results.filter((r) => !r.ok).length;
        setError(
          failed > 0
            ? `Couldn't load ${failed} hidden post${failed === 1 ? "" : "s"}. Check your connection.`
            : null,
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load hidden posts.");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // hiddenIds is captured via idsKey (its stable content hash); me/source/retryNonce complete it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, idsKey, me, retryNonce]);

  const unhide = useCallback(
    (id: bigint) => {
      // Optimistic: drop the id from the cache + list so the row disappears at once, then commit to the
      // store. The store change re-runs the effect, which rebuilds from cache (no refetch of survivors).
      resolvedRef.current.delete(String(id));
      setPosts((prev) => prev.filter((p) => p.id !== id));
      hiddenActionsFor(me).unhide(id);
    },
    [me],
  );

  if (hiddenIds.length === 0) {
    return (
      <EmptyState
        title="No hidden posts"
        description="Hide a post from the ··· menu on it. Hiding is saved on this device, per account, and only hides the post for you. It never affects anyone else."
      />
    );
  }

  if (loading && posts.length === 0) {
    return <p className={styles.muted}>Loading hidden posts…</p>;
  }

  const resolved = new Map(posts.map((p) => [String(p.id), p]));

  return (
    <div className={styles.list}>
      {error && (
        <div className={styles.errorRow} role="status">
          <span>{error}</span>
          <button type="button" className={styles.retry} onClick={onRetry}>
            Retry
          </button>
        </div>
      )}
      {orderedIds.map((id) => {
        const post = resolved.get(String(id));
        // A resolved post shows its author + snippet; an id that failed to resolve still gets a row (with
        // its permalink, which does its own read) so it stays manageable — never a vanished, un-unhideable id.
        if (post) {
          return (
            <div key={String(id)} className={styles.row}>
              <Link href={`/post/${post.id}/`} className={styles.link} aria-label="Open hidden post">
                <Avatar address={post.author} src={post.authorAvatar} size="md" name={post.authorDisplayName} />
                <span className={styles.who}>
                  <Handle address={post.author} />
                  <span className={styles.snippet} dir="auto">
                    {sanitizeInline(post.text)}
                  </span>
                </span>
              </Link>
              <button type="button" className={styles.unhide} onClick={() => unhide(post.id)}>
                Unhide
              </button>
            </div>
          );
        }
        if (loading) return null; // still resolving this id — don't flash a fallback row prematurely
        return (
          <div key={String(id)} className={styles.row}>
            <Link href={`/post/${id}/`} className={styles.link} aria-label="Open hidden post">
              <span className={styles.who}>
                <span className={styles.fallback}>Couldn&apos;t load post #{String(id)}</span>
              </span>
            </Link>
            <button type="button" className={styles.unhide} onClick={() => unhide(id)}>
              Unhide
            </button>
          </div>
        );
      })}
    </div>
  );
}
