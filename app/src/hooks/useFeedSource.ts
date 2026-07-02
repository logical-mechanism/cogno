"use client";

// useFeedSource — the single seam every other read hook consumes. Wraps `makeFeedSource` (the
// PAPI-direct node reader — the only reader since the all-Rust restart; the node serves feed / thread /
// profile / search node-direct) and memoizes on [api], so the source is stable across renders and only
// rebuilt when the connection changes.

import { useMemo } from "react";
import { makeFeedSource } from "@/lib/feed";
import type { FeedSource } from "@/lib/feed/source";
import type { CognoApi } from "@/lib/types";

export function useFeedSource(api: CognoApi | null): FeedSource | null {
  return useMemo(() => {
    if (!api) return null;
    return makeFeedSource(api);
  }, [api]);
}
