"use client";

// useFeedSource — the single seam every other read hook consumes. Wraps `makeFeedSource`
// (indexer when a GraphQL URL is set, else PAPI-direct) and memoizes on [api, graphqlUrl], so
// the source is stable across renders and only rebuilt when the connection or endpoint changes.
// Clearing the GraphQL endpoint silently degrades to PAPI-direct (caps shrink; affordances hide).

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
