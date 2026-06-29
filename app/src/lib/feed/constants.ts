// Shared feed page size. With spec-120 node-served reads a feed/profile page comes back in ONE
// `state_call` (no ~5-reads-per-post fan-out), so the page size is no longer a round-trip multiplier
// and we size for the UI, not the read cost. One constant keeps home / Following / explore / profile
// load-more in step; it matches the seam's first-page defaults (`papi-source` DEFAULT_FIRST /
// `graphql/feed-source` WATCH_LIMIT = 50) so first paint and "load more" request the same window.
// Stays well under the runtime clamp (`node-reads` MAX_PAGE = 100).
export const FEED_PAGE_SIZE = 50;
