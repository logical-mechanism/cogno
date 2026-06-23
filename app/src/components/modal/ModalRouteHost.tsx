"use client";

// ModalRouteHost — the single overlay host mounted once in AppShell (doc 01 §7.2).
//
// It subscribes to the client modalStore and renders the matching composer inside ComposerModal chrome
// WITHOUT a route swap — <main> never unmounts, so the live source.watch() subscription keeps streaming
// behind the modal (X-exact). It keeps the URL in sync via the History API directly (history.pushState
// / history.back), NOT next/router: opening pushes a shareable /compose/?reply=<id>/?quote=<id> URL;
// closing pops it. On a COLD load of /compose/ the full-page fallback is ComposePage (doc 01 §7.1) — this
// host only handles the in-app overlay path, so it does NOT open itself from the URL on mount.
//
// This host is the "surface" that owns the write for compose/reply/quote/poll: it holds useMutation +
// the optimistic insert + capacity gate and wires each composer to @/lib/chain/mutations. edit-profile
// renders the EditProfileModal (its own modal chrome). It NEVER builds an extrinsic outside the mutations
// module.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ComposerModal } from "../ComposerModal";
import { Composer } from "../Composer";
import { ReplyComposer } from "../ReplyComposer";
import { QuoteComposer } from "../QuoteComposer";
import { PollComposer } from "../PollComposer";
import { EditProfileModal } from "../EditProfileModal";
import { useSession } from "../Providers";
import { useModalStore } from "@/lib/modalStore";
import { useMutation } from "@/hooks/useMutation";
import { useOptimistic } from "@/hooks/useOptimistic";
import { useThread } from "@/hooks/useThread";
import { useCapacity } from "@/hooks/useCapacity";
import { useToaster, RATE_LIMIT_COPY } from "../toast/ToasterProvider";
import {
  submitPost,
  submitReply,
  submitQuote,
  submitCreatePoll,
} from "@/lib/chain/mutations";
import type { ActionState, ComposerDraft, PollDraft, ModalKind } from "../kit";
import type { CognoPost } from "@/lib/types";

/** The CheckCapacity pool rejection surfaces as the rate-limit copy (stringifyError maps it). */
function isRateLimit(message: string): boolean {
  return /rate limit|ExhaustsResources/i.test(message);
}

const TITLES: Record<Exclude<ModalKind, null>, string> = {
  compose: "Compose post",
  reply: "Reply",
  quote: "Quote",
  poll: "Create poll",
  "edit-profile": "Edit profile",
};

/** Push the shareable overlay URL for a mode without swapping <main> (History API, doc 01 §7.2). */
function pushModalUrl(kind: Exclude<ModalKind, null>, targetId?: string) {
  if (typeof window === "undefined") return;
  const base = "/compose/";
  let url = base;
  if (kind === "reply" && targetId) url = `${base}?reply=${targetId}`;
  else if (kind === "quote" && targetId) url = `${base}?quote=${targetId}`;
  // poll/compose share /compose/; edit-profile keeps the current URL (its fallback is /settings/).
  if (kind === "edit-profile") return;
  try {
    window.history.pushState({ cgModal: kind }, "", url);
  } catch {
    /* history may be unavailable in some embeds; the overlay still works in-memory */
  }
}

