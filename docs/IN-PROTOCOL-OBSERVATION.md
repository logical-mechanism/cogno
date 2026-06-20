# cogno-chain — In-Protocol Deterministic Observation of Cardano (the D4 weight rung)

> **Status: IMPLEMENTED IN SHADOW (default-off enforcement) — proven live against preprod.**
> Branch `in-protocol-observation` off `main` @170fb3c. The design (this doc) is approved and built
> through **step 4**: the deterministic observation library (step 2), the `ProvideInherent` pallet +
> node IDP (step 3), and the shadow-validation layer (step 4: a default-off enforce/shadow flag, the
> shadow-diff observability tool, and the db-sync point-existence guard). The inherent runs **every block,
> verified cross-node**, but `EnforceWeight` defaults to `false` so it only PROJECTS weight — the trusted
> committee `set_stake` path still drives `AllowedStake`. **Cutover** (enforce = sole writer) is gated on
> ≥3 independent producers and is the only remaining step; until then this is **D4-SHAPED, not D4-TRUST**
> (§2). See **§14** for the landed-state summary + live evidence.

> **One sentence.** Today the Cardano→chain *weight* path is a **trusted off-chain oracle** (the
> follower reads the `talk_vault` UTxO set and *injects* the result via a privileged
> `talk_stake.set_stake` extrinsic). This doc replaces it with the partner-chain / Midnight
> standard — **in-node deterministic observation supplied as a Substrate inherent**, recomputed
> and rejected-on-mismatch by every importing validator — so the locked-ADA weight becomes a
> **consensus-verified output**, not a trusted write. Aura + GRANDPA are **unchanged**; only
> *where the Cardano read happens* moves (trusted service → in-node deterministic inherent).

This is not greenfield. It is the repo's own pre-specified graduation: `docs/L2-follower.md` §4/§5/§9
already names the weight-path glide path **D0 → D1 → D2 → D3 → D4**, where **D4** is exactly
"*migrate the pure §6.3 function into a `ProvideInherent` pallet (`create_inherent` / `check_inherent`);
every producer re-derives from its own buried indexer*" (`L2-follower.md` §9, §12 step 9). This doc
designs **D4 without the optional Mithril input** — the in-protocol re-verification half — and is
faithful to that ladder: the same `beacons → weights` pure function moves from the off-chain follower
into the runtime with **zero redesign of the app pallets** (`L2-follower.md` §9 throughline).

---

## 0. Reading guide / canon

Read these before implementing (this doc summarizes, it does not supersede them):

- `docs/L2-follower.md` — the authoritative L2 design. §4 (four trust approaches A→D), §5 (the four
  *ingress mechanisms*: **(a) inherent / (b) gated extrinsic / (c) OCW anti-pattern / (d) Mithril**),
  §6 (the deterministic observation pipeline), §9 (the D0–D4 milestone ladder), §10 (honest risks).
- `docs/DECISION-REGISTER.md` — **DR-07** (trusted follower; 3-of-5 at D2), **DR-09b** (reorg burial,
  grant-*k* + shorter clamp-*k*), **DR-13** (clamp-only decay, no L1 timelock), **DR-25** (Mithril
  deferred to D4), **DR-26** (1–3 permissioned operator nodes in v1; self-build, don't depend on the
  archived partner-chains repo).
- `docs/ECONOMICS.md` §4.1 + §6.2 — the weight→capacity curve (`cap = min(weight·CapRatio, Ceiling)`,
  `rate = weight·RegenPerBlock`); §6.1 — the `set_stake` invariants (largest-wins, going-forward-only,
  unlock→`weight=0`, never-delete-the-row). (The cap/rate *formula* is §4.1/§6.2; §6.1 is the
  invariants — cite each correctly.)
- `docs/D2-custody-runbook.md` / `docs/L3-SPO-graduation.md` — the custody + SPO/Ariadne graduation
  (the **deferred** committee-from-stake workstream; see §11).

**Live values referenced throughout** (verified read-only; do not move them):
applied vault policy id / validator hash `168a9710e991b768426b58011febec0fa3c5ff6beb49065cc52489c7`
(`contracts/vault.json`), unapplied blueprint hash `49ffbfc6…` (`contracts/plutus.json`);
`min_lock = 100_000_000` lovelace; identity key = the 32-byte beacon `token_name` =
`blake2b_256(plutus_data_cbor(owner Address))` (`services/cogno-follower/beacon.py`); dev capacity
constants `CapRatio=50`, `RegenPerBlock=2`, `Ceiling=5_000_000_000_000`, `MaxStakeWeight=45e15`
(`runtime/src/configs/mod.rs`). Runtime is **spec_version 107 / tx_version 2**; next free pallet
index is **16** (7 is permanently vacant; 8–15 used). cogno-chain block time
`MILLI_SECS_PER_BLOCK = 6000` (`runtime/src/lib.rs`), so 1 Aura slot = 6 s.

**Verified preprod Cardano anchor** (we are live on preprod; from the preprod genesis):
`SHELLEY_START_UNIX = 1655769600` (2022-06-21T00:00:00Z), `SHELLEY_START_SLOT = 86400`,
`SLOT_LENGTH_MS = 1000`, `k = 2160`, `f = 0.05`. ⚠ The preprod `shelley-genesis.json systemStart`
(`1654041600`, 2022-06-01) is the **Byron** start, **not** the Shelley anchor — preprod ran a 20-day
Byron prefix (20 s slots), so the Shelley era begins at absolute slot `86400` / wall-clock
`1655769600`. Pinning `systemStart` would offset every computed slot by exactly 86400 and brick every
node's read. Mainnet anchors must be verified the same way before any mainnet cutover (§5.2).

---

## 1. Scope

### In scope (this initiative)
- The **locked-ADA → `talk-stake` WEIGHT path** — the genuine in-protocol observation of Cardano UTxO
  state. Build, behind a flag and additively:
  1. a **deterministic observation library** (pure function: data source + stable reference → canonical
     observed state);
  2. a **node-side `InherentDataProvider`** that supplies the observation;
  3. a new **`ProvideInherent` pallet** (`create_inherent` / `check_inherent`) that verifies it and
     sets `talk_stake` weight from the verified inherent.

### Deferred to the end of the initiative (do **not** start now)
- **Ariadne / SPO-stake-derived committee selection** and validator-set decentralization. Keep the
  M6 operator/committee-curated validator set (`pallet-session` @15 + forked `pallet-validator-set`
  @14) exactly as-is. In-protocol observation is **separable** from committee-from-stake — and
  partner-chains confirms this: committee selection is *just another observation* through the
  identical inherent path, so we take the observation machinery without Ariadne (§11).

### Separate workstream (don't conflate)
- The **CIP-8 identity binding** (`cogno-gate.link_identity`) is a **signature verification**, not a
  Cardano-state observation (`L2-follower.md` §5.2/§7: "*identity is a GATED EXTRINSIC, never an
  inherent*"). Its trustless upgrade is the on-chain `ed25519_verify` self-proof (**D1**, behind a
  verifier audit), which has **no Cardano data source** and is *not* gated on L3 decentralization.
  Noted here as a distinct future workstream; the weight path is the real "observation" case.

### Not touched
- The **anchor relayer** (chain→Cardano state-root anchoring) is the WRITE/evidence direction and
  stays as-is. The **live preprod `talk_vault` Aiken contract must not change** (moving its hash
  orphans the M8 vault — CLAUDE.md).

---

## 2. Where this sits — the glide path and the honesty ceiling

`L2-follower.md` §9 (verbatim ladder, abridged):

| Rung | What | Unlocks | Requires L3 → SPO committee? |
|---|---|---|---|
| **D0** | Single follower + published spec + recomputer (SHIPS IN v1) | Auditability | No |
| **D1** | On-chain CIP-8 `ed25519_verify` self-proof (identity) | Identity trust → nobody | No |
| **D2** | k-of-t (3-of-5) committee `FollowerOrigin` | Removes the single follower key | No (marginal until D4) |
| **D3** | Optimistic / permissionless relay | Removes the trusted writer w/o a committee | Effectively yes |
| **D4** | **`ProvideInherent` re-verification (+ optional Mithril input)** | **Trustlessness end-to-end** | **YES** |

**This work = D4 minus Mithril.** Today the repo is at **D2-shaped** for writes (the committee path
exists but a single operator holds all 5 seats — "D2-SHAPED, not D2-TRUST"; `sync-weight.mjs` banner,
`docs/D2-custody-runbook.md`).

### The load-bearing caveat: this buys auditability, not trust, until multi-producer L3
`L2-follower.md` §5.1 is emphatic, and it bounds everything below:

> *"the trust-minimization only materializes when there are MULTIPLE independent block producers.
> Under single-operator L3 the sole author is the only 'checker,' so an inherent is no more trustless
> than a gated extrinsic."*

So on the current single-operator (or single-operator-controlled-committee) stack the inherent is
**D4-shaped, not D4-trust** — mirroring the existing "D2-SHAPED" label. The hard ceiling: **L2 can be
no more trust-minimized than L3 consensus.** What the inherent *does* buy immediately and for real:

1. **Consensus-pinned auditability.** The observation rule (largest-wins, MIN_LOCK floor, as-of cursor)
   becomes *the runtime's code*, re-runnable by anyone against the chain, instead of an off-chain
   service's behavior. The "determinism ⇒ auditable" claim (D0) graduates from "a published spec you
   trust the operator to follow" to "the protocol's own verified computation."
2. **The hard engineering, de-risked early and separably.** The determinism contract (§5) is the
   genuinely difficult part. Building and proving it now — in *shadow* mode, zero consensus risk
   (§9) — means the day L3 gains independent producers, the trust payoff is a flag flip, not a
   project.

**Therefore the sequencing (see §9):** build the inherent now and run it in **shadow** (emitted +
checked, but the committee `set_stake` still drives weight); ship the **cutover** (inherent becomes the
sole writer) only **co-sequenced with ≥3 genuinely independent producers**. Until then it stays
flagged-off and labeled D4-shaped. **Do not market the inherent as "trustless"** (`L2-follower.md` §10).

---

## 3. The trusted-oracle path today (what we replace)

The weight path is the off-chain read→write loop in
`services/committee/sync-weight.mjs` (+ the Python mirror `services/cogno-follower/vault.py`):

1. **Read** the vault beacon-UTxOs via db-sync: a read-only snapshot driven by
   `tx_out.payment_cred = <vault script hash>` (`sync-weight.mjs:125`).
2. **`pickLargest`** (`sync-weight.mjs:66`) — per beacon asset-name, keep the **single largest** UTxO
   (exactly one vault-policy asset at qty 1, positive lovelace); **never sum** (anti-Sybil).
