# FORK-PLAN — all-Rust restart (the "iagon" port-back)

Tracking doc for the `fork/all-rust` branch. This is the big fork that ports the
[`iagon-partner-chain`](../_reference/iagon-partner-chain/) architecture back into cogno: an **all-Rust
backend** (node + `cogno-chain-cli` + shared crates), the Next.js frontend as the only non-Rust surface,
the Aiken contracts unchanged, **sudo-free from genesis**, the observer as the **sole** weight writer,
anchoring dropped, and all reads folded into the node. The chain is **restarted** (fresh genesis).

Full design + rationale: the approved plan (`~/.claude/plans/ok-so-i-used-glowing-phoenix.md`).

## Locked decisions

1. Sudo-free from genesis — no `pallet-sudo`; `AuthorityOrigin` = 3/5 committee only; `pallet-governed-upgrade@7`; empty-committee brick-guard; single-seat committee → federate by vote.
2. `cardano-observer` is the SOLE weight writer — delete `talkStake.set_stake`/`set_voting_power`; enforce at genesis.
3. Drop anchoring — remove `pallet-anchor@12` + the anchor-relayer; observe-only.
4. Fold ALL reads into the node — expand `MicroblogApi`; delete the SubQuery indexer.

Secondary: GovernedUpgrade fills index 7 (fresh restart resets on-wire contracts); keep cogno's talk-capacity
fee model (endow governance accounts, don't port `GaslessCharge`); staged search (in-runtime scan → tantivy
RPC later); keep the CIP-8 verifier as a CI-only adversarial oracle; `spec_version` → 200, `transaction_version`
stays 3.

## New pallet-index map

`0-5` spine · **6 VACANT (Sudo removed)** · **7 GovernedUpgrade (NEW)** · 8 CognoGate · 9 TalkStake (call-less
ledger) · 10 Microblog · 11 SkipFeelessPayment · **12 VACANT (Anchor removed)** · 13 FollowerCommittee ·
14 ValidatorSet · 15 Session · 16 CardanoObserver (enforcing) · 17 Profile.

## Phase status

Each phase must keep `cargo build --workspace`, `cargo test --workspace`, `cd app && npm run build`, and
`cd contracts && script -qec "aiken check" /dev/null` green.

| # | Phase | Status |
|---|---|---|
| 0 | Fork branch + scaffolding | ✅ done |
| 1 | Shared crates (`cogno-dbsync`, `cogno-keyfile`) — additive | ✅ done |
| 2 | Node consumes `cogno-dbsync` + `node/src/metrics.rs` | ✅ done |
| 3 | Sudo-free governance + `governed-upgrade@7` + genesis reshape | ✅ done |
| 4 | Observer sole weight writer (delete `set_stake`, enforce) | ✅ done |
| 5 | Drop anchoring | ✅ done |
| 6 | Fold reads into node (`MicroblogApi` + staged `search_*`) | ✅ done |
| 7 | Build `cogno-chain-cli` + node subcommands | ✅ done |
| 8 | Delete services + rewire frontend | ✅ done |
| 9 | Ops + CI + docs + hygiene | ✅ done |
| 10 | Fresh-genesis relaunch ceremony | ⬜ todo |
