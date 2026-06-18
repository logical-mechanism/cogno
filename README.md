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
frontend) is designed in [`docs/PLAN.md`](docs/PLAN.md) and [`docs/ECONOMICS.md`](docs/ECONOMICS.md);
what was actually built is logged per-milestone in [`docs/M*-build.md`](docs/). The full L1–L5
design notes, the [`DECISION-REGISTER.md`](docs/DECISION-REGISTER.md), and these two specs now all
live under [`docs/`](docs/) — they were the guide for *building* the chain; this README describes
what now *exists*.

---

## Status: implemented through M10 (runtime spec_version 107, transaction_version 2)

All ten milestones are merged to `main` and — where applicable — proven live on Cardano
**preprod**. M0–M8 each have a per-milestone build log in [`docs/`](docs/); the last two milestones
**hardened what already existed** rather than adding features, so they have no `docs/M*-build.md`
log (M9's record is the remediation plan it executed, [`docs/PRODUCTION-HARDENING.md`](docs/PRODUCTION-HARDENING.md);
M10 is its merged PR).

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
| **M8** | `talk_vault` relaunch (audit-fix hash move) + CIP-30 wallet lock/exit + **sign-to-derive posting key** (no keystore) | [`M8-relaunch.md`](docs/M8-relaunch.md) |
| **M9** | production-hardening of the off-chain services + pallets/runtime/node + indexer (no spec bump) | [`PRODUCTION-HARDENING.md`](docs/PRODUCTION-HARDENING.md) |
| **M10** | repo-wide tests + `log::` failure-path diagnostics — pallets, services, contracts, frontend Vitest (no spec bump) | PR #7 `m10-test-logging` |

