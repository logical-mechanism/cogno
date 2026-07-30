# Contributing to cogno-chain

Thanks for your interest in cogno-chain — a Polkadot-SDK Substrate app-chain for a feeless
"post text / read text" social app, metered by a stake-weighted talk-capacity earned by locking ADA
in a Cardano L1 contract (Cardano is *observed*, not bridged). Start with the
[README](README.md) for the overview and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the design.

## Project posture (read this first)

This is a **live preprod testnet** moving toward production. It is deliberately **operator-run** and
honestly labeled: a set of hardening items — a `MinAuthorities` floor, GRANDPA equivocation slashing,
an independent CIP-8-verifier audit, production key custody — are **intentionally deferred** and
marked with `MAINNET PREREQUISITE` comments in the source. **These are scoped-out testnet choices,
not bugs.** Please don't open PRs "fixing" them unless an issue explicitly asks for it.

The backend is **all-Rust** and **sudo-free from genesis**: every privileged call goes through a
3-of-5 committee (`pallet-collective` `FollowerCommittee`). There is no `pallet-sudo`.

## Toolchain

| Component | Requirement |
|---|---|
| Rust | **1.93.0** (pinned in [`rust-toolchain.toml`](rust-toolchain.toml) — installed automatically by rustup). Stay on the toolchain the pinned polkadot-sdk release (`stable2606`) is verified against; the old ≥ ~1.91 `sp_io` wasm-link break was specific to stable2603's sp-io 45.0.0 and no longer applies. |
| Aiken (contracts) | **v1.1.22** (pinned in `contracts/aiken.toml` and CI) — required to reproduce the committed blueprint hash. |
| Node.js (frontend + fixtures) | **v22.12.0** via nvm. Do **not** use the snap `node` (it silently drops stdout). |
| Python (CIP-8 oracle) | **3.12** (the version CI pins) with the pinned `ci/cip8-oracle/requirements.txt`. |

## Build, run, test

```bash
# Node + workspace (heavy first compile):
cargo build --release
./target/release/cogno-chain-node run --dev      # single //Alice authority, WS :9944
cargo test --workspace                            # node + runtime + all pallets + cli + cogno-dbsync + cogno-keyfile

# Fast iteration (skips the wasm runtime build):
SKIP_WASM_BUILD=1 cargo check -p <crate>

# L1 contract (aiken errors are TTY-gated — wrap in `script` when capturing output):
cd contracts && script -qec "aiken check" /dev/null

# Frontend (use the nvm node — see toolchain table). This is the whole CI gate, in order:
cd app && npm ci && npm run lint && npx tsc --noEmit --incremental false \
  && npm test && npm run build && npm run smoke

# CIP-8 agreement oracle (an independent second implementation, used as a CI adversarial check):
cd ci/cip8-oracle && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

### Re-running FRAME benchmarks

Any change to what a call READS OR WRITES invalidates its weights — the generated `weights.rs` carries
a `/// Storage:` list describing the storage as it was when measured, and a stale one is worse than no
list, because the next person recounts a `#[pallet::weight]` against it and derives the wrong delta.

The obvious command does not work here:

```bash
cargo build --release --features runtime-benchmarks   # ✗ panics in a dependency's build script
```

`frame-benchmarking-cli` pulls in `frame-storage-access-test-runtime`, whose build script asks
`substrate-wasm-builder` to compile its wasm. wasm-builder locates the workspace by walking UP from
`OUT_DIR` — which lands in *our* `target/` — then runs `cargo metadata` on our workspace **without**
`--features runtime-benchmarks`. That crate only exists under that feature, so it fails to find itself
and panics with `Failed to find entry for package frame-storage-access-test-runtime`.

We never need that crate's wasm (it backs `benchmark storage`, not `benchmark pallet`). So build the
benchmarks RUNTIME on its own — `frame-benchmarking-cli` is not in the runtime crate's dependency
graph — then build the node with the wasm step skipped, and point the CLI at the runtime blob:

```bash
# 1. the benchmarks runtime (no frame-benchmarking-cli in the graph, so no panic)
cargo build --release -p cogno-chain-runtime --features runtime-benchmarks
cp target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm /tmp/bench.wasm

# 2. the node, for its `benchmark` subcommand only — SKIP_WASM_BUILD dodges the broken build script
SKIP_WASM_BUILD=1 cargo build --release --features runtime-benchmarks

# 3. measure, against the blob from step 1 rather than an embedded runtime
./target/release/cogno-chain-node benchmark pallet \
  --runtime /tmp/bench.wasm --genesis-builder=runtime \
  --pallet pallet_microblog --extrinsic '*' \
  --steps 20 --repeat 5 --wasm-execution compiled \
  --template _sdk/substrate/.maintain/frame-weight-template.hbs \
  --output pallets/microblog/src/weights.rs
```

