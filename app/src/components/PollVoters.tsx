"use client";

// PollVoters — who voted in a governance poll, and which way.
//
// This is the accountability surface. Every voter's identity and choice has been on chain since polls
// shipped, and a stake-weighted governance poll with an anonymous electorate is an opinion poll with
// extra arithmetic.
//
// IT DOES NOT LOAD UNTIL ASKED. It used to read on mount, so every reader who opened a poll paid a full
// `PollVotes` prefix enumeration whether or not they ever scrolled to a single name. The read now starts
// when this section is opened, which is the change that matters most, because most readers never open it.
//
// IT PAGES, IT DOES NOT CAP. The old read pulled the whole prefix and sliced the first 200 client-side —
// roughly 0.42 KB per voter, so about 4 MB at ten thousand, to render an alphabetical-by-address sample
// under a caveat admitting the rest was unreachable. Rows now arrive ~50 at a time by storage cursor.
// There is no cap left to disclose and no hidden remainder.
//
// FLAT, NOT GROUPED BY OPTION, and that is a paging decision. Storage order interleaves the options, so
// grouping would insert each new page's rows into the MIDDLE of the list under their headings, which
// reads as the page rearranging itself under the reader. A flat list always appends at the bottom and
// the per-row chip carries the same fact. The per-option TOTALS still lead the section, taken from the
// poll's own aggregate — so they are the true counts even when a single page has loaded.
//
// THE LOOKUP answers the question people actually have ("how did my dRep vote?"). It is a point read of
// `PollVotes[host][who]`, so it costs the same on a poll with ten voters and one with ten thousand, and
// it never enumerates. That is why it sits ABOVE the list rather than filtering it: a filter could only
// search rows that happened to be fetched, and would answer "has not voted" for someone who simply had
// not been paged in yet — the one wrong answer this surface must never give.
//
// WHAT IT STILL DOES NOT SHOW. Per-voter WEIGHT. The runtime derives chamber weights inside
// `poll_chamber_weights` and exposes only the per-option aggregate, so showing one would mean inventing
// it. That needs a runtime read, which is a spec bump.
//
// POSITIONS ARE CURRENT, NOT HISTORICAL. A re-cast replaces, and the chain keeps no per-vote block
// height, so this is where each account stands now. Same reason ReplyVoteChip is present tense.

import { useCallback, useId, useState } from "react";
import Link from "next/link";
import { Handle } from "./Handle";
import { DisplayName } from "./DisplayName";
import { Spinner } from "./icons";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { classifyChoice } from "@/lib/cardano/governance";
import { pollChoiceLabel } from "@/lib/poll";
import { sanitizeInline } from "@/lib/sanitize";
import { normalizeSs58 } from "@/lib/ss58";
import type { PollVoter } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";
import styles from "./PollVoters.module.css";

/** One voter. Split out so `useAccountProfile` (a shared, cached read) is called per row, not in a loop. */
function VoterRow({ who, choice }: { who: Ss58; choice: string | null }) {
  const profile = useAccountProfile(who);
  return (
    <li className={styles.voter}>
      <Link href={`/u/${who}/`} className={styles.link} prefetch={false}>
        <DisplayName address={who} displayName={profile?.displayName} truncate />
        <Handle address={who} />
      </Link>
      {choice && (
        <span className={styles.choice} data-choice={classifyChoice(choice)}>
          {choice}
        </span>
      )}
    </li>
  );
}

/** One option's true voter count, from the poll's own aggregate rather than from what has loaded. */
export interface PollVoterTotal {
  label: string;
  count: number;
}

export interface PollVotersProps {
  /** Loaded so far, in storage order. Null until the first page lands (or while closed). */
  voters: readonly PollVoter[] | null;
  /** Option labels in on-chain index order. */
  labels: readonly string[];
  /** The TRUE per-option counts. Correct before a single row has loaded. */
  totals: readonly PollVoterTotal[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  /** The first page failed with nothing loaded. */
  failed: boolean;
  /** Whether the roster is open. Owned by the parent, because opening is what STARTS the read. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Point read: one account's current option index in this poll, or null if they have not cast. */
  onLookup: (who: Ss58) => Promise<number | null>;
}

type LookupState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "voted"; who: Ss58; label: string | null }
  | { kind: "absent"; who: Ss58 }
  | { kind: "bad" };

