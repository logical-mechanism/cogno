# Upgrading a running cogno-chain

How to evolve a live chain (add features, fix bugs) without splitting it. The terms "soft/hard
fork" mean something specific here — different from Bitcoin/Ethereum — so read the model first.

## The model: runtime vs node

Two separable things. Conflating them is what makes upgrades feel scary.

| | The **runtime** (business logic) | The **node** (the binary) |
|---|---|---|
| What | the Wasm in `runtime/` — pallets, calls, storage | `cogno-chain-node` — networking, DB, Aura/GRANDPA, the Wasm executor |
| Lives | **on-chain**, in state under `:code` | on each operator's **disk** |
| Upgrades via | **forkless** — one extrinsic (`system.set_code`) | out-of-band — operators `cargo build` + restart |

Because the runtime is shared chain state, a runtime-only change switches **atomically at one block
height, network-wide** — every node loads the same `:code`. A validator on an *old node binary*
still runs the *new runtime*. So a runtime-only upgrade **cannot** create a "some validators on new,
some on old" runtime split. That only happens when the new runtime needs something the old *binary*
can't provide (below).

## Decision tree: is this soft or hard?

```
Did the change touch host functions or consensus (Aura/GRANDPA/networking/block-import)?
│
├─ NO  → SOFT. Runtime-only forkless upgrade. Old node binaries keep following.
│        (Adding a pallet, a call, storage, an event, weights, a bound, logging → SOFT.)
│
└─ YES → HARD. Old binaries can't execute the new runtime. Roll binaries FIRST, enact SECOND.
         (New host function — e.g. the `ext_benchmarking_*` imports a benchmarks build needs;
          changes to consensus or the p2p protocol.)
```

A normal feature — a "profile creator" `pallet-profile`, say — is **soft**. Pallets don't add host
functions; the new runtime runs on existing validator binaries unchanged.

## Soft path — forkless runtime upgrade

1. Build the feature (new pallet at a **new** `pallet_index`, or changes to existing pallets).
2. Bump **`spec_version`** in [`../runtime/src/lib.rs`](../runtime/src/lib.rs) (e.g. 107 → 108) and
   add a changelog comment like the existing ones. Bump **`transaction_version`** *only* if the
   extrinsic **encoding** changed (a new `TransactionExtension`, or changed call args) — adding a new
   call does **not** change it.
3. Write a storage **migration** if you changed the layout of *existing* storage (see below). Purely
   additive storage (a new pallet's empty maps) needs none.
4. `cargo build --release` — **plain, default features**. A `--features runtime-benchmarks` build
   produces a runtime a normal node can't execute, and the spec embeds the runtime; build the spec
   and run the node with the *same* clean binary.
5. **`try-runtime`** dry-run against a snapshot of **live** state (it is wired — see below). A
   migration that passes on a fresh `--dev` chain can still panic on real accumulated state.
6. Enact: `sudo.sudo(system.set_code(<new_wasm>))` (or via the committee). The new runtime is live at
   the **next block**, for all nodes at once.
7. Resync metadata-coupled clients (none of these are forks — they're clients catching up):
   - frontend: `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://…)`,
     then redeploy the SPA.
   - indexer: extend the SubQuery mappings for any new events, rebuild.
   - committee tooling uses dynamic metadata (`@polkadot/api`) — it auto-adapts, no regen.

A `set_code` upgrade **does not change the genesis hash** — genesis is block #0, immutable. The
indexer's `GENESIS` pin survives upgrades; you only re-pin when starting a brand-new chain.

> A `set_code` is a normal extrinsic: once it's in a finalized block, it's law — there's no per-node
> opt-in vote (unlike Ethereum clients). A runtime that panics during block execution **halts the
> chain**. That's why step 5 (`try-runtime`) is non-negotiable for anything touching storage.

## Hard path — coordinated node upgrade

When the new runtime needs new host functions or you changed consensus, old binaries **stop
importing blocks the moment that runtime enacts**. Sequencing is everything:

1. Publish the new node binary + a **target enactment block** (or just "after everyone confirms").
2. Each validator upgrades its binary and restarts on the **current** runtime. Old and new binaries
   coexist fine here — they're all still running the *same old runtime*.
3. Confirm **≥ 2/3 of validators** are on the new binary and healthy.
4. *Then* enact the `set_code`.

The danger window is enacting while validators are still on an incompatible binary. With GRANDPA,
if **more than 1/3 of authorities** can't follow, **finality stalls** (blocks may still be produced,
but nothing finalizes). On this chain that bites fast: `MinAuthorities = 1`, equivocation reporting
is a no-op, and there is no slashing — coordination is purely operational. See
[`L3-SPO-graduation.md`](L3-SPO-graduation.md).

## Encoding contracts (keep these stable)

- **`spec_version`** — bump on any logic/metadata change.
- **`transaction_version`** — bump *only* on extrinsic-encoding changes. Keeping it stable means
  in-flight signed txs and signing tooling don't break. (It is `2` — bumped 1→2 only when the
  `CheckCapacity` extension was added.)
