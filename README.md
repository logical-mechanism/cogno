# cogno-chain

**A feeless, Twitter-style social chain.** Post text, read text — with no per-post fees. Instead of
paying for each post, you earn a regenerating **talk-capacity** by locking ADA in a Cardano smart
contract. Cardano is *observed, not bridged*: it supplies your identity (a CIP-8 wallet signature),
your weight (locked ADA + stake), and a block clock — but nothing is ever written back to it, and the
chain runs its own consensus.

Built on the Polkadot SDK (Substrate). It succeeds the Cardano-native forum *Cogno*, which grew too
expensive at volume (per-post L1 fees + min-ADA-per-byte); cogno-chain moves posts onto cheap feeless
blockspace and swaps fees for a capacity meter.

<!-- TODO(website): screenshot / GIF of the app + the hosted preprod URL, once the site is live. -->

## Start here

- **Just want to try it?** Run a tracking node against the live preprod chain, then point the app at
  it: [docs/RELAY-NODE.md](docs/RELAY-NODE.md) → [docs/LOCAL-FRONTEND.md](docs/LOCAL-FRONTEND.md).
  *(A hosted site is coming — until then, this is the way in.)*
- **Want to run your own node or network?** [docs/PREPROD-BRINGUP.md](docs/PREPROD-BRINGUP.md).
- **Want to understand how it works?** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **Want to contribute?** [CONTRIBUTING.md](CONTRIBUTING.md).

## What you're trusting

This is a permissioned, operator-run testnet, and it's honest about that:

- **Consensus is its own proof-of-authority.** Blocks are produced by **Aura** and finalized by
  **GRANDPA** over a validator set the operator runs. The chain borrows *none* of Cardano's security.
- **Weight is observed in-protocol, not set by hand.** Each block, the node reads locked ADA + stake
  from a read-only Cardano **db-sync** and credits your talk-capacity. There is no admin "set weight"
  call — the observer is the sole writer, and every node re-derives the same result deterministically.
- **There is no sudo.** Every privileged action (adding validators, runtime upgrades, moderation) goes
  through a **3-of-5 committee** that exists from the first block and can federate out by vote.
- **Your keys, your genesis.** No well-known dev keys anywhere outside the local `--dev` quick-start.

With a single operator running everything, it is trust-*minimized*, not trustless. The remaining
hardening for a real network — more independent producers, GRANDPA equivocation slashing, an
independent audit of the CIP-8 verifier, and split key custody — is deliberately deferred and flagged
`MAINNET PREREQUISITE` in the source. The full trust posture, including the D-rung ladder, is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Architecture

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

The node is the **whole backend** — one binary. It authors and finalizes blocks, runs the Cardano
observer in-protocol, and serves every read (feed / thread / search / profile) from its own runtime
API. `cogno-chain-cli` is a separate, run-anywhere admin tool (keys by file) — not a service. There is
no follower, relayer, or indexer. Two node roles:

- **Validator node** (`--validator`) — authors blocks and votes finality when it holds session keys.
- **Tracking node** (omit `--validator`) — syncs the chain and serves RPC, but never authors or votes.
  Use these as RPC endpoints for the frontend and to scale reads.

## Prerequisites

**To build the node** (Debian/Ubuntu):

```bash
sudo apt-get update && sudo apt-get install -y \
  clang llvm-dev libclang-dev protobuf-compiler cmake libssl-dev pkg-config make build-essential
```

> `llvm-dev` + `libclang-dev` are required by `bindgen`/`librocksdb-sys`; without them the build fails
> with an `llvm-config` error. If your distro ships only versioned names (e.g. `llvm-config-18`), either
> symlink it (`sudo ln -sf "$(ls /usr/bin/llvm-config-* | sort -V | tail -1)" /usr/bin/llvm-config`) or
> set `LLVM_CONFIG_PATH`.

Rust is pinned by [`rust-toolchain.toml`](rust-toolchain.toml) to **`1.93.0`** — `cargo build`
auto-selects it, so just have `rustup` installed. Don't roll to plain `stable`: stay on the toolchain
the pinned SDK release (polkadot-sdk `stable2606`) is verified against. `Cargo.lock` is committed —
don't regenerate it.

**To run the rest of the stack** (only what you use):

