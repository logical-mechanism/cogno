"use client";

// PollComposer — a Composer fixed to mode='poll', with the spec-209 governance flavors.
//
// The poll QUESTION reuses the 512-byte textarea (through the base Composer's text seam); below it a
// <fieldset> of 2–4 option inputs (each ≤ 80 bytes, first two mandatory). Then:
//   • a POLL-TYPE selector (spec 207/209): Stake (everyone) · SPO & dRep (both chambers) · SPO only ·
//     dRep only. The chamber kinds surface a display-only Cardano temperature check.
//   • when a CHAMBER kind is chosen, an optional GOVERNANCE-ACTION section (spec 209): tag the poll as a
//     pre-submission temperature check on a specific CIP-1694 action — pick the action type (with guidance
//     on which bodies vote it on Cardano) and paste a LINK to the off-chain proposal (GitHub/IPFS). Turning
//     it on presets the options to Yes/No/Abstain (the on-chain vote tri-state). Cogno stores the type +
//     link, never the proposal body.
//   • a deadline <select> (spec 205): No deadline / 1 / 3 / 7 days → a block-number `close_at`.
// Submit drops empty options, asserts 2 ≤ options ≤ 4, and (for a tagged poll) a non-empty in-bound link,
// then hands back through `submitCreatePoll(question, options, closeInDays, kind, action)`. CONTROLLED via
// `pollDraft` + `onChange`. PRESENTATIONAL — no mutation built here.

import { useCallback, useMemo } from "react";
import type { KeyboardEvent } from "react";
import { Composer, MAX_POST_BYTES } from "./Composer";
import { ByteCounter } from "./ByteCounter";
import { utf8Bytes, clampToBytes } from "@/lib/bytes";
import { IconClose } from "./icons";
import styles from "./PollComposer.module.css";
import type {
  Viewer,
  PollDraft,
  ActionState,
  ComposerDraft,
  PollKindName,
  GovActionType,
} from "./kit";

/** Runtime Profile/Microblog MaxPollOptionLen (bytes). */
export const MAX_POLL_OPTION_BYTES = 80;
/** Runtime MaxPollOptions. */
export const MAX_POLL_OPTIONS = 4;
const MIN_POLL_OPTIONS = 2;
/** Runtime MaxAnchorUrlLen (bytes) — the governance-action proposal link. */
export const MAX_ANCHOR_URL_BYTES = 256;

/** The Yes/No/Abstain tri-state a governance-action temperature check presets to (mirrors on-chain). */
const YES_NO_ABSTAIN = ["Yes", "No", "Abstain"];

/**
 * A proposal link is only accepted if it is an absolute http(s) URL — EXACTLY the guard PollCard applies
 * when it renders the "View proposal" link (`safeUrl`). Gating the creator on the same rule means what you
 * can submit is always what renders as a clickable link: a scheme-less (`github.com/…`) or non-http
 * (`ipfs://…`) link can never be written on-chain as a permanently-unlinkable anchor (there is no
 * delete_post to fix one).
 */
function isSafeAnchorUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** Does a poll kind surface the SPO chamber / the dRep chamber / any chamber? (Mirrors the runtime.) */
const kindHasSpo = (k?: PollKindName) => k === "Governance" || k === "Spo";
const kindHasDrep = (k?: PollKindName) => k === "Governance" || k === "Drep";
const kindIsChamber = (k?: PollKindName) => kindHasSpo(k) || kindHasDrep(k);

/** One-line description of the selected poll kind. */
const KIND_HINT: Record<PollKindName, string> = {
  Stake: "A regular stake-weighted poll — everyone votes.",
  Governance:
    "Verified SPOs & dReps also weigh in with their delegated stake — a display-only Cardano temperature check.",
  Spo: "Only verified SPOs are tallied, by their pool's delegated stake — a display-only signal.",
  Drep: "Only verified dReps are tallied, by their delegated voting stake — a display-only signal.",
};