**M9 (production-hardening, PR #6).** A risk-first review + remediation of the *in-between* layers
(off-chain follower/committee/relayer, pallets/runtime/node, indexer; contracts and frontend were
out of scope). Real fixes: a relayer fund-burn (a failed committee ack used to re-mint a *paid*
Cardano tx every retry), follower Cardano-network-id pin + bounded nonce cache + RPC retries, a
bounded validator set (`MaxValidators = 32`) + `MaxStakeWeight` ceiling, `anchor_ack` monotonicity
(regressions rejected), committee finalize-on-revert detection, and an indexer halt-on-error policy.
It changed no runtime encoding, so the runtime stays spec 107 / tx 2; testnet shortcuts (the GRANDPA
equivocation NO-OP, `MinAuthorities = 1`, dev-key custody) are left in place as documented
`MAINNET PREREQUISITE` notes.

**M10 (test + logging, PR #7).** A repo-wide test-coverage and structured-logging pass — see
[Testing & CI](#testing--ci). Purely additive (no new Events, no weight/storage change, **no spec
bump**); the live contract blueprint hash `49ffbfc6…` was deliberately preserved.

**Pinned upstream (DR-03):** polkadot-sdk **`polkadot-stable2603-3`**
(commit `e3737178ec726cffe506c907263aaaa417893fd0`). `rust-toolchain.toml` pins
**`channel = "1.90.0"`** directly — *not* rolling `stable` — because current stable (1.96) breaks
the `sp_io` wasm link; `targets = ["wasm32v1-none", "wasm32-unknown-unknown"]` (wasm-builder prefers
`wasm32v1-none`).

### Repo layout

```
cogno-chain/
├─ Cargo.toml / Cargo.lock     # workspace, pinned to stable2603-3; Cargo.lock committed
├─ rust-toolchain.toml         # channel = 1.90.0; targets = [wasm32v1-none, wasm32-unknown-unknown]
├─ node/                       # cogno-chain-node (Aura + GRANDPA)
├─ runtime/                    # cogno-chain-runtime (#[frame_support::runtime], spec 107)
├─ pallets/                    # microblog, cogno-gate, talk-stake, anchor, validator-set
├─ contracts/                  # the Aiken L1 `talk_vault` validator (+ audits/)
├─ app/                        # Next.js 14 static-export frontend (PAPI + MeshJS)  — see app/README.md
├─ services/                   # cogno-follower · anchor-relayer · committee · indexer · _shared
├─ docs/                       # PLAN + ECONOMICS + L1–L5 design + DECISION-REGISTER + M*-build logs
└─ scripts/acceptance/         # headless @polkadot/api M0 acceptance test
```

(`_sdk/` — a vendored polkadot-sdk checkout — is gitignored and intentionally omitted above.)

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
allows index gaps, so the on-wire indices never shift. M9 added on-chain bounds inside these
pallets (validator-set `BoundedVec<_, MaxValidators(32)>`, talk-stake `MaxStakeWeight`, `anchor_ack`
monotonicity, symmetric cogno-gate bind/revoke refcounting) and M10 added `log::` diagnostics on
their error paths — both **encoding-neutral**, which is why the spec stayed at 107.

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

# Run a dev chain (single //Alice Aura/GRANDPA authority, Alice = sudo, //Alice..//Eve dev
# committee so the 3-of-5 path is drivable, WS :9944):
./target/release/cogno-chain-node --dev
```

`--dev` seats one genesis authority (`//Alice`); two authorities (`//Alice` + `//Bob`) is the
`--chain local` preset, and more can be onboarded at runtime via `add_validator`. Acceptance (M0):
with a `--dev` node on `ws://127.0.0.1:9944`,
`cd scripts/acceptance && npm install && WS=ws://127.0.0.1:9944 node acceptance.mjs`. Pallet unit
tests: `cargo test` (anchor · cogno-gate · microblog · talk-stake · validator-set) — see
[Testing & CI](#testing--ci) for the other layers.

### 2. The L1 contract (`contracts/`)

The Aiken (Plutus V3) `talk_vault` — an owner-reclaimable ADA vault marked by a per-user beacon
NFT (`policy_id == this validator's own hash`; beacon `token_name = blake2b_256(cbor.serialise(
owner Address))` = the app-chain identity hash). See [`contracts/README.md`](contracts/README.md)
for the trust model and the creator footguns.

```bash
cd contracts
aiken check                          # 46 tests / 739 checks (incl. 7 property/fuzz, 100 samples each)
aiken build                          # regenerates plutus.json (the blueprint + hash)
node scripts/regen-vault.mjs         # regenerates contracts/vault.json (applied hash + CBOR)
aiken bench                          # 4 budget baselines (spend top-up/exit, mint, burn)
```

Run `regen-vault.mjs` after any `aiken build` that changes the validator: it applies
`min_lock` (100 ADA = 100000000 lovelace) and writes `vault.json` (the applied vault hash + CBOR)
that the MeshJS lock/exit scripts and the follower/committee services consume. Changing the
validator **moves the script hash** and orphans any deployed vault (it must be exited under the old
hash and re-minted under the new) — this is exactly what the M8 audit fix did (blueprint
`49ffbfc6…`, applied `168a9710…`). The M10 test pass deliberately stayed **tests-only** (it grew
the suite 38 → 46 but left the production validator and `plutus.json` untouched) precisely so the
blueprint hash `49ffbfc6…` — and the live preprod vault — were preserved. Full audit in
[`contracts/audits/`](contracts/audits/).

### 3. The frontend (`app/`)

The "Reading Room / Civic Ledger" SPA — see [`app/README.md`](app/README.md) for the full config
surface. **Use the nvm node, not the snap node** (`node` here is a snap build whose stdout is
`/dev/null`): prepend `~/.nvm/versions/node/v22.12.0/bin` to `PATH`.

```bash
cd app
npm install                 # postinstall runs `papi` to generate the typed descriptors
npm run dev                 # dev server on :3000, points at ws://127.0.0.1:9944 by default
npm run build               # Next.js static export → app/out/ (self-hostable on any static host)
npm test                    # Vitest pure-logic unit suite (node env, MeshJS/PAPI mocked) — M10
```

After a runtime `spec_version` bump, regenerate the PAPI descriptors against a live node:
`rm .papi/descriptors/generated.json && npx papi add cogno -w ws://127.0.0.1:9944`.

**One Cardano wallet does everything**, with nothing stored on disk:

- **Posting key — sign-to-derive, no keystore.** Connecting a CIP-30 wallet (Eternl/Lace/…) has it
  sign **one** fixed, domain-separated CIP-8 message; that signature is deterministic Ed25519,
  `blake2b_256`'d into the seed for an sr25519 *posting* key (`app/src/lib/signer/wallet-derive.ts`).
  Same wallet ⇒ same posting account, re-derived each session by signing again — **no mnemonic, no
  password, no second wallet, nothing to back up.** The derived key signs **posts only** and never
  controls funds, so a phished posting key means impersonation (revoke + re-derive), never theft.
  *(An earlier PBKDF2 → AES-GCM keystore was built and then superseded within M8.)*
- **Identity bind (M2):** the same wallet signs the CIP-8 bind once to register the posting key 1:1.
- **Talk-capacity (M8 / CIP-30 lock-exit):** lock ADA into / reclaim ADA from the `talk_vault`
  straight from the browser wallet via **Blockfrost** — set a preprod project id in the About panel
  or `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID`.

The UI is consumer-shaped: a single Account widget drives all three, with advanced config (Blockfrost
id, endpoints) tucked behind an About panel and `//Alice…//Eve` dev signers kept as a testing
fallback.

### 4. The services (`services/`)

Each has its own README; one line each here. All the Node services use the nvm node v22.12.0; the
Python follower uses its pinned `pycardano` venv. M9 production-hardened all four; M10 added test
suites + structured logging.

- **cogno-follower** (`services/cogno-follower`, HTTP **:8090**) — the Cardano READ link. A Python
  CIP-8 verifier (`pycardano`) that turns a wallet signature into the 1:1 identity binding, then
  observes the `talk_vault` UTxO and writes the Cardano-sourced weight. Start: `./run.sh`. *M9:*
  pinned the recovered address to the configured Cardano network (`CARDANO_NETWORK`), bounded the
  nonce cache, added RPC retries. See [`services/cogno-follower/README.md`](services/cogno-follower/README.md).
- **anchor-relayer** (`services/anchor-relayer`) — the Cardano WRITE link. Every `ANCHOR_EVERY`
  finalized blocks it writes that block's finalized post-state root onto Cardano as a metadata tx,
  then `anchor_ack`s it back (evidence, not enforcement) — **through the 3-of-5 committee by
  default** (`ANCHOR_VIA=committee`; `sudo` is the dev fallback). Start: `node relayer.mjs` (`--once`
  for a single anchor, `--reack-last` to re-ack verbatim). *M9:* fixed a paid-tx fund-burn
  (persist-before-ack, ack-only retry, `drainPending()` resume) and added timeouts/backoff +
  tamper-evidence gap markers. See [`services/anchor-relayer/README.md`](services/anchor-relayer/README.md).
- **committee** (`services/committee`) — tooling to drive the privileged calls (`set_stake`,
  `anchor_ack`, `add/remove_validator`) through the **3-of-5 `FollowerCommittee`** (propose → vote
  ×3 → close) instead of sudo. E.g. `node op.mjs --call talkStake.setStake --args '[…]' --via
  committee`. *M9:* the Kupo weight read now fails closed, and `viaCommittee`/`viaSudo` throw on a
  reverted inner dispatch (no more "success" on a reverted call). See
  [`services/committee/README.md`](services/committee/README.md).
- **indexer** (`services/indexer`) — the self-hosted **SubQuery** GraphQL read layer (folds the
  chain's public events into Postgres; paginated/searchable/threaded feed). Runs without Docker on
  local Postgres 16: `./run-indexer.sh` (ingest, admin/health :3001) + `./run-query.sh` (GraphQL on
  :3000). The frontend reads it only when a GraphQL endpoint is configured; PAPI-direct is the
  always-available fallback. *M9:* halt-on-error handler policy so the served feed can't diverge
  from the `verify-m4c` re-derivation; *M10:* pure mapping logic extracted to `src/mappings/pure.ts`
  with unit tests. See [`services/indexer/README.md`](services/indexer/README.md).
- **_shared** (`services/_shared`) — dependency-free helpers shared by the Node services: `net.mjs`
  (`fetchJson` — AbortController timeout + bounded exponential-backoff retry + `res.ok`/JSON
  validation, so a hung or error-ing Ogmios/Kupo can never silently drive a privileged write) and
  `cli.mjs` (`isMain` run-as-main guard that keeps entrypoints unit-testable).

### The full live stack (preprod)

`cardano-node` + Ogmios **:1337** + Kupo **:1442** + `cogno-chain-node` **:9944** + cogno-follower
**:8090**. The end-to-end loop — lock ADA → CIP-8 bind → committee `set_stake` from the locked
lovelace → feeless `PostCreated` (Δbalance = 0) → finalized root anchored to Cardano — is proven
live on spec 107 in [`docs/M8-relaunch.md`](docs/M8-relaunch.md) and [`docs/M7-ops.md`](docs/M7-ops.md).

---

## Testing & CI

M9 (production-hardening) and M10 (test + logging) brought every layer under test. The current
suites (run them per-layer as shown below):

| Layer | Suite | How to run |
|---|---|---|
| Pallets | **100** `#[test]` (microblog 33, cogno-gate 22, validator-set 17, anchor 15, talk-stake 13) | `cargo test` |
| L1 contract | **46** Aiken tests / 739 checks (7 property/fuzz) + 4 benches | `cd contracts && aiken check` |
| Frontend | Vitest pure-logic units (node env; MeshJS/PAPI mocked) | `cd app && npm test` |
| anchor-relayer · _shared · committee | Node decision-logic suites | `node <service>/<name>.test.mjs` |
| indexer | SubQuery pure mapping units (`src/mappings/pure.test.ts`) | `npm run codegen && node --experimental-strip-types src/mappings/pure.test.ts` |
| cogno-follower | Python suites (`test_beacon` · `test_vault` · `test_http` · `test_agreement`) | `python test_<name>.py` in its venv |

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) gates all of it on every push to `main` and
every PR, across four jobs:

- **contracts** — `aiken check` (the L1 `talk_vault` property/fuzz + boundary tests), aiken `v1.1.22`.
- **rust** — `clippy` + `cargo test` on the five pallets, pinned to rustc 1.90.0.
- **frontend** — `npm ci` → lint → **Vitest** → static-export `build` (node 22.12.0).
- **services** — the Node suites for `anchor-relayer`/`_shared`/`committee`; the indexer's pure
  mapping tests + `tsc --noEmit` (after `npm run codegen` to materialize the gitignored
  `src/types/`); and the Python Cogno-Follower suites.

M10 added no on-chain surface: no new Events, no weight/storage change, **no spec bump** — the
logging is operator-facing `log::` diagnostics on error/edge paths only.
