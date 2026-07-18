"use client";

// MentionChip — renders an in-body `@<ss58>` mention as a link to that person's profile, showing their
// CURRENT display name (resolved + cached via useAccountProfile), and — on desktop hover — the same
// ProfileHoverCard quick-view that the author line at the top of a post opens.
//
// It is TEXT, not a chip. It used to lead with a 16px identicon; at that size an identicon carries no
// recognisable signal, and a run of them mid-sentence read as noise rather than as identity. The
// avatar, bio, counts and Follow button all live in the hover card, which is where someone actually
// asking "who is this?" goes — and which now costs a hover instead of a navigation.
//
// Graceful degradation (D6): an unbound / nameless / still-loading account shows the truncated ss58
// (`@5Grw…utQY`) — never a broken render.

import Link from "next/link";
import { ProfileHoverCard } from "./ProfileHoverCard";
import { useSession } from "./Providers";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { useBlocked } from "@/lib/blockStore";
import { mentionLabel } from "@/lib/mentions";
import { truncateSs58 } from "@/lib/ss58";
import styles from "./MentionChip.module.css";
import type { Ss58 } from "@/lib/types";

export function MentionChip({ ss58 }: { ss58: Ss58 }) {
  const profile = useAccountProfile(ss58);
  const { viewer } = useSession();
  const blocked = useBlocked(ss58, viewer.address ?? null);

  // A blocked account @mentioned in a THIRD party's post collapses to a bare, non-linked, name-less token:
  // block means never display their content or interactions — including their name + profile quick-view —
  // even when the mention rides inside someone else's (unblocked) post. We can't remove it from that post's
  // bytes, so we neutralize its identity surface instead.
  if (blocked) {
    return (
      <span className={styles.mention} title={ss58}>
        @{truncateSs58(ss58)}
      </span>
    );
  }

  const name = profile?.displayName;
  // Resolved with a name → show it; unbound / nameless / loading → the truncated ss58 (never broken).
  // `mentionLabel` also COLLAPSES whitespace in the name — see its doc: a post body is `pre-wrap`, so
  // a name carrying newlines would otherwise break the line inside someone else's post.
  const label = mentionLabel(name, ss58);

  return (
    <ProfileHoverCard
      inline
      author={{
        address: ss58,
        displayName: name,
        avatar: profile?.avatar,
        // A SEED only — the card's own profile() read supplies the truth (and dims a revoked account).
        // The mention text itself has never dimmed, and this doesn't change that.
        banned: false,
      }}
    >
      <Link
        href={`/u/${ss58}/`}
        className={styles.mention}
        title={ss58}
        // Inside a clickable PostCard row — don't also trigger the row navigation.
        onClick={(e) => e.stopPropagation()}
      >
        @{label}
      </Link>
    </ProfileHoverCard>
  );
}
