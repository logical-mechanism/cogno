// Shared vocabulary for the cogno-chain M1 frontend.
//
// This file is the DETERMINISTIC SEAM between the PAPI data layer (lib/chain, lib/signer)
// and the React layer (hooks, components). The data layer IMPLEMENTS these shapes; the
// React layer CONSUMES them. Nothing here imports React. Grounded against PAPI 1.23.3 +
// the descriptors generated from cogno-chain-runtime v101 (see scripts/papi-acceptance.mjs
// and scripts/watch-probe.mjs — the live shapes are confirmed, not guessed).

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
 * The posting-key adapter. In M1 the sr25519 key is a SIMPLE in-session/dev key, but it is
 * deliberately shaped exactly like the future hardened Model-B keystore signer (L5-M2) so
 * that milestone slots in with NO call-site change: every consumer only ever touches
 * `{ ss58, publicKeyHex, label, signer }`. The Cardano identity half does NOT exist in M1.
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
  kind: "dev" | "session" | "mnemonic";
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
