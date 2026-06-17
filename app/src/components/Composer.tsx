"use client";

// Composer — write a post (or a reply). Chrome, not page-body: the textarea is in
// the UI font, not the reading serif. It is relentlessly honest about the tx
// lifecycle: signing → in best block #N → finalized #N, with "signed ≠ included"
// stated next to the button. The byte counter enforces the runtime MaxLength
// (512 bytes, measured as UTF-8, NOT characters) and disables submit past it.

import { useEffect, useMemo, useState } from "react";
import type { PostingSigner, TxUpdate, BootGuard } from "@/lib/types";
import styles from "./Composer.module.css";

// Runtime Microblog::MaxLength (Vec<u8>, bytes). Counted as UTF-8 bytes.
const MAX_BYTES = 512;

function shortSs58(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function byteLen(s: string): number {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(s).length;
  return unescape(encodeURIComponent(s)).length;
}

function statusView(state: TxUpdate | null): { text: string; tone: string } | null {
  if (!state) return null;
  switch (state.phase) {
    case "signing":
      return { text: "signing…", tone: styles.toneWork };
    case "broadcast":
      return { text: "broadcasting…", tone: styles.toneWork };
    case "inBestBlock":
      return {
        text:
          state.blockNumber != null
            ? `in block #${state.blockNumber} (best — not yet final)`
            : "in a best block (not yet final)",
        tone: styles.toneWork,
      };
    case "finalized":
      return {
        text:
          state.blockNumber != null
            ? `finalized #${state.blockNumber}`
            : "finalized",
        tone: styles.toneOk,
      };
    case "invalid":
      return { text: state.error ?? "rejected (invalid)", tone: styles.toneBad };
    case "error":
      return { text: state.error ?? "submission error", tone: styles.toneBad };
    default:
      return null;
  }
}

export interface ComposerProps {
  signer: PostingSigner;
  boot: BootGuard | null;
  /** in-flight tx state (from useSubmit). */
  txState: TxUpdate | null;
  busy: boolean;
  /** the post id being replied to, if any. */
  replyTo: bigint | null;
  onClearReply: () => void;
  onSubmit: (text: string) => void;
}

export function Composer({
  signer,
  boot,
  txState,
  busy,
  replyTo,
  onClearReply,
  onSubmit,
}: ComposerProps) {
  const [text, setText] = useState("");

  const bytes = useMemo(() => byteLen(text), [text]);
  const overLimit = bytes > MAX_BYTES;
  const empty = text.trim().length === 0;
  const bootBlocked = boot != null && boot.ok === false;

  // Clear the textarea as soon as the post lands in a best block (success), and
  // drop the reply context too.
  useEffect(() => {
    if (txState?.phase === "inBestBlock") {
      setText("");
      onClearReply();
    }
  }, [txState?.phase, onClearReply]);

  const disabled = busy || overLimit || empty || bootBlocked;
  const status = statusView(txState);

  const submit = () => {
    if (disabled) return;
    onSubmit(text);
  };

  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {replyTo != null && (
        <div className={styles.replyBar}>
          <span className={styles.replyText}>
            ↳ replying to <span className={styles.replyId}>#{String(replyTo)}</span>
          </span>
          <button
            type="button"
            className={styles.clearReply}
            onClick={onClearReply}
          >
            clear reply
          </button>
        </div>
      )}

      <label className={styles.srOnly} htmlFor="cogno-composer">
        Write a post
      </label>
      <textarea
        id="cogno-composer"
        className={styles.textarea}
        placeholder={replyTo != null ? "Write a reply…" : "Write something. It lands in a block."}
        value={text}
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Cmd/Ctrl+Enter submits.
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        aria-describedby="cogno-composer-meta"
      />

      <div className={styles.row} id="cogno-composer-meta">
        <span className={styles.signingAs}>
          signing as{" "}
          <span className={styles.signId} title={signer.ss58}>
            {shortSs58(signer.ss58)}
          </span>{" "}
          <span className={styles.signLabel}>· {signer.label}</span>
        </span>

        <span
          className={`${styles.counter} ${overLimit ? styles.counterOver : ""}`}
          aria-live="polite"
        >
          {bytes}/{MAX_BYTES} bytes
        </span>
      </div>

      <div className={styles.actions}>
        <div className={styles.statusArea} aria-live="polite">
          {bootBlocked ? (
            <span className={styles.toneBad}>
              update required to post — node spec {boot?.nodeSpecVersion} differs from
              this build
              {boot?.reason ? ` (${boot.reason})` : ""}
            </span>
          ) : status ? (
            <span className={status.tone}>{status.text}</span>
          ) : (
            <span className={styles.signedNote}>
              signed ≠ included — a post is real only once it is in a block
            </span>
          )}
        </div>

        <button
          type="submit"
          className={styles.postBtn}
          disabled={disabled}
          title={
            bootBlocked
              ? "Update required to post"
              : overLimit
                ? "Too long — trim to 512 bytes"
                : undefined
          }
        >
          {busy ? "posting…" : replyTo != null ? "Reply" : "Post"}
        </button>
      </div>
    </form>
  );
}

export default Composer;
