# cogno-chain

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app. The
right to post is metered by a regenerating, stake-weighted **"talk capacity"** you earn by locking
ADA in a Cardano L1 smart contract — posting **costs no money per post**. Cardano is **observed, not
bridged**: it answers *"can you sign with this wallet?"* (CIP-8 identity), supplies the *weight*
(locked ADA), and *witnesses* finalized state-roots (metadata anchors). The app-chain inherits
**none** of Cardano's economic finality or security — its safety is its own operator-run
Aura/GRANDPA.

> **Why it exists:** the prior Cardano-native forum **Cogno** (`logicalmechanism/cogno_v3`) became
> too expensive at volume (per-post L1 fees + min-ADA-per-byte). cogno-chain moves posts onto cheap
> feeless blockspace and replaces fees with a capacity meter.

The chain + frontend run **standalone**. The Cardano integration (identity, weight, anchoring) is
**additive** and needs an external preprod Cardano stack — see [Run the Cardano
integration](#run-the-cardano-integration).

---

## Trust model — what you're running

This is a permissioned, operator-run stack. Know what you're trusting before you deploy it:

- **Consensus is your own PoA.** Blocks are authored by **Aura** and finalized by **GRANDPA** over a
  validator set *you* run. The chain borrows none of Cardano's security. The validator set is
  **mutable** (run one node or many — see below), but it is **not BFT-hardened**: `MinAuthorities`
  is `1`, equivocation/double-sign reporting is a deliberate no-op (no slashing), and a 1–3-validator
  set can **stall finality** if one node drops (GRANDPA needs `3f+1` to tolerate `f` faults).
- **The Cardano follower is a trusted oracle.** A single off-chain service verifies CIP-8 proofs and
  writes each account's locked-ADA weight. A follower outage freezes weight updates.
- **Privileged calls go through a 3-of-5 committee** (`set_stake`, `anchor_ack`, `add/remove_validator`),
  with sudo retained as a dev fallback. Today this is **D2-*shaped*, not D2-*trust***: one operator
  holds all five committee keys. Real decentralization means five independent custodians.
- **Genesis ships well-known dev keys** (`//Alice`…). A throwaway preprod test can run on them; a
  network with any value cannot — you must author a custom genesis with your own keys.

These are deliberate **testnet** choices, flagged as `MAINNET PREREQUISITE` in the source and
detailed in [`docs/L3-SPO-graduation.md`](docs/L3-SPO-graduation.md),
[`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md), and
[`docs/DECISION-REGISTER.md`](docs/DECISION-REGISTER.md).

## Architecture — the stack

```
                 Cardano preprod (external)                 The app-chain (this repo)
        ┌───────────────────────────────────┐      ┌──────────────────────────────────────┐
        │  cardano-node  ─ Ogmios :1337      │      │  validator node(s)   Aura + GRANDPA   │
        │                ─ Kupo   :1442      │◀────▶│  tracking node(s)    sync + RPC :9944 │
        │  talk_vault contract + beacon NFT  │      │  runtime: microblog · talk-stake ·    │
        └───────────────────────────────────┘      │           cogno-gate · anchor ·       │
                          ▲                          │           validator-set + committee   │
            off-chain services (Node/Python)         └──────────────────────────────────────┘
        ┌───────────────────────────────────┐                        ▲
        │ cogno-follower :8090  READ  (CIP-8 + weight)                │ PAPI / GraphQL
        │ anchor-relayer        WRITE (state-root → Cardano)         │
        │ committee             privileged ops via 3-of-5            │
        │ indexer  :3000/:3001  SubQuery read layer (Postgres 16)    │
        └───────────────────────────────────┘                        │
                                                          frontend (Next.js static SPA)
```

Two node roles:

- **Validator node** (`--validator`) — authors blocks (Aura) and votes finality (GRANDPA) when it
  holds session keys in its keystore.
- **Tracking node** (omit `--validator`) — syncs the chain and serves RPC, but never authors or
  votes. Use these as RPC endpoints for the frontend/indexer and to scale reads.

---

## Prerequisites

**To build the node:**

```bash
# System packages (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y \
  clang protobuf-compiler cmake libssl-dev pkg-config make build-essential
```

Rust is pinned by [`rust-toolchain.toml`](rust-toolchain.toml) to **`channel = "1.90.0"`** (not
rolling `stable` — current stable 1.96 breaks the `sp_io` wasm link). `cargo build` auto-selects it;
just have `rustup` installed. Pinned upstream (DR-03): polkadot-sdk **`polkadot-stable2603-3`**
(commit `e3737178ec726cffe506c907263aaaa417893fd0`); `Cargo.lock` is committed — don't regenerate it.

**To run the rest of the stack** (only what you use):

| Component | Needs |
|---|---|
| Off-chain services + frontend | **Node v22.12.0 via nvm** — *not* the snap `node` (its stdout is `/dev/null` and `@meshsdk/core-cst` redirects stdio). Prepend `~/.nvm/versions/node/v22.12.0/bin` to `PATH`. |
| cogno-follower | Python with `pycardano` (the pinned `cogno_v3` venv) |
| indexer | **PostgreSQL 16** (uses `btree_gist`) |
| contracts (only to rebuild) | **Aiken** `v1.1.22` |
| Cardano integration | a synced preprod **`cardano-node`** + **Ogmios** (:1337) + **Kupo** (:1442); optional **Blockfrost** preprod project id for the in-browser wallet |

## Build

```bash
cargo build --release            # heavy first compile; produces ./target/release/cogno-chain-node
cargo test                       # pallet unit/boundary tests (see Development for the other layers)
```

---

## Run the chain

### Quick start — a single dev node

```bash
./target/release/cogno-chain-node --dev          # one //Alice authority, Alice = sudo, WS :9944
```

`--dev` is an ephemeral, single-authority chain (it also seats a `//Alice…//Eve` 5-seat committee so
the 3-of-5 path is drivable). Great for local development; **not** for a persistent deployment —
its state is thrown away and its genesis is a throwaway.

### A persistent network (validators + tracking nodes)

For anything that must survive restarts or span machines, build **one shared raw chain spec**, give
each node a stable identity, and wire them with bootnodes.

**1 — Build the shared chain spec** (once, on any host; copy the raw file to every node):

```bash
# `local` preset = 2 genesis authorities (//Alice + //Bob). See the note below about genesis keys.
./target/release/cogno-chain-node export-chain-spec --chain local --output cognoSpecPlain.json
./target/release/cogno-chain-node export-chain-spec --chain cognoSpecPlain.json --raw --output cognoSpecRaw.json
```

`--chain <path>` loads any file that isn't `dev`/`local`. The raw spec must be **byte-identical** on
every node or they won't peer (the genesis hash must match).

**2 — Give the boot node a stable identity** and read its peer id for the bootnode address:

```bash
./target/release/cogno-chain-node key generate-node-key --file /var/lib/cogno/node-key   # peer id → stderr
./target/release/cogno-chain-node key inspect-node-key --file /var/lib/cogno/node-key     # re-print peer id
# bootnode multiaddr = /ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<PEER_ID>
```

**3 — Run the boot validator:**

```bash
./target/release/cogno-chain-node \
  --validator --name cogno-boot \
  --chain /etc/cogno/cognoSpecRaw.json \
  --base-path /var/lib/cogno/boot \
  --node-key-file /var/lib/cogno/node-key \
  --port 30333 --rpc-port 9944 \
  --state-pruning archive --blocks-pruning archive    # archive REQUIRED if this node feeds the indexer (DR-08)
```

**4 — Run additional validators and/or tracking nodes** (dial the boot node). On separate hosts the
default ports are fine; on one host give each node distinct `--port`/`--rpc-port`.

```bash
# another validator:
./target/release/cogno-chain-node --validator --name cogno-val2 \
  --chain /etc/cogno/cognoSpecRaw.json --base-path /var/lib/cogno/val2 \
  --port 30333 --rpc-port 9944 \
  --bootnodes /ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<BOOT_PEER_ID>

# a tracking (non-validator) full node — just omit --validator; expose RPC for the frontend/indexer:
./target/release/cogno-chain-node --name cogno-track1 \
  --chain /etc/cogno/cognoSpecRaw.json --base-path /var/lib/cogno/track1 \
  --port 30333 --rpc-port 9944 \
  --bootnodes /ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<BOOT_PEER_ID> \
  --state-pruning archive --blocks-pruning archive \
  --rpc-external --rpc-methods safe --rpc-cors '<allowed-origins>'
```

Default ports: **P2P 30333** (`--port`), **JSON-RPC 9944** (`--rpc-port`, serves both WS and HTTP —
there is no separate WS port), **Prometheus 9615**. `--rpc-external`/`--rpc-methods`/`--rpc-cors`
control RPC exposure (localhost + `safe` methods by default — put a filtering proxy in front before
exposing anything publicly). `--state-pruning` can only be set at first DB creation.

> ⚠ **Genesis keys.** The `dev` and `local` presets seat their authorities (and the 5-seat
> committee) with **well-known dev keys** (`//Alice`, `//Bob`, …) — anyone can sign as them. That is
> fine for a throwaway preprod test, but a network holding any value needs a **custom genesis** with
> your own keys. The repo ships only the `dev`/`local` presets (no production preset); a custom
> genesis means authoring/patching the plain chain spec's `session.keys`, `validatorSet`,
> `followerCommittee`, and `sudo` before the `--raw` step. This gap is a documented mainnet
> prerequisite.

### Onboarding a validator at runtime

The validator set is mutable — you don't have to bake every validator into genesis. To promote a
running node to a validator:

1. **Insert its session keys** into the node's keystore — two distinct keypairs:

   ```bash
   ./target/release/cogno-chain-node key insert --base-path <path> --chain <spec> \
     --scheme sr25519 --key-type aura --suri "<aura secret>"     # block authoring
   ./target/release/cogno-chain-node key insert --base-path <path> --chain <spec> \
     --scheme ed25519 --key-type gran --suri "<grandpa secret>"  # finality
   ```

2. **Register the keys on-chain** via `session.setKeys(keys, proof)` signed by the validator's
   account, where `proof` is a real proof-of-possession (an empty proof is rejected). The committee
   tooling builds the PoP and submits it — see [`services/committee/`](services/committee/).

3. **Admit it to the set** through the 3-of-5 committee (or sudo fallback):

   ```bash
   node services/committee/op.mjs --call validatorSet.addValidator --args '["<SS58-account>"]' --via committee
   node services/committee/op.mjs --call validatorSet.removeValidator --args '["<SS58-account>"]' --via committee
   ```

Changes apply at a **session boundary** (next-but-one session — ~2 min at the dev `SessionPeriod` of
10 blocks × 6 s; lengthen `SessionPeriod` for a real testnet). Confirm with `session.validators()`
(active set) vs `validatorSet.validators()` (pending). Aura and GRANDPA move in lockstep.

---

## Run the Cardano integration

This turns the standalone chain into the full ADA-metered app. It needs the external Cardano stack
**up and synced first**, then the off-chain services.

### 1 — External Cardano dependencies (preprod)

A synced preprod `cardano-node` feeding **Ogmios** (`http://127.0.0.1:1337` — cost models, tx submit,
tip) and **Kupo** (`http://127.0.0.1:1442` — UTxO/datum/asset queries, vault observation). Start Kupo
matching the live vault policy id and the owner address. Ogmios/Kupo launch flags live with those
tools, not in this repo (M7/M8 used Ogmios v6.x + Kupo v2.x). The services point at them via the
`OGMIOS` / `KUPO` env vars.

### 2 — The L1 contract (`contracts/`)

The Aiken (Plutus V3) `talk_vault` is an owner-reclaimable ADA vault marked by a per-user beacon NFT
(`policy_id == this validator's own hash`; beacon `token_name = blake2b_256(cbor.serialise(owner
Address))` = the app-chain identity hash). It is **already deployed on preprod** — you only rebuild
it if you change the validator.

```bash
cd contracts
aiken check                       # 46 tests / 739 checks (incl. 7 property/fuzz)
aiken build                       # regenerates plutus.json (blueprint + hash)
node scripts/regen-vault.mjs      # regenerates vault.json (applied hash + CBOR) from min_lock (100 ADA)
```

> ⚠ **Any production edit under `contracts/` moves the script hash** (currently blueprint
> `49ffbfc6…`, applied vault `168a9710…`) and **orphans the deployed vault**. `git diff` the `hash`
> fields in `plutus.json`/`vault.json` after any contracts change. See
> [`contracts/README.md`](contracts/README.md) and [`contracts/audits/`](contracts/audits/).

### 3 — The off-chain services (`services/`)

Each has its own README. Run them with the nvm node (follower with its `pycardano` venv). State
files default to `/tmp/cogno-m2/…` — **relocate them off `/tmp`** on a server.

- **cogno-follower** (`:8090`, binds `127.0.0.1`) — the READ link. A Python CIP-8 verifier that turns
  a wallet signature into the 1:1 identity binding, then observes the `talk_vault` UTxO and writes the
  Cardano-sourced weight. `CARDANO_NETWORK=testnet` for preprod. Start: `./run.sh`.
- **anchor-relayer** (no listen port; a polling writer) — the WRITE link. Every `ANCHOR_EVERY`
  finalized blocks it writes that block's finalized post-state root to a Cardano metadata tx, then
  `anchor_ack`s it back — through the committee by default (`ANCHOR_VIA=committee`). Set
  `CONFIRM_DEPTH_SLOTS` (default 0) to a few hundred for reorg-safety in production. Start:
  `node relayer.mjs` (`--once` for one anchor). Evidence, not enforcement.
- **committee** — operator tooling (not a daemon) that drives privileged calls through the 3-of-5
  `FollowerCommittee` (propose → vote ×3 → close), or sudo. E.g.
  `node op.mjs --call talkStake.setStake --args '[…]' --via committee`; `node sync-weight.mjs --via
  committee` to set weight from the observed vault.
- **indexer** (`:3000` GraphQL, `:3001` admin) — the self-hosted **SubQuery** read layer. Needs
  **Postgres 16** (`createdb cogno_indexer`, `CREATE EXTENSION btree_gist`, a `cogno` login role) and
  an **archive node** (DR-08). `TZ=UTC` is required. Start `./run-indexer.sh` (ingest, creates the
  schema — run first) then `./run-query.sh` (GraphQL). The frontend uses it only when a GraphQL
  endpoint is configured; PAPI-direct is the always-available fallback.

### 4 — The frontend (`app/`)

The "Reading Room / Civic Ledger" SPA — see [`app/README.md`](app/README.md).

```bash
cd app
npm install                 # postinstall runs `papi` to generate the typed descriptors
npm run dev                 # dev server on :3000 (points at ws://127.0.0.1:9944 by default)
npm run build               # Next.js static export → app/out/ (host on any static host / IPFS)
```

**Wallet model — one Cardano wallet does everything, nothing stored.** Connecting a CIP-30 wallet
signs one fixed CIP-8 message; that signature is `blake2b_256`'d into the seed for an sr25519
*posting* key (sign-to-derive — no keystore, no password, re-derived each session). The same wallet
binds identity (M2) and locks/reclaims ADA into the `talk_vault` via **Blockfrost** (set
`NEXT_PUBLIC_BLOCKFROST_PROJECT_ID`). The derived key signs **posts only** and never controls funds.

After a runtime `spec_version` bump, regenerate the PAPI descriptors against a live node:
`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

---

## Deploying on a server (preprod)

A practical bring-up order and the things that bite:

1. **External Cardano** up and synced: `cardano-node` + Ogmios `:1337` + Kupo `:1442`.
2. **Chain:** build a raw chain spec, run at least one validator with `--state-pruning archive
   --blocks-pruning archive` (the indexer/anchor-verifier need history), plus tracking nodes for RPC.
   Put persistent state under `--base-path` on a real disk (not `/tmp`).
3. **Re-capture genesis after any (re)launch.** The genesis hash changes on every `spec_version`
   bump, every fresh `--dev`/`--tmp` rebuild, and every contract relaunch. Capture it live
   (`chain_getBlockHash(0)`) and feed it to the indexer (`GENESIS`) and `GENESIS.txt` — never hardcode.
4. **Services:** point them at your node WS, Ogmios, and Kupo; relocate `STATE_FILE`/`VAULT_FILE` off
   `/tmp`; bind the follower behind HTTPS with a pinned origin (it ships plain HTTP + permissive CORS
   for the localhost showcase). The relayer and follower are single points of failure (DR-22) — add
   health checks + missed-`anchor_ack` alerting.
5. **Ports to open:** P2P `30333` (public); RPC `9944` (behind a proxy if exposed); Prometheus `9615`;
   follower `8090`; indexer `3000`/`3001`; Postgres `5432`; Ogmios `1337`; Kupo `1442`.

What stays **testnet-scoped** (mainnet prerequisites, by design): dev-key genesis, sudo retained,
`MinAuthorities = 1`, equivocation no-op, the single trusted follower, and one operator holding all
five committee keys. See [`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md) and
[`docs/L3-SPO-graduation.md`](docs/L3-SPO-graduation.md).

