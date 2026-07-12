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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ComposerModal } from "../ComposerModal";
import { ConfirmDialog } from "../ConfirmDialog";
import { loadPostDraft, savePostDraft, clearPostDraft } from "@/lib/composerDraftStore";
import { Composer } from "../Composer";
import { ReplyComposer } from "../ReplyComposer";
import { QuoteComposer } from "../QuoteComposer";
import { PollComposer } from "../PollComposer";
import { EditProfileModal } from "../EditProfileModal";
import { useSession } from "../Providers";
import { modalActions, useModalStore } from "@/lib/modalStore";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useThread } from "@/hooks/useThread";
import { useInvalidateAccountProfile } from "@/hooks/useAccountProfile";
import { invalidateHoverProfile } from "../ProfileHoverCard";
import { useComposerGate } from "@/hooks/useComposerGate";
import { useToaster } from "../toast/ToasterProvider";
import { errorCopy } from "@/lib/chain/errors";
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
  const { api, signer, source, viewer } = useSession();
  const { addPending, dropPending, failPending, patchProfile, confirmProfile, rollbackProfile } =
    useOptimistic();
  const { run } = useMutation();
  const { toast } = useToaster();
  const invalidateAccountProfile = useInvalidateAccountProfile();
  const { phase } = useActionToast();
  const router = useRouter();

  const [submitState, setSubmitState] = useState<ActionState>("idle");
  const [pollDraft, setPollDraft] = useState<PollDraft>({ question: "", options: ["", ""] });
  // Controlled text for the base compose mode so the capacity gate measures the live draft (reply /
  // quote stay uncontrolled — their gate uses the empty-draft base-cost probe, exactly like ComposePage).
  const [text, setText] = useState("");
  // The SERIALIZED compose body (mention `@name` tokens expanded to `@<ss58>`), reported by the base
  // Composer, so the capacity gate counts the real posted length rather than the short display text.
  const [serialized, setSerialized] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Uncontrolled reply/quote drafts report dirtiness here so a close can confirm before discarding.
  const composerDirtyRef = useRef(false);
  // Carries the in-flight words across a compose↔poll flip (see the reset effect). A ref, not state:
  // the flip is driven by the modal store, so the reset effect below runs on the NEXT render with the
  // new `kind` and would otherwise clobber anything the toggle handler had set.
  const carryRef = useRef<string | null>(null);

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
  }, [kind, state.targetId]);

  // Back-button closes the overlay (doc 01 §7.2): a popstate while open dismisses without a route swap.
  useEffect(() => {
    if (!kind) return;
    const onPop = () => close();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [kind, close]);

  // Reset the per-open transient state whenever the modal kind changes (also on close → kind null).
  // Opening the plain composer HYDRATES the persisted post draft (localStorage) so an accidental close
  // or reload didn't lose it; other kinds start empty.
  //
  // EXCEPT across a compose↔poll flip, which is a mode swap within one open modal, not a new open. The
  // flip hands the user's in-flight words through `carryRef` (a post's text IS a poll's question), so
  // toggling does not silently blank the textarea they were typing in.
  useEffect(() => {
    const carried = carryRef.current;
    carryRef.current = null;
    setSubmitState("idle");
    setText(kind === "compose" ? (carried ?? loadPostDraft()) : "");
    setSerialized(""); // the base Composer re-reports on mount; reply/quote leave it "" (base-cost gate)
    setConfirmDiscard(false);
    composerDirtyRef.current = false;
    if (kind === "poll") setPollDraft({ question: carried ?? "", options: ["", ""] });
  }, [kind]);

  // Persist the plain-compose draft as it changes (savePostDraft removes the key when it's empty).
  useEffect(() => {
    if (kind === "compose") savePostDraft(text);
  }, [kind, text]);

  // Pre-flight capacity gate (shared with every other composing surface — see useComposerGate).
  // Non-poll compose measures the SERIALIZED body (mention tokens count as their ss58 length); reply /
  // quote are uncontrolled → `serialized` stays "" and the gate uses the base-cost probe, as before.
  // `noPostingPower` also feeds EditProfileModal below — profile writes are capacity-metered too.
  const gateText = kind === "poll" ? pollDraft.question : serialized;
  const { rateLimited, noPostingPower } = useComposerGate(gateText);

  const onClose = useCallback(() => {
    // Pop the pushed URL (if any) then clear the store. The popstate handler also calls close(); the
    // store no-op guard makes the double call harmless.
    if (kind && kind !== "edit-profile" && typeof window !== "undefined" && window.history.state?.cgModal) {
      window.history.back();
    }
    close();
  }, [kind, close]);

  const onComposerDirty = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
  }, []);

  // A draft is "dirty" when the composer holds non-whitespace text (poll: the question or any option).
  const isDirty = useCallback(() => {
    if (kind === "poll") {
      return pollDraft.question.trim() !== "" || pollDraft.options.some((o) => o.trim() !== "");
    }
    return composerDirtyRef.current;
  }, [kind, pollDraft]);

  // User-initiated close (Esc / ✕ / dim-click / Cancel): confirm before discarding a dirty draft. A
  // successful submit closes via the raw onClose (runWrite) after clearing the draft, so it never asks.
  const onRequestClose = useCallback(() => {
    if (isDirty()) setConfirmDiscard(true);
    else onClose();
  }, [isDirty, onClose]);

  // The in-modal compose↔poll mode swap. Until this existed, `openPoll()` had exactly ONE caller —
  // Home's inline composer, which is `display: none` below 688px — so poll creation was unreachable on
  // mobile entirely, and on desktop unless you composed from the inline box. Both the LeftNav "Post"
  // pill and the mobile FAB open THIS modal, which supported `kind === "poll"` all along with nothing
  // able to ask for it. Each direction hands its in-flight words to the other (see `carryRef`).
  const toPoll = useCallback(() => {
    carryRef.current = text;
    modalActions.openPoll();
  }, [text]);

  const toCompose = useCallback(() => {
    carryRef.current = pollDraft.question;
    modalActions.openCompose();
  }, [pollDraft.question]);

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
      );
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
      clearPostDraft(); // submitted → don't restore it next time
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
          // MANDATORY, not polish: confirmProfile's overlay is TTL-backed and evaporates on its own, so
          // without dropping the caches the chrome avatar, every mention chip and every hover card
          // silently revert to the pre-edit name/avatar once it expires — and the hover card's own cache
          // had no expiry at all, so it stayed stale for the whole session.
          invalidateAccountProfile(ss58);
          invalidateHoverProfile(ss58);
          toast({ id: "profile-save", kind: "success", message: successCopy });
        },
        onError: (error) => {
          rollbackProfile(ss58);
          // Re-toast under the SAME id on purpose: "profile-save" is the sticky pending toast above,
          // which has NO auto-dismiss (pending: null). Replacing it in place is the only thing that
          // clears it. Route this through useActionToast.fail() — whose toast ids are "rate-limit" and
          // a fresh nextId() — and "Saving your profile…" spins on the app-wide toast bus forever.
          toast({
            id: "profile-save",
            kind: error.kind === "rate-limit" ? "rate-limit" : "error",
            message: errorCopy(error),
          });
        },
      });
    },
    [
      api,
      signer,
      viewer.address,
      patchProfile,
      confirmProfile,
      rollbackProfile,
      invalidateAccountProfile,
      run,
      toast,
      onClose,
    ],
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
        noPostingPower={noPostingPower}
      />
    );
  }

  // reply / quote wait for the target post before rendering the composer.
  if (needsTarget && !targetPost) {
    return (
      <ComposerModal title={title} onClose={onRequestClose}>
        <div style={{ minHeight: "120px" }} aria-busy />
      </ComposerModal>
    );
  }

  return (
    <>
      <ComposerModal title={title} onClose={onRequestClose}>
        {kind === "compose" && (
          <Composer
            viewer={viewer}
            mode="post"
            submitState={submitState}
            noPostingPower={noPostingPower}
            rateLimited={rateLimited}
            text={text}
            onTextChange={setText}
            onSerializedChange={setSerialized}
            autoFocus
            onSubmit={onPost}
            onTogglePoll={toPoll}
            onDirtyChange={onComposerDirty}
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
            onDirtyChange={onComposerDirty}
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
            onDirtyChange={onComposerDirty}
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
            onTogglePoll={toCompose}
          />
        )}
      </ComposerModal>
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          body="Your unsent text will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => {
            clearPostDraft(); // explicit discard → forget the saved draft
            setConfirmDiscard(false);
            onClose();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}
