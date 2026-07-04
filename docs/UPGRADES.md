# Upgrading a running cogno-chain

How to evolve a live chain (add features, fix bugs) without splitting it. The terms "soft/hard
fork" mean something specific here — different from Bitcoin/Ethereum — so read the model first.
There is **no sudo**: runtime upgrades go through the committee-gated `governed-upgrade` pallet.

## The model: runtime vs node

Two separable things. Conflating them is what makes upgrades feel scary.

| | The **runtime** (business logic) | The **node** (the binary) |
|---|---|---|
| What | the Wasm in `runtime/` — pallets, calls, storage | `cogno-chain-node` — networking, DB, Aura/GRANDPA, the Wasm executor |
| Lives | **on-chain**, in state under `:code` | on each operator's **disk** |
| Upgrades via | **forkless + sudo-free** — committee `upgrade authorize` + permissionless `upgrade apply` | out-of-band — operators `cargo build` + restart |

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

A normal feature — a "bookmarks" `pallet-bookmarks`, say — is **soft**. Pallets don't add host
functions; the new runtime runs on existing validator binaries unchanged.

## Soft path — forkless runtime upgrade

1. Build the feature (new pallet at a **new** `pallet_index`, or changes to existing pallets).
2. Bump **`spec_version`** in [`../runtime/src/lib.rs`](../runtime/src/lib.rs) (e.g. 201 → 202) and
   add a changelog comment like the existing ones. Bump **`transaction_version`** *only* if the
   extrinsic **encoding** changed (a new `TransactionExtension`, or changed call args) — adding a new
   call does **not** change it.
3. Write a storage **migration** if you changed the layout of *existing* storage (see below). Purely
   additive storage (a new pallet's empty maps) needs none.
4. `cargo build --release` — **plain, default features**. A `--features runtime-benchmarks` build
   produces a runtime a normal node can't execute, and the spec embeds the runtime; build the spec
   and run the node with the *same* clean binary. The artifact is
   `target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm`.
5. **`try-runtime`** dry-run against a snapshot of **live** state (it is wired — see below). A
   migration that passes on a fresh `--dev` chain can still panic on real accumulated state.
6. Enact — the **sudo-free, two-step** path (there is no `system.set_code` you can reach; it needs
   Root and there is no Root/sudo origin):
   ```bash
   CLI=./target/release/cogno-chain-cli ; WS=ws://<host>:9944 ; WASM=<the .compact.compressed.wasm>
   # (a) committee authorizes the code HASH (a 3-of-5 FollowerCommittee motion → GovernedUpgrade@7):
   $CLI upgrade authorize --wasm "$WASM" --committee-signing-key-file seat1.skey --ws $WS
   # (b) anyone uploads the WASM to enact it (permissionless; refuses a non-increasing spec_version):
   $CLI upgrade apply --account-signing-key-file val-account.skey --wasm "$WASM" --ws $WS
   ```
   The new runtime is live at the block that includes `apply`, for all nodes at once.
7. Resync metadata-coupled clients (none of these are forks — they're clients catching up):
   - frontend: `rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://…)`,
     then redeploy the SPA.
   - `cogno-chain-cli` builds **typed `RuntimeCall`s from the statically-compiled runtime crate** (not
     dynamic on-chain metadata), so after an **encoding-affecting** upgrade rebuild the CLI against the
     new runtime; a non-encoding change needs no CLI rebuild.

An upgrade **does not change the genesis hash** — genesis is block #0, immutable. Only starting a
brand-new chain changes it.

> `upgrade apply` is a normal signed extrinsic: once it's in a finalized block, the new `:code` is law
> — there's no per-node opt-in vote (unlike Ethereum clients). A runtime that panics during block
> execution **halts the chain**. That's why step 5 (`try-runtime`) is non-negotiable for anything
> touching storage. `apply` itself refuses a non-increasing `spec_version` on-chain.

## Hard path — coordinated node upgrade

When the new runtime needs new host functions or you changed consensus, old binaries **stop
importing blocks the moment that runtime enacts**. Sequencing is everything:

1. Publish the new node binary + a **target enactment window** (or just "after everyone confirms").
2. Each validator upgrades its binary and restarts on the **current** runtime. Old and new binaries
   coexist fine here — they're all still running the *same old runtime*.
3. Confirm **≥ 2/3 of validators** are on the new binary and healthy.
4. *Then* run `upgrade apply` (after the committee `authorize`).

The danger window is enacting while validators are still on an incompatible binary. With GRANDPA,
if **more than 1/3 of authorities** can't follow, **finality stalls** (blocks may still be produced,
but nothing finalizes). On this chain that bites fast: `MinAuthorities = 1`, equivocation reporting
is a no-op, and there is no slashing — coordination is purely operational. See
[`ARCHITECTURE.md`](ARCHITECTURE.md) (Trust posture).

## Encoding contracts (keep these stable)

- **`spec_version`** — bump on any logic/metadata change (currently **201**).
- **`transaction_version`** — bump *only* on extrinsic-encoding changes. Keeping it stable means
  in-flight signed txs and signing tooling don't break. (It is **3**: bumped 1→2 when the
  `CheckCapacity` extension was added, then 2→3 at spec 118 when `pallet-profile`'s `set_profile`
  gained call args.)
