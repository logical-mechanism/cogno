// The read-path selector. The app reads the node directly over PAPI, and only that: feed / thread /
// profile / search / people / replies are all served by the node's `MicroblogApi` runtime read API.
// There is one reader, so there is nothing to select between — the function stays as the single place
// a second reader would be wired in.

import { createPapiFeedSource } from "./papi-source";
import { withServeDenylist } from "./denylist-source";
import type { CognoApi } from "@/lib/types";
import type { PolkadotClient } from "polkadot-api";
import type { FeedSource } from "./source";

/**
 * Build the active feed source: the PAPI-direct node reader bound to the live `api`, wrapped in this
 * deployment's serve denylist.
 *
 * The wrap is the operator lever POLICY.md has always promised and nothing implemented. It is a no-op
 * (literally the unwrapped source) while the list is empty, which is the shipped state. Being one line
 * HERE rather than a check at every render site is the whole point: there is one reader, so there is
 * one place to forget, and this is it. See lib/feed/denylist-source.ts.
 */
export function makeFeedSource(api: CognoApi, client: PolkadotClient): FeedSource {
  return withServeDenylist(createPapiFeedSource(api, client));
}

export type { FeedSource } from "./source";
