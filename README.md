# cogno-chain

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app,
where the right to post is metered by **ADA locked in a Cardano L1 smart contract** rather than
per-post fees. Posting consumes a regenerating, stake-weighted **"talk capacity"** (Hive-RC /
Midnight-DUST style) that you earn by parking ADA in a Cardano vault — and **costs no money per
post**. Cardano is **observed (not bridged)**: it answers *"can you sign with this wallet?"*
(CIP-8 identity), supplies the *weight* (locked ADA), and *witnesses* finalized state-roots
(metadata anchors). None of this makes the app-chain inherit Cardano's economic finality or
security; the chain's safety is its own operator-run Aura/GRANDPA.

> **Honest posture — "usable ≠ trustless".** In v1 the follower is a single trusted
> verifier-and-writer (`follower: trusted (v1)`), the chain is a single operator-run node
> (`chain: operator-run (v1)`), and the 3-of-5 committee path is real but **D2-SHAPED, not
> D2-TRUST** on a single-operator stack. The UI states these limits on-screen as honesty badges;
> the docs state them in prose. See [`docs/DECISION-REGISTER.md`](docs/DECISION-REGISTER.md) for
> every cross-layer decision.

> **Why:** the prior Cardano-native forum **Cogno** (`logicalmechanism/cogno_v3`) became too
> expensive at volume (per-post L1 fees + min-ADA-per-byte). cogno-chain moves posts onto cheap
> feeless blockspace and replaces fees with a capacity meter.

The original architecture (L1 Cardano vault+beacon → L2 follower → L3 runtime → L4 reads → L5
frontend) is designed in [`PLAN.md`](PLAN.md) and [`ECONOMICS.md`](ECONOMICS.md); what was
actually built is logged per-milestone in [`docs/M*-build.md`](docs/).

---

## Status: implemented through M8 (runtime spec_version 107, transaction_version 2)

All milestones are built and — where applicable — proven live on Cardano **preprod**. See the
per-milestone build logs in [`docs/`](docs/):

| Milestone | What it added | Log |
|---|---|---|
| **M0** | solochain stands up + plain posting (no Cardano) | [`M0-build.md`](docs/M0-build.md) |
| **M1** | Next.js static-export read/post frontend ("Reading Room") | [`M1-build.md`](docs/M1-build.md) |
| **M2** | the CIP-8 identity gate (Cardano READ link) | [`M2-build.md`](docs/M2-build.md) |
| **M2c** | feeless, talk-capacity-metered posting | [`M2c-build.md`](docs/M2c-build.md) |
| **M2d** | Cardano-sourced weight — lock ADA → weight → feeless post (live) | [`M2d-build.md`](docs/M2d-build.md) |
| **M3** | the Cardano anchor — finalized state-root → metadata tx (live) | [`M3-build.md`](docs/M3-build.md) |
| **M4** | self-hosted SubQuery indexer (the L4 Tier-B read layer) | [`M4-build.md`](docs/M4-build.md) |
| **M5** | real FRAME-benchmarked weights + 3-of-5 committee authorities | [`M5-build.md`](docs/M5-build.md) |
| **M6** | mutable Aura+GRANDPA validators + committee-driven live stack | [`M6-build.md`](docs/M6-build.md) |
| **M7** | ops re-prove + drop `pallet-template` (spec 106 → 107) | [`M7-ops.md`](docs/M7-ops.md) |
| **M8** | `talk_vault` relaunch (audit-fix hash move) + CIP-30 wallet lock/exit + encrypted keystore | [`M8-relaunch.md`](docs/M8-relaunch.md) |

**Pinned upstream (DR-03):** polkadot-sdk **`polkadot-stable2603-3`**
(commit `e3737178ec726cffe506c907263aaaa417893fd0`); toolchain `channel = "stable"` (build with
**rustc 1.90.0** — stable 1.96 breaks the `sp_io` wasm link); wasm runtime target
`wasm32-unknown-unknown`.

### Repo layout

```
cogno-chain/
├─ Cargo.toml / Cargo.lock     # workspace, pinned to stable2603-3; Cargo.lock committed
├─ rust-toolchain.toml         # channel = stable; targets = [wasm32-unknown-unknown]
├─ node/                       # cogno-chain-node (Aura + GRANDPA)
├─ runtime/                    # cogno-chain-runtime (#[frame_support::runtime], spec 107)
├─ pallets/                    # microblog, cogno-gate, talk-stake, anchor, validator-set
├─ contracts/                  # the Aiken L1 `talk_vault` validator (+ audits/)
├─ app/                        # Next.js 14 static-export frontend (PAPI + MeshJS)  — see app/README.md
├─ services/                   # cogno-follower · anchor-relayer · committee · indexer
├─ docs/                       # PLAN/ECONOMICS spec (L1–L5) + DECISION-REGISTER + M*-build logs
└─ scripts/acceptance/         # headless @polkadot/api M0 acceptance test
```

### Pallet indices (on-wire contracts, stable forever)

| idx | pallet | idx | pallet |
|---|---|---|---|
| 0 | System | 9 | TalkStake (Cardano-sourced weight) |
| 1 | Timestamp | 10 | Microblog (posts + folded capacity) |
| 2 | Aura | 11 | SkipFeelessPayment (feeless extension) |
| 3 | Grandpa | 12 | Anchor (Tier-A Cardano anchor) |
| 4 | Balances | 13 | FollowerCommittee (collective `Instance1`, 3-of-5) |
| 5 | TransactionPayment | 14 | ValidatorSet (mutable Aura/GRANDPA) |
| 6 | Sudo | 15 | Session |
| 8 | CognoGate (CIP-8 identity gate) | | |

