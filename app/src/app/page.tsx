"use client";

// HomePage — the Home route '/' (doc 01 §1, doc 06). The FOUNDATION home stub: a sticky "Home" header,
// an inline Composer, and a live feed of PostCards via useOptimisticFeed(source) + useViewerStates,
// with Like/Repost wired through useVote/useRepost. The rich Timeline / TimelineTabs (For you /
// Following) is surface 06 — this keeps it simple but REAL (snapshot → PostCards, optimistic, gated).
// One socket: everything reads from useSession(); this page never instantiates a client.

import { useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import styles from "./page.module.css";
import { StickyHeader } from "@/components/AppShell";
import { Composer } from "@/components/Composer";
import { PostCard } from "@/components/PostCard";
import { EmptyState } from "@/components/EmptyState";
import { Spinner } from "@/components/icons";
import { useSession } from "@/components/Providers";
import { useOptimisticFeed } from "@/hooks/useOptimisticFeed";
import { useViewerStates } from "@/hooks/useViewerStates";
import { useVote } from "@/hooks/useVote";
import { useRepost } from "@/hooks/useRepost";
import { useOptimistic } from "@/hooks/useOptimistic";
import { useMutation } from "@/hooks/useMutation";
import { useToaster, RATE_LIMIT_COPY } from "@/components/toast/ToasterProvider";
import { modalActions } from "@/lib/modalStore";
import { submitPost } from "@/lib/chain/mutations";
import type { CognoPost, ViewerPostState } from "@/lib/types";
import type { ActionState, ComposerDraft, PostActionCallbacks } from "@/components/kit";

const NO_VIEWER: ViewerPostState = { myVote: null, reposted: false };

function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

export default function HomePage() {
  const router = useRouter();
  const { api, signer, source, viewer, votingPower } = useSession();

  const { snapshot, ready } = useOptimisticFeed(source);
  const posts = snapshot.posts;

  const me = viewer.address ?? null;
  const postIds = useMemo(() => posts.map((p) => p.id), [posts]);
  const viewerStates = useViewerStates(source, postIds, me);

  const vote = useVote(api, signer, votingPower ?? 0n);
  const repost = useRepost(api, signer);
  const { addPending, dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();

  // ── inline composer (top-level post) ──
  const onComposePost = useCallback(
    (draft: ComposerDraft) => {
      if (viewer.status !== "ready") {
        router.push("/welcome/");
        return;
      }
      if (!api || !signer || draft.text.trim().length === 0) return;
      const optimistic: CognoPost = {
        id: -BigInt(Date.now()),
        author: me ?? signer.ss58,
        text: draft.text,
        at: 0,
        authorDisplayName: viewer.displayName,
        authorAvatar: viewer.avatar,
      };
      const clientId = addPending(optimistic);
      void run(submitPost(api, signer, draft.text), {
        onConfirm: () => dropPending(clientId),
        onError: (message) => {
          failPending(clientId);
          if (isRateLimit(message)) toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {});
    },
    [viewer, api, signer, me, addPending, dropPending, failPending, run, toast, router],
  );

  // ── per-card action bundle ──
  const handlers = useMemo<PostActionCallbacks>(
    () => ({
      onOpen: (id) => router.push(`/post/${id}/`),
      onAuthorOpen: (address) => router.push(`/u/${address}/`),
      onReply: (post) => (viewer.status === "ready" ? modalActions.openReply(post.id) : router.push("/welcome/")),
      onQuote: (post) => (viewer.status === "ready" ? modalActions.openQuote(post.id) : router.push("/welcome/")),
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
    }),
    [router, viewer.status, viewerStates, vote, repost, toast],
  );

  const composeState: ActionState = "idle"; // the inline composer clears optimistically; per-tx state lives on the card

  return (
    <>
      <StickyHeader title="Home" />

      {viewer.status === "ready" && (
        <div className={styles.composerSlot}>
          <Composer
            viewer={viewer}
            mode="post"
            submitState={composeState}
            onTogglePoll={() => modalActions.openPoll()}
            onSubmit={onComposePost}
          />
        </div>
      )}

      {!ready && posts.length === 0 ? (
        <div className={styles.loading}>
          <Spinner label="Loading the timeline" />
        </div>
      ) : posts.length === 0 ? (
        <EmptyState variant="feed" />
      ) : (
        <div className={styles.feed}>
          {posts.map((post) => (
            <PostCard
              key={String(post.id)}
              post={post}
              viewer={viewerStates.get(post.id) ?? NO_VIEWER}
              gate={viewer}
              handlers={handlers}
              variant="timeline"
              pending={post.id < 0n}
            />
          ))}
        </div>
      )}
    </>
  );
}
