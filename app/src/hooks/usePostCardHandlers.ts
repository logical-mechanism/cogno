// usePostCardHandlers — the ONE per-card action bundle shared by every feed surface (home, explore,
// thread, profile). Each surface previously hand-maintained a byte-near-identical `PostActionCallbacks`
// block; keeping four copies in sync was a standing drift hazard (the profile's `onShare` had already
// drifted to swallow its result silently — no "Link copied" feedback). Centralizing here makes the
// wiring single-sourced and gives every surface the same auth-gate, optimistic-vote, and share-toast
// behaviour, so the next feed surface is a one-liner.
//
// The toast bus is read INTERNALLY via `useToaster()` (global ToasterProvider), so a surface need not
// thread it in — and can never again forget it. `modalActions` is a module singleton, so it is used
// directly rather than passed as a dependency.

import { useMemo } from "react";
import type { useRouter } from "next/navigation";
import { modalActions } from "@/lib/modalStore";
import { useToaster } from "@/components/toast/ToasterProvider";
import type { PostActionCallbacks, Viewer } from "@/components/kit";
import type { UseVote } from "@/hooks/useVote";
import type { UseRepost } from "@/hooks/useRepost";
import type { ViewerPostState } from "@/lib/types";

/** The Next App Router instance the surfaces navigate with. */
type AppRouter = ReturnType<typeof useRouter>;

/** Neutral viewer state for a post the viewer hasn't acted on (no vote, not reposted). */
const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

/** Per-surface inputs the handlers close over. Everything else (toast, modal bus) is sourced inside. */
export interface PostCardHandlerDeps {
  router: AppRouter;
  /** The coarse viewer status the surfaces auth-gate on (`"ready"` ⇒ may write). */
  viewer: Viewer;
  /** The viewer's own vote/repost per visible post (drives optimistic vote toggles). */
  viewerStates: Map<bigint, ViewerPostState>;
  vote: UseVote;
  repost: UseRepost;
  /** Pin one of the viewer's OWN posts (own-post overflow menu only). */
  pin: (postId: bigint) => void;
}

/**
 * Build the memoized {@link PostActionCallbacks} for a feed surface. Identical wiring across all
 * surfaces: navigation, an auth-gate that bounces unbound viewers to `/welcome/`, optimistic
 * vote/repost via the passed write hooks, share-to-clipboard with a success/error toast, and pin.
 */
export function usePostCardHandlers({
  router,
  viewer,
  viewerStates,
  vote,
  repost,
  pin,
}: PostCardHandlerDeps): PostActionCallbacks {
  const { toast } = useToaster();
  return useMemo<PostActionCallbacks>(
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
      onRepost: (post) => {
        if (viewer.status !== "ready") return void router.push("/welcome/");
        const cur = viewerStates.get(post.id) ?? NO_VIEWER;
        repost.repost(post.id, cur.reposted);
      },
      onShare: (post) => {
        const url = `${typeof window !== "undefined" ? window.location.origin : ""}/post/${post.id}/`;
        void navigator.clipboard
          ?.writeText(url)
          .then(() => toast({ kind: "success", message: "Link copied" }))
          .catch(() => toast({ kind: "error", message: "Couldn't copy the link" }));
      },
      onPin: (post) => pin(post.id),
    }),
    [router, viewer.status, viewerStates, vote, repost, pin, toast],
  );
}
