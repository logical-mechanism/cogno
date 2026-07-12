// Shared vocabulary for the cogno-chain frontend.
//
// This file is the DETERMINISTIC SEAM between the PAPI data layer (lib/chain, lib/signer)
// and the React layer (hooks, components). The data layer IMPLEMENTS these shapes; the
// React layer CONSUMES them. Nothing here imports React. Grounded against PAPI 1.x + the
// descriptors generated from cogno-chain-runtime (spec_version 200 — the all-Rust restart:
// the spec-113 social pallet set + spec-117 feeless pallet-profile, with feed/thread/profile
// reads now served node-direct by the node's spec-200 MicroblogApi rather than a SubQuery
// node's MicroblogApi; the live shapes are confirmed against the running node's metadata, not guessed).

import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { PolkadotSigner } from "polkadot-api/signer";
import type { cogno } from "@polkadot-api/descriptors";
// errors.ts is a LEAF (it imports nothing) — safe to depend on from here without a cycle.
import type { ChainError } from "@/lib/chain/errors";

/** The typed API for the cogno-chain runtime (Microblog @ pallet index 10). */
export type CognoApi = TypedApi<typeof cogno>;

/** SS58 string, encoded with the cogno-chain prefix (42). */
export type Ss58 = string;

/**
 * A decoded microblog post. Mirrors `Microblog.Posts` value
 * `{ author, text, parent?, at, quote? }` with `text` already decoded via `Binary.asText()`
 * and the storage-key id attached.
 *
 * The social fields (quote/tallies/counts + author profile snapshot) are ADDITIVE and all
 * optional: the node-served MicroblogApi reader fills them fully; a bare PAPI-direct storage
 * read fills what the node serves. Weight/score fields are
 * `bigint` (u128 ⇒ lovelace-scale, may exceed 2^53; `score` may be negative).
 */
export interface CognoPost {
  /** Storage key (`NextPostId`-assigned u64). */
  id: bigint;
  /** SS58 author address (prefix 42). */
  author: Ss58;
  /** UTF-8 post body (decoded; may be empty). */
  text: string;
  /** Parent post id for replies (`Option<u64>` → undefined when top-level). */
  parent?: bigint;
  /** Block number the post was created at (`BlockNumber` u32). NOT a timestamp; never rendered as one. */
  at: number;
  /**
   * The author's identity binding has been revoked (the absence of `CognoGate.PkhOf`). NOT a
   * per-post chain field — revoke
   * leaves the posts intact, so the feed must FLAG (dim), not drop, them.
   */
  authorRevoked?: boolean;

  // ── spec-113 social ──
  /** Present iff this post quotes another (`Post.quote` on-chain). A shallow, one-level embed. */
  quote?: QuotedRef;
  /** True iff a `PollCreated` fired for this id; fetch options via `source.poll(id)`. */
  isPoll?: boolean;
  /** Stake-weighted up tally (u128). */
  upWeight?: bigint;
  /** Stake-weighted down tally (u128). */
  downWeight?: bigint;
  upCount?: number;
  downCount?: number;
  /** `upWeight - downWeight` (u128 difference; MAY be negative). */
  score?: bigint;
  /** Count of direct replies. */
  replyCount?: number;

  // ── profile snapshot of the author (stamped node-side; avoids N+1 on the timeline) ──
  authorDisplayName?: string;
  authorAvatar?: string;
  /** Author posting power (lovelace); undefined until staked. */
  authorWeight?: bigint;

  // ── viewer overlay (spec-120 node-served reads only) ──
  /**
   * The connected viewer's own vote/repost on this post, stamped node-side by the spec-120
   * `MicroblogApi` (when a `viewer` was passed). PRESENT only when a `viewer` was passed;
   * `undefined` on the keyed fallback path, where `useViewerStates` reads it per-card instead. When
   * present, `useViewerStates` prefers it and SKIPS the per-card `Reposts.getEntries` viewer scan.
   */
  myVote?: "Up" | "Down" | null;
}

/** A 0-indexed poll option with its stake-weighted tally. */
export interface PollOptionView {
  index: number; // 0..=3
  label: string; // UTF-8 option text (<= 80 bytes)
  weight: bigint; // sum of weight snapshots currently choosing this option
  count: number; // accounts currently choosing this option
}

