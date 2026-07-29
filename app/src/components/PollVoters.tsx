"use client";

// PollVoters — who voted in a governance poll, and which way.
//
// This is the accountability surface. Every voter's identity and choice has been on chain since polls
// shipped, and until now nothing rendered any of it: a reader saw aggregate chamber bars and their own
// check mark, and could not see a single individual. A stake-weighted governance poll with an anonymous
// electorate is an opinion poll with extra arithmetic.
//
// WHAT IT DOES NOT SHOW, AND WHY. Per-voter WEIGHT. The runtime derives chamber weights inside
// `poll_chamber_weights` and exposes only the per-option aggregate through `MicroblogApi.poll`; there is
// no per-voter weight read, so showing one would mean inventing it. Grouping by option and naming each
// voter is the honest subset, and it is most of the value. A per-voter weight needs a runtime read,
// which is a spec bump, and belongs with the other chain-change work rather than smuggled in here.
//
// NO ROLE BADGE PER ROW, for now. `useAccountProfile` carries the display name and avatar only, so a
// badge here would mean a second per-voter read of the roles map. The voter's profile link carries it
// one tap away, and adding a read per row to a list that can hold two hundred is not worth it until the
// list is paged.
//
// POSITIONS ARE CURRENT, NOT HISTORICAL. A re-cast replaces, and the chain keeps no per-vote block
// height, so this is where each account stands now. Same reason ReplyVoteChip is present tense.

import Link from "next/link";
import { Handle } from "./Handle";
import { DisplayName } from "./DisplayName";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { classifyChoice } from "@/lib/cardano/governance";
import { sanitizeInline } from "@/lib/sanitize";
import type { PollVoter } from "@/lib/chain/social-reads";
import type { Ss58 } from "@/lib/types";
import styles from "./PollVoters.module.css";

/** One voter. Split out so `useAccountProfile` (a shared, cached read) is called per row, not in a loop. */
function VoterRow({ who }: { who: Ss58 }) {
  const profile = useAccountProfile(who);
  return (
    <li className={styles.voter}>
      <Link href={`/u/${who}/`} className={styles.link} prefetch={false}>
        <DisplayName address={who} displayName={profile?.displayName} truncate />
        <Handle address={who} />
      </Link>
    </li>
  );
}

export interface PollVotersProps {
  voters: readonly PollVoter[] | null;
  /** Option labels in on-chain index order. */
  labels: readonly string[];
  /** True when the read hit its cap, so the list is a sample rather than the whole electorate. */
  truncated: boolean;
}

export function PollVoters({ voters, labels, truncated }: PollVotersProps) {
  if (voters == null) return null; // still loading: an identity list that pops in beats a shimmer block
  if (voters.length === 0) return null; // nobody has voted; the poll's own "no votes" copy covers it

  // Grouped by the option each voter chose, in on-chain option order so Yes precedes No precedes Abstain
  // exactly as the poll's own bars do. A voter whose option index has no label (a poll edited out from
  // under them, which cannot happen today) is dropped rather than rendered under a blank heading.
  const groups = labels
    .map((label, index) => ({
      label: sanitizeInline(label),
      index,
      members: voters.filter((v) => v.option === index),
    }))
    .filter((g) => g.label && g.members.length > 0);

  // How many voters are actually ON SCREEN, which is not `voters.length`: the two filters above drop a
  // voter whose option index has no label, and a whole group whose label sanitizes away to nothing (an
  // on-chain option written entirely in bidi or invisible characters, which is exactly the unvalidated
  // bytes case sanitizeInline exists for). The truncation note below quotes this, because a number that
  // does not match the rows under it misrepresents the vote on the one surface that cannot afford to.
  const shown = groups.reduce((n, g) => n + g.members.length, 0);
  // Nothing survived grouping, so there is no option text to file anyone under. A heading and a
  // caveat over an empty list names nobody and reads as "no positions", which is a different claim.
  if (shown === 0) return null;

  return (
    <section className={styles.block} aria-labelledby="cg-poll-voters">
      <h3 className={styles.heading} id="cg-poll-voters">
        How each voter stands
      </h3>
      {groups.map((g) => (
        <div className={styles.group} key={g.index}>
          <p className={styles.groupHead} data-choice={classifyChoice(g.label)}>
            {g.label}
            <span className={styles.count}>
              {g.members.length} {g.members.length === 1 ? "voter" : "voters"}
            </span>
          </p>
          <ul className={styles.list}>
            {g.members.map((v) => (
              <VoterRow key={v.who} who={v.who} />
            ))}
          </ul>
        </div>
      ))}
      {/* Stated, never silent. A truncated roster that reads as complete would misrepresent the vote,
          which is the one failure this surface cannot afford. */}
      {truncated && (
        <p className={styles.note}>
          Showing the first {shown} voters by account. More have voted than are listed here.
        </p>
      )}
      <p className={styles.note}>
        Positions are current. A voter can change their choice while the poll is open, and the chain
        keeps only the latest one. Individual voting weight is not shown.
      </p>
    </section>
  );
}

export default PollVoters;
