"use client";

// ReplyVoteChip — how a reply's author is voting in the poll the thread hangs off, rendered on their
// identity line beside the role and reputation badges.
//
// The point is to bind an argument to a position: a thread under a governance poll is full of people
// making a case, and until now nothing on the page said which way the person making it had actually
// cast.
//
// PRESENT TENSE, DELIBERATELY. A poll vote can be re-cast at any time and the chain keeps only the
// CURRENT choice, with no record of when it was made. So this is not "voted Yes when they wrote this" —
// a reply arguing one way can legitimately carry the opposite chip, because its author changed their
// mind after posting. "Voting Yes" is the only reading that is true of what the chain actually stores.

import { sanitizeInline } from "@/lib/sanitize";
import { classifyChoice } from "@/lib/cardano/governance";
import styles from "./ReplyVoteChip.module.css";

export function ReplyVoteChip({ label }: { label: string }) {
  // Sanitize BEFORE the empty check, not after: the on-chain option text is unvalidated bytes, so a
  // label made entirely of bidi or invisible characters is non-empty raw and empty once cleaned. Testing
  // the raw string would render a chip reading "Voting " with nothing after it.
  const safe = sanitizeInline(label);
  if (!safe) return null;

  return (
    <span className={styles.chip} data-choice={classifyChoice(safe)} title="This author's current vote in this poll">
      {/* The clamp lives on an inner span because the chip is an inline-flex container, and a text child
          of a flex container is an anonymous flex item that text-overflow cannot reach. Same shape as
          RoleBadge's .detail. */}
      <span className={styles.label}>Voting {safe}</span>
    </span>
  );
}

export default ReplyVoteChip;