// The seven CIP-1694 governance actions. `spo`/`drep` = which bodies vote on Cardano (drives the guidance
// nudge toward a matching poll kind); `note` explains the on-chain voting for that action type.
const GOV_ACTIONS: {
  value: GovActionType;
  label: string;
  spo: boolean;
  drep: boolean;
  note: string;
}[] = [
  {
    value: "Info",
    label: "Info action",
    spo: true,
    drep: true,
    note: "A non-binding on-chain signal — both SPOs and dReps record votes. The closest analogue to this poll.",
  },
  {
    value: "NoConfidence",
    label: "Motion of no-confidence",
    spo: true,
    drep: true,
    note: "Decided by dReps and SPOs together.",
  },
  {
    value: "UpdateCommittee",
    label: "Update the Constitutional Committee",
    spo: true,
    drep: true,
    note: "Decided by dReps and SPOs together.",
  },
  {
    value: "NewConstitution",
    label: "New Constitution / guardrails",
    spo: false,
    drep: true,
    note: "Decided by dReps (and the Constitutional Committee) — SPOs do not vote on Cardano.",
  },
  {
    value: "HardFork",
    label: "Hard-fork initiation",
    spo: true,
    drep: true,
    note: "Decided by dReps and SPOs together.",
  },
  {
    value: "ParamChange",
    label: "Protocol-parameter change",
    spo: false,
    drep: true,
    note: "Usually dReps only — SPOs also vote when a security-group parameter is touched.",
  },
  {
    value: "TreasuryWithdrawal",
    label: "Treasury withdrawal",
    spo: false,
    drep: true,
    note: "Decided by dReps (and the Constitutional Committee) — SPOs do not vote on Cardano.",
  },
];

export interface PollComposerProps {
  viewer: Viewer;
  /** Controlled draft: { question, options, kind?, govAction? }. The two mandatory options must be present. */
  pollDraft: PollDraft;
  onChange: (draft: PollDraft) => void;
  submitState: ActionState;
  rateLimited?: boolean;
  retryInSeconds?: number | null;
  noPostingPower?: boolean;
  needsVotingPower?: boolean;
  autoFocus?: boolean;
  /**
   * Hand back the trimmed args; the surface calls mutations.submitCreatePoll(question, options, closeAt,
   * kind, action). `closeInDays` is `undefined` for a floating (no-deadline) poll; `kind` selects the
   * chamber lens ("Stake" default); `action` (only for a chamber kind) is the governance-action tag — its
   * CIP-1694 type + a link to the off-chain proposal.
   */
  submitCreatePoll: (
    question: string,
    options: string[],
    closeInDays?: number,
    kind?: PollKindName,
    action?: { actionType: GovActionType; anchorUrl: string },
  ) => void;
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
  const kind: PollKindName = pollDraft.kind ?? "Stake";
  const govAction = pollDraft.govAction;
  // Spread `...pollDraft` in every mutation so a change to one field (question / a choice / deadline /
  // kind / gov-action) preserves the others.

  const setQuestion = useCallback(
    (question: string) => onChange({ ...pollDraft, question, options }),
    [onChange, options, pollDraft],
  );

  const setCloseInDays = useCallback(
    // 0 = "No deadline" ⇒ a floating poll (undefined so the surface passes None).
    (days: number) => onChange({ ...pollDraft, options, closeInDays: days > 0 ? days : undefined }),
    [onChange, options, pollDraft],
  );

  const setKind = useCallback(
    (nextKind: PollKindName) =>
      onChange({
        ...pollDraft,
        options,
        kind: nextKind,
        // A gov-action tag only makes sense on a chamber kind — drop it when switching to Stake.
        govAction: kindIsChamber(nextKind) ? pollDraft.govAction : undefined,
      }),
    [onChange, options, pollDraft],
  );

  const toggleGovAction = useCallback(
    (on: boolean) => {
      if (!on) {
        onChange({ ...pollDraft, options, govAction: undefined });
        return;
      }
      // Enabling: preset the options to Yes/No/Abstain when the author hasn't typed any yet.
      const allEmpty = options.every((o) => o.trim().length === 0);
      onChange({
        ...pollDraft,
        options: allEmpty ? [...YES_NO_ABSTAIN] : options,
        govAction: { actionType: "Info", anchorUrl: "" },
      });
    },
    [onChange, options, pollDraft],
  );

  const setActionType = useCallback(
    (actionType: GovActionType) =>
      onChange({
        ...pollDraft,
        options,
        govAction: { actionType, anchorUrl: govAction?.anchorUrl ?? "" },
      }),
    [onChange, options, pollDraft, govAction],
  );

