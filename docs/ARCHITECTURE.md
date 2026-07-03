# cogno-chain — Architecture

A single, current overview of the whole system. It replaces the older layered design specs
(`L1`–`L5`) and the frontend spec, which were build-era design documents; their detail now lives in
the code and in the focused per-mechanism docs linked below. For the *why* behind the big choices see
[`DECISION-REGISTER.md`](DECISION-REGISTER.md).

## What it is

cogno-chain is a Polkadot-SDK (Substrate) **app-chain** for a *feeless* "post text / read text" social
app. There are no per-post fees. The right to post is metered by a regenerating, stake-weighted
**talk-capacity** that an account earns by locking ADA in a Cardano L1 contract.

Cardano is **observed, not bridged**. It supplies three things and holds no custody of chain state:

1. **Identity** — a 1:1 binding between a Cardano address (proved by a CIP-8 signature) and a posting
   account (anti-Sybil; see [`TRUSTLESS-IDENTITY.md`](TRUSTLESS-IDENTITY.md)).
2. **Weight** — the amount of ADA locked in the `talk_vault` contract becomes an account's posting
   power; the total stake behind the bound credential becomes its voting power.
3. **A deterministic clock** — each block header seals the hash of a stable, finalized Cardano block
   (the `cobs` header seal), so every node reduces the same Cardano state at the same point.

The chain inherits **none** of Cardano's finality or security. Its safety is its own operator-run
**Aura** (block production) + **GRANDPA** (finality). It is **observe-only**: there is no bridge, no
message passing, and (since the all-Rust restart) no metadata anchoring back to Cardano.

## Trust posture

- **Sudo-free from genesis.** There is no `pallet-sudo`. Every privileged call is authorized by a
  3-of-5 **committee** (`pallet-collective`, `FollowerCommittee`), which exists from block 0 and
  federates outward by vote (it can start as a single seat and add more). The committee is
  self-policing and brick-guarded (a motion that would empty it is rejected).
- **Runtime upgrades are governed, not root.** `pallet-governed-upgrade` lets the committee authorize
  a code hash; anyone may then submit the matching WASM, which the runtime enacts only if the spec
  version increases. `frame_system::set_code`/`set_storage` are unreachable by design.
- **The observer is the sole writer of weight.** Weight enters the chain *only* through the
  `cardano-observer` inherent — a consensus-verified reduction of db-sync state. There is no trusted
  `set_stake` extrinsic. Enforcement is on from genesis.
