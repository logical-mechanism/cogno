# cogno-chain

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app. The
right to post is metered by a regenerating, stake-weighted **"talk capacity"** you earn by locking
ADA in a Cardano L1 smart contract — posting **costs no money per post**. Cardano is **observed, not
bridged**: it answers *"can you sign with this wallet?"* (CIP-8 identity), supplies the *weight*
(locked ADA + stake), and provides a deterministic block clock (a stable Cardano block hash sealed
into each header). It is **observe-only** — no bridge, no tokens moved, nothing written back to
Cardano. The app-chain inherits **none** of Cardano's finality or security — its safety is its own
operator-run Aura/GRANDPA.

> **Why it exists:** the prior Cardano-native forum **Cogno** (`logicalmechanism/cogno_v3`) became
> too expensive at volume (per-post L1 fees + min-ADA-per-byte). cogno-chain moves posts onto cheap
> feeless blockspace and replaces fees with a capacity meter.

The chain + frontend run **standalone**. The Cardano integration (identity + weight) is
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
- **Weight is an in-protocol observation, not a trusted service.** Each block, the node's
  `cardano-observer` inherent reads the locked-ADA vaults + stake from a read-only Cardano **db-sync**
  and credits talk-capacity weight. It is the **SOLE** writer of weight — there is no `set_stake`
  extrinsic and no off-chain follower. Every full node re-derives the same observation deterministically
  (a divergence is a chain fork), so it is trust-*minimized* — but **D4-*shaped*, not trustless** until
  ≥3 independent producers run it (a single producer is one honest operator).
