"use client";

// PostItem — one post as a well-set page block. The BODY is the product: serif,
// generous line-height, held to a reading measure. The marginalia header carries
// the CHAIN-TRUTH facts in mono (#id, author ss58, block #at) — mono means
// "verifiable on-chain fact", never decoration. Reply is always available; delete
// only when the post's author is the active signer.

import type { CognoPost, Ss58 } from "@/lib/types";
import styles from "./PostItem.module.css";

function shortSs58(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export interface PostItemProps {
  post: CognoPost;
  /** The active signer's ss58 — enables the delete affordance for own posts. */
  mySs58: Ss58;
  /** true while a tx is in flight (disables the per-post actions). */
  busy: boolean;
  isReply?: boolean;
  onReply: (id: bigint) => void;
  onDelete: (id: bigint) => void;
}

export function PostItem({
  post,
  mySs58,
  busy,
  isReply = false,
  onReply,
  onDelete,
}: PostItemProps) {
  const mine = post.author === mySs58;
  const empty = post.text.trim().length === 0;

  return (
    <article className={`${styles.item} ${isReply ? styles.reply : ""}`}>
      <header className={styles.marginalia}>
        <span className={styles.id}>#{String(post.id)}</span>
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span className={styles.author} title={post.author}>
          {shortSs58(post.author)}
        </span>
        {mine && <span className={styles.youTag}>you</span>}
        <span className={styles.dot} aria-hidden="true">
          ·
        </span>
        <span className={styles.at}>#{post.at}</span>
        {post.parent != null && (
          <>
            <span className={styles.dot} aria-hidden="true">
              ·
            </span>
            <span className={styles.replyRef}>↳ #{String(post.parent)}</span>
          </>
        )}
      </header>

      {empty ? (
        <p className={styles.emptyBody}>(empty post)</p>
      ) : (
        <p className={styles.body}>{post.text}</p>
      )}

      <footer className={styles.actions}>
        <button
          type="button"
          className={styles.action}
          onClick={() => onReply(post.id)}
          disabled={busy}
        >
          reply
        </button>
        {mine && (
          <button
            type="button"
            className={`${styles.action} ${styles.delete}`}
            onClick={() => onDelete(post.id)}
            disabled={busy}
            aria-label={`Delete your post #${String(post.id)}`}
          >
            delete
          </button>
        )}
      </footer>
    </article>
  );
}

export default PostItem;
