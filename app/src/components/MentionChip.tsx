"use client";

// MentionChip — renders an in-body `@<ss58>` mention as a link to that person's profile, showing their
// CURRENT display name (resolved + cached via useAccountProfile) NEXT TO their truncated address, and
// — on desktop hover — the same ProfileHoverCard quick-view that the author line at the top of a post
// opens.
//
// THE ADDRESS IS NOT DECORATION. It used to appear only in `title`, which is invisible on touch and
// unreliable to a screen reader, and the hover card is gated on `(hover: hover)` so it never opens on a
// phone at all. That left the display name as the sole identity signal — and the name is resolved LIVE
// at render time while the post is permanent, so someone mentioned as `@alice` could rename to
// `@intersect_official` and silently rewrite what a stranger's undeletable post appears to say. Every
// other identity surface in the app (PostCardHeader, MentionSuggestions, PersonRow, FollowsPanel) pairs
// a name with a `<Handle>`; this was the one that did not. See `mentionParts` in lib/mentions for the
// rule and the full reasoning, and note that lib/sanitize's tolerance of one residual spoof class rests
// on the ss58 being shown beside every name — which is only true once this render is.
//
// `<Handle>` itself is deliberately NOT reused here: it renders its own `<span>`/`<Link>`/`<button>`,
// and nesting an interactive element inside this `<Link>` is invalid. The truncation helper is shared
// instead, so the `5Grw…utQY` shape stays identical everywhere.
//
// It is TEXT, not a chip. It used to lead with a 16px identicon; at that size an identicon carries no
// recognisable signal, and a run of them mid-sentence read as noise rather than as identity. The
// avatar, bio, counts and Follow button all live in the hover card, which is where someone actually
// asking "who is this?" goes — and which now costs a hover instead of a navigation.
//
// Graceful degradation (D6): an unbound / nameless / still-loading account shows the truncated ss58
// as its label (`@5Grw…utQY`) with no second copy beside it — never a broken render.

import Link from "next/link";
import { ProfileHoverCard } from "./ProfileHoverCard";
import { useAccountProfile } from "@/hooks/useAccountProfile";
import { mentionParts } from "@/lib/mentions";
import styles from "./MentionChip.module.css";
import type { Ss58 } from "@/lib/types";

// NOTE: a blocked account @mentioned inside a THIRD party's post still renders their name here. Doing
// otherwise needs the viewer's ss58, and the only source of it (useSession) changes every block — reading
// it in this leaf would re-render every mention chip in the feed each block. Threading `me` down through
// PostBody to reach here isn't worth it for that narrow residual: the blocked account's own posts, quotes,
// replies, People rows and mention-autocomplete are all still suppressed.
export function MentionChip({ ss58 }: { ss58: Ss58 }) {
  const profile = useAccountProfile(ss58);
  const name = profile?.displayName;
  // Resolved with a name → the name PLUS the truncated address; unbound / nameless / loading → the
  // truncated ss58 alone as the label, with `address` null so it is not printed twice.
  // `mentionParts` also COLLAPSES whitespace in the name — see `mentionLabel`'s doc: a post body is
  // `pre-wrap`, so a name carrying newlines would otherwise break the line inside someone else's post.
  const { label, address } = mentionParts(name, ss58);

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
        // The visible text is "@name 5Grw…utQY", which a screen reader would otherwise read as two
        // unrelated runs (and spell the address out character by character). Name the relationship
        // instead. Same treatment, and same reason, as PersonRow's reputation figure.
        aria-label={address ? `${label}, account ${address}` : `Account ${label}`}
        // Inside a clickable PostCard row — don't also trigger the row navigation.
        onClick={(e) => e.stopPropagation()}
      >
        @{label}
        {address && <span className={styles.address}>{address}</span>}
      </Link>
    </ProfileHoverCard>
  );
}
