"use client";

// MentionChip — renders an in-body `@<ss58>` mention as a link to that person's profile, showing their
// CURRENT display name (resolved + cached via useAccountProfile) beside an offline identicon.
//
// Graceful degradation (D6): an unbound / nameless / still-loading account shows the truncated ss58
// (`@5Grw…utQY`) — never a broken render. The identicon is deterministic + offline (no fetch), so we
// deliberately DON'T surface the account's avatar image here: that would auto-fetch an arbitrary host,
// which the app's reveal-cover posture forbids for un-tapped remote content.

import Link from "next/link";
import { Avatar } from "./Avatar";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { truncateSs58 } from "@/lib/ss58";
import styles from "./MentionChip.module.css";

export function MentionChip({ ss58 }: { ss58: string }) {
  const profile = useAccountProfile(ss58);
  const name = profile?.displayName;
  // Resolved with a name → show it; unbound / nameless / loading → the truncated ss58 (never broken).
  const label = name ?? truncateSs58(ss58);
  return (
    <Link
      href={`/u/${ss58}/`}
      className={styles.mention}
      title={ss58}
      // Inside a clickable PostCard row — don't also trigger the row navigation.
      onClick={(e) => e.stopPropagation()}
    >
      <Avatar address={ss58} size={16} name={name} />
      <span className={styles.name}>@{label}</span>
    </Link>
  );
}