  const setAnchorUrl = useCallback(
    (value: string) => {
      const clamped =
        utf8Bytes(value) > MAX_ANCHOR_URL_BYTES ? clampToBytes(value, MAX_ANCHOR_URL_BYTES) : value;
      onChange({
        ...pollDraft,
        options,
        govAction: { actionType: govAction?.actionType ?? "Info", anchorUrl: clamped },
      });
    },
    [onChange, options, pollDraft, govAction],
  );

  const setOption = useCallback(
    (i: number, value: string) => {
      // Hard-block past 80 bytes at the code-point boundary (D1).
      const clamped = utf8Bytes(value) > MAX_POLL_OPTION_BYTES ? clampToBytes(value, MAX_POLL_OPTION_BYTES) : value;
      const next = options.map((o, idx) => (idx === i ? clamped : o));
      onChange({ ...pollDraft, options: next });
    },
    [onChange, options, pollDraft],
  );

  const addOption = useCallback(() => {
    if (options.length >= MAX_POLL_OPTIONS) return;
    onChange({ ...pollDraft, options: [...options, ""] });
  }, [onChange, options, pollDraft]);

  const removeOption = useCallback(
    (i: number) => {
      if (i < MIN_POLL_OPTIONS) return; // first two are mandatory
      onChange({ ...pollDraft, options: options.filter((_, idx) => idx !== i) });
    },
    [onChange, options, pollDraft],
  );

  // Focus an option input after the controlled re-render commits (setTimeout, not this render's DOM).
  const focusOptionSoon = useCallback((i: number) => {
    setTimeout(() => document.getElementById(`cg-poll-option-${i}`)?.focus(), 0);
  }, []);

