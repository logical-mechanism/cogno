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
An offline **aye** also needs `--call <hex>`: that seat has no endpoint to fetch the motion's preimage
from, so it carries the call hex in (`committee list` prints it as `call-hex`) and the CLI re-hashes it
against `--proposal` before signing. The check is local, so it holds even if the host that printed the
hex lied. A `--reject` does not require it, because a nay can only ever block a motion.

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

## When the observer's config grows a field: runtime FIRST, binary SECOND

This is the exact reverse of the hard-upgrade drill above, and it has now caught us three times (spec
115, 215, 220). It applies whenever a spec appends a field to `ObserverConfig` — the struct the
node-side observation provider reads through the `CardanoObserverApi` runtime API.

sp-api decodes a runtime-API return with plain `Decode::decode`, not `decode_all`, so trailing bytes
are ignored. That makes the compatibility one-directional:

- **Old binary + new runtime — fine.** The old struct decodes the fields it knows and ignores the
  appended one. This is an ordinary soft upgrade.
- **New binary + old runtime — the observer stops.** The old payload is short, decoding fails, and
  `observe_for_parent` abstains (`node/src/service.rs`). No inherent is produced on any block, so the
  sole weight writer freezes chain-wide and importer verification goes quiet — until the runtime
  upgrade enacts and unsticks it.

So the order is:

1. `authorize` + `apply` the runtime. Every node keeps running its existing binary throughout.
2. *Then* rebuild and restart the node binaries, for the new metrics and log lines.
3. *Then* deploy the frontend (`DESCRIPTOR_SPEC_VERSION` blocks posting against a mismatched chain).

The hard-upgrade drill above is scoped to consensus and host-function changes. It does not apply to a
runtime-API field append, and following it here is what causes the freeze.

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
- **Deleting a storage item is a layout change too.** Dropping the `#[pallet::storage]` declaration
  stops the writes; it does not remove what is already there. Those rows stay in state and in every
  state root, under a prefix nothing declares any more — invisible to `try_state` and to `post_upgrade`,
  and one accidental re-declaration away from coming back. Ship a sweep, versioned like any other
  migration: `pallet_cogno_gate::migrations::v1` (spec 212) is the worked example.

### The dry-run against live state

**Do this before every enactment that carries a migration.** CI does *not* gate on it, and a migration
that passes its own unit tests on a fresh `--dev` chain can still be wrong against real accumulated
state — spec 212's first cut of `microblog::migrations::v10` addressed the wrong storage prefix, passed
every unit test (they wrote and read through that same wrong prefix, so they agreed with themselves),
and only this run caught it.

It needs a **separate build**: `--features try-runtime` is what compiles the `pre_upgrade` /
`post_upgrade` / `try_state` hooks that are the entire safety net. That WASM is for the dry-run only —
never enact it.

```bash
cargo install --git https://github.com/paritytech/try-runtime-cli --locked   # once
cargo build --release --features try-runtime                                 # NOT the enactment blob

# Sync a local tracking node first (see below for why), then point the dry-run at IT:
scripts/run-tracking-node.sh &                                               # syncs to tip over P2P

try-runtime --runtime target/release/wbuild/cogno-chain-runtime/cogno_chain_runtime.wasm \
  on-runtime-upgrade --checks all --blocktime 6000 \
  live --uri ws://127.0.0.1:9944
```

`--checks all` is the point — it runs the pre/post hooks *and* `try_state` over the whole migrated
state. `live` pulls a state snapshot over RPC (read-only; it never submits anything). Add
`--snapshot-path state.snap` on a first run to reuse the snapshot for later iterations instead of
re-downloading. Read the output for `post_upgrade` failures **and** for the weight warnings: a
single-block migration reports its weight after the fact, so an under-count is not something the block
limiter can catch for you.

**Scrape from a LOCAL node, not `wss://cogno.forum/rpc`.** The public endpoint rate-limits, and
`remote-ext` answers a throttled batch by *logging* `Value worker N: batch item error: RPC rate limit
exceeded` and carrying on — so it hands you a snapshot with holes and try-runtime then reports a
`try_state` failure in whichever pallet happened to lose a value. That failure is indistinguishable from
a real one: the spec-215 dry-run against the public RPC failed with `"a TopLevelByAuthor entry is missing
or is not top-level"` on all four attempts (7–9 rate-limit errors each), while the same runtime against a
locally-synced node passed every pallet's `try_state` and exited 0. Live state was independently verified
consistent. A truncated scrape is the one failure mode that makes this gate lie in *both* directions, so
if you see a `try_state` error, confirm the scrape was clean before believing it.

Enact only after this passes — then build the enactment WASM **clean**, with no `try-runtime` and no
`runtime-benchmarks` feature.

## Version rules

- **`spec_version`** — bump on any logic/storage/metadata change (currently **220**). `apply` rejects
  a non-increasing value on-chain.
- **`transaction_version`** — bump *only* when the extrinsic encoding changes (a new transaction
  extension, or changed call arguments — removing an argument counts, removing a whole call does
  not). Adding a new call does **not** change it. Keeping it stable means in-flight signed
  transactions and signing tools don't break. (Currently **8** — spec 215 turned `observe`'s three
  full-snapshot vectors into bounded change vectors, which is a call-argument change.)
- **Pallet indices are forever.** A new pallet gets a new index; never renumber. Indices 6 (Sudo) and
  12 (Anchor) are permanently vacant — gaps are fine.

## After an encoding change

Regenerate the frontend's typed descriptors and redeploy, and rebuild the CLI (it builds calls from
the compiled runtime, not live metadata):

```bash
rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)
```

## After ANY spec bump: re-snapshot the metadata

CI diffs the committed `app/.papi/metadata/cogno.scale` against a freshly built runtime. That snapshot
is the strongest pin the repo has on every on-wire index — pallet, call, and (because SCALE indexes
enum variants by declaration order) every event and error variant. A reorder that no test would catch
fails this gate.

It also means **every** spec bump moves the snapshot by one byte, because `System::Version` embeds the
`RuntimeVersion` and therefore the `spec_version` itself. So after a bump:

```bash
cargo build --release            # the gate needs a node binary
./scripts/check-metadata.sh      # verify — tells you WHAT moved
./scripts/check-metadata.sh --write   # re-snapshot, once you've read what moved
```

Read the output before you re-snapshot. A **single** differing byte is the signature of a plain
`spec_version` bump — no type, call, storage item or event changed shape, so the PAPI descriptors need
no regeneration. **More** than that means something moved that a client can observe: re-check
`transaction_version` (a call *argument* change moves it; adding or removing a whole call does not)
and regenerate the descriptors per the section above. If you did not intend a shape change, do not
re-snapshot — the gate has just caught a silent on-wire break.

Re-snapshot with this script rather than `papi add -w ws://…`: that command writes the node it was
pointed at back into `app/.papi/polkadot-api.json` (`wsUrl`, plus that chain's `genesis` and
`codeHash`), and once those are committed a later `papi generate` resolves against a local dev node
instead of the committed metadata.
