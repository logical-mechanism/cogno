# cogno-chain L3 — The Chain & Runtime

> Deep-dive design for the cogno-chain **L3**: the Polkadot-SDK Substrate
> **solochain** (its own node binary, Aura authoring + GRANDPA finality) and its
> **runtime** (the app + the economics). L3 holds the **posts** and turns
> per-account **weight** into **feeless, capacity-gated** posting. Written to be
> picked up cold and implemented from scratch. Companion to `docs/L1-cardano.md`
> (the `talk_vault`), `docs/L2-follower.md` (the follower/bridge), `ECONOMICS.md`
> (the capacity model), and `PLAN.md` (the microblog sketch + roadmap).
>
> **This doc BUILDS ON those — it does not re-derive them.** The capacity model
> (`ECONOMICS.md` §4/§6/§7) and the vault (`L1-cardano.md`) are settled; cited,
> not redone. What is *new* here is the chain skeleton, the four runtime pallets,
> the `CheckCapacity` `TransactionExtension`, the feeless wiring, and the
> consensus/decentralization story — all at implement-from-cold detail in current
> (2026) Polkadot SDK idioms (`#[frame_support::runtime]`, `#[runtime::pallet_index]`,
> `TransactionExtension`, `wasm32v1-none`).

> **RECONCILED to DECISION-REGISTER.md (2026-06-16).** The DECISION-REGISTER is
> authoritative and OVERRIDES this doc where they conflict. The changes that hit
> THIS doc:
> - **Identity = the WHOLE Cardano Address, not `owner_pkh` (DR-01).** The L1 vault
>   datum is `VaultDatum { owner: Address }` (payment cred + stake cred), and the
>   identity hash carried into L3 is **`blake2b_256(serialized owner Address)` = 32
>   bytes** (== the beacon token_name). This **supersedes §1, §2.2, §4.1, §4.4 §10**
>   wherever they say the binding key is a 28-byte `blake2b-224` `owner_pkh` with
>   `len() == 28`: the L3 binding/store key is now a **32-byte identity hash** and
>   the assertion is **`len() == 32`**. L3 still does ZERO Cardano re-derivation —
>   it stores the 32-byte hash the follower submits. (Conceptually rename
>   `Pkh`/`PkhOf`/`AccountOf`/`pkh_of` to the *identity hash*; kept as-is below only
>   to minimize churn — read every `pkh` in this doc as "32-byte identity hash".)
> - **The credential-kind question is RESOLVED (DR-01).** The old "is `owner_pkh` a
>   payment vs stake/reclaim cred? — BLOCKING / `L2-follower.md` §7.4 oq2" framing in
>   §1, §4.1, §9, and §11-Q5 is **no longer open**: the identity is the whole Address
>   (payment cred restricted to `VerificationKey` in v1), and the CIP-8 bind is an
>   **exact whole-address match** (recovered signing Address == reconstructed
>   `datum.owner`, payment AND stake cred). This structurally closes the old
>   wrong-address binding gotcha — treat those notes as historical.
> - **CIP-8 = committed payload (DR-02).** The follower's bind verifies a
>   domain-separated signature over `{ sr25519 account + L3 genesis hash + fresh
>   nonce }`, signing-Address == `datum.owner`, and payload-sr25519 == the submitted
>   sr25519. Bind-hijack is PREVENTED in v1 (not merely detected). L3 still trusts the
>   follower for this; the on-chain ed25519 self-proof is the DEFERRED D1 (§11-Q10).
> - **`NextPostId` is `u64` (DR-21).** §2.1, §4.4, §11-Q7 — the storage type is
>   `u64` and the 2^32 wraparound caveat is **removed** (no longer a documented
>   ceiling).
> - **Decided capacity values (DR-10/10b/11):** regen window **~5h**
>   (10 ADA → ~48 posts/day sustained, burst ~10), **`MaxLength = 512`**,
>   **`MaxPostsPerAuthor = 10_000`**, curve = **linear (capped-linear) + hard
>   ceiling** in v1 (sqrt deferred behind a proven gate). These are now the DECIDED
>   v1 baseline (still runtime-tunable), not merely illustrative — §6, §4.3, §11-Q2.
> - **Decay = clamp-only in v1 (DR-13); NO on-chain timelock / `lock_until`.** The
>   commitment is enforced by L3 regen/clamp (talk starts at 0, accrues only while
>   parked, clamps to 0 on unlock). This is already this doc's stance (§4.2, §4.3,
>   §10) — kept. The opt-in `lock_until` bonus is DEFERRED.
> - **Comments/replies are GATED (DR-14b):** they inherit the 1:1 Sybil anchor +
>   the capacity meter (the `parent` field path in §4.4 is a gated post — consistent
>   with the existing model; noted).
> - **L1 = ONE merged validator (DR-18).** L1 is now a single `talk_vault(min_lock)`
>   validator with both mint and spend handlers (policy_id == vault script hash; the
>   mint arm asserts the beacon lands at the script's own address). The two-validator
>   / separate beacon policy / `beacon_policy_id` parameter / hash-cycle are DELETED.
>   L3 does not depend on L1's internal shape, but cross-refs to L1 should read it as
>   the merged single-validator design. The 32-byte identity hash above == the beacon
>   token_name from that merged validator.
> - **DR-34:** any "L2 is group-and-sum / a live double-dip" framing is FALSE — L2 on
>   disk is already largest-wins/never-sum. This doc already says "L3 never sums on
>   chain" (§2.2); the L1→L2 column label "group-and-sum by owner_pkh" in §10 is
>   corrected to aggregate-by-identity (largest-wins, one weight per identity).

---

## 1. TL;DR

- **L3 = a sovereign Substrate solochain + its runtime.** Fork the current
  Polkadot SDK **solochain template** (its own node binary with Aura authoring +
  GRANDPA finality), rename the runtime to `cogno-chain-runtime`, and append four
  app pallets to the stock `System(0)…Sudo(6)/Template(7)` set.
- **L3 OWNS:** the posts, the capacity math, the feeless gate, and consensus.
  **L3 RECEIVES** (from L2 via one `FollowerOrigin`-gated path): exactly **one
  weight per account** (`set_stake`) and the **1:1 `identity-hash ↔ AccountId`
  binding** (`link_identity`), where the identity hash is
  **`blake2b_256(serialized owner Address)` = 32 bytes** (DR-01; == the L1 beacon
  token_name). **L3 DEFERS:** the per-identity ceiling *numbers*
  (`ECONOMICS.md` §4.4 — tunable; v1 baseline now decided per DR-10) and the Cardano
  `pallet-anchor`.
- **Four pallets:** `pallet-cogno-gate` (the 1:1 binding + `is_allowed`),
  `pallet-talk-stake` (per-identity weight, `set_stake`), the **capacity logic**
  (recommend **folding into `pallet-microblog`** per `ECONOMICS.md` §6.2, or a
  sibling `pallet-talk-capacity`), and `pallet-microblog` (posts). Plus the
  deferred `pallet-anchor`.
- **The binding key MUST equal the L1 identity hash** — `blake2b_256(serialized
  owner Address)`, a **32-byte** hash (== the L1 beacon token_name; DR-01/DR-18).
  Identity is the WHOLE CIP-19 Address (payment cred + stake cred; payment cred
  restricted to `VerificationKey` in v1), not a bare `owner_pkh`. The credential-kind
  question is **RESOLVED** (it's an Address; the CIP-8 bind is an exact whole-address
  match, DR-01/DR-02) — the old "`L2-follower.md` §7.4 oq2: BLOCKING" framing is
  historical. L3 does **not** re-derive anything: the runtime stores the 32-byte hash
  the follower submits, does **zero** Cardano re-derivation, and enforces **only**
  `len() == 32`.
- **Posting is FEELESS — capacity is the SOLE rate-limit** (`ECONOMICS.md`
  §7). It is enforced in a **`CheckCapacity` `TransactionExtension` at
  `validate()`** (return `InvalidTransaction::ExhaustsResources` at the pool),
  **consumed only in `post_dispatch_details`**. The **fee** is waived by
  `#[pallet::feeless_if(|…| true)]` + `SkipCheckIfFeeless<ChargeTransactionPayment>`
  — NOT by `CheckCapacity::post_dispatch_details` returning `Weight::zero()`, which
  is **unspent-weight reporting** (refund nothing), a different mechanism (§5.1).
  The old per-post refundable `Hold` deposit (`PLAN.md` §5) is **removed**.
- **`current_capacity()` is PURE** (no writes — safe to call repeatedly in
  `validate()`); **`consume()` is the only writer** and runs **only** at
  inclusion. Consuming in `validate()` is a bug (the pool calls it many times).
- **New identity starts at ZERO** capacity (`None → 0`), and the `Capacity` row
  is **NEVER deleted** on unlock (weight → 0, `min`-clamp to 0). These two
  invariants close the cheap-identity burst farm and the lock/unlock/relock
  re-mint farm (`ECONOMICS.md` §6.1–6.2). v1 narrows `ECONOMICS.md` §6/Q6's
  decay-on-decrease to **clamp-only**: full unlock collapses to 0 via `min()`;
  a *partial* decrease lowers the ceiling on next read but does not actively
  decay banked `cap_last` — **intentional, partial-decay deferred** (§4.3).
- **`FollowerOrigin` is an `EnsureOrigin`** that widens single-key → k-of-t
  committee **without changing call signatures** (`L2-follower.md` §8.4). v1 =
  `EnsureSignedBy<FollowerKey>` (optionally `EitherOfDiverse<EnsureRoot, …>` for
  a bring-up sudo escape hatch). Identity **and** weight share one trust boundary.
- **Consensus v1 = operator-run Aura + GRANDPA over a tiny authority set** — a
  deliberate **honest centralization**. Capacity gates **USERS, not the
  operator**; the operator authors blocks and is the real security boundary.
- **Honest security reality:** a feeless + low-validator solochain is a
  **permissioned service**. Capacity is the *entire* spam control (so it must be
  gated in `validate()`, not just on-chain); the operator is trusted for
  liveness/censorship/validity; weights come from the trusted L2 follower. None
  of this inherits Cardano's security.
- **Benchmark `post_message` (len-parameterized), `current_capacity`, and
  `consume` to REAL weights** before any non-dev run — they back the only
  anti-spam. Until those weights land (M4), the block-weight backstop is
  **asserted, not proven**; spam-safety is a design property whose *bound*
  (`posts/block ≤ 0.75·MAXBLOCK / weight(post_message)`) is unquantified until
  benchmarked (§5.4, `ECONOMICS.md` §7, `PLAN.md` M5).
- **Decentralization path:** drop sudo → graduate to an SPO/Ariadne-style
  committee (coupled to L2's D2–D4); the deferred Cardano anchor is the only
  "unstoppable" backstop, and it is tamper-**evidence**, not enforcement.
- **Recommendation:** ship the solochain (Approach A in `PLAN.md`), fold capacity
  into `pallet-microblog`, gate posting feelessly in `validate()`, label v1 a
  permissioned service, and structure every privileged origin as an `EnsureOrigin`
  so the consensus and trust graduation discard nothing.

---

## 2. Scope & what L3 owns vs receives

L3 is the third layer of a three-layer system. Its boundaries are settled by the
companion docs; this section pins them so nothing is re-derived below.

### 2.1 L3 OWNS

- **Posts.** `pallet-microblog`: `Posts` / `NextPostId` / `ByAuthor`,
  `post_message` / `delete_post`, `PostCreated` / `PostDeleted` events, bounded
  text (`PLAN.md` §5).
- **Capacity math.** The lazy stake-weighted token bucket
  (`current = min(cap, cap_last + rate·Δblocks)`), `post_cost`, `consume`,
  first-touch-zero, never-delete-on-unlock — **as specified in `ECONOMICS.md`
  §4/§6** (built on here, not redone).
- **The feeless gate.** The `CheckCapacity` `TransactionExtension`
  (`validate()` → `ExhaustsResources`; `consume` in `post_dispatch_details`) plus
  the **fee waiver** (`feeless_if` + `SkipCheckIfFeeless`, distinct from the
  extension) — `ECONOMICS.md` §7.
- **Consensus.** Aura authoring + GRANDPA finality, the authority set, the
  decentralization glide path, and (deferred) the anchor checkpoint pallet.

### 2.2 L3 RECEIVES (from L2, via `FollowerOrigin`)

- **One weight per account** — `set_stake(account, weight)`. The follower has
  **already aggregated** all of an identity's vault UTxOs across all sets into ONE
  weight, largest-wins / never-sum (`L1-cardano.md` §10.2, `L2-follower.md` §6.4;
  DR-34); **L3 never sums on chain** and receives exactly one weight per account.
- **The identity binding** — `link_identity(identity_hash, …, sr25519_account)`
  where `identity_hash = blake2b_256(owner Address)` (32 bytes; DR-01), the
  hard 1:1 Sybil anchor (`L2-follower.md` §7, `ECONOMICS.md` §8). **`link_identity`
  MUST precede `set_stake`** for an account: bind stamps the empty capacity row
  (`on_first_bind`) and bumps the provider reference so the first feeless post is
  valid (§4.1). A stray `set_stake` that lands first is harmless (no row stamped;
  `current_capacity` still returns `None → 0`) but is a follower-ordering bug, not
  an L3 invariant — the follower emits bind-before-weight (`L2-follower.md` §12).
- Both arrive as **gated extrinsics** (never offchain-worker HTTP reads — the
  named anti-pattern, `L2-follower.md` §5). The runtime does **zero** Cardano
  re-derivation; correctness of the CIP-8 proof and the aggregation is the
  follower's job in v1.

### 2.3 L3 DEFERS

- **The ceiling NUMBERS.** The per-identity ceiling is a capped-linear L3 runtime
  param (`L1-cardano.md` §9.3, `ECONOMICS.md` §4.3–4.4). The *mechanism* is in
  scope; the *values* are illustrative and tuned later — none is consensus-critical.
- **The anchor.** `pallet-anchor` (chain → Cardano finalized-root checkpoint) is
  `PLAN.md` M3 / Approach A's WRITE link; specified here at interface level,
  built later. It is the only Cardano-backed property and it is evidence, not
  enforcement.

---

## 3. The chain skeleton

### 3.1 Base: the current solochain template

Fork the **Polkadot SDK solochain template** (`templates/solochain` in
`paritytech/polkadot-sdk`, or the release-pinned standalone mirror). It is the
correct base because it ships its **own full node binary** with baked-in Aura +
GRANDPA — sovereign, not relay-coupled. (The *minimal* template runs only under
external `polkadot-omni-node` with manual-seal; the *parachain* template expects a
relay chain. Neither gives a standalone Aura+GRANDPA node binary; running the
cogno runtime under `polkadot-omni-node` later is optional.) This is exactly
`PLAN.md` M0.

**Pin a recent monorepo commit and read its `rust-toolchain.toml` verbatim —
do not assume.** The wasm target is version-gated and mid-migration:

- Rust ≤ 1.83 → `rustup target add wasm32-unknown-unknown` **plus**
  `rustup component add rust-src`.
- Rust ≥ 1.84 (stable 2025-01-09, PR #7008) → `rustup target add wasm32v1-none`
  (no `rust-src` / `-Zbuild-std`).

Do **not** copy build flags from the lagging `v0.0.2` standalone mirror — it
still uses the legacy `construct_runtime!` macro and the pre-1.84 wasm target
(`PLAN.md` M0 warning). System build deps commonly missing on Debian/Ubuntu:
`clang`, `protobuf-compiler`, `cmake`, `libssl-dev`, `pkg-config`, `make`,
`build-essential`.

### 3.2 The node (Aura + GRANDPA)

`node/` is the `cogno-chain-node` binary (forked `solochain-template-node`):
`chain_spec.rs` (genesis / `development_config` + `testnet_genesis`),
`service.rs` (consensus wiring), `main.rs` / `cli.rs` / `command.rs` (CLI).
Consensus is wired in `node/src/service.rs`: `sc_consensus_grandpa::block_import`
wraps the client; `sc_consensus_aura::import_queue::<AuraPair, …>` is built over
that; `sc_consensus_aura::start_aura::<AuraPair, …>(…)` authors
(`slot_duration` from `sc_consensus_aura::slot_duration(&*client)`, keystore,
timestamp+slot inherents); `sc_consensus_grandpa::run_grandpa_voter(…)` finalizes.
Both run as essential tasks. v1 authorities are set at genesis in `chain_spec.rs`
(Aura `sr25519`/`AuraId`, GRANDPA `ed25519`/`GrandpaId`, plus `Sudo::key`).

Default endpoints (Substrate defaults): JSON-RPC (WS+HTTP) on `127.0.0.1:9944`,
libp2p P2P on `:30333`, Prometheus on `:9615`. `--dev` produces blocks
immediately (Alice/Bob Aura authorities, Alice = sudo, ephemeral tmp state);
`--base-path ./state/` persists; `purge-chain --dev` wipes. Expose RPC beyond
localhost only with `--rpc-external --rpc-cors all` (dev only).

### 3.3 The runtime (`#[frame_support::runtime]`)

`runtime/src/lib.rs` is the `no_std` WASM state-transition crate. Use the
**current** runtime-composition macro (NOT `construct_runtime!`):

```rust
#[frame_support::runtime]
mod runtime {
    #[runtime::runtime]
    #[runtime::derive(
        RuntimeCall, RuntimeEvent, RuntimeError, RuntimeOrigin,
        RuntimeFreezeReason, RuntimeHoldReason, RuntimeSlashReason,
        RuntimeLockId, RuntimeTask, RuntimeViewFunction,
    )]
    pub struct Runtime;

    // ── stock solochain set (keep indices stable forever) ──
    #[runtime::pallet_index(0)] pub type System            = frame_system;
    #[runtime::pallet_index(1)] pub type Timestamp         = pallet_timestamp;
    #[runtime::pallet_index(2)] pub type Aura              = pallet_aura;
    #[runtime::pallet_index(3)] pub type Grandpa           = pallet_grandpa;
    #[runtime::pallet_index(4)] pub type Balances          = pallet_balances;
    #[runtime::pallet_index(5)] pub type TransactionPayment = pallet_transaction_payment;
    #[runtime::pallet_index(6)] pub type Sudo              = pallet_sudo;
    #[runtime::pallet_index(7)] pub type Template          = pallet_template; // drop later

    // ── cogno-chain app pallets (appended at fresh indices) ──
    #[runtime::pallet_index(8)]  pub type CognoGate = pallet_cogno_gate;
    #[runtime::pallet_index(9)]  pub type TalkStake = pallet_talk_stake;
    #[runtime::pallet_index(10)] pub type Microblog = pallet_microblog; // capacity folded in
    // #[runtime::pallet_index(11)] pub type Anchor = pallet_anchor;     // DEFERRED
}
```

Rename `VERSION`: `spec_name`/`impl_name` → `"cogno-chain-runtime"`. **Bump
`spec_version` on every encoding-affecting change** (new pallet/call/storage
shape) and re-run `npx papi` or PAPI/subxt clients fail to encode
(`PLAN.md` §9 metadata-coupled clients). Pallet indices are on-wire contracts —
**never renumber an existing one.** (Note: `RuntimeHoldReason` stays in the derive
list because it is stock, but `pallet-microblog` no longer uses a hold reason —
the per-post `Hold` is removed; do not add a `PostDeposit` hold reason.)

**Add-a-pallet recipe (3 edits per pallet):** (1) add the local-path dep to
`runtime/Cargo.toml` with `default-features = false` and add `…/std` to the
runtime `[features] std = [ … ]`; (2) write `impl pallet_x::Config for Runtime { … }`
(standalone solochain keeps these inline in `runtime/src/lib.rs`; some newer
templates split into `runtime/src/configs/mod.rs` — check the pinned commit);
(3) add the `#[runtime::pallet_index(N)]` line.

### 3.4 The runtime pallet stack (ASCII)

```
                       cogno-chain RUNTIME (WASM, no_std)
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  STOCK (template)                                                          │
  │   System(0)  Timestamp(1)  Aura(2)  Grandpa(3)                             │
  │   Balances(4)  TransactionPayment(5)  Sudo(6)  [Template(7) -> drop]       │
  │                                                                            │
  │  COGNO APP PALLETS                                                         │
  │                                  FollowerOrigin (EnsureOrigin, ONE key v1) │
  │                                   │  link_identity        │  set_stake     │
  │                                   ▼                       ▼                │
  │   CognoGate(8) ───────────┐   TalkStake(9) ──────────┐                     │
  │   PkhOf / AccountOf        │   AllowedStake           │                     │
  │   1:1 identhash<->Acct     │   AccountId -> weight    │                     │
  │   (32B blake2b_256(Addr))  │   (one weight/account)   │                     │
  │   is_allowed()             │                          │                     │
  │        │ is_allowed         │        │ weight_of                            │
  │        ▼                    ▼        ▼                                      │
  │   Microblog(10)  ── post_message: ensure_signed -> is_allowed -> bound     │
  │   Posts / NextPostId / ByAuthor      -> insert -> PostCreated              │
  │   Capacity (folded): current_capacity()=PURE, consume()=writer            │
  │        ▲                                                                   │
  │        │ reads weight (TalkStake) + Capacity state                         │
  │  ┌─────┴───────────────────────────────────────────────────────────────┐  │
  │  │ TxExtension tuple:  …CheckNonce, CheckWeight,                        │  │
  │  │   CheckCapacity<Runtime>  ← validate()=ExhaustsResources at POOL;    │  │
  │  │                              consume() in post_dispatch_details;     │  │
  │  │                              Weight::zero()=unspent-weight report    │  │
  │  │   , SkipCheckIfFeeless<ChargeTransactionPayment>  ← FEE waived here  │  │
  │  │     via feeless_if(true), …                                         │  │
  │  └─────────────────────────────────────────────────────────────────────┘  │
  │                                                                            │
  │   [Anchor(11) — DEFERRED: LastCheckpoint; anchor_ack records finalized    │
  │    root + Cardano txhash, gated by the SAME FollowerOrigin]                │
  └──────────────────────────────────────────────────────────────────────────┘
                       │ Aura authoring + GRANDPA finality (operator-run, v1)
                       ▼
                cogno-chain-node  (WS :9944 / P2P :30333 / Prom :9615)
```

---

## 4. The pallets

Four pallets implement the L1/L2 interfaces as feeless, capacity-gated posting.
Code sketches are in current FRAME idioms; ⚑ marks where the load-bearing
invariants live.

### 4.1 `pallet-cogno-gate` — the 1:1 identity-hash ↔ account binding

The Sybil anchor. Written by `FollowerOrigin` via `link_identity`; exposes
`is_allowed` to `pallet-microblog`. **The binding key == the L1 identity hash =
`blake2b_256(serialized owner Address)`** (`L1-cardano.md`; DR-01/DR-18) — a
**32-byte** hash that is also the L1 beacon token_name. Identity is the WHOLE
CIP-19 Address (payment cred + stake cred); the credential-kind question is
**RESOLVED** (it's an Address, not a bare pkh — the old `L2-follower.md` §7.4 oq2
is historical). L3 does not re-derive: it enforces **only** `len() == 32`, trusting
the follower for the exact whole-address CIP-8 bind (zero Cardano re-derivation in
v1, by design). (Below, `Pkh`/`PkhOf`/`AccountOf`/`pkh_of` are kept by name only to
minimize churn — read them as the *32-byte identity hash*.)

```rust
#[pallet::config]
pub trait Config: frame_system::Config {
    type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    type FollowerOrigin: EnsureOrigin<Self::RuntimeOrigin>;   // ⚑ EnsureOrigin, never ensure_signed
}

// ⚑ DR-01: the identity hash = blake2b_256(serialized owner Address) = 32 bytes
//   (== the L1 beacon token_name). NOT a 28-byte owner_pkh. (Name kept as `Pkh` to
//   minimize churn; conceptually this is `IdentityHash`.)
pub type Pkh = BoundedVec<u8, ConstU32<32>>;                 // 32-byte blake2b_256(owner Address)
// (a fixed [u8; 32] is equally valid and a touch cheaper; BoundedVec keeps the
//  follower-submitted-bytes / try_into validation path uniform.)

// ⚑ BOTH directions, so a 2nd-bind on EITHER side is O(1)-rejectable.
#[pallet::storage] pub type PkhOf<T: Config>     = StorageMap<_, Blake2_128Concat, T::AccountId, Pkh, OptionQuery>;
#[pallet::storage] pub type AccountOf<T: Config> = StorageMap<_, Blake2_128Concat, Pkh, T::AccountId, OptionQuery>;
// optional cogno_v3 thread join key (5 raw bytes / 10 hex — NEVER ConstU32<4>; PLAN.md §5 note)
#[pallet::storage] pub type ThreadOf<T: Config>  = StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<u8, ConstU32<10>>, OptionQuery>;

#[pallet::call]
impl<T: Config> Pallet<T> {
    #[pallet::call_index(0)]
    #[pallet::weight(T::WeightInfo::link_identity())]
    pub fn link_identity(
        origin: OriginFor<T>,
        identity_hash: Vec<u8>,        // ⚑ blake2b_256(serialized owner Address), 32 bytes (DR-01)
        thread_pointer: Option<Vec<u8>>,
        substrate_account: T::AccountId,
    ) -> DispatchResult {
        T::FollowerOrigin::ensure_origin(origin)?;                          // ⚑ gated write
        let pkh: Pkh = identity_hash.try_into().map_err(|_| Error::<T>::BadPkh)?;
        ensure!(pkh.len() == 32, Error::<T>::BadPkh);                       // ⚑ assert 32 bytes (DR-01)
        // ⚑ HARD 1:1: reject if EITHER side already bound (Sybil anchor).
        ensure!(!PkhOf::<T>::contains_key(&substrate_account), Error::<T>::AccountAlreadyBound);
        ensure!(!AccountOf::<T>::contains_key(&pkh),           Error::<T>::PkhAlreadyBound);
        PkhOf::<T>::insert(&substrate_account, &pkh);
        AccountOf::<T>::insert(&pkh, &substrate_account);
        if let Some(tp) = thread_pointer {
            let tp: BoundedVec<_, ConstU32<10>> = tp.try_into().map_err(|_| Error::<T>::BadThread)?;
            ThreadOf::<T>::insert(&substrate_account, tp);
        }
        // ⚑ provider ref so a freshly-bound FEELESS poster's first post isn't
        //   rejected by CheckNonce for a non-existent account (issue #3991, §5.5).
        //   inc_providers is idempotent-safe to net effect; pair with dec_providers in revoke.
        let _ = frame_system::Pallet::<T>::inc_providers(&substrate_account);
        // ⚑ stamp the capacity bucket EMPTY+dated at first bind. NOTE: ECONOMICS §6.2 / L2 §12
        //   originally stamped this at set_stake's first bind with sig (who, now); L3 binds it to
        //   IDENTITY instead (signature on_first_bind(who), reads block_number internally) because
        //   that is what guarantees bind-before-weight. The empty-stamp invariant is identical;
        //   consume()'s lazy-insert is the backstop if any flow skips this hook (§4.3).
        pallet_microblog::Pallet::<T>::on_first_bind(&substrate_account);
        Self::deposit_event(Event::IdentityLinked { who: substrate_account, pkh });
        Ok(())
    }
}

// the trait pallet-microblog depends on (composition pattern, PLAN.md §5)
pub trait CognoGate<AccountId> {
    fn is_allowed(who: &AccountId) -> bool;
    fn pkh_of(who: &AccountId) -> Option<Pkh>;
}
impl<T: Config> CognoGate<T::AccountId> for Pallet<T> {
    fn is_allowed(who: &T::AccountId) -> bool { PkhOf::<T>::contains_key(who) }
    fn pkh_of(who: &T::AccountId) -> Option<Pkh> { PkhOf::<T>::get(who) }
}
```

⚑ **Invariants that live here:** the hard 1:1 binding (reject 2nd-bind on
**either** side — skipping the `AccountOf` reverse check silently multiplies
capacity); `len() == 32` (the 32-byte identity hash, DR-01); `FollowerOrigin`-gated write (never `ensure_signed` —
the public pool would forge it); the **provider bump** at first bind (so the first
feeless post survives `CheckNonce`, §5.5); and **bind stamps the empty capacity
row** (`on_first_bind`, so weight never lands before a row). A `revoke` call (gated
identically) is the M2b revocation hook (`L2-follower.md` §7.5) and **must
`dec_providers`** to undo the bump.

### 4.2 `pallet-talk-stake` — per-identity weight, going-forward only

Written by the **same** `FollowerOrigin` (`L2-follower.md` §8.1). The follower
already aggregated; L3 stores one weight per account.

```rust
pub type StakeWeight = u128;   // summed buried lovelace (ADA-only vaults), per ECONOMICS §6.1

#[pallet::config]
pub trait Config: frame_system::Config {
    type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    type SetStakeOrigin: EnsureOrigin<Self::RuntimeOrigin>;   // ⚑ same FollowerOrigin as the gate
}

// ⚑ ValueQuery -> an unbound/unlocked account reads 0 (cap=0, rate=0 fall out for free).
#[pallet::storage]
pub type AllowedStake<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, StakeWeight, ValueQuery>;

#[pallet::call]
impl<T: Config> Pallet<T> {
    #[pallet::call_index(0)]
    #[pallet::weight(T::WeightInfo::set_stake())]
    pub fn set_stake(origin: OriginFor<T>, who: T::AccountId, weight: StakeWeight) -> DispatchResult {
        T::SetStakeOrigin::ensure_origin(origin)?;            // ⚑ gated, deterministic
        AllowedStake::<T>::insert(&who, weight);              // ⚑ idempotent overwrite (reorg-safe re-derive)
        // ⚑ MUST NOT touch the Capacity row -> going-forward-only falls out (ECONOMICS §6.1 part 1).
        //   weight=0 (unlock) clamps current via min() on next access; the row is NEVER deleted.
        Self::deposit_event(Event::StakeSet { who, weight });
        Ok(())
    }
}
```

⚑ **Invariants that live here:** `set_stake` writes **only** `AllowedStake`,
**never** the `Capacity` map — that separation IS the going-forward-only rule
(adding stake raises future `cap`/`rate` immediately, but the bigger bucket still
fills over the window; `ECONOMICS.md` §6.1). It also closes the retroactive-credit
farm: a weight raise tops up nothing instantly because `cap_last` is untouched.
On **full** unlock the follower writes `weight = 0`; weight is read live, so
`cap = rate = 0` and `current` collapses to `min(0, …) = 0` — **the row is never
deleted**, so a relock can't re-mint (`ECONOMICS.md` §6.1 part 2). A **partial**
decrease lowers the `cap` ceiling, so the next read clamps `current` down to the
new ceiling via `min()`, but banked `cap_last` is **not** actively decayed below
that clamp — **v1 narrows `ECONOMICS.md` §6/Q6's decay schedule to clamp-only by
intent**; partial-decay is deferred (the relock farm stays closed because
`weight → 0` makes clamp and decay equivalent). On first bind the capacity row is
stamped empty by `on_first_bind` (called from `link_identity`, §4.1).

### 4.3 The capacity logic — FOLDED INTO `pallet-microblog` (recommended)

`ECONOMICS.md` §6.2/§9 allows either folding the lazy bucket into
`pallet-microblog` or keeping a separate `pallet-talk-capacity`. **Recommend
folding** (fewer pallets; the extension already calls into `pallet_microblog`).
The math is `ECONOMICS.md` §4.1 verbatim — reproduced only so the pallet is
implementable; **not re-derived**. `current_capacity` / `on_first_bind` /
`post_cost` / `consume` are plain associated functions (NOT dispatchables) so the
`TransactionExtension` and the call body can both reach them.

```rust
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
pub struct CapacityState<BN> { pub cap_last: u128, pub last_block: BN }

// ⚑ OptionQuery is load-bearing: None (true first-touch) vs Some(_) IS the new-identity logic.
#[pallet::storage]
pub type Capacity<T: Config> =
    StorageMap<_, Blake2_128Concat, T::AccountId, CapacityState<BlockNumberFor<T>>, OptionQuery>;

impl<T: Config> Pallet<T> {
    /// Lazy regenerate-on-read. PURE (no writes) -> safe to call repeatedly in validate().
    pub fn current_capacity(who: &T::AccountId, now: BlockNumberFor<T>) -> u128 {
        let weight = pallet_talk_stake::AllowedStake::<T>::get(who);            // 0 if unbound/unlocked
        let cap_linear = weight.saturating_mul(T::CapRatio::get());
        let cap = core::cmp::min(cap_linear, T::Ceiling::get());                // ⚑ capped-linear (L1 §9.3)
        match Capacity::<T>::get(who) {
            None => 0,                                                          // ⚑ first-touch = ZERO (ECONOMICS §6.2)
            Some(s) => {
                let elapsed: u128 = now.saturating_sub(s.last_block).saturated_into();
                let regen = weight.saturating_mul(T::RegenPerBlock::get()).saturating_mul(elapsed);
                core::cmp::min(cap, s.cap_last.saturating_add(regen))           // ⚑ all saturating
            }
        }
    }
    /// Stamp the bucket empty+dated at first bind. Row NEVER removed on unlock.
    pub fn on_first_bind(who: &T::AccountId) {
        if !Capacity::<T>::contains_key(who) {
            let now = <frame_system::Pallet<T>>::block_number();
            Capacity::<T>::insert(who, CapacityState { cap_last: 0, last_block: now });
        }
    }
    pub fn post_cost(len: u32) -> u128 {
        T::BaseCost::get().saturating_add(T::PerByteCost::get().saturating_mul(len as u128))
    }
    /// The ONLY writer. Called ONLY from post_dispatch_details (inclusion), never validate().
    pub fn consume(who: &T::AccountId, now: BlockNumberFor<T>, cost: u128) {
        let current = Self::current_capacity(who, now);
        Capacity::<T>::insert(who, CapacityState { cap_last: current.saturating_sub(cost), last_block: now });
    }
}
```

⚑ **Invariants that live here:** `None → 0` (closes the cheap-identity / first-
touch burst farm — a fresh identity charges up from empty, never a full bucket);
the row is **never deleted** on unlock (closes the relock re-mint farm);
`current_capacity` is **pure** (safe in `validate()`); `consume` is the **sole
writer** and runs only at inclusion; `min`-clamp + `saturating_*` make a whale idle
for years saturate into the clamp instead of wrapping. **Decay policy = clamp-only
in v1:** the `min(cap, …)` read enforces a *lower* ceiling immediately on a weight
decrease, but there is no active decay of banked `cap_last` toward a lower cap
beyond that clamp — `ECONOMICS.md` §6/Q6's full decay-on-power-down schedule
(Midnight/Hive-style) is **deferred by intent** (for `weight → 0` the two are
equivalent, so this does not reopen the relock farm). Clock = **block number**
(deterministic; caveat: regen drifts if Aura stalls — acceptable on a single-
operator chain; `ECONOMICS.md` §4.1). Work in fine-grained micro-capacity units
(mirror Midnight's 1e15 resolution).

### 4.4 `pallet-microblog` — posts (Hold removed)

`PLAN.md` §5 minus the `Hold` (`ECONOMICS.md` §6.3): no `RuntimeHoldReason`, no
`Currency: MutateHold`, no `BaseDeposit`/`ByteDeposit`, no `hold()`/`release()`.
`is_allowed` and `BoundedVec` stay.

```rust
#[pallet::config]
pub trait Config: frame_system::Config {
    type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    type CognoGate: pallet_cogno_gate::CognoGate<Self::AccountId>;       // is_allowed / pkh_of / thread_of
    #[pallet::constant] type MaxLength:     Get<u32>;                    // PoV bound; v1 = 512 (DR-10b)
    #[pallet::constant] type MaxPostsPerAuthor: Get<u32>;
    #[pallet::constant] type CapRatio:      Get<u128>;                   // capacity constants (ECONOMICS §6.3)
    #[pallet::constant] type RegenPerBlock: Get<u128>;
    #[pallet::constant] type Ceiling:       Get<u128>;
    #[pallet::constant] type BaseCost:      Get<u128>;
    #[pallet::constant] type PerByteCost:   Get<u128>;
    type WeightInfo: WeightInfo;
}

#[derive(Encode, Decode, DecodeWithMemTracking, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
#[scale_info(skip_type_params(T))]
pub struct Post<T: Config> {
    pub author: T::AccountId,
    pub text:   BoundedVec<u8, T::MaxLength>,
    pub parent: Option<u64>,                 // ⚑ GATED comment/reply (DR-14b): a parent'd post is
                                             //   still a gated post (1:1 anchor + capacity meter).
    pub at:     BlockNumberFor<T>,
}

// ⚑ NextPostId is u64 (DR-21) — the 2^32 wraparound caveat is removed.
#[pallet::storage] pub type NextPostId<T> = StorageValue<_, u64, ValueQuery>;
#[pallet::storage] pub type Posts<T: Config> = StorageMap<_, Blake2_128Concat, u64, Post<T>>;
#[pallet::storage] pub type ByAuthor<T: Config> =
    StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<u64, T::MaxPostsPerAuthor>, ValueQuery>;
// + Capacity<T> (§4.3, folded)

#[pallet::call]
impl<T: Config> Pallet<T> {
    #[pallet::call_index(0)]
    #[pallet::weight(T::WeightInfo::post_message(text.len() as u32))]    // ⚑ len-parameterized; BENCH it
    // ⚑ THIS is the actual fee waiver: feeless_if returning true makes SkipCheckIfFeeless
    //   skip ChargeTransactionPayment entirely (§5.1). Closure arg types below are ILLUSTRATIVE —
    //   the real closure receives (&dispatch origin, &decoded args by ref); match them to the
    //   generated signature or it will not compile.
    #[pallet::feeless_if(|_origin: &OriginFor<T>, _text: &Vec<u8>, _parent: &Option<u64>| true)]
    pub fn post_message(origin: OriginFor<T>, text: Vec<u8>, parent: Option<u64>) -> DispatchResult {
        let who = ensure_signed(origin)?;
        ensure!(T::CognoGate::is_allowed(&who), Error::<T>::NotAllowed); // ⚑ Sybil/identity gate (STAYS)
        let bounded: BoundedVec<_, T::MaxLength> = text.try_into().map_err(|_| Error::<T>::TooLong)?;
        // NOTE: NO capacity check here — it lives in CheckCapacity::validate() (pool) and
        //       consume() in post_dispatch_details. Body + pool gate must not desync (ECONOMICS §7).
        let id = NextPostId::<T>::mutate(|n| { let id = *n; *n += 1; id });
        let at = <frame_system::Pallet<T>>::block_number();
        Posts::<T>::insert(id, Post { author: who.clone(), text: bounded, parent, at });
        let _ = ByAuthor::<T>::try_mutate(&who, |v| v.try_push(id));     // ⚑ bounded; handle overflow
        Self::deposit_event(Event::PostCreated { id, author: who });
        Ok(())
    }

    #[pallet::call_index(1)]
    #[pallet::weight(T::WeightInfo::delete_post())]
    pub fn delete_post(origin: OriginFor<T>, id: u64) -> DispatchResult {
        let who = ensure_signed(origin)?;
        let post = Posts::<T>::get(id).ok_or(Error::<T>::NotFound)?;
        ensure!(post.author == who, Error::<T>::NotAuthor);
        Posts::<T>::remove(id);                                          // ⚑ nothing to refund (no Hold)
        Self::deposit_event(Event::PostDeleted { id });
        Ok(())
    }
}
```

**How `post_message` wires gate → capacity check → consume → event:**

1. **Pool (`CheckCapacity::validate()`, §5):** decode the call; if
   `Microblog::post_message`, read `have = current_capacity(who, now)` and
   `need = post_cost(text.len())`; if `have < need` → `ExhaustsResources`
   (rejected before the pool/gossip work); else admit with priority tied to
   remaining capacity. **No consume here.**
2. **Block body (`post_message`):** `ensure_signed` → `is_allowed` (identity
   gate) → `try_into` `BoundedVec` (PoV bound) → insert `Post` + `ByAuthor` push
   → emit `PostCreated`. No capacity logic in the body.
3. **`post_dispatch_details` (§5):** `consume(who, now, cost)` (the sole bucket
   mutation, at inclusion) → return `Weight::zero()` as **unspent-weight reporting**
   (post_message used its full benchmarked weight, so refund nothing). This does
   **not** waive the fee — the fee was already skipped by `feeless_if` +
   `SkipCheckIfFeeless` at the payment extension (§5.1).

⚑ Bound every collection: `text` (`MaxLength` = 512, DR-10b), `ByAuthor`
(`MaxPostsPerAuthor` = 10_000, DR-10b; `try_push` can fail — handle, don't silently
drop), the identity hash (32 bytes, DR-01). `NextPostId` is **`u64`** (DR-21) — the
2^32 wraparound caveat is removed (a u64 id space is effectively inexhaustible).
Optionally validate `parent` references an existing post; replies/comments are
**gated** like any post (inherit the 1:1 anchor + capacity meter, DR-14b). Off-chain
indexers reconstruct threads from `PostCreated` + `parent` (no on-chain children
index needed).

### 4.5 The runtime `Config` wiring + `FollowerOrigin`

```rust
// ── FollowerOrigin: ONE EnsureOrigin shared by identity AND weight (L2 §8.4) ──
parameter_types! { pub const FollowerKey: AccountId = /* the follower's account */; }
// v1: single key + sudo escape hatch for bring-up.
pub type EnsureFollower = EitherOfDiverse<EnsureRoot<AccountId>, EnsureSignedBy<FollowerKey, AccountId>>;
// hardened (D2, no signature change): EnsureProportionAtLeast<AccountId, FollowerCollective, M, N>.

impl pallet_cogno_gate::Config for Runtime {
    type RuntimeEvent  = RuntimeEvent;
    type FollowerOrigin = EnsureFollower;     // ⚑ same boundary
}
impl pallet_talk_stake::Config for Runtime {
    type RuntimeEvent   = RuntimeEvent;
    type SetStakeOrigin = EnsureFollower;     // ⚑ same boundary
}
impl pallet_microblog::Config for Runtime {
    type RuntimeEvent = RuntimeEvent;
    type CognoGate    = CognoGate;            // pallet 8 implements the trait
    type MaxLength    = ConstU32<512>;        // DR-10b (decided v1 baseline, still tunable)
    type MaxPostsPerAuthor = ConstU32<10_000>; // DR-10b (decided v1 baseline, still tunable)
    type CapRatio     = CapRatio;  type RegenPerBlock = RegenPerBlock;
    type Ceiling      = Ceiling;   type BaseCost = BaseCost;  type PerByteCost = PerByteCost;
    type WeightInfo   = pallet_microblog::weights::SubstrateWeight<Runtime>; // ⚑ REAL weights (M4)
}
```

---

## 5. Feeless capacity gating

This is `ECONOMICS.md` §7 made concrete in current FRAME. **The whole anti-spam
budget is this extension** — on a feeless chain there is no fee floor underneath
it.

### 5.1 The `CheckCapacity` TransactionExtension

`CheckCapacity` is a `TransactionExtension` (the current term; replaced
`SignedExtension`). Shape verified against the GPL-3.0 feeless template's
`CheckRate` (`bgallois/substrate-feeless-solochain-template`) and polkadot-sdk
master — **note the copyleft if vendored.**

```rust
#[derive(Encode, Decode, DecodeWithMemTracking, Clone, Eq, PartialEq, TypeInfo)]
#[scale_info(skip_type_params(T))]
pub struct CheckCapacity<T>(core::marker::PhantomData<T>);
// + a manual core::fmt::Debug impl (std/no_std split)

pub struct Pre<T: Config> { who: Option<T::AccountId>, cost: u128 }

impl<T: Config + Send + Sync> TransactionExtension<T::RuntimeCall> for CheckCapacity<T>
where T::RuntimeCall: Dispatchable<Info = DispatchInfo>,
{
    const IDENTIFIER: &'static str = "CheckCapacity";
    type Implicit = ();
    type Val = Pre<T>;
    type Pre = Pre<T>;
    impl_tx_ext_default!(T::RuntimeCall; weight);   // unused hooks (incl. weight = 0)

    fn validate(
        &self,
        origin: <T::RuntimeCall as Dispatchable>::RuntimeOrigin,
        call: &T::RuntimeCall,
        _info: &DispatchInfoOf<T::RuntimeCall>,
        _len: usize, _self_implicit: (), _impl: &impl Encode, _src: TransactionSource,
    ) -> Result<(ValidTransaction, Self::Val, <T::RuntimeCall as Dispatchable>::RuntimeOrigin), TransactionValidityError> {
        // pass through anything that isn't a signed post_message
        let Ok(who) = frame_system::ensure_signed(origin.clone()) else {
            return Ok((ValidTransaction::default(), Pre { who: None, cost: 0 }, origin));
        };
        if let Some(pallet_microblog::Call::post_message { text, .. }) = call.is_sub_type() {
            let now  = frame_system::Pallet::<T>::block_number();
            let have = pallet_microblog::Pallet::<T>::current_capacity(&who, now);  // ⚑ ~2 cheap reads
            let need = pallet_microblog::Pallet::<T>::post_cost(text.len() as u32);
            if have < need {
                // ⚑ POOL REJECT — bounds INCLUSION (block author re-runs at build time)
                return Err(TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources));
            }
            // ⚑ priority tied to remaining capacity + SHORT longevity -> over-budget bursts age out.
            //   Cast u128 micro-capacity -> u64 TransactionPriority saturates: whale-scale headroom
            //   pins to u64::MAX (all large posters share top priority — coarse at the top, harmless,
            //   no panic). Optionally compress (e.g. log2 / divide by a unit) to keep resolution.
            let vt = ValidTransaction {
                priority: (have - need).saturated_into::<u64>(), longevity: 8, propagate: true, ..Default::default()
            };
            return Ok((vt, Pre { who: Some(who), cost: need }, origin));
        }
        Ok((ValidTransaction::default(), Pre { who: None, cost: 0 }, origin))
    }

    fn prepare(self, val: Self::Val, _o: &_, _c: &_, _i: &_, _l: usize) -> Result<Self::Pre, TransactionValidityError> {
        Ok(val)                                   // carry the resolved {who, cost} through
    }

    fn post_dispatch_details(
        pre: Self::Pre, _info: &_, _post: &_, _len: usize, _result: &DispatchResult,
    ) -> Result<Weight, TransactionValidityError> {
        if let Some(who) = pre.who {              // ⚑ CONSUME here ONLY (inclusion), never in validate()
            let now = frame_system::Pallet::<T>::block_number();
            pallet_microblog::Pallet::<T>::consume(&who, now, pre.cost);
        }
        // ⚑ NOT the fee waiver. This is UNSPENT-WEIGHT reporting: zero unspent => refund nothing.
        //   The FEE is waived upstream by feeless_if + SkipCheckIfFeeless (see TxExtension tuple below).
        Ok(Weight::zero())
    }
}
```

Imports: `use frame_support::pallet_prelude::InvalidTransaction::ExhaustsResources;`
and `use sp_runtime::{impl_tx_ext_default, traits::{…, TransactionExtension},
transaction_validity::{TransactionSource, TransactionValidityError, ValidTransaction},
SaturatedConversion, Weight};`. `DecodeWithMemTracking` on the struct is a current
required bound; copying old `SignedExtension` code will not compile.

Wire it into the runtime's `TxExtension` tuple **before** the payment extension:

```rust
pub type TxExtension = (
    frame_system::CheckNonZeroSender<Runtime>, CheckSpecVersion<Runtime>, CheckTxVersion<Runtime>,
    CheckGenesis<Runtime>, CheckEra<Runtime>, CheckNonce<Runtime>, CheckWeight<Runtime>,
    CheckCapacity<Runtime>,                                            // ⚑ NEW, before payment
    pallet_skip_feeless_payment::SkipCheckIfFeeless<Runtime, ChargeTransactionPayment<Runtime>>,
    CheckMetadataHash<Runtime>, /* WeightReclaim */
);
pub type UncheckedExtrinsic = generic::UncheckedExtrinsic<Address, RuntimeCall, Signature, TxExtension>;
```

**Two orthogonal mechanisms — do not conflate them:**

1. **Fee waiver (makes the chain feeless):** `#[pallet::feeless_if(|…| true)]`
   (§4.4) marks `post_message` feeless, and `SkipCheckIfFeeless<…,
   ChargeTransactionPayment>` in the tuple then **skips** `ChargeTransactionPayment`
   for any call the closure returns `true` for. This pair — and *only* this pair —
   is why no fee is charged. (Gallois's reference template is feeless by a different
   route: it **omits `ChargeTransactionPayment` from the tuple entirely**. Keeping
   the payment extension wrapped in `SkipCheckIfFeeless` is a deliberate choice so
   the runtime can later make *other* calls fee-bearing — feeless is per-call, not
   chain-wide.)
2. **Spam control (makes the chain safe):** `CheckCapacity::validate()` →
   `ExhaustsResources`. `CheckCapacity::post_dispatch_details` returning
   `Weight::zero()` is **NOT** part of the waiver — it is unspent-weight reporting
   (refund nothing). These two extensions are NOT redundant: one waives money, the
   other rejects work.

**`feeless_if` alone is NOT spam protection** — it skips the fee, it rejects
nothing from the pool. **`CheckCapacity` alone does not make posts free** — it
gates inclusion but never touches the fee. Both are required, and they do
different jobs.

### 5.2 The security point: capacity is the SOLE spam control

Because posting is feeless, **all spam/DoS protection rests on this extension, and
it MUST run at the pool in `validate()`, not only as an on-chain `ensure!`**
(`ECONOMICS.md` §7). An on-chain-only check fires too late: a signature-valid but
over-budget tx has already entered and gossiped the mempool **for free** — that
*is* the spam on a feeless chain.

**Gate in `validate()`, mutate in `post_dispatch_details()`.** Never consume in
`validate()` (the pool calls it many times per tx → over-charge); never rely
solely on the call body (pool gate and state desync). Never do crypto/CIP-8 in
`validate()` (heavy uncharged compute is itself a DoS vector — keep it to ~2-3
cheap reads: `AllowedStake`, `Capacity`, block number).

### 5.3 What `validate()` bounds vs not (be precise)

- **Bounds INCLUSION (hard).** The block author re-runs `validate()` at build
  time, sees capacity consumed by the first included post, and rejects the rest
  → only ~`cap` posts land on-chain.
- **Does NOT prevent a transient same-account mempool burst.** Several nonces
  submitted before a block is built all read the same un-consumed `cap_last`, all
  pass `validate()`, all enter the pool. That is throttled — not eliminated — by
  **pool per-sender limits** (ready/future queue caps) + **capacity-tied
  `priority`/short `longevity`** + block-build re-validation. Net: posting is
  hard-bounded; mempool burst pollution is throttled.

### 5.4 The BlockWeights backstop + benchmarking requirement

`frame_system::BlockWeights` still caps total per-block weight (Normal class =
75% of the block); `CheckWeight` returns `ExhaustsResources` at the per-block
limit. This is a **layered, not alternative** defense: `CheckCapacity` throttles
per-account inflow into the pool; `BlockWeights`/`CheckWeight` caps per-block
*execution* regardless of capacity. The backstop matters precisely for the case
capacity does not cover — e.g. the operator self-including over-budget posts (§8.1):
even then, the block-weight cap bounds posts-per-block.

**The backstop's bound is concrete but currently unquantified:**

```
  posts_per_block_max  =  floor( NormalClass_max_weight / weight(post_message@maxlen) )
                       =  floor( 0.75 · MAXBLOCK / WeightInfo::post_message(MaxLength) )
```

Both terms are known only **after benchmarking**: `MAXBLOCK` from the chosen
`BlockWeights` config, and `weight(post_message)` from the FRAME benchmark. Until
M4 lands those, **this ceiling is asserted, not proven, and the spam-safety claim
is incomplete** — state it that way, do not imply a measured bound exists.

**Benchmark to REAL `Weight`** (M4, before any non-dev run):

- `post_message` — **len-parameterized** (`post_message(l)`), to realistic
  worst-case `MaxLength` text **plus the 2 storage reads `CheckCapacity::validate()`
  performs** (`AllowedStake`, `Capacity`), so the weight that backs the block-limit
  math includes the gate's own cost.
- `current_capacity` and `consume` — they run in the now-weight-relevant extension
  path (`validate` reads, `post_dispatch` writes).

Do **not** ship `dev_mode`/placeholder weights for any non-dev run — these weights
back the **only** anti-spam, so the block-limit math must be honest
(`ECONOMICS.md` §7, `PLAN.md` M5).

### 5.5 Provider note (feeless new posters)

`CheckNonce` still requires the account to exist (issue #3991): a brand-new poster
whose fee is skipped may have no provider reference, so its first post would be
rejected. **`link_identity` calls `frame_system::inc_providers(&account)` at first
bind** (§4.1 code) so the freshly-bound account exists before it can post; `revoke`
must `dec_providers` to undo it. This is the load-bearing reason `link_identity`
**must precede** `set_stake`/any post for an account (§2.2): without the bind, no
provider ref and no capacity row.

---

## 6. The economic constants

All runtime-tunable, none consensus-critical (`ECONOMICS.md` §4.4 — built on, not
re-derived). Express as `#[pallet::constant] Get<u128>` so they are governance-
mutable. The **v1 baseline is now DECIDED** (DR-10/10b/11), still tunable: a
**~5h** empty→full regen window, worked example **10 ADA → ~48 posts/day sustained,
burst ~10** (small 2–3× burst headroom), curve = **linear (capped-linear) + hard
ceiling** (sqrt deferred behind a proven gate), **`MaxLength = 512`**,
**`MaxPostsPerAuthor = 10_000`**. The remaining capacity constants (exact
`CapRatio`/`RegenPerBlock`/`Ceiling`/`BaseCost`/`PerByteCost`) are proposed at M2c
(§11-Q2).

| Constant | Meaning | Illustrative start | Source |
|---|---|---|---|
| `RegenPerBlock` | refill rate per block = `weight·RegenPerBlock` | derive from the decided **~5h regen window** (DR-10; faster than Hive's 5 days) and block time | `ECONOMICS.md` §4.1, §10 Q1; DR-10 |
| `CapRatio` | `cap_linear = weight·CapRatio` (the burst size) | sized so baseline stake gives a small burst (2–3×, not EOS's 1000×; DR-10 burst ~10) | `ECONOMICS.md` §3, §4.4; DR-10 |
| `Ceiling` | per-identity cap (**capped-linear**): `cap = min(cap_linear, Ceiling)` | high but finite, so no whale dominates the mempool | `L1-cardano.md` §9.3, `ECONOMICS.md` §4.3; DR-11 |
| `BaseCost` | flat per-post cost (capacity units) | low, so onboarding/first post is cheap | `ECONOMICS.md` §4.2, §6.2 |
| `PerByteCost` | per-byte cost: `post_cost = BaseCost + PerByteCost·len` | small; flat or size-only is fine for launch | `ECONOMICS.md` §4.2 |
| `MaxLength` | bounded text (PoV) | **512 bytes (DR-10b, decided)** | `PLAN.md` §5; DR-10b |

- **Curve = capped-linear for v1** (`weight = lovelace`, scaled by `CapRatio`,
  clamped by `Ceiling`). Linear is split-neutral; concave (sqrt) is more
  Sybil-farmable and should wait behind a proven gate (`ECONOMICS.md` §4.3). The
  ceiling is applied **on top of** the already-L2-aggregated weight (`L1-cardano.md`
  §9.3) — L1 declares the floor (`min_lock = 100 ADA`), L3 clamps the ceiling.
- **Work in micro-capacity units** (fine-grained integers, mirror Midnight's 1e15
  resolution) so `weight·CapRatio·elapsed` fits `u128` with saturating math.
- **Do NOT copy Hive's volatile `A/(B+x)` dynamic pricing** — prefer fixed,
  predictable per-post costs (`ECONOMICS.md` §4.2).
- **Clock = block number** (`ECONOMICS.md` §4.1): deterministic; regen drifts if
  Aura stalls (acceptable on a single-operator chain).

---

## 7. Reading the feed

No Cardano round-trip on reads (`PLAN.md` §4 READ). Two paths:

**Direct PAPI (demo / low scale).** Generate the typed client:
`npm i polkadot-api`; `npx papi add cogno -w ws://localhost:9944`; `npx papi`.

```ts
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { cogno } from "@polkadot-api/descriptors";

const client = createClient(getWsProvider("ws://localhost:9944"));
const api = client.getTypedApi(cogno);

// WRITE (signed by the user's Substrate sr25519 key — NOT the Cardano wallet)
const tx  = api.tx.Microblog.post_message({ text: Binary.fromText("gm cogno"), parent: undefined });
const res = await tx.signAndSubmit(signer);            // { ok, txHash, events, dispatchError?, block }

// READ — one-shot, live, and event stream
const entries = await api.query.Microblog.Posts.getEntries();
api.query.Microblog.Posts.watchEntries().subscribe(({ deltas }) => { /* render */ });
client.finalizedBlock$.subscribe(b => { /* finality */ });
```

Headless signer: `@polkadot-labs/hdkd`
(`sr25519CreateDerive(...)('//Alice')`) + `getPolkadotSigner(pub,'Sr25519',sign)`.
Posting is signed by the **Substrate** sr25519 key; the Cardano CIP-30 `signData`
is used **once** at onboarding by the follower, never on the post path
(`L2-follower.md` §7).

**Optional indexer (scale).** SubQuery or Subsquid (SQD) ingests
`PostCreated`/`PostDeleted` into Postgres + GraphQL for paginated, searchable,
per-identity, threaded feeds (threads reconstructed from `parent`). `PLAN.md` M4.
**Any** call/storage shape change needs a `spec_version` bump + re-running `papi`
(metadata-coupled clients).

---

## 8. Consensus & decentralization path

### 8.1 v1 — operator-run Aura + GRANDPA (an honest centralization)

- **Aura** (round-robin PoA authoring) assigns each slot to one authority in
  rotation; with 1 authority it is a single sequencer. It provides
  liveness/ordering, **not** safety.
- **GRANDPA** (BFT finality) finalizes once > 2/3 of authority weight votes a
  common prefix. **Safe only while byzantine weight < 1/3; stalls (no finality)
  if > 1/3 of authorities are offline.** On a 3-authority chain, one
  offline/malicious authority is already at the 1/3 line — there is no safety
  margin. Tell users finality can stall.
- Authorities + sudo are set at genesis in `chain_spec.rs` (Aura `sr25519`,
  GRANDPA `ed25519` — **distinct keypairs**; a common footgun is updating Aura
  authorities but not GRANDPA's, silently breaking finality).

This is a **deliberate honest centralization** — a permissioned service whose
safety budget is operator trust. **Capacity gates USERS not the operator**
(`ECONOMICS.md` §8): the block author can include their own over-budget posts by
not applying the gate at build time. Do not market capacity as chain security;
consensus trust is the real boundary. The chain inherits **none** of Cardano's
finality/stake security.

> The named weaknesses, stated plainly: few-authority Aura PoA is the
> single-sealer **cloning attack** target (Ekparinya/Gramoli, arXiv 1902.10244 —
> one byzantine sealer suffices); GRANDPA finality (< 1/3 byzantine) is the
> mitigation, which is why **finality, not authoring, carries the safety story** —
> and why a single authority is never "safe."

### 8.2 First step off static genesis — mutable authorities (still operator-gated)

Add `pallet-session`; set its `SessionManager` to a validator-management pallet
(vendor-fork `gautamdhameja/substrate-validator-set` as a *reference pattern* — it
tracks ~`polkadot-v1.13.0` and needs porting to the current `#[runtime]` API, not
a drop-in dep), `ValidatorIdOf` to that pallet, `Keys` to the `(Aura, Grandpa)`
session keys. Then **`pallet-aura` and `pallet-grandpa` derive their authorities
from `pallet-session`** each rotation (via their `OneSessionHandler` impls) instead
of from genesis — **do not also keep static genesis authorities** (mutually
exclusive). `add_validator`/`remove_validator` are gated by an `AddRemoveOrigin`
(`EnsureRoot` in v1); a change is **queued then applied at a session boundary**
(~2 sessions), never mid-session. Optionally wire `pallet-im-online` so a
provably-offline authority is auto-removed before it crosses the 1/3 GRANDPA-stall
line.

### 8.3 Graduation — drop sudo → SPO/Ariadne committee (coupled to L2 D2–D4)

The endgame (`PLAN.md` Approach B, `L2-follower.md` §9):

- **Widen privileged origins** from `EnsureRoot`/single-key to a **k-of-t
  collective** (`pallet-collective` + `EnsureProportionAtLeast<M,N>`) — the same
  `EnsureOrigin` widening `FollowerOrigin` uses, so **no call signature changes.**
- **Replace the operator-controlled `AddRemoveOrigin`/`SessionManager` with an
  Ariadne/D-parameter committee-selection pallet** that ingests Cardano SPO
  registrations (as a gated extrinsic or inherent — same ingress discipline as
  L2's weight write, **never** an OCW HTTP read) and elects each epoch's
  block-producing committee, mixing permissioned (bootstrap) and registered (SPO)
  seats by a D-parameter tuned toward zero trusted seats over time. `SessionManager::new_session`
  returns the elected committee; Aura/GRANDPA follow.
- **The app pallets (`microblog`/`cogno-gate`/`talk-stake`/capacity) change ZERO**
  — only the consensus/session layer changes. This is the throw-nothing-away
  property L2 §9 relies on.

⚑ **Constraints:** IOG **partner-chains** (the canonical Ariadne template) was
**archived 2026-04-23**, read-only, folded into Midnight — **self-build or
vendor-fork** (Apache-2.0 / GPLv3-Classpath; reconcile the license before
vendoring), or track Midnight's crates. **Dropping sudo is a process, not a flag**:
removing `pallet-sudo` while any privileged origin (validator add/remove, `set_code`
upgrades, follower writes, `anchor_ack`) still points at a single key just moves
the centralization — route **every** privileged origin through the collective
first, and audit that no `EnsureRoot`/single-key origin is left behind. Per-committee-member
Cardano infra (cardano-node + db-sync + Postgres) is the heavy cost that makes
this a later milestone. This graduation is **coupled to L2's D3/D4** (inherent
re-verification is load-bearing only with multiple independent producers,
`L2-follower.md` §5.1, §9).

### 8.4 The deferred anchor — the only "unstoppable" backstop

`pallet-anchor` (DEFERRED, `PLAN.md` M3, Approach A's WRITE link) is the **only**
Cardano-backed property — and it is tamper-**evidence**, not enforcement.

- **Off-chain Anchor Relayer** subscribes to **GRANDPA finality** notifications
  (`sc-finality-grandpa` `FinalityNotifications`, or the
  `grandpa_subscribeJustifications` RPC) — NOT best-chain/in-progress roots — and
  every N finalized blocks reads the **last finalized** block's state-root +
  `{block_number, post_count, timestamp}`, builds a Cardano tx (Tier-A metadata
  or Tier-B checkpoint-UTxO) via Ogmios, and calls `anchor_ack` back on
  confirmation.
- **`pallet-anchor` only RECORDS** the relayer-confirmed checkpoint
  (`LastCheckpoint`, `anchor_ack(block_number, state_root, cardano_txhash)`
  gated by the **same** `FollowerOrigin`, **idempotent** — no-op if the block is
  already recorded so a rollback retry can't double-record). ⚑ **Do NOT snapshot a
  root inside `on_initialize`/`on_finalize`** — that sees only block N−1's state
  and could anchor a root that later loses a finality race.
- **Tiers:** Tier-A = tx metadata (cheapest; proves existence+timestamp, enforces
  nothing). Tier-B = spend+recreate a singleton checkpoint UTxO at a tiny Aiken
  validator gated by the operator/k-of-t sig (proves *who* posted the root, still
  not that it's honest).
- ⚑ **Data-availability caveat (load-bearing):** the anchor is checkable only if a
  skeptic has independent access to L3's history at the anchored block to
  re-derive and compare. If the sole operator prunes/withholds history, "anyone
  can verify" is unbacked. Pair the anchor claim with a concrete archival
  commitment (archive node / published checkpoints) — `PLAN.md` §9.

---

## 9. Honest risks

- **Feeless spam surface.** Posting is feeless (fee waived by `feeless_if` +
  `SkipCheckIfFeeless`, §5.1), so there is no fee floor. If the `CheckCapacity`
  extension is wrong — consuming in `validate()`, missing from the TxExtension
  tuple, or doing crypto in `validate()` — free spam is possible. It MUST be
  `validate()` → `ExhaustsResources` + `consume` only in `post_dispatch_details`
  (with `Weight::zero()` reporting no unspent weight, **not** as the fee waiver)
  (§5). `feeless_if` alone is the classic mistake (skips the fee, rejects nothing);
  and the spam-safety claim is **only as proven as the M4 benchmarks** that fix the
  block-weight backstop bound (§5.4).
- **Capacity is the sole anti-spam — and only for users.** The block-weight
  backstop bounds per-*block* damage, not mempool pollution; pool per-sender
  limits throttle but don't eliminate same-account bursts (§5.3). And on a 1–3
  validator PoA chain the operator authors blocks and can include their own
  over-budget posts (`ECONOMICS.md` §8) — capacity disciplines non-operator users,
  not the operator. Not a regression vs the deposit model, but do not overstate
  capacity as chain security.
- **Low-validator / operator-trust reality.** A few operator-run Aura authorities
  is a permissioned service. Aura's cloning attack and GRANDPA's 1/3 thresholds
  mean no safety margin at 1–3 authorities; finality can stall. The operator is
  trusted for liveness, censorship-resistance, and validity, and the chain
  inherits none of Cardano's security (§8.1, `PLAN.md` §9).
- **Weights come from the trusted L2 follower.** `set_stake` is follower-submitted
  via one `FollowerOrigin` key, so posting **rate** is operator-controlled too; a
  compromised follower key = arbitrary weight + identity forgery (`L2-follower.md`
  §10). Put the origin behind the same k-of-t as `link_identity`; the
  `EnsureOrigin` hook is already in place. The 1:1 binding invariant
  (`pallet-cogno-gate`, §4.1) is the Sybil anchor — if it ever lets a pkh bind two
  accounts, capacity multiplies for free.
- **Metadata-coupled clients.** Every runtime change (new pallet/call, adding
  `pallet-session`/`pallet-anchor`) requires a `spec_version` bump + regenerating
  PAPI/subxt descriptors, or clients fail to encode (`PLAN.md` §9). Keep the
  client in lockstep with consensus-layer pallet additions.
- **Benchmarking is load-bearing, not cosmetic.** `post_message` backs the only
  anti-spam, so `dev_mode`/placeholder weights are unsafe for any non-dev run —
  benchmark `post_message` (len-parameterized), `current_capacity`, and `consume`
  to real `WeightInfo` (§5.4, `PLAN.md` M5).
- **Binding-key correctness is inherited, not re-checked (the key *type* is now
  RESOLVED).** The runtime stores whatever 32-byte identity hash the follower
  submits and asserts **only** `len() == 32` (DR-01). Correctness — that the hash
  is `blake2b_256(serialized owner Address)` and that the CIP-8 committed-payload
  signature recovers a signing Address **exactly equal** to `datum.owner` (payment
  AND stake cred; DR-01/DR-02) — is the follower's job in v1; the on-chain ed25519
  self-proof is the DEFERRED D1 (§11-Q10). The old credential-kind question
  (payment vs stake/reclaim cred; `L2-follower.md` §7.4 oq2) is **no longer open**:
  identity is the whole Address, so the wrong-address binding gotcha is structurally
  closed. A compromised follower can still bind a phantom identity to weight the
  signer doesn't control (the trust-boundary risk above), but it can no longer be a
  *credential-kind ambiguity*.
- **GPL-3.0 boundary.** `CheckCapacity` is adapted from Gallois's GPL-3.0
  `CheckRate`; if vendored, that file/derivative inherits GPL-3.0 — reconcile with
  the workspace license.

---

## 10. How L1/L2/L3 interact (end-to-end)

The complete loop. L1 holds ADA, L2 turns vaults into one weight + a binding, L3
turns weight into feeless capacity-gated posting; reads never touch Cardano.

```
  L1 CARDANO (talk_vault)        L2 FOLLOWER (trusted oracle v1)        L3 cogno-chain (this doc)
  ════════════════════════       ══════════════════════════════        ════════════════════════════════
  user LOCKS >= min_lock ADA at   observe vaults (Kupo, by Address);    pallet-cogno-gate (8)
  talk_vault(min_lock) MERGED     bury past k; aggregate per identity  ┌──────────────────────────────┐
  mint+spend (DR-18)              largest-wins/never-sum (DR-34) ─────▶ │ link_identity (FollowerOrigin)│
  datum { owner: Address }        => ONE weight per identity          │ 1:1 identhash<->AccountId     │
  + beacon = blake2b_256(Addr)    (identhash = beacon = 32B)          │ (32B blake2b_256(owner Addr)) │
  ADA-only, owner-reclaimable                                          │ is_allowed = true             │
  (no token, no timelock)         CIP-8 committed-payload verify       └───────────────┬──────────────┘
        │ (one-time onboarding)   exact whole-Address match (DR-02) ──────────────────▶│ on_first_bind -> cap=0
        │                                  │                            pallet-talk-stake (9)
        │                         set_stake(account, weight) ────────▶ ┌──────────────────────────────┐
        │                         (FollowerOrigin, going-forward only) │ AllowedStake: Acct -> weight  │
        │                                                              └───────────────┬──────────────┘
        │                                                              capacity (folded in microblog)
        │                                                              cap=min(weight*CapRatio, Ceiling)
        │                                                              ┌──────────────────────────────┐
        │                                       FEELESS post (sr25519) │ CheckCapacity::validate():    │
        │                                       ─────────────────────▶ │  have>=need? no->ExhaustsRes  │
        │                                                              │  yes->admit (priority~remain) │
        │                                                              │ body: is_allowed -> insert    │
        │                                                              │ post_dispatch: consume        │
        │                                                              │ fee skipped (feeless_if+Skip) │
        │                                                              └───────────────┬──────────────┘
        │ unlock anytime (owner spends; no timelock)                                   │ PostCreated event
        └──────────── spent_at observed, buried -> set_stake(acct,0)                   ▼
                      -> cap clamps to 0 (row NEVER deleted)            READ: PAPI watchEntries / indexer
                                                                       (NO Cardano round-trip on reads)
   ┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
   │ DEFERRED ANCHOR: L3 GRANDPA-finalized state-root --(relayer, Ogmios)--> Cardano metadata/checkpoint│
   │                  -> anchor_ack records it. Tamper-EVIDENCE only, if history is independently kept.  │
   └─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**One sentence:** lock ADA on L1 → the follower aggregates it to one weight and
binds your identity → L3 sizes a regenerating capacity bucket from that weight →
a feeless post is admitted at the pool only if the bucket has room and consumed at
inclusion → anyone reads the feed straight from L3 with no Cardano round-trip.

---

## 11. Open questions for the owner

> RESOLVED in DECISION-REGISTER.md (2026-06-16) — see that doc. Several items below
> are now decided: the binding-key credential type (Q5 — identity is the whole
> Address, DR-01/DR-02), `NextPostId` (Q7 — `u64`, DR-21), `MaxLength`/
> `MaxPostsPerAuthor` (Q7 — 512 / 10_000, DR-10b), the regen window (Q2 — ~5h,
> DR-10), the curve (capped-linear + ceiling, DR-11), partial-unlock decay (Q4 —
> clamp-only in v1, DR-13), and onboarding (Q3 — accept a short charge-up / copy-only,
> DR-12). Detail is kept below for context.

1. **Fold capacity into `pallet-microblog`, or keep a separate
   `pallet-talk-capacity`?** (Recommend fold; `ECONOMICS.md` §9 allows both.) Does
   the extra pallet boundary buy anything?
2. **The ceiling NUMBERS** (`Ceiling`, `CapRatio`, `RegenPerBlock`/regen window,
   `BaseCost`, `PerByteCost`) — deferred to `ECONOMICS.md` §10 Q1–Q9, but L3 needs
   concrete starting values to benchmark against. Pick a regen window (hours?) and
   a baseline-stake posts/day before M2c.
3. **Onboarding sweetener** (`ECONOMICS.md` §6.2, open sub-question): new
   identities start at zero. Keep onboarding friendly via a one-time small free
   allowance at bind, a low `BaseCost` first-post, or accept a short charge-up?
   (Note: any free-allowance-at-bind must NOT reopen the cheap-identity burst farm
   — keep it below one post's `post_cost` or rate-limited.)
4. **Partial-unlock decay: keep v1 clamp-only, or implement the
   `ECONOMICS.md` §6/Q6 decay schedule?** v1 deliberately narrows to clamp-only
   (a partial weight decrease lowers the ceiling on next read but does not actively
   decay banked `cap_last`; §4.3). Full unlock (`weight → 0`) is unaffected, so the
   relock farm stays closed either way — this only changes how fast a *partially*
   unlocked account's existing burst shrinks. Worth the extra state/complexity?
5. **Binding-key credential type** — **RESOLVED (DR-01/DR-02).** Identity is the
   WHOLE CIP-19 Address (payment cred — `VerificationKey`-only in v1 — + stake cred),
   not a bare `owner_pkh`; the CIP-8 bind is an exact whole-address match. L3 now
   enforces `len()==32` on `blake2b_256(owner Address)` and is insensitive to the
   internal credential kind. The old `L2-follower.md` §7.4 oq2 is historical.
6. **Block time / `slot_duration`** for Aura — this sets the regen-per-block math
   and the anchor cadence. What target?
7. **`MaxLength` / `MaxPostsPerAuthor`** — **RESOLVED (DR-10b):** 512 / 10_000
   (still tunable). And `NextPostId` is **`u64`** (DR-21) — the u32-vs-u64 question
   is settled (u64, wraparound caveat removed).
8. **`FollowerOrigin` threshold for v1** — single dev key (labelled) for the
   showcase, or stand up the k-of-t collective from the start? (Shared with
   `L2-follower.md` §8.5 / Q4.)
9. **Authority set size** for v1 Aura/GRANDPA — 1 (single sequencer, no finality
   safety) or 3 (one-fault-from-stall)? And when is the SPO-committee graduation a
   hard requirement vs deferred (coupled to L2 D3/D4)?
10. **On-chain CIP-8 self-proof (D1) in L3 scope?** Moving `link_identity` to an
   in-runtime `ed25519_verify` self-proof removes the operator from identity
   correctness but adds `no_std` COSE/CBOR as critical attack surface
   (`L2-follower.md` §7.2/Q1). In or out for v1?
11. **Anchor: in v1 or deferred?** Tier-A metadata is cheap; what archival
   commitment backs "anyone can verify"? (Shared with `PLAN.md` Q4.)

---

## 12. Implementation milestones (L3)

Bite-sized, executable cold; each builds on the last. Aligns with `PLAN.md`
M0–M5.

1. **M0 — Template stands up, plain post, no Cardano.** Pin a recent monorepo
   solochain commit; record its exact `rust-toolchain.toml` + wasm target; install
   system deps. Add `pallet-microblog` (`post_message`/`delete_post`, bounded text,
   **no gate, no Hold, no capacity**) at index 8; `cargo build --release`;
   `--dev` produces blocks; a signed `post_message` lands; `Posts.getEntries()`
   returns it. Treat "compiles + `--dev` blocks" as a real de-risking task.
2. **M1 — Capacity math + the feeless gate (no Cardano weight yet).** Add the
   `Capacity` storage + `current_capacity`/`on_first_bind`/`post_cost`/`consume`
   (§4.3) and the `CheckCapacity` `TransactionExtension` (§5); wire it into the
   TxExtension tuple **before** payment. Waive the fee via `feeless_if(true)` +
   `SkipCheckIfFeeless<ChargeTransactionPayment>` (the fee waiver — distinct from
   `CheckCapacity`'s `Weight::zero()` unspent-weight report, §5.1). `sudo`-grant
   weight via a stub. An over-budget account is rejected at the pool with
   `ExhaustsResources`; a weighted account posts feelessly until its bucket drains,
   then waits for regen.
3. **M2 — The gate + weight pallets.** Add `pallet-cogno-gate` (8) and
   `pallet-talk-stake` (9) with `link_identity`/`set_stake` gated by
   `FollowerOrigin = EitherOfDiverse<EnsureRoot, EnsureSignedBy<FollowerKey>>`;
   enforce the hard 1:1 binding (both directions), `len()==32` (the 32-byte identity
   hash, DR-01), going-forward-only + clamp-to-zero (clamp-only decay, §4.3), first-bind
   `on_first_bind` **+ `inc_providers`** (so the first feeless post survives
   `CheckNonce`, §5.5), and the **bind-before-weight** ordering (§2.2).
   `post_message` calls `is_allowed`. Posting fails `NotAllowed` for an unbound
   account; the capacity bucket is keyed to the 1:1-bound account.
4. **M3 — Frontend post/read loop.** Next.js + PAPI: hdkd/sr25519 signer,
   `post_message`, live feed via `watchEntries()`; show capacity/regen countdown.
   (`PLAN.md` M1.)
5. **M4 — Real weights (benchmark) + L2 wiring.** FRAME-benchmark `post_message`
   (len-parameterized, including the gate's 2 reads), `current_capacity`,
   `consume`; replace `dev_mode` weights with real `WeightInfo`; **compute and
   record the posts-per-block ceiling** (`floor(0.75·MAXBLOCK / post_message(MaxLength))`,
   §5.4) — this is the step that turns the block-weight backstop from asserted into
   proven, so **no non-dev deployment before it**. Point the real follower at
   `set_stake`/`link_identity` (L2 milestones). (`PLAN.md` M2c/M2d/M5.)
6. **M5 — Mutable authorities + decentralization story.** Add `pallet-session` +
   the validator-management pallet so Aura/GRANDPA follow session rotation
   (operator-gated `AddRemoveOrigin`); write the drop-sudo → SPO/Ariadne committee
   design (coupled to L2 D2–D4). (`PLAN.md` M5 / Approach B.)
7. **M6 — Deferred anchor (optional).** `pallet-anchor` (`anchor_ack`,
   idempotent, `FollowerOrigin`-gated) + the Anchor Relayer off GRANDPA finality →
   Cardano Tier-A metadata via Ogmios; UI shows "anchored at tx X"; verify against
   retained history. (`PLAN.md` M3.)

---

## Appendix A — Key references

- **In-repo (authoritative, build on these):** `DECISION-REGISTER.md` (the
  canonical 2026-06-16 decisions — OVERRIDES all docs; see the reconciliation block
  atop this doc); `docs/L1-cardano.md` (the **merged single** `talk_vault(min_lock)`
  validator with mint+spend, DR-18: `VaultDatum{ owner: Address }`,
  beacon = `blake2b_256(owner Address)` = 32B, ADA-only, owner-reclaimable, no token,
  no timelock; §9.3 floor-vs-ceiling; §10 L1→L2 read);
  `docs/L2-follower.md` (the follower: `set_stake`/`link_identity` via
  `FollowerOrigin`, going-forward + clamp, 1:1 binding on the 32-byte identity hash,
  CIP-8 committed-payload exact whole-Address bind (DR-02), §8.4 `EnsureOrigin`
  widening, §9 D0–D4, §12 first-bind);
  `ECONOMICS.md` (the capacity model: §4 lazy bucket, §6 pallets + going-forward +
  never-delete + first-touch-zero + Q6 decay-on-power-down, §7 feeless gate
  placement, §8 Sybil 1:1); `PLAN.md` (§5 microblog skeleton + the superseded Hold,
  M0–M5 roadmap, §9 honest risks).
- **Solochain template (in-tree):**
  https://github.com/paritytech/polkadot-sdk/tree/master/templates/solochain ;
  standalone mirror: https://github.com/paritytech/polkadot-sdk-solochain-template
- **`#[frame_support::runtime]` macro:**
  https://paritytech.github.io/polkadot-sdk/master/frame_support/attr.runtime.html
- **Node service wiring (Aura + GRANDPA):**
  https://github.com/paritytech/polkadot-sdk/blob/master/templates/solochain/node/src/service.rs
- **`TransactionExtension` trait (current; replaces `SignedExtension`):**
  https://github.com/paritytech/polkadot-sdk/blob/master/substrate/primitives/runtime/src/traits/transaction_extension/mod.rs
  ; forum intro: https://forum.polkadot.network/t/introducing-transactionextension/10827
- **Feeless reference (the `CheckRate` shape `ECONOMICS.md` §7 cites; GPL-3.0 — note
  it is feeless by OMITTING `ChargeTransactionPayment`, §5.1):**
  https://github.com/bgallois/substrate-feeless-solochain-template/blob/master/pallets/feeless/src/extensions.rs
- **`pallet-skip-feeless-payment` (`SkipCheckIfFeeless` + `feeless_if` — the actual
  fee waiver, §5.1):**
  https://github.com/paritytech/polkadot-sdk/blob/master/substrate/frame/transaction-payment/skip-feeless-payment/src/lib.rs
- **wasm target gating (`wasm32-unknown-unknown` → `wasm32v1-none`, Rust 1.84):**
  https://paritytech.github.io/polkadot-sdk/master/substrate_wasm_builder/index.html
- **`pallet-session` + mutable PoA validators:**
  https://paritytech.github.io/polkadot-sdk/master/pallet_session/index.html ;
  reference pattern: https://github.com/gautamdhameja/substrate-validator-set ;
  https://www.gautamdhameja.com/resilient-poa-network-substrate/
- **`pallet-collective` (`EnsureProportionAtLeast<M,N>` for k-of-t origins):**
  https://github.com/paritytech/polkadot-sdk/tree/master/substrate/frame/collective
- **`pallet-grandpa` (authority set, finality):**
  https://paritytech.github.io/polkadot-sdk/master/pallet_grandpa/index.html
- **IOG partner-chains (Ariadne/D-param template; ARCHIVED 2026-04-23, folded into
  Midnight — study, do not depend):**
  https://github.com/input-output-hk/partner-chains/blob/master/docs/intro.md
- **Attack of the Clones against PoA (the Aura cloning weakness):**
  https://arxiv.org/pdf/1902.10244
- **`sc-finality-grandpa` (finality notifications for the anchor relayer):**
  https://docs.rs/sc-finality-grandpa/ ; finality subscription RPC:
  https://github.com/paritytech/substrate/pull/5732
- **PAPI (typed client read/write):** https://papi.how/getting-started/ ;
  https://papi.how/typed/tx/ ; hdkd dev signer:
  https://www.npmjs.com/package/@polkadot-labs/hdkd
- **`DecodeWithMemTracking` (now required on call/extension types):**
  https://github.com/paritytech/polkadot-sdk/issues/7360
- **Provider/consumer references for feeless accounts (`CheckNonce` + new accounts):**
  https://github.com/paritytech/polkadot-sdk/issues/3991