- **Determinism is the safety boundary.** Cardano is read **exclusively** through db-sync, byte-for-byte
  identically across the node and the CLI. A divergence between two readers is a **chain fork**, so the
  read is pinned by a golden fixture (see [Observation](#observation-cardano--weight)).
- **Not yet trustless.** With a single operator-run producer this is *D4-shaped*, not trustless. The
  graduation to a trust-minimized set needs ≥3 independent block producers; until then the honest label
  is "usable, operator-run, observe-only." Mainnet prerequisites (`MinAuthorities` floor, GRANDPA
  equivocation reporting, an independent audit of the CIP-8 verifier) are left in the source as
  `MAINNET PREREQUISITE` comments — deliberately scoped out, not bugs.

## Repository layout

```
node/            cogno-chain-node — the Aura+GRANDPA node + the cobs header-seal proposer
runtime/         cogno-chain-runtime — #[frame_support::runtime], spec_version 200 / tx_version 3
pallets/         microblog, talk-stake, cogno-gate, profile, validator-set,
                 cardano-observer, governed-upgrade
cli/             cogno-chain-cli — the all-Rust admin CLI (typed calls, keys-by-file)
cogno-dbsync/    shared crate: the deterministic db-sync reader + Cardano-state reduction
cogno-keyfile/   shared crate: the cardano-cli-style JSON key envelope
contracts/       the Aiken (Plutus V3) L1 talk_vault validator — LIVE on preprod (never move its hash)
app/             Next.js 14 static-export frontend (PAPI + MeshJS)
ci/cip8-oracle/  an independent Python CIP-8 verifier, kept as a CI adversarial oracle
deploy/          systemd unit + monitoring (Prometheus/Grafana/Alertmanager)
docs/            this file + the per-mechanism docs + operator runbooks
```

The backend is **all-Rust**: two binaries (`cogno-chain-node`, `cogno-chain-cli`) plus two shared
no-node crates. The frontend is the only non-Rust surface. There are no off-chain services.

## The pallets (on-wire indices — never renumber)

| idx | pallet | role |
|----|--------|------|
| 0–5 | System, Timestamp, Aura, Grandpa, Balances, TransactionPayment | the Substrate spine |
| 6 | *(vacant)* | Sudo removed |
| 7 | **GovernedUpgrade** | committee-authorized runtime upgrades (no root) |
| 8 | **CognoGate** | CIP-8 1:1 identity: `owner-Address ↔ account`, on-chain verify (`cip8.rs`) |
| 9 | **TalkStake** | the observer-written weight ledger (`AllowedStake`, `VotingPower`) — call-less |
| 10 | **Microblog** | posts + folded talk-capacity + social (votes/polls/reposts/quotes/follows) + the node read API |
| 11 | SkipFeelessPayment | the tx-extension that makes metered social calls feeless |
| 12 | *(vacant)* | Anchor removed |
| 13 | **FollowerCommittee** | `pallet-collective<Instance1>` — the 3-of-5 authority origin |
| 14 | **ValidatorSet** | mutable Aura+GRANDPA authorities (session-boundary add/remove) |
| 15 | Session | authority-set rotation |
| 16 | **CardanoObserver** | the in-protocol Cardano-weight observation inherent (sole weight writer, enforcing) |
| 17 | **Profile** | display name / bio / avatar / banner / pinned — feeless, capacity-metered |

## L1 — the Cardano `talk_vault` (observed, never bridged)

`contracts/` holds an Aiken (Plutus V3) validator. A user locks ADA at the vault, committing their
posting account and identity in the datum; the vault also mints a **beacon** token whose name is
`blake2b_256(cbor(owner))` — the identity hash. The lock is the account's posting deposit + weight
source; exiting burns the beacon and releases the ADA.

**The contract is LIVE on preprod. Never move its hash.** Any production edit under `contracts/`
recompiles the script and moves the blueprint hash, orphaning the deployed vault. After any change,
`git diff` the `hash` fields in `plutus.json` / `vault.json` and confirm they are unchanged. Contract
logging is off-limits while live (even a `trace` line bakes into the script and moves the hash).

## Observation — Cardano → weight

The `cardano-observer` inherent is the **only** thing that writes weight. Every node runs the same
reduction over the same Cardano state and must produce the same result:

- **db-sync is the only source.** Both the node (writer, in its inherent-data provider) and the CLI
  (`query weight --dbsync`, a read-only cross-check) go through the `cogno-dbsync` crate, byte-for-byte
  identically. Ogmios still *submits* L1 transactions and serves cost models; the in-browser wallet uses
  Blockfrost — but consensus-critical reads are db-sync only.
- **Byte-identity invariants** (a divergence is a fork; pinned by a golden fixture in `cogno-dbsync`):
  spentness from `tx_in` (never the denormalized `consumed_by_tx_id`); coin/quantity amounts as `::text`
  (lovelace exceeds 2⁵³); the vault set driven from `tx_out.payment_cred = <script hash>`; a fail-closed
  abstain when `tx_in` is absent (so a pruned/wrong-mode db-sync never reports a spent vault as locked);
  largest-UTxO-wins per identity (never summed).
- **Enforcement is on from genesis** on preprod/mainnet; dev/local presets genesis-seed weight because
  they have no Cardano to observe.

Full detail: [`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md). db-sync must run FULL
(non-pruned), `tx_in`-enabled (not `--consumed-tx-out`), and — for mainnet — over TLS.

## L3 — the runtime & consensus

- **Consensus:** Aura produces blocks, GRANDPA finalizes. The authority set is **mutable**
  (`pallet-session` + a forked `pallet-validator-set`): the committee adds/removes producers at session
  boundaries. At low authority counts GRANDPA finality is fragile by design — the honest floor is a
  documented prerequisite, and `MinAuthorities` is left low for testnet.
- **The `cobs` header seal:** `node/src/consensus/` is a custom block proposer (a reimplemented,
  Apache-2.0 partner-chains `PartnerChainsProposerFactory` + `InherentDigest`) that seals the stable,
  finalized Cardano block anchor into each header as a `cobs` PreRuntime digest. This is what makes the
  observation deterministic; it is **not** the (removed) metadata-anchoring.
- **Fee model:** the social hot path is feeless and metered by talk-capacity via the `CheckCapacity`
  transaction extension (slot 9) + `SkipFeelessPayment`. Governance calls stay ordinary fee-bearing; the
  operator genesis endows the committee seats + validators so they can pay. See
  [`ECONOMICS.md`](ECONOMICS.md).

## Reads — folded into the node

There is no external indexer. The runtime exposes a `MicroblogApi` (an `sp_api` read API served over
`state_call`) that returns enriched, viewer-aware feed / thread / profile / search / people / replies
pages in one call, plus poll tallies, follow edges, and identity resolution. Bounded linear scans are
fine here because these run off-chain (not block-weight-metered). Design + the graduation path to a
node-side `tantivy` index: [`SCALE-NODE-READS.md`](SCALE-NODE-READS.md).

## The frontend

`app/` is a Next.js 14 **static export**. It reads and writes the chain node-direct through PAPI
(reads via `MicroblogApi`, writes as ordinary or bare-unsigned extrinsics — CIP-8 binds are bare, the
proof is the authorization). It uses MeshJS for the CIP-30 browser wallet and the L1 `talk_vault`
lock/exit (Cardano txs submitted via Blockfrost, with live Ogmios cost models). It is the only
non-Rust surface and holds no privileged keys.

Build/run this against a real chain: [`LOCAL-FRONTEND.md`](LOCAL-FRONTEND.md).

## The CLI

`cogno-chain-cli` is the all-Rust admin tool: typed `RuntimeCall` constructors only (so `set_stake`,
sudo, `set_code`, and anchor calls **cannot be built** — a compile-time boundary), keys by file path,
the committee lifecycle (propose / vote / close over `FollowerCommittee`), bare identity binds, and
`query state` / `query weight --dbsync` (the read-only observation cross-check). The node grows the
matching operator subcommands: `gen-chainspec` (operator-keyed, refuses dev keys), `key insert-file`,
and `config_check`.

## Operating it

- Bring up a fresh chain: [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md).
- Run a tracking / relay node: [`RELAY-NODE.md`](RELAY-NODE.md).
- Upgrade a running chain (committee-authorized): [`UPGRADES.md`](UPGRADES.md).
- Committee custody / rotation / audit: [`D2-custody-runbook.md`](D2-custody-runbook.md).
- Deployment (systemd + monitoring): [`../deploy/README.md`](../deploy/README.md).

## Toolchain

Pinned to **rustc 1.90.0** (`rust-toolchain.toml`) — stable ≥ ~1.91 breaks the `sp_io` wasm link. The
frontend uses **nvm node v22.12.0** (the snap node writes stdout to `/dev/null`, and MeshJS's
`core-cst` redirects stdio). Encoding-affecting runtime changes bump `spec_version` and require
regenerating the PAPI descriptors.
