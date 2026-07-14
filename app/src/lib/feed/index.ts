// The read-path selector. The app reads the node directly over PAPI, and only that: feed / thread /
// profile / search / people / replies are all served by the node's `MicroblogApi` runtime read API.
// There is one reader, so there is nothing to select between — the function stays as the single place
// a second reader would be wired in.

import { createPapiFeedSource } from "./papi-source";
import type { CognoApi } from "@/lib/types";
import type { FeedSource } from "./source";

/** Build the active feed source: the PAPI-direct node reader bound to the live `api`. */
export function makeFeedSource(api: CognoApi): FeedSource {
  return createPapiFeedSource(api);
}

export type { FeedSource } from "./source";