Step 2 leaves a stub where the runtime wasm goes, so run a plain `cargo build --release` afterwards
before you use `target/release/wbuild/…` for anything else.

Two things to watch. The harness dispatches the extrinsic in the block AFTER your `#[benchmark]`
setup runs, so setup that computes a block-number bound must not sit exactly on it — `create_poll`
anchors its deadline on `MaxPollDuration` for precisely this reason. And once weights are re-measured,
re-check any hand-written `.saturating_add(T::DbWeight::get().reads_writes(..))` on the call: an addend
that covered storage the old benchmark missed becomes a double count the moment the benchmark covers it.

`next build` type-checks only the module graph it bundles, so a type error in a test file or an
unimported module passes both `next build` and vitest. `tsc` is the only gate that reads every file
the tsconfig covers — run it. `NEXT_PUBLIC_WS_URL` needs no value: unset, the app falls back to the
live `wss://cogno.forum/rpc`, so a clean clone builds and runs. Set it to point at your own node.

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) gates five jobs: `rust` (clippy
`-D warnings` + `cargo fmt --check` + `cargo test --workspace` + build), `supply-chain`
(`cargo deny check`), `contracts` (`aiken check`, plus a guard that fails if the live script hash
moved), `frontend` (lint / typecheck / test / build / smoke), and `cip8-oracle` (the Python agreement
check). Please make sure the relevant gates pass locally before opening a PR.

## Pull requests

- **Branch per unit of work**, then open a PR into `main`.
- **Commit messages:** `<scope>(<area>): <summary>`, e.g. `feat(pallets): …`, `fix(node): …`,
  `docs: …`. Keep the subject imperative and under ~72 chars.
- **`Cargo.lock` is committed** — include it when dependencies change.

## Licensing of contributions

- Contributions are accepted under the [Apache License, Version 2.0](LICENSE) — the same license the
  project ships under. That is the Apache-2.0 §5 default; it is stated here so there is no ambiguity.
- **No CLA, no copyright assignment.** You keep the copyright on your work.
- **Sign off your commits** (`git commit -s`), certifying the [DCO](https://developercertificate.org/).
  This is required — it is the project's record of contribution provenance.

## Rules that will bite you (please respect these)

- **The L1 contract is LIVE on preprod — never move its hash.** Any change under `contracts/`
  (`validators/*.ak` or `lib/*.ak`) recompiles the script and moves the blueprint hash, orphaning the
  deployed vault — which holds real preprod ADA. After any contracts change, `git diff` the `hash`
  fields in `plutus.json` / `vault.json` and confirm they're unchanged; CI fails the `contracts` job
  if they moved. Contract logging is off-limits while the script is live (even a `trace` line moves
  the hash).
- **Use the nvm `node` v22.12.0, not the snap `node`.** The snap build writes stdout to `/dev/null`,
  so Node scripts fail silently — you get an empty result and no error. Importing `@meshsdk/core-cst`
  redirects stdio for the same reason. Put `~/.nvm/versions/node/v22.12.0/bin` first on your `PATH`
  for all Node/MeshJS work.
- **Aiken errors are TTY-gated.** `aiken check` prints nothing useful when its output is piped — wrap
  it: `script -qec "aiken check" /dev/null`.
- **Never run `next build` while `next dev` is running** — they share `app/.next/` and will corrupt
  each other's output.
- **Pallet indices and `transaction_version` are on-wire contracts — never renumber.** Indices 6
  (Sudo, removed) and 12 (Anchor, removed) are permanently vacant; adding a pallet uses a new index.
- **Spec-bump discipline.** Bump `spec_version` (currently **215**) *only* for encoding-affecting
  runtime changes (calls/storage/events/extensions); after a bump, regenerate the frontend's PAPI
  descriptors. Non-encoding changes (bounds, logging, docs, tests) must **not** bump it.
- **Cardano is read exclusively through db-sync** via the `cogno-dbsync` crate, and its byte-identity
  invariants are consensus-critical (a divergence is a chain fork). Preserve them verbatim; the golden
  fixture in `cogno-dbsync` pins determinism.
- **Privileged calls go through the 3-of-5 committee — there is no sudo.** Use `cogno-chain-cli
  committee …`.
- **Pallet logging** uses the `log::` facade via each pallet's `LOG_TARGET` — keep it additive and
  encoding-neutral (no new events).

## Reporting bugs & security issues

Open a GitHub issue for ordinary bugs and feature requests (templates are provided) — that is also the
place to ask a question if you're stuck. For anything with security impact, follow
[`SECURITY.md`](SECURITY.md) instead of filing a public issue. For abuse on the hosted network, see
[`POLICY.md`](POLICY.md).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to
uphold it.
