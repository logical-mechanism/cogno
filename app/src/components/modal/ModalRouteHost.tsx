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
import { useRouter } from "next/navigation";
import { ComposerModal } from "../ComposerModal";
import { Composer } from "../Composer";
import { ReplyComposer } from "../ReplyComposer";
import { QuoteComposer } from "../QuoteComposer";
import { PollComposer } from "../PollComposer";
import { EditProfileModal } from "../EditProfileModal";
import { useSession } from "../Providers";
import { useModalStore } from "@/lib/modalStore";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useThread } from "@/hooks/useThread";
import { useCapacity } from "@/hooks/useCapacity";
import { draftStatus } from "@/lib/chain/capacity";
import { useToaster, RATE_LIMIT_COPY } from "../toast/ToasterProvider";
import {
  submitPost,
  submitReply,
  submitQuote,
  submitCreatePoll,
  submitSetProfile,
  submitClearProfile,
} from "@/lib/chain/mutations";
import type { ActionState, ComposerDraft, PollDraft, ModalKind } from "../kit";
import type { CognoPost } from "@/lib/types";
import type { ProfileFields } from "../EditProfileModal";

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
  const { addPending, dropPending, failPending, patchProfile, confirmProfile, rollbackProfile } =
    useOptimistic();
  const { run } = useMutation();
  const { toast, rateLimit } = useToaster();
  const { phase } = useActionToast();
  const router = useRouter();

  // Zero locked ADA → no posting power: hard-disable the composer CTA (the self-contained
  // NoPostingPowerNotice already shows the "Lock ADA to post" banner), matching HomePage/ComposePage.
  const { view: capacityView, consts: capacityConsts } = useCapacity(api, viewer.address ?? null, bestBlock);
  const noPostingPower = viewer.status === "ready" && !!capacityView && capacityView.weight === 0n;

  const [submitState, setSubmitState] = useState<ActionState>("idle");
  const [pollDraft, setPollDraft] = useState<PollDraft>({ question: "", options: ["", ""] });
  // Controlled text for the base compose mode so the capacity gate measures the live draft (reply /
  // quote stay uncontrolled — their gate uses the empty-draft base-cost probe, exactly like ComposePage).
  const [text, setText] = useState("");

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
    setText("");
    if (kind === "poll") setPollDraft({ question: "", options: ["", ""] });
  }, [kind]);

  // Pre-flight capacity gate — mirror ComposePage so the PRIMARY (overlay) compose path also disables
  // the CTA + shows the inline RateLimitNotice before submit, instead of only surfacing a rate limit
  // via the post-submit failure toast (D5).
  const gateText = kind === "poll" ? pollDraft.question : text;
  const rateLimited = useMemo(() => {
    if (viewer.status !== "ready" || !capacityView || !capacityConsts) return false;
    const byteLen = new TextEncoder().encode(gateText).length;
    if (byteLen === 0) {
      const probe = draftStatus(capacityView, 0, capacityConsts);
      return probe.kind === "charging" || probe.kind === "wait";
    }
    const k = draftStatus(capacityView, byteLen, capacityConsts).kind;
    return k !== "ok" && !(k === "no_weight" && capacityView.weight === 0n);
  }, [viewer.status, capacityView, capacityConsts, gateText]);

  const onClose = useCallback(() => {
    // Pop the pushed URL (if any) then clear the store. The popstate handler also calls close(); the
    // store no-op guard makes the double call harmless.
    if (kind && kind !== "edit-profile" && typeof window !== "undefined" && window.history.state?.cgModal) {
      window.history.back();
    }
    close();
  }, [kind, close]);

  // The shared submit pipeline: optimistic insert → close → run(stream) with a phase() status toast
  // (sticky "…ing" → "…ed" + "View →" at inBestBlock, or dismissed + fail() on error). Rollback on
  // error/cancel. The modal host persists after close(), so the background run still upgrades the toast.
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
      onClose();
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
          onCancel: () => failPending(clientId),
        }),
      ).catch(() => {
        /* settled + rolled back via onError */
      });
    },
    [api, signer, addPending, dropPending, failPending, run, phase, router, onClose],
  );

  // Build a minimal optimistic CognoPost for the pending card (the real row replaces it on confirm).
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

  const onPost = useCallback(
    (draft: ComposerDraft) => {
      if (!api || !signer || draft.text.trim().length === 0) return;
      runWrite(submitPost(api, signer, draft.text), optimisticPost(draft.text), {
        pending: "Posting…",
        success: "Posted",
      });
    },
    [api, signer, runWrite, optimisticPost],
  );

  const onReply = useCallback(
    (text: string) => {
      if (!api || !signer || !targetPost || text.trim().length === 0) return;
      runWrite(
        submitReply(api, signer, text, targetPost.id),
        optimisticPost(text, { parent: targetPost.id }),
        { pending: "Replying…", success: "Replied" },
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
        { pending: "Quoting…", success: "Quoted" },
      );
    },
    [api, signer, targetPost, runWrite, optimisticPost],
  );

  const onCreatePoll = useCallback(
    (question: string, options: string[]) => {
      if (!api || !signer || question.trim().length === 0) return;
      runWrite(submitCreatePoll(api, signer, question, options), optimisticPost(question, { isPoll: true }), {
        pending: "Creating poll…",
        success: "Poll created",
      });
    },
    [api, signer, runWrite, optimisticPost],
  );

  // ── profile save/clear pipeline (feeless + capacity-metered, exactly like a post) ────────────────
  // Owned HERE (the persistent host), not in EditProfileModal, so the modal can close INSTANTLY while
  // this tx runs to confirmation in the background: apply the optimistic overlay → close + sticky
  // "Saving…" toast → on confirm keep the overlay (retired by a fresh read) + swap to a success toast;
  // on error roll the overlay back + surface the failure. The whole app reflects the edit at once.
  const runProfileWrite = useCallback(
    (
      stream: ReturnType<typeof submitSetProfile>,
      patch: ProfileFields,
      pendingCopy: string,
      successCopy: string,
    ) => {
      if (!api || !signer) return;
      // Key the overlay by the account the profile view reads under (self-view: viewer.address === url).
      const ss58 = viewer.address ?? signer.ss58;
      patchProfile(ss58, patch);
      toast({ id: "profile-save", kind: "pending", message: pendingCopy });
      onClose();
      void run(stream, {
        onConfirm: () => {
          confirmProfile(ss58);
          toast({ id: "profile-save", kind: "success", message: successCopy });
        },
        onError: (message: string) => {
          rollbackProfile(ss58);
          if (isRateLimit(message)) toast({ id: "profile-save", kind: "rate-limit", message: RATE_LIMIT_COPY });
          else toast({ id: "profile-save", kind: "error", message });
        },
      }).catch(() => {
        /* settled + rolled back via onError */
      });
    },
    [api, signer, viewer.address, patchProfile, confirmProfile, rollbackProfile, run, toast, onClose],
  );

  const onSaveProfile = useCallback(
    (fields: ProfileFields) => {
      if (!api || !signer) return;
      runProfileWrite(
        submitSetProfile(
          api,
          signer,
          fields.displayName,
          fields.bio,
          fields.avatar,
          fields.banner,
          fields.location,
          fields.website,
        ),
        fields,
        "Saving your profile…",
        "Profile updated",
      );
    },
    [api, signer, runProfileWrite],
  );

  const onClearProfile = useCallback(() => {
    if (!api || !signer) return;
    const empty: ProfileFields = {
      displayName: "",
      bio: "",
      avatar: "",
      banner: "",
      location: "",
      website: "",
    };
    runProfileWrite(submitClearProfile(api, signer), empty, "Clearing your profile…", "Profile cleared");
  }, [api, signer, runProfileWrite]);

  const title = useMemo(() => (kind ? TITLES[kind] : ""), [kind]);

  if (!kind) return null;

  // edit-profile has its own modal chrome. The host owns the write (optimistic + toast + close), so the
  // modal is presentational — it collects the fields and hands them up via onSaveProfile / onClearProfile.
  if (kind === "edit-profile") {
    return (
      <EditProfileModal
        onClose={onClose}
        onSaveProfile={onSaveProfile}
        onClearProfile={onClearProfile}
      />
    );
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
          rateLimited={rateLimited}
          text={text}
          onTextChange={setText}
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
          rateLimited={rateLimited}
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
          rateLimited={rateLimited}
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
          rateLimited={rateLimited}
          autoFocus
          submitCreatePoll={onCreatePoll}
          onCancel={onClose}
        />
      )}
    </ComposerModal>
  );
}