export function PollVoters({
  voters,
  labels,
  totals,
  loading,
  hasMore,
  loadMore,
  failed,
  open,
  onOpenChange,
  onLookup,
}: PollVotersProps) {
  const [query, setQuery] = useState("");
  const [lookup, setLookup] = useState<LookupState>({ kind: "idle" });
  const id = useId();

  const total = totals.reduce((s, t) => s + t.count, 0);

  const check = useCallback(
    async (raw: string) => {
      // `normalizeSs58` re-encodes to this chain's prefix, so the same key pasted in another network's
      // format still matches. Something that is not an address never becomes a read at all — it is a
      // typo, and "has not voted" would be the wrong answer to one.
      const who = normalizeSs58(raw.trim());
      if (!who) {
        setLookup({ kind: "bad" });
        return;
      }
      setLookup({ kind: "checking" });
      try {
        const option = await onLookup(who as Ss58);
        setLookup(
          option == null
            ? { kind: "absent", who: who as Ss58 }
            : { kind: "voted", who: who as Ss58, label: pollChoiceLabel(labels, option) },
        );
      } catch {
        setLookup({ kind: "bad" });
      }
    },
    [onLookup, labels],
  );

  // Nobody has voted, so there is no section: a plain poll never grows an empty disclosure.
  if (total === 0) return null;

  return (
    <section className={styles.block} aria-labelledby={`${id}-h`}>
      <h3 className={styles.heading}>
        <button
          type="button"
          id={`${id}-h`}
          className={styles.disclosure}
          aria-expanded={open}
          aria-controls={open ? `${id}-body` : undefined}
          onClick={() => onOpenChange(!open)}
        >
          <span className={styles.caret} aria-hidden>
            {open ? "▾" : "▸"}
          </span>
          How each voter stands
          <span className={styles.count}>{total.toLocaleString()}</span>
        </button>
      </h3>

      {open && (
        <div id={`${id}-body`}>
          {/* The true split. Sanitized because an option label is unvalidated on-chain bytes. */}
          <p className={styles.totals}>
            {totals
              .filter((t) => t.count > 0 && sanitizeInline(t.label))
              .map((t) => `${t.count.toLocaleString()} ${sanitizeInline(t.label)}`)
              .join(" · ")}
          </p>

          <form
            className={styles.lookup}
            onSubmit={(e) => {
              e.preventDefault();
              void check(query);
            }}
          >
            <label className={styles.srOnly} htmlFor={`${id}-q`}>
              Check whether an address voted in this poll
            </label>
            <input
              id={`${id}-q`}
              className={styles.input}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (lookup.kind !== "idle") setLookup({ kind: "idle" });
              }}
              placeholder="Check an address"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className={styles.checkBtn} disabled={query.trim().length === 0}>
              Check
            </button>
          </form>

          {lookup.kind !== "idle" && (
            <p className={styles.lookupResult} role="status">
              {lookup.kind === "checking" ? (
                <>
                  <Spinner size="sm" label="Checking" /> Checking…
                </>
              ) : lookup.kind === "bad" ? (
                "That does not look like an address on this chain."
              ) : lookup.kind === "absent" ? (
                "That account has not voted in this poll."
              ) : (
                <>
                  Voted{" "}
                  <strong>
                    {lookup.label && sanitizeInline(lookup.label)
                      ? sanitizeInline(lookup.label)
                      : "an option"}
                  </strong>
                  .{" "}
                  <Link href={`/u/${lookup.who}/`} className={styles.link} prefetch={false}>
                    View profile
                  </Link>
                </>
              )}
            </p>
          )}

          {failed ? (
            <p className={styles.note} role="status">
              Couldn&apos;t load the list.{" "}
              <button type="button" className={styles.retry} onClick={loadMore}>
                Try again
              </button>
            </p>
          ) : (
            <>
              <ul className={styles.list}>
                {(voters ?? []).map((v) => {
                  const label = pollChoiceLabel(labels, v.option);
                  const safe = label ? sanitizeInline(label) : null;
                  return <VoterRow key={v.who} who={v.who} choice={safe || null} />;
                })}
              </ul>
              {loading && (
                <p className={styles.note}>
                  <Spinner size="sm" label="Loading voters" /> Loading…
                </p>
              )}
              {!loading && hasMore && (
                <button type="button" className={styles.more} onClick={loadMore}>
                  Load more
                </button>
              )}
            </>
          )}

          <p className={styles.note}>
            Positions are current. A voter can change their choice while the poll is open, and the chain
            keeps only the latest one. Individual voting weight is not shown.
          </p>
        </div>
      )}
    </section>
  );
}

export default PollVoters;
