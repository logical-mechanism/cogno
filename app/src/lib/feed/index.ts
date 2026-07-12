// The read-path selector. Since the all-Rust restart the app reads the node directly via PAPI ONLY —
// the spec-200 node-served feed/thread/profile/search, always available and credibly neutral. There is
// no SubQuery indexer and no GraphQL/hybrid seam any more: the node serves EVERYTHING the indexer used
// to (search + people search + the reverse Replies tab folded into `MicroblogApi` at P6/P8b).

import { createPapiFeedSource } from "./papi-source";
import type { CognoApi } from "@/lib/types";
import type { FeedSource } from "./source";

/** Build the active feed source: the PAPI-direct node reader bound to the live `api`. */
export function makeFeedSource(api: CognoApi): FeedSource {
  return createPapiFeedSource(api);
}

export type { FeedSource } from "./source";
