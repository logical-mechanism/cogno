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
| Aiken (contracts) | **v1.1.22** (pinned in [`contracts/aiken.toml`](contracts/aiken.toml) and installed by CI) — the compiler that reproduces the committed blueprint. A compiler bump can move the compiled UPLC hash, and even when it doesn't it stamps its own version into `plutus.json`'s `preamble.compiler`, so the `git diff --exit-code` guard fails either way. Use the pin. |
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

# Frontend (use the nvm node — see toolchain table). This is the whole `frontend` CI job, in order:
cd app && npm ci && npm run lint && npx tsc --noEmit --incremental false \
  && npm test && npm run build && npm run smoke

# CIP-8 agreement oracle (an independent second implementation, used as a CI adversarial check).
# test_agreement.py shells out to app/scripts/m2-cip8-fixture.mjs, so `npm ci` in app/ has to have run:
cd ci/cip8-oracle && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
python test_beacon.py && python test_agreement.py && python test_role_payload.py
```

Three of those frontend steps do more than their names suggest. `npm ci` fires `postinstall: papi`,
which regenerates the PAPI descriptors from the committed metadata. `npm run lint` is three checks:
`eslint . --max-warnings 0`, then `scripts/check-tokens.mjs` (every `var(--cg-…)` used in a
`*.module.css` must be declared by some stylesheet under `app/src`), then `scripts/check-spec.mjs`
(the runtime's `spec_version` must equal `DESCRIPTOR_SPEC_VERSION` in `app/src/lib/chain/client.ts`).
And `npm run build` fires `prebuild: gen-licenses.mjs`, which rewrites the committed
`app/public/third-party-licenses.txt`.

`next build` type-checks only the module graph it bundles, so a type error in a test file or an
unimported module passes both `next build` and vitest. `tsc` is the only gate that reads every file the
tsconfig covers — run it. `NEXT_PUBLIC_WS_URL` needs no value: unset, the app falls back to the live
`wss://cogno.forum/rpc`, so a clean clone builds and runs. Set it to point at your own node.

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

We never need that crate's wasm (it backs `benchmark storage`, not `benchmark pallet`). wasm-builder
takes a PER-CRATE skip variable — `SKIP_<CRATE_NAME>_WASM_BUILD` — so skip exactly the crate that
panics and let everything else build normally:

```bash
# 1. the benchmarks runtime (no frame-benchmarking-cli in the graph, so no panic)
cargo build --release -p cogno-chain-runtime --features runtime-benchmarks
cp target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm /tmp/bench.wasm

# 2. the node, for its `benchmark` subcommand only
SKIP_FRAME_STORAGE_ACCESS_TEST_RUNTIME_WASM_BUILD=1 cargo build --release --features runtime-benchmarks

# 3. measure, against the blob from step 1 rather than an embedded runtime
./target/release/cogno-chain-node benchmark pallet \
  --runtime /tmp/bench.wasm --genesis-builder=runtime --genesis-builder-preset development \
  --pallet pallet_microblog --extrinsic '*' \
  --steps 50 --repeat 20 --wasm-execution compiled \
  --template _sdk/substrate/.maintain/frame-weight-template.hbs \
  --output pallets/microblog/src/weights.rs
```

**Do not use the blanket `SKIP_WASM_BUILD=1` for step 2**, which is what this recipe used to say. It
skips *our* runtime's wasm build too, so `WASM_BINARY` compiles to `None` — and the node's `load_spec`
builds every one of its chain specs from `WASM_BINARY`. `create_runner` resolves a spec before the
benchmark command ever runs, so step 3 dies on `Error: Input("Development wasm not available")`, and
`--chain` cannot rescue it because clap declares it mutually exclusive with `--runtime`. (It appears to
work if a wasm from a previous build happens to be sitting in `target/release/wbuild/`, which is why
the recipe survived: wasm-builder only substitutes the `None` stub when no binary exists yet.)

