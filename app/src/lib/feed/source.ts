// The data-layer SEAM for reading the Civic Ledger. M4 adds a second reader (the SubQuery
// GraphQL indexer) behind this interface; the existing PAPI-direct reader is the always-
// available fallback. Both implement `FeedSource`; the React layer only ever touches this
// interface, never a concrete reader, so the read path is swappable with no call-site churn.
//
// `caps` lets the UI light up ONLY the affordances a source can honestly serve: search and
// cursor pagination are indexer-only; threads and revocation-flagging both sources do.

import type { Observable } from "rxjs";
import type {
  FeedSnapshot,
  FeedPage,
  FeedQuery,
  ThreadView,
  ProfileView,
} from "@/lib/types";

/** What a feed source can do — drives which UI affordances are shown (never faked). */
export interface FeedCaps {
  /** case-insensitive substring search over post bodies. */
  search: boolean;
  /** cursor (`after`) pagination beyond the first page. */
  pagination: boolean;
  /** thread reconstruction (root + direct replies). */
  threads: boolean;
  /** author-revocation flagging on posts. */
  revocation: boolean;
}

/** Arguments for {@link FeedSource.profile} — by account or by identity hash. */
export interface ProfileArgs {
  author?: string;
  identityHash?: string;
}

/**
 * A swappable reader for the feed/thread/profile views. `kind` is for honest labeling
 * ("reads: indexer" vs "reads: direct node"); the rest is the read surface.
 */
export interface FeedSource {
  /** Which reader this is, for the honest read-path indicator. */
  kind: "papi" | "graphql";
  /** What this reader can do (gates UI affordances). */
  caps: FeedCaps;
  /** The live feed — a continuously-updating full snapshot, newest-first. */
  watch(): Observable<FeedSnapshot>;
  /** One page of the feed (global, search, or author-scoped). */
  page(q: FeedQuery): Promise<FeedPage>;
  /** A reconstructed thread for `rootId`. */
  thread(rootId: bigint): Promise<ThreadView>;
  /** One author's profile + posts. */
  profile(args: ProfileArgs): Promise<ProfileView>;
}

/**
 * Thrown when a {@link FeedQuery} asks for something a source cannot honestly serve — e.g.
 * search or cursor pagination on the PAPI-direct path. The UI gates these on `caps`, so this
 * is a guard against a logic slip, not an expected user-facing state.
 */
export class UnsupportedQuery extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedQuery";
  }
}
