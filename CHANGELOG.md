# Changelog

All notable changes to cogno-chain are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Because this is a live chain, the meaningful version numbers are the runtime's on-wire identifiers:
`spec_version` (bumped for encoding-affecting changes) and `transaction_version` (bumped when the
signed-extension set changes). The chain has not yet cut a tagged public release.

## [Unreleased]

Current runtime: **`spec_version` 201 / `transaction_version` 3**.

### Toolchain / dependencies (polkadot-sdk `stable2606`)

- **Upgraded the whole Rust workspace to polkadot-sdk `stable2606`** (from `stable2603-3`) and the
  pinned toolchain to **rustc 1.93.0** (from 1.90.0) — the toolchain Parity builds the `stable2606`
  release train against. The runtime `spec_version` bumped **200 → 201**; `transaction_version`
  stays **3** (extrinsic/extension encoding is byte-identical). The old "stable ≥ ~1.91 breaks the
  `sp_io` wasm link" pin caution no longer applies: it was specific to stable2603's sp-io 45.0.0, and
  stable2606's sp-io 48.0.0 links cleanly under 1.93.0.

### All-Rust restart (fresh genesis)

The backend was consolidated to an all-Rust stack and the chain restarted at a fresh genesis:

- **Sudo-free from genesis.** Removed `pallet-sudo`; every privileged call now routes through the
  3-of-5 `FollowerCommittee` (`pallet-collective`), with an empty-committee brick-guard. Runtime
  upgrades are committee `authorize` + a permissionless spec-checked `apply` (`pallet-governed-upgrade`,
  index 7).
- **`cardano-observer` is the sole weight writer.** The talk-capacity weight is written only by a
  consensus-verified inherent that reads Cardano state via db-sync; the `talkStake.set_stake` /
  `set_voting_power` extrinsics were removed.
- **Anchoring dropped.** Removed `pallet-anchor` (index 12, now permanently vacant) and the off-chain
  anchor relayer — the chain is observe-only.
- **All reads folded into the node.** Expanded the `MicroblogApi` runtime read layer; removed the
  external SubQuery indexer.
- **Off-chain services removed.** The Python follower and JS relayer/committee/indexer are gone; an
  independent Python CIP-8 verifier is retained under `ci/cip8-oracle/` purely as a CI adversarial
  oracle.

### Repository / open-source readiness

- Relicensed the workspace to **Apache-2.0** with a `LICENSE` and a `NOTICE` attributing the
  Apache-2.0 upstreams (Polkadot SDK templates, the partner-chains consensus primitives, and the
  `substrate-validator-set` fork).
- Added `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue/PR templates, `CODEOWNERS`, and
  Dependabot.

### Deliberately deferred (`MAINNET PREREQUISITE`)

These are honestly-labeled testnet-scope choices, not defects: `MinAuthorities = 1`, GRANDPA
equivocation reporting as a no-op, an independent audit of the CIP-8 verifier, production key custody,
and db-sync over TLS.
