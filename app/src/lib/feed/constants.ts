// Shared feed page size. A node-served feed/profile page comes back in ONE `state_call` (no
// ~5-reads-per-post fan-out), so the page size is not a round-trip multiplier and we size for the UI,
// not the read cost. One constant keeps home / Following / explore / profile load-more in step, and
// matches `papi-source`'s DEFAULT_FIRST so first paint and "load more" request the same window. Stays
// well under the runtime clamp (`node-reads` MAX_PAGE = 100).
export const FEED_PAGE_SIZE = 50;
