"use client";

// ReplyComposer — a Composer fixed to mode='reply' (doc 03 §9, doc 09 §2.2).
//
// Adds the compact read-only preview of the parent post + the "Replying to @handle" context line
// (the @handle links to /u/[address]) above the textarea. Submit sets parent=Some(replyTo.id): the
// surface wires the extrinsic via @/lib/chain/mutations.submitReply, so this component only hands
// back the draft through `submitReply(text)`. PRESENTATIONAL — no mutation built here.

import { useCallback } from "react";
import { Composer } from "./Composer";
import { Avatar } from "./Avatar";
import { DisplayName } from "./DisplayName";
import { Handle } from "./Handle";
import styles from "./ReplyComposer.module.css";
import type { Viewer, CognoPost, ActionState, ComposerDraft } from "./kit";

export interface ReplyComposerProps {
  viewer: Viewer;
  /** The post being replied to (sets parent=Some(id) + drives the context line/preview). */
  replyTo: CognoPost;
  submitState: ActionState;
  rateLimited?: boolean;
  retryInSeconds?: number | null;
  autoFocus?: boolean;
  /** Hand back the reply text; the surface calls mutations.submitReply(text, replyTo.id). */
  submitReply: (text: string) => void;
  onCancel?: () => void;
}

export function ReplyComposer({
  viewer,
  replyTo,
  submitState,
  rateLimited,
  retryInSeconds,
  autoFocus,
  submitReply,
  onCancel,
}: ReplyComposerProps) {
  const onSubmit = useCallback(
    (draft: ComposerDraft) => submitReply(draft.text),
    [submitReply],
  );

  const parentPreview = (
    <div className={styles.context}>
      <div className={styles.parent}>
        <Avatar
          address={replyTo.author}
          src={replyTo.authorAvatar}
          size="md"
          dim={replyTo.authorRevoked}
          name={replyTo.authorDisplayName}
        />
        <div className={styles.parentBody}>
          <div className={styles.parentHead}>
            <DisplayName
              address={replyTo.author}
              displayName={replyTo.authorDisplayName}
              authorRevoked={replyTo.authorRevoked}
              as="a"
            />
            <Handle address={replyTo.author} as="a" />
          </div>
          <p className={styles.parentText}>{replyTo.text}</p>
        </div>
      </div>
      <p className={styles.replyingTo}>
        Replying to <Handle address={replyTo.author} as="a" />
      </p>
    </div>
  );

  return (
    <Composer
      viewer={viewer}
      mode="reply"
      submitState={submitState}
      rateLimited={rateLimited}
      retryInSeconds={retryInSeconds}
      autoFocus={autoFocus}
      contextAbove={parentPreview}
      draftExtras={{ parentId: replyTo.id }}
      onSubmit={onSubmit}
      onCancel={onCancel}
    />
  );
}

export default ReplyComposer;
