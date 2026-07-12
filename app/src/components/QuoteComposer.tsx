"use client";

// QuoteComposer — a Composer fixed to mode='quote' (doc 03 §10, doc 09 §2.3).
//
// Embeds the read-only QuotedPostEmbed of the quoted post BELOW the textarea (onOpen is a no-op
// inside the composer — the embed is non-interactive here). Submit calls quote_post via the
// surface: this component hands back the comment text through `submitQuote(text)` only. A quote
// requires ≥1 non-whitespace byte (a zero-comment quote is indistinguishable from a Repost — doc 03
// §10), enforced by Composer's own non-empty rule. PRESENTATIONAL — no mutation built here.

import { useCallback, useMemo } from "react";
import { Composer } from "./Composer";
import { QuotedPostEmbed } from "./QuotedPostEmbed";
import styles from "./QuoteComposer.module.css";
import type { Viewer, CognoPost, QuotedRef, ActionState, ComposerDraft } from "./kit";

export interface QuoteComposerProps {
  viewer: Viewer;
  /** The post being quoted (renders the embed + sets quoted_id). */
  quoted: CognoPost;
  submitState: ActionState;
  rateLimited?: boolean;
  retryInSeconds?: number | null;
  noPostingPower?: boolean;
  needsVotingPower?: boolean;
  autoFocus?: boolean;
  /** Hand back the comment text; the surface calls mutations.submitQuote(text, quoted.id). */
  submitQuote: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

/** Project a CognoPost down to the QuotedRef the embed consumes (no nested actions). */
function toQuotedRef(p: CognoPost): QuotedRef {
  return {
    id: p.id,
    author: p.author,
    text: p.text,
    authorRevoked: p.authorRevoked ?? false,
    displayName: p.authorDisplayName,
    avatar: p.authorAvatar,
  };
}

export function QuoteComposer({
  viewer,
  quoted,
  submitState,
  rateLimited,
  retryInSeconds,
  noPostingPower,
  needsVotingPower,
  autoFocus,
  submitQuote,
  onDirtyChange,
}: QuoteComposerProps) {
  const onSubmit = useCallback(
    (draft: ComposerDraft) => submitQuote(draft.text),
    [submitQuote],
  );

  const ref = useMemo(() => toQuotedRef(quoted), [quoted]);

  const embed = (
    <div className={styles.embed}>
      {/* read-only inside the composer: onOpen is a no-op */}
      <QuotedPostEmbed quoted={ref} onOpen={() => {}} />
    </div>
  );

  return (
    <Composer
      viewer={viewer}
      mode="quote"
      submitState={submitState}
      rateLimited={rateLimited}
      retryInSeconds={retryInSeconds}
      noPostingPower={noPostingPower}
      needsVotingPower={needsVotingPower}
      autoFocus={autoFocus}
      contextBelow={embed}
      draftExtras={{ quotedId: quoted.id }}
      onSubmit={onSubmit}
      onDirtyChange={onDirtyChange}
    />
  );
}

export default QuoteComposer;
