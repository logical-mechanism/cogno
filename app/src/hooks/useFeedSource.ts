"use client";

// useFeedSource — the single seam every other read hook consumes. Wraps `makeFeedSource`
// (the node-first HYBRID when a GraphQL URL is set — primaries node-direct, search/Replies via the
// indexer — else pure PAPI-direct) and memoizes on [api, graphqlUrl], so the source is stable across
// renders and only rebuilt when the connection or endpoint changes. Clearing the GraphQL endpoint
// drops back to pure PAPI-direct (only search + the Replies tab disappear; the feed stays node-served).

import { useMemo } from "react";
import { makeFeedSource } from "@/lib/feed";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi } from "@/lib/types";

export function useFeedSource(
  api: CognoApi | null,
  graphqlUrl: string | null,
): FeedSource | null {
  return useMemo(() => {
    if (!api) return null;
    return makeFeedSource(api, graphqlUrl);
  }, [api, graphqlUrl]);
}
