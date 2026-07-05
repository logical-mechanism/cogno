# CLAUDE.md

Guidance for working in this repo. See [README.md](README.md) for the user-facing overview and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design; per-mechanism depth lives in the
focused docs it links (`IN-PROTOCOL-OBSERVATION`, `ECONOMICS`, `TRUSTLESS-IDENTITY`, `SCALE-NODE-READS`)
and the operator runbooks (`PREPROD-BRINGUP`, `RELAY-NODE`, `UPGRADES`, `D2-custody-runbook`).

## What this is

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app. The right
to post is metered by a regenerating, stake-weighted **talk-capacity** earned by locking ADA in a
Cardano L1 contract — not by per-post fees. Cardano is **observed, not bridged**: it supplies CIP-8
identity, the locked-ADA weight, and a deterministic block clock (a stable Cardano block hash sealed
into each header). The chain inherits **none** of Cardano's finality/security — its safety is its own
operator-run Aura/GRANDPA. It is **observe-only**: no bridge, no metadata anchoring back to Cardano.

**Posture.** The backend is **all-Rust** and **sudo-free from genesis**: every privileged call goes
through a 3-of-5 committee that exists from block 0 (it can start single-seat and federate out by
vote). The `cardano-observer` inherent is the *sole* writer of weight. This is a live, honestly-labeled
**preprod testnet** moving toward production-ready — with a single operator-run producer it is
*D4-shaped, not trustless* (that needs ≥3 independent producers). Mainnet gaps (`MinAuthorities` floor,
GRANDPA equivocation, an independent CIP-8-verifier audit, prod key custody) are deliberately left in
place as `MAINNET PREREQUISITE` comments — **do not "fix" them** unless explicitly asked; they are
scoped-out testnet choices, not bugs.

## Layout

