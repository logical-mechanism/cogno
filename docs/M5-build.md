# M5 — Benchmark + Decentralize (mutable authorities)

> **Status: DONE (2026-06-17), verified locally end-to-end.** The FINAL milestone in
> `PLAN.md` §8 (M0 → M1 → M2 → M2c → M2d → M3 → M4 → **M5**). M5 makes the chain
> **non-dev-ready**: it replaces the placeholder weights with **real FRAME benchmarks** (so the
> feeless + capacity anti-spam is actually backed) and makes the crown-jewel authorities
> **mutable / k-of-t** (off single-key-sudo toward a 3-of-5 committee with rotation + an
> audit log). Resolves **DR-05** (benchmark `post_message` et al.), **DR-07** (mutable k-of-t
> authorities), **DR-06** (clamp/largest-wins property tests), and **DR-34** (doc cleanup).
>
> **Runtime: spec_version 104 → 105, transaction_version UNCHANGED (2)** — a new pallet +
> origin config is encoding-affecting (regen PAPI descriptors), but no `TxExtension` change.
> Builds on [M3](M3-build.md)/[M4](M4-build.md). See `docs/L3-chain.md` §5.4 (the backstop),
> §8 (decentralization), and `docs/DECISION-REGISTER.md` DR-05/06/07/34.

---

## 0. What changed (at a glance)