/** A poll attached to a host post (`Poll.id == host post id`; the question IS the host post's text). */
export interface PollView {
  hostId: bigint;
  options: PollOptionView[];
  /** Σ option weight, for percent bars. */
  totalWeight: bigint;
  totalCount: number;
}

/** A compact reference to a quoted post for the `QuotedPostEmbed` (no recursion). */
export interface QuotedRef {
  id: bigint;
  author: Ss58;
  text: string;
  authorRevoked: boolean;
  /** Resolved from Profile when available. */
  displayName?: string;
  avatar?: string;
}

/** The viewer's own relationship to a post — drives the active/filled action icons. */
export interface ViewerPostState {
  myVote: "Up" | "Down" | null; // null = not voted
}

/** Followers/following ids + counts for an account. */
export interface FollowEdges {
  followers: Ss58[]; // accounts following `who`
  following: Ss58[]; // accounts `who` follows
  followerCount: number;
  followingCount: number;
}

/** A who-to-follow / people-search suggestion. */
export interface Suggestion {
  author: Ss58;
  displayName?: string;
  avatar?: string;
  weight?: bigint;
  followerCount: number;
  /** spec-202: net stake-weighted reputation score (up − down; may be negative). Undefined when unknown. */
  accountScore?: bigint;
}

// ── the feed seam ───────────────────────────────────────────────────────────────────────
// These shapes are the contract between the data layer and React. There is ONE reader
// (lib/feed/papi-source.ts), serving everything out of the node — the SubQuery indexer this seam
// was originally built to abstract over no longer exists.

/** An opaque cursor string. The node's cursors are ENDPOINT-SCOPED — one method's cursor is only
 *  valid passed back to the SAME method. */
export type FeedCursor = string;

/** One page of the feed. `asOf` is the block the page reflects, when knowable (PAPI), else null. */
export interface FeedPage {
  posts: CognoPost[];
  /** The cursor to pass as the next `after`, or null when there is no further page. */
  endCursor: FeedCursor | null;
  hasNextPage: boolean;
  /** Total matching posts, when the source can report it. */
  totalCount?: number;
  asOf: number | null;
}

/**
 * A page request. `after` continues a cursor; `search` is a case-insensitive substring
 * `authorId` / `identityHash` scope the page to one author. `tab` selects a
 * home/profile view; `followeeOf` scopes the Following timeline.
 * Empty/omitted fields mean the global feed, page one.
 */
export interface FeedQuery {
  first?: number;
  after?: FeedCursor;
  search?: string;
  authorId?: Ss58;
  identityHash?: string;
  // ── NEW ──
  tab?: "forYou" | "following" | "replies" | "likes";
  followeeOf?: Ss58; // "Following" timeline: posts by accounts this user follows
  /**
   * The connected account, when known. The source threads it into the
   * `MicroblogApi` so each returned post carries the viewer's `myVote`/`reposted` overlay, computed
   * node-side in the same `state_call`. The keyed fallback path IGNORES it (the overlay is fetched
   * separately via `useViewerStates`), so passing it is always safe and never changes those results.
   */
  viewer?: Ss58;
}

/** A single author's public profile + their (paginated) posts. */
export interface ProfileView {
  /** SS58 account, or null when looked up by identity hash and unresolved. */
  author: Ss58 | null;
  /** 0x-prefixed 32-byte identity hash, or null when unbound/unknown. */
  identityHash: string | null;
  postCount: number;
  /** identity binding revoked (`Author.banned` / `PkhOf` absent). */
  banned: boolean;
  /** Cardano-sourced talk weight (lovelace), when known. */
  weight?: bigint;
  // ── spec-117 pallet-profile (node-served) ──
  displayName?: string;
  bio?: string;
  avatar?: string;
  /** spec-118 pallet-profile: banner reference (URL / IPFS CID), free-text location, website URL. */
  banner?: string;
  location?: string;
  website?: string;
  /** Pinned post id (a bare on-chain string id; not existence-validated). */
  pinnedPostId?: bigint;
  /** Follower/following counts (node-served, off the denormalised counters). */
  followerCount?: number;
  followingCount?: number;
  // ── spec-202 account reputation (stake-weighted up/down votes ON this account) ──
  /** Net stake-weighted reputation score (`accountUpWeight − accountDownWeight`; may be negative). */
  accountScore?: bigint;
  accountUpWeight?: bigint;
  accountDownWeight?: bigint;
  accountUpCount?: number;
  accountDownCount?: number;
  /** The connected viewer's own vote on this account (null = not voted; undefined = no viewer / unknown). */
  myAccountVote?: "Up" | "Down" | null;
  page: FeedPage;
}

