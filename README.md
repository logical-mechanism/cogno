# cogno-chain

A Polkadot-SDK Substrate **solochain** for a *feeless* "post text / read text" social app,
with **Cardano observed (not bridged)** as an information oracle. Posting is feeless; a
regenerating, stake-weighted **"talk capacity"** — earned by parking ADA in a Cardano vault —
is the rate-limit instead of per-post fees.

> **Why:** the prior Cardano-native forum **Cogno** (`logicalmechanism/cogno_v3`) became too
> expensive at volume (per-post L1 fees + min-ADA-per-byte). cogno-chain moves posts onto cheap
> feeless blockspace and replaces fees with a Hive-RC / Midnight-DUST-style capacity meter.

The full architecture (L1 Cardano vault+beacon → L2 follower → L3 runtime → L4 reads → L5
frontend) is designed in [`PLAN.md`](PLAN.md), [`ECONOMICS.md`](ECONOMICS.md), and
[`docs/`](docs/). **Every cross-layer decision is settled in the canonical
[`docs/DECISION-REGISTER.md`](docs/DECISION-REGISTER.md).**

---

## Status: milestone M0 — solochain stands up, plain text posting, NO Cardano

M0 forks the polkadot-sdk solochain template and adds a minimal `pallet-microblog` (plain
posting; **no** identity gate, **no** talk-capacity, **no** feeless extension — those arrive in
M2/M2c/M2d). See [`docs/M0-build.md`](docs/M0-build.md) for the build log, the pinned SDK
(DR-03), and acceptance results.

**Pinned upstream (DR-03):** polkadot-sdk **`polkadot-stable2603-3`**
(commit `e3737178ec726cffe506c907263aaaa417893fd0`); toolchain `channel = "stable"`; wasm runtime
target `wasm32-unknown-unknown`.

### Repo layout (M0)

```
cogno-chain/
├─ Cargo.toml              # workspace; deps pinned to stable2603-3 crates.io versions
├─ Cargo.lock              # committed (pins the full closure, incl. yanked core2 0.4.0)
├─ rust-toolchain.toml     # channel = stable; targets = [wasm32-unknown-unknown]
├─ node/                   # cogno-chain-node (forked solochain-template-node; Aura + GRANDPA)
├─ runtime/                # cogno-chain-runtime  (#[frame_support::runtime])
├─ pallets/
│  ├─ microblog/           # pallet-microblog — Posts/NextPostId(u64)/ByAuthor; index 10
│  ├─ cogno-gate/          # pallet-cogno-gate — CIP-8 identity gate; index 8
│  ├─ talk-stake/          # pallet-talk-stake — Cardano-sourced weight; index 9
│  ├─ anchor/              # pallet-anchor — Tier-A Cardano anchor; index 12
│  └─ validator-set/       # pallet-validator-set — mutable Aura/GRANDPA; index 14
└─ scripts/acceptance/     # headless @polkadot/api M0 acceptance test
```

Pallet indices (on-wire contracts, stable forever): System(0) Timestamp(1) Aura(2) Grandpa(3)
Balances(4) TransactionPayment(5) Sudo(6) — **CognoGate(8) TalkStake(9) Microblog(10)**
SkipFeelessPayment(11) Anchor(12) FollowerCommittee(13) ValidatorSet(14) Session(15). Index 7 is
vacant: the stock `pallet-template` scaffold was dropped in M7 (spec 107); FRAME allows index gaps,
so the on-wire indices never shift.

## Build & run

```bash
# System deps (Debian/Ubuntu):
sudo apt-get update && sudo apt-get install -y \
  clang protobuf-compiler cmake libssl-dev pkg-config make build-essential

# Build the node (heavy first compile):
cargo build --release -p cogno-chain-node

# Run a dev chain (Alice/Bob Aura authorities, Alice = sudo, WS :9944):
./target/release/cogno-chain-node --dev
```

## Acceptance test (M0 done-when)

With a `--dev` node running on `ws://127.0.0.1:9944`:

```bash
cd scripts/acceptance && npm install && WS=ws://127.0.0.1:9944 node acceptance.mjs
```

It submits a signed `Microblog.post_message`, confirms `PostCreated` + reads it back from
`Posts`, then `delete_post` and confirms removal. Unit tests: `cargo test -p pallet-microblog`.