| Component | Needs |
|---|---|
| Frontend + the CIP-8 CI oracle | **Node v22.12.0 via nvm** — *not* the snap `node` (its stdout is `/dev/null` and `@meshsdk/core-cst` redirects stdio). Prepend `~/.nvm/versions/node/v22.12.0/bin` to `PATH`. |
| CIP-8 oracle (CI only) | Python 3.12 with `pycardano` (`ci/cip8-oracle/`) |
| Contracts (only to rebuild) | **Aiken** `v1.1.22` |
| Cardano integration | a synced preprod **`cardano-node`** + read-only **db-sync** for the observer; **Ogmios** (:1337) + a **Blockfrost** preprod project id for the frontend's L1 lock/exit |

## Build

```bash
cargo build --release            # heavy first compile; produces ./target/release/cogno-chain-node
cargo test --workspace           # pallet + crate tests
```

> Build **clean** (default features). A `--features runtime-benchmarks` build produces a runtime a
> normal node can't execute, and the chain spec embeds the runtime — so always generate the spec with
> the same clean binary you run.

## Run the chain

### Local quick-start (throwaway)

```bash
./target/release/cogno-chain-node run --dev      # one //Alice authority, WS :9944
```

`--dev` is an ephemeral single-node chain on well-known dev keys (single-seat `//Alice` committee,
`--force-authoring`). State and genesis are thrown away on restart — use it for local development only.

### A real network

Your own keys, your own genesis, one validator to start (the set grows by on-chain vote), plus any
tracking nodes. The full, copy-pasteable runbook lives in the operator docs — this repo does not make
you reconstruct it from the README:

- **[docs/PREPROD-BRINGUP.md](docs/PREPROD-BRINGUP.md)** — mint keys, generate a genesis, run the boot
  validator, and federate out (seat the committee, admit validators) via `cogno-chain-cli`.
- **[deploy/README.md](deploy/README.md)** — the always-on server runbook (systemd, key custody,
  backups, monitoring).
- **[docs/UPGRADES.md](docs/UPGRADES.md)** — ship new runtime code to a live chain (sudo-free, two
  commands).

Ports: **P2P 30333** (`--port`), **JSON-RPC 9944** (`--rpc-port`, both WS and HTTP — localhost + `safe`
by default; put a filtering proxy in front before exposing it), **Prometheus 9615** (keep private).

### Configuration

The env surface is tiny (see [`.env.example`](.env.example)). The node reads only `DBSYNC_URL`; the
frontend inlines two `NEXT_PUBLIC_*` vars at build; `cogno-chain-cli` takes keys **by file**, not env.

