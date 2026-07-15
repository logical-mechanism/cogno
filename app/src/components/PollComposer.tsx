"use client";

// PollComposer — a Composer fixed to mode='poll'.
//
// The poll QUESTION reuses the 512-byte textarea (controlled through the base Composer's text seam);
// below it a <fieldset> of 2–4 option inputs, EACH with its own ByteCounter('sm', 80). The first two
// options are mandatory (not removable); options 3 & 4 are removable; "+ Add option" disabled at 4.
// NO expiry/duration picker — polls never expire (D4). Submit drops empty/whitespace options and
// asserts 2 ≤ options ≤ 4 (each ≤ 80 bytes) before handing back through `submitCreatePoll(question,
// options)`. CONTROLLED via `pollDraft` + `onChange`. PRESENTATIONAL — no mutation built here.

import { useCallback, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { Composer, MAX_POST_BYTES } from "./Composer";
import { ByteCounter } from "./ByteCounter";
import { utf8Bytes, clampToBytes } from "@/lib/bytes";
import { IconClose } from "./icons";
import styles from "./PollComposer.module.css";
import type { Viewer, PollDraft, ActionState, ComposerDraft } from "./kit";

/** Runtime Profile/Microblog MaxPollOptionLen (bytes). */
export const MAX_POLL_OPTION_BYTES = 80;
/** Runtime MaxPollOptions. */
export const MAX_POLL_OPTIONS = 4;
const MIN_POLL_OPTIONS = 2;

export interface PollComposerProps {
  viewer: Viewer;
  /** Controlled draft: { question, options }. The two mandatory options must already be present. */
  pollDraft: PollDraft;
  onChange: (draft: PollDraft) => void;
  submitState: ActionState;
  rateLimited?: boolean;
  retryInSeconds?: number | null;
  noPostingPower?: boolean;
  needsVotingPower?: boolean;
  autoFocus?: boolean;
  /** Hand back the trimmed args; the surface calls mutations.submitCreatePoll(question, options). */
  submitCreatePoll: (question: string, options: string[]) => void;
  /**
   * Flip back OUT of poll mode (to the plain composer). Optional: a surface that reaches PollComposer
   * one-way (Home, which opens the poll modal directly) omits it and shows no toggle. The in-modal
   * compose↔poll flip passes it so poll mode is not a one-way trap.
   */
  onTogglePoll?: () => void;
}

/** Ensure the controlled draft always has at least the two mandatory option slots. */
function normalize(options: string[]): string[] {
  const next = [...options];
  while (next.length < MIN_POLL_OPTIONS) next.push("");
  return next.slice(0, MAX_POLL_OPTIONS);
}

export function PollComposer({
  viewer,
  pollDraft,
  onChange,
  submitState,
  rateLimited,
  retryInSeconds,
  noPostingPower,
  needsVotingPower,
  autoFocus,
  submitCreatePoll,
  onTogglePoll,
}: PollComposerProps) {
  const options = useMemo(() => normalize(pollDraft.options), [pollDraft.options]);

  const setQuestion = useCallback(
    (question: string) => onChange({ question, options }),
    [onChange, options],
  );

  const setOption = useCallback(
    (i: number, value: string) => {
      // Hard-block past 80 bytes at the code-point boundary (D1).
      const clamped = utf8Bytes(value) > MAX_POLL_OPTION_BYTES ? clampToBytes(value, MAX_POLL_OPTION_BYTES) : value;
      const next = options.map((o, idx) => (idx === i ? clamped : o));
      onChange({ question: pollDraft.question, options: next });
    },
    [onChange, options, pollDraft.question],
  );

  const addOption = useCallback(() => {
    if (options.length >= MAX_POLL_OPTIONS) return;
    onChange({ question: pollDraft.question, options: [...options, ""] });
  }, [onChange, options, pollDraft.question]);

  const removeOption = useCallback(
    (i: number) => {
      if (i < MIN_POLL_OPTIONS) return; // first two are mandatory
      onChange({ question: pollDraft.question, options: options.filter((_, idx) => idx !== i) });
    },
    [onChange, options, pollDraft.question],
  );

  // Focus an option input after the controlled re-render commits (setTimeout, not this render's DOM).
  const focusOptionSoon = useCallback((i: number) => {
    setTimeout(() => document.getElementById(`cg-poll-option-${i}`)?.focus(), 0);
  }, []);

  // Keyboard flow (X parity): Enter → next option (or add one from the last non-empty option, never
  // submitting the form); Backspace on an empty removable option → delete it and focus the previous.
  const onOptionKeyDown = useCallback(
    (i: number, e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (i < options.length - 1) {
          focusOptionSoon(i + 1);
        } else if (options[i].trim().length > 0 && options.length < MAX_POLL_OPTIONS) {
          addOption();
          focusOptionSoon(i + 1);
        }
      } else if (e.key === "Backspace" && options[i].length === 0 && i >= MIN_POLL_OPTIONS) {
        e.preventDefault();
        removeOption(i);
        focusOptionSoon(i - 1);
      }
    },
    [options, addOption, removeOption, focusOptionSoon],
  );

  // Validity: ≥2 non-empty options after trim, none over 80 bytes.
  const trimmed = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const anyOptionOver = options.some((o) => utf8Bytes(o) > MAX_POLL_OPTION_BYTES);
  const enoughOptions = trimmed.length >= MIN_POLL_OPTIONS;
  const extraValid = enoughOptions && !anyOptionOver;

  const onSubmit = useCallback(
    (draft: ComposerDraft) => {
      const out = options.map((o) => o.trim()).filter((o) => o.length > 0).slice(0, MAX_POLL_OPTIONS);
      if (out.length < MIN_POLL_OPTIONS) return; // guard (CTA should already be disabled)
      // draft.text is the question with any @mention display tokens serialized to `@<ss58>` (the base
      // Composer owns that). Use it, NOT the raw pollDraft.question, so poll questions mention correctly.
      submitCreatePoll(draft.text, out);
    },
    [options, submitCreatePoll],
  );

  const fieldset = (
    <fieldset className={styles.fieldset}>
      <legend className={styles.srOnly}>Poll choices</legend>
      {options.map((opt, i) => {
        const removable = i >= MIN_POLL_OPTIONS;
        return (
          <div className={styles.optionRow} key={i}>
            <label className={styles.srOnly} htmlFor={`cg-poll-option-${i}`}>
              Choice {i + 1}
            </label>
            <input
              id={`cg-poll-option-${i}`}
              className={styles.optionInput}
              type="text"
              value={opt}
              placeholder={`Choice ${i + 1}`}
              onChange={(e) => setOption(i, e.target.value)}
              onKeyDown={(e) => onOptionKeyDown(i, e)}
              aria-invalid={utf8Bytes(opt) > MAX_POLL_OPTION_BYTES || undefined}
            />
            <ByteCounter value={opt} maxBytes={MAX_POLL_OPTION_BYTES} size="sm" />
            {removable && (
              <button
                type="button"
                className={styles.removeOption}
                onClick={() => removeOption(i)}
                aria-label={`Remove choice ${i + 1}`}
              >
                <IconClose size="var(--cg-icon-sm)" />
              </button>
            )}
          </div>
        );
      })}

      <div className={styles.addRow}>
        <button
          type="button"
          className={styles.addOption}
          onClick={addOption}
          disabled={options.length >= MAX_POLL_OPTIONS}
          aria-disabled={options.length >= MAX_POLL_OPTIONS || undefined}
        >
          + Add option
        </button>
        {!enoughOptions && <span className={styles.hint}>Add at least 2 options.</span>}
        <span className={styles.srOnly} aria-live="polite">
          {MAX_POLL_OPTIONS - options.length} option slots remaining
        </span>
      </div>
    </fieldset>
  );

  return (
    <Composer
      viewer={viewer}
      mode="poll"
      maxBytes={MAX_POST_BYTES}
      submitState={submitState}
      rateLimited={rateLimited}
      retryInSeconds={retryInSeconds}
      noPostingPower={noPostingPower}
      needsVotingPower={needsVotingPower}
      autoFocus={autoFocus}
      text={pollDraft.question}
      onTextChange={setQuestion}
      onTogglePoll={onTogglePoll}
      pollActive={onTogglePoll ? true : undefined}
      extraValid={extraValid}
      contextBelow={fieldset}
      draftExtras={{ pollOptions: options }}
      onSubmit={onSubmit}
    />
  );
}

export default PollComposer;