3. **Reorg-burial gate** (`CONFIRM_DEPTH_SLOTS`, `sync-weight.mjs:38,78`) — credit a UTxO only if buried
   ≥ depth past the **live db-sync tip** (`max(block.slot_no)`, `:107`). `0` in the dev showcase.
4. **`lockToWeight`** (`:103`) — `lovelace ≥ MIN_LOCK ? lovelace : 0`.
5. **Resolve account** — `cognoGate.accountOf("0x"+beacon)` (`:187`); the beacon asset-name is used
   *directly* as the `AccountOf` key (no address re-derivation in the read path).
6. **Write** `talkStake.setStake(account, weight)` + `microblog.forceSetCapacity(account, …)` through
   the 3-of-5 committee (or sudo) — `setStakeFor`, `:142`. `talk_stake.set_stake` is gated by
   `SetStakeOrigin = AuthorityOrigin = EitherOfDiverse<EnsureRoot, EnsureProportionAtLeast<FollowerCommittee,3,5>>`
   (`runtime/src/configs/mod.rs:240,317`).

**Two sources of nondeterminism live here and are exactly what we eliminate:**
"unspent *now*" and the *live* db-sync tip (`max(block.slot_no)`). Both make the read depend on *when*
and *which node* runs it. The pure parts — `pickLargest`, `lockToWeight`, the MIN_LOCK floor — are
already deterministic and move into the runtime as the consensus rule.

---

## 4. Target architecture

```
        Cardano (preprod)                  cogno-chain VALIDATOR NODE                 cogno-chain RUNTIME (wasm, deterministic)
  ┌──────────────────────────┐      ┌──────────────────────────────────┐      ┌──────────────────────────────────────────────┐
  │ talk_vault beacon UTxOs   │      │ node-side InherentDataProvider     │      │ pallet-cardano-observer  (NEW, index 16)        │
  │ (policy 168a9710…)        │─────▶│  ref = f(PARENT block), NOT tip    │      │  ProvideInherent:                              │
  │ created_at/spent_at slots │db-snc│  (same on author+importer); AS-OF: │      │   • create_inherent  (author): emit            │
  └──────────────────────────┘      │   read tx_out.payment_cred         │      │       observe{ reference, ObservedVault }       │
                                     │     at/before slot {ref}           │─────▶│   • check_inherent (importer): re-read from     │
  cardano-node (per validator)       │   filter created≤ref & unspent@ref │ inh. │       OWN follower at {ref}; EXACT match or      │
  + db-sync (full / non-pruned)      │  → pickLargest → canonical encode  │ data │       FATAL reject; can't-read ⇒ DEFER (§6)      │
                                     └──────────────────────────────────┘      │   • is_inherent = true (pool-inadmissible)      │
                                                                                │  Mandatory dispatchable APPLIES (every node):   │
                                                                                │   monotonic ref ↑; for each (beacon,lovelace):  │
                                                                                │     account = CognoGate::AccountOf[beacon]      │
                                                                                │     weight   = lockToWeight(lovelace)           │
                                                                                │     ≤ MaxStakeWeight; set AllowedStake;         │
                                                                                │     prime capacity = min(weight·CapRatio,Ceil)  │
                                                                                └──────────────────────────────────────────────┘
```

### 4.1 The split: what is inherent data vs what is on-chain logic
The **only** thing that must travel as inherent data is the **raw observed Cardano read** — a canonical
set of `(beacon_name: [u8;32], lovelace: u128)` pairs as-of a stable reference slot. **Everything
downstream is deterministic on-chain state/logic and stays in the runtime:**

- `beacon → account` via `CognoGate::AccountOf` (`pallets/cogno-gate/src/lib.rs:114`) — *chain state*,
  identical on every node at a given block. **No address→hash derivation is needed in-runtime**: the
  beacon name *is* the vault UTxO's asset-name and *is* the `AccountOf` key (the `blake2b_256(plutus_cbor(owner))`
  derivation lives only in the off-chain *bind* path and stays there).
- `lockToWeight` (the MIN_LOCK floor) and the `pickLargest` largest-wins rule — pure; lifted into the
  runtime so they become *the consensus rule* rather than the follower's behavior.
- The capacity curve `cap = min(weight·CapRatio, Ceiling)`, `rate = weight·RegenPerBlock`
  (`ECONOMICS.md` §4.1 / §6.2) — pure.

Keeping account-resolution and the weight curve *in the runtime* (not pre-resolved off-chain) means
`check_inherent` verifies exactly one thing every node independently reproduces — the stable Cardano
read — and nothing that depends on chain state.

### 4.2 The new pallet — `pallet-cardano-observer` @ index 16
A new pallet (working name) implementing `ProvideInherent` for the **weight path only**:

```rust
// frame_support::inherent::ProvideInherent  (_sdk/substrate/frame/support/src/inherent.rs)
const INHERENT_IDENTIFIER: InherentIdentifier = *b"cgnoobsv";   // 8 bytes
type Call;   type Error: Encode + IsFatalError;
fn create_inherent(data: &InherentData) -> Option<Call>;        // AUTHOR only
fn check_inherent(call: &Call, data: &InherentData) -> Result<(), Self::Error>;  // importers
fn is_inherent(call: &Call) -> bool;                            // → true (pool-inadmissible)
fn is_inherent_required(data: &InherentData) -> Result<Option<Self::Error>, Self::Error>;
```