Step 3 needs `--genesis-builder-preset development` explicitly; the CLI does not default to it.

Step 3's `--template` path is **not a repo file**. `_sdk/` is a gitignored vendored polkadot-sdk
checkout, so a fresh clone has no template there and nothing else in this repo supplies one. Take
`substrate/.maintain/frame-weight-template.hbs` from a polkadot-sdk checkout at the pinned tag
(`polkadot-stable2606-rc4` — see the header of [`rust-toolchain.toml`](rust-toolchain.toml)) and point
`--template` at wherever you keep it. Keep the flag: every *benchmarked* `weights.rs` was generated with
that template, and each one records the exact invocation in its `Executed Command:` header block —
pointing at the same template is what keeps a re-measurement diffing on the numbers you changed.
(`pallet-cardano-roles` and `pallet-governed-upgrade` are the exceptions: their weights are hand-set
rather than measured, so those two files carry no such header.)

Both the runtime and the node are left built with `--features runtime-benchmarks` afterwards, so run a
plain `cargo build --release` before using `target/release/…` for anything else — including
`scripts/check-metadata.sh`, which gates against whichever node binary is newest.

Two things to watch. The harness dispatches the extrinsic in the block AFTER your `#[benchmark]`
setup runs, so setup that computes a block-number bound must not sit exactly on it — `create_poll`
anchors its deadline on `MaxPollDuration` for precisely this reason. And once weights are re-measured,
re-check any hand-written `.saturating_add(T::DbWeight::get().reads_writes(..))` on the call: an addend
that covered storage the old benchmark missed becomes a double count the moment the benchmark covers it.

## What CI actually runs

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) is a `changes` path-filter job plus **five gated
jobs**. Each gated job runs only when its own paths were touched, so a green run on your PR may have
skipped most of the list below. Run the jobs your change fires before opening the PR.