export function ModalRouteHost() {
  const { state, close } = useModalStore();
  const { api, signer, source, viewer, bestBlock } = useSession();
  const { addPending, dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { toast, rateLimit } = useToaster();

  // Zero locked ADA → no posting power: hard-disable the composer CTA (the self-contained
  // NoPostingPowerNotice already shows the "Lock ADA to post" banner), matching HomePage/ComposePage.
  const { view: capacityView } = useCapacity(api, viewer.address ?? null, bestBlock);
  const noPostingPower = viewer.status === "ready" && !!capacityView && capacityView.weight === 0n;

  const [submitState, setSubmitState] = useState<ActionState>("idle");
  const [pollDraft, setPollDraft] = useState<PollDraft>({ question: "", options: ["", ""] });

  const kind = state.kind;
  const targetId = state.targetId ? BigInt(state.targetId) : null;

  // Resolve the reply/quote target post through the SEAM (source.thread → root), never a concrete
  // reader. Only fetched while a reply/quote modal is open.
  const needsTarget = kind === "reply" || kind === "quote";
  const { thread } = useThread(source, needsTarget ? targetId : null);
  const targetPost: CognoPost | null = needsTarget ? thread?.root ?? null : null;

  // Sync the URL when the overlay opens; restore it (history.back) when it closes via the store.
  useEffect(() => {
    if (kind && kind !== "edit-profile") pushModalUrl(kind, state.targetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, state.targetId]);

  // Back-button closes the overlay (doc 01 §7.2): a popstate while open dismisses without a route swap.
  useEffect(() => {
    if (!kind) return;
    const onPop = () => close();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [kind, close]);

  // Reset the per-open transient state whenever the modal kind changes.
  useEffect(() => {
    setSubmitState("idle");
    if (kind === "poll") setPollDraft({ question: "", options: ["", ""] });
  }, [kind]);

  const onClose = useCallback(() => {
    // Pop the pushed URL (if any) then clear the store. The popstate handler also calls close(); the
    // store no-op guard makes the double call harmless.
    if (kind && kind !== "edit-profile" && typeof window !== "undefined" && window.history.state?.cgModal) {
      window.history.back();
    }
    close();
  }, [kind, close]);

  // The shared submit pipeline: optimistic insert → run(stream) → close on confirm, rollback + toast on
  // error (rate-limit gets the dedicated copy, per D5/D11). Feeless social writes are SILENT on success.
  const runWrite = useCallback(
    (stream: ReturnType<typeof submitPost>, optimistic: CognoPost, parentId?: bigint) => {
      if (!api || !signer) return;
      const clientId = addPending(optimistic, parentId);
      setSubmitState("pending");
      onClose();
      void run(stream, {
        onConfirm: () => {
          dropPending(clientId);
          setSubmitState("ok");
        },
        onError: (message: string) => {
          failPending(clientId);
          setSubmitState("error");
          if (isRateLimit(message)) toast({ id: "rate-limit", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ kind: "error", message });
        },
      }).catch(() => {
        /* settled + rolled back via onError */
      });
    },
    [api, signer, addPending, dropPending, failPending, run, toast, onClose],
  );

  // Build a minimal optimistic CognoPost for the pending card (the real row replaces it on confirm).
  const optimisticPost = useCallback(
    (text: string, extra: Partial<CognoPost> = {}): CognoPost => ({
      id: -BigInt(Date.now()), // negative sentinel id — never collides with a real (positive) post id
      author: viewer.address ?? signer.ss58,
      text,
      at: 0,
      authorDisplayName: viewer.displayName,
      authorAvatar: viewer.avatar,
      ...extra,
    }),
    [viewer.address, viewer.displayName, viewer.avatar, signer.ss58],
  );

  const onPost = useCallback(
    (draft: ComposerDraft) => {
      if (!api || !signer || draft.text.trim().length === 0) return;
      runWrite(submitPost(api, signer, draft.text), optimisticPost(draft.text));
    },
    [api, signer, runWrite, optimisticPost],
  );

  const onReply = useCallback(
    (text: string) => {
      if (!api || !signer || !targetPost || text.trim().length === 0) return;
      runWrite(
        submitReply(api, signer, text, targetPost.id),
        optimisticPost(text, { parent: targetPost.id }),
        targetPost.id,
      );
    },
    [api, signer, targetPost, runWrite, optimisticPost],
  );

  const onQuote = useCallback(
    (text: string) => {
      if (!api || !signer || !targetPost || text.trim().length === 0) return;
      runWrite(
        submitQuote(api, signer, text, targetPost.id),
        optimisticPost(text, {
          quote: {
            id: targetPost.id,
            author: targetPost.author,
            text: targetPost.text,
            authorRevoked: targetPost.authorRevoked ?? false,
            displayName: targetPost.authorDisplayName,
            avatar: targetPost.authorAvatar,
          },
        }),
      );
    },
    [api, signer, targetPost, runWrite, optimisticPost],
  );

  const onCreatePoll = useCallback(
    (question: string, options: string[]) => {
      if (!api || !signer || question.trim().length === 0) return;
      runWrite(submitCreatePoll(api, signer, question, options), optimisticPost(question, { isPoll: true }));
    },
    [api, signer, runWrite, optimisticPost],
  );

  const title = useMemo(() => (kind ? TITLES[kind] : ""), [kind]);

  if (!kind) return null;

  // edit-profile has its own modal chrome + write surface.
  if (kind === "edit-profile") {
    return <EditProfileModal onClose={onClose} />;
  }

  // reply / quote wait for the target post before rendering the composer.
  if (needsTarget && !targetPost) {
    return (
      <ComposerModal title={title} onClose={onClose}>
        <div style={{ minHeight: "120px" }} aria-busy />
      </ComposerModal>
    );
  }

  return (
    <ComposerModal title={title} onClose={onClose}>
      {kind === "compose" && (
        <Composer
          viewer={viewer}
          mode="post"
          submitState={submitState}
          noPostingPower={noPostingPower}
          autoFocus
          onSubmit={onPost}
          onCancel={onClose}
        />
      )}
      {kind === "reply" && targetPost && (
        <ReplyComposer
          viewer={viewer}
          replyTo={targetPost}
          submitState={submitState}
          noPostingPower={noPostingPower}
          autoFocus
          submitReply={onReply}
          onCancel={onClose}
        />
      )}
      {kind === "quote" && targetPost && (
        <QuoteComposer
          viewer={viewer}
          quoted={targetPost}
          submitState={submitState}
          noPostingPower={noPostingPower}
          autoFocus
          submitQuote={onQuote}
          onCancel={onClose}
        />
      )}
      {kind === "poll" && (
        <PollComposer
          viewer={viewer}
          pollDraft={pollDraft}
          onChange={setPollDraft}
          submitState={submitState}
          noPostingPower={noPostingPower}
          autoFocus
          submitCreatePoll={onCreatePoll}
          onCancel={onClose}
        />
      )}
    </ComposerModal>
  );
}