Index **7 is vacant**: the stock `pallet-template` scaffold was dropped in M7 (spec 107). FRAME
allows index gaps, so the on-wire indices never shift.

---

## Stand up the stack

Bring up the pieces in this order. The live Cardano-backed stack additionally needs a synced
preprod `cardano-node` + Ogmios + Kupo (an external dependency); the chain + frontend run
standalone without them.

### 1. The Substrate node

```bash
# System deps (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y \
  clang protobuf-compiler cmake libssl-dev pkg-config make build-essential

# Build (heavy first compile; uses the pinned rustc 1.90.0 from rust-toolchain.toml):
cargo build --release

# Run a dev chain (Alice/Bob Aura authorities, Alice = sudo, WS :9944):
./target/release/cogno-chain-node --dev
```

Acceptance (M0): with a `--dev` node on `ws://127.0.0.1:9944`,
`cd scripts/acceptance && npm install && WS=ws://127.0.0.1:9944 node acceptance.mjs`. Unit tests:
`cargo test` (pallets: anchor · cogno-gate · microblog · talk-stake · validator-set).

### 2. The L1 contract (`contracts/`)

The Aiken (Plutus V3) `talk_vault` — an owner-reclaimable ADA vault marked by a per-user beacon
NFT (`policy_id == this validator's own hash`; beacon `token_name = blake2b_256(cbor.serialise(
owner Address))` = the app-chain identity hash). See [`contracts/README.md`](contracts/README.md)
for the trust model and the creator footguns.

```bash
cd contracts
aiken check                          # 38 tests (incl. 5 property/fuzz, 100 samples each)
aiken build                          # regenerates plutus.json (the blueprint + hash)
node scripts/regen-vault.mjs         # regenerates contracts/vault.json (applied hash + CBOR)
```

Run `regen-vault.mjs` after any `aiken build` that changes the validator: it applies
`min_lock` (100 ADA) and writes `vault.json` (the applied vault hash + CBOR) that the MeshJS
lock/exit scripts and the follower/committee services consume. Changing the validator **moves the
script hash** and orphans any deployed vault (it must be exited under the old hash and re-minted
under the new) — this is exactly what the M8 audit fix did (blueprint `49ffbfc6…`, applied
`168a9710…`). Full audit in [`contracts/audits/`](contracts/audits/).

### 3. The frontend (`app/`)

The "Reading Room / Civic Ledger" SPA — see [`app/README.md`](app/README.md) for the full config
surface and the dual-key model. **Use the nvm node, not the snap node** (`node` here is a snap
build whose stdout is `/dev/null`): prepend `~/.nvm/versions/node/v22.12.0/bin` to `PATH`.

```bash
cd app
npm install                 # postinstall runs `papi` to generate the typed descriptors
npm run dev                 # dev server on :3000, points at ws://127.0.0.1:9944 by default
npm run build               # Next.js static export → app/out/ (self-hostable on any static host)
```

After a runtime `spec_version` bump, regenerate the PAPI descriptors against a live node:
`rm .papi/descriptors/generated.json && npx papi add cogno -w ws://127.0.0.1:9944`.

**M8 additions:** an in-browser **CIP-30 wallet** lock/exit (lock ADA into / reclaim ADA from the
`talk_vault` directly from a browser wallet via Blockfrost — set a preprod project id in Settings
or `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID`), and a **hardened encrypted posting keystore** (the
sr25519 posting mnemonic is held as PBKDF2 → AES-GCM-256 ciphertext, unlocked per session with a
password).

### 4. The services (`services/`)

Each has its own README; one line each here. All the Node services use the nvm node v22.12.0.

- **cogno-follower** (`services/cogno-follower`, HTTP **:8090**) — the Cardano READ link. A Python
  CIP-8 verifier (`pycardano`) that turns a wallet signature into the 1:1 identity binding, then
  observes the `talk_vault` UTxO and writes the Cardano-sourced weight. Start: `./run.sh`. See
  [`services/cogno-follower/README.md`](services/cogno-follower/README.md).
- **anchor-relayer** (`services/anchor-relayer`) — the Cardano WRITE link. Every N finalized
  blocks it writes that block's finalized post-state root onto Cardano as a metadata tx, then
  `anchor_ack`s it back (evidence, not enforcement). Start: `node relayer.mjs` (`--once` for a
  single anchor). See [`services/anchor-relayer/README.md`](services/anchor-relayer/README.md).
- **committee** (`services/committee`) — tooling to drive the privileged calls (`set_stake`,
  `anchor_ack`, `add/remove_validator`) through the **3-of-5 `FollowerCommittee`** (propose → vote
  ×3 → close) instead of sudo. E.g. `node op.mjs --call talkStake.setStake --args '[…]' --via
  committee`. See [`services/committee/README.md`](services/committee/README.md).
- **indexer** (`services/indexer`) — the self-hosted **SubQuery** GraphQL read layer (folds the
  chain's public events into Postgres; paginated/searchable/threaded feed). Runs without Docker on
  local Postgres 16: `./run-indexer.sh` (ingest) + `./run-query.sh` (GraphQL on :3000). The
  frontend reads it only when a GraphQL endpoint is configured; PAPI-direct is the always-available
  fallback. See [`services/indexer/README.md`](services/indexer/README.md).

### The full live stack (preprod)

`cardano-node` + Ogmios **:1337** + Kupo **:1442** + `cogno-chain-node` **:9944** + cogno-follower
**:8090**. The end-to-end loop — lock ADA → CIP-8 bind → committee `set_stake` from the locked
lovelace → feeless `PostCreated` (Δbalance = 0) → finalized root anchored to Cardano — is proven
live on spec 107 in [`docs/M8-relaunch.md`](docs/M8-relaunch.md) and [`docs/M7-ops.md`](docs/M7-ops.md).
