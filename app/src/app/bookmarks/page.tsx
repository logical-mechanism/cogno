"use client";

// BookmarksPage — /bookmarks. The viewer's device-local saved posts (see lib/bookmarkStore). Bookmarks
// are client-only (localStorage['cg-bookmarks']) — nothing is written to the chain and the list never
// leaves this device. Each saved id is resolved to its live post via source.thread(id, me).root (the
// same read any post detail uses), so the cards are always chain-truth, never a cached copy.
//
// Newest-first. Every card write is the same optimistic PostActionCallbacks bundle the Home/Explore
// timelines use (open / author / reply / quote / like / downvote / copy-link). No pagination
// (the list is a fixed local set). No honesty/block-number chrome.
//
// Reach: LeftNav "Bookmarks" (desktop/tablet) + a Settings launcher (mobile — the bottom bar is a
// locked 4 tabs). A muted author's saved post still collapses to the "Show" stub (PostCard owns that).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { StickyHeader } from "@/components/AppShell";
import { Timeline } from "@/components/Timeline";
import { useSession } from "@/components/Providers";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { usePinPost } from "@/hooks/usePinPost";
import { carriedViewerStates } from "@/lib/chain/node-reads";
import { useToaster } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { sharePostWithToast } from "@/lib/share";
import { useBookmarkList } from "@/lib/bookmarkStore";
import type { CognoPost, ViewerPostState } from "@/lib/types";
import type { PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

export default function BookmarksPage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower } = useSession();
  const me = viewer.address ?? null;

  // The saved id set (bigint[]) from localStorage; an order-independent string key drives the resolve
  // effect so a referentially-new-but-equal list doesn't refetch.
  const bookmarkIds = useBookmarkList();
  const idsKey = useMemo(() => bookmarkIds.map(String).sort().join(","), [bookmarkIds]);

  // ── resolve saved ids → live posts (newest-first) ─────────────────────────────────────────────
  // A per-id cache of RESOLVED posts so removing one bookmark reorders from cache with NO refetch /
  // skeleton flash. Only SUCCESSES are cached — a failed thread() read (a transient RPC/WS blip and a
  // genuine miss are indistinguishable here) is left UNCACHED so it re-resolves on the next id change
  // or a Timeline retry, and a read failure surfaces an error row instead of silently dropping a saved
  // post / showing a misleading empty state. The cache is dropped whole on an account switch (the node
  // stamps the viewer overlay onto root, so it's `me`-specific), clearing `posts` too so the previous
  // viewer's overlay never flashes on the new one.
  const resolvedRef = useRef<Map<string, CognoPost>>(new Map());
  const meRef = useRef<string | null>(me);
  const [posts, setPosts] = useState<CognoPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped by the Timeline retry row to re-attempt the ids that failed to resolve.
  const [retryNonce, setRetryNonce] = useState(0);
  const onRetry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    if (!source) return; // wait for the reader
    let cancelled = false;

    if (meRef.current !== me) {
      meRef.current = me;
      resolvedRef.current = new Map();
      setPosts([]); // drop the previous viewer's cards so their overlay can't flash on the new viewer
      setLoading(true); // let the skeleton mask the viewer-correct refetch
    }

    const ids = [...bookmarkIds].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest-first
    if (ids.length === 0) {
      resolvedRef.current = new Map();
      setPosts([]);
      setLoading(false);
      setError(null);
      return;
    }

    const rebuild = () =>
      setPosts(
        ids
          .map((id) => resolvedRef.current.get(String(id)))
          .filter((p): p is CognoPost => p != null),
      );

    const missing = ids.filter((id) => !resolvedRef.current.has(String(id)));
    if (missing.length === 0) {
      rebuild();
      setLoading(false);
      setError(null);
      return;
    }

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
        // Cache ONLY successful resolves; a failed id stays uncached (→ retryable), never a poisoned null.
        results.forEach((r) => {
          if (r.ok && r.post) resolvedRef.current.set(String(r.id), r.post);
        });
        rebuild();
        setLoading(false);
        const failed = results.filter((r) => !r.ok).length;
        setError(
          failed > 0
            ? `Couldn't load ${failed} bookmark${failed === 1 ? "" : "s"} — check your connection.`
            : null,
        );
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Couldn't load bookmarks");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // bookmarkIds is captured via idsKey (its stable content hash); me/source/retryNonce complete it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, idsKey, me, retryNonce]);

  // ── viewer-relative state (filled heart / active repost) ──────────────────────────────────────
  const postIds = useMemo(() => posts.map((p) => p.id), [posts]);
  const carriedStates = useMemo(() => carriedViewerStates(posts), [posts]);
  const viewerStates = useViewerStates(source, postIds, me, carriedStates);

  // ── write hooks + per-card action bundle (identical wiring to Home/Explore) ───────────────────
  const vote = useVote(api, signer, votingPower ?? 0n);
  const { pin } = usePinPost(api, signer);
  const { toast } = useToaster();

  const handlers = useMemo<PostActionCallbacks>(
    () => ({
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (address) => router.push(`/u/${address}/`),
      onReply: (post) =>
        viewer.status === "ready" ? modalActions.openReply(post.id) : router.push("/welcome/"),
      onQuote: (post) =>
        viewer.status === "ready" ? modalActions.openQuote(post.id) : router.push("/welcome/"),
      onLike: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.like(post.id, cur);
        else vote.unlike(post.id, cur);
      },
      onDownvote: (post, next) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        if (next) vote.downvote(post.id, cur);
        else vote.clear(post.id, cur);
      },
      onShare: (post) => void sharePostWithToast(post.id, toast),
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, pin, toast],
  );

  return (
    <>
      <StickyHeader showBack title="Bookmarks" />

      <Timeline
        posts={posts}
        gate={viewer}
        viewerStates={viewerStates}
        handlers={handlers}
        loading={loading && posts.length === 0}
        error={error}
        onRetry={onRetry}
        hasMore={false}
        paginationCapable={false}
        emptyVariant="feed"
        emptyTitle="No bookmarks yet"
        emptyDescription="Save a post from the ··· menu to find it here. Bookmarks are kept on this device only."
        emptyAction={{ label: "Explore", onClick: () => router.push("/explore/") }}
        api={api}
        signer={signer}
      />
    </>
  );
}