### Configuration reference

Full surface in [`.env.example`](.env.example); the most-used variables:

| Variable | Default | Used by |
|---|---|---|
| `WS` | `ws://127.0.0.1:9944` | every service (node JSON-RPC) |
| `OGMIOS` / `KUPO` | `http://127.0.0.1:1337` / `:1442` | relayer, committee, follower |
| `CARDANO_NETWORK` | `testnet` | follower (network-id gate; `mainnet` for mainnet) |
| `ANCHOR_VIA` / `ANCHOR_EVERY` / `CONFIRM_DEPTH_SLOTS` | `committee` / `10` / `0` | anchor-relayer |
| `STATE_FILE` / `VAULT_FILE` | `/tmp/cogno-m2/…` | relayer / committee (**relocate on a server**) |
| `DB_USER` / `DB_PASS` / `DB_DATABASE` / `DB_HOST` / `DB_PORT` | `cogno` / *(secret)* / `cogno_indexer` / `127.0.0.1` / `5432` | indexer (host must be TCP, not a socket) |
| `GENESIS` | *(per-script default)* | indexer / verifiers (re-capture per chain) |
| `NEXT_PUBLIC_WS_URL` / `_FOLLOWER_URL` / `_GRAPHQL_URL` / `_BLOCKFROST_PROJECT_ID` | localhost / *(empty)* | frontend (inlined at build) |

