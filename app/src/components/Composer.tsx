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

import { lazy, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { countImageUrls } from "@/lib/media";
import { useMentions } from "@/hooks/useMentions";
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
import type { ReactNode, CSSProperties } from "react";

/** Runtime Microblog::MaxLength (Vec<u8>), measured as UTF-8 BYTES (D1). */
export const MAX_POST_BYTES = 512;

// The searchable emoji board (doc 09 §4.1). Lazy so its emoji dataset (~570KB) downloads as its own
// chunk only when a user first opens the picker — it never touches the main composer bundle. Emoji are
// still inserted as plain UTF-8 that counts toward the byte budget; this is NOT a media affordance.
const EmojiPickerPanel = lazy(() => import("./emoji/EmojiPickerPanel"));

// Desired picker size; the anchor caps these to the viewport at open time (see EmojiPicker).
const EMOJI_PANEL_W = 340;
const EMOJI_PANEL_MAX_H = 420;

// For the Post-button tooltip advertising the ⌘/Ctrl+Enter submit shortcut. Guarded for SSR/prerender.
const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform ?? "");

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
   * Show the emoji picker in the toolbar (doc 09 §4.1) — a searchable native-emoji board whose picks
   * are inserted as plain UTF-8 into the textarea (byte-counted); NOT a media affordance. Default true;
   * pass false to hide the affordance.
   */
  emoji?: boolean;
  /**
   * Whether the CTA is enabled BEYOND this composer's own text validity. The surface ANDs in the
   * poll-options validity (PollComposer) or a quote's non-empty rule. Default true.
   */
  extraValid?: boolean;
  /** Controlled text (PollComposer drives the question through here); uncontrolled when omitted. */
  text?: string;
  onTextChange?: (text: string) => void;
  /**
   * The SERIALIZED body (display `@name` tokens expanded to `@<ss58>`) whenever it changes. A surface
   * that runs a per-draft capacity gate (ComposePage/ModalRouteHost) uses this — NOT the display text —
   * so the gate counts the real, ~48-bytes-per-mention serialized length. The byte-counter ring + the
   * over-limit CTA gate always count the serialized length internally regardless.
   */
  onSerializedChange?: (serialized: string) => void;
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
  emoji = true,
  extraValid = true,
  text: controlledText,
  onTextChange,
  onSerializedChange,
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

  // @-mentions: the display text holds friendly `@name` tokens; `serializeDraft` expands them to
  // `@<ss58>` for the byte meter + submit, and `mentionPopover` is the autocomplete popover.
  const listId = useId();
  const {
    serialize: serializeDraft,
    mentionCount,
    suggestions: mentionPopover,
    open: mentionsOpen,
    onTextInput: syncMentionQuery,
    onKeyDown: mentionKeyDown,
    dismiss: dismissMentions,
    reset: resetMentions,
  } = useMentions({ text, setText, taRef, listId });

  // The SERIALIZED body — what actually gets posted, and what the byte counter / capacity gate must
  // measure (each `@name` token expands to a ~48-byte ss58, so a short-looking draft can exceed 512).
  const serializedText = useMemo(() => serializeDraft(text), [serializeDraft, text]);
  useEffect(() => {
    onSerializedChange?.(serializedText);
  }, [serializedText, onSerializedChange]);

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
      // Clamp on the DISPLAY text only when there are no mention tokens (display === serialized then);
      // with mentions present the serialized measure governs, and clamping display text could cut a token.
      const next =
        mentionCount === 0 && utf8Bytes(candidate) > maxBytes
          ? clampToBytes(candidate, maxBytes)
          : candidate;
      setText(next);
      const pos = start + emoji.length;
      syncMentionQuery(next, pos); // an emoji ends any active @query
      // restore the caret after the inserted emoji on the next frame
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        try {
          el.setSelectionRange(pos, pos);
        } catch {
          /* selection may be unsupported in some envs */
        }
      });
    },
    [text, maxBytes, setText, mentionCount, syncMentionQuery],
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
      // With mention tokens present, display length ≠ serialized length, so clamping the DISPLAY here
      // could cut a token; instead the serialized byte meter turns the ring red + disables the CTA.
      let next = el.value;
      if (mentionCount === 0 && utf8Bytes(next) > maxBytes) {
        next = clampToBytes(next, maxBytes);
      }
      setText(next);
      syncMentionQuery(next, el.selectionStart ?? next.length);
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    },
    [maxBytes, setText, mentionCount, syncMentionQuery],
  );

  const buildDraft = useCallback(
    (): ComposerDraft => ({
      mode,
      // Serialize `@name` display tokens to `@<ss58>` so the POSTED body is the self-describing form
      // every client parses (QuoteComposer forwards draft.text; PollComposer submits draft.text too).
      text: serializedText,
      parentId: draftExtras?.parentId,
      quotedId: draftExtras?.quotedId,
      pollOptions: draftExtras?.pollOptions,
    }),
    [mode, serializedText, draftExtras],
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
    resetMentions(); // drop the recorded mentions with the submitted draft
    if (!isControlled) {
      setInnerText("");
      if (taRef.current) taRef.current.style.height = "auto";
    }
  }, [sessionGated, disabled, onSubmit, buildDraft, isControlled, resetMentions]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Let the mention popover claim navigation keys first (↑/↓ move, Enter/Tab pick, Esc close).
      if (mentionKeyDown(e)) return;
      // ⌘/Ctrl+Enter submits; Enter is a newline (X parity, doc 09 §7.1).
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    },
    [submit, mentionKeyDown],
  );

  const label = ctaLabel(mode, viewer.status);
  // Live-announce remaining only when ≤ 20 bytes left (avoid spam — doc 09 §11).
  const announce = measure.remaining <= 20;

  // Count image links in the draft (matching PostBody's reveal-on-open posture — NO auto-fetch here;
  // just a chip so the author knows the link will render as an image when the post is opened).
  const imageLinkCount = useMemo(() => countImageUrls(text), [text]);

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
          {/* Relatively-positioned wrapper so the mention autocomplete popover anchors under the textarea. */}
          <div className={styles.taWrap}>
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
              // Re-detect an @query when the caret is moved by mouse; close the popover on blur (a row
              // pick uses mousedown+preventDefault, so it never blurs before the pick lands).
              onClick={(e) => syncMentionQuery(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
              onBlur={dismissMentions}
              role="combobox"
              aria-expanded={mentionsOpen}
              aria-controls={mentionsOpen ? listId : undefined}
              aria-autocomplete="list"
              aria-describedby={`cg-composer-${mode}-meta`}
            />
            {mentionPopover}
          </div>
          {contextBelow}
          {imageLinkCount > 0 && (
            <p className={styles.imageChip} role="note">
              <span aria-hidden>🖼</span>{" "}
              {imageLinkCount === 1
                ? "Image link — shown when the post is opened"
                : `${imageLinkCount} image links — shown when opened`}
            </p>
          )}
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
              <IconPoll size="var(--cg-icon-lg)" />
            </button>
          )}
          {emoji && !sessionGated && <EmojiPicker onPick={insertEmoji} />}
          {toolbarExtras}
        </div>

        <div className={styles.toolbarRight}>
          {!sessionGated && (
            <span aria-live={announce ? "polite" : "off"}>
              {/* Count the SERIALIZED body (mention tokens expanded to their ~48-byte ss58), not the
                  short display text — else a mention-heavy draft that looks short fails the 512 cap. */}
              <ByteCounter value={serializedText} maxBytes={maxBytes} onMeasure={setMeasure} />
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
                        : `${label} — ${IS_MAC ? "⌘↵" : "Ctrl+Enter"}`
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
function EmojiPicker({ onPick }: { onPick: (e: string) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  // Anchor the panel to the button and keep it fully on-screen. The panel has KNOWN dimensions
  // (EMOJI_PANEL_W × up-to-EMOJI_PANEL_MAX_H), so we place it from the trigger's position alone — no need
  // to measure the lazily-loaded content (which would race the Suspense fallback swap): flip above/below
  // toward the side with room, cap the height to that side (the board scrolls inside), and nudge it
  // horizontally so a wide panel near a screen edge can't spill off. Hidden for the one frame before this
  // lands so it never flashes off-screen.
  const [place, setPlace] = useState<{
    up: boolean;
    shiftX: number;
    width: number;
    maxH: number;
    ready: boolean;
  }>({ up: false, shiftX: 0, width: EMOJI_PANEL_W, maxH: EMOJI_PANEL_MAX_H, ready: false });
  useEffect(() => {
    if (!open) {
      setPlace((p) => ({ ...p, ready: false }));
      return;
    }
    const trig = triggerRef.current;
    if (!trig) return;
    const MARGIN = 8; // clearance from every viewport edge
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const t = trig.getBoundingClientRect();
    const width = Math.min(EMOJI_PANEL_W, vw - 2 * MARGIN);
    const roomAbove = t.top - MARGIN;
    const roomBelow = vh - t.bottom - MARGIN;
    // Open downward by default (the composer sits near the top of the modal); flip up only when below is
    // too tight for the panel and above is roomier (e.g. an inline reply composer near the viewport bottom).
    const up = roomBelow < EMOJI_PANEL_MAX_H && roomAbove > roomBelow;
    const maxH = Math.min(EMOJI_PANEL_MAX_H, Math.max(up ? roomAbove : roomBelow, 0));
    let shiftX = 0;
    const rightEdge = t.left + width;
    if (rightEdge > vw - MARGIN) shiftX = vw - MARGIN - rightEdge; // overruns right → nudge left
    if (t.left + shiftX < MARGIN) shiftX = MARGIN - t.left; // …but never off the left edge
    setPlace({ up, shiftX, width, maxH, ready: true });
  }, [open]);

  // Twitter-style dismissal: a pointer press anywhere outside the picker closes it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Escape closes ONLY the picker — stop it bubbling to the surrounding ComposerModal's own Escape
  // handler (which would otherwise close the whole modal too) — and return focus to the trigger.
  const onPanelKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    }
  }, []);

  const pick = useCallback(
    (e: string) => {
      onPick(e);
      setOpen(false); // close on select (X-style — the caret returns to the textarea)
    },
    [onPick],
  );

  const anchorStyle: CSSProperties = {
    width: place.width,
    maxHeight: place.maxH,
    transform: place.shiftX ? `translateX(${place.shiftX}px)` : undefined,
    visibility: place.ready ? undefined : "hidden",
    top: place.up ? "auto" : "calc(100% + var(--cg-space-1))",
    bottom: place.up ? "calc(100% + var(--cg-space-1))" : "auto",
  };

  return (
    <span className={styles.emojiWrap} ref={wrapRef}>
      <button
        ref={triggerRef}
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
        <div className={styles.emojiPanel} style={anchorStyle} onKeyDown={onPanelKeyDown}>
          <Suspense
            fallback={
              <div className={styles.emojiPanelLoading}>
                <Spinner size="sm" />
              </div>
            }
          >
            <EmojiPickerPanel onPick={pick} />
          </Suspense>
        </div>
      )}
    </span>
  );
}


export default Composer;
