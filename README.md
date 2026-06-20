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
- **You run it with your own keys.** [`scripts/gen-chainspec.mjs`](scripts/gen-chainspec.mjs)
  generates your validator, committee, and sudo keys and bakes them into a custom genesis — no
  well-known dev keys anywhere (`//Alice` is only the local `--dev` quick-start). See
  [Run the chain](#run-the-chain).
- **Privileged calls go through the committee** (`set_stake`, `anchor_ack`, `add/remove_validator`):
  the on-chain origin is **≥3/5 of the FollowerCommittee** OR sudo. The mechanism is real, but with
  one operator holding all the committee keys it is **D2-*shaped*, not D2-*trust*** until the seats
  are split across independent custodians.

The deeper, still-open hardening items — raising `MinAuthorities` above 1, wiring real GRANDPA
equivocation/slashing, replacing the single trusted follower, and dropping sudo — are deliberate
**testnet** choices flagged as `MAINNET PREREQUISITE` in the source and detailed in
[`docs/L3-SPO-graduation.md`](docs/L3-SPO-graduation.md),
[`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md), and
[`docs/DECISION-REGISTER.md`](docs/DECISION-REGISTER.md).

## Architecture — the stack

```
                 Cardano preprod (external)                 The app-chain (this repo)
        ┌───────────────────────────────────┐      ┌──────────────────────────────────────┐
        │  cardano-node  ─ Ogmios  :1337     │      │  validator node(s)   Aura + GRANDPA   │
        │                ─ db-sync (Postgres)│◀────▶│  tracking node(s)    sync + RPC :9944 │
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
| Cardano integration | a synced preprod **`cardano-node`** + **Ogmios** (:1337) + **db-sync** (read-only Postgres); optional **Blockfrost** preprod project id for the in-browser wallet |

## Build

```bash
cargo build --release            # heavy first compile; produces ./target/release/cogno-chain-node
cargo test                       # pallet unit/boundary tests (see Development for the other layers)
```

---

## Run the chain

> Build with a plain **`cargo build --release`** (default features). A `--features
> runtime-benchmarks` build produces a runtime a normal node can't execute, and the chain spec
> embeds that runtime — so always generate the spec with the same clean binary you run.

### Local quick-start (throwaway)

```bash
./target/release/cogno-chain-node --dev          # one //Alice authority, Alice = sudo, WS :9944
```

`--dev` is an ephemeral single-node chain on well-known dev keys (it also seats a `//Alice…//Eve`
committee so the 3-of-5 path is drivable, and sets `--force-authoring`). Use it for local
development only — the state and genesis are thrown away on restart.

### Your own network

This is the real path: your keys, your genesis, one or more validators plus tracking nodes. It has
**no Cardano dependency** — the chain runs on its own.

**1 — Generate your keys + chain spec.** The generator creates your validator / committee / sudo
keys (no dev keys) and bakes them into a custom genesis:

```bash
OUT=./network VALIDATORS=2 COMMITTEE=5 CHAIN_NAME="Cogno" CHAIN_ID="cogno" \
  node scripts/gen-chainspec.mjs        # run with the nvm node
```

It writes `network/`: `raw.json` (the spec every node loads), `keys.json` (your secret mnemonics —
**chmod 600, back it up, never commit**; gitignored), `env.sh` (the service key env — see below),
and `NEXT-STEPS.md` (a runbook filled in with your accounts). Copy `raw.json` to every node — it must
be **byte-identical** everywhere or nodes won't peer.

**2 — Insert each validator's session keys** into its node keystore (two distinct schemes; mnemonics
are in `keys.json`):

```bash
NODE=./target/release/cogno-chain-node; RAW=./network/raw.json
$NODE key insert --base-path /var/lib/cogno/v1 --chain $RAW --scheme sr25519 --key-type aura --suri "<validator-1 mnemonic>"  # authoring
$NODE key insert --base-path /var/lib/cogno/v1 --chain $RAW --scheme ed25519 --key-type gran --suri "<validator-1 mnemonic>"  # finality
```

**3 — Give the boot validator a stable identity, then launch it:**

```bash
$NODE key generate-node-key --file /var/lib/cogno/v1/node-key    # peer id → stderr
$NODE key inspect-node-key  --file /var/lib/cogno/v1/node-key    # re-print it
# bootnode multiaddr = /ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<PEER_ID>

$NODE --validator --name v1 --chain $RAW --base-path /var/lib/cogno/v1 \
  --node-key-file /var/lib/cogno/v1/node-key \
  --port 30333 --rpc-port 9944 \
  --state-pruning archive --blocks-pruning archive    # archive REQUIRED if it feeds the indexer (DR-08)
  # add --force-authoring ONLY for a single-validator chain (it has no peers to confirm against)
```

**4 — Add more validators and/or tracking nodes** (they dial the boot node). On separate hosts keep
the default ports; on one host give each a distinct `--port`/`--rpc-port`.

```bash
# another validator (needs its own libp2p key: a --node-key-file, or --unsafe-force-node-key-generation):
$NODE --validator --name v2 --chain $RAW --base-path /var/lib/cogno/v2 \
  --port 30333 --rpc-port 9944 --unsafe-force-node-key-generation \
  --bootnodes /ip4/<BOOT_IP>/tcp/30333/p2p/<BOOT_PEER_ID>

# a tracking (non-validator) full node — omit --validator; serves RPC for the frontend/indexer:
$NODE --name track1 --chain $RAW --base-path /var/lib/cogno/track1 \
  --port 30333 --rpc-port 9944 \
  --bootnodes /ip4/<BOOT_IP>/tcp/30333/p2p/<BOOT_PEER_ID> \
  --state-pruning archive --blocks-pruning archive \
  --rpc-external --rpc-methods safe --rpc-cors '<allowed-origins>'
```

Default ports: **P2P 30333** (`--port`), **JSON-RPC 9944** (`--rpc-port`, serves both WS and HTTP —
there is no separate WS port), **Prometheus 9615**. A validator **starts authoring once it has ≥1
peer**, and GRANDPA needs **≥2/3 of validators online to finalize** — so a 2-validator network needs
both up. `--rpc-external`/`--rpc-methods`/`--rpc-cors` control RPC exposure (localhost + `safe` by
default — put a filtering proxy in front before exposing anything). `--state-pruning` is fixed at
first DB creation.

> **Verified:** a 2-validator + 1-tracker network generated this way produces *and* finalizes blocks,
> and the tracking node syncs the same chain — see the validation in the commit that added the
> generator.

**5 — Onboard a validator after genesis.** The set is mutable; you don't have to bake every
validator into genesis. Generate + insert its keys (steps 1–2 / `key generate`), register them with
`session.setKeys(keys, proof)` (a real proof-of-possession, built by the committee tooling — an
empty proof is rejected), then admit it through the committee:

```bash
node services/committee/op.mjs --call validatorSet.addValidator --args '["<new-validator-SS58>"]' --via committee
node services/committee/op.mjs --call validatorSet.removeValidator --args '["<SS58>"]' --via committee
```

Changes apply at a **session boundary** (next-but-one session — ~2 min at the default `SessionPeriod`
of 10 blocks × 6 s; lengthen it for a real network). Confirm with `session.validators()` (active) vs
`validatorSet.validators()` (pending). Aura (authoring) and GRANDPA (finality) move in lockstep.

---

## Run the Cardano integration

This turns the standalone chain into the full ADA-metered app. It needs the external Cardano stack
**up and synced first**, then the off-chain services.

### 1 — External Cardano dependencies (preprod)

A synced preprod `cardano-node` feeding **Ogmios** (`http://127.0.0.1:1337` — cost models, tx submit,
tip) and a read-only **db-sync** Postgres (vault observation: a deterministic block-at/before-slot
anchor and the vault UTxO reads — spentness from `tx_in`, coins as `::text`, driven by the indexed
`tx_out.payment_cred`). Ogmios/db-sync launch flags live with those tools, not in this repo (M7/M8
used Ogmios v6.x). The services point at them via the `OGMIOS` / `DBSYNC_URL` env vars.

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

**One-time setup** (run everything with the nvm node v22.12.0). The Node services share deps via
symlinks (gitignored), so install in the right dirs and recreate the links — exactly what CI does:

```bash
( cd app && npm install )            # builds app/node_modules + PAPI descriptors (relayer reuses these)
( cd services/indexer && npm install )   # committee reuses these deps
ln -sfn ../indexer/node_modules   services/committee/node_modules
ln -sfn ../../app/node_modules    services/anchor-relayer/node_modules

# cogno-follower needs a Python venv with pycardano (Python 3.12):
python3.12 -m venv services/cogno-follower/.venv
services/cogno-follower/.venv/bin/pip install -r services/cogno-follower/requirements.txt
export COGNO_FOLLOWER_PY="$PWD/services/cogno-follower/.venv/bin/python"   # optional; run.sh defaults to ./.venv

# point the committee + follower at YOUR keys (from step 1 of "Your own network"):
source ./network/env.sh              # exports COMMITTEE_SEEDS + SUDO_SEED (default: the dev keys)
```

Each service has its own README. Stateful files (relayer wallet + anchor cursor, committee vault, the
single-instance lock) default to a **durable, user-private data dir** — `$COGNO_DATA_DIR`, else the
systemd `StateDirectory`, else `~/.local/state/cogno` (see [`services/_shared/paths.mjs`](services/_shared/paths.mjs)); **never `/tmp`**. An existing `/tmp/cogno-m2/*` file is auto-migrated on first read.
For a supervised, always-on deployment use the committed `systemd` units in [`deploy/`](deploy/).
Start order: **indexer node → query** (the query service needs the schema the ingest node creates);
the follower and relayer can start anytime the node WS is up.

- **cogno-follower** (`:8090`, binds `127.0.0.1`) — a **read-only** HTTP helper for the identity gate
  (it no longer writes the chain). Serves the exact CIP-8 bind payload to sign (`/nonce`), liveness
  (`/health`), and Prometheus `/metrics`. Since D1, identity binding is the permissionless **on-chain**
  self-proof `cognoGate.link_identity_signed` — the runtime verifies the wallet signature — optionally
  fee-sponsored via the **sponsored-bind-relay** (`POST /bind` is retired → 410). Cardano-sourced weight
  is driven separately by the 3-of-5 committee `set_stake` path. `CARDANO_NETWORK=testnet` for preprod.
  Start: `./run.sh`.
- **anchor-relayer** (no listen port; a polling writer) — the WRITE link. Every `ANCHOR_EVERY`
  finalized blocks it writes that block's finalized post-state root to a Cardano metadata tx, then
  `anchor_ack`s it back through the committee (`ANCHOR_VIA=committee`). It needs a **funded preprod
  Cardano wallet** persisted to `OWNER_FILE` (default `$COGNO_DATA_DIR/owner.json`, `0600`): for a
  fresh deployment run `COGNO_ALLOW_WALLET_BREW=1 node app/scripts/m2d-wallet.mjs` to print the address,
  then fund it with tADA (it **refuses to silently brew** an unfunded wallet otherwise). Set
  `CONFIRM_DEPTH_SLOTS` (default 0) to a few hundred for reorg-safety in production. It persists its
  anchor cursor atomically, takes a single-instance lock, and shuts down cleanly on `SIGTERM`. Start:
  `node relayer.mjs` (`--once` for one anchor). Evidence, not enforcement.
- **committee** — operator tooling (not a daemon) that drives privileged calls through the
  `FollowerCommittee` (propose → vote → close, ≥3/5) signing with `COMMITTEE_SEEDS`, or sudo with
  `SUDO_SEED`. E.g. `node op.mjs --call talkStake.setStake --args '[…]' --via committee`;
  `node sync-weight.mjs --via committee` to set weight from the observed vault.
- **indexer** (`:3000` GraphQL, `:3001` admin) — the self-hosted **SubQuery** read layer. Needs
  **Postgres 16** (`createdb cogno_indexer`; `psql -d cogno_indexer -c 'CREATE EXTENSION btree_gist'`;
  a `cogno` login role owning it; creds in `services/indexer/.env` with `DB_HOST` a TCP host, not a
  socket) and an **archive node** (DR-08). `TZ=UTC` is required. Re-pin the chain at build:
  `npm run codegen && GENESIS=<0x…> WS=ws://… npx subql build`. Start `./run-indexer.sh` (ingest,
  creates the schema — run first) then `./run-query.sh` (GraphQL). The frontend reads it only when a
  GraphQL endpoint is configured; PAPI-direct is the always-available fallback.

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

For a supervised, always-on deployment, [`deploy/`](deploy/) ships committed `systemd` units (one per
service) with `Restart=always`, boot persistence, dependency ordering, durable `StateDirectory`, and
sandboxing — see [`deploy/README.md`](deploy/README.md) for the full runbook. The bring-up order and
the things that bite, whether you use the units or run by hand:

1. **External Cardano** up and synced: `cardano-node` + Ogmios `:1337` + db-sync (read-only Postgres).
2. **Chain:** `node scripts/gen-chainspec.mjs` to mint your keys + `raw.json`, then run your
   validators with `--state-pruning archive --blocks-pruning archive` (the indexer/anchor-verifier
   need history) plus tracking nodes for RPC. Put `--base-path` on a real disk (not `/tmp`), and keep
   `network/keys.json` backed up and offline.
3. **Re-capture genesis after any (re)launch.** The genesis hash changes whenever you regenerate the
   spec, on a `spec_version` bump, and on a fresh `--dev`/`--tmp` rebuild. Capture it live
   (`chain_getBlockHash(0)`) and feed it to the indexer (`GENESIS`) and `GENESIS.txt` — never hardcode.
4. **Services:** `source network/env.sh` so the committee/follower sign with your keys; point them at
   your node WS, Ogmios, and db-sync; fund the relayer's `OWNER_FILE` wallet. Stateful files now default to
   the durable data dir (`$COGNO_DATA_DIR` / systemd `StateDirectory`, **not `/tmp`**) — set
   `COGNO_DATA_DIR` to pick a location. Bind the follower behind HTTPS with a pinned origin (it ships
   plain HTTP + permissive CORS for the localhost showcase — least-privilege + transport hardening is on
   the roadmap). The relayer and follower are single points of failure (DR-22) — the node + both
   services now expose Prometheus `/metrics` + health endpoints, with scrape config + alert rules in
   [`deploy/monitoring/`](deploy/monitoring/).
5. **Ports to open:** P2P `30333` (public); RPC `9944` (behind a proxy if exposed); Prometheus `9615`;
   relayer metrics `9101`; follower `8090`; indexer `3000`/`3001`; Postgres `5432`; Ogmios `1337`. (The
   `/metrics` + health ports stay on your private scrape network, not public.)

You now run on your **own** keys, sudo, and committee. What still stays **testnet-scoped** (the
deeper mainnet prerequisites, by design): sudo retained as an escape hatch, `MinAuthorities = 1`,
GRANDPA equivocation as a no-op (no slashing), the single trusted follower, and — until you split the
committee seats across independent custodians — D2-*shaped* authority. See
[`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md) and
[`docs/L3-SPO-graduation.md`](docs/L3-SPO-graduation.md).

### Configuration reference

Full surface in [`.env.example`](.env.example); the most-used variables:

| Variable | Default | Used by |
|---|---|---|
| `WS` | `ws://127.0.0.1:9944` | every service (node JSON-RPC) |
| `COMMITTEE_SEEDS` / `SUDO_SEED` | the dev keys | committee + follower signers (set to **your** keys via `network/env.sh`) |
| `OGMIOS` / `DBSYNC_URL` | `http://127.0.0.1:1337` / *(read-only Postgres DSN)* | relayer, committee, follower |
| `CARDANO_NETWORK` | `testnet` | follower (network-id gate; `mainnet` for mainnet) |
| `ANCHOR_VIA` / `ANCHOR_EVERY` / `CONFIRM_DEPTH_SLOTS` | `committee` / `10` / `0` | anchor-relayer |
| `COGNO_DATA_DIR` | `~/.local/state/cogno` (systemd: `/var/lib/cogno`) | durable dir for the relayer wallet + anchor cursor + committee vault + lock (never `/tmp`) |
| `STATE_FILE` / `VAULT_FILE` / `OWNER_FILE` | `$COGNO_DATA_DIR/…` | relayer / committee (`OWNER_FILE` = relayer's funded Cardano wallet; an explicit override wins) |
| `COGNO_ALLOW_WALLET_BREW` | *(unset)* | set `1` to deliberately brew a new relayer wallet (else it refuses, to avoid a silent unfunded rotation) |
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
└─ scripts/                    # gen-chainspec.mjs (own-keys genesis) + acceptance/ (headless test)
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
- **Upgrading a live chain** (adding features, soft vs hard forks, the mixed-validator question,
  storage migrations, enactment): [`docs/UPGRADES.md`](docs/UPGRADES.md).
- **Design & build history:** the full L1–L5 design, the economic model, and the canonical
  [`DECISION-REGISTER.md`](docs/DECISION-REGISTER.md) live in [`docs/`](docs/), alongside per-milestone
  build logs ([`docs/M*-build.md`](docs/)) recording how the stack was built incrementally (M0–M10).
- **Contributing in this repo:** see [`CLAUDE.md`](CLAUDE.md) for conventions and the gotchas that
  bite (live contract hash, nvm-vs-snap node, committee-not-sudo, the rustc pin).
