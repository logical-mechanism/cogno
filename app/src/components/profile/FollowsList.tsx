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

import { useState } from "react";
import styles from "./FollowsList.module.css";
import exploreStyles from "@/components/explore/ExploreList.module.css";
import { PersonRow } from "@/components/explore/PersonRow";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import type { Suggestion, Viewer, Ss58 } from "@/components/kit";

/**
 * Rows rendered per step. The follow graph comes back whole (the runtime bounds it, at up to 1000 edges
 * a side) and this mapped ALL of it, one `PersonRow` each — and every row mounts `useStakeRing` /
 * `useReputation`, i.e. a `MicroblogApi.profile` state_call per row, uncached, whose tally
 * `FollowsList` then discards (it builds `{author, followerCount: 0}` with no `accountScore`, so the
 * read fires purely for the avatar ring). A thousand of those on one tap is waste, not cost.
 *
 * So it is a STEP, not a ceiling. A hard cut solved the fan-out by making rows 101+ of a 1000-follower
 * account unreachable from the UI altogether — trading a waste problem for a functional hole in the
 * one surface whose entire job is listing those accounts. Growing the window on demand costs the same
 * per row and reaches all of them.
 */
const ROW_STEP = 100;

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
  // How many rows are mounted. FollowsPanel re-keys this component per side, so switching Followers ↔
  // Following starts a fresh window rather than carrying one side's expansion into the other.
  const [shown, setShown] = useState(ROW_STEP);

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

  const visible = people.slice(0, shown);
  const remaining = people.length - visible.length;

  return (
    <div className={styles.list}>
      {visible.map((addr) => {
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
      {remaining > 0 && (
        <>
          <p className={exploreStyles.truncated}>
            Showing {visible.length} of {people.length} accounts.
          </p>
          <div className={styles.tail}>
            <button
              type="button"
              className={styles.showMore}
              onClick={() => setShown((n) => n + ROW_STEP)}
            >
              Show {Math.min(remaining, ROW_STEP)} more
            </button>
          </div>
        </>
      )}
    </div>
  );
}
