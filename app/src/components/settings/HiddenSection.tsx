"use client";

// HiddenSection — Settings "Hidden posts": manage the device-local hidden-post set (see lib/hiddenStore).
// Hiding is client-only and removes ONE post from your feeds on THIS device — it never deletes anything
// or changes what anyone else sees. Hide from the ··· menu on a post; unhide here (or from the post's
// own permalink, which still shows it).
//
// The store holds only ids, so each is resolved to its live post (source.thread(id).root — the same
// one-post read /bookmarks uses) to show a recognizable row. A compact management list, not a feed: no
// full cards, no pagination.

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import styles from "./HiddenSection.module.css";
import { Avatar } from "@/components/Avatar";
import { Handle } from "@/components/Handle";
import { EmptyState } from "@/components/EmptyState";
import { useSession } from "@/components/Providers";
import { useHiddenList, hiddenActionsFor } from "@/lib/hiddenStore";
import type { CognoPost } from "@/lib/types";

export function HiddenSection() {
  const { source, viewer } = useSession();
  const me = viewer.address ?? null;
  const hiddenIds = useHiddenList(me);
  const idsKey = useMemo(() => hiddenIds.map(String).sort().join(","), [hiddenIds]);

  const [posts, setPosts] = useState<CognoPost[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    const ids = [...hiddenIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest-first
    if (ids.length === 0) {
      setPosts([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    Promise.all(
      ids.map((id) =>
        source
          .thread(id, me ?? undefined)
          .then((t) => t.root)
          .catch(() => null),
      ),
    ).then((resolved) => {
      if (cancelled) return;
      setPosts(resolved.filter((p): p is CognoPost => p != null));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // hiddenIds is captured via idsKey (its stable content hash); me/source complete it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, idsKey, me]);

  if (hiddenIds.length === 0) {
    return (
      <EmptyState
        title="No hidden posts"
        description="Hide a post from the ··· menu on it. Hidden posts are saved on this device, per account, and only hidden for you. It never affects anyone else."
      />
    );
  }

  if (loading && posts.length === 0) {
    return <p className={styles.muted}>Loading hidden posts…</p>;
  }

  return (
    <div className={styles.list}>
      {posts.map((post) => (
        <div key={String(post.id)} className={styles.row}>
          <Link href={`/post/${post.id}/`} className={styles.link} aria-label="Open hidden post">
            <Avatar address={post.author} src={post.authorAvatar} size="md" name={post.authorDisplayName} />
            <span className={styles.who}>
              <Handle address={post.author} />
              <span className={styles.snippet}>{post.text}</span>
            </span>
          </Link>
          <button
            type="button"
            className={styles.unhide}
            onClick={() => hiddenActionsFor(me).unhide(post.id)}
          >
            Unhide
          </button>
        </div>
      ))}
    </div>
  );
}