| Variable | Default | Used by |
|---|---|---|
| `DBSYNC_URL` | *(read-only Postgres DSN)* | the node's Cardano observer (unset ⇒ abstain, chain still runs) |
| `RUST_LOG` | *(unset)* | node / pallet log filter (optional) |
| `NEXT_PUBLIC_WS_URL` | `ws://127.0.0.1:9944` | frontend (the node JSON-RPC it reads) |
| `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | frontend (the in-browser L1 `talk_vault` lock/exit) |

## Run the Cardano integration

This turns the standalone chain into the full ADA-metered app. The external Cardano stack must be up
and synced first; there are no off-chain services to run — the node observes Cardano itself.

- **db-sync (the node's only Cardano dependency).** The observer reads a read-only db-sync Postgres at
  `DBSYNC_URL` — a deterministic block reference + the vault UTxO reads. Unset ⇒ the observer abstains
  and the chain still runs. *`MAINNET PREREQUISITE`: db-sync FULL (non-pruned), `tx_in`-enabled (NOT
  `--consumed-tx-out`), over TLS.*
- **The L1 contract (`contracts/`).** The Aiken (Plutus V3) `talk_vault` is an owner-reclaimable ADA
  vault marked by a per-user beacon NFT. It is **already deployed on preprod** — only rebuild it if you
  change the validator.

  > ⚠ Any production edit under `contracts/` **moves the script hash** (currently blueprint
  > `49ffbfc6…`, applied vault `168a9710…`) and **orphans the deployed vault**. `git diff` the `hash`
  > fields in `plutus.json`/`vault.json` after any contracts change. See
  > [`contracts/README.md`](contracts/README.md).

- **The frontend (`app/`).** The Next.js static-export SPA reads everything from the node and reaches
  Cardano via **Ogmios** (cost models + tx submit) and **Blockfrost** (in-browser CIP-30 vault
  lock/exit). See [`app/README.md`](app/README.md).

  ```bash
  cd app
  npm install                 # postinstall runs `papi` to generate the typed descriptors
  npm run dev                 # dev server on :3000 (points at ws://127.0.0.1:9944 by default)
  npm run build               # Next.js static export → app/out/ (host on any static host / IPFS)
  ```

  **Wallet model — one Cardano wallet does everything, nothing stored.** Connecting a CIP-30 wallet
  signs one fixed CIP-8 message; that signature is hashed into the seed for an sr25519 *posting* key
  (re-derived each session — no keystore, no password). The same wallet binds identity and locks/reclaims
  ADA in the `talk_vault`. The derived key signs **posts only** and never controls funds.

## Repo layout

```
cogno-chain/
├─ node/         # cogno-chain-node (Aura + GRANDPA + cardano-observer + read RPC)
├─ runtime/      # cogno-chain-runtime (#[frame_support::runtime], spec 203 / tx 3)
├─ pallets/      # microblog, talk-stake, cogno-gate, governed-upgrade, validator-set,
│                #   cardano-observer, profile, governance-fuel
├─ cli/          # cogno-chain-cli (all-Rust admin tool; typed RuntimeCall, keys by file)
├─ cogno-dbsync/ cogno-keyfile/   # shared no-node crates (db-sync reader; key envelope)
├─ contracts/    # the Aiken L1 `talk_vault` validator (+ audits/)
├─ app/          # Next.js 16 static-export frontend (PAPI + MeshJS) — see app/README.md
├─ ci/cip8-oracle/   # the independent pycardano CIP-8 verifier (CI adversarial oracle)
├─ deploy/       # one systemd unit + monitoring (Prometheus/Grafana/Alertmanager)
├─ docs/         # start at docs/README.md
└─ chainspecs/   # committed raw chain spec for joining the live preprod chain
```

### Pallet indices (on-wire contracts, stable forever)

| idx | pallet | idx | pallet |
|---|---|---|---|
| 0 | System | 11 | SkipFeelessPayment |
| 1 | Timestamp | *12* | *vacant* (Anchor removed) |
| 2 | Aura | 13 | FollowerCommittee (3-of-5) |
| 3 | Grandpa | 14 | ValidatorSet |
| 4 | Balances | 15 | Session |
| 5 | TransactionPayment | 16 | CardanoObserver (sole weight writer) |
| *6* | *vacant* (Sudo removed) | 17 | Profile |
| 7 | GovernedUpgrade | 18 | GovernanceFuel |
| 8 | CognoGate (CIP-8 identity) | | |
| 9 | TalkStake (observer-written ledger) | | |
| 10 | Microblog (posts + capacity) | | |

Indices **6** (Sudo) and **12** (Anchor) are permanently vacant — FRAME allows gaps, so on-wire indices
never shift. A new pallet always takes a new index.

## Development

- **Build & test per layer:** `cargo test --workspace`; `cd contracts && aiken check`; `cd app && npm
  run lint && npm test`. The independent CIP-8 oracle: `cd ci/cip8-oracle && python test_beacon.py &&
  python test_agreement.py`. All four legs are gated in CI
  ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).
- **Encoding discipline:** pallet indices and `transaction_version` are on-wire contracts. Bump
  `spec_version` (currently 203) only for encoding-affecting changes, and regenerate PAPI descriptors
  afterward. See [docs/UPGRADES.md](docs/UPGRADES.md).
- **Contributing:** [CONTRIBUTING.md](CONTRIBUTING.md) has the build/test matrix, the branch-per-unit +
  PR-into-`main` flow, commit conventions, and the gotchas that bite (live contract hash, nvm-vs-snap
  node, committee-not-sudo, the rustc pin). Read [SECURITY.md](SECURITY.md) before reporting a
  vulnerability.

## License

Licensed under the [Apache License, Version 2.0](LICENSE). Reused/reimplemented third-party code (the
Polkadot SDK templates, the partner-chains consensus primitives, and the `substrate-validator-set`
fork — all Apache-2.0) is attributed in [`NOTICE`](NOTICE).
