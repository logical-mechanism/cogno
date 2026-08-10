<!-- Thanks for contributing! Please fill this out so reviewers can move quickly. -->

## Summary

<!-- What does this change do, and why? -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] CI / tooling / ops

## Testing

<!--
Tick the groups your change touches. These ARE the CI gates, so a full tick predicts a green run.
Go by the triggers in parentheses, not by the directory you edited: a runtime-only spec bump still
runs the frontend job, and any edit to `.github/workflows/ci.yml` runs all four groups.
The flags are not decoration: `--locked` and `-A clippy::result_large_err` are what CI passes, and
without them you will chase a lockfile CI would reject or a lint CI suppresses.
-->

- [ ] **Rust** (`*.rs`, `Cargo.*`, `deny.toml`, `rust-toolchain.toml`) — `cargo fmt --all --check`;
      `SKIP_WASM_BUILD=1 cargo clippy --workspace --all-targets --locked -- -D warnings
      -A clippy::result_large_err`; `cargo test --workspace --locked`;
      `cargo build --workspace --locked`; `SKIP_WASM_BUILD=1 cargo check --locked
      -p cogno-chain-node --features runtime-benchmarks`
- [ ] **On-wire surface + supply chain** (same trigger) — `./scripts/check-metadata.sh` (it needs a
      node binary built from this commit); `cargo deny check advisories bans sources`
- [ ] **Contracts** (`contracts/`, plus the aiken compiler pin in `.github/workflows/ci.yml`) —
      `cd contracts && script -qec "aiken check" /dev/null`, then the live-hash guard CI applies:
      `aiken build && git diff --exit-code plutus.json`
- [ ] **Frontend** (`app/`, plus `runtime/src/lib.rs` — a spec bump re-runs `npm run lint`'s
      check-spec gate) — `npm ci && npm run lint && npx tsc --noEmit --incremental false &&
      npm test && npm run build && npm run smoke`
- [ ] **CIP-8 oracle** (`ci/cip8-oracle/`, `app/scripts/`, `app/package*.json`,
      `pallets/cogno-gate/`) — the two installs CI does first: `(cd app && npm ci)` for the MeshJS
      fixture the agreement test shells out to, and `pip install -r requirements.txt` from
      `ci/cip8-oracle/` for pycardano (a venv if you'd rather not install it globally); then, from
      `ci/cip8-oracle/`: `python test_beacon.py && python test_agreement.py && python
      test_role_payload.py`

## Checklist

- [ ] Commit messages follow `<scope>(<area>): <summary>`.
- [ ] **Encoding discipline:** if this touches runtime calls/storage/events/extensions, `spec_version`
      was bumped, the PAPI descriptors were regenerated against a **local dev** node, the metadata
      snapshot was re-taken (`./scripts/check-metadata.sh --write`), and `DESCRIPTOR_SPEC_VERSION` in
      `app/src/lib/chain/client.ts` moved in lockstep. If it does **not**, `spec_version` was left
      unchanged. `transaction_version` moves only on a call-arg or `TxExtension` change.
- [ ] **Nothing renumbered** — pallet indices (6 and 12 stay permanently vacant), call indices, and the
      explicit `#[codec(index = N)]` on every Event/Error variant. A retired variant leaves a gap; new
      variants are appended and pinned, never slotted into one.
- [ ] **No new sudo / privileged escape hatch** — privileged calls still go through the 3-of-5
      committee.
- [ ] **If `contracts/` changed:** the `hash` fields in `plutus.json` are unchanged (CI diffs that
      file), **and** both pinned copies — `contracts/vault.json` and the frontend's
      `app/src/lib/cardano/vault.json` — were verified with `node contracts/scripts/regen-vault.mjs
      --verify`, which recomputes the applied hash, writes nothing, and exits 1 on drift. No workflow
      checks either file, and a moved hash orphans the live preprod vault. An intentional redeploy is
      explained in the summary.
- [ ] Docs updated where behavior changed.
