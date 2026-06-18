// Shared vocabulary for the cogno-chain frontend.
//
// This file is the DETERMINISTIC SEAM between the PAPI data layer (lib/chain, lib/signer)
// and the React layer (hooks, components). The data layer IMPLEMENTS these shapes; the
// React layer CONSUMES them. Nothing here imports React. Grounded against PAPI 1.23.3 +
// the descriptors generated from cogno-chain-runtime (spec_version 107; see
// scripts/papi-acceptance.mjs and scripts/watch-probe.mjs — the live shapes are confirmed,
// not guessed).

import type { PolkadotClient, TypedApi } from "polkadot-api";
import type { PolkadotSigner } from "polkadot-api/signer";
import type { cogno } from "@polkadot-api/descriptors";

/** The typed API for the cogno-chain runtime (Microblog @ pallet index 10). */
export type CognoApi = TypedApi<typeof cogno>;

/** SS58 string, encoded with the cogno-chain prefix (42). */
export type Ss58 = string;

/**
 * A decoded microblog post. Mirrors `Microblog.Posts` value
 * `{ author: SS58String, text: Binary, parent?: bigint, at: number }` with `text`
 * already decoded via `Binary.asText()` and the storage-key id attached.
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
  /** Block number the post was created at (`BlockNumber` u32). */
  at: number;
  /**
   * Soft-delete tombstone, only ever set by the INDEXER (GraphQL) path: a deleted post
   * leaves a record the indexer keeps and flags. On the PAPI path a deleted post is simply
   * absent from storage, so this is left undefined (treat as not-deleted). M4.
   */
  deleted?: boolean;
  /**
   * The author's identity binding has been revoked (`Author.banned` on the indexer; the
   * absence of `CognoGate.PkhOf` on the PAPI path). NOT a per-post chain field — revoke
   * leaves the posts intact, so the feed must FLAG, not drop, them. M4.
   */
  authorRevoked?: boolean;
}

// ── M4: the indexer-backed feed seam ────────────────────────────────────────────────────
// The data layer can now read from either the SubQuery GraphQL indexer (search + cursor
// pagination + thread/profile views) or, as the always-available fallback, the PAPI node
// directly. These shapes are the contract; both sources IMPLEMENT them. They are additive
// and back-compatible — `FeedSnapshot` (the live watch shape) is unchanged.

/** An opaque cursor string from the indexer (`pageInfo.endCursor` / `edges.cursor`). */
export type FeedCursor = string;

/** One page of the feed. `asOf` is the block the page reflects, when knowable (PAPI), else null. */
export interface FeedPage {
  posts: CognoPost[];
  /** The cursor to pass as the next `after`, or null when there is no further page. */
  endCursor: FeedCursor | null;
  hasNextPage: boolean;
  /** Total matching posts, when the source can report it (indexer `totalCount`). */
  totalCount?: number;
  asOf: number | null;
}

/**
 * A page request. `after` continues a cursor; `search` is a case-insensitive substring
 * (indexer only); `authorId` / `identityHash` scope the page to one author. Empty/omitted
 * fields mean the global feed, page one.
 */
export interface FeedQuery {
  first?: number;
  after?: FeedCursor;
  search?: string;
  authorId?: Ss58;
  identityHash?: string;
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
  page: FeedPage;
}

/** A reconstructed thread: the root post + its direct replies. */
export interface ThreadView {
  root: CognoPost;
  replies: CognoPost[];
  replyCount: number;
  /** Block height of the latest activity in the thread (root or any reply), when knowable. */
  lastActivity: number | null;
}

/** A chain block header summary (from `bestBlocks$` / `finalizedBlock$`). */
export interface BlockRef {
  number: number;
  hash: string;
}

/** Live head positions for honest best-vs-finalized labeling (Civic Ledger). */
export interface ChainHeads {
  best: BlockRef | null;
  finalized: BlockRef | null;
}

/**
 * The latest Cardano anchor checkpoint (`Anchor.LastCheckpoint`, M3 Tier-A). Records which
 * Cardano metadata tx witnessed which finalized solochain post-state root. **Evidence, not
 * enforcement** (DR-20). `null` until the relayer has anchored at least once.
 */
export interface AnchorCheckpoint {
  /** The finalized solochain block this checkpoint witnesses (`block_number`, u32). */
  blockNumber: number;
  /** 0x-prefixed finalized post-state root — the GRANDPA-committed root (`finalized_root`). */
  finalizedRoot: string;
  /** 0x-prefixed Cardano metadata tx hash carrying the root (`cardano_txhash`). */
  cardanoTxHash: string;
  /** `NextPostId` at that block — total posts created by then (`post_count`, u64). */
  postCount: bigint;
  /** Relayer-supplied unix-millis of the anchored block (`timestamp`, u64). */
  timestamp: bigint;
}

/**
 * A live feed snapshot. `posts` is the FULL current set (rebuilt from
 * `watchEntries().entries` every emission — `entries` is authoritative; deltas can be
 * null), sorted newest-first by `id`. `asOf` is the block the snapshot reflects.
 */
export interface FeedSnapshot {
  posts: CognoPost[];
  asOf: number | null;
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
 * The posting-key adapter. The sr25519 key signs every feeless post; it can be a simple
 * in-session/dev key or the hardened Model-B encrypted keystore signer — both share this
 * exact shape, so every consumer only ever touches `{ ss58, publicKeyHex, label, signer }`.
 * This is the SEPARATE posting half of the dual-key model; the Cardano CIP-30 wallet is the
 * identity/stake key that signs the CIP-8 bind and the L1 vault lock/exit.
 */
export interface PostingSigner {
  /** SS58 address (prefix 42) — the "Signing as <ss58-short>" identity. */
  ss58: Ss58;
  /** 0x-prefixed sr25519 public key. */
  publicKeyHex: string;
  /** Human label, e.g. "//Alice (dev)" or "session key". */
  label: string;
  /** The PAPI signer passed to `tx.*.signSubmitAndWatch(signer)`. */
  signer: PolkadotSigner;
  /** Provenance of the key, so the UI can be honest about what it is. */
  kind: "dev" | "session" | "mnemonic" | "keystore";
}

/** Phases of a submitted extrinsic, surfaced honestly (signed ≠ included). */
export type TxPhase =
  | "signing"
  | "broadcast"
  | "inBestBlock"
  | "finalized"
  | "invalid"
  | "error";

/** A progress update for a post/delete submission. */
export interface TxUpdate {
  phase: TxPhase;
  /** best-block number once the tx is seen in a block. */
  blockNumber?: number;
  txHash?: string;
  /** the new post id (from the `PostCreated` event) once in a block. */
  postId?: bigint;
  /** dispatch/validity/runtime error message when phase is "invalid" | "error". */
  error?: string;
  /** true once the including block is GRANDPA-finalized. */
  finalized?: boolean;
}
