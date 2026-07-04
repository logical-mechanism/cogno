"use client";

// Composer (base) — the text-entry engine for every authoring flow (doc 03 §7, doc 09 §4).
//
// PRESENTATIONAL. It owns ONLY the draft text + the live byte measurement. It NEVER builds an
// extrinsic and NEVER subscribes to a read/capacity hook: the surface owns `useCapacity` +
// `useMutation` and hands the composer the *derived* gate state — `submitState` (the optimistic
// ActionState), `viewer.status` (the session gate), and `rateLimited` (draftStatus !== 'ok', already
// classified by the surface via @/lib/chain/capacity.draftStatus). The zero-locked-ADA "no posting
// power" gate is surfaced by the self-contained NoPostingPowerNotice child (like CapacityMeter), with
// `noPostingPower` hard-disabling the CTA where the surface knows it. On submit the composer hands back
// a `ComposerDraft` via `onSubmit(draft)` and OPTIMISTICALLY clears its textarea instantly (doc 09
// §6.1 — the surface closes the modal + inserts the pending card).
//
// Toolbar is stripped to chain-backed affordances (doc 09 §12): exactly the Poll toggle (top-level
// post only) + an OPTIONAL text-only emoji insert helper. NO media / GIF / location / audience /
// schedule / poll-duration. The ByteCounter ring (UTF-8 BYTES, D1) is the single source of truth the
// CTA gates off; a RateLimitNotice line (D5) shows when the surface says capacity is exhausted.

import { useCallback, useEffect, useRef, useState } from "react";
import { ByteCounter, utf8Bytes, clampToBytes } from "./ByteCounter";
import { RateLimitNotice } from "./RateLimitNotice";
import { NoPostingPowerNotice } from "./NoPostingPowerNotice";
import { CapacityMeter } from "./CapacityMeter";
import { Avatar } from "./Avatar";
import { Spinner, IconPoll } from "./icons";
import styles from "./Composer.module.css";
import type {
  Viewer,
  ComposerMode,
  ComposerDraft,
  ActionState,
  ByteMeasure,
} from "./kit";
import type { ReactNode } from "react";

/** Runtime Microblog::MaxLength (Vec<u8>), measured as UTF-8 BYTES (D1). */
export const MAX_POST_BYTES = 512;

/**
 * Default text-only emoji for the insert helper (doc 09 §4.1) — plain UTF-8 that counts toward the
 * byte budget; NOT a media affordance. A surface can override via the `emojiChoices` prop, or pass
 * `[]` to hide the affordance entirely.
 */
const DEFAULT_EMOJI = [
  "😀", "😂", "🥹", "😍", "🤔", "😎", "😭", "🔥",
  "✨", "🎉", "👍", "🙏", "👀", "💯", "❤️", "🚀",
];

const PLACEHOLDER: Record<ComposerMode, string> = {
  post: "What's happening?",
  reply: "Post your reply",
  quote: "Add a comment",
  poll: "Ask a question…",
};

const TEXTAREA_LABEL: Record<ComposerMode, string> = {
  post: "Post text",
  reply: "Your reply",
  quote: "Add a comment",
  poll: "Poll question",
};

export interface ComposerProps {
  /** Avatar/name + the coarse write gate (`viewer.status`). */
  viewer: Viewer;
  /** Drives the CTA label + which extrinsic the surface wires. */
  mode: ComposerMode;
  /** Override the per-mode placeholder. */
  placeholder?: string;
  /** Byte cap for the textarea (default 512). PollComposer passes 512 for the question. */
  maxBytes?: number;
  /** Optimistic submit state (idle → pending → ok/error/rate-limited). */
  submitState: ActionState;
  /** Pre-flight capacity gate: true → CTA disabled + inline RateLimitNotice (D5). Surface-classified. */
  rateLimited?: boolean;
  /** Soft "try again in ~Ns" for the RateLimitNotice (never a meter/percent — D5). */
  retryInSeconds?: number | null;
  /**
   * Ready account with ZERO posting power (locked-ADA weight 0) → CTA disabled + the "Lock ADA to post"
   * notice instead of the transient rate-limit one (waiting never helps). The notice ALSO renders
   * self-contained on every surface; this prop only hard-disables the CTA where the surface knows it.
   */
  noPostingPower?: boolean;
  /** Context block above/below the textarea (reply preview / QuotedPostEmbed / poll options). */
  contextAbove?: ReactNode;
  contextBelow?: ReactNode;
  /** Extra toolbar controls injected by the surface (rendered after the built-in Poll/emoji buttons). */
  toolbarExtras?: ReactNode;
  /**
   * Toggle this composer into poll mode (top-level posts only — doc 09 §4.4). When provided AND
   * mode='post', the toolbar shows the built-in IconPoll toggle; the surface owns the actual
   * mode swap (post ↔ poll). `pollActive` highlights it when poll mode is on.
   */
  onTogglePoll?: () => void;
  pollActive?: boolean;
  /**
   * Optional text-only emoji insert (doc 09 §4.1) — a plain UTF-8 insert into the textarea that
   * still counts toward the byte budget; NOT a media affordance. Omit to hide the affordance.
   */
  emojiChoices?: string[];
  /**
   * Whether the CTA is enabled BEYOND this composer's own text validity. The surface ANDs in the
   * poll-options validity (PollComposer) or a quote's non-empty rule. Default true.
   */
  extraValid?: boolean;
  /** Controlled text (PollComposer drives the question through here); uncontrolled when omitted. */
  text?: string;
  onTextChange?: (text: string) => void;
  /** Focus the textarea on mount (modal/sheet = true). */
  autoFocus?: boolean;
  /** Build a ComposerDraft and submit. The surface maps it to the right mutation. */
  onSubmit: (draft: ComposerDraft) => void;
  /** Modal/page close. */
  onCancel?: () => void;
  /** Report draft dirtiness (non-empty text) so the surface can confirm a discard on close. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Surface-supplied extras the surface needs to assemble the ComposerDraft (parentId/quotedId/options). */
  draftExtras?: Pick<ComposerDraft, "parentId" | "quotedId" | "pollOptions">;
}

