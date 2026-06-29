// The read-path selector. With NO GraphQL endpoint the app reads the node directly via PAPI —
// the spec-120/121 node-served feed/thread/profile, always available and credibly neutral. With an
// endpoint configured it builds a NODE-FIRST HYBRID: primaries (feed/thread/profile) still read
// node-direct (one `state_call`), and the indexer adds only what the node can't — substring search,
// People search, and the reverse Replies tab. Either way the indexer is NON-LOAD-BEARING for the core
// surfaces, and clearing the endpoint drops cleanly back to the pure PAPI reader.

import { createPapiFeedSource } from "./papi-source";
import { createGraphqlFeedSource } from "@/lib/graphql/feed-source";
import { createHybridFeedSource } from "./hybrid-source";
import type { CognoApi } from "@/lib/types";
import type { FeedSource } from "./source";

/**
 * Build the active feed source. `graphqlUrl` non-null/non-empty ⇒ the node-first HYBRID (PAPI-direct
 * primaries + indexer search/Replies); otherwise the pure PAPI-direct reader bound to the live `api`.
 */
export function makeFeedSource(api: CognoApi, graphqlUrl: string | null): FeedSource {
  const node = createPapiFeedSource(api);
  if (graphqlUrl && graphqlUrl.trim().length > 0) {
    return createHybridFeedSource(node, createGraphqlFeedSource(graphqlUrl.trim()));
  }
  return node;
}

export type { FeedSource } from "./source";
export { UnsupportedQuery } from "./source";
