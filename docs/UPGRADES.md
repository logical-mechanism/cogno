# Upgrading a running chain

How to ship new runtime code to a live cogno-chain. There is **no sudo** — every upgrade is a
committee motion plus one permissionless step. It comes down to two commands:

```bash
CLI=./target/release/cogno-chain-cli ; WS=ws://<host>:9944
WASM=target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm

$CLI upgrade authorize --wasm "$WASM" --committee-signing-key-file seat.skey --ws $WS  # 1. approve
$CLI upgrade apply     --wasm "$WASM" --account-signing-key-file acct.skey    --ws $WS  # 2. enact
```

Step 1 (`authorize`) is a committee decision that records the code hash. Step 2 (`apply`) uploads the
WASM to enact it — anyone can run it, and the chain refuses a `spec_version` that isn't higher than
what's already running. The new runtime is live at the block that includes `apply`, for every node at
once.

## Two things you can upgrade

- **The runtime** — the WASM (pallets, calls, storage) that lives *on-chain*. It upgrades with the
  two commands above and switches atomically at one block height for the whole network. This is the
  normal case.
- **The node** — the `cogno-chain-node` binary on each operator's disk. It upgrades out-of-band:
  operators `cargo build` and restart. Only needed for the "hard" changes below.

## Soft vs. hard

- **Soft (almost everything):** adding a pallet, call, storage, event, weight, or a bound. Existing
  node binaries run the new runtime unchanged — just do the two commands.
- **Hard (rare):** you changed consensus (Aura/GRANDPA/networking) or added a host function (e.g. a
  benchmarking build). Old binaries **can't execute the new runtime**, so operators must upgrade their
  binaries *first* — see [Hard upgrades](#hard-upgrades).

## Single operator

You hold all the committee seats (or a one-seat committee), so a motion executes the moment you
propose it. `authorize` is effectively one command, then `apply`:

```bash
$CLI upgrade authorize --wasm "$WASM" --committee-signing-key-file seat.skey --ws $WS
$CLI upgrade apply     --wasm "$WASM" --account-signing-key-file acct.skey    --ws $WS
```

## Multiple operators (3-of-5 committee)

`authorize` now needs **3 of 5** seats to agree before it takes effect. There is no `committee propose`
subcommand: multi-custody is the **`--propose` flag on the governed verb itself**. One seat opens the
motion with its own key; the others co-sign from their own hosts with `committee vote`; any seat closes
it. Both `vote` and `close` need the motion's `--proposal` hash **and** its `--index` — `propose` prints
both, and `committee list` re-prints them for any open motion.

```bash
# 1. one seat opens the motion (prints the motion hash + index and the co-sign lines)
$CLI upgrade authorize --wasm "$WASM" --propose --committee-signing-key-file seat1.skey --ws $WS

# (any seat can rediscover an open motion's hash + index at any time)
$CLI committee list --ws $WS

# 2. two more seats co-sign — aye is the default; --reject votes nay
$CLI committee vote --proposal <hash> --index <n> --committee-signing-key-file seat2.skey --ws $WS
$CLI committee vote --proposal <hash> --index <n> --committee-signing-key-file seat3.skey --ws $WS

# 3. any seat closes it — at threshold the inner authorize executes
$CLI committee close --proposal <hash> --index <n> --committee-signing-key-file seat1.skey --ws $WS

# 4. then anyone runs the permissionless enactment:
$CLI upgrade apply --wasm "$WASM" --account-signing-key-file acct.skey --ws $WS
```

`--propose` is the generic multi-custody flag on every committee-governed verb (`upgrade authorize`,
`validator add`/`remove`, `fuel set-allowance`/`revoke`, `committee members …`, `identity revoke`).
Without it, the CLI bundles every seat key on one host and runs `propose → vote → close` itself — which
is the single-operator default, and exactly what you do *not* want once the seats are real custodians.
An air-gapped seat can `committee vote --offline` and hand the signed extrinsic to `committee submit`.

> **Fuel:** whoever signs `authorize`/`apply` pays the fee in governance fuel. Genesis committee
> accounts are pre-funded; any account added later needs a committee-granted allowance first
> (`fuel set-allowance`).

## Hard upgrades

When the change is hard (consensus or a new host function), sequencing matters — enacting while
validators run an incompatible binary stalls finality:

1. Publish the new node binary.
2. Every validator upgrades its binary and restarts (they keep running the *current* runtime — old and
   new binaries coexist fine here).
3. Confirm **≥ 2/3 of validators** are on the new binary.
4. *Then* run the committee `authorize` + `apply`.

## Building the WASM

Build **clean** — `cargo build --release`, no `--features runtime-benchmarks` (a benchmarks build
produces a runtime a normal node can't execute). The artifact is at:

```
target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.compact.compressed.wasm
```

**The runtime is not reproducibly built.** `cargo build --release` of a Substrate runtime is not
byte-identical across machines, and nothing in CI publishes the blob's hash. So a committee seat voting
on a `code_hash` is trusting whoever built the WASM, and a third party cannot independently confirm the
hash on-chain corresponds to a reviewed commit. Closing this means a deterministic container build
(srtool or a pinned image) that publishes the runtime hash — an open gap, not a solved one.

## Storage migrations

If you changed the layout of *existing* storage, ship an `OnRuntimeUpgrade` migration or the chain
**halts** decoding old data. Adding a *new* pallet's (empty) storage needs none.

- Wire the migration through `frame_system::Config::SingleBlockMigrations` in
  [`../runtime/src/configs/mod.rs`](../runtime/src/configs/mod.rs) — it runs once, at the enactment
  block.
- **`try-runtime` is wired.** Build with `--features try-runtime` and dry-run the migration against a
  snapshot of live state before you enact. A migration that passes on a fresh `--dev` chain can still
  panic on real accumulated state.

## Version rules

- **`spec_version`** — bump on any logic/storage/metadata change (currently **204**). `apply` rejects
  a non-increasing value on-chain.
- **`transaction_version`** — bump *only* when the extrinsic encoding changes (a new transaction
  extension, or changed call arguments). Adding a new call does **not** change it. Keeping it stable
  means in-flight signed transactions and signing tools don't break. (Currently **3**.)
- **Pallet indices are forever.** A new pallet gets a new index; never renumber. Indices 6 (Sudo) and
  12 (Anchor) are permanently vacant — gaps are fine.

## After an encoding change

Regenerate the frontend's typed descriptors and redeploy, and rebuild the CLI (it builds calls from
the compiled runtime, not live metadata):

```bash
rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)
```
