"use client";

// ProfileHeader — the profile chrome above the tabs (doc 07 §4): banner → overlapping xl Avatar →
// action button (Follow / Following / Edit profile / Set up profile) → DisplayName + copyable Handle →
// linkified bio → location / website meta → FollowCounts → banned "restricted" note.
//
// BANNER (spec-118): a `banner` URL/CID set on-chain renders as the header image behind a click-to-
// reveal cover (no auto-fetch of an arbitrary host). With no banner set we fall back to a deterministic
// CSS gradient seeded from the address (a stable hue/angle offset per account).
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
import { RevealImage } from "@/components/RevealImage";
import { IconLink } from "@/components/icons";
import { FollowCounts } from "./FollowCounts";
import { resolveImageSrc } from "@/lib/media";
import type { Ss58, Viewer } from "@/components/kit";

/** Ensure a website value carries a scheme so the anchor href resolves (default https). */
function websiteHref(raw: string): string {
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Display a website without scheme / leading www / trailing slash (X-style). */
function websiteLabel(raw: string): string {
  return raw
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/+$/, "");
}

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
  /** spec-118: banner reference (URL / IPFS CID), free-text location, website URL. */
  banner?: string;
  location?: string;
  website?: string;
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
  banner,
  location,
  website,
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
  const bannerSrc = banner?.trim() ?? "";
  const locationText = location?.trim() ?? "";
  const websiteText = website?.trim() ?? "";

  return (
    <section className={styles.header} aria-label="Profile">
      {/* Banner — the on-chain banner image behind a reveal cover, else a deterministic gradient. */}
      {bannerSrc.length > 0 ? (
        <div className={styles.banner}>
          <RevealImage
            src={resolveImageSrc(bannerSrc)}
            alt="Profile banner"
            fit="cover"
            label="Show banner"
            hideLabel="Hide banner"
            fallback={<span className={styles.bannerFallback} style={bannerStyle(address)} />}
          />
        </div>
      ) : (
        <div className={styles.banner} style={bannerStyle(address)} aria-hidden />
      )}

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

        {(locationText.length > 0 || websiteText.length > 0) && (
          <div className={styles.meta}>
            {locationText.length > 0 && <span className={styles.metaItem}>{locationText}</span>}
            {websiteText.length > 0 && (
              <a
                className={styles.metaLink}
                href={websiteHref(websiteText)}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                <IconLink className={styles.metaIcon} aria-hidden />
                <span>{websiteLabel(websiteText)}</span>
              </a>
            )}
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
