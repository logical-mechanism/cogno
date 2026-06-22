"use client";

// ProfileHeader — the profile chrome above the tabs (doc 07 §4): address-seeded accent banner →
// overlapping xl Avatar → action button (Follow / Following / Edit profile / Set up profile) →
// DisplayName + copyable Handle → linkified bio → FollowCounts → banned "restricted" note.
//
// There is NO banner field on-chain (D1/§4.1): the banner is a deterministic CSS gradient seeded from
// the address (a stable hue/angle offset per account), base colours --cg-accent → --cg-bg-subtle.
//
// The action button is the load-bearing self-vs-other switch (§4.4):
//   • self + has-profile  → "Edit profile" (outline pill) → onEditProfile()
//   • self + no-profile    → "Set up profile" (filled accent pill, the stronger nudge) → onEditProfile()
//   • someone else         → <FollowButton> (returns null on self; the gate funnels to /welcome)
//
// FollowCounts is OMITTED entirely when the reader can't serve follows (PAPI-direct) — never "0
// Followers" (§4.5). A banned author renders dimmed (Avatar dim + DisplayName authorRevoked) with a
// neutral "restricted" note — NO honesty/trust framing (D10). Posts stay visible (the tab cards dim
// themselves). FollowButton is still rendered for a banned account (the chain permits it).

import styles from "./ProfileHeader.module.css";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { Handle } from "@/components/Handle";
import { PostBody } from "@/components/PostBody";
import { FollowButton } from "@/components/FollowButton";
import { FollowCounts } from "./FollowCounts";
import type { Ss58, Viewer } from "@/components/kit";

/** A stable 0..359 hue offset + 0..89 angle offset derived from the address (FNV-1a-ish). */
function bannerStyle(address: string): React.CSSProperties {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = (h >>> 0) % 360;
  const angle = 90 + (((h >>> 9) >>> 0) % 90); // 90..179deg so the avatar-corner stays the lighter end
  // Rotate the accent base by the per-address hue so each banner reads as "their colour", while the
  // far stop fades into the subtle surface so the strip never looks like a broken empty grey bar.
  return {
    background: `linear-gradient(${angle}deg, color-mix(in oklab, var(--cg-accent) 70%, hsl(${hue} 60% 45%)) 0%, var(--cg-bg-subtle) 100%)`,
  };
}

export interface ProfileHeaderProps {
  /** ss58 of the profile being viewed (always present — validated upstream). */
  address: Ss58;
  displayName?: string;
  bio?: string;
  avatar?: string;
  banned: boolean;
  /** This is the viewer's own profile (self-view → Edit / Set-up, never FollowButton). */
  isSelf: boolean;
  /** self + all of displayName/bio/avatar empty → "Set up profile" (filled) vs "Edit profile" (outline). */
  hasProfile: boolean;
  /** Show the follower/following figures (caps.follows). Omit entirely when false. */
  showCounts: boolean;
  followingCount: number;
  followerCount: number;
  /** The viewer (gate state for FollowButton). */
  viewer: Viewer;
  /** Edge state for FollowButton (from useFollow). */
  isFollowing: boolean;
  /** Open the edit-profile modal (self only). */
  onEditProfile: () => void;
  /** Follow/unfollow toggle (others); the surface gates to /welcome when not ready. */
  onToggleFollow: (target: Ss58, next: boolean) => void;
}

export function ProfileHeader({
  address,
  displayName,
  bio,
  avatar,
  banned,
  isSelf,
  hasProfile,
  showCounts,
  followingCount,
  followerCount,
  viewer,
  isFollowing,
  onEditProfile,
  onToggleFollow,
}: ProfileHeaderProps) {
  const bioText = bio?.trim() ?? "";

  return (
    <section className={styles.header} aria-label="Profile">
      {/* Banner — deterministic accent gradient (no chain field, §4.1). Scrolls under the sticky hdr. */}
      <div className={styles.banner} style={bannerStyle(address)} aria-hidden />

      <div className={styles.body}>
        {/* avatar (overlapping the banner) on the left; the action button on the right (§2.1) */}
        <div className={styles.topRow}>
          <div className={styles.avatarRing}>
            <Avatar
              address={address}
              src={avatar}
              size="xl"
              dim={banned}
              name={displayName}
            />
          </div>

          <div className={styles.action}>
            {isSelf ? (
              <button
                type="button"
                className={hasProfile ? styles.editBtn : styles.setupBtn}
                onClick={onEditProfile}
              >
                {hasProfile ? "Edit profile" : "Set up profile"}
              </button>
            ) : (
              <FollowButton
                target={address}
                isFollowing={isFollowing}
                viewer={viewer}
                onToggle={onToggleFollow}
              />
            )}
          </div>
        </div>

        <div className={styles.identity}>
          <DisplayName
            address={address}
            displayName={displayName}
            authorRevoked={banned}
            truncate={false}
          />
          <Handle address={address} truncate="middle" copyable />
        </div>

        {bioText.length > 0 && (
          <div className={styles.bio}>
            <PostBody text={bioText} dim={banned} />
          </div>
        )}

        {banned && (
          <p className={styles.restricted} role="note">
            This account has been restricted.
          </p>
        )}

        {/* Counts omitted entirely on PAPI-direct (caps.follows === false) — never "0 Followers". */}
        {showCounts && (
          <FollowCounts following={followingCount} followers={followerCount} />
        )}
      </div>
    </section>
  );
}
