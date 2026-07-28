// The tail must never auto-load off a count taken on the wrong side of the moderation filter.
//
// The shipped bug in one line: `{raw: 50, visible: 0, hasMore: true}` rendered the IntersectionObserver
// sentinel, which re-observes itself on every `loadMore` identity change and therefore fires again
// immediately — walking an author's whole index to append nothing.

import { describe, it, expect } from "vitest";
import { tailDecision } from "./tail";

const base = { rawCount: 0, visibleCount: 0, hasMore: false, paginationCapable: false };

describe("tailDecision", () => {
  it("is manual when a whole window of fetched rows is suppressed", () => {
    expect(
      tailDecision({ ...base, rawCount: 50, visibleCount: 0, hasMore: true, paginationCapable: true }),
    ).toBe("manual");
  });

  it("is manual when the LAST page contributed nothing visible, even with rows on screen", () => {
    // The case a window-shaped guard misses entirely: a lens found three rows, then a page of blocked
    // authors. Three rows sitting on top of the same runaway.
    expect(
      tailDecision({
        ...base,
        rawCount: 53,
        visibleCount: 3,
        hasMore: true,
        paginationCapable: true,
        lastPageVisibleCount: 0,
      }),
    ).toBe("manual");
  });

  it("auto-loads while pages keep landing visible rows", () => {
    expect(
      tailDecision({
        ...base,
        rawCount: 50,
        visibleCount: 48,
        hasMore: true,
        paginationCapable: true,
        lastPageVisibleCount: 48,
      }),
    ).toBe("auto");
  });

  it("does not mistake a first page still in flight for a page that found nothing", () => {
    // `lastPage` is null until one lands. `null` must not read as `0`.
    expect(
      tailDecision({
        ...base,
        rawCount: 0,
        visibleCount: 0,
        hasMore: true,
        paginationCapable: true,
        lastPageVisibleCount: null,
      }),
    ).toBe("auto");
  });

  it("renders no tail at all without pagination or a further page", () => {
    expect(tailDecision({ ...base, rawCount: 50, visibleCount: 0, hasMore: true })).toBe("none");
    expect(
      tailDecision({ ...base, rawCount: 50, visibleCount: 0, paginationCapable: true }),
    ).toBe("none");
  });

  it("prefers the per-page signal over the window one", () => {
    // Nothing visible in the window, but the page that just landed DID contribute — which happens when
    // the surface pre-filters and hands Timeline an already-empty array. Auto is right: rows are moving.
    expect(
      tailDecision({
        ...base,
        rawCount: 0,
        visibleCount: 0,
        hasMore: true,
        paginationCapable: true,
        lastPageVisibleCount: 12,
      }),
    ).toBe("auto");
  });
});