- **Pallet indices are forever** ([`../runtime/src/lib.rs`](../runtime/src/lib.rs)). A new pallet gets
  a **new** index; never renumber existing ones. Index 7 is vacant (dropped `pallet-template`) —
  FRAME allows gaps, so on-wire indices never shift.

## Storage migrations

Adding a *new* pallet's storage needs no migration (empty maps). Changing the layout of *existing*
storage does — ship an `OnRuntimeUpgrade` migration that runs **once, at the enactment block**, to
rewrite old state into the new shape, gated by the pallet's `StorageVersion`. Without it, execution
panics decoding old data and the chain halts.

- Today `Executive` passes `AllPalletsWithSystem` as the migrations slot
  ([`../runtime/src/lib.rs`](../runtime/src/lib.rs)) — i.e. only per-pallet `StorageVersion`-gated
  hooks. Add a custom migration as the 5th `Executive` generic: `Executive<…, AllPalletsWithSystem,
  (Migration1, Migration2)>`.
- **`try-runtime` is wired** ([`../runtime/Cargo.toml`](../runtime/Cargo.toml),
  [`../node/Cargo.toml`](../node/Cargo.toml)). Build with `--features try-runtime` and dry-run
  `on-runtime-upgrade` against a live state snapshot before enacting.

## Governance & enactment

`system.set_code` requires **Root → sudo today**. The crown-jewel origin
`AuthorityOrigin = EnsureRoot OR ≥3/5 committee` exists ([`../runtime/src/configs/mod.rs`](../runtime/src/configs/mod.rs)),
but runtime upgrades are not yet routed through it. For a multi-operator chain:

- Route `set_code` behind the committee (or a dedicated governance origin) instead of bare sudo.
- Add a **scheduled enactment delay** (e.g. `pallet-scheduler`) so there's a public window between
  "approved" and "live" for validators to ready their binaries — forklessness with no delay can
  enact a hard-fork-class change before stragglers upgrade, stalling finality.

This is the social layer that makes an evolving multi-operator chain actually hard — the Substrate
mechanics above are the easy part.

## Worked example: adding a "profile creator"

1. New `pallet-profile` at a new index; its own (initially empty) storage → **no migration**.
2. `spec_version` 107 → 108; `transaction_version` stays 2 (no extension change).
3. `cargo build --release` (clean). No new host functions → **soft**: existing validator binaries run
   it unchanged, no coordinated node upgrade.
4. `try-runtime` against a preprod snapshot.
5. `sudo.sudo(system.set_code(new_wasm))` → live next block, all validators atomically.
6. Regen PAPI descriptors + redeploy SPA; extend indexer mappings for `Profile*` events.

## Gotchas checklist

- [ ] Built **clean** (`cargo build --release`, no `runtime-benchmarks`).
- [ ] `spec_version` bumped; `transaction_version` bumped **only if** encoding changed.
- [ ] New pallet at a **new** index; no existing index renumbered.
- [ ] Migration written + `try-runtime`-tested if existing storage layout changed.
- [ ] If host functions / consensus changed → **hard path**: roll binaries (≥2/3) *before* enacting.
- [ ] PAPI descriptors regenerated; indexer mappings updated; SPA redeployed.
- [ ] Genesis pin left alone (a `set_code` upgrade doesn't change it).