- One inherent-only dispatchable `observe { reference: CardanoRef, vault: ObservedVault }`.
  `is_inherent` returns `true` for it ⇒ it can **never** enter the public tx pool — satisfying the
  `L2-follower.md` §5.2 mutual-exclusion invariant ("*never expose the same dispatchable as both a
  signed extrinsic and an inherent*"). It is declared `DispatchClass::Mandatory` (the
  `parachain-system::set_validation_data` pattern) so that, **when included**, it cannot be weight-trimmed
  and its dispatch errors invalidate the block. ⚠ `Mandatory` does **not** *force* inclusion — that is a
  separate mechanism (`is_inherent_required` / the author always emitting it). Since the author emits the
  inherent **every block** (full set, not a delta — see §4.4), inclusion is guaranteed by the author, and
  `is_inherent_required` may stay `Ok(None)` (it is "*only checked by block producers, not all full
  nodes*" — `inherent.rs:61` — so it is not a cross-node guarantee anyway).
- Storage: `LastReference: CardanoRef` (the monotonicity anchor, §5.6) and `LastObserved`
  (a bounded set of the previously-credited beacons + their resolved accounts) — **required** so the
  Mandatory dispatchable can compute the unlock-clamp set as `LastObserved \ current` (§7 step 5). A bare
  `LastDigest: H256` is **insufficient** for this: a one-way set hash cannot tell you *which* identities
  dropped out, and the safety-critical clamp path needs exactly that. (An optional `LastDigest` may be
  kept purely as a cheap "did anything change" log line; it is not load-bearing.) Weight itself continues
  to live in `talk_stake` (`AllowedStake`) and capacity in `microblog` — this pallet *drives* those via
  their existing internal entry points, it does not own them.
- `Config`: a `MaxStakeWeight` re-assert (defence-in-depth; see §7), the per-network Cardano anchor
  constants + stability window + `SLOT_DURATION_MS` (§5), the `vaultHash` (pinned as a runtime constant so
  a misconfigured node can't silently observe the wrong policy), and a `MaxObserved` bound on `LastObserved`.
- **Declaration order matters.** Inherents apply in pallet-declaration order. The Mandatory dispatchable
  *reads* `pallet_timestamp::now()` (the block's authored consensus time, for the §5.6 stability-bound
  sanity check) and `CognoGate::AccountOf`, so this pallet must be declared **after** `Timestamp` (@1) and
  `CognoGate` (@8) — index 16 satisfies both. (Note the *reference slot itself* is **not** derived from
  this block's `now()`; it is derived from the **parent** block — see §5.1 — precisely because
  `check_inherent` cannot see this block's timestamp.)

### 4.3 Node-side `InherentDataProvider` (the IO half)
A new IDP wired into **both** closures in `node/src/service.rs` — the import-queue CIDP
(`service.rs:94-110`) and the authoring CIDP (`service.rs:261-270`) — alongside the existing
timestamp/slot providers. **Both closures already receive `parent_hash`** (the authoring closure ignores
it today as `move |_, ()|` — bind it). The IDP:

1. derives the **reference slot deterministically from the parent block** (§5.1) — using `parent_hash`,
   so author and importer compute the *identical* reference without seeing this block's body;
2. reads db-sync **as-of that reference** in a single read-only MVCC snapshot — the vault UTxOs driven by
   `tx_out.payment_cred = <vault script hash>`, with spentness read from `tx_in` and coins/quantities as
   `::text` strings — then applies the unspent-as-of-ref predicate **in SQL/client-side**:
   `created_at.slot ≤ ref AND (spent_at == null OR spent_at.slot > ref)`. A single snapshot gives the
   exact set as-of the reference slot directly, with no live-tip dependency. (This is why db-sync must run
   **full / non-pruned**, §5.4: a pruned `spent_at` makes the predicate uncomputable.)
3. runs `pickLargest` and **canonically encodes** the result (§5.3).

Only the **pure largest-wins / floor / encoding LOGIC** is shared with the runtime (§9 step 1) — *not*
the IO. The existing db-sync readers are off-process (Python follower, JS committee tooling); the node
gains a **new node-crate dependency** (an **async** Postgres client — a *blocking* call inside the async
CIDP closure would stall the executor and is an anti-pattern; cumulus's `parachain-inherent` does all its
relay reads via `.await`, the precedent to follow).

**Fail-closed, with a hard timeout.** If the IDP cannot resolve the canonical set at the reference (db-sync
behind/down, the reference point fails the existence check), it emits the
**empty / no-op** observation — it never guesses (§6). The read must be bounded by an **in-IDP timeout
well inside the slot/proposing budget**: on the author, a slow IDP causes a *skipped slot*
(`sc-consensus-slots` runs the CIDP under a `select(delay, …)` and abandons the slot past the proposing
deadline — `slots.rs`); on an importer it stalls that block's import. The timeout must fire and emit the
no-op observation before either deadline, so "fail-closed → empty observation → chain stays live" is
actually reachable.

### 4.4 The inherent payload — the full observed set, every block
Carry the **full `ObservedVault`** in the inherent body **every block** (not a delta):

```rust
struct CardanoRef    { slot: u64, block_hash: [u8; 32] }    // the stable as-of point (= f(parent), §5.1)
struct ObservedVault { reference: CardanoRef, entries: Vec<([u8;32] /*beacon*/, u128 /*lovelace*/)> }
```

Always carrying the full set (vs delta-emission) is the deliberate choice, for two reasons the review
surfaced:

1. **The clamp set must be derivable.** Unlock detection (§7 step 5) is "credited last block, absent now →
   `weight=0`". With a delta + a bare digest there is no on-chain source for "absent now"; with the full
   set each block, the clamp set is `LastObserved \ current.entries` — computable in the dispatchable.
2. **A per-block author commitment.** With delta-emission, a block that *omits* the inherent is
   indistinguishable from "nothing changed", so a withholding author who *observed* a change but emitted
   nothing is invisible to `check_inherent` (which only fires on a *present* inherent). Carrying the full
   set every block makes every block carry a checkable commitment.

Cost is trivial — `~34 + 50·N` bytes for a small private-vault set. (Delta-emission is a possible *later*
optimization, but only if `LastObserved` is still stored for the clamp diff; and it re-introduces the
"suppression invisible to `check_inherent`" caveat — on a single producer, weight changes could be
withheld indefinitely with no on-chain evidence, which the next honest author would correct. This is the
§2 "only as trustless as the producer set" ceiling applied to the *suppression* case. Default: no
delta-emission.) The digest, if kept, lives **only in storage** as a cheap change-log — **not** in the
block header: a FRAME pallet cannot freely add header digest items (`Executive::final_checks` asserts
exact digest-log equality), and the partner-chains "`mcsh`-in-the-header" detail buys nothing here.

### 4.5 Coexistence — what must NOT be disturbed
- **`cogno-gate` `AccountOf`**: unchanged; the inherent *reads* it in-runtime instead of the follower
  reading it off-chain.
- **Identity (`link_identity`)**: stays a committee/`FollowerOrigin`-gated extrinsic, **never** an
  inherent (`L2-follower.md` §5.2). Separate workstream (§1, §11).
- **The committee**: `set_stake` *and* `force_set_capacity` drop out of the committee's *routine* workload;
  `link_identity` / `anchor_ack` / `add_validator` stay committee-routed. **Both** `set_stake` and
  `force_set_capacity` are retained as **dev-only / break-glass** overrides (feature/profile-gated), never
  the routine weight path post-cutover. The observer pallet drives weight + capacity via `talk_stake` /
  `microblog`'s **existing internal entry points** (not the `SetStakeOrigin` / `ForceOrigin` extrinsics),
  so the going-forward-only / unlock→0 / never-delete-the-row invariants are preserved unchanged.
- **Session / validator-set seam (M6)**: **completely untouched.** Aura/GRANDPA authorities are seated
  via `pallet-session` (`SessionManager = pallet-validator-set @14`); `add/remove_validator` is
  `AuthorityOrigin`-gated and applied at the next-but-one session boundary (`docs/M6-build.md`). The
  inherent injects *weight* (who may post, how much), which is orthogonal to *which keys author/finalize*.
  The inherent is simply one more per-block item every curated validator produces and checks.

---

## 5. The determinism contract (the heart of the design)

Every node must compute a **byte-identical** observation or the chain forks. These rules are mandatory.

### 5.1 The reference is a pure function of the **parent** block — not the live tip, not this block's clock
The reference slot is computed **deterministically from the parent block**, so the author and every
importer arrive at the *same single value* (no band, no discretion) — and crucially, **both can compute
it without seeing this block's body**. This is what makes the cross-node exact-match (§6) work.

**Why the parent, not this block?** `check_inherent` runs via the `BlockBuilder::check_inherents`
runtime API **at the parent state** (`client_side.rs` passes `parent_hash`; the block is *not* executed
there), so this block's `pallet_timestamp::now()` is **not** available at check time — it returns the
*parent's* timestamp. And the importer's inherent-data closure also runs at `parent_hash`, *before* it
can see this block's slot/timestamp. The one input both the authoring and import closures provably share
is the **parent block** (both receive `parent_hash`). So we anchor the reference there:

```
// computed in the node-side IDP (author + importer), from the parent header — checked arithmetic:
s_parent       = aura_slot(parent_header)                       // parent block's Aura slot (in its digest)
parent_unix_s  = (s_parent * SLOT_DURATION_MS) / 1000           // canonical slot-start time; integer math
if parent_unix_s < SHELLEY_START_UNIX                  { → EMPTY observation }   // young chain / wrong net
cardano_slot   = SHELLEY_START_SLOT + (parent_unix_s − SHELLEY_START_UNIX)       // Shelley: 1 slot/s
reference_slot = cardano_slot.checked_sub(STABILITY_SLOTS)?                       // None → EMPTY observation
if reference_slot < SHELLEY_START_SLOT                 { → EMPTY observation }
```

Because the parent is identical for the author and every importer, every honest node computes the
**identical** `reference_slot` and reads db-sync at that exact slot — so the §6 byte-exact match is well-defined
(there is no author-chosen band that a slightly-lagging importer could fail to reproduce). The reference
trails this block's time by only one slot (~6 s) plus the stability window — negligible. (This adapts the
partner-chains `mcsh` pattern to an Aura chain, where the only block-authoritative clock the importer's
local inherent data carries is the slot, not a wall-clock timestamp.)

**Defense-in-depth in the Mandatory dispatchable** (which *does* run in `execute_block`, after the
Timestamp inherent @1, so this block's `now()` is set there): assert `reference.slot ≥ LastReference.slot`
(monotone) **and** `reference.slot ≤ f(now()) − STABILITY_SLOTS` (never fresher than the stability
window). These are sanity bounds that hold even on nodes that skipped `check_inherent` (warp/state sync,
§6); the exact cross-node pinning is `check_inherent`'s job.

**Reference clock = the parent block's Aura slot** (open question 4 — *inverted* from the first draft):
the Aura slot is the only per-block-deterministic clock available in the importer's local inherent data
(the timestamp IDP is left at the importer's own `from_system_time()` and is never replaced; only the
slot is block-authoritative). Use `pallet_timestamp::now()` **only** for the in-dispatchable upper-bound
sanity check above, never as the reference clock.

### 5.2 The stability window — slot-denominated `3k/f`, conservative
Cardano (Ouroboros Praos) is *probabilistic*; we must read only history that can never roll back.
With mainnet/preprod `k = 2160` (`securityParam`) and active-slot coefficient `f = 0.05`:

- `k/f` = 43 200 slots ≈ **12 h** — partner-chains' *lower* bound (a block must be at least this old).
- `3k/f` = 129 600 slots ≈ **36 h** — the Praos common-prefix / stability window; the horizon
  partner-chains/Midnight and Cardano's own stack treat as immutable.

**Production default `STABILITY_SLOTS = 129_600` (3k/f, ~36 h).** Reasons it is load-bearing: (a) it is
*pure integer arithmetic on a slot number*, unlike "count k blocks back" (itself a fork-sensitive,
chain-dependent quantity); (b) it is strictly more conservative than the k-*block* rule; (c) it matches
the partner-chain horizon. A **smaller value is permitted only on dev/testnet as an explicit, labeled
safety relaxation** (a knob, not a protocol constant). Adopt partner-chains' extra
`BLOCK_STABILITY_MARGIN` (normally `0`; raise to `1` only if data-source lag causes import rejections).

**Per-network anchor constants** (compile-time, pinned): `SHELLEY_START_UNIX`, `SHELLEY_START_SLOT`,
`SLOT_LENGTH_MS = 1000`. **Verified preprod values** (we are live there): `SHELLEY_START_UNIX = 1655769600`,
`SHELLEY_START_SLOT = 86400` (§0). ⚠ **`systemStart` is NOT the Shelley anchor** — preprod's
`shelley-genesis.json systemStart = 1654041600` is the *Byron* start; the Shelley era begins 20 days later
at slot 86400 / `1655769600`. Pinning `systemStart` offsets every slot by 86400 and bricks every node's
read. The mainnet anchor candidates likewise differ (`1596491091` vs the Byron `1596059091`) and **must**
be verified against the mainnet genesis before any mainnet cutover. **Startup self-check** (before the
inherent is enabled): round-trip a known recent `(slot, time)` pair through the anchor and refuse to start
on mismatch.

**Fail-closed arithmetic — do not rely on overflow panics.** The release WASM runtime is built with
overflow-checks **off** (wrapping arithmetic), so a naive `substrate_time − SHELLEY_START_UNIX` on a
wrong-network / pre-Shelley input would **wrap to ~`u64::MAX`** (not underflow below a floor), sail past a
`≥ SHELLEY_START_SLOT` guard, and read at an impossible slot. Therefore every step uses an explicit guard
+ `checked_sub` and maps any failure to the **empty observation** (§5.1 pseudocode): guard
`parent_unix_s ≥ SHELLEY_START_UNIX` *before* subtracting, `checked_sub(STABILITY_SLOTS)`, and
`reference_slot ≥ SHELLEY_START_SLOT`. Add a unit test compiled with `overflow-checks = false` so CI
(which builds debug, checks **on**) cannot mask the wrap.

### 5.3 Canonical encoding (the hashing law)
After applying the consensus filters, encode the observed state deterministically:

1. **Filter** (in-runtime, the lifted `pickLargest`/`lockToWeight`): exactly one beacon under the vault
   policy at qty 1; positive lovelace; `created_at.slot ≤ reference_slot`;
   `spent_at == null OR spent_at.slot > reference_slot`; **largest-wins per beacon (never sum)**;
   MIN_LOCK floor.
2. `beacon` is the **raw 32 bytes**, never hex (hex-case is a divergence trap).
3. **Sort entries strictly ascending by the 32 beacon bytes.** This is a strict *total* order because the
   largest-wins fold is keyed by beacon (`pickLargest` uses a `Map` keyed by beacon with strict `>`,
   `sync-weight.mjs:91`), so each beacon appears at most once and two equal-lovelace duplicates of the same
   beacon collapse to one value-identical entry — no ties, no per-UTxO tiebreak needed (the design carries
   only the deterministic lovelace *value*, never a chosen UTxO reference, so DR-06's output-ref tiebreak is
   moot here).
4. `lovelace` as `u128`, parsed from the `coins` field **as an integer string** (db-sync emits coins as
   `::text`) — never `f32/f64` (cross-platform float nondeterminism).
5. **Only two fields enter the encoding**: the 32-byte beacon name (under the pinned `vaultHash` policy)
   and the integer `coins`. **Every other field of the read is excluded by construction** — `datum`,
   `datum_hash`, `script`, `address`, `output_index`, and any non-vault native assets in the same UTxO —
   so representation differences in those fields **cannot** fork the chain. (The
   talk_vault UTxO carries an inline datum, but the in-runtime applier never needs it: the beacon name is
   the `AccountOf` key directly, §4.1.)
6. Encode with **SCALE** (the chain's canonical codec — no JSON, no CBOR), then `blake2_256` for the
   digest.

### 5.4 Every nondeterminism source → mitigation
| Source | Why it diverges | Mitigation |
|---|---|---|
| **Live tip** | each node's tip differs | reference = f(parent block), §5.1; **the live tip never enters the enforced path** |
| **"unspent now"** | depends on tip | reconstruct unspent **as-of reference_slot** in one read-only MVCC snapshot: read the vault UTxOs at/before `{ref}` then apply `created≤ref AND (spent==null OR spent>ref)` — a single snapshot gives the exact as-of set with no live-tip dependency |
| **Rollbacks behind the read** | a fork changes recent UTxOs | reference is ≥36 h back (past max rollback); **tip-freshness guard** — the node reads db-sync `max(block.slot_no)` and abstains when its most-recent indexed slot is **behind the reference** (a behind/forked instance returns a partial set ⇒ this turns it into a non-fatal `CannotVerify` defer, not a false fatal `Mismatch`). Compare the **tip slot vs the reference**, NOT a header *at* the reference (≈95 % of slots are empty under f=0.05). The anchor block hash rides in `CardanoRef.block_hash`; `check_inherent` compares slot + entries (and, post-§15.3, the deterministic anchor `block_hash`). **LANDED step 4c** (`node/src/dbsync.rs`). |
| **Result ordering** | server/version/insertion order | canonical sort by beacon bytes; never hash wire order |
| **Excluded fields drift** (datum/script/address/output_index/other assets) | sources may represent these differently | **exclude all of them from the encoding**; hash only `(beacon, coins)` (§5.3 rule 5) |
| **db-sync pruning** | a pruned spent UTxO loses `spent_at` ⇒ the `spent>ref` predicate is uncomputable | **mandate db-sync full / non-pruned** (hard operator requirement) |
| **partial / late-started index** | a late-started db-sync lacks pre-genesis history | require the index to cover history back to vault genesis AND `reference_slot` within range; else **abstain** (treat as behind) |
| **Policy/pattern drift** | operator queries wrong policy | pin `vaultHash` as a **runtime constant**; drive the read from `tx_out.payment_cred = <vault script hash>` |
| **lovelace precision** | float parsing | parse `u128` from the `coins` string; reject non-integer; never floats |
| **value at/over `MaxStakeWeight`** | a max-supply UTxO sits exactly at the 45e15 bound | per-entry **skip/clamp** in the dispatchable (§7 step 3) — a deterministic decision, identical on every node |
| **rule drift between operators** | impl divergence | lift largest-wins + floor into the runtime as *the* consensus rule |
| **Byron 20s→Shelley 1s slot change** | general converter is fragile | pin the **Shelley anchor only**; assert `reference_slot ≥ SHELLEY_START_SLOT` (every honest ref ≥36 h old is deep in the 1 s era) |
| **future Cardano HF slot-length change** | silent breakage | pin `SLOT_LENGTH_MS=1000`; a change is a runtime upgrade + spec bump, never silent |
| **`u64` wrap in release WASM** (overflow-checks off) | a pre-Shelley/wrong-net input wraps instead of erroring | guard *before* subtraction + `checked_sub` everywhere → empty observation (§5.2); test with `overflow-checks=false` |

### 5.5 A consequence: DR-09b's asymmetric grant-*k* / clamp-*k* does **not** survive determinism
DR-09b (and `L2-follower.md` §6.2/§8.2) prescribes a *pragmatic grant-k* plus a deliberately **shorter
clamp-k** so unlock-clamps land faster than grants — a single-writer **liveness** optimization (a slow
clamp strands voice for a reclaimed user). **This optimization is incompatible with a consensus
inherent.** A "short clamp-k" within the rollback window would let two honest, independently-synced
nodes disagree on whether a recent spend has settled — a chain fork. For the in-protocol model **both
grant and clamp must read as-of a single conservative cursor** (`reference_slot`, ≥ the no-rollback
window). The honest consequence: **the unlock clamp now lags by the full stability window** (≈36 h with
the default), *slower* than v1's short clamp-*k*. This is **safe** (weight can never be double-counted;
a reorg can only ever transiently clamp-then-re-grant, never grant unearned voice) but it is a real
behavior change — a user retains voice for up to ~36 h after unlocking. It is acceptable on a testnet
PoC; it is a **mainnet tuning parameter** (open question 3). A two-cursor scheme (a closer clamp cursor)
is *not* viable without sacrificing determinism, because any clamp cursor inside the rollback window can
diverge across nodes. Note this *subsumes* rather than abandons DR-06's `clamp-latency ≤ grant-latency`
acceptance gate: with a single shared cursor, clamp- and grant-latency are **equal** by construction, so
the asymmetric-failure mitigation of `L2-follower.md` §8.2 is satisfied trivially — but the DR-06 test
assertion must be re-stated (or waived) for the D4 path so it doesn't read as a contradictory requirement.

### 5.6 Monotonicity + fail-closed
The Mandatory dispatchable asserts `reference.slot ≥ LastReference.slot` ("never propose older MC state
than the ledger already holds" — partner-chains' anti-regression rule). This prevents rollback and lets
the stability margin be raised safely. All edge cases (underflow, wrong network, unresolvable read) →
**empty observation (no-op), never panic** — an empty observation simply leaves weight unchanged this
block; the next healthy author catches up.

---

## 6. Verification & liveness semantics (the asymmetry that prevents forks)

The "mismatch → reject, can't-check → accept" asymmetry is what makes the inherent both fork-proof and
live — but **neither half is automatic; both must be coded deliberately** in the bespoke `InherentError`
+ the node-side IDP's `try_handle_error`. (The framework routes *every* error `check_inherents` returns —
fatal or not — through the IDP's `try_handle_error`, whose return value is the final import verdict:
`Some(Ok(()))` = accept, `Some(Err)` = reject, `None` = reject as "unknown".)

Define a typed `InherentError` with **three** variants (LANDED — the third added in the 2026-06-19
hardening pass, §15):

- **`Mismatch` — `is_fatal_error() == true`.** Returned by `check_inherent` when the importer's own read
  at the (parent-derived, §5.1) reference produces a *different* canonical set than the author's `call`
  **and the input commitments differ** (the importer saw DIFFERENT Cardano data). Its `try_handle_error`
  returns **`Some(Err(_))`** → block **permanently invalid**. **Exact equality, never a tolerance band** —
  a band would let a malicious author inject an observation no honest follower agrees with as long as it is
  "close." (`pallet_timestamp` *must* tolerate ±`MAX_TIMESTAMP_DRIFT` because wall clocks are never
  byte-equal; a stable-history Cardano read is the opposite kind of quantity and is matched exactly. Note
  pallet_timestamp marks **both** its errors fatal and does **not** "defer" via the inherent — its
  future-block tolerance is Aura's *header* drift check, a different mechanism — so it is the precedent for
  the *Mandatory/exact* half, **not** for the can't-check defer.)
- **`ComputeDiverged` — `is_fatal_error() == true`.** Returned when the author and importer agree on the
  raw Cardano inputs (identical `inputs_commitment`, the §15 `selection_inputs_hash` analog) but the
  *reduced* `entries` differ — i.e. the SAME data reduced to a different observed set, a determinism bug or
  a binary version skew. `try_handle_error` returns **`Some(Err(_))`** → reject (a divergent reduction must
  never be consensus-pinned). It is split out from `Mismatch` **only as a diagnostic**: it is the precise
  signal for the silent-fork risk an enforced multi-producer network most fears (the reduction code, not
  the data, diverged). The commitment is consulted **only** when the reduced reads already disagree — it
  **never** causes a rejection on its own, so two honest nodes whose raw candidate sets differ only in
  UTxOs the reduction drops (too-fresh / spent) but which reduce to the SAME `entries` are still accepted.
- **`CannotVerify` (a.k.a. `SourceBehind`) — `is_fatal_error() == false`.** Returned when the importer's
  *own* db-sync is behind the reference slot / down. Its `try_handle_error` returns **`Some(Ok(()))`** →
  **accept the block without verifying it**. This variant **must** be registered so the framework's
  unknown-error path (`None` → reject) cannot fire on it.

⚠ **The `try_handle_error` must branch on the decoded variant.** The obvious lazy implementation — a
blanket `Some(Ok(()))` — would swallow `Mismatch` too and silently turn the entire consensus check into a
no-op on every node. State this as a hard implementation rule. "Defer" here means **a final accept**, not
a re-check-later: stable2603 has **no** automatic inherent re-queue (the `Deferred` requeue is Aura's
*header*-time path, unrelated); once a node accepts on `CannotVerify`, it is done with that block.

**The safety this trades on (state it plainly).** "Accept on can't-verify" means a bad block is caught
only if **≥1 honest, caught-up, full-execution verifier** is in the import/finalizing set. That is exactly
the **multi-independent-producer** assumption D4's trust payoff already requires (§2). On a single-producer
stack there is no independent verifier at all — which is *why* cutover is co-sequenced with multi-producer
L3, and why this is D4-shaped until then.

**`check_inherent` is a soft network-edge gate — even softer than it looks.** Per the Substrate source
(`_sdk/substrate/frame/support/src/inherent.rs:76-79`), `check_inherent` runs in the import-queue verifier,
"*is not guaranteed to be run by all full nodes*", and is **not** re-run inside `Executive::execute_block`.
Further, Aura **skips inherent checking entirely on warp / state / gap sync** (`import_queue.rs` — blocks
imported with state are trusted wholesale). So the "honest caught-up verifier" must be a **full-execution
importer** (in practice the GRANDPA finalizing set), not just any node. This *tightens* the §2
"D4-shaped until multi-producer L3" conclusion, it does not break it. Consequently **anything that must
hold for every node** (monotonicity, `MaxStakeWeight`, weight/capacity application, account resolution) is
enforced **inside the Mandatory dispatchable** — which *does* run in `execute_block` on every node and
whose dispatch error invalidates the block — following the `parachain-system::set_validation_data`
pattern. `check_inherent` enforces the one cross-node thing: *the author's Cardano read matches mine.*

---

## 7. Weight application (in the Mandatory dispatchable, every node)
For each `(beacon, lovelace)` in the verified `ObservedVault`, atomically:

1. `account = CognoGate::AccountOf[beacon]` — skip (not an error) if `None` (bind precedes weight, as in
   `sync-weight.mjs:188`).
2. `weight = lockToWeight(lovelace)` (MIN_LOCK floor).
3. **Bound check, skip-not-reject.** If `weight > MaxStakeWeight`, **skip this single entry** (and log) —
   do **not** reject. ⚠ This is **new behavior**, deliberately *different* from the existing
   `set_stake`, which `return Err(WeightTooHigh)` rejects the whole call (`pallets/talk-stake/src/lib.rs:124`).
   An inherent runs inside a Mandatory block that cannot legitimately be failed by one bad entry, so a
   single absurd value must be skipped, never allowed to brick the block. (`MaxStakeWeight=45e15` equals
   the max ADA supply, so a max-value UTxO sits exactly at the boundary — `>` not `≥`.)
4. Set weight via `talk_stake`'s internal entry point (reuse the `StakeSet` event + the
   going-forward-only / unlock→0 / never-delete-the-row invariants — `ECONOMICS.md` §6.1,
   `pallets/talk-stake/src/lib.rs`).
5. Prime capacity `= min(weight·CapRatio, Ceiling)` (`ECONOMICS.md` §4.1/§6.2; the `force_set_capacity`
   math, `sync-weight.mjs:149`) via `microblog`'s internal entry point — folded into this one atomic
   write, retiring the separate `force_set_capacity` to dev-only (open question 8).
6. **Unlock clamp.** For each account in **`LastObserved`** (the previous block's credited set, §4.2) that
   is **absent from the current `ObservedVault`**, set `weight = 0` (capacity collapses on next read; the
   row is never deleted). This is why the inherent carries the full set and stores `LastObserved` — a bare
   `LastDigest: H256` cannot yield the "absent now" set. Finally, overwrite `LastObserved ← current` and
   `LastReference ← reference`.

This keeps `talk_stake` and `microblog` as the storage owners; the observer pallet only drives them via
their existing internal entry points — a thin, auditable addition to those pallets, not a rewrite. The
pallet is FRAME-benchmarked (DR-05 discipline).

---

## 8. Operational cost — the real change to the operator model
This is **the** change: every *verifying* validator must run its own buried Cardano indexer.

- **Recommended posture: `cardano-node` + Cardano db-sync (full / non-pruned, tx_in-enabled).** db-sync
  gives a deterministic "block at/before slot S" anchor and the indexed `tx_out.payment_cred` vault read.
  The real cost is **cardano-node** — every validator becomes a Cardano relay-class machine (~24 GB RAM,
  ~250 GB SSD, 1–2 day initial sync) plus the db-sync Postgres alongside it; see `L2-follower.md` §10
  "operational burden."
- **The read is scoped to one vault policy.** Even on whole-ledger db-sync, the consensus read touches
  only the vault-script address (`tx_out.payment_cred = <vault script hash>`, an indexed lookup), so the
  per-block cost is a single ~15 ms snapshot, not a whole-ledger scan.
- **A new async node dependency.** The node gains a **new Rust crate** — an **async** Postgres client —
  it does **not** "reuse" the existing off-process Python/JS readers (only the pure largest-wins/floor
  *logic* is shared, §4.3). A *blocking* call inside the async inherent-data closure
  would stall the executor; and the read's latency is on the **block path**: a slow/down db-sync on the
  **author** causes a *skipped slot* (`sc-consensus-slots` abandons the slot past the proposing deadline),
  and on an **importer** stalls that block's import. The in-IDP timeout (§4.3) must fire and emit the
  no-op observation well inside both budgets.
- **Liveness:** because the reference is ~36 h in the past, a validator fails to verify only if it is
  **>36 h behind or down** — a high bar; a node minutes/hours behind is fine, and lag never *diverges*
  the answer (the reference is a pure function of the block), it only delays. Combined with the §6
  optimistic-defer rule and the §5.6 author-abstain rule, **the Cardano feed never gates Substrate block
  production**: a node whose db-sync is stopped authors a no-op observation and the chain stays live.
- **Label it a `MAINNET PREREQUISITE`** for a multi-validator chain (§11). The weaker intermediate —
  an N-of-M committee that *signs* the observation rather than *every* validator re-deriving — is
  strictly weaker (reintroduces a trust assumption); call it out as an explicit trade, not the target.

---

## 9. Cutover plan (additive until cutover)
Ship the new path alongside the trusted writer, behind a flag; cut over deliberately. Each step is
independently testable and merges per the branch-per-unit-of-work convention.

**Step 1 — Deterministic observation library (no consensus impact). ✅ LANDED.**
Extract the largest-wins / MIN_LOCK / unspent-as-of-ref / reference-slot logic into a pure module,
shared between the off-chain reader and (later) the runtime. Replace `?unspent`+`ogmiosTipSlot` with
`?created_before={ref}` + the spent-by-ref predicate in `sync-weight.mjs` / `vault.py` (still driving
the *old* committee write). *Delivered:* `services/_shared/observation.mjs` (pure, dependency-free:
`cardanoReferenceSlot`/`referenceFromAuraSlot` with fail-closed checked arithmetic, `observeAsOf` the
as-of-reference largest-wins, `canonicalBytes`/`canonicalHex` the SCALE-compatible determinism witness) +
the Python mirror in `services/cogno-follower/vault.py`; `sync-weight.mjs` now reads as-of a stable
reference slot when `CONFIRM_DEPTH_SLOTS>0` (the legacy `?unspent`+`pickLargest` stays the dev fast path).
*Tests (all green):* `observation.test.mjs` (37) incl. the **byte-identical-across-shuffled-input**
determinism test + reference-slot wrap/Shelley-anchor/wrong-network edges; `test_vault.py` (+ the
**cross-language** canonical-bytes vector proving JS≡Python byte-for-byte); existing `committee` (72) /
`shared` (78) / `relayer` (63) / `beacon` (6) / `http` (23) suites unchanged. CI gains
`node services/_shared/observation.test.mjs`. **No spec bump** (off-chain only).

**Step 2 — Inherent provider, shadow / non-enforcing. ✅ LANDED (commits step 3a–3c + 4a–4c; see §14).**
Add `pallet-cardano-observer` @16 with `create_inherent` + the node-side IDP wired into both `service.rs`
closures. **Gate so the inherent is emitted + `check_inherent`-verified but its *application* is a no-op
(write-behind-flag)**; the committee `set_stake` still drives weight. Emit a metric diffing the
inherent-derived set vs the committee-written weight (reuse the Phase-2 observability layer). *Delivers:*
a live shadow proving the in-node read matches the trusted writer on real preprod data, **zero consensus
risk**. *Tests:* `check_inherent` exact-match units (match→Ok; single-byte mismatch→fatal); fold the
digest into the `verify-m4c` recompute gate; **spec bump 107→108 + PAPI regen**
(`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`);
`transaction_version` stays 2 (inherents are not signed txs).

**Step 3 — Verification + application (cutover). ⏳ GATED — the mechanism is built, the flip is not done.**
The default-off `EnforceWeight` flag + the `set_enforcement` cutover control are LANDED (step 4a); flipping
it is the cutover. ⚠ The cutover is **NOT a pure flag flip for weight already on-chain**: in shadow the
inherent's `LastObserved` clamp baseline tracks only what *it* observed, so an account the committee
credited but the inherent never saw (its db-sync lagging at flip time, or a beacon it skipped) would be
**stale and un-clampable** after the flip. So the cutover procedure is: (1) ≥3 independent producers each
running their own db-sync; (2) **stop the committee weight-sync**; (3) **reconcile** — drain/zero any
`AllowedStake` key not in the inherent's `ShadowStake` projection (so the keysets match); (4) THEN
`set_enforcement(true)`. Flip the flag: the Mandatory dispatchable becomes the **sole** weight writer (monotonicity +
`MaxStakeWeight` + capacity priming atomic); `is_inherent` keeps it off the tx pool; the committee-gated
`set_stake` is retired to dev-only / break-glass. *Delivers:* weight is now a consensus-verified output.
**Cutover gate:** co-sequence with ≥3 genuinely independent producers (§2); until then keep step 3
flagged-off and labeled D4-shaped. *Tests:* a multi-node testnet where each node runs its own db-sync —
prove a healthy block imports, a forced-mismatch block is rejected fatally, a node with a lagging db-sync
**defers (accepts)** rather than rejects, and authoring **abstains** (no-op inherent) when db-sync is
stopped while the chain stays live.

The migration is **throw-nothing-away**: the same pure function moves from the follower into
`create_inherent`/`check_inherent` with zero app-pallet redesign (`L2-follower.md` §9).

---

## 10. Spec-version & on-wire impact
- **spec_version 107 → 108 (developed) → 109 (merged) → 110 (hardening §15.2).** This branch added pallet
  @16 + new inherent call/storage at 108; on merge to `main` it shares the runtime with the
  trustless-identity (D1) branch which also claimed 108, so the combined runtime bumped to **109** (see
  §14.3); the 2026-06-19 input-commitment hardening (§15.2) added the `inputs_commitment` arg to the
  `observe` Call + a third `InherentError` variant, bumping to **110**. New pallet/call/storage =
  encoding-affecting — regenerate PAPI descriptors (CLAUDE.md spec-bump discipline). `transaction_version`
  stays **2**.
- **Pallet index 16** — new index; 7 stays vacant; 8–15 unchanged (indices are on-wire contracts).
- **`is_inherent = true`** on the `observe` call ⇒ pool-inadmissible; the dev-only `set_stake` stays a
  normal gated extrinsic — the two are mutually exclusive per call (`L2-follower.md` §5.2).
- The live `talk_vault` Aiken contract is **not touched** (no hash move).

---

## 11. What stays a MAINNET PREREQUISITE / deferred
Consistent with the repo's grep-enforced honest posture ("usable ≠ trustless / auditable ≠ trustless"):

- **D4-shaped, not D4-trust (the ceiling).** On a single-operator stack the sole author is the only
  checker; the inherent buys *auditability*, not *trust*, until multi-producer L3 (§2, `L2-follower.md`
  §5.1). The full trust payoff (step-3 cutover) is **co-sequenced with the SPO/Ariadne validator-set
  graduation**, not delivered by the inherent alone. Do not market it as "trustless."
- **Ariadne / committee-from-stake — explicitly separate & deferred.** Observation is the lower layer;
  Ariadne is a *consumer* of it (partner-chains' `pallet-session-validator-management`), plumbed through
  the *same* inherent-verify pattern — which is exactly why we adopt the observation machinery **without**
  it. SPO-registration ingress + D-parameter selection + Mithril stay DESIGN-ONLY
  (`docs/L3-SPO-graduation.md`). `MinAuthorities=1` and 1–3 operator nodes remain the honest permissioned
  posture; finality can stall on a 1–3 authority chain — say so to users.
- **Identity binding — separate workstream.** `link_identity`/CIP-8 stays a gated extrinsic, never an
  inherent. Its trustless upgrade is the on-chain `ed25519_verify` self-proof (**D1**, behind a
  Wormhole-class verifier audit; `L2-follower.md` §7.2) — not gated on L3 decentralization, but out of
  scope here.
- **Mithril input (the *other* half of D4) — deferred (DR-25).** This work is D4-minus-Mithril. Mithril
  proves transaction **membership, not address completeness** — even with it, the completeness assumption
  (an *omitted* vault is invisible) is **not** discharged. State this plainly: the inherent verifies the
  *computation* over observed UTxOs, not that the observation is *complete*.
- **Per-validator `cardano-node` + Cardano db-sync** is a hard `MAINNET PREREQUISITE` for a
  multi-validator chain (§8): full / **non-pruned** (history back to the reference) and **tx_in-enabled**
  (NOT `--consumed-tx-out`; the read probes `EXISTS (SELECT 1 FROM tx_in)` and abstains otherwise, so a
  mis-configured db-sync fails closed rather than forking on spentness).
- **The existing deferred `MAINNET PREREQUISITE` comments stay** (dev-key custody, prod genesis, GRANDPA
  equivocation, `MinAuthorities`) — do not "fix" them under cover of this work (CLAUDE.md).

---

## 12. Open design decisions (recommended defaults)
1. **Sequence vs multi-producer L3.** *Default:* build now in **shadow** (step 2); ship cutover (step 3)
   only with ≥3 independent producers; until then flagged-off + labeled D4-shaped.
2. **Data source.** *Default:* `cardano-node` + Cardano db-sync (full / non-pruned, tx_in-enabled) as
   canonical — the deterministic block-at/before-slot anchor + the indexed `tx_out.payment_cred` vault read.
3. **`STABILITY_SLOTS`.** *Default:* `129_600` (3k/f, ~36 h) on mainnet/preprod; a smaller **labeled**
   value on dev testnet only. **Note the §5.5 consequence**: unlock-clamp now lags the full window — a
   mainnet tuning decision.
4. **Reference clock.** *Default:* the **parent block's Aura slot** → canonical ms → Cardano slot − window
   (§5.1). *Inverted from the first draft:* the Aura slot is the only per-block-deterministic clock the
   importer's local inherent data carries; `pallet_timestamp::now()` is unavailable to `check_inherent`
   (which runs at parent state) and is used only for the in-dispatchable sanity bound.
5. **Inherent payload.** *Default:* the **full observed set every block** (no delta-emission), plus a
   stored `LastObserved` set so the unlock-clamp diff is computable; digest (if any) in **storage only**,
   never the header. (Delta-emission is a deferred optimization that re-introduces the suppression caveat,
   §4.4.)
6. **Mismatch vs can't-check.** *Default (non-negotiable):* mismatch → fatal reject; can't-check → accept/
   defer. Reversing this splits the chain on a slow node (§6).
7. **Forked/non-canonical db-sync answer.** *Default (LANDED, step 4c):* a **tip-freshness** guard — the
   node reads db-sync `max(block.slot_no)` and abstains (emits the empty observation → `CannotVerify`) when
   its most-recent indexed **tip slot is behind the reference**, so a behind/forked db-sync defers rather
   than returns a partial set that would trigger a false fatal `Mismatch`. Compare the **tip slot vs the
   reference**, never a header hash *at* the reference (most Cardano slots are empty, so the reference
   usually has no block of its own). The anchor block hash is carried in `CardanoRef.block_hash`;
   `check_inherent` originally compared `reference.slot` + `entries` only, and §15.3 later promoted
   `block_hash` to the **deterministic anchor** (the `block` row at/before the reference) and made it
   consensus-compared.
8. **Capacity priming.** *Default:* set weight + prime capacity atomically in the one Mandatory
   dispatchable (removes the separate `force_set_capacity` write; preserves the §6.1 invariants).
9. **`MaxStakeWeight` over-bound.** *Default:* **skip the single offending entry** (never reject the
   block) — explicitly *different* from `set_stake`'s reject-the-call behavior (§7 step 3), because a
   Mandatory inherent must not be brickable by one bad value.
10. **Shelley anchor + arithmetic.** *Default:* pin per-network anchors as runtime constants; use the
    **verified preprod values** (`SHELLEY_START_UNIX=1655769600`, `SHELLEY_START_SLOT=86400`) — **not**
    `systemStart` (the Byron start) — and verify mainnet against its genesis before cutover. Use a guard
    + `checked_sub` (not overflow panics, off in release WASM) so a pre-Shelley/wrong-net input → empty
    observation; add a startup round-trip self-check and an `overflow-checks=false` unit test (§5.2).

---

## 13. References
**Repo:** `docs/L2-follower.md` (§4/§5/§6/§9/§10 — the canon), `docs/DECISION-REGISTER.md`
(DR-06/07/09b/13/25/26), `docs/ECONOMICS.md` §4.1+§6.2 (cap/rate curve) + §6.1 (set_stake invariants),
`docs/L3-SPO-graduation.md`, `docs/D2-custody-runbook.md`,
`docs/M6-build.md`; `runtime/src/lib.rs` (spec 107, indices — 16 free), `runtime/src/configs/mod.rs`
(`AuthorityOrigin`, talk-stake/microblog/cogno-gate config), `pallets/talk-stake/src/lib.rs`
(`set_stake`, `MaxStakeWeight`), `pallets/cogno-gate/src/lib.rs` (`AccountOf`),
`node/src/service.rs:94-110/261-270` (the two CIDP closures), `runtime/src/apis.rs:94-104`
(`inherent_extrinsics` / `check_inherents`); the path to replace —
`services/committee/sync-weight.mjs` + `services/cogno-follower/vault.py`;
`services/cogno-follower/beacon.py` (the bind-time beacon derivation — stays off-chain).

**Substrate:** `_sdk/substrate/frame/support/src/inherent.rs:76-79` (`ProvideInherent`; check_inherent "not
guaranteed to be run by all full nodes"), `_sdk/substrate/primitives/{inherents,block-builder}/src/client_side.rs`
(`InherentDataProvider::try_handle_error` — the per-variant accept/reject decision), `_sdk/.../primitives/inherents/src/lib.rs`
(`IsFatalError`), `_sdk/substrate/frame/timestamp/src/lib.rs` (precedent for the *exact/mandatory* half —
both its errors are fatal, on_finalize assert; **not** a defer precedent),
`_sdk/substrate/client/consensus/aura/src/import_queue.rs` (inherent check skipped on warp/state sync;
`aura_replace_inherent_data` injects the block slot), `_sdk/substrate/client/consensus/slots/src/lib.rs`
(slow-IDP → skipped slot), `_sdk/cumulus/pallets/parachain-system/src/lib.rs` (the
panic-in-Mandatory-dispatchable pattern + async relay reads in the inherent provider). Docs:
<https://paritytech.github.io/polkadot-sdk/master/frame_support/inherent/trait.ProvideInherent.html>.

**Cardano partner chains / Midnight:** the `mcsh` / `McHashInherentDataProvider` main-chain-reference
pattern; `CARDANO_SECURITY_PARAMETER` (k=2160) + `BLOCK_STABILITY_MARGIN`; Ariadne committee selection
(`pallet-session-validator-management`) as *just another observation* — the boundary we defer. NB: the
IOG partner-chains repo was **archived ~2026-04 and folded into Midnight** — study as a template, do not
depend on it (DR-26). Cardano db-sync schema (`block` / `tx_out` / `tx_in` — the deterministic
block-at/before-slot anchor + point-in-time `created_at`/`spent_at` semantics):
<https://github.com/IntersectMBO/cardano-db-sync>.

---

## 14. Implementation status (what actually landed)

The initiative is **built through step 4 and proven live against preprod**, running in **shadow** behind a
default-off enforcement flag. spec_version **109** (developed at 108; folded to 109 on merge to `main`
alongside the trustless-identity branch — see §14.3); `transaction_version` stays 2.

### 14.1 The pieces (commits on `in-protocol-observation`)
- **Step 2 — deterministic library:** `services/_shared/observation.mjs` + the Python mirror
  `services/cogno-follower/vault.py` (`observeAsOf` / `cardanoReferenceSlot`), byte-identical across JS≡Python.
- **Step 3 — the inherent path:** `pallets/cardano-observer` @16 (`ProvideInherent`: `create_inherent` /
  `check_inherent` / the Mandatory `observe` dispatchable) + `node/src/cardano_observer.rs` (the Rust port +
  async db-sync IO, `node/src/dbsync.rs`) wired into both `service.rs` CIDP closures, reference = f(parent Aura slot); the
  `CardanoObserverApi` runtime API is the no-drift config source (anchors, stability window, vault policy id).
- **Step 4a — enforce/shadow flag:** `EnforceWeight: bool` (default `false` = shadow). `observe` reads the
  mode once and gates **both** `WeightSink::set_weight` sites (credit + unlock clamp) under it; the
  projection, `LastObserved`/`LastReference`, the monotonicity + stability `ensure!`s, and the event are
  **unconditional**. A new account-keyed `ShadowStake: StorageMap<AccountId, u128>` records the inherent's
  per-account projection EVERY block (mirrors `AllowedStake`'s insert-0-on-unlock-never-delete shape) so it
  is diffable even in shadow and clamped accounts stay visible as 0. `set_enforcement(enabled)` @
  `call_index(1)` (NOT an inherent) is gated by `EnforceOrigin = AuthorityOrigin` (root OR 3-of-5 committee).
  `ObservationApplied` gained `skipped` (over-cap entries) + `enforced`.
- **Step 4b — shadow-diff:** `services/committee/shadow-diff.mjs` — a **convergence** monitor (on-chain
  `ShadowStake` vs `AllowedStake`) PLUS an independent **correctness** oracle (re-derive off-chain via
  `observeAsOf` over the operator's own db-sync at the inherent's own reference slot, vs the on-chain
  projection). Prometheus `:9102` + `deploy/monitoring` alerts: persistent committee-divergence (a streak,
  not a transient) is a warning; **any** recompute disagreement is critical.
- **Step 4c — point-existence guard:** the db-sync freshness read (`max(block.slot_no)`, defensive parse);
  the IDP abstains when its db-sync tip is behind the reference; `check_inherent` compares slot + entries
  (and, post-§15.3, the deterministic anchor `block_hash`) (§5.4 / OQ7).
- **Step 4e — frontend:** PAPI descriptors regenerated for the observer pallet (at spec 108 on this
  branch; re-regenerated at spec 109 on merge to `main`, where the observer shares the runtime with D1).

### 14.2 Honest framing (corrects two over-statements)
- **Shadow ≠ zero consensus risk.** Shadow removes the **weight-application** risk only. `observe` is
  `Mandatory`, so a divergent author read (`check_inherent` → fatal `Mismatch`) or a non-monotone / too-fresh
  reference still **invalidates the block in shadow exactly as in enforce** — the `ensure!`s and
  `check_inherent` run flag-independently. What shadow buys is that the committee, not the inherent, owns
  `AllowedStake` until cutover.
- **Convergence ≠ correctness.** The committee leg of the shadow-diff is **eventual-consistency**: the two
  writers are asynchronous (committee sync lags the every-block inherent; the clamp lags the full stability
  window), so a momentary disagreement is EXPECTED at every lock/unlock. Only a **persistent** streak, or
  **any** independent-recompute disagreement, is a real signal. Committee-vs-inherent agreement is **not**
  proof of trustlessness — on a single producer there is no independent verifier (§2/§6).

### 14.3 spec 108 folded on this branch; bumped to 109 at merge-to-main
While on this branch, 108 was **unreleased** (not on `main`, no persistent shared network), so step-4's
additive storage/call/event changes **folded into 108** rather than forcing a 109 — the line past which a
NEW spec becomes mandatory is the **first merge-to-main OR the first persistent/shared chain at 108**.
That line has now been crossed: the trustless-identity (D1) branch **also** claimed 108 and merged to
`main` first, so when this work merged second the combined runtime (observer pallet @16 **and** the D1
gate) bumped to **spec 109** and the PAPI descriptors were regenerated against it. The `CardanoObserverApi`
runtime API is **unchanged** (no `#[api_version]` bump); the live preprod `talk_vault` Aiken contract is
untouched (no hash move).

### 14.4 Live evidence (preprod, this branch — pre-merge at spec 108)
A persistent `--dev` node (spec 108, genesis `0x995be6cc…`) against live db-sync, via
`services/committee/obs-shadow-demo.mjs` (beacon `287a99d2…` / 100 ADA, bound `//Bob` via the then-extant
trusted bind — post-merge that demo requires the beacon to be pre-bound via `link_identity_signed`):

```
[SHADOW]  ShadowStake[//Bob] = 100000000   ;  AllowedStake[//Bob] = 0   (inherent projects, does not apply)
[ENFORCE] set_enforcement(true) → AllowedStake[//Bob] = 100000000        (the SAME inherent applies; credited=1)
```
and `shadow-diff.mjs` one-shot cross-confirmed all three legs agree at the live reference slot:
**inherent projection == committee `AllowedStake` == independent db-sync recompute = 100000000.**

### 14.5 What remains (the cutover — GATED, do not flip on a single operator)
The default-off flag + the `set_enforcement` control + the reconciliation requirement are documented in §9
step 3. Cutover is co-sequenced with ≥3 independent producers (the SPO/Ariadne graduation, §11) and is the
ONLY remaining step. Until then: default shadow, committee still drives weight, **D4-SHAPED, not D4-TRUST.**

---

## 15. Mechanism-hardening toward Midnight parity (2026-06-19)

A pass to close the *achievable* mechanism-hardening deltas against Midnight's `cnight-observation` /
the partner-chains Ariadne inherent (the full mapping + the overclaim guardrails are in
`_reference/MIDNIGHT-MAPPING.md`). This does **not** touch the one delta that matters most — validator
decentralization (`check_inherent` is load-bearing only with ≥3 independent producers; §2). Two items
landed; the flagship third is designed below for a sign-off.

### 15.1 LANDED — determinism equivalence regression (mapping delta B.8) — no spec change
A committed-golden **cross-language** (Rust↔JS) equivalence regression, mirroring Midnight's
`primitives/mainchain-follower/tests/cnight_equivalence.rs` (which asserts two observation implementations
return byte-identical output for the same input). Here the two implementations are in *different*
languages, so instead of comparing in one process we pin a golden computed by the canonical JS spec and
re-derive it from both sides:
- `services/_shared/fixtures/observation-equivalence.json` — 17 cases (largest-wins, spent-after-ref,
  too-fresh, multi-beacon-reject, realistic-mixed, the candidate-sort `None < Some` / coins tiebreak, the
  three parser-strictness edges below, and a **64-beacon SCALE 2-byte compact-length** boundary), generated
  by `gen-equivalence-fixtures.mjs` from `observation.mjs`.
- `services/_shared/observation-equivalence.test.mjs` (JS leg) and
  `node/src/cardano_observer.rs::rust_matches_js_observation_equivalence_fixture` (Rust leg) each re-derive
  every case and assert the **canonical SCALE bytes** *and* the **input-commitment pre-image** equal the
  golden. A Rust↔JS divergence fails one suite (proven: corrupting one golden byte fails *both*).
- Always-on in CI (`ci.yml` `services` job), vs Midnight's db-gated skip-by-default; the live-db-sync
  recompute leg Midnight also gets from db-sync, cogno already has in `shadow-diff.mjs`'s correctness oracle.
- **Parser-strictness alignment (closed by the build's adversarial review).** An equivalence pass is only
  as good as the parse it pins. `observation.mjs`'s coercions were looser than the Rust node's
  `serde_json` parse — JS `Number("1.0")===1` / `BigInt(" 1")` accepted asset-qty / coins / slot values the
  Rust `as_u64`/`as_u128` reject, and JS credited a non-32-byte beacon (then `canonicalBytes` threw) where
  Rust's `hex32` silently drops it. These never occur with honest db-sync data (the on-chain beacon is always
  32 bytes; db-sync emits integer qty/coins as `::text`), but they were latent Rust↔JS divergences. `observeAsOf` +
  `candidates` now parse through strict `asU64`/`asU128`/`isBeacon32` helpers that **exactly mirror** the
  Rust `as_u64`/`as_u128`/`hex32`, and three fixture cases (`short-beacon-name-dropped`,
  `non-integer-qty-dropped`, `non-integer-coins-dropped`) pin the now-identical "both drop" behavior. The
  one residual JS cannot mirror — a JSON **number** written `1.0` (which `JSON.parse` collapses to `1`
  before any guard can see the decimal) — is a documented precondition: db-sync never emits fractional
  integers (coins/quantities are `::text`), and the consensus read is Rust-only regardless.

### 15.2 LANDED — input-commitment hash + the `ComputeDiverged` taxonomy (mapping delta A.2) — spec 109 → 110
The partner-chains `selection_inputs_hash` analog. The `observe` inherent now carries an
`inputs_commitment: [u8;32]` — a `blake2_256` of the canonical SCALE encoding of the **pre-reduction
structural candidate set** (every vault UTxO the as-of reduction consumes, before the time-filter /
largest-wins fold; `candidate_tuples` in the node, `candidates`/`candidateBytes` in `observation.mjs`,
byte-identical and pinned by the §15.1 fixture). When the reduced reads disagree, `check_inherent` splits
the (fatal) failure with the commitment: differing commitments ⇒ `Mismatch` ("saw different Cardano
data"); identical commitments ⇒ `ComputeDiverged` ("same data, different reduction" — a determinism bug /
binary version skew). Both are fatal; the split is **diagnostic**. The commitment is consulted **only**
when the reduced outputs already disagree, so it never rejects on its own (agreeing `entries` ⇒ accept
regardless of the commitment — two honest nodes whose raw candidate sets differ only in UTxOs the reduction
drops still agree on the output). The Mandatory dispatchable carries-but-ignores it (no db-sync in-runtime;
it is auditable from the extrinsic, recomputable against an archived db-sync at `reference.slot`).
- **Not** "compare the full UTxO list like Midnight" (a stated non-goal): cogno observes ONE pinned vault,
  so the reduced largest-wins set IS the complete canonical observation; this is a finer *failure
  taxonomy*, not a wider comparison.
- Encoding-affecting (`observe` Call + `CardanoObservation` gained the field; `InherentError` gained the
  variant) ⇒ **spec_version 109 → 110**, PAPI + indexer + frontend regenerated; `transaction_version`
  stays 2 (`observe` is an inherent, not a signed tx). The live `talk_vault` contract is **untouched**.

### 15.3 LANDED — header-sealed, importer-re-validated stable Cardano block on **db-sync** (mapping delta A.1, "the biggest gap") — spec 110 → 111
> ✅ **LANDED (2026-06-19).** The header-seal **infrastructure** (the custom proposer + `cobs` digest, the
> `check_inherent` full-`CardanoRef` re-validation) seals a *specific, stable Cardano block* into the
> anchor, grounded on the deterministic Cardano db-sync read. **db-sync's `block` table holds every block,
> so "latest block at/before slot S" is EXACT** (≤1 block/slot on settled history ⇒ a single, unique row
> identical across every fully-synced db-sync) — what makes `block_hash` genuinely safe to compare
> cross-node. The node (`node/src/dbsync.rs`), the committee tooling (`services/committee/dbsync.mjs`),
> and the follower (`vault.py`) all read the vault from db-sync; **Ogmios stays for L1 tx submission**
> (db-sync is read-only and cannot submit). The ceiling is unchanged — **D4-SHAPED, not D4-TRUST** until
> ≥3 independent producers each run their own db-sync; this did **not** flip `set_enforcement` or tighten
> the window.

**Status: LANDED on branch `cardano-observer-mchash`.** The McHash-faithful **Architecture B** (the header
digest itself consensus-binding on import) is deliberately deferred — see "What was deferred".

**The db-sync read (the consensus-critical part).** One read-only snapshot per block
(`read_observation`, mirrored in Rust / committee-JS / follower-Python) returns, from a single Postgres MVCC
snapshot: (1) freshness `max(block.slot_no)` — the point-existence guard (a behind db-sync abstains →
`CannotVerify`); (2) the deterministic anchor — the `block` row at `max(slot_no) <= reference`; (3) the
vault UTxOs shaped **in SQL** into the exact JSON the pure reduction consumes, so
`observe_as_of` / `observeAsOf` / `observe_as_of` (Rust/JS/Python) run **byte-identically**. A single
snapshot also gives the freshness, anchor, and matches from one consistent point (no tip→matches TOCTOU).
Three byte-identity choices (a divergence is a chain FORK), each grounded in a live-data finding:
- **Spentness from `tx_in`, NOT `consumed_by_tx_id`.** The denormalized `consumed_by_tx_id` column was
  observed NULL for a known-spent vault UTxO on the live instance (it is config-dependent); `tx_in` is
  canonical ledger data, identical on every correctly-synced db-sync.
- **Coins/quantities as `::text` strings.** `MaxStakeWeight` = 4.5e16 lovelace > 2^53, so a JS `Number` (or
  any float) would lose precision; the strict integer parsers consume the strings.
- **Driven from `tx_out.payment_cred = <vault script hash>`** (the vault script address equals the beacon
  policy id) — an indexed (`idx_tx_out_payment_cred`) lookup of every UTxO at the vault script address. The
  asset-driven query would seq-scan 7.4M `ma_tx_out` rows (no index on `ident`, which the read-only
  `cogno_reader` cannot add); the address path runs the full read in ~15 ms. Verified equivalent: 0
  escaped beacons in all preprod history, and ADA-only-at-address UTxOs are excluded by the asset `EXISTS`.

**Live byte-identity evidence.** The db-sync read was run through
the canonical `observeAsOf`/`canonicalHex`/`candidateHex` at two preprod references straddling the
spent-before/after-ref split: the reduced observation **and** the input-commitment pre-image were byte-identical
across the Rust/JS/Python implementations. The Rust↔JS golden fixture (`observation-equivalence.json`) carries
two `dbsync-live-preprod-*` cases sourced from that real db-sync output; the Rust and JS equivalence suites
both re-derive them and agree byte-for-byte. **MAINNET PREREQUISITE:** run db-sync **full / non-pruned** (retaining history back to the
reference), **tx_in-enabled** (NOT `--consumed-tx-out` — spentness is read from `tx_in`; the read probes
`EXISTS (SELECT 1 FROM tx_in)` and abstains fail-closed otherwise, so a `--consumed-tx-out` instance can never
silently emit a spent vault as locked), and over **TLS** (the node uses `NoTls` against the read-only
`cogno_reader` on a private LAN here).

**The gap.** Before this, the reference was `f(parent Aura slot) − stability_window` (§5.1) and the anchor
**trusted the slot arithmetic**: `CardanoRef.block_hash` carried only a node-local diagnostic and
`check_inherent` deliberately **never compared** it, so the inherent never proved a *specific, stable
Cardano block* underlay the read. Midnight/partner-chains instead seal the chosen **stable Cardano block
hash** into the PC header (the `mcsh` `PreRuntime` digest) and every importer **re-validates** it.

**What landed (Architecture A):**
1. **`block_hash` promoted from diagnostic → sealed stable-block anchor.** The db-sync read (the McHash
   `get_latest_stable_block_for` analog) selects the latest stable Cardano block **at/under** the reference
   — the `block` row at `max(slot_no) <= reference`; `service.rs::build_cardano_idp` now
   sets `CardanoRef.block_hash` to that block's header hash. `reference.slot` is **unchanged**
   (still the deterministic parent-slot arithmetic — the consensus bedrock that always agrees), and the read
   is still as-of `reference.slot`.
2. **Custom proposer seals it into the HEADER.** A reimplemented (Apache-2.0 partner-chains
   `sp-partner-chains-consensus-aura`, DR-26) `PartnerChainsProposerFactory` + `InherentDigest` in
   `node/src/consensus/` writes the anchor (`CardanoRef`) into each authored block as a `cobs` `PreRuntime`
   digest. It wraps the stock `sc_basic_authorship::ProposerFactory` and is passed to the **stock**
   `start_aura` — **no `start_aura`/`import_queue`/verifier fork, no GPL crate.** The appended `PreRuntime`
   item survives `Executive::final_checks` because `frame_system::initialize` stores the full incoming
   header digest (exactly like the Aura slot pre-digest, §4.4) — no runtime change for the digest itself.
3. **`check_inherent` re-validates the anchor.** It now compares the **full** `CardanoRef` (slot **+
   block_hash**) + entries (`pallets/cardano-observer/src/lib.rs`). A forged/regressing/wrong anchor that a
   caught-up importer can see is wrong ⇒ **`Mismatch` (fatal)**; an importer whose own db-sync is behind the
   reference abstains via the point-existence guard (`tip < reference`) ⇒ **`CannotVerify` (non-fatal,
   accept)** — preserving the "forged → reject, can't-check → accept" asymmetry. The existing `LastReference`
   slot-monotonicity remains the on-chain non-regression mirror.

**Why this is safe to compare `block_hash` now (it was excluded before for fork-safety):** the anchor is the
latest stable block **≤ the reference**, a single unique `block` row identical across every fully-synced
db-sync (the reference is ≥ the stability window old = immutable Cardano history), and a behind importer
abstains before it can reach a false mismatch. (MAINNET PREREQUISITE: at the prod ~36 h window db-sync must
run full / non-pruned so it retains the `block` row back to the reference.)

**Spec bump is consensus-VALIDITY, not encoding.** `CardanoRef` already encoded `block_hash`, so the
`observe` Call / storage / event encoding is **unchanged** and the PAPI/indexer/frontend metadata is
byte-identical. The 110 → 111 bump exists to signal the **required lockstep node upgrade** (an old author's
tip-hash anchor would be fatally rejected by a new importer). `transaction_version` is unchanged (`observe`
is still an inherent). The Rust↔JS equivalence golden fixture is unaffected (the anchor `block_hash` is not
part of the SCALE canonical `(reference_slot, entries)` bytes); the anchor selection is mirrored by
`latestStableBlock` in `services/_shared/observation.mjs` and unit-tested both sides.

**What was deferred (Architecture B, co-sequence with the ≥3-producer cutover).** In Architecture A the
header `cobs` digest is an **external-auditability** artifact (a third party reading only PC headers sees the
sealed Cardano block); the **load-bearing** importer re-validation rides `check_inherent` on the inherent's
`block_hash`. Making the header digest **itself** consensus-binding (extracting it in a forked verifier and
re-validating it on import) is Architecture B — it needs import-path surgery (and is the only part that
would want the GPL consensus fork), and is trust-bearing only with ≥3 independent producers. The
`value_from_digest` decoder (missing→`NoSeal`, duplicate→`Err`, malformed→`Err`) is implemented + tested in
`node/src/consensus/cardano_digest.rs` so B is ready to wire.

**The ceiling is unchanged (D4-SHAPED, not D4-TRUST).** Like the inherent itself, header-sealing is
auditability, not trust, until ≥3 independent producers exist to out-vote a bad author. This shipped
labeled honestly and is co-sequenced with the validator-decentralization / `set_enforcement(true)` cutover
(§9 step 3); it does **not** flip enforcement and does **not** tighten the testnet stability window.

**Acceptance.** Unit/pallet/node tests cover the rejection logic: `check_inherent` accepts a matching anchor
and fatally rejects a forged one (`check_inherent_rejects_a_forged_sealed_block_hash_anchor`); a behind
importer → `CannotVerify` (`check_inherent_cannot_verify_when_local_source_behind_is_non_fatal`); the `cobs`
codec round-trips and rejects duplicate/malformed seals; `parse_checkpoint_anchor` / `latestStableBlock`
agree cross-language. The full multi-node live import test (two `--chain local` nodes against preprod db-sync:
healthy seal imports / forged seal rejected / lagging importer defers / db-sync-down author abstains, chain
stays live) is the operational acceptance step — staged as **two keyrings under one operator** (NOT the ≥3
independent producers the trust payoff needs), consistent with the honest posture above.

**Live multi-node runbook (`--chain local`, Alice + Bob = two keyrings on one operator).** The runtime
tests above prove the rejection *logic*; this proves the live import flow. Spin two nodes with the
spec-111 binary, each pointed at a synced preprod db-sync via `DBSYNC_URL`:
```
# node A (authority Alice)  — DBSYNC_URL=<synced db-sync>  --chain local --alice  --rpc-port 9944 ...
# node B (authority Bob)    — DBSYNC_URL=<synced db-sync>  --chain local --bob --port 30334 --rpc-port 9945 ...
```
- **(a) Healthy:** with both db-syncs caught up past the reference, Alice authors blocks carrying a `cobs`
  header digest whose anchor matches Bob's own anchor read ⇒ Bob imports + GRANDPA
  finalizes. (The author-abstain smoke test — no db-sync ⇒ clean authoring + finality — already passed live on
  spec 111: blocks #1–5 authored and finalized through #2 with no panic, proving the `cobs` proposer is
  GRANDPA-neutral and the digest survives `Executive::final_checks`.)
- **(b) Forged/regressing anchor → fatal:** no honest node authors a forged anchor, so the live form needs
  a deliberate adversarial-author build (or a hand-crafted block injected at the import queue) that seals a
  `block_hash` ≠ the stable block. A caught-up Bob then re-derives the real anchor, mismatches, and FATALLY
  rejects (`Mismatch`). The logic is unit-proven by `check_inherent_rejects_a_forged_sealed_block_hash_anchor`.
- **(c) Lagging importer defers:** stop Bob's db-sync (or point it at an index behind the reference). Bob's
  point-existence guard (`tip < reference`) makes its IDP abstain ⇒ `check_inherent` returns `CannotVerify`
  (non-fatal) ⇒ Bob ACCEPTS Alice's blocks and the chain keeps finalizing. Unit-proven by
  `check_inherent_cannot_verify_when_local_source_behind_is_non_fatal`.
- **(d) Author abstains, chain stays live:** stop Alice's db-sync. Alice emits no `observe` inherent and no
  `cobs` digest (the `from_inherent_data` total-over-missing path) and keeps authoring; the chain stays
  live. Unit-proven by `from_inherent_data_is_total_over_missing_data` + the live no-db-sync smoke test above.

**Live evidence — two-node import run (2026-06-19, spec-111 binary `fa445b5`, two keyrings on one
operator).** Ran Alice+Bob as `--chain local` authorities against the real preprod **db-sync** (`DBSYNC_URL`).
**(a) Healthy:** both nodes logged `observed 1 vault
entrie(s) as-of slot R … anchor block H`, and for every shared reference slot the sealed anchor agreed
cross-node byte-for-byte (`8c789818…96fbc`); both authored, imported, and GRANDPA-**finalized** in lockstep
(to #20) with **no** `Mismatch`/`ComputeDiverged`/panic; block #2+ headers carried the `cobs` `PreRuntime`
digest (block #1 abstained on its genesis parent) and `ObservationApplied` fired in shadow mode
(`enforced=false`, `credited=0` — beacon unbound on a fresh chain; the #2 event `reference_slot` equalled the
decoded `cobs` slot). **(c)+(d) Degraded:** Bob started with no `DBSYNC_URL` abstained every block
(`no DBSYNC_URL/DBSYNC set — abstaining`) yet **imported and finalized Alice's `cobs`-sealed observed blocks**
(`check_inherent` → `CannotVerify`, non-fatal accept — the same path a lagging db-sync takes) while Alice
imported Bob's inherent-free blocks; the chain kept finalizing throughout. Case (b) (forged anchor → fatal
`Mismatch`) stays unit-proven only (it needs an adversarial-author build). **Caveat:** one db-sync instance
proves the import/abstain mechanics + same-reference cross-node anchor agreement, **not** cross-*instance*
determinism (that needs ≥2 independent db-syncs = the deferred validator decentralization) — still
**D4-SHAPED, not D4-TRUST**.