/**
 * A reconstructed thread: the focal `root` post, its connected ancestor chain (the parent posts
 * above it), and its direct replies. Each direct reply carries its own `replyCount` so the UI can
 * offer an inline "Show replies" expander instead of routing away to a fresh page.
 */
export interface ThreadView {
  root: CognoPost;
  /**
   * The ancestor chain above `root`, ordered top-down (the conversation root first, `root`'s
   * immediate parent last). Empty when `root` is top-level. PAPI-direct walks the full chain from
   * the snapshot.
   */
  ancestors: CognoPost[];
  replies: CognoPost[];
  replyCount: number;
  /** The post `root` replies to, for the "Replying to @…" context line (when known). */
  parent?: QuotedRef;
  /** Block height of the latest activity in the thread (root or any reply), when knowable. */
  lastActivity: number | null;
}

/** A chain block header summary (from `bestBlocks$` / `finalizedBlock$`). */
export interface BlockRef {
  number: number;
  hash: string;
}

/**
 * Live head positions. The honesty/trust UI is dropped, so these are NOT rendered as
 * "best vs finalized" marginalia anymore — `best.number` drives `useCapacity`'s `bestBlock`
 * (the rate-limit gate) and nothing else.
 */
export interface ChainHeads {
  best: BlockRef | null;
  finalized: BlockRef | null;
}


/** Connection lifecycle for the WS provider (drives the connecting/reconnecting UI). */
export type ConnStatus = "connecting" | "connected" | "reconnecting" | "error";

/**
 * Read/write-aware boot guard (L5 §8.1): compares the runtime `spec_version` to the
 * descriptors the app was built against. A mismatch must BLOCK the write path (a silent
 * spec bump mis-encodes posts) while keeping READS in best-effort mode.
 */
export interface BootGuard {
  ok: boolean;
  nodeSpecName: string;
  nodeSpecVersion: number;
  /** descriptor spec_version the app was generated against, when discoverable. */
  descriptorSpecVersion: number | null;
  reason?: string;
}

/** A handle bundling the PAPI client + typed API + the endpoint it speaks to. */
export interface ChainHandle {
  client: PolkadotClient;
  api: CognoApi;
  wsUrl: string;
}

/**
 * The posting-key adapter. The sr25519 key signs every feeless post; every consumer only ever
 * touches `{ ss58, publicKeyHex, label, signer }`. In the product flow it is DERIVED from a
 * Cardano wallet signature (kind "derived") — nothing stored, no second wallet.
 */
export interface PostingSigner {
  /** SS58 address (prefix 42). */
  ss58: Ss58;
  /** 0x-prefixed sr25519 public key. */
  publicKeyHex: string;
  /** Human label, e.g. "wallet key" or "//Alice (dev)". */
  label: string;
  /** The PAPI signer passed to `tx.*.signSubmitAndWatch(signer)`. */
  signer: PolkadotSigner;
  /** Provenance of the key. */
  kind: "dev" | "derived";
}

/** Phases of a submitted extrinsic. */
export type TxPhase =
  | "signing"
  | "broadcast"
  | "inBestBlock"
  | "finalized"
  | "invalid"
  | "error";

/** A progress update for a submitted extrinsic. */
export interface TxUpdate {
  phase: TxPhase;
  /** best-block number once the tx is seen in a block. */
  blockNumber?: number;
  txHash?: string;
  /** the new post id (from an id-bearing event, e.g. `PostCreated`) once in a block. */
  postId?: bigint;
  /**
   * The CLASSIFIED failure when phase is "invalid" | "error" (see lib/chain/errors.ts).
   *
   * Structured, not a string: this used to be prose, so every consumer that needed to know WHICH
   * failure it was had to regex the English back out of it. Branch on `error.kind`; render with
   * `errorCopy(error)`.
   */
  error?: ChainError;
  /** true once the including block is GRANDPA-finalized. */
  finalized?: boolean;
}
