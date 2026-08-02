"use client";

// ExploreList — the People-tab list container. Renders the four list states for a
// people search: loading → Skeleton variant='person' ×6; empty → people-flavoured `search`
// EmptyState; error → inline `generic` EmptyState + Retry; results → a column of PersonRow rows.
// People search renders ONE assembled window. `search_people` carries a cursor since spec 217, but the
// chasing happens in `nodeSearchPeople` (which follows it until the window fills), so this component
// still sees a finished list and needs no tail spinner / load-more.

import styles from "./ExploreList.module.css";
import { PersonRow } from "./PersonRow";
import { Skeleton } from "@/components/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { sanitizeInline } from "@/lib/sanitize";
import type { Suggestion, Viewer } from "@/components/kit";

export interface ExploreListProps {
  people: Suggestion[];
  viewer: Viewer;
  query: string;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  isFollowing: (target: string) => boolean;
  onToggleFollow: (target: string, next: boolean) => void;
  /** Display cap. The caller fetches limit+1 so an extra row distinguishes a truncated page from a
   *  complete one (`search_people` returns a cursor but no total); only the first `limit` are shown. */
  limit?: number;
}

export function ExploreList({
  people,
  viewer,
  query,
  loading,
  error,
  onRetry,
  isFollowing,
  onToggleFollow,
  limit,
}: ExploreListProps) {
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
          title="Couldn't run that search."
          description="Check your connection and try again."
          action={onRetry ? { label: "Retry", onClick: onRetry } : undefined}
        />
      </div>
    );
  }

  if (people.length === 0) {
    return (
      <div className={styles.list}>
        <EmptyState
          variant="search"
          query={query}
          // Display only. `query` stays the raw needle for the search itself.
          title={`No people found for "${sanitizeInline(query)}"`}
          description="Search matches display names, and only where the letters match exactly apart from upper and lower case."
        />
      </div>
    );
  }

  // The caller fetches limit+1; a (limit+1)th row means there are genuinely more, so we show only the
  // first `limit` and the "refine" note. Exactly `limit` matches (no extra row) is a COMPLETE result
  // set → all shown, no misleading note.
  const truncated = limit != null && people.length > limit;
  const shown = limit != null ? people.slice(0, limit) : people;

  return (
    <div className={styles.list}>
      {shown.map((p) => (
        <PersonRow
          key={p.author}
          person={p}
          viewer={viewer}
          isFollowing={isFollowing(p.author)}
          onToggleFollow={onToggleFollow}
          highlight={query}
        />
      ))}
      {truncated && (
        <p className={styles.truncated}>
          Showing {limit} people. There are more matches than fit here.
        </p>
      )}
    </div>
  );
}
