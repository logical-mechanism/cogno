"use client";

// ReputationBadge — the small community-reputation chip shown next to an author's name on a post
// header. Self-fetching: it reads the author's NET stake-weighted reputation from the shared
// `useReputation` cache (a batched, cached `AccountVoteTally` read) and renders the signed magnitude.
// A quick "good actor vs troll / shitpost" signal inline on the timeline — the same reputation number
// the profile header and People rows already surface, so you don't have to open the profile to gauge
// who you're reading.
//
// Renders NOTHING for an unknown / still-loading score or a neutral net-zero score (most accounts on a
// fresh chain) — see `reputationBadge`. Positive is toned neutral (endorsed); a negative net score is
// toned danger-red (community-disputed), matching the People-row treatment (the app is monochrome +
// danger — there is no green token).

import styles from "./ReputationBadge.module.css";
import { useAuthorReputation } from "@/hooks/useReputation";
import { reputationBadge } from "@/lib/reputation";

export function ReputationBadge({ address }: { address: string }) {
  const score = useAuthorReputation(address);
  const view = reputationBadge(score);
  if (!view) return null;
  return (
    <span
      className={`${styles.badge} ${view.tone === "down" ? styles.down : styles.up}`}
      title="Community reputation (stake-weighted). Higher means more endorsed by the community; a negative score is disputed."
      // Spell the direction out — the +/− sign glyph (a U+2212 minus for negatives) is unreliably
      // announced by screen readers, so "endorsed"/"disputed" carries the good-actor/troll signal.
      aria-label={`Community reputation: ${view.tone === "down" ? "disputed" : "endorsed"}, ${view.label}`}
    >
      {view.label}
    </span>
  );
}