---

## Repo layout

```
cogno-chain/
├─ Cargo.toml / Cargo.lock     # workspace, pinned to stable2603-3; Cargo.lock committed
├─ rust-toolchain.toml         # channel = 1.90.0; targets = [wasm32v1-none, wasm32-unknown-unknown]
├─ node/                       # cogno-chain-node (Aura + GRANDPA)
├─ runtime/                    # cogno-chain-runtime (#[frame_support::runtime], spec 107)
├─ pallets/                    # microblog, cogno-gate, talk-stake, anchor, validator-set
├─ contracts/                  # the Aiken L1 `talk_vault` validator (+ audits/)
├─ app/                        # Next.js 14 static-export frontend (PAPI + MeshJS) — see app/README.md
├─ services/                   # cogno-follower · anchor-relayer · committee · indexer · _shared
├─ docs/                       # design specs (PLAN, ECONOMICS, L1–L5), DECISION-REGISTER, build logs
└─ scripts/acceptance/         # headless @polkadot/api acceptance test
```

(`_sdk/` — a vendored polkadot-sdk checkout — is gitignored and omitted above.)

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

Index **7 is vacant** (the stock `pallet-template` was dropped in M7). FRAME allows index gaps, so
the on-wire indices never shift. Talk-capacity is **folded into `microblog`** (no separate capacity
pallet); `talk-stake` only supplies the weight the meter reads.

---

## Development

- **Build & test per layer:** `cargo build --release` / `cargo test` (pallets); `cd contracts &&
  aiken check`; `cd app && npm test` (Vitest). The off-chain services have hand-rolled suites
  (`node services/<svc>/<name>.test.mjs`, `python test_<name>.py`). All four are gated in CI
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml): `contracts` / `rust` / `frontend` /
  `services`).
- **Acceptance:** with a `--dev` node, `cd scripts/acceptance && npm install && WS=ws://127.0.0.1:9944
  node acceptance.mjs`.
- **Encoding discipline:** pallet indices and `transaction_version` are on-wire contracts; bump
  `spec_version` only for encoding-affecting changes and regenerate PAPI descriptors afterward.
- **Design & build history:** the full L1–L5 design, the economic model, and the canonical
  [`DECISION-REGISTER.md`](docs/DECISION-REGISTER.md) live in [`docs/`](docs/), alongside per-milestone
  build logs ([`docs/M*-build.md`](docs/)) recording how the stack was built incrementally (M0–M10).
- **Contributing in this repo:** see [`CLAUDE.md`](CLAUDE.md) for conventions and the gotchas that
  bite (live contract hash, nvm-vs-snap node, committee-not-sudo, the rustc pin).