| Area | Before M5 | After M5 |
|---|---|---|
| Weights | Hand-set placeholders ("NOT benchmarked", every `weights.rs`) | **Real FRAME benchmarks** for `post_message`(len-parameterized)/`delete_post`/`force_set_capacity`/`check_capacity`, `link_identity`/`revoke`, `set_stake`, `anchor_ack` |
| `CheckCapacity` extension weight | `Weight::zero()` (the gate's reads/writes were **uncounted** → silent free-spam headroom) | **Real** `WeightInfo::check_capacity()` (its `AllowedStake`+`Capacity` reads + `Capacity` write are now in the block-weight backstop) |
| Crown-jewel origins | bare `EnsureRoot<AccountId>` (single-key sudo) | `EitherOfDiverse<EnsureRoot, EnsureProportionAtLeast<FollowerCommittee, 3, 5>>` (sudo retained as the v1 dev fallback) |
| Pallets | 0..12 (Anchor @12 the highest) | + `FollowerCommittee = pallet_collective<Instance1>` **@13** |
| Anti-spam bound | "asserted, not proven" (L3 §5.4) | **proven**: `posts_per_block_max ≈ 2,677` (gate-inclusive) |

---

## 1. DR-05 — Benchmark the custom extrinsics → real `WeightInfo`

### 1.1 The pipeline (grounded against the pinned SDK, not assumed)

- Toolchain pinned (rustc 1.90.0, `polkadot-stable2603-3`, committed `Cargo.lock`). The node already
  wires `frame_benchmarking_cli::BenchmarkCmd::Pallet` (`node/src/command.rs`), so the integrated
  `./cogno-chain-node benchmark pallet` path works once built `--features runtime-benchmarks`. No
  `frame-omni-bencher` needed.
- Per pallet (`microblog`, `cogno-gate`, `talk-stake`, `anchor`): added `frame-benchmarking`
  (optional dep) + `frame-benchmarking?/std` + `frame-benchmarking/runtime-benchmarks`;
  `#[cfg(feature = "runtime-benchmarks")] mod benchmarking;`; a v2 `#[benchmarks]` module.
- Registered all four in the runtime's `define_benchmarks!` (`runtime/src/benchmarks.rs`).
- Generated `weights.rs` with the **stock frame weight template**
  `_sdk/substrate/.maintain/frame-weight-template.hbs` (emits the exact `WeightInfo` trait +
  `SubstrateWeight<T>` + `impl WeightInfo for ()` shape the runtime + mocks already used → drop-in;
  the runtime wiring `pallet_x::weights::SubstrateWeight<Runtime>` is unchanged).

```
cargo build --release -p cogno-chain-node --features runtime-benchmarks
./target/release/cogno-chain-node benchmark pallet \
  --chain dev --pallet pallet_microblog --extrinsic '*' \
  --steps 50 --repeat 20 --wasm-execution compiled \
  --template _sdk/substrate/.maintain/frame-weight-template.hbs \
  --output pallets/microblog/src/weights.rs        # (repeat for cogno_gate / talk_stake / anchor)
```

### 1.2 Two benchmarking subtleties that matter

1. **Benchmarking `post_message` through the REAL gate.** The body does
   `ensure!(T::IdentityGate::is_allowed(&who))`; against the runtime `IdentityGate = CognoGate`, so a
   `whitelisted_caller` is unbound → `NotAllowed` → the benchmark would fail. Fix: a
   `#[cfg(feature = "runtime-benchmarks")] fn benchmark_set_allowed(who)` hook on the `IsAllowed`
   trait (defined in microblog; implemented by cogno-gate = inserts `PkhOf`, no-op in the mock). The
   benchmark calls it in setup, so `post_message` is measured end-to-end through the live gate — and
   the generated weight includes the `CognoGate::PkhOf` read (`r:1`).
2. **The `CheckCapacity` extension was weighing ZERO.** `impl_tx_ext_default!(…; weight)` defaulted its
   weight to zero, so the gate's `AllowedStake`+`Capacity` reads (`validate()`) and `Capacity` write
   (`post_dispatch` `consume`) were **uncounted** — the exact L3 §5.4 dishonesty (the backstop would
   understate the only anti-spam). Fix: a dedicated `check_capacity` benchmark (a `#[block]` over
   `current_capacity` + `consume`) → `WeightInfo::check_capacity()`, and the extension now implements
   `fn weight()` returning it. So each feeless post tx is charged **body + gate**.

### 1.3 The benchmarked weights (RocksDbWeight: read 25M ps, write 100M ps)

| Pallet · extrinsic | exec (ps) | reads | writes | notes |
|---|---|---|---|---|
| microblog `post_message(s)` | `19_130_688 + 581·s` | 3 | 3 | incl. the gate `PkhOf` read; `s` = text len `0..512` |
| microblog `delete_post` | `17_391_000` | 2 | 2 | |
| microblog `force_set_capacity` | `17_041_000` | 1 | 1 | operator battery prime |
| microblog `check_capacity` (extension) | `15_782_000` | 2 | 1 | `AllowedStake`+`Capacity` reads, `Capacity` write |
| cogno-gate `link_identity` | `26_486_000` | 3 | 4 | worst case: writes `ThreadOf` too + `on_first_bind` |
| cogno-gate `revoke` | `14_796_000` | 1 | 3 | |
| talk-stake `set_stake` | `6_884_000` | 0 | 1 | single map write behind the gated origin |
| anchor `anchor_ack` | `8_803_000` | 1 | 1 | the advance path (worst case vs the AckIgnored no-op) |

### 1.4 The block-weight backstop is now PROVEN (L3 §5.4)

`RuntimeBlockWeights` = `with_sensible_defaults(2s, 75%)` → **Normal class budget = 1.5×10¹² ps**.
Worst-case feeless post (512 bytes), counting body **and** the `CheckCapacity` extension:

```
post_message(512)  = 19_130_688 + 581·512 + reads(3)·25M + writes(3)·100M = 394_428_160 ps
CheckCapacity ext  = 15_782_000          + reads(2)·25M + writes(1)·100M = 165_782_000 ps
per-post (body+gate)                                                      = 560_210_160 ps

posts_per_block_max = floor(0.75 · MAXBLOCK / per-post)
                    = floor(1_500_000_000_000 / 560_210_160)  ≈  2,677 posts / block
                    (body alone, ignoring the gate, would read ~3,802 — counting the gate is the honest figure)
```

This is the **ceiling the operator cannot exceed even by self-including over-budget posts** (the
case capacity does not cover). Real throughput is far lower — `CheckCapacity` rate-limits per-account
inflow at the pool. PoV does not bind (solochain, `proof_size` dimension = `u64::MAX`).

---

## 2. DR-07 — Mutable / k-of-t crown-jewel authorities

**Mechanism (chosen with the owner): `pallet-collective`** (the canonical `L3-chain.md` §8.3 / DR-07
path; battle-tested, lowest audit risk for a crown-jewel key). One shared instance
`FollowerCommittee = pallet_collective<Instance1>` at **runtime index 13**.

```rust
// runtime/src/configs/mod.rs — ONE shared authority origin for all four crown jewels:
pub type AuthorityOrigin =
    EitherOfDiverse<EnsureRoot<AccountId>, EnsureProportionAtLeast<AccountId, Instance1, 3, 5>>;

impl pallet_cogno_gate::Config { type FollowerOrigin = AuthorityOrigin; … }  // link_identity / revoke
impl pallet_talk_stake::Config { type SetStakeOrigin = AuthorityOrigin; … }  // set_stake
impl pallet_anchor::Config     { type AnchorOrigin   = AuthorityOrigin; … }  // anchor_ack
impl pallet_microblog::Config  { type ForceOrigin    = AuthorityOrigin; … }  // force_set_capacity
```

- **k-of-t = 3-of-5** (`EnsureProportionAtLeast<…, 3, 5>`, the DR-26 D2 number). A privileged call is
  executed by a committee motion: `propose → vote (×k) → close`.
- **Sudo retained as the v1 dev fallback** (`EitherOfDiverse<EnsureRoot, …>`) — so the everyday dev
  path is unchanged and the heavier committee flow is the *D2 capability*, wired and ready, not the
  daily driver. The widen was **signature-free** (the underlying origins were already `EnsureOrigin`).
- **Audit log = the proposal lifecycle** (`Proposed`/`Voted`/`Closed`/`Approved`/`Disapproved`/
  `Executed` events) — DR-07's D0 per-action requirement. The underlying pallets still emit their own
  action events (`StakeSet`, `IdentityLinked`/`Revoked`, `AnchorAcked`, `CapacityForced`).
- **Rotation = `Collective::set_members`** (gated by `SetMembersOrigin = EnsureRoot` in v1 → move to
  the committee itself / an Ariadne-SPO selection pallet at D2/D3, another signature-free swap).
- **Genesis**: the dev/local presets seat 5 members `[Alice, Bob, Charlie, Dave, Eve]` (all endowed,
  since propose/vote are fee-bearing). `MaxMembers = 7`, `MotionDuration = 7 days`,
  `MaxProposalWeight = 50% block`, `Consideration = ()` (permissioned committee, no proposal deposit).

> The block-producing **validator** set (Aura/GRANDPA) staying static genesis is the *other*
> decentralization axis (`L3-chain.md` §8.2, `pallet-session` + a validator-set pallet) — that remains
> a documented later step; M5 hardens the **authority origins** (the L2 follower / relayer crown
> jewels), which is the DR-07 scope.

---

## 3. DR-06 — Property tests (mock-runtime)

- **`talk-stake::set_stake_overwrites_never_sums_property`** — sweeps several follower re-observation
  sequences (raise / lower / repeated reorg-safe re-derives / unlock) and asserts `set_stake` is an
  idempotent **overwrite**, never an accumulation: after every write the stored weight == the
  just-written value, and for ≥2 nonzero observations it is strictly below the naive sum. This is the
  L3 guarantee that makes the follower's off-chain largest-wins / never-sum aggregation safe (no live
  double-dip).
