"use client";

// ComposePage — the FULL-PAGE composer fallback for the real route /compose/ (surface 09 §1/§3.1).
//
// The PRIMARY compose presentation is the ComposerModal overlay owned by <ModalRouteHost> (mounted in
// AppShell) — opened from the LeftNav "Post" pill, the ComposeFab, a card Reply/Quote, or the "Poll"
// entry, WITHOUT a route swap so the timeline keeps streaming behind the scrim. THIS file is only the
// COLD presentation: a deep-link / hard-refresh / no-JS share of /compose/ (§3.1). It is NOT a dialog
// (no scrim, no focus trap, no blurred sticky-timeline header) — just a focused header (Cancel + the
// mode label) over the same Composer family the modal host renders. One source of truth: the Composer
// owns the Post CTA + the byte-counter + the validity/capacity/session gate; this page only resolves
// the mode, hydrates the reply/quote context, and runs the SAME optimistic submit pipeline as
// ModalRouteHost.runWrite (optimistic insert → run(stream) → silent confirm / rollback + toast).
//
// Mode resolution (§1): ?reply=<id> > ?quote=<id> > ?poll=1 > (none → post). The id is validated
// (/^[0-9]+$/) before BigInt so a junk deep link never crashes the route.
//
// Capacity gate (§5.1): mirrors HomePage's composerRateLimited — useHeads + useCapacity + draftStatus.
// pallet-profile is irrelevant here; every post/reply/quote/poll write is FEELESS + capacity-metered
// (spec 117), so there is NO funding / balance gate — capacity exhaustion is the only chain reality
// (inline RateLimitNotice via the rateLimited prop, owned by the Composer).
//
// NOTIFICATIONS SEAM (§13 — DEFERRED): a reply carries parent=Some(id) and a quote carries quoted_id,
// so the reply/quote edges a future useNotifications(who) would fold are created here already. Not
// built in v1 — this note keeps the flow notification-friendly.

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./ComposePage.module.css";
import { Composer } from "@/components/Composer";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ReplyComposer } from "@/components/ReplyComposer";
import { QuoteComposer } from "@/components/QuoteComposer";
import { PollComposer } from "@/components/PollComposer";
import { Spinner } from "@/components/icons";
import { useSession } from "@/components/Providers";
import { useThread } from "@/hooks/useThread";
import { useOptimistic } from "@/hooks/useOptimistic";
import { nextPendingId } from "@/lib/optimistic";
import { useMutation } from "@/hooks/useMutation";
import { useActionToast } from "@/hooks/useActionToast";
import { useCapacity } from "@/hooks/useCapacity";
import { useHeads } from "@/hooks/useHeads";
import { draftStatus } from "@/lib/chain/capacity";
import {
  submitPost,
  submitReply,
  submitQuote,
  submitCreatePoll,
} from "@/lib/chain/mutations";
import type { ActionState, ComposerDraft, ComposerMode, PollDraft } from "@/components/kit";
import type { CognoPost } from "@/lib/types";

/** Only a canonical decimal u64 is a valid reply/quote target; reject anything else (no BigInt throw). */
function parseTargetId(raw: string | null): bigint | null {
  if (raw == null || !/^[0-9]+$/.test(raw)) return null;
  try {
    return BigInt(raw);
  } catch {
    return null;
  }
}

const TITLES: Record<ComposerMode, string> = {
  post: "Compose post",
  reply: "Reply",
  quote: "Quote",
  poll: "Create poll",
};

