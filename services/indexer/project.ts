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
    node: { name: "@subql/node", version: ">=6.0.0" },
    query: { name: "@subql/query", version: "*" },
  },
  schema: { file: "./schema.graphql" },
  network: {
    // The GENESIS (block-0) hash of THIS chain — the chain-identity pin. A fresh --dev rebuild
    // changes it (spec-104 dev genesis below). Re-capture via chain_getBlockHash(0) after any wipe.
    chainId:
      "0x41467cdca29a25549388e5f2f387fc2dd54fce7000d494d2578cbd0afcce65cd",
    endpoint: ["ws://127.0.0.1:9944"],
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