- **`microblog::clamp_latency_at_most_grant_latency_property`** — sweeps weights and measures both
  latencies directly: a **grant** (0→W) is never instantaneous (capacity must regenerate over the
  window, latency > 0), whereas a **clamp** (W→0 on unlock) drops usable capacity to 0 on the very
  next read (latency 0). Asserts `clamp_latency == 0 ≤ grant_latency` — the asymmetric-safety property
  (the dangerous stale-positive direction is never the slower one).

---

## 4. DR-34 — Doc cleanup (no code)

The doc *bodies* were already reconciled in the 2026-06-16 pass: `PLAN.md` §8 M2d reads "**NO
`lock_until` / no timelock (DR-13)**"; `docs/L1-cardano.md` carries the DR-34 RECONCILED banner and
every "double-dip" mention is now framed as "gone / a §10.7 consistency cross-check, not a live
exploit"; the §12 freeze gate no longer gates on "§10.7 applied to the L2 doc". The **one residual
stale artifact** was `docs/DECISION-REGISTER.md`'s own milestone scope note, which still asserted
PLAN said `lock_until` + `{ owner_pkh }`. Corrected, and DR-34 marked ✅ (executed M5).

---

## 5. Acceptance (all green)

- **`cargo test` (plain, all 4 pallets):** anchor 8 · cogno-gate 11 · microblog 18 · talk-stake 6
  (incl. the 2 new DR-06 property tests). 0 failed.
- **`cargo test --features runtime-benchmarks` (the `impl_benchmark_test_suite!` suites):** anchor 9 ·
  cogno-gate 13 · microblog 22 · talk-stake 7 (every benchmark runs against its mock). 0 failed.
- **Node builds with AND without `runtime-benchmarks`** (`cargo build --release -p cogno-chain-node`
  both ways; `cargo check` for both, runtime + node).
- **`benchmark pallet` produces real weights** for all four pallets, wired into the runtime (no
  placeholder `WeightInfo` on any hot path).