export function ComposePage() {
  const router = useRouter();
  const params = useSearchParams();
  const { api, client, signer, source, viewer } = useSession();

  // ── Mode resolution (§1): precedence reply > quote > poll > post; defensive against junk ids. ──
  const replyId = parseTargetId(params.get("reply"));
  const quoteId = parseTargetId(params.get("quote"));
  const wantsPoll = params.get("poll") === "1";

  const mode: ComposerMode = replyId != null
    ? "reply"
    : quoteId != null
      ? "quote"
      : wantsPoll
        ? "poll"
        : "post";

  const targetId = mode === "reply" ? replyId : mode === "quote" ? quoteId : null;
  const needsTarget = mode === "reply" || mode === "quote";

  // ── Cold-load context hydration: resolve the reply/quote target through the SEAM (thread → root),
  //    exactly as ModalRouteHost does (never a concrete reader). Only fetched for reply/quote. ──
  const { thread, loading: targetLoading } = useThread(source, needsTarget ? targetId : null);
  const targetPost: CognoPost | null = needsTarget ? thread?.root ?? null : null;
  const contextUnavailable = needsTarget && targetId != null && !targetLoading && !targetPost;
  // When the reply/quote target can't be resolved the composer degrades to a top-level post, so the
  // header must say "Post", not the stale "Reply"/"Quote".
  const effectiveMode = contextUnavailable ? "post" : mode;

  // ── Write pipeline (mirror ModalRouteHost.runWrite) ──────────────────────────────────────────
  const { addPending, dropPending, failPending } = useOptimistic();
  const { run } = useMutation();
  const { phase } = useActionToast();
  const [submitState, setSubmitState] = useState<ActionState>("idle");

  // The poll draft lives here (controlled by PollComposer) — same shape ModalRouteHost seeds.
  const [pollDraft, setPollDraft] = useState<PollDraft>({ question: "", options: ["", ""] });

  // Controlled text so the capacity gate measures the live draft (and a rollback can restore it).
  const [text, setText] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Uncontrolled reply/quote drafts report dirtiness here so Cancel can confirm before discarding.
  const composerDirtyRef = useRef(false);

  // ── Capacity gate (§5.1) — mirror HomePage.composerRateLimited. Profile is irrelevant; every
  //    write here is feeless + capacity-metered, so capacity exhaustion is the only gate. ──
  const heads = useHeads(client);
  const bestBlock = heads.best?.number ?? null;
  const { view: capacityView, consts: capacityConsts } = useCapacity(api, viewer.address ?? null, bestBlock);

  // The text the capacity gate measures: the post/reply/quote draft, or the poll question.
  const gateText = mode === "poll" ? pollDraft.question : text;
  const rateLimited = useMemo(() => {
    if (viewer.status !== "ready" || !capacityView || !capacityConsts) return false;
    const byteLen = new TextEncoder().encode(gateText).length;
    if (byteLen === 0) {
      // probe the base cost so a fully-exhausted bucket still disables the CTA on an empty draft
      const probe = draftStatus(capacityView, 0, capacityConsts);
      return probe.kind === "charging" || probe.kind === "wait";
    }
    // Zero locked ADA (weight 0) is surfaced separately as "lock ADA to post", NOT as a rate limit.
    // Any OTHER non-ok kind (incl. the weight>0 / rate==0 no_weight edge) still disables via rateLimited.
    const k = draftStatus(capacityView, byteLen, capacityConsts).kind;
    return k !== "ok" && !(k === "no_weight" && capacityView.weight === 0n);
  }, [viewer.status, capacityView, capacityConsts, gateText]);
  // Ready account with zero posting power (locked-ADA weight 0) → the honest "lock ADA to post" gate.
  const noPostingPower =
    viewer.status === "ready" && !!capacityView && capacityView.weight === 0n;

  // ── goBack: prefer in-app history; else land on Home (§6.1 step 3 / Cancel). ─────────────────
  const goBack = useCallback(() => {
    if (typeof window !== "undefined" && window.history.length > 1) router.back();
    else router.push("/");
  }, [router]);

  const onComposerDirty = useCallback((dirty: boolean) => {
    composerDirtyRef.current = dirty;
  }, []);

  // Dirty = the composer holds non-whitespace text. reply/quote WITH a resolved target use the
  // uncontrolled composers (→ composerDirtyRef); everything else (post, poll question, and the
  // reply/quote fallbacks) lives in host state (text / pollDraft).
  const isDirty = useCallback(() => {
    if (mode === "poll") {
      return pollDraft.question.trim() !== "" || pollDraft.options.some((o) => o.trim() !== "");
    }
    if ((mode === "reply" || mode === "quote") && targetPost) return composerDirtyRef.current;
    return text.trim() !== "";
  }, [mode, pollDraft, targetPost, text]);

  // Cancel / back with a dirty draft → confirm first. A successful submit navigates via the raw
  // goBack (runWrite) after clearing the draft, so it never asks.
  const requestBack = useCallback(() => {
    if (isDirty()) setConfirmDiscard(true);
    else goBack();
  }, [isDirty, goBack]);

  // Build a minimal optimistic CognoPost for the pending card (the real row replaces it on confirm).
  const optimisticPost = useCallback(
    (body: string, extra: Partial<CognoPost> = {}): CognoPost => ({
      id: nextPendingId(), // strictly-negative unique sentinel — never collides with a real post id
      author: viewer.address ?? signer.ss58,
      text: body,
      at: 0,
      authorDisplayName: viewer.displayName,
      authorAvatar: viewer.avatar,
      ...extra,
    }),
    [viewer.address, viewer.displayName, viewer.avatar, signer.ss58],
  );

  // The shared submit pipeline: optimistic insert → navigate away → run(stream) with a phase() status
  // toast (sticky "…ing" → "…ed" + "View →" at inBestBlock, or dismissed + fail() on error). Rollback
  // on error/cancel — this page can unmount on navigation, so onCancel drops the sticky pending too.
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
      goBack();
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
    [api, signer, addPending, dropPending, failPending, run, phase, router, goBack],
  );

  // ── Per-mode submit handlers ─────────────────────────────────────────────────────────────────
  const onPost = useCallback(
    (draft: ComposerDraft) => {
      // Session-gated submit reroutes to /welcome (the Composer relabels the CTA; §5.3).
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || draft.text.trim().length === 0) return;
      runWrite(submitPost(api, signer, draft.text), optimisticPost(draft.text), {
        pending: "Posting…",
        success: "Posted",
      });
    },
    [viewer.status, api, signer, runWrite, optimisticPost, router],
  );

  const onReply = useCallback(
    (replyText: string) => {
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || !targetPost || replyText.trim().length === 0) return;
      runWrite(
        submitReply(api, signer, replyText, targetPost.id),
        optimisticPost(replyText, { parent: targetPost.id }),
        { pending: "Replying…", success: "Replied" },
        targetPost.id,
      );
    },
    [viewer.status, api, signer, targetPost, runWrite, optimisticPost, router],
  );

  const onQuote = useCallback(
    (quoteText: string) => {
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || !targetPost || quoteText.trim().length === 0) return;
      runWrite(
        submitQuote(api, signer, quoteText, targetPost.id),
        optimisticPost(quoteText, {
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
    [viewer.status, api, signer, targetPost, runWrite, optimisticPost, router],
  );

  const onCreatePoll = useCallback(
    (question: string, options: string[]) => {
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || question.trim().length === 0) return;
      runWrite(submitCreatePoll(api, signer, question, options), optimisticPost(question, { isPoll: true }), {
        pending: "Creating poll…",
        success: "Poll created",
      });
    },
    [viewer.status, api, signer, runWrite, optimisticPost, router],
  );

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.cancel} onClick={requestBack}>
          Cancel
        </button>
        <h1 className={styles.title}>{TITLES[effectiveMode]}</h1>
      </header>

      <div className={styles.body}>
        {/* reply/quote: hydrate the target post for context; busy placeholder then the composer. */}
        {needsTarget && targetLoading && (
          <div className={styles.contextLoading} aria-busy>
            <Spinner size="md" label="Loading the post" />
          </div>
        )}

        {/* Missing/pruned target → muted stub, but keep the composer usable (§8). */}
        {contextUnavailable && (
          <p className={styles.contextUnavailable} role="status">
            This post is unavailable.
          </p>
        )}

        {mode === "post" && (
          <Composer
            viewer={viewer}
            mode="post"
            submitState={submitState}
            text={text}
            onTextChange={setText}
            rateLimited={rateLimited}
            noPostingPower={noPostingPower}
            autoFocus
            onTogglePoll={() => router.push("/compose/?poll=1")}
            onSubmit={onPost}
            onCancel={requestBack}
          />
        )}

        {mode === "reply" && (
          // Target loads async; render the composer once present (or once we know it's unavailable,
          // when targetPost stays null and the muted stub above explains why — but a reply NEEDS a
          // parent id, so without the post we only show the post-mode fallback is wrong; keep waiting).
          targetPost ? (
            <ReplyComposer
              viewer={viewer}
              replyTo={targetPost}
              submitState={submitState}
              rateLimited={rateLimited}
              noPostingPower={noPostingPower}
              autoFocus
              submitReply={onReply}
              onCancel={requestBack}
              onDirtyChange={onComposerDirty}
            />
          ) : (
            !targetLoading && (
              // No resolvable parent → fall back to a top-level post so the deep link is never dead.
              <Composer
                viewer={viewer}
                mode="post"
                submitState={submitState}
                text={text}
                onTextChange={setText}
                rateLimited={rateLimited}
                noPostingPower={noPostingPower}
                autoFocus
                onSubmit={onPost}
                onCancel={requestBack}
              />
            )
          )
        )}

        {mode === "quote" && (
          targetPost ? (
            <QuoteComposer
              viewer={viewer}
              quoted={targetPost}
              submitState={submitState}
              rateLimited={rateLimited}
              noPostingPower={noPostingPower}
              autoFocus
              submitQuote={onQuote}
              onCancel={requestBack}
              onDirtyChange={onComposerDirty}
            />
          ) : (
            !targetLoading && (
              <Composer
                viewer={viewer}
                mode="post"
                submitState={submitState}
                text={text}
                onTextChange={setText}
                rateLimited={rateLimited}
                noPostingPower={noPostingPower}
                autoFocus
                onSubmit={onPost}
                onCancel={requestBack}
              />
            )
          )
        )}

        {mode === "poll" && (
          <PollComposer
            viewer={viewer}
            pollDraft={pollDraft}
            onChange={setPollDraft}
            submitState={submitState}
            rateLimited={rateLimited}
            noPostingPower={noPostingPower}
            autoFocus
            submitCreatePoll={onCreatePoll}
            onCancel={requestBack}
          />
        )}
      </div>

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard this draft?"
          body="Your unsent text will be lost."
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          danger
          onConfirm={() => {
            setConfirmDiscard(false);
            goBack();
          }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}
    </div>
  );
}

export default ComposePage;
