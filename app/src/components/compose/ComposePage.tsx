"use client";

// ComposePage — the FULL-PAGE composer fallback for the real route /compose/.
//
// The PRIMARY compose presentation is the ComposerModal overlay owned by <ModalRouteHost> (mounted in
// AppShell) — opened from the LeftNav "Post" pill, the ComposeFab, a card Reply/Quote, or the "Poll"
// entry, WITHOUT a route swap so the timeline keeps streaming behind the scrim. THIS file is only the
// COLD presentation: a deep-link / hard-refresh / no-JS share of /compose/. It is NOT a dialog
// (no scrim, no focus trap, no blurred sticky-timeline header) — just a focused header (Cancel + the
// mode label) over the same Composer family the modal host renders. One source of truth: the Composer
// owns the Post CTA + the byte-counter + the validity/capacity/session gate; this page only resolves
// the mode, hydrates the reply/quote context, and runs the SAME optimistic submit pipeline as
// ModalRouteHost.runWrite (optimistic insert → run(stream) → silent confirm / rollback + toast).
//
// Mode resolution: ?reply=<id> > ?quote=<id> > ?poll=1 > (none → post). The id is validated
// (/^[0-9]+$/) before BigInt so a junk deep link never crashes the route.
//
// Capacity gate: the shared useComposerGate, same as every other composing surface.
// pallet-profile is irrelevant here; every post/reply/quote/poll write is FEELESS + capacity-metered
// (spec 117), so there is NO funding / balance gate — capacity exhaustion is the only chain reality
// (inline RateLimitNotice via the rateLimited prop, owned by the Composer).
//

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import styles from "./ComposePage.module.css";
import { Composer } from "@/components/Composer";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ReplyComposer } from "@/components/ReplyComposer";
import { QuoteComposer } from "@/components/QuoteComposer";
import { PollComposer } from "@/components/PollComposer";
import { Loading } from "@/components/Loading";
import { useSession } from "@/components/Providers";
import { useThread } from "@/hooks/useThread";
import { useComposerGate } from "@/hooks/useComposerGate";
import { useComposeWrite } from "@/hooks/useComposeWrite";
import { loadPostDraft, savePostDraft, clearPostDraft } from "@/lib/composerDraftStore";
import {
  submitPost,
  submitReply,
  submitQuote,
  submitCreatePoll,
  resolveCloseAt,
} from "@/lib/chain/mutations";
import { useToaster } from "@/components/toast/ToasterProvider";
import type { ComposerDraft, ComposerMode, PollDraft } from "@/components/kit";
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
  const { api, signer, source, viewer, bestBlock } = useSession();
  const { toast } = useToaster();

  // ── Mode resolution: precedence reply > quote > poll > post; defensive against junk ids. ──
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

  // ── Write pipeline (mirror ModalRouteHost.runWrite) ────────────────────────────────────────────

  // The poll draft lives here (controlled by PollComposer) — same shape ModalRouteHost seeds.
  const [pollDraft, setPollDraft] = useState<PollDraft>({ question: "", options: ["", ""] });

  // Controlled text so the capacity gate measures the live draft (and a rollback can restore it).
  // Hydrate the persisted post draft on mount — but ONLY for a plain-post compose (gated on the stable
  // `mode`, not effectiveMode), so a reply/quote deep-link never leaks the saved post text into its
  // capacity gate. Client-only render behind Suspense, so the lazy initializer is safe.
  const [text, setText] = useState(() => (mode === "post" ? loadPostDraft() : ""));
  // The SERIALIZED post body (mention `@name` tokens expanded to `@<ss58>`), reported up by the base
  // Composer, so the capacity gate counts the real posted length — a mention is ~48 bytes, not `@name`.
  const [serialized, setSerialized] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Uncontrolled reply/quote drafts report dirtiness here so Cancel can confirm before discarding.
  const composerDirtyRef = useRef(false);

  // Persist the plain-post draft as it changes. Gate on the STABLE `mode` (not `effectiveMode`): `text`
  // only holds the real post draft when mode==="post" (it's initialized "" for reply/quote). Using
  // effectiveMode here meant a reply/quote whose target failed to resolve degraded to "post" and ran
  // savePostDraft("") — whose empty branch removeItem()s the key — silently WIPING an unrelated saved
  // draft. mode==="post" never fires for a reply/quote deep link, so the saved draft is preserved.
  useEffect(() => {
    if (mode === "post") savePostDraft(text);
  }, [mode, text]);

  // ── Capacity gate, shared with every other composing surface — see useComposerGate. Profile
  //    is irrelevant; every write here is feeless + capacity-metered, so capacity is the only gate.
  //    The text it measures is the SERIALIZED post/reply/quote body (so mention tokens count as their
  //    ss58 length), or the poll question. Reply/quote are uncontrolled → `serialized` stays "" and the
  //    gate uses the empty-draft base-cost probe, exactly as before.
  //
  //    This used to open its OWN useHeads subscription purely to feed the gate a block number that
  //    useSession already publishes; the shared hook reads the session's, so that second subscription
  //    (and its extra render cadence) is gone.
  const gateText = mode === "poll" ? pollDraft.question : serialized;
  const { rateLimited, noPostingPower, needsVotingPower, retryInSeconds } = useComposerGate(gateText);

  // ── goBack: prefer in-app history; else land on Home (step 3 / Cancel). ────────────────────────
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


  // ── Per-mode submit handlers ───────────────────────────────────────────────────────────────────
  // This page UNMOUNTS on navigation, so runWrite's onCancel is live here: it drops the sticky
  // pending toast when the user navigates away mid-flight.
  const { submitState, runWrite, optimisticPost } = useComposeWrite(api, signer, viewer, goBack);

  const onPost = useCallback(
    (draft: ComposerDraft) => {
      // Session-gated submit reroutes to /welcome (the Composer relabels the CTA).
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || draft.text.trim().length === 0) return;
      clearPostDraft(); // submitted → don't restore it next time
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
    async (question: string, options: string[], closeInDays?: number) => {
      if (viewer.status !== "ready") return void router.push("/welcome/");
      if (!api || !signer || question.trim().length === 0) return;
      // Convert the chosen deadline (days) to an absolute block-number `close_at`. If a deadline was
      // requested but the chain height can't be read, surface it — never silently create a floating poll.
      let closeAt: number | undefined;
      try {
        closeAt = await resolveCloseAt(api, bestBlock, closeInDays);
      } catch {
        toast({
          id: "poll-deadline",
          kind: "error",
          message: "Couldn't set the poll deadline — check your connection and try again.",
        });
        return;
      }
      runWrite(submitCreatePoll(api, signer, question, options, closeAt), optimisticPost(question, { isPoll: true }), {
        pending: "Creating poll…",
        success: "Poll created",
      });
    },
    [viewer.status, api, signer, bestBlock, runWrite, optimisticPost, router, toast],
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
          <Loading variant="panel" label="Loading the post…" />
        )}

        {/* Missing/pruned target → muted stub, but keep the composer usable. */}
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
            onSerializedChange={setSerialized}
            rateLimited={rateLimited}
            retryInSeconds={retryInSeconds}
            noPostingPower={noPostingPower}
            needsVotingPower={needsVotingPower}
            autoFocus
            onTogglePoll={() => router.push("/compose/?poll=1")}
            onSubmit={onPost}
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
              needsVotingPower={needsVotingPower}
              autoFocus
              submitReply={onReply}
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
                onSerializedChange={setSerialized}
                rateLimited={rateLimited}
                noPostingPower={noPostingPower}
                needsVotingPower={needsVotingPower}
                autoFocus
                onSubmit={onPost}
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
              needsVotingPower={needsVotingPower}
              autoFocus
              submitQuote={onQuote}
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
                onSerializedChange={setSerialized}
                rateLimited={rateLimited}
                noPostingPower={noPostingPower}
                needsVotingPower={needsVotingPower}
                autoFocus
                onSubmit={onPost}
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
            needsVotingPower={needsVotingPower}
            autoFocus
            submitCreatePoll={onCreatePoll}
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
            clearPostDraft(); // explicit discard → forget the saved draft
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
