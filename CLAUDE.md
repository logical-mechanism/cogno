# CLAUDE.md

Guidance for working in this repo. See [README.md](README.md) for the user-facing overview and
[docs/](docs/) for the full design (L1–L5, `PLAN.md`, `ECONOMICS.md`, `DECISION-REGISTER.md`).

## What this is

A Polkadot-SDK Substrate **app-chain** for a *feeless* "post text / read text" social app. The
right to post is metered by a regenerating, stake-weighted **talk-capacity** earned by locking ADA
in a Cardano L1 contract — not by per-post fees. Cardano is **observed, not bridged**: it supplies
CIP-8 identity, the locked-ADA weight, and witnesses finalized state-roots (metadata anchors). The
chain inherits **none** of Cardano's finality/security — its safety is its own operator-run
Aura/GRANDPA.

**Honest posture ("usable ≠ trustless"):** v1 is a single operator-run node + a single trusted
follower; the 3-of-5 committee path is real but D2-*shaped* on a one-operator stack. This is a live,
honestly-labeled **testnet proof-of-concept**, not a production system. Mainnet gaps (dev-key
custody, prod genesis, GRANDPA equivocation, `MinAuthorities`) are deliberately left in place as
`MAINNET PREREQUISITE` comments in the source — **do not "fix" them** unless explicitly asked; they
are scoped-out testnet choices, not bugs.

## Layout

| Path | What |
|---|---|
| `node/` | `cogno-chain-node` (Aura + GRANDPA). `src/consensus/` = a custom block proposer (reimplemented Apache-2.0 partner-chains `PartnerChainsProposerFactory` + `InherentDigest`) that seals the stable Cardano block anchor into each header as a `cobs` PreRuntime digest |
| `runtime/` | `cogno-chain-runtime` (`#[frame_support::runtime]`, **spec_version 111 / tx_version 2**) |
| `pallets/` | `microblog` (10, posts + folded capacity), `talk-stake` (9, Cardano weight), `cogno-gate` (8, CIP-8 1:1 identity), `anchor` (12), `validator-set` (14), `cardano-observer` (16, in-protocol Cardano-weight observation inherent) |
| `contracts/` | the Aiken (Plutus V3) L1 `talk_vault` validator + `audits/` — **LIVE on preprod, see gotcha below** |
| `app/` | Next.js 14 static-export frontend (PAPI + MeshJS). See [app/README.md](app/README.md) |
| `services/` | `cogno-follower` (Python), `anchor-relayer`, `committee`, `indexer` (SubQuery), `_shared`. Each has a README |
| `docs/` | design specs + per-milestone build logs (`M*-build.md`) |
| `_sdk/` | **gitignored** vendored polkadot-sdk checkout |

Milestone history: M0–M10, all merged to `main`. M0–M8 each have a `docs/M*-build.md`; M9
(production-hardening) and M10 (test+logging) hardened existing code and have no build log (M9 =
`docs/PRODUCTION-HARDENING.md`).

## Build / run / test

```bash
# Node (heavy first compile; pinned rustc 1.90.0):
cargo build --release
./target/release/cogno-chain-node --dev        # single //Alice authority, Alice=sudo, WS :9944
cargo test                                      # the 5 pallets (100 #[test])

# L1 contract — aiken errors are TTY-gated, wrap in `script` when capturing:
cd contracts && script -qec "aiken check" /dev/null   # 46 tests / 739 checks
aiken build                                     # regenerates plutus.json (blueprint + hash)
node scripts/regen-vault.mjs                     # regenerates vault.json (applied hash + CBOR)

# Frontend (USE THE NVM NODE — see gotcha):
cd app && npm install                            # postinstall runs `papi` to gen descriptors
npm run dev                                       # :3000, points at ws://127.0.0.1:9944
npm run build                                      # static export -> app/out/
npm test                                           # Vitest pure-logic units (MeshJS/PAPI mocked)
```

Service tests run as plain scripts (mirrored in [.github/workflows/ci.yml](.github/workflows/ci.yml),
which gates four jobs: `contracts` / `rust` / `frontend` / `services`):
`node services/<svc>/<name>.test.mjs`; indexer `npm run codegen && node --experimental-strip-types
src/mappings/pure.test.ts`; follower `python test_<name>.py` in its venv.