| Job | Fires when these change | Commands, in order |
|---|---|---|
| `rust` | `**/*.rs`, `**/Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `deny.toml`, `node/**`, `runtime/**`, `cli/**`, `pallets/**`, `cogno-dbsync/**`, `cogno-keyfile/**`, `ci.yml` | `cargo fmt --all --check`; `SKIP_WASM_BUILD=1 cargo clippy --workspace --all-targets --locked -- -D warnings -A clippy::result_large_err`; `cargo test --workspace --locked`; `cargo build --workspace --locked`; `SKIP_WASM_BUILD=1 cargo check --locked -p cogno-chain-node --features runtime-benchmarks`; `./scripts/check-metadata.sh` |
| `supply-chain` | the same filter as `rust` | `cargo deny check advisories bans sources` (the `licenses` check is deliberately off — see [`deny.toml`](deny.toml)) |
| `contracts` | `contracts/**`, `ci.yml` | `aiken check`; then `aiken build && git diff --exit-code plutus.json` |
| `frontend` | `app/**`, `runtime/src/lib.rs`, `ci.yml` | the frontend line above, in that order |
| `cip8-oracle` | `ci/cip8-oracle/**`, `app/scripts/**`, `app/package.json`, `app/package-lock.json`, `pallets/cogno-gate/**`, `ci.yml` | `python test_beacon.py`; `python test_agreement.py`; `python test_role_payload.py` |

Three of those are easy to be surprised by:

- **`runtime/src/lib.rs` is in the *frontend* filter on purpose.** `npm run lint` runs
  `check-spec.mjs`, so a runtime-only `spec_version` bump fails the `frontend` job unless
  `DESCRIPTOR_SPEC_VERSION` moved with it.
- **`./scripts/check-metadata.sh`** diffs the committed `app/.papi/metadata/cogno.scale` against a
  freshly built runtime. Any deliberate encoding change — a plain `spec_version` bump included — has
  to be re-snapshotted with `./scripts/check-metadata.sh --write` in the same PR.
- **`cargo check --features runtime-benchmarks`** is the only thing that compiles the `#[benchmarks]`
  modules; nothing else in CI touches them.

CI does **not** run: `cargo build --release`, the `try-runtime` dry-run, `scripts/acceptance/`, or the
Playwright-driven `npm run check:overflow` / `shoot` / `psi` (`npm ci` does not even download a browser).
It also does not diff `contracts/vault.json` or `app/public/third-party-licenses.txt`.

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
  deployed vault — which holds real preprod ADA. CI rebuilds the blueprint and fails the `contracts`
  job if `plutus.json`'s hash moved, but **that is the only artifact any workflow checks**: nothing in
  CI looks at `contracts/vault.json` or the frontend's pinned copy at `app/src/lib/cardano/vault.json`.
  Verify those two yourself with `node contracts/scripts/regen-vault.mjs --verify`, which recomputes the
  applied hash, writes nothing, and exits 1 on drift. It needs `npm ci` in `app/` first — the MeshJS
  deps it resolves live there — and the nvm `node`; trust the exit code rather than the printout,
  because the snap node swallows stdout. Contract logging is off-limits while the script is live (even a
  `trace` line moves the hash).
- **Use the nvm `node` v22.12.0, not the snap `node`.** The snap build writes stdout to `/dev/null`,
  so Node scripts fail silently — you get an empty result and no error. Importing `@meshsdk/core-cst`
  redirects stdio for the same reason. Put `~/.nvm/versions/node/v22.12.0/bin` first on your `PATH`
  for all Node/MeshJS work.
- **Aiken errors are TTY-gated.** `aiken check` prints nothing useful when its output is piped — wrap
  it: `script -qec "aiken check" /dev/null`.
- **Never run `next build` while `next dev` is running** — they share `app/.next/` and will corrupt
  each other's output.
- **Pallet indices and call indices are on-wire contracts — never renumber.** Indices 6 (Sudo, removed)
  and 12 (Anchor, removed) are permanently vacant; adding a pallet takes a new index (the next free one
  is **21**). Gaps are fine; reuse is not.
- **Event and Error variants are on-wire too.** SCALE indexes enum variants by *declaration order*, so
  deleting one silently shifts every variant below it. Every pallet's `Event` and `Error` is pinned with
  explicit `#[codec(index = N)]`; retired variants leave a permanent gap. Append at the end, pin the new
  variant, and never insert into a gap or reorder.
- **Spec-bump discipline.** Bump `spec_version` (currently **225**) for any runtime change you intend to
  **enact** — encoding-affecting or not. `authorize_upgrade` sets `check_version = true` and
  `frame_system::can_set_code` refuses a non-increasing `spec_version`, so a runtime that does not bump
  cannot be deployed at all; specs 222 and 224 were behaviour- and read-shape-only and bumped for that
  reason alone. What must **not** bump it is a change that never ships as a runtime upgrade: comments,
  tests, and node-side code. `transaction_version` (currently **8**) is separate: it moves only on a
  call-argument or `TxExtension` change — removing a call does not move it. Three things travel with a
  bump. Re-snapshot the metadata (`./scripts/check-metadata.sh --write`) — the `rust` job diffs it. Move
  `DESCRIPTOR_SPEC_VERSION` in `app/src/lib/chain/client.ts` to match — the `frontend` job diffs it.
  And regenerate the frontend's PAPI descriptors against a **local dev node**, never the live chain:
  `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.
  That last command writes `wsUrl` / `genesis` / `codeHash` back into `app/.papi/polkadot-api.json`;
  strip them out again before committing, or `npm run lint` rejects the entry.
- **Cardano is read exclusively through db-sync** via the `cogno-dbsync` crate, and its byte-identity
  invariants are consensus-critical (a divergence is a chain fork). Preserve them verbatim; the golden
  fixture at `cogno-dbsync/src/fixtures/observation-equivalence.json` pins determinism and is exercised
  by `cargo test --workspace`.
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
