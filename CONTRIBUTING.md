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
| Python (CIP-8 oracle) | 3.10+ with the pinned `ci/cip8-oracle/requirements.txt`. |

## Build, run, test

```bash
# Node + workspace (heavy first compile):
cargo build --release
./target/release/cogno-chain-node run --dev      # single //Alice authority, WS :9944
cargo test --workspace                            # pallets + cli + cogno-dbsync + cogno-keyfile

# Fast iteration (skips the wasm runtime build):
SKIP_WASM_BUILD=1 cargo check -p <crate>

# L1 contract (aiken errors are TTY-gated — wrap in `script` when capturing output):
cd contracts && script -qec "aiken check" /dev/null

# Frontend (use the nvm node — see toolchain table):
cd app && npm install && npm test && npm run build

# CIP-8 agreement oracle (an independent second implementation, used as a CI adversarial check):
cd ci/cip8-oracle && python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) gates four jobs: `rust`
(clippy `-D warnings` + `cargo test --workspace` + build), `contracts` (`aiken check`), `frontend`
(lint / test / build), and `cip8-oracle` (the Python agreement check). Please make sure the relevant
gates pass locally before opening a PR.

## Pull requests

- **Branch per unit of work**, then open a PR into `main`.
- **Commit messages:** `<scope>(<area>): <summary>`, e.g. `feat(pallets): …`, `fix(node): …`,
  `docs: …`. Keep the subject imperative and under ~72 chars.
- **`Cargo.lock` is committed** — include it when dependencies change.
- Sign-off (`git commit -s`, the [DCO](https://developercertificate.org/)) is encouraged.

## Rules that will bite you (please respect these)

- **The L1 contract is LIVE on preprod — never move its hash.** Any change under `contracts/`
  (`validators/*.ak` or `lib/*.ak`) recompiles the script and moves the blueprint hash, orphaning the
  deployed vault. After any contracts change, `git diff` the `hash` fields in `plutus.json` /
  `vault.json` and confirm they're unchanged. Contract logging is off-limits while the script is live
  (even a `trace` line moves the hash).
- **Pallet indices and `transaction_version` are on-wire contracts — never renumber.** Indices 6
  (Sudo, removed) and 12 (Anchor, removed) are permanently vacant; adding a pallet uses a new index.
- **Spec-bump discipline.** Bump `spec_version` (currently **201**) *only* for encoding-affecting
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

Open a GitHub issue for ordinary bugs and feature requests (templates are provided). For anything with
security impact, follow [`SECURITY.md`](SECURITY.md) instead of filing a public issue.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to
uphold it.