  // Keyboard flow (X parity): Enter → next option (or add one from the last non-empty option, never
  // submitting the form); Backspace on an empty removable option → delete it and focus the previous.
  const onOptionKeyDown = useCallback(
    (i: number, e: KeyboardEvent<HTMLInputElement>) => {
      // ⌘/Ctrl+Enter submits from an option field too — parity with the question textarea, whose
      // shortcut the composer advertises. Route it through the enclosing <form> so it hits the exact
      // same validity-gated submit path (requestSubmit → Composer's onSubmit), rather than the
      // option-navigation branch below swallowing every Enter.
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.currentTarget.form?.requestSubmit();
        return;
      }
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

  // Validity: ≥2 non-empty options after trim, none over 80 bytes, and — for a tagged poll — a non-empty,
  // in-bound proposal link.
  const trimmed = options.map((o) => o.trim()).filter((o) => o.length > 0);
  const anyOptionOver = options.some((o) => utf8Bytes(o) > MAX_POLL_OPTION_BYTES);
  const enoughOptions = trimmed.length >= MIN_POLL_OPTIONS;
  const anchorEmpty = govAction ? govAction.anchorUrl.trim().length === 0 : false;
  const anchorTooLong = govAction ? utf8Bytes(govAction.anchorUrl) > MAX_ANCHOR_URL_BYTES : false;
  // The link must be a valid http(s) URL — the authoritative gate. The CTA and the ⌘/Ctrl+Enter submit
  // both respect `extraValid`, so a scheme-less / non-http anchor can never be written on-chain.
  const anchorUnsafe = govAction ? !isSafeAnchorUrl(govAction.anchorUrl) : false;
  const govOk = !govAction || (!anchorTooLong && !anchorUnsafe);
  const extraValid = enoughOptions && !anyOptionOver && govOk;

  // The metadata of the currently-selected action type, and whether the chosen kind covers the chambers
  // that vote it on Cardano (a non-blocking nudge — since every action is dRep-voted, an SPO-only poll on
  // any real action warns; picking Stake hides the section entirely).
  const selectedAction = govAction
    ? GOV_ACTIONS.find((a) => a.value === govAction.actionType)
    : undefined;
  const chamberMismatch = !selectedAction
    ? null
    : selectedAction.spo && !kindHasSpo(kind)
      ? "On Cardano this action is also decided by SPOs — consider a kind that includes the SPO chamber."
      : selectedAction.drep && !kindHasDrep(kind)
        ? "On Cardano this action is decided by dReps — pick a kind that includes the dRep chamber."
        : null;

  const onSubmit = useCallback(
    (draft: ComposerDraft) => {
      const out = options.map((o) => o.trim()).filter((o) => o.length > 0).slice(0, MAX_POLL_OPTIONS);
      if (out.length < MIN_POLL_OPTIONS) return; // guard (CTA should already be disabled)
      // A tagged poll must carry a valid http(s) link — refuse to submit an unlinkable anchor (belt-and-
      // suspenders; `extraValid` already gates both the CTA and the ⌘/Ctrl+Enter submit on this).
      if (govAction && !isSafeAnchorUrl(govAction.anchorUrl)) return;
      // A gov-action tag rides only on a chamber kind.
      const action =
        kindIsChamber(kind) && govAction
          ? { actionType: govAction.actionType, anchorUrl: govAction.anchorUrl.trim() }
          : undefined;
      // draft.text is the question with any @mention display tokens serialized to `@<ss58>` (the base
      // Composer owns that). Use it, NOT the raw pollDraft.question, so poll questions mention correctly.
      submitCreatePoll(draft.text, out, pollDraft.closeInDays, kind, action);
    },
    [options, submitCreatePoll, pollDraft.closeInDays, kind, govAction],
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

      <div className={styles.deadlineRow}>
        <label className={styles.deadlineLabel} htmlFor="cg-poll-kind">
          Poll type
        </label>
        <select
          id="cg-poll-kind"
          className={styles.deadline}
          value={kind}
          onChange={(e) => setKind(e.target.value as PollKindName)}
        >
          <optgroup label="Everyone">
            <option value="Stake">Stake — everyone votes</option>
          </optgroup>
          <optgroup label="Governance chambers">
            <option value="Governance">SPO &amp; dRep — both chambers</option>
            <option value="Spo">SPO only</option>
            <option value="Drep">dRep only</option>
          </optgroup>
        </select>
        <span className={styles.hint}>{KIND_HINT[kind]}</span>
      </div>

      {kindIsChamber(kind) && (
        <div className={styles.govSection}>
          <label className={styles.govToggle}>
            <input
              type="checkbox"
              checked={!!govAction}
              onChange={(e) => toggleGovAction(e.target.checked)}
            />
            <span className={styles.govToggleText}>Temperature-check a Cardano governance action</span>
          </label>

          {govAction && (
            <div className={styles.govFields}>
              <div className={styles.deadlineRow}>
                <label className={styles.deadlineLabel} htmlFor="cg-poll-gov-type">
                  Action type
                </label>
                <select
                  id="cg-poll-gov-type"
                  className={styles.deadline}
                  value={govAction.actionType}
                  onChange={(e) => setActionType(e.target.value as GovActionType)}
                >
                  {GOV_ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              {selectedAction && <span className={styles.govNote}>{selectedAction.note}</span>}
              {chamberMismatch && (
                <span className={styles.govWarn} role="status">
                  {chamberMismatch}
                </span>
              )}

              <div className={styles.govUrlRow}>
                <label className={styles.srOnly} htmlFor="cg-poll-gov-url">
                  Proposal link
                </label>
                <input
                  id="cg-poll-gov-url"
                  className={styles.govUrlInput}
                  type="text"
                  inputMode="url"
                  value={govAction.anchorUrl}
                  placeholder="https://github.com/org/proposal"
                  onChange={(e) => setAnchorUrl(e.target.value)}
                  aria-invalid={(anchorTooLong || (!anchorEmpty && anchorUnsafe)) || undefined}
                />
                <ByteCounter value={govAction.anchorUrl} maxBytes={MAX_ANCHOR_URL_BYTES} size="sm" />
              </div>
              {anchorEmpty ? (
                <span className={styles.hint}>Add a link to the proposal document.</span>
              ) : anchorUnsafe ? (
                <span className={styles.hint}>
                  Enter a full link starting with https:// (a GitHub or IPFS-gateway URL).
                </span>
              ) : null}
            </div>
          )}
        </div>
      )}

      <div className={styles.deadlineRow}>
        <label className={styles.deadlineLabel} htmlFor="cg-poll-deadline">
          Deadline
        </label>
        <select
          id="cg-poll-deadline"
          className={styles.deadline}
          value={pollDraft.closeInDays ?? 0}
          onChange={(e) => setCloseInDays(Number(e.target.value))}
        >
          <option value={0}>No deadline</option>
          <option value={1}>1 day</option>
          <option value={3}>3 days</option>
          <option value={7}>1 week</option>
        </select>
        <span className={styles.hint}>
          {pollDraft.closeInDays
            ? "Voting closes then; results can be finalized after."
            : "The poll stays open and results stay live."}
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