- **Live `--dev` acceptance** (`services/indexer/m5-acceptance.mjs`, `@polkadot/api`, fresh spec-105
  node — genesis `0xbbe867a5…`): `spec_version == 105` · FollowerCommittee seated 5-of-5 ·
  **`//Dave` posts FEELESS under the benchmarked weights (free-balance Δ == 0)** via the sudo
  fallback · **bound-but-unweighted `//Ferdie` post REJECTED at the pool (`ExhaustsResources`)** —
  the capacity gate is the live anti-spam · **a 3-of-5 FollowerCommittee motion (propose → 3×vote →
  close) executes `talk_stake::set_stake(//Grace, 42M)`** via `EnsureProportionAtLeast<3,5>` —
  `Approved` + `Executed` + `StakeSet`, `AllowedStake(//Grace) == 42M` set by the **committee, not
  sudo**. **PASSED.**

```
WS=ws://127.0.0.1:9944 node services/indexer/m5-acceptance.mjs   # against a fresh `--dev --tmp` node
```

---

## 6. Gotchas (recorded)

- **A leftover M4 `--dev` archive node held `:9944`** (prior session, `--base-path /tmp/cogno-m4`).
  A fresh `--dev --rpc-port 9944` node then silently fell back to a random RPC port, and the
  acceptance hit the OLD spec-104 node (genesis `0x41467cdc…`). **Always confirm `:9944` is free
  (`ss -ltnp`) / kill stale `cogno-chain-node` PIDs before a live acceptance.** A fresh spec rebuild
  changes genesis (spec-105 = `0xbbe867a5…`, ≠ spec-104 `0x41467cdc…` — the new pallet + 5 genesis
  committee members change the genesis state root); fetch genesis live, never hardcode.
- **`benchmark_set_allowed` trait hook** — the only clean way to benchmark `post_message` through the
  real `CognoGate` without microblog depending on cogno-gate (cfg-gated on `runtime-benchmarks`,
  no-op in the mock).
- **The `CheckCapacity` extension MUST report a real weight** — `impl_tx_ext_default!(…; weight)`
  silently zeroes it; that hides the gate's reads/writes from the backstop. Override `fn weight()` →
  a benchmarked `check_capacity`.
- **`Linear<0, { T::MaxLength::get() }>`** is valid in the v2 `#[benchmarks]` macro (config-bounded
  component); `Get` must be in scope for `T::MaxLength::get()`. Gated extrinsics use
  `T::Origin::try_successful_origin().map_err(|_| BenchmarkError::Weightless)?` (works for both
  `EnsureRoot` and the DR-07 `EitherOfDiverse` widen). The `crate::Pallet as X` alias only used by
  `impl_benchmark_test_suite!` (cfg-test) needs `#[allow(unused)]`.
- **`SKIP_WASM_BUILD=1`** for the fast `cargo check` / test loop; drop it for the real benchmark
  binary + the live node. The frame weight template emits the `()` impl, so mocks keep compiling.
- **`#[frame_support::runtime]` instanced-pallet syntax** = `pub type FollowerCommittee =
  pallet_collective<Instance1>;` (the macro auto-qualifies `Instance1` to the pallet crate — no
  `use` needed). pallet-collective `initialize_members` sorts internally, so genesis members need not
  be pre-sorted (but must be unique and ≤ `MaxMembers`).
- **PAPI descriptors are stale at spec 105** (the existing `app/scripts` are PAPI) — regen needs
  `rm .papi/descriptors/generated.json` then `papi`. The M5 acceptance side-steps this with
  `@polkadot/api` (dynamic metadata, auto-exposes `followerCommittee`), placed in `services/indexer/`
  beside `verify-m4c.mjs` (where `@polkadot/api` resolves).

---

## 7. Where M5 lives

- **Benchmarks:** `pallets/{microblog,cogno-gate,talk-stake,anchor}/src/benchmarking.rs` +
  regenerated `…/src/weights.rs`; `runtime/src/benchmarks.rs` (`define_benchmarks!`).
- **k-of-t authority:** `runtime/src/lib.rs` (FollowerCommittee @13, spec 105),
  `runtime/src/configs/mod.rs` (collective Config + `AuthorityOrigin` + the 4 origin swaps),
  `runtime/src/genesis_config_presets.rs` (seated committee), `Cargo.toml` + `runtime/Cargo.toml`
  (pallet-collective `v46.0.0`).
- **Property tests:** `pallets/talk-stake/src/tests.rs`, `pallets/microblog/src/tests.rs`.
- **Gate hook:** `pallets/microblog/src/lib.rs` (`IsAllowed::benchmark_set_allowed`, the real
  `CheckCapacity::weight()`); `pallets/cogno-gate/src/lib.rs` (its impl); microblog mock.
- **Docs:** `docs/DECISION-REGISTER.md` (DR-34), this file.
- **Live acceptance:** `services/indexer/m5-acceptance.mjs`.
