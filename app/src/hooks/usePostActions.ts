"use client";

// usePostActions — the per-card action bundle every post surface hands to <PostCard>.
//
// Five surfaces (Home, Explore, Bookmarks, the profile, ThreadView) each carried their own
// `useMemo<PostActionCallbacks>` with the same eight callbacks. Three were byte-identical; the profile's
// differed only in a parameter NAME; ThreadView's differed for a real reason (see `onReplyReady`).
//
// THE SIGNED-OUT GATE IS THE POINT. Six of the eight callbacks bounce a signed-out reader to /welcome/
// before doing anything. That gate is written INSIDE this hook, and the one axis a surface can vary —
// where a Reply goes — is expressed as a callback the hook invokes only AFTER the gate has passed. A
// surface therefore cannot supply a reply handler that forgets to check, which is precisely the mistake
// the obvious extraction invites: ThreadView's reply handler reads
//
//     if (viewer.status !== "ready") return void router.push("/welcome/");
//     if (post.id === rootId) focusComposer();
//
// and lifting that body wholesale into a shared `onReply` override would let a signed-out user focus
// the composer instead of bouncing.
//
// `modalActions` is a module singleton (lib/modalStore), imported directly and deliberately absent from
// the dep array — it has no identity to track.

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { modalActions } from "@/lib/modalStore";
import { sharePostWithToast, type ShareToast } from "@/lib/share";
import { NO_VIEWER } from "@/lib/optimistic";
import type { UseVote } from "./useVote";
import type { PostActionCallbacks, Viewer } from "@/components/kit";
import type { CognoPost, ViewerPostState } from "@/lib/types";

export interface PostActionDeps {
  /** The write-gate state. `status === "ready"` is the only one that may mutate. */
  viewer: Viewer;
  /** Per-post viewer overlay, keyed by post id. Missing ids fall back to {@link NO_VIEWER}. */
  viewerStates: Map<bigint, ViewerPostState>;
  vote: UseVote;
  /** Pin one of your own posts (usePinPost). */
  pin: (id: bigint) => void;
  toast: ShareToast;
  /**
   * Where a Reply goes once the viewer is KNOWN-READY. Omit for the default (open the reply modal).
   *
   * The signed-out bounce is applied by the hook BEFORE this runs, so an override cannot drop it.
   * ThreadView is the only surface that needs this: its focal Reply focuses the inline composer in
   * place, while a non-focal reply descends to that reply's own focal (?reply=1 auto-focuses its
   * composer) — so a reply is always authored where parentId === rootId and shows optimistically.
   */
  onReplyReady?: (post: CognoPost) => void;
}

export function usePostActions({
  viewer,
  viewerStates,
  vote,
  pin,
  toast,
  onReplyReady,
}: PostActionDeps): PostActionCallbacks {
  const router = useRouter();

  return useMemo<PostActionCallbacks>(() => {
    /** The signed-out bounce, in ONE place. Returns false when the caller must stop. */
    const ready = (): boolean => {
      if (viewer.status === "ready") return true;
      void router.push("/welcome/");
      return false;
    };
    const stateOf = (post: CognoPost) => viewerStates.get(post.id) ?? NO_VIEWER;

    return {
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (address) => router.push(`/u/${address}/`),
      onReply: (post) => {
        if (!ready()) return;
        if (onReplyReady) onReplyReady(post);
        else modalActions.openReply(post.id);
      },
      onQuote: (post) => {
        if (!ready()) return;
        modalActions.openQuote(post.id);
      },
      onLike: (post, next) => {
        if (!ready()) return;
        const cur = stateOf(post);
        if (next) vote.like(post.id, cur);
        else vote.unlike(post.id, cur);
      },
      onDownvote: (post, next) => {
        if (!ready()) return;
        const cur = stateOf(post);
        if (next) vote.downvote(post.id, cur);
        else vote.clear(post.id, cur);
      },
      onShare: (post) => void sharePostWithToast(post.id, toast),
      onPin: (post) => pin(post.id),
    };
  }, [router, viewer.status, viewerStates, vote, pin, toast, onReplyReady]);
}
