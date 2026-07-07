"use client";

// PersonRow — the shared "person" row primitive for the Explore People tab (surface 10 §6). A single
// row = Avatar (md) + DisplayName + Handle (mono) + follower count + a FollowButton. It is the same
// shape the RightRail who-to-follow uses, at a larger touch size; PersonResult is a thin wrapper over
// it. A `Suggestion` carries no bio, so there is NO bio line (per the brief). The whole who-block
// (avatar + names) is a link to the profile; the FollowButton sits outside the link so its click
// doesn't navigate.

import Link from "next/link";
import styles from "./PersonRow.module.css";
import { Avatar } from "@/components/Avatar";
import { DisplayName } from "@/components/DisplayName";
import { Handle } from "@/components/Handle";
import { FollowButton } from "@/components/FollowButton";
import { formatCount, formatSignedWeight } from "@/lib/format";
import type { Suggestion, Viewer } from "@/components/kit";

export interface PersonRowProps {
  person: Suggestion;
  viewer: Viewer;
  isFollowing: boolean;
  onToggleFollow: (target: string, next: boolean) => void;
  /** Search term to <mark> in the display name (People search results; omitted for who-to-follow). */
  highlight?: string;
}

export function PersonRow({ person, viewer, isFollowing, onToggleFollow, highlight }: PersonRowProps) {
  const count = formatCount(person.followerCount);
  const followers =
    person.followerCount > 0
      ? `${count} ${person.followerCount === 1 ? "follower" : "followers"}`
      : null;
  // Community reputation (stake-weighted up/down ON this account). Shown only when non-zero; a
  // negative net score (down-voted / disputed) is flagged red.
  const rep =
    person.accountScore != null && person.accountScore !== 0n
      ? formatSignedWeight(person.accountScore)
      : null;
  const repNeg = person.accountScore != null && person.accountScore < 0n;

  return (
    <div className={styles.row}>
      <Link
        href={`/u/${person.author}/`}
        className={styles.who}
        aria-label={`Profile ${person.author}`}
      >
        <Avatar address={person.author} src={person.avatar} size="md" name={person.displayName} />
        <span className={styles.text}>
          <DisplayName
            address={person.author}
            displayName={person.displayName}
            truncate
            highlight={highlight}
          />
          <span className={styles.meta}>
            <Handle address={person.author} />
            {followers && <span className={styles.followers}>{followers}</span>}
            {rep && (
              <span
                className={`${styles.rep} ${repNeg ? styles.repDown : ""}`}
                title="Community reputation (stake-weighted)"
              >
                {rep}
              </span>
            )}
          </span>
        </span>
      </Link>
      <div className={styles.action}>
        <FollowButton
          target={person.author}
          isFollowing={isFollowing}
          viewer={viewer}
          onToggle={onToggleFollow}
        />
      </div>
    </div>
  );
}
