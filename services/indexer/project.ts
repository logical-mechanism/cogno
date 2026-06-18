import {
  SubstrateDatasourceKind,
  SubstrateHandlerKind,
  SubstrateProject,
} from "@subql/types";

// cogno-chain L4 Tier-B indexer (M4). Self-hosted SubQuery over the cogno-chain solochain
// (DR-27 — the published reference indexer; PAPI-direct stays the v1 baseline). RPC-only
// ingestion (a custom solochain is in no dictionary): NO `dictionary`, NO `chaintypes` — the
// runtime emits metadata V14+, so @polkadot/api auto-decodes every custom pallet event/storage.
const project: SubstrateProject = {
  specVersion: "1.0.0",
  version: "0.0.1",
  name: "cogno-indexer",
  description:
    "Indexer for cogno-chain: Microblog posts/threads, CognoGate identity bind/revoke, TalkStake weight. Reads NEVER touch Cardano (L4).",
  runner: {
    // Pinned exactly (indexer-4) — a future @subql release can silently change generated models or
    // query behaviour, so the runner versions match the locked devDependencies. Re-run verify-m4c
    // after any bump.
    node: { name: "@subql/node", version: "6.4.6" },
    query: { name: "@subql/query", version: "2.25.0" },
  },
  schema: { file: "./schema.graphql" },
  network: {
    // Chain-identity pin (DR-08): the GENESIS (block-0) hash of THIS chain, plus its RPC endpoint.
    // Both are ENV-DRIVEN so re-pointing the indexer at a different chain is a config change, not a
    // code edit — a fresh chain (any wipe/relaunch) gets a NEW genesis, so re-capture it via
    // `chain_getBlockHash(0)` and set CHAIN_ID/GENESIS (or rebuild). NOTE: SubQuery resolves these at
    // BUILD time (`subql build` bakes them into project.yaml), so set the env before building.
    // Default = the live spec-107 preprod chain (captured 2026-06; the prior spec-104 genesis
    // 0x41467cdc… is dead — the chain was relaunched, which is why that pin would fail verify-m4c).
    chainId:
      process.env.CHAIN_ID ||
      process.env.GENESIS ||
      "0x2653e177acfa9c1c11fd5479f3b2ddc22db53cb8083b05721ea70753c62cda61",
    endpoint: [process.env.WS_ENDPOINT || process.env.WS || "ws://127.0.0.1:9944"],
  },
  dataSources: [
    {
      kind: SubstrateDatasourceKind.Runtime,
      startBlock: 1,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handlePostCreated",
            filter: { module: "microblog", method: "PostCreated" },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handlePostDeleted",
            filter: { module: "microblog", method: "PostDeleted" },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handleIdentityLinked",
            filter: { module: "cognoGate", method: "IdentityLinked" },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handleRevoked",
            filter: { module: "cognoGate", method: "Revoked" },
          },
          {
            kind: SubstrateHandlerKind.Event,
            handler: "handleStakeSet",
            filter: { module: "talkStake", method: "StakeSet" },
          },
        ],
      },
    },
  ],
};

export default project;