## Critical gotchas

- **The L1 contract is LIVE on preprod — never move its hash.** Any *production* edit under
  `contracts/` (`validators/*.ak` or `lib/*.ak`) recompiles the script and **moves the blueprint
  hash** (currently `49ffbfc6…`, applied vault `168a9710…`), orphaning the deployed M8 vault. After
  any contracts change, `git diff` the `hash` fields in `plutus.json` / `vault.json` and confirm
  they're unchanged. **Contracts logging is off-limits while live** — even a `trace` line bakes into
  the script and moves the hash. M10's contract work was deliberately tests-only for this reason.
- **Use the nvm node `v22.12.0`, not the snap node.** The snap `node` writes stdout to `/dev/null`
  (silent failures), and importing `@meshsdk/core-cst` redirects stdio. Prepend
  `~/.nvm/versions/node/v22.12.0/bin` to `PATH` for all Node/MeshJS work.
- **The in-protocol observation reads Cardano db-sync, NOT Kupo (consensus-critical determinism).** The
  node (`node/src/dbsync.rs`), the committee tooling (`services/committee/dbsync.mjs`), and the follower
  (`vault.py`) all read the `talk_vault` from a read-only db-sync via `DBSYNC_URL|DBSYNC`. Kupo's
  `/checkpoints` anchor was tip-relative / non-deterministic (a latent fork at the ≥3-producer cutover);
  db-sync gives a deterministic "block at/before slot S". Three byte-identity invariants — a divergence is
  a **chain fork** — pinned by the Rust↔JS golden (`services/_shared/fixtures/observation-equivalence.json`):
  spentness from **`tx_in`** (canonical), NOT `consumed_by_tx_id` (denormalized/unreliable); coins/qty as
  **`::text`** (lovelace > 2^53); the vault set driven from **`tx_out.payment_cred = <script hash>`** (the
  indexed analog of Kupo `/matches/{policy}.*`). The SQL is parallel across all three languages — keep them
  in lockstep. Kupo is **retired from the observation path** but stays for the anchor-relayer (L1 write/
  metadata) + the in-browser CIP-30 vault. MAINNET PREREQUISITE: db-sync must run FULL (non-pruned),
  **tx_in-enabled** (NOT `--consumed-tx-out` — the read probes `EXISTS (SELECT 1 FROM tx_in)` and abstains
  fail-closed otherwise, so a wrong-mode instance never emits a spent vault as locked), and over TLS.
- **Pallet indices are on-wire contracts — never renumber.** Index **7 is permanently vacant**
  (`pallet-template` dropped in M7). Adding a pallet uses a new index; gaps are fine.
- **Spec-bump discipline.** Encoding-affecting runtime changes (calls/storage/events/extensions)
  bump `spec_version`; after a bump, regenerate PAPI descriptors:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.
  Non-encoding changes (bounds, logging, tests) must **not** bump it — M9/M10 correctly stayed at 107.
- **Toolchain is pinned to rustc 1.90.0.** Stable ≥ ~1.91 (incl. 1.96) breaks the `sp_io` wasm link
  (`undefined symbol` for every host fn). Don't bump `rust-toolchain.toml`.
- **Privileged calls go through the 3-of-5 `FollowerCommittee`**, not bare sudo (sudo is a dev
  fallback). Use `services/committee/op.mjs --via committee`; the relayer defaults `ANCHOR_VIA=committee`.
- **Cardano cost models:** inject live Ogmios cost models via `setCostModels` when building L1 txs —
  MeshJS's stale defaults produce a bad script-integrity hash.
- **Never `next build` while `next dev` is running** (they share `.next/`). The live cardano-node
  monitoring binds `:3000`/`:3001`; run the frontend dev server on a free port if conflicting.

## Conventions

- **Commits:** `<scope>(<area>): <summary>`, e.g. `m10(ci): …`, `m9(relayer): …`; non-milestone work
  uses a plain scope like `docs:`. End commit messages with
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- **Branch per unit of work** off `main`; PR into `main`. `Cargo.lock` is committed.
- **Pallet logging** uses the `log::` facade via each pallet's `LOG_TARGET` (no new Events) — keep it
  additive and encoding-neutral.
