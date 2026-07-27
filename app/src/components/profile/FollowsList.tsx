"use client";

// FollowsList — the list body for the Followers / Following sub-view (FollowsPanel). Mirrors the four
// list states of the Explore People list (ExploreList): loading → Skeleton 'person' ×6; error → a
// 'generic' EmptyState + Retry; empty → a 'follows' EmptyState with per-side copy; rows → a column of
// the shared PersonRow.
//
// The follow graph (source.followEdges) yields only ss58 ids, so each row is built from a MINIMAL
// Suggestion — the real @handle + identicon + a working FollowButton, with the display name falling
// back to the address-derived label exactly as everywhere else that lacks a fetched profile (real
// per-row display names would need a node profiles-by-address batch read — out of scope / no backend).

import styles from "./FollowsList.module.css";
import exploreStyles from "@/components/explore/ExploreList.module.css";
import { PersonRow } from "@/components/explore/PersonRow";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import type { Suggestion, Viewer, Ss58 } from "@/components/kit";

/**
 * Rows rendered at once. The follow graph comes back whole (the runtime bounds it, at up to 1000 edges
 * a side) and this mapped ALL of it, one `PersonRow` each — and every row mounts `useStakeRing` /
 * `useReputation`, i.e. a `MicroblogApi.profile` state_call per row, uncached, whose tally
 * `FollowsList` then discards (it builds `{author, followerCount: 0}` with no `accountScore`, so the
 * read fires purely for the avatar ring). A thousand of those on one tap is waste, not cost, and the
 * cap is the actionable half. `ExploreList` already renders exactly this note on exactly this row type.
 */
const MAX_ROWS = 100;

export interface FollowsListProps {
  /** The accounts to list (followers OR following, resolved by FollowsPanel from followEdges). */
  people: Ss58[];
  viewer: Viewer;
  /** Initial-load skeleton (the followEdges read is in flight and nothing is cached yet). */
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Per-side empty copy (e.g. "@… has no followers yet."). */
  emptyTitle: string;
  emptyDescription?: string;
  isFollowing: (target: string) => boolean;
  onToggleFollow: (target: string, next: boolean) => void;
}

export function FollowsList({
  people,
  viewer,
  loading,
  error,
  onRetry,
  emptyTitle,
  emptyDescription,
  isFollowing,
  onToggleFollow,
}: FollowsListProps) {
  if (loading && people.length === 0) {
    return (
      <div className={styles.list} aria-busy="true">
        <Skeleton variant="person" count={6} />
      </div>
    );
  }

  if (error && people.length === 0) {
    return (
      <div className={styles.list}>
        <EmptyState
          variant="generic"
          title="Couldn't load this list."
          description="Check your connection and try again."
          action={onRetry ? { label: "Retry", onClick: onRetry } : undefined}
        />
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className={styles.list}>
        <EmptyState variant="follows" title={emptyTitle} description={emptyDescription} />
      </div>
    );
  }

  const shown = people.slice(0, MAX_ROWS);

  return (
    <div className={styles.list}>
      {shown.map((addr) => {
        // A minimal Suggestion — followEdges carries no profile fields; PersonRow renders the handle +
        // identicon + FollowButton, and hides the follower-count/reputation meta when they're absent.
        const person: Suggestion = { author: addr, followerCount: 0 };
        return (
          <PersonRow
            key={addr}
            person={person}
            viewer={viewer}
            isFollowing={isFollowing(addr)}
            onToggleFollow={onToggleFollow}
          />
        );
      })}
      {people.length > MAX_ROWS && (
        <p className={exploreStyles.truncated}>
          Showing {MAX_ROWS} of {people.length} accounts.
        </p>
      )}
    </div>
  );
}