- **You run it with your own keys.** `cogno-chain-cli key gen` mints your validator + committee keys
  (by file path) and `cogno-chain-node gen-chainspec` bakes them into a custom genesis — no
  well-known dev keys anywhere (`//Alice` is only the local `--dev` quick-start). See
  [Run the chain](#run-the-chain).
- **There is no sudo.** Every privileged call (`add/remove_validator`, observer enforcement, the gate
  `revoke` ban, granting/revoking governance-fuel allowances, runtime upgrades) goes through the
  **3-of-5 FollowerCommittee**, which exists from block 0 and can start single-seat and federate out by
  vote. The mechanism is real, but with one
  operator holding all the seats it is **D2-*shaped*, not D2-*trust*** until they are split across
  independent custodians.

The deeper, still-open hardening items — raising `MinAuthorities` above 1, wiring real GRANDPA
equivocation/slashing, an independent CIP-8-verifier audit, and graduating past a single observer/producer
— are deliberate **testnet** choices flagged as `MAINNET PREREQUISITE` in the source and detailed in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (Trust posture) and
[`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md).

## Architecture — the stack

```
   Cardano preprod (external)                    The app-chain (this repo)

   cardano-node                                  cogno-chain-node  (one binary)
     └ db-sync (read-only Postgres) ──read──▶      · cardano-observer inherent: reads db-sync,
   talk_vault contract + beacon NFT                  credits locked-ADA + stake → talk-capacity weight
                                                    · Aura + GRANDPA · 3-of-5 committee (no sudo)
   Ogmios :1337 · Blockfrost      ◀──L1 tx───       · runtime: microblog · talk-stake · cogno-gate ·
     (L1 lock/exit, from frontend)    submit           profile · validator-set · governance-fuel
                                                    · serves ALL reads via its runtime API

        frontend (Next.js static SPA) ──PAPI :9944──▶ node
           └ CIP-30 wallet + L1 lock ──▶ Ogmios / Blockfrost
```

The node is the **whole backend** — one binary. It authors + finalizes blocks, runs the Cardano
observer in-protocol, and serves every read (feed / thread / search / profile) from its own runtime
API. `cogno-chain-cli` is a separate, run-anywhere admin tool (keys by file) — not a service; there
is no follower, relayer, or indexer. Two node roles:

- **Validator node** (`--validator`) — authors blocks (Aura) and votes finality (GRANDPA) when it
  holds session keys in its keystore.
- **Tracking node** (omit `--validator`) — syncs the chain and serves RPC, but never authors or
  votes. Use these as RPC endpoints for the frontend and to scale reads.

---

## Prerequisites

**To build the node:**

```bash
# System packages (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y \
  clang llvm-dev libclang-dev protobuf-compiler cmake libssl-dev pkg-config make build-essential
```

> `llvm-dev` + `libclang-dev` are required by `bindgen`/`librocksdb-sys`; without them the build
> fails with an `llvm-config` execute error. On distros that ship these under versioned names only
> (e.g. Ubuntu 24.04 → `llvm-config-18`, no plain `llvm-config` on `PATH`), either symlink it
> (`sudo ln -sf "$(ls /usr/bin/llvm-config-* | sort -V | tail -1)" /usr/bin/llvm-config`) or export
> `LLVM_CONFIG_PATH` at the versioned binary.

Rust is pinned by [`rust-toolchain.toml`](rust-toolchain.toml) to **`channel = "1.93.0"`** (not
rolling `stable` — stay on the toolchain the pinned SDK release is verified against). `cargo build`
auto-selects it; just have `rustup` installed. Pinned upstream (DR-03): polkadot-sdk **`stable2606`**
(release tag `polkadot-stable2606-rc4`; forked from `templates/solochain` at `polkadot-stable2603-3`,
commit `e3737178ec726cffe506c907263aaaa417893fd0`); `Cargo.lock` is committed — don't regenerate it.

**To run the rest of the stack** (only what you use):

| Component | Needs |
|---|---|
| Frontend + the CIP-8 CI oracle | **Node v22.12.0 via nvm** — *not* the snap `node` (its stdout is `/dev/null` and `@meshsdk/core-cst` redirects stdio). Prepend `~/.nvm/versions/node/v22.12.0/bin` to `PATH`. |
| CIP-8 oracle (CI only) | Python 3.12 with `pycardano` (`ci/cip8-oracle/`) |
| contracts (only to rebuild) | **Aiken** `v1.1.22` |
| Cardano integration | a synced preprod **`cardano-node`** + read-only **db-sync** (Postgres) for the observer; **Ogmios** (:1337) + a **Blockfrost** preprod project id for the frontend's L1 lock/exit |

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
./target/release/cogno-chain-node run --dev      # one //Alice authority, WS :9944
```

`--dev` is an ephemeral single-node chain on well-known dev keys (it seats a single-seat `//Alice`
committee — the founder-governs-alone bootstrap where a motion executes on propose — and sets
`--force-authoring`). Use it for local
development only — the state and genesis are thrown away on restart.

### Your own network

This is the real path: your keys, your genesis, one validator to start (the set is mutable — grow it
by on-chain vote), plus any tracking nodes. It has **no Cardano dependency** — the chain runs on its own.

**1 — Generate your keys** with `cogno-chain-cli key gen` (cardano-cli-style JSON envelopes, written
`0600`, keyed **by file path** — no seed phrases). You need a validator account key (sr25519), its two
session keys (Aura sr25519 + GRANDPA ed25519), at least one committee seat (sr25519), and — because a
`--validator` node will **not** auto-generate one (see step 4) — a libp2p **node (p2p) key** via `key
generate-node-key` (a raw ed25519 secret; it prints the derived peer id):

```bash
CLI=./target/release/cogno-chain-cli
$CLI key gen --scheme sr25519 --out val-account.skey
$CLI key gen --scheme sr25519 --out val-aura.skey
$CLI key gen --scheme ed25519 --out val-grandpa.skey
$CLI key gen --scheme sr25519 --out seat1.skey        # repeat for more committee seats
$CLI key generate-node-key   --out val-p2p.key        # the validator's p2p network identity (peer id)
```

**2 — Build your operator-keyed chain spec** from those key FILES (it reads only their PUBLIC keys and
refuses dev keys). `--base cogno-preprod` (a live-observing chain) or `cogno-dev`:

```bash
NODE=./target/release/cogno-chain-node
$NODE gen-chainspec --base cogno-preprod \
  --validator-account-key val-account.skey \
  --validator-aura-key val-aura.skey --validator-grandpa-key val-grandpa.skey \
  --committee-key seat1.skey \
  --out-raw raw.json                    # + a plain, inspectable spec
```

Copy `raw.json` to every node — it must be **byte-identical** everywhere or nodes won't peer.
`gen-chainspec` prints the exact `key insert` + `run` lines for the keys you passed.

**3 — Insert the validator's session secrets** into its keystore, FROM the key files:

```bash
$NODE key insert --base-path /var/lib/cogno/v1 --chain raw.json --key-file val-aura.skey    --key-type aura  # authoring
$NODE key insert --base-path /var/lib/cogno/v1 --chain raw.json --key-file val-grandpa.skey --key-type gran  # finality
```

**4 — Launch the boot validator**, passing the step-1 p2p key with `--node-key-file`. A `--validator`
node will **not** auto-generate a node key — the SDK refuses (an authority that silently adopts a new
peer id becomes unreachable to peers who pinned the old one) and exits with `NetworkKeyNotFound` unless
you supply one. `key generate-node-key` already printed the peer id; re-read it any time with `$NODE key
inspect-node-key --file val-p2p.key`. The bootnode multiaddr is
`/ip4/<BOOT_PUBLIC_IP>/tcp/30333/p2p/<PEER_ID>`.

```bash
# --force-authoring is single-validator only (a lone validator has no peers to confirm against).
$NODE run --validator --name v1 --chain raw.json --base-path /var/lib/cogno/v1 \
  --node-key-file val-p2p.key \
  --force-authoring \
  --port 30333 --rpc-port 9944 \
  --state-pruning archive --blocks-pruning archive
```

**5 — Add more validators and/or tracking nodes** (they dial the boot node). On separate hosts keep
the default ports; on one host give each a distinct `--port`/`--rpc-port`. Each **validator** needs its
**own** node key — mint one per validator with `$CLI key generate-node-key` and pass `--node-key-file`. A
**tracking** (non-validator) node is not an authority, so it auto-generates + persists its own p2p key
under its `--base-path` on first run (no step needed).

```bash
# another validator (drop --force-authoring once it has a peer):
$CLI key generate-node-key --out v2-p2p.key
$NODE run --validator --name v2 --chain raw.json --base-path /var/lib/cogno/v2 \
  --node-key-file v2-p2p.key \
  --port 30333 --rpc-port 9944 \
  --bootnodes /ip4/<BOOT_IP>/tcp/30333/p2p/<BOOT_PEER_ID>

# a tracking (non-validator) full node — omit --validator; auto-generates its p2p key; serves RPC:
$NODE run --name track1 --chain raw.json --base-path /var/lib/cogno/track1 \
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

> A 2-validator + 1-tracker network built this way produces *and* finalizes blocks, and the tracking
> node syncs the same chain.

**6 — Onboard a validator after genesis.** The set is mutable — you don't bake every validator into
genesis. Generate + insert its keys (steps 1 + 3), **fund the account with a standing fuel allowance so it
can pay the fee-bearing `set-keys`** (fuel is the native token; it then *regenerates* toward the allowance
each period, so the account never drains — see [ECONOMICS.md](docs/ECONOMICS.md#64-the-native-governance-fuel-token)), have the new validator
register its own session keys with `cogno-chain-cli validator set-keys` (a real proof-of-possession — an
empty proof is rejected), then admit it through the committee. **This order is enforced on-chain**:
`validator add` rejects an account with no fuel allowance (`NotFunded`) or no session keys
(`NoSessionKeys`), and `committee members add` rejects seating a committee member with no fuel allowance —
so you can't accidentally seat a role that can't function.

```bash
# Fund first (committee motion): a standing, regenerating fuel allowance for the new account.
$CLI fuel set-allowance --account <new-validator-SS58> --max 1000000000000000 --committee-signing-key-file seat1.skey --ws ws://<boot>:9944
# … new validator runs `validator set-keys` (self-signed) …
$CLI validator add    --validator <new-validator-SS58> --committee-signing-key-file seat1.skey --ws ws://<boot>:9944
$CLI validator remove --validator <SS58>               --committee-signing-key-file seat1.skey --ws ws://<boot>:9944
# Cut off a spamming / departed account (drop allowance + claw back balance):
$CLI fuel revoke      --account <SS58>                  --committee-signing-key-file seat1.skey --ws ws://<boot>:9944
```

Changes apply at a **session boundary** (next-but-one session — ~2 min at the default `SessionPeriod`
of 10 blocks × 6 s; lengthen it for a real network). Confirm with `session.validators()` (active) vs
`validatorSet.validators()` (pending). Aura (authoring) and GRANDPA (finality) move in lockstep.

---

## Run the Cardano integration

This turns the standalone chain into the full ADA-metered app. It needs the external Cardano stack
**up and synced first**; there are no off-chain services to run — the node observes Cardano itself.

### 1 — External Cardano dependencies (preprod)

The **node's observer** reads a read-only **db-sync** Postgres — the vault observation: a
deterministic block-at/before-slot reference + the vault UTxO reads (spentness from `tx_in`, coins as
`::text`, driven by the indexed `tx_out.payment_cred`), pointed at by `DBSYNC_URL`. That is the node's
only Cardano dependency; absent/unset, the observer abstains and the chain still runs. MAINNET
PREREQUISITE: db-sync FULL (non-pruned), `tx_in`-enabled (NOT `--consumed-tx-out`), over TLS. The
**frontend's** L1 lock/exit additionally needs **Ogmios** (`http://127.0.0.1:1337` — cost models + tx
submit) and/or **Blockfrost**; the node never talks to Ogmios. Launch flags for those tools live with
them, not in this repo.

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

### 3 — The frontend (`app/`)

The Next.js static-export SPA — see [`app/README.md`](app/README.md). It reads **everything from the
node** (feed / thread / search / profile via PAPI + the runtime read API) — no indexer, no GraphQL.

```bash
cd app
npm install                 # postinstall runs `papi` to generate the typed descriptors
npm run dev                 # dev server on :3000 (points at ws://127.0.0.1:9944 by default)
npm run build               # Next.js static export → app/out/ (host on any static host / IPFS)
```

To iterate on the frontend against the **real, running chain** (not `--dev`), run a local
non-validator tracking node that syncs the real chain over P2P and serves RPC to the dev server —
see [`docs/LOCAL-FRONTEND.md`](docs/LOCAL-FRONTEND.md) (`scripts/fetch-chainspec.mjs` +
`scripts/run-tracking-node.sh`).

**Wallet model — one Cardano wallet does everything, nothing stored.** Connecting a CIP-30 wallet
signs one fixed CIP-8 message; that signature is `blake2b_256`'d into the seed for an sr25519
*posting* key (sign-to-derive — no keystore, no password, re-derived each session). The same wallet
binds identity (a bare, unsigned on-chain CIP-8 self-proof) and locks/reclaims ADA into the
`talk_vault` via **Blockfrost** (set `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID`). The derived key signs
**posts only** and never controls funds.

After a runtime `spec_version` bump, regenerate the PAPI descriptors against a live node:
`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

---

## Deploying on a server (preprod)

For a supervised, always-on deployment, [`deploy/`](deploy/) ships a **single** committed `systemd`
unit (the node is the whole backend) with `Restart=always`, boot persistence, durable `StateDirectory`,
and sandboxing — see [`deploy/README.md`](deploy/README.md) for the full runbook. The bring-up order
and the things that bite:

1. **External Cardano** up and synced: `cardano-node` + read-only **db-sync** (Postgres) at `DBSYNC_URL`.
2. **Chain:** `cogno-chain-cli key gen` + `cogno-chain-node gen-chainspec` to mint your keys + raw
   chainspec, then run your validator with `--state-pruning archive --blocks-pruning archive` (the node
   serves historical reads) plus any tracking nodes for RPC. Put `--base-path` on a real disk (not
   `/tmp`), and keep your `.skey` key files backed up and offline.
3. **Re-capture genesis after any (re)launch.** The genesis hash changes whenever you regenerate the
   spec, on a fresh `--dev`/`--tmp` rebuild, or at a restart. Capture it live (`chain_getBlockHash(0)`)
   and pin it wherever you run `cogno-chain-cli` — its genesis guard refuses the wrong chain.
4. **Federate + operate** with `cogno-chain-cli` from an operator machine (keys by file, off the node
   host): `committee members set` federates the founder seat straight to 3+ by vote (the runtime rejects
   a fault-intolerant 2-seat committee, so jump 1 → 3+ in one motion; `members add`/`remove` adjust an
   already-≥3 set), `validator add` + the new validator's `set-keys` admits producers, and
   `upgrade authorize` (committee) + a permissionless `upgrade apply` (spec-checked) evolves the runtime.
   There is no sudo key.
5. **Ports to open:** P2P `30333` (public); RPC `9944` (behind a proxy if exposed — localhost + `safe`
   by default); Prometheus `9615` (keep on your private scrape network, not public).

The node's Prometheus `/metrics` (chain health + `cogno_observer_*` liveness) has scrape config + alert
rules in [`deploy/monitoring/`](deploy/monitoring/). What still stays **testnet-scoped** (the deeper
mainnet prerequisites, by design): `MinAuthorities = 1`, GRANDPA equivocation as a no-op (no slashing),
an independent CIP-8-verifier audit, a single observer/producer, and — until you split the committee
seats across independent custodians — D2-*shaped* authority. See
[`docs/D2-custody-runbook.md`](docs/D2-custody-runbook.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

### Configuration reference

The env surface is tiny (see [`.env.example`](.env.example)). The node reads **only** `DBSYNC_URL`
(+ optional `RUST_LOG`); the frontend inlines a couple of `NEXT_PUBLIC_*` vars at build; and
`cogno-chain-cli` takes keys **by file**, not env.

| Variable | Default | Used by |
|---|---|---|
| `DBSYNC_URL` | *(read-only Postgres DSN)* | the node's Cardano observer (unset ⇒ abstain, chain still runs) |
| `RUST_LOG` | *(unset)* | node / pallet log filter (optional) |
| `NEXT_PUBLIC_WS_URL` | `ws://127.0.0.1:9944` | frontend (the node JSON-RPC it reads) |
| `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | frontend (the in-browser L1 `talk_vault` lock/exit) |

The node's systemd EnvironmentFile template is
[`deploy/systemd/cogno.env.example`](deploy/systemd/cogno.env.example).

---

## Repo layout

```
cogno-chain/
├─ Cargo.toml / Cargo.lock     # workspace, pinned to stable2606; Cargo.lock committed
├─ rust-toolchain.toml         # channel = 1.93.0; targets = [wasm32v1-none, wasm32-unknown-unknown]
├─ node/                       # cogno-chain-node (Aura + GRANDPA + cardano-observer + read RPC)
├─ runtime/                    # cogno-chain-runtime (#[frame_support::runtime], spec 203 / tx 3)
├─ pallets/                    # microblog, talk-stake, cogno-gate, governed-upgrade, validator-set,
│                              #   cardano-observer, profile, governance-fuel
├─ cli/                        # cogno-chain-cli (all-Rust admin tool; typed RuntimeCall, keys by file)
├─ cogno-dbsync/ cogno-keyfile/ # shared no-node crates (deterministic db-sync reader; key envelope)
├─ contracts/                  # the Aiken L1 `talk_vault` validator (+ audits/)
├─ app/                        # Next.js 16 static-export frontend (PAPI + MeshJS) — see app/README.md
├─ ci/cip8-oracle/             # the independent pycardano CIP-8 verifier (CI adversarial oracle)
├─ deploy/                     # one systemd unit + monitoring (Prometheus/Grafana/Alertmanager)
├─ docs/                       # ARCHITECTURE.md + design deep-dives + operator runbooks
└─ scripts/                    # fetch-chainspec.mjs + run-tracking-node.sh + acceptance/ (headless test)
```

(`_sdk/` — a vendored polkadot-sdk checkout — and `_reference/` are gitignored and omitted above.)

### Pallet indices (on-wire contracts, stable forever)

The chain restarted at a fresh genesis (`fork/all-rust`), so the index map is:

| idx | pallet | idx | pallet |
|---|---|---|---|
| 0 | System | 11 | SkipFeelessPayment (feeless extension) |
| 1 | Timestamp | *12* | *vacant* (Anchor removed) |
| 2 | Aura | 13 | FollowerCommittee (collective `Instance1`, 3-of-5) |
| 3 | Grandpa | 14 | ValidatorSet (mutable Aura/GRANDPA) |
| 4 | Balances | 15 | Session |
| 5 | TransactionPayment | 16 | CardanoObserver (sole weight writer, enforcing) |
| *6* | *vacant* (Sudo removed) | 17 | Profile |
| 7 | GovernedUpgrade (sudo-free upgrades) | 18 | GovernanceFuel (committee-set regenerating admin-fuel budget) |
| 8 | CognoGate (CIP-8 identity gate) | | |
| 9 | TalkStake (observer-written ledger) | | |
| 10 | Microblog (posts + folded capacity) | | |

Indices **6** (Sudo) and **12** (Anchor) are permanently vacant; FRAME allows gaps, so the on-wire
indices never shift. Talk-capacity is **folded into `microblog`** (no separate capacity pallet);
`talk-stake` is a call-less ledger the observer writes and the meter reads.

---

## Development

- **Build & test per layer:** `cargo build --release` / `cargo test --workspace` (node, runtime,
  pallets, cli, `cogno-dbsync`, `cogno-keyfile`); `cd contracts && aiken check`; `cd app && npm run
  lint && npm test` (Vitest). The independent CIP-8 agreement oracle: `cd ci/cip8-oracle && python
  test_beacon.py && python test_agreement.py` (needs `cd app && npm ci` first, for the fixture). All
  four legs are gated in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml): `rust` /
  `contracts` / `frontend` / `cip8-oracle`).
- **Acceptance:** with a `--dev` node, `cd scripts/acceptance && npm install && WS=ws://127.0.0.1:9944
  node acceptance.mjs` (asserts the running chain exposes no sudo / `set_stake` / anchor extrinsic).
- **Encoding discipline:** pallet indices and `transaction_version` are on-wire contracts; bump
  `spec_version` (currently 203) only for encoding-affecting changes and regenerate PAPI descriptors
  afterward.
- **Upgrading a live chain** (adding features, soft vs hard forks, the mixed-validator question,
  storage migrations, enactment): [`docs/UPGRADES.md`](docs/UPGRADES.md).
- **Design:** the system overview is [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the economic
  model, the observation mechanism, and the identity gate have focused deep-dives in [`docs/`](docs/).
- **Contributing:** see [`CONTRIBUTING.md`](CONTRIBUTING.md) for the build/test matrix, the
  branch-per-unit + PR-into-`main` flow, commit conventions, and the gotchas that bite (live contract
  hash, nvm-vs-snap node, committee-not-sudo, the rustc pin). Please also read
  [`SECURITY.md`](SECURITY.md) before reporting a vulnerability.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Third-party code reused or reimplemented
in this repository (the Polkadot SDK templates, the partner-chains consensus primitives, and the
`substrate-validator-set` fork — all Apache-2.0) is attributed in [`NOTICE`](NOTICE).
