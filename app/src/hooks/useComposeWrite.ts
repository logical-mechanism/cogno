"use client";

// useComposeWrite — the compose submit pipeline shared by the two surfaces that own one: the modal
// host (ModalRouteHost) and the full-page composer (ComposePage).
//
// Their `runWrite` callbacks were the same forty lines, down to an identical three-line comment inside
// onConfirm, differing in exactly ONE token: `onClose()` vs `goBack()`. That token is now the `dismiss`
// argument, and the navigation stays where it belongs — the modal pops history and closes a store; the
// page calls router.back(). The hook never learns which.
//
// SCOPE, deliberately narrow. Home's inline composer and ThreadView's reply composer do NOT use this and
// should not be made to: Home has no dismiss, no submitState and a bespoke error path that restores the
// DISPLAY text (not the serialized body), and ThreadView routes its optimism through useThread's
// addOptimisticReply/confirmReply rather than useOptimistic's addPending/dropPending. They are different
// pipelines that happen to end in a post, not copies of this one.
//
// The DRAFT STORE is not in here, on purpose. `clearPostDraft()` stays in each caller's onPost. Home
// never SAVES a draft, and there is a single global draft key — so a shared clear, once Home adopted it,
// would silently wipe the modal's saved draft the moment anyone posted from the inline box.

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "./useMutation";
import { useActionToast } from "./useActionToast";
import { useOptimistic } from "./useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import type { submitPost } from "@/lib/chain/mutations";
import type { ActionState, Viewer } from "@/components/kit";
import type { CognoPost, PostingSigner, CognoApi } from "@/lib/types";

export interface UseComposeWrite {
  /** Drives the composer CTA (disabled + "Posting…" spinner) while a write is in flight. */
  submitState: ActionState;
  /**
   * Reset the submit state. REQUIRED by ModalRouteHost, which is mounted once in AppShell and NEVER
   * unmounts — so unlike ComposePage (which gets a fresh "idle" on every visit by remounting), its only
   * reset is the per-open effect. Without it, `runWrite` sets "pending", dismisses, and the state stays
   * pending for the whole in-flight tx: reopen the composer and you get a disabled, spinning CTA with no
   * way to post until the first tx settles.
   */
  setSubmitState: (s: ActionState) => void;
  /** Optimistic insert → dismiss → run, with the sticky status toast and rollback on error/cancel. */
  runWrite: (
    stream: ReturnType<typeof submitPost>,
    optimistic: CognoPost,
    feedback: { pending: string; success: string },
    parentId?: bigint,
  ) => void;
  /** Build the minimal optimistic CognoPost for the pending card (the real row replaces it on confirm). */
  optimisticPost: (text: string, extra?: Partial<CognoPost>) => CognoPost;
}

export function useComposeWrite(
  api: CognoApi | null,
  signer: PostingSigner,
  viewer: Viewer,
  /** How this surface gets out of the way once the write is submitted (modal close / router.back). */
  dismiss: () => void,
): UseComposeWrite {
  const router = useRouter();
  const { addPending, dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { phase } = useActionToast();
  const [submitState, setSubmitState] = useState<ActionState>("idle");

  const runWrite = useCallback(
    (
      stream: ReturnType<typeof submitPost>,
      optimistic: CognoPost,
      feedback: { pending: string; success: string },
      parentId?: bigint,
    ) => {
      if (!api || !signer) return;
      const clientId = addPending(optimistic, parentId);
      setSubmitState("pending");
      dismiss();
      void run(
        stream,
        phase({
          id: clientId,
          pending: feedback.pending,
          success: feedback.success,
          view: (u) =>
            u.postId != null
              ? { label: "View →", onClick: () => router.push(`/post/${u.postId}/`) }
              : undefined,
          onConfirm: () => {
            // Top-level posts/quotes are retired by the feed presence-reconcile when their real twin
            // lands (no confirm-time blink). Replies live in a thread with no such reconcile, so they
            // still hand off on confirm.
            if (parentId != null) dropPending(clientId);
            setSubmitState("ok");
          },
          onError: () => {
            failPending(clientId);
            setSubmitState("error");
          },
          // Fires on the OWNING surface's unmount, so what this means depends on the caller — and that
          // asymmetry is real, not noise. In ComposePage (unmounts on navigation) this is the live path
          // that drops the sticky pending toast when the user navigates away mid-flight. In the modal
          // host (mounted once in AppShell, never unmounts) it is unreachable. Keep it: it is dead in one
          // caller, load-bearing in the other, and deleting it because you watched the modal is a bug.
          onCancel: () => failPending(clientId),
        }),
      );
    },
    [api, signer, addPending, dropPending, failPending, run, phase, router, dismiss],
  );

  const optimisticPost = useCallback(
    (text: string, extra: Partial<CognoPost> = {}): CognoPost => ({
      id: nextPendingId(), // strictly-negative unique sentinel — never collides with a real post id
      author: viewer.address ?? signer.ss58,
      text,
      at: 0,
      authorDisplayName: viewer.displayName,
      authorAvatar: viewer.avatar,
      ...extra,
    }),
    [viewer.address, viewer.displayName, viewer.avatar, signer.ss58],
  );

  return { submitState, setSubmitState, runWrite, optimisticPost };
}