/** CTA label per mode + session gate (doc 09 §4.3 / §5.3). */
function ctaLabel(mode: ComposerMode, status: Viewer["status"]): string {
  if (status === "not-connected") return "Connect wallet";
  if (status === "not-identity-bound") return "Finish setup";
  return mode === "reply" ? "Reply" : "Post";
}

export function Composer({
  viewer,
  mode,
  placeholder,
  maxBytes = MAX_POST_BYTES,
  submitState,
  rateLimited,
  retryInSeconds,
  noPostingPower,
  contextAbove,
  contextBelow,
  toolbarExtras,
  onTogglePoll,
  pollActive,
  emojiChoices = DEFAULT_EMOJI,
  extraValid = true,
  text: controlledText,
  onTextChange,
  autoFocus,
  onSubmit,
  onCancel,
  onDirtyChange,
  draftExtras,
}: ComposerProps) {
  const [innerText, setInnerText] = useState("");
  const isControlled = controlledText !== undefined;
  const text = isControlled ? controlledText : innerText;

  const taRef = useRef<HTMLTextAreaElement | null>(null);

  const setText = useCallback(
    (next: string) => {
      if (!isControlled) setInnerText(next);
      onTextChange?.(next);
    },
    [isControlled, onTextChange],
  );

  // Single source of truth for the byte measurement; the CTA gates off the SAME measure the ring shows.
  const [measure, setMeasure] = useState<ByteMeasure>({ bytes: 0, remaining: maxBytes, over: false });

  const pending = submitState === "pending";
  const sessionGated = viewer.status !== "ready"; // relabel + reroute, not silently dead (doc 09 §5.3)

  // Insert a plain UTF-8 emoji at the caret — counts toward the byte budget, clamped to maxBytes (D1).
  const insertEmoji = useCallback(
    (emoji: string) => {
      const el = taRef.current;
      const start = el?.selectionStart ?? text.length;
      const end = el?.selectionEnd ?? text.length;
      const candidate = text.slice(0, start) + emoji + text.slice(end);
      const next = utf8Bytes(candidate) > maxBytes ? clampToBytes(candidate, maxBytes) : candidate;
      setText(next);
      // restore the caret after the inserted emoji on the next frame
      requestAnimationFrame(() => {
        if (!el) return;
        const pos = start + emoji.length;
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          /* selection may be unsupported in some envs */
        }
      });
    },
    [text, maxBytes, setText],
  );

  // Validity (doc 09 §5.4 precedence): for a quote the chain allows empty text but the UI requires a
  // non-whitespace byte; reply/post require non-empty too; poll requires a non-empty question.
  const nonEmpty = text.trim().length > 0;
  const overLimit = measure.over;
  const textValid = nonEmpty && !overLimit && extraValid;

  // Report dirtiness up so the surface can confirm a discard on close (uncontrolled reply/quote text
  // lives only in this component, so the surface can't see it any other way).
  useEffect(() => {
    onDirtyChange?.(nonEmpty);
  }, [nonEmpty, onDirtyChange]);

  // CTA disabled rules — §5.4 order: session(reroute) > validity > capacity > pending. No posting
  // power (zero locked ADA) is a hard capacity block, same as rate-limited.
  const disabled = sessionGated
    ? false // session-gated CTA is ACTIVE (it reroutes), never greyed
    : !textValid || rateLimited === true || noPostingPower === true || pending;

  // Auto-grow: let the textarea size to content (capped by CSS max-height → scroll).
  const onTextareaInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const el = e.currentTarget;
      // Hard-block past the byte boundary: clamp a paste to the last whole code point that fits (D1).
      let next = el.value;
      if (utf8Bytes(next) > maxBytes) {
        next = clampToBytes(next, maxBytes);
      }
      setText(next);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    },
    [maxBytes, setText],
  );

  const buildDraft = useCallback(
    (): ComposerDraft => ({
      mode,
      text,
      parentId: draftExtras?.parentId,
      quotedId: draftExtras?.quotedId,
      pollOptions: draftExtras?.pollOptions,
    }),
    [mode, text, draftExtras],
  );

  const submit = useCallback(() => {
    if (sessionGated) {
      // Reroute is owned by onCancel/onSubmit at the surface; here we just hand back the draft so the
      // surface can decide (it inspects viewer.status). For the gated case the surface routes /welcome.
      onSubmit(buildDraft());
      return;
    }
    if (disabled) return;
    onSubmit(buildDraft());
    // OPTIMISTIC: clear the textarea instantly (doc 09 §6.1). Controlled drafts are cleared by the surface.
    if (!isControlled) {
      setInnerText("");
      if (taRef.current) taRef.current.style.height = "auto";
    }
  }, [sessionGated, disabled, onSubmit, buildDraft, isControlled]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ⌘/Ctrl+Enter submits; Enter is a newline (X parity, doc 09 §7.1).
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const label = ctaLabel(mode, viewer.status);
  // Live-announce remaining only when ≤ 20 bytes left (avoid spam — doc 09 §11).
  const announce = measure.remaining <= 20;

  return (
    <form
      className={styles.composer}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {contextAbove}

      <div className={styles.body}>
        <Avatar address={viewer.address ?? ""} src={viewer.avatar} size="md" name={viewer.displayName} eager />

        <div className={styles.field}>
          <label className={styles.srOnly} htmlFor={`cg-composer-${mode}`}>
            {TEXTAREA_LABEL[mode]}. Press Command or Control plus Enter to post
          </label>
          <textarea
            id={`cg-composer-${mode}`}
            ref={taRef}
            className={styles.textarea}
            placeholder={placeholder ?? PLACEHOLDER[mode]}
            value={text}
            rows={1}
            readOnly={sessionGated}
            autoFocus={autoFocus}
            onChange={onTextareaInput}
            onKeyDown={onKeyDown}
            aria-describedby={`cg-composer-${mode}-meta`}
          />
          {contextBelow}
        </div>
      </div>

      {sessionGated && (
        <p className={styles.sessionPrompt} role="status">
          {viewer.status === "not-connected"
            ? "Connect a wallet to post."
            : "Finish setting up your account to post."}
        </p>
      )}

      {/* No posting power (zero locked ADA) → the honest "Lock ADA to post" banner. Self-contained, so
          it renders on every surface; it takes precedence over the transient rate-limit notice. */}
      {!sessionGated && <NoPostingPowerNotice />}

      {!sessionGated && !noPostingPower && rateLimited && (
        <div className={styles.notice}>
          <RateLimitNotice variant="inline" retryInSeconds={retryInSeconds} />
        </div>
      )}

      <div className={styles.toolbar} id={`cg-composer-${mode}-meta`}>
        <div className={styles.toolbarLeft}>
          {!sessionGated && <CapacityMeter />}
          {onTogglePoll && (mode === "post" || mode === "poll") && (
            <button
              type="button"
              className={`${styles.toolBtn} ${pollActive ? styles.toolBtnActive : ""}`}
              onClick={onTogglePoll}
              aria-pressed={pollActive || undefined}
              aria-label={pollActive ? "Remove poll" : "Add poll"}
              title={pollActive ? "Remove poll" : "Add poll"}
              disabled={sessionGated}
            >
              <IconPoll size="var(--cg-icon-md)" />
            </button>
          )}
          {emojiChoices && emojiChoices.length > 0 && !sessionGated && (
            <EmojiPicker choices={emojiChoices} onPick={insertEmoji} />
          )}
          {toolbarExtras}
        </div>

        <div className={styles.toolbarRight}>
          {!sessionGated && (
            <span aria-live={announce ? "polite" : "off"}>
              <ByteCounter value={text} maxBytes={maxBytes} onMeasure={setMeasure} />
            </span>
          )}
          <button
            type="submit"
            className={styles.cta}
            aria-disabled={disabled || undefined}
            disabled={disabled}
            title={
              sessionGated
                ? undefined
                : noPostingPower
                  ? "Lock ADA to post"
                  : overLimit
                    ? `Too long. Trim to ${maxBytes} bytes`
                    : !nonEmpty
                      ? "Write something first"
                      : rateLimited
                        ? "You're over the rate limit"
                        : undefined
            }
          >
            {pending ? <Spinner size="sm" label="Posting" /> : label}
          </button>
        </div>
      </div>
    </form>
  );
}

/**
 * A text-only emoji insert helper (doc 09 §4.1) — NOT a media affordance. A tiny popover of plain
 * UTF-8 emoji; picking one inserts it at the caret (counted by the ByteCounter). No image/sticker.
 */
function EmojiPicker({ choices, onPick }: { choices: string[]; onPick: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className={styles.emojiWrap}>
      <button
        type="button"
        className={styles.toolBtn}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label="Insert emoji"
        title="Insert emoji"
      >
        <span aria-hidden>☺</span>
      </button>
      {open && (
        <div className={styles.emojiPopover} role="menu">
          {choices.map((e) => (
            <button
              key={e}
              type="button"
              className={styles.emojiBtn}
              role="menuitem"
              onClick={() => {
                onPick(e);
                setOpen(false);
              }}
              aria-label={`Insert ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}


export default Composer;