| Path | What |
|---|---|
| `node/` | `cogno-chain-node` (Aura + GRANDPA). `src/consensus/` = a custom proposer (reimplemented Apache-2.0 partner-chains `PartnerChainsProposerFactory` + `InherentDigest`) that seals the stable Cardano block anchor into each header as a `cobs` PreRuntime digest. Operator subcommands: `run`, `gen-chainspec`, `export-chain-spec`, `key insert`/`inspect-node-key` (session secret by file; p2p identity); a one-shot db-sync `config_check` runs automatically at boot |
| `runtime/` | `cogno-chain-runtime` (`#[frame_support::runtime]`, **spec_version 203 / tx_version 3**) |
| `pallets/` | `microblog` (10), `talk-stake` (9, call-less observer-written ledger), `cogno-gate` (8, CIP-8 1:1 identity), `governed-upgrade` (7), `validator-set` (14), `cardano-observer` (16, enforcing), `profile` (17), `governance-fuel` (18, committee-administered REGENERATING admin-fuel budget — `set_allowance`/`revoke` + an `on_initialize` regen hook; non-transferable, mint-on-demand) |
| `cli/` | `cogno-chain-cli` — the all-Rust admin CLI (typed `RuntimeCall` only, keys-by-file, committee lifecycle, bare identity binds, `query state`/`query weight` over RPC) |
| `cogno-dbsync/` | shared crate: the deterministic db-sync reader + Cardano-state reduction (the node's inherent writer + its boot `config_check` probe read it identically) |
| `cogno-keyfile/` | shared crate: the cardano-cli-style JSON key envelope |
| `contracts/` | the Aiken (Plutus V3) L1 `talk_vault` validator + `audits/` — **LIVE on preprod, see gotcha below** |
| `app/` | Next.js 16 static-export frontend (PAPI + MeshJS). See [app/README.md](app/README.md) |
| `ci/cip8-oracle/` | an independent Python CIP-8 verifier (a second implementation), kept as a CI adversarial oracle — do **not** port to Rust |
| `deploy/` | one systemd unit + monitoring (Prometheus/Grafana/Alertmanager) |
| `_sdk/` | **gitignored** vendored polkadot-sdk checkout |

## Build / run / test

The full build/test matrix, toolchain pins, and CI gates are in
[CONTRIBUTING.md](CONTRIBUTING.md). Quick reference for working here:

```bash
cargo build --release && ./target/release/cogno-chain-node run --dev   # single //Alice, WS :9944
cargo test --workspace
SKIP_WASM_BUILD=1 cargo check -p <crate>                               # fast, skips the wasm build
cd contracts && script -qec "aiken check" /dev/null                    # aiken errors are TTY-gated
```

- **Regenerate contract artifacts** (only on an intentional redeploy — this MOVES the live hash, see
  the gotcha below): `aiken build` (plutus.json) + `node scripts/regen-vault.mjs` (vault.json).
- **After an encoding-affecting spec bump**, regenerate the frontend's PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

## Critical gotchas

- **The L1 contract is LIVE on preprod — never move its hash.** Any *production* edit under
  `contracts/` (`validators/*.ak` or `lib/*.ak`) recompiles the script and **moves the blueprint
  hash** (currently `49ffbfc6…`, applied vault `168a9710…`), orphaning the deployed vault. After any
  contracts change, `git diff` the `hash` fields in `plutus.json` / `vault.json` and confirm they're
  unchanged. **Contracts logging is off-limits while live** — even a `trace` line bakes into the script
  and moves the hash.
- **Cardano is read EXCLUSIVELY through db-sync (consensus-critical determinism)** via the
  `cogno-dbsync` crate. The node's inherent-data provider is the sole consensus **writer**; the node's
  boot-time `config_check` reuses the same crate **read-only** (a non-blocking startup probe) — both go
  through `DBSYNC_URL`. Determinism is pinned by the golden fixture in `cogno-dbsync` (a divergence is a
  **chain fork**); the CLI's `query weight` reads the resulting on-chain `TalkStake` ledger over RPC, not
  db-sync. **Preserve verbatim** the byte-identity invariants: spentness from **`tx_in`**
  (never `consumed_by_tx_id`); coins/qty as **`::text`** (lovelace > 2⁵³); the vault set from
  **`tx_out.payment_cred = <script hash>`**; a fail-closed **abstain** when `tx_in` is absent;
  largest-UTxO-wins per identity (never summed). Ogmios still SUBMITS L1 txs + serves cost models; the
  in-browser CIP-30 vault uses Blockfrost. MAINNET PREREQUISITE: db-sync must run FULL (non-pruned),
  **`tx_in`-enabled** (NOT `--consumed-tx-out`), and over TLS.
- **Use the nvm node `v22.12.0`, not the snap node.** The snap `node` writes stdout to `/dev/null`
  (silent failures), and importing `@meshsdk/core-cst` redirects stdio. Prepend
  `~/.nvm/versions/node/v22.12.0/bin` to `PATH` for all Node/MeshJS work.
- **Pallet indices are on-wire contracts — never renumber.** Indices **6** (Sudo, removed) and **12**
  (Anchor, removed) are permanently vacant; **7** is GovernedUpgrade. Adding a pallet uses a new index;
  gaps are fine.
- **Spec-bump discipline.** Encoding-affecting runtime changes (calls/storage/events/extensions) bump
  `spec_version` (currently **203**); after a bump, regenerate PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.
  Non-encoding changes (bounds, logging, tests) must **not** bump it.
- **Toolchain is pinned to rustc 1.93.0** — the toolchain Parity builds the polkadot-sdk `stable2606`
  train against. The old "stable ≥ ~1.91 breaks the `sp_io` wasm link" ceiling was specific to
  stable2603's sp-io 45.0.0; stable2606's sp-io 48.0.0 links cleanly under 1.93.0. Stay on the
  toolchain the pinned SDK release is verified against — don't drift `rust-toolchain.toml` off it.
- **Privileged calls go through the 3-of-5 committee — there is no sudo.** Use `cogno-chain-cli
  committee …` (propose / vote / close over `FollowerCommittee`). Runtime upgrades are
  `upgrade authorize` (committee) + a permissionless `upgrade apply` (spec-checked).
- **Federating out is fund-before-seat (spec 203).** Seating gates now require a committee-granted
  governance-fuel allowance (and, for validators, registered session keys): a `fuel set-allowance
  --account <X>` must precede `committee members add` / `validator add`, and a new validator must
  `validator set-keys` first. Seating an unfunded/keyless account is rejected on-chain (`CallFiltered`
  for a committee seat, `NotFunded` / `NoSessionKeys` for a validator). See docs/PREPROD-BRINGUP.md Step 6.
- **Cardano cost models:** inject live Ogmios cost models via `setCostModels` when building L1 txs —
  MeshJS's stale defaults produce a bad script-integrity hash.
- **Never `next build` while `next dev` is running** (they share `.next/`). Run the frontend dev server
  on a free port if the live cardano-node monitoring is binding `:3000`/`:3001`.

## Conventions

Contribution workflow (branch-per-unit, PR-into-`main`, the commit-scope format, `Cargo.lock`
committed) lives in [CONTRIBUTING.md](CONTRIBUTING.md). Agent-specific notes:

- **Commits:** `<scope>(<area>): <summary>` (e.g. `feat(pallets): …`, `fix(node): …`, `docs: …`); end
  AI-assisted commits with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Pallet logging** uses the `log::` facade via each pallet's `LOG_TARGET` (no new Events) — keep it
  additive and encoding-neutral.