- **Pallet indices are forever** ([`../runtime/src/lib.rs`](../runtime/src/lib.rs)). A new pallet gets
  a **new** index; never renumber existing ones. Indices **6** (Sudo, removed) and **12** (Anchor,
  removed) are permanently vacant; **7** is GovernedUpgrade. FRAME allows gaps, so on-wire indices
  never shift.

## Storage migrations

Adding a *new* pallet's storage needs no migration (empty maps). Changing the layout of *existing*
storage does — ship an `OnRuntimeUpgrade` migration that runs **once, at the enactment block**, to
rewrite old state into the new shape, gated by the pallet's `StorageVersion`. Without it, execution
panics decoding old data and the chain halts.

- Wire a custom migration through `frame_system::Config::SingleBlockMigrations`
  ([`../runtime/src/configs/mod.rs`](../runtime/src/configs/mod.rs), currently `type
  SingleBlockMigrations = ();`) — e.g. `type SingleBlockMigrations = (MyVersionedMigration,);`. That is
  the runtime's dedicated one-shot-migrations slot, run once at the enactment block ahead of the
  per-pallet `StorageVersion`-gated hooks in `AllPalletsWithSystem`.
- **`try-runtime` is wired** ([`../runtime/Cargo.toml`](../runtime/Cargo.toml),
  [`../node/Cargo.toml`](../node/Cargo.toml)). Build with `--features try-runtime` and dry-run
  `on-runtime-upgrade` against a live state snapshot before enacting.

## Governance & enactment — sudo-free by construction

There is **no Root and no sudo**. `AuthorityOrigin` is the **3-of-5 `FollowerCommittee` only** (no
`EnsureRoot` fallback — [`../runtime/src/configs/mod.rs`](../runtime/src/configs/mod.rs)), and runtime
upgrades are **already routed through it**: `governed-upgrade`'s `authorize_upgrade(code_hash)` is
`AuthorityOrigin`-gated (the `upgrade authorize` motion), and the WASM is enacted by the permissionless,
spec-checked `System::apply_authorized_upgrade` (the `upgrade apply` step). `frame_system::set_code` /
`set_storage` / `kill_storage` are unreachable by design.

What remains **operational policy**, not code:

- **Coordinate hard upgrades manually** — the `apply` step is immediate once authorized, so for a
  host-function/consensus change get ≥2/3 of validators onto the new binary *before* anyone runs
  `apply`. A scheduled enactment delay (e.g. `pallet-scheduler` between `authorize` and `apply`) is a
  possible future enhancement to make that window enforced rather than agreed.
- **Split the committee across custodians** so "3-of-5 controls upgrades" is real — see
  [`D2-custody-runbook.md`](D2-custody-runbook.md).

This is the social layer that makes an evolving multi-operator chain actually hard — the Substrate
mechanics above are the easy part.

## Worked example: adding a "bookmarks" pallet

1. New `pallet-bookmarks` at a new index (e.g. 18); its own (initially empty) storage → **no migration**.
2. `spec_version` 201 → 202; `transaction_version` stays 3 (a new call is not an encoding change).
3. `cargo build --release` (clean). No new host functions → **soft**: existing validator binaries run
   it unchanged, no coordinated node upgrade.
4. `try-runtime` against a preprod snapshot.
5. `cogno-chain-cli upgrade authorize --wasm <wasm> --committee-signing-key-file seat1.skey` then
   `cogno-chain-cli upgrade apply --account-signing-key-file val-account.skey --wasm <wasm>` → live at
   the `apply` block, all validators atomically.
6. Regen PAPI descriptors + redeploy SPA (the node serves the new reads directly — no indexer to touch).

## Gotchas checklist

- [ ] Built **clean** (`cargo build --release`, no `runtime-benchmarks`).
- [ ] `spec_version` bumped; `transaction_version` bumped **only if** encoding changed.
- [ ] New pallet at a **new** index; no existing index renumbered (6 + 12 stay vacant).
- [ ] Migration written (via `SingleBlockMigrations`) + `try-runtime`-tested if existing storage changed.
- [ ] If host functions / consensus changed → **hard path**: roll binaries (≥2/3) *before* `apply`.
- [ ] `upgrade authorize` (committee) done, then permissionless `upgrade apply`.
- [ ] PAPI descriptors regenerated; SPA redeployed; CLI rebuilt if the encoding changed.
- [ ] Genesis pin left alone (an upgrade doesn't change it).
