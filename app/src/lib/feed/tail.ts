// tailDecision — should the infinite-scroll tail auto-load, offer a button, or not render at all?
//
// WHY IT IS A SEPARATE PURE FUNCTION. Timeline's tail used to read the RAW `hasMore` the surface
// passed down while Timeline itself suppressed rows internally (block / hide / the operator's serve
// denylist). Those two facts sit on opposite sides of the filter, and when they disagree the tail
// eats the chain:
//
//   Block an author with >50 top-level posts, open /u/<them>/. Every row filters out, `hasMore` is
//   still true, so `LoadMoreTail` is the only child and its sentinel sits in the viewport. Each
//   landed page changes `loadMore`'s identity, the IntersectionObserver re-observes a sentinel that
//   is STILL intersecting, and fires again — walking the author's whole index, one `author_feed_page`
//   state_call per hop, appending nothing. `mergeById` and `useViewerStates`' ids key re-run over a
//   growing array every iteration, so the tab janks and its memory climbs while nothing renders.
//
// `lib/feed/denylist-source.ts` names this exact mechanism in its header and solves it for the
// operator axis only (by topping up the page). /explore had a second, bespoke copy for its lens and
// topic axes (`lensStalled` / `topicStalled`). This is the general form: one decision, computed where
// the filter lives, covering Home, profile, /lists and /explore at once.
//
// THE PER-PAGE HALF MATTERS. A window-shaped guard ("nothing at all is visible") never fires for a
// feed that found three rows and then nothing — which is the same runaway with three rows sitting on
// top of it. So the primary rule is about the page that most recently LANDED: if it contributed zero
// visible rows, the reader saw nothing move, and the next page is theirs to ask for.

/** What the list should render below the last card. */
export type TailMode =
  /** IntersectionObserver sentinel — page in as the reader scrolls. */
  | "auto"
  /** An explicit "Show more" button — the reader asks, so a fruitless page costs one read, not a walk. */
  | "manual"
  /** Nothing: either the source does not paginate, or there is no further page. */
  | "none";

export interface TailDecisionInput {
  /** Rows handed to the list, PRE-moderation. */
  rawCount: number;
  /** Rows that will actually render, POST-moderation. */
  visibleCount: number;
  /** The source says a further page exists. */
  hasMore: boolean;
  /** The source cursor-paginates at all. */
  paginationCapable: boolean;
  /**
   * Visible (post-moderation) row count of the page that landed MOST RECENTLY.
   *
   * `null` / omitted when no page has landed yet or the surface cannot report one — a first page in
   * flight must never be mistaken for a page that found nothing. Surfaces that page through
   * `useFeedPage` / `useProfile` / `useLiveFeed` pass the raw page down and Timeline filters it, so the
   * count is measured on the same side of the filter as the rows on screen.
   */
  lastPageVisibleCount?: number | null;
}

/**
 * Decide the tail. `manual` whenever the last page (or, failing that, the whole window) fetched rows
 * that all got suppressed — the reader is told there is more and given a button, instead of the list
 * silently paging the chain on their behalf to render nothing.
 */
export function tailDecision(input: TailDecisionInput): TailMode {
  const { rawCount, visibleCount, hasMore, paginationCapable, lastPageVisibleCount } = input;
  if (!paginationCapable || !hasMore) return "none";
  // Per PAGE. `0` is "it landed and nothing survived"; `null`/undefined is "nothing has landed yet".
  if (lastPageVisibleCount === 0) return "manual";
  // Window fallback, for a surface that cannot report its last page: rows were fetched and the reader
  // can see none of them.
  if (visibleCount === 0 && rawCount > 0) return "manual";
  return "auto";
}
