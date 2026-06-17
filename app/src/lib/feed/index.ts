// The read-path selector. The app reads through the indexer when a GraphQL endpoint is
// configured (search + cursor pagination + thread/profile views); otherwise it reads the node
// directly via PAPI — slower, no search, but ALWAYS available and credibly neutral. Clearing
// the GraphQL endpoint always falls back here, so the indexer is never load-bearing.

import { createPapiFeedSource } from "./papi-source";
import { createGraphqlFeedSource } from "@/lib/graphql/feed-source";
import type { CognoApi } from "@/lib/types";
import type { FeedSource } from "./source";

/**
 * Build the active feed source. `graphqlUrl` non-null/non-empty ⇒ the indexer reader;
 * otherwise the PAPI-direct reader bound to the live `api`.
 */
export function makeFeedSource(api: CognoApi, graphqlUrl: string | null): FeedSource {
  if (graphqlUrl && graphqlUrl.trim().length > 0) {
    return createGraphqlFeedSource(graphqlUrl.trim());
  }
  return createPapiFeedSource(api);
}

export type { FeedSource } from "./source";
export { UnsupportedQuery } from "./source";
