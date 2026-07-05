# cogno-chain — Economic Model: Stake-Weighted Talk Capacity

> **Historical design doc.** This predates the all-Rust restart (`fork/all-rust`) and describes the
> pre-restart design. It references planning artifacts that are **not part of this repo** — the retired
> `L1`–`L5` layered specs, `PLAN.md`, the `M*-build.md` notes, and an internal decision register cited
> inline as `DR-NN` — plus older spec versions and removed components (the off-chain follower, sudo).
> Kept for design rationale; the **current** system overview is [`ARCHITECTURE.md`](ARCHITECTURE.md), and
> the runtime is now `spec_version` 203.

> **Status: IMPLEMENTED (present in the current `spec_version` 203 runtime).** This document is the
> original economic design. It specifies the model that replaces per-post fees. Honest about caveats;
> numbers are illustrative and runtime-tunable, not consensus-critical magic.
> **One-line thesis:** Your stake is your rate limit. Lock ADA on Cardano → it grants a regenerating "talk capacity" on the solochain → posting is feeless and consumes capacity → capacity refills over time. No money is spent per post.

> **RECONCILED design decisions.** The decisions below (tracked during the build-out in a now-retired internal decision register, cited as `DR-NN`) override the older text where they conflict; the inline text has been corrected to match, and they are reflected in the code.
> - **DR-13 — v1 has NO on-chain timelock / NO `lock_until`; commitment is enforced by L3 regen/clamp (clamp-only decay).** The repeated claim that the unstake cooldown **must live on Cardano in `talk-stake.ak`** as a `lock_until` datum field is **SUPERSEDED**. In v1 there is no `lock_until`, no Aiken validity-interval cooldown check, and no runtime timelock. The anti-toggle commitment is structural: talk capacity **starts at zero**, accrues **only while the lock stays parked**, and **clamps to zero on unlock** (clamp-only decay). An opt-in `lock_until` commitment-bonus is **DEFERRED** (if ever added: decay-toward-new-cap + re-tighten to the whole owner Address first). This supersedes **§1 caveat 5**, the **§4.4 "Note one exception" cooldown carve-out**, **§8 "Unstake / power-down handling"**, **§9 §6/§8 plan-deltas referencing the `lock_until` cooldown**, and **§10 Q6**.
> - **DR-29 — reward distribution deferred to M5; v1 weight source = plain Lock read via db-sync (Ogmios submits).** The yield-bearing "lock-that-delegates" hybrid and any reward routing are **not** v1. v1 reads exact locked lovelace from a **plain Lock** via db-sync. This sharpens §5/§8/§9.
> - **DR-01 — identity = the WHOLE owner Address (payment + stake credential), not `owner_pkh`.** The follower aggregates lock UTxOs and keys the 1:1 binding on the owner **Address** (and `blake2b_256(owner Address)` on L3), not a bare 28-byte `owner_pkh`. Read the inline `owner_pkh` references in §1/§2/§6/§8 as the owner **Address** per DR-01.
> - **DR-10 / DR-10b / DR-11 — capacity constants:** regen window **~5h** (worked-example baseline 10 ADA → ~48 posts/day sustained, burst ~10) is the v1 baseline; **linear (capped-linear) + hard ceiling** ships in v1, **sqrt only later behind a proven gate**; `MaxLength = 512`, `MaxPostsPerAuthor = 10_000` (tunable). This decides **§10 Q1** (regen window ~5h) and **§10 Q2** (curve = capped-linear v1).
> - **DR-12 / DR-08 (§10 Q8) — onboarding sweetener = accept a short charge-up** (copy-only; a new identity starts at 0). Decides **§10 Q8**.
> - See **§10** for the per-question dispositions; the "Open questions" items below were **RESOLVED** during the build-out — the resolutions are inlined here and reflected in the code.

---

## 1. Verdict

**Cogno died from fees.** The original Cogno was a Cardano-native forum where every message was an L1 transaction. At volume that model collapsed: per-post tx fees plus min-ADA-per-byte made high-frequency social posting economically unviable. This is not a hypothetical risk to design around — it is the proven failure mode of a real, shipped, Cardano-native dApp. The whole pivot exists to fix exactly this.

**Is it possible? YES.** The "stake-weighted, regenerating talk capacity" model is not novel research — it is a production-proven pattern with two strong precedents:

- **Hive / Steem Resource Credits (RC)** — Since Steem hardfork 20 ("Velocity", Sept 2018), Hive has run **100% feeless** posting gated *entirely* by a regenerating, stake-weighted pool. Every account holds a non-transferable "manabar" whose max size equals its staked weight (Hive Power / VESTS); it is consumed per operation and regenerates linearly to full over exactly 5 days (20%/day). Transactions cost no money — RC is the sole rate-limit. **This is running at social-media scale today.** It is almost exactly cogno-chain's intended model.
- **Midnight NIGHT → DUST** — The owner's explicit reference. A held/staked token (NIGHT) continuously generates a consumable resource (DUST) up to a cap proportional to the stake, at a fixed linear rate (~1 week to fill). DUST is burned to pay tx fees and regenerates while NIGHT is held; you never spend NIGHT. Canonical params: cap = 5 DUST per NIGHT, slope = 8,267 Specks/Star/sec, time-to-full ≈ 7 days. The held asset is on Cardano-adjacent infra and observed cross-chain — structurally the same shape as "stake ADA on L1, enforce capacity on the solochain."

Both precedents prove the three things cogno-chain needs: (a) feeless posting, (b) gated by a regenerating staked resource, (c) at scale. The implementation primitive (a lazy token bucket) is trivial, O(1) per access, and battle-tested. The FRAME mechanism to enforce it feelessly already exists as a working template (Gallois's `substrate-feeless-solochain-template`, GPL-3.0).

**Is it worth it? YES, with caveats** — and notably *more* worth it than the per-post-deposit anti-spam model in the current PLAN.md, because it directly fixes the thing that killed Cogno:

- It removes the per-post cost that killed the original dApp. "No money spent per post" is the entire point, and it is achievable.
- It is a cleaner, more honest story than the refundable `Hold` deposit: "your stake is your rate limit" vs. "we escrow ADA per post and give it back."
- The lock path can be made **yield-bearing** (the locked ADA still earns Cardano staking rewards), so users pay *neither* a per-post fee *nor* an opportunity cost — only illiquidity. (This yield-bearing hybrid and reward distribution are the M5 target, **not v1** — DR-29; v1 ships a **plain Lock** on the light path.)

**The honest caveats** (detailed in §8):

1. **It does not add chain security, and it constrains users, not the operator.** Capacity is an *anti-spam / rate-limit* mechanism, not consensus. The solochain's safety is still its own operator-run Aura/GRANDPA (PLAN.md §9). Capacity gates *who can fill the mempool*, not *who produces blocks* — and on a 1–3-validator PoA chain the operator builds the blocks and is free to include their own over-budget posts by not applying the gate at build time. Capacity disciplines non-operator users (exactly as fees and the old deposit did); the operator is unconstrained by it, which is why consensus trust stays the real security boundary.
2. **Anti-Sybil lives in the identity gate, not the curve — and the gate must enforce one bucket per Cardano identity.** Every stake-weighted scheme is farmable by splitting stake across identities unless one bucket = one scarce verified identity. The CIP-8 gate from PLAN.md M2 is load-bearing here, not optional flavor, and it must enforce a hard **1:1 binding** between a Cardano **owner Address** (the whole CIP-19 Address = payment + stake credential — DR-01, not a bare `owner_pkh`; CIP-8 is an exact whole-address match, and L3 keys on `blake2b_256(owner Address)`) and a single Substrate account (§8). Binding a second account to a bound owner Address must be rejected, or capacity multiplies for free.
3. **The weight oracle is trusted.** The follower reads Cardano and writes weight — the same trust boundary PLAN.md already accepts at `link_identity`. Capacity inherits it.
4. **Sourcing weight from delegation is too slow** (~10-day activation lag). The fast, precise path is a **lock**, which costs a new Plutus validator. "Yes" on the *model*; "yes with real work" on the *best* weight source.
5. **The anti-toggle commitment is enforced by L3 regen/clamp — v1 has NO on-chain timelock.** ⛔ SUPERSEDED by DR-13: the earlier framing here ("the unstake cooldown *must live on Cardano* in `talk-stake.ak` as a `lock_until` datum field checked against the tx validity range") is **not** v1. v1 has **no `lock_until`**, no Aiken validity-interval cooldown, and no runtime timelock. Toggle-farming is instead defeated structurally: talk capacity **starts at zero**, accrues **only while the lock stays parked**, and **clamps to zero on unlock** (clamp-only decay — see §8). A user *can* freely spend their lock UTxO on L1 at any time; doing so simply forfeits their accrued capacity. An opt-in `lock_until` commitment-bonus is deferred.

**Bottom line:** This is the correct economic model for the pivot, and the two precedents prove the *shape* (feeless, stake-gated, regenerating, at scale) is real. It is *not* a turnkey port: each of the five caveats above is real work the showcase must do — a lock validator (v1: **no** on-chain cooldown; the commitment is enforced by L3 clamp-only decay per DR-13), a strict 1:1 identity gate keyed on the whole owner **Address** (DR-01), a correctly-placed `validate()`/`post_dispatch` split, and an honest acknowledgement that consensus trust, not capacity, is the security boundary. It fixes the exact fee problem that killed Cogno, with a cleaner story than the deposit model it replaces, and the work is bounded — but the holes below must be closed deliberately, not assumed shut.

---

## 2. The model in one picture

```
   CARDANO L1                    COGNO-FOLLOWER                 SOLOCHAIN (cogno-chain)
  ┌──────────────┐              ┌────────────────┐             ┌──────────────────────────────┐
  │ user LOCKS   │   db-sync    │ sum unspent    │  set_stake  │ pallet-talk-stake            │
  │ N ADA at     │──reads─────▶ │ coins per      │──(operator──▶│ AllowedStake: addr -> weight │
  │ talk-vault   │  (unspent,   │ ALL coins for  │   signed,   │                              │
  │ (datum binds │   past reorg │ owner Address  │ EnsureOrigin)│        │ weight sizes...      │
  │  owner       │   depth)     │ -> ONE weight, │             │        ▼                      │
  │  Address;    │              │ past reorg     │             │ pallet-talk-capacity         │
  │  NO          │              │ depth          │             │ {weight, cap_last, last_blk} │
  │  lock_until  │              │ (also: CIP-8   │             │  (new id: starts EMPTY;      │
  │  in v1)      │              │  identity bind │             │   row never deleted)         │
  │ (v1: plain   │              │  from M2, 1:1) │             │ current = min(               │
  │  Lock, light │              └────────────────┘             │   weight*CAP_RATIO,          │
  │  path)       │                                             │   cap_last +                 │
  └──────────────┘                                             │   weight*REGEN*Δblocks )     │
         ▲                                                     └───────────────┬──────────────┘
         │ unlock anytime (NO on-chain timelock in v1; spending the lock       │
         │  simply forfeits accrued capacity) ──▶ follower lowers weight       │
         │  ──▶ L3 clamps capacity to zero (clamp-only decay, DR-13)           │
         │                                                                     │
         │                                              FEELESS post (sr25519) │
         │                                              ┌──────────────────────▼─────────────┐
         │                                              │ CheckCapacity TransactionExtension  │
         │                                              │  validate(): current >= POST_COST?  │
         │                                              │   no  -> InvalidTransaction::        │
         │                                              │          ExhaustsResources (pool    │
         │                                              │          reject this tx)            │
         │                                              │   yes -> admit; weight() = zero     │
         │                                              │ post_dispatch(): cap_last -= cost   │
         │                                              │  (consume only here = the real      │
         │                                              │   bound on what gets INCLUDED)      │
         │                                              └─────────────────────────────────────┘
         │                                                                     │
         └─────────────────── capacity refills over time while ADA stays locked
```

**The whole loop in one sentence:** Lock ADA → follower reads the exact locked amount and writes it as a per-identity weight → weight sizes a regenerating capacity bucket → a feeless post is admitted only if the bucket has room, and consumes from it → the bucket refills over a fixed window while the ADA stays locked. (v1 uses a **plain Lock** on the light path; the yield-bearing "still earns staking rewards" hybrid and reward distribution are deferred to M5 — DR-29.)

---

## 3. Precedent table

| | **Hive RC** | **Midnight DUST** | **EOS staking** | **cogno-chain (what we copy)** |
|---|---|---|---|---|
| **Staked asset** | Hive Power (VESTS) | NIGHT (held UTxO) | EOS | **Locked ADA** (the merged `talk_vault` validator, DR-18) |
| **Consumable** | Resource Credits (manabar) | DUST (battery) | CPU μs / NET bytes | **Talk capacity** (token bucket) |
| **Feeless?** | Yes — RC is sole gate | Yes — DUST is gas, burned | Yes (stake, not fee) | **Yes** — capacity is sole gate |
| **Regen window** | 5 days, linear 20%/day | ~7 days, linear, to a cap | rolling 24h sliding window | **~5h v1 baseline** (DR-10; tunable) |
| **Lazy / on-read?** | Yes (`current_mana`, `last_update`) | Yes (computed from UTxO timestamps) | rolling-window integral | **Yes** (store `cap_last`, `last_block`) |
| **Cap = f(stake)** | max RC ∝ VESTS | cap = NIGHT × 5 | pro-rata of shared pool | cap = weight × `CAP_RATIO` |
| **Non-transferable?** | Yes | Yes | n/a | **Yes** — bound to Cardano identity |
| **WHAT WE COPY** | Lazy manabar formula; max=f(stake); feeless+sole-gate; deny-and-explain UX | Two-token split (stake≠spend); piecewise-linear regen; proportional cap; **decay-on-unlock**; conservation/anti-re-point rule | The *cautionary tale* (see below) | All of the above, on a FRAME `TransactionExtension` |
| **WHAT WE AVOID** | Volatile `p(x)=A/(B+x)` dynamic pricing; punishing account-creation RC cliff; full 5-resource metering | zk/shielding machinery (irrelevant for a public forum) | **1000× elastic borrowed burst** (users built habits on capacity they didn't own, then got locked out under congestion); **pro-rata-of-shared-pool** dilution | Fixed predictable per-post cost; absolute per-identity bucket; cheap first post |

**The EOS lesson, stated plainly:** EOS let users consume up to ~1000× their pro-rata share when the network was idle, then collapsed them to their real share under congestion — so people built posting habits on capacity they never actually owned and got locked out exactly when it mattered. cogno-chain must give each identity an **absolute** bucket sized only by its own stake, advertise the **sustained** rate (not a borrowed burst), and keep any surge headroom small (2–3×) and explicit.

---

## 4. The capacity mechanic

### 4.1 The lazy leaky-/token-bucket formula

The model is a **token bucket**: it accumulates allowance up to a cap while idle (permitting a burst), then throttles to a sustained refill rate. It is computed **lazily on access** — no per-block sweep over accounts. Per identity, store only three values:

```
{ stake_weight, capacity_last, last_block }
```

On every validate/dispatch, regenerate-on-read, then check:

```
cap     = stake_weight * CAP_RATIO
rate    = stake_weight * REGEN_PER_BLOCK
current = min( cap, capacity_last + rate * (now_block - last_block) )

allow post  iff  current >= POST_COST
on success:  capacity_last := current - POST_COST ;  last_block := now_block
```

This is identical to Hive's manabar, Midnight's DUST `value(t)`, and the classic token-bucket conformance test. It is O(1) per post, needs no cron, and maps onto a FRAME `StorageMap<Identity, (StakeWeight, Capacity, BlockNumber)>`.

**Clock source:** use **block number**, not wall-clock, inside the runtime — it is deterministic and consensus-safe. Compute `REGEN_PER_BLOCK` from a chosen time-to-full and the chain's block time. (Caveat: if Aura stalls, regen drifts with block production; acceptable for a single-operator chain. `pallet_timestamp::now()` is the alternative if wall-clock accuracy is ever required.)

**Integer safety:** work in fine-grained micro-capacity units (mirror Midnight's 10¹⁵-Speck resolution vs NIGHT's 10⁶) and use `saturating_add`/`saturating_mul`, so an account idle for years overflows gracefully into the `min(cap, …)` clamp instead of wrapping.

### 4.2 Post cost model (per-byte)

Posts vary in size; a 1000-byte essay consumes more PoV/storage than `gm`. Keep the old `ByteDeposit` intuition, expressed in capacity units:

```
POST_COST = BASE_COST + PER_BYTE_COST * text.len()
```

Start simple — a flat or size-only cost is fine for launch. Do **not** copy Hive's volatile dynamic stockpile pricing (`p(x)=A/(B+x)`), which makes the same post cost a different amount day to day and confuses users. Prefer fixed, predictable per-post costs so a given stake always buys a knowable number of posts/day. Add congestion pricing only if spam actually forces it.

### 4.3 The anti-whale curve: **RECOMMEND linear for v1**, sqrt only behind a proven gate

Stake enters *only* through the curve `f(stake)` that sets `cap` and `rate`. The regen math is identical regardless. The curve is a pure whale/Sybil policy choice:

| Curve | Shape | Whale effect | Sybil (split stake across k identities) |
|---|---|---|---|
| **Linear** `w = k·s` | proportional | whale-friendly (100× ADA → 100× weight) | **split-NEUTRAL** (`Σ k·sᵢ = k·Σsᵢ`) |
| **Sqrt** `w = k·√s` | concave | anti-whale (100× ADA → 10× weight) | **split-POSITIVE** (`Σ√sᵢ = √k·√(Σs)` — splitting yields √k× more) |
| **Log** `w = k·log(1+s/s₀)` | strongly concave | strong anti-whale | **most split-positive** (needs the strongest gate) |

**The central tradeoff (Jensen):** for *any* strictly concave `f` with `f(0)=0`, `Σf(sᵢ) > f(Σsᵢ)` whenever stake is split. So **every anti-whale curve is *more* farmable, not less** — concave curves reward splitting in direct proportion to how weak the identity gate is. Linear is the *unique* split-neutral curve.

**Recommendation (DECIDED — DR-11):**

- **Ship v1 with a linear (capped-linear) curve + a hard ceiling** (`weight = lovelace`, possibly scaled by a `CAP_RATIO`, clamped at a ceiling). It is split-neutral, so it does not *amplify* a gate weakness, and it is the honest default until the identity gate is proven. This is the decided v1 curve.
- **Graduate to a mildly concave (sqrt) curve only later, behind a proven gate** — i.e. one bucket per verified CIP-8 identity (keyed on the whole owner Address, DR-01), ideally with M2b thread-ownership strictness (each identity then costs a real, scarce on-chain object). A concave curve is *defensible* exactly to the degree the gate is Sybil-resistant, and no further; DR-11 holds sqrt back until that gate is proven.
- Keep a hard **ceiling** regardless of curve (capped-linear) so a single mega-whale cannot dominate the mempool.

### 4.4 Worked example (illustrative — all params runtime-tunable)

Pick a baseline: **10 ADA → ~48 posts/day sustained, burst of 10.** Working in posts-as-units for readability:

```
Baseline stake      S₀   = 10 ADA  (10_000_000 lovelace)
Sustained target    Y    = 48 posts/day  =>  rate = 1 post / 1800 s (one post per 30 min)
Burst target        Z    = 10 posts      =>  cap  = 10
POST_COST                = 1 unit/post (flat, for this example)

Refill of an empty bucket = cap / rate = 10 posts / (48/day) = 5 hours to full again
Time to afford one post from empty = POST_COST / rate = 30 min
```

Under a **linear** curve, this scales proportionally:

| Stake | Sustained (posts/day) | Burst (cap) | Empty→full |
|---|---|---|---|
| 1 ADA | ~5 | 1 | 5 h |
| 10 ADA | ~48 | 10 | 5 h |
| 100 ADA | ~480 | 100 | 5 h |
| 1000 ADA | ~4800 | 1000 | 5 h |

Note **time-to-full is independent of stake** when both `cap` and `rate` scale linearly with stake (Midnight's design: more ADA → bigger bucket *and* faster refill, same fill window). If you instead choose a **capped-linear or sqrt** curve, the 100-ADA and 1000-ADA rows flatten toward the ceiling — that is the anti-whale lever, applied only when the gate justifies it.

**These numbers are tunable runtime params, not consensus-critical magic.** `CAP_RATIO`, `REGEN_PER_BLOCK` (or `FILL_WINDOW`), `POST_COST` (`BASE_COST`/`PER_BYTE_COST`), the `lovelace → weight` curve, and the *post-unlock capacity-decay schedule* should all be runtime-configurable from day one (Midnight treats its constants as governance-mutable; do the same). ⛔ **The earlier "one exception" carve-out is SUPERSEDED by DR-13:** v1 has **no unstake cooldown / no `lock_until` / no on-chain timelock** at all — neither a runtime param nor an Aiken validity-interval check. The anti-toggle commitment is enforced entirely by L3 regen/clamp: capacity starts at zero, accrues only while parked, and **clamps to zero on unlock** (see §8). The runtime/L3 governs what happens to *capacity* when the follower observes an unlock; nothing prevents the L1 spend itself. The v1 regen window is **~5h** per DR-10 (the worked-example baseline above): faster than Hive's 5 days so casual posters aren't locked out, while still pacing sustained posting.

---

## 5. Sourcing the weight from Cardano

Three ways to turn ADA into a `stake_weight`. They differ enormously in latency and precision.

| | **Delegate** (epoch_stake) | **Lock** (Plutus + db-sync) | **Lock-that-delegates** (hybrid) |
|---|---|---|---|
| **What's read** | Active stake delegated to the Cogno pool, from db-sync `epoch_stake` | Exact locked lovelace at the lock validator (the merged `talk_vault`, DR-18), via db-sync (unspent vault coins) | Same as Lock, but the lock address also delegates |
| **Latency** | **~10 days** (~2-epoch activation lag) + 5-day quantization | **Confirmation-depth choice** (minutes at shallow depth; longer for stronger rollback safety) | **Same** (lock-read; delegation lag decoupled) |
| **Precision** | Whole controlled stake — **splittable** across keys | **Exact** committed lovelace — non-splittable | **Exact** committed lovelace |
| **Capital cost** | **Lowest** — ADA stays liquid, never moved | Locked + cooldown (illiquid) | Locked + cooldown (illiquid) |
| **Keeps staking rewards** | **Yes**, by default (it *is* delegation) | No (plain lock) — unless hybridized | **Yes** — locked ADA delegates and earns |
| **Sybil resistance** | **Weakest** — splittable; rests entirely on CIP-8 gate; concave curves farmable | **Strongest** — capital-bonded + one bucket per identity | **Strong** — capital-bonded + identity gate |
| **Infra** | **db-sync** `epoch_stake` (cardano-node + Postgres) | **db-sync** reads + **Ogmios** submit (already needed for M2b) | **db-sync** reads + **Ogmios** submit |
| **Revocation** | Epoch-laggy (no event; next snapshot only) | **Event-driven** (`spent_at`) | **Event-driven** (`spent_at`) |

### The script-staking question — resolved

**Can script-locked ADA still delegate and earn staking rewards?** **Yes.** A CIP-19 base address independently combines a **script payment credential** (the lock validator enforcing lock/unlock rules) with a **key-hash stake credential** (CIP-19 type 1). The script-locked ADA is registered (`DCertDelegRegKey`) and delegated (`DCertDelegDelegate`) once, so it earns ordinary Cardano staking rewards *while* backing talk capacity — non-custodial **and** yield-bearing. This removes the opportunity cost of locking.

- **Use a type-1 (key-hash) stake credential for v1.** Tooling is mature; reward registration/delegation use standard key-witnessed certs.
- **Defer type-3 (script stake credential, Rewarding/Certifying Plutus validators).** It is real at the ledger level but tooling is "thin," with very limited examples, and a Rewarding withdrawal must drain the *full* reward-account balance (all-or-nothing). Real DEXes (e.g. WingRiders) used DAO-controlled staking agents as an interim. Reserve type-3 only if fully trustless per-user reward routing becomes a hard requirement.
- **Reward distribution is a policy problem, not automatic.** A single shared type-1 stake key pools all rewards into one reward account; fair pro-rata payout/compounding to individual lockers must be designed (or routed through a clearly-disclosed DAO/operator staking agent). Rewards are *preserved* at the protocol level; their *fair distribution* is an operator/governance choice you must specify.

### Recommendation

- **For the showcase / v1:** **Lock** (plain, type-1, or skip delegation initially). It is the right shape for a responsive DUST-like rate limiter: exact precision, a *tunable* recognition latency (a deliberate confirmation-depth choice — minutes at shallow depth for low-value locks, longer for stronger rollback safety; either way far below the Delegate path's ~10 days), event-driven revocation, and the vault UTxOs are read via **db-sync** (Ogmios submits the L1 txs). It directly matches the owner's Midnight analogy.
- **For the end-state / target (M5 — DR-29):** **Lock-that-delegates (hybrid)**. Same exact low-latency weight and light infra, *plus* the locked ADA earns staking rewards — uniquely matching "stake is your rate limit, no money spent, returns over time, and you still earn yield." Per DR-29 the hybrid **and** reward distribution are deferred to M5; graduate to it once the plain Lock is proven.
- **Delegate: do NOT use as the primary meter.** Its ~10-day activation lag and 5-day quantization make it a poor rate-limiter. Use it *at most* as a slow-moving, coarse **loyalty/bonus multiplier** layered on top of the lock weight (it also has the nice property of driving the project's own SPO stake). The `pallet-talk-stake` map and the bucket are identical for both sources, so they compose: `stake_weight = f(lock) + small_delegation_bonus`.

---

## 6. The pallets

Two additions, mirroring the existing `pallet-cogno-gate` trusted-bridge pattern. **The per-post `Hold` deposit from PLAN.md §5 is REMOVED and replaced by the capacity check.**

### 6.1 `pallet-talk-stake` — weight set by the follower

Direct analogue of `pallet-cogno-gate::AllowedKeys`. Written by the same operator-signed, `EnsureOrigin`-gated path (`set_stake` mirrors `link_identity`); **never** an offchain-worker HTTP read into consensus.

```rust
#[pallet::config]
pub trait Config: frame_system::Config {
    type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
    type SetStakeOrigin: EnsureOrigin<Self::RuntimeOrigin>;   // follower authority key / multisig / collective
}

// Exact committed lovelace (or curve output) per bound identity.
#[pallet::storage]
pub type AllowedStake<T: Config> = StorageMap<_, Blake2_128Concat, T::AccountId, StakeWeight, ValueQuery>;

#[pallet::call]
impl<T: Config> Pallet<T> {
    #[pallet::call_index(0)]
    pub fn set_stake(origin: OriginFor<T>, who: T::AccountId, stake_weight: StakeWeight) -> DispatchResult {
        T::SetStakeOrigin::ensure_origin(origin)?;          // operator-signed, deterministic
        AllowedStake::<T>::insert(&who, stake_weight);       // idempotent: keyed by account, overwrite-safe
        Self::deposit_event(Event::StakeSet { who, stake_weight });
        Ok(())
    }
}
```

The follower computes `stake_weight` off-chain from Cardano (sum of unspent lock-validator coins per **owner Address** — DR-01, the whole CIP-19 Address, not a bare `owner_pkh`; past reorg depth) and submits this. On lock/top-up/unlock it re-submits the new sum — idempotent because it is keyed by `substrate_account`, so a rollback re-derivation just overwrites. (The lock validator is the merged single `talk_vault(min_lock)` of DR-18, with datum `VaultDatum { owner: Address }`; v1 carries **no** `lock_until` field — DR-13.)

**Anti-toggle-farm rule (two parts, reconciled):**

1. **Weight changes are going-forward only.** When `set_stake` changes the weight, it changes the *future* `cap` and `rate` only. It must **not** retroactively credit or reset `capacity_last`. Adding stake raises sustained capacity immediately but the larger bucket still fills over `FILL_WINDOW`.
2. **Capacity entries are NEVER deleted.** When stake goes to zero on unlock, the follower writes `weight = 0` — it does **not** remove the `Capacity` map entry. The `CapacityState` row persists (with its `capacity_last`/`last_block`), so a later relock can never read a `None` first-touch and re-mint a fresh bucket. Combined with first-touch-starts-at-zero (§6.2), this closes the lock/unlock/relock farm: the *only* path to a `None` entry is a genuinely new identity, which starts empty.

### 6.2 Capacity check-and-consume in `pallet-microblog`

The lazy bucket lives per identity; the check is a `TransactionExtension` (§7), the consume is in `post_dispatch`.

**Resolves open question 8 (first-touch default): new identities start at ZERO and charge up.** Starting every new identity at full cap, combined with cheap identity creation, is an instant burst farm (the research gotcha; it also reopens the relock farm under §6.1). So the `None` branch returns **0**, not `cap`. A genuinely new identity must wait one `FILL_WINDOW`-fraction before its first post — to avoid Hive's onboarding cliff, keep **registration and the first post cheap separately** (e.g. a one-time small free allowance granted at bind time, or a low `BASE_COST` for an account's first post), never by minting a full bucket. Per §6.1, `Capacity` entries are also **never deleted on unlock**, so the only way to hit the `None` branch is true first-time bind — relock cannot re-mint.

```rust
#[pallet::storage]
pub type Capacity<T: Config> =
    StorageMap<_, Blake2_128Concat, T::AccountId, CapacityState<BlockNumberFor<T>>, OptionQuery>;

#[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
pub struct CapacityState<BN> {
    pub capacity_last: u128,   // micro-capacity units at last touch
    pub last_block:    BN,
}

impl<T: Config> Pallet<T> {
    /// Lazy regenerate-on-read. Pure: no writes. Safe to call in validate().
    pub fn current_capacity(who: &T::AccountId, now: BlockNumberFor<T>) -> u128 {
        let weight = pallet_talk_stake::AllowedStake::<T>::get(who);     // 0 if unbound
        let cap    = (weight as u128).saturating_mul(T::CapRatio::get());
        match Capacity::<T>::get(who) {
            // First touch (genuinely new identity only): start EMPTY, then charge up.
            // Full-on-first-touch + cheap identities = instant burst farm; start-at-zero closes it.
            None => 0,
            Some(s) => {
                let elapsed = now.saturating_sub(s.last_block);
                let regen   = (weight as u128)
                    .saturating_mul(T::RegenPerBlock::get())
                    .saturating_mul(elapsed.saturated_into::<u128>());
                core::cmp::min(cap, s.capacity_last.saturating_add(regen))
            }
        }
    }

    /// Stamp the bucket at bind time so first-touch is empty *and dated*: write
    /// `{ capacity_last: 0, last_block: now }` from set_stake's first bind for an
    /// account. The row is NEVER removed on unlock (weight goes to 0 instead),
    /// so a later relock cannot read None and re-mint a fresh full bucket.
    pub fn on_first_bind(who: &T::AccountId, now: BlockNumberFor<T>) {
        if !Capacity::<T>::contains_key(who) {
            Capacity::<T>::insert(who, CapacityState { capacity_last: 0, last_block: now });
        }
    }

    pub fn post_cost(len: u32) -> u128 {
        T::BaseCost::get().saturating_add(T::PerByteCost::get().saturating_mul(len as u128))
    }

    /// Consume on actual inclusion (called from post_dispatch, NOT validate).
    pub fn consume(who: &T::AccountId, now: BlockNumberFor<T>, cost: u128) {
        let current = Self::current_capacity(who, now);
        Capacity::<T>::insert(who, CapacityState { capacity_last: current.saturating_sub(cost), last_block: now });
    }
}
```

### 6.3 What is REMOVED from the old plan

The refundable `Hold` deposit in PLAN.md §5 (the `BaseDeposit`/`ByteDeposit` model) is deleted and replaced by the capacity gate:

| PLAN.md §5 location | Old (REMOVE) | New (capacity) |
|---|---|---|
| `Config` (lines 173–178) | `RuntimeHoldReason`, `Currency: MutateHold`, `BaseDeposit`, `ByteDeposit` | `TalkStake` weight source; `CapRatio`, `RegenPerBlock`/`FillWindow`, `BaseCost`, `PerByteCost` |
| `HoldReason` enum (line 155) | `PostDeposit` hold reason | *(deleted — no hold)* |
| `post_message` (lines 208–210) | `T::Currency::hold(&HoldReason::PostDeposit.into(), &who, deposit)?` | capacity checked in `validate()`, consumed in `post_dispatch` |
| `delete_post` (lines 226–228) | `T::Currency::release(...)` of the deposit | *(deleted — nothing to refund; deletion is just a state removal)* |
| §5 "Anti-spam summary" (line 264) | "refundable `Hold` prices storage" | "regenerating per-identity capacity; your stake is your rate limit" |

The `ensure!(T::CognoGate::is_allowed(&who), …)` identity gate stays (it is the Sybil anchor). `BoundedVec<u8, MaxLength>` stays (bounds PoV). What goes is the **money-per-post escrow** — exactly the thing that conceptually echoes what killed Cogno.

---

### 6.4 The native governance-fuel token

Everything above is about **talk-capacity** — the *social* rate-limit. There is a second, entirely separate
resource: the **native token**, which exists only to pay the handful of fee-bearing **admin** extrinsics an
operator ever submits — a new validator's self-signed `Session::set_keys`, and committee
`propose`/`vote`/`close`. We call it **fuel**. The two tokens are deliberately symmetric — *both are
non-transferable, non-purchasable, governance-granted regenerating rate-limits; neither is money; neither
can post.*

| | **talk-capacity** (social) | **governance fuel** (admin) |
|---|---|---|
| Meters | posting / voting / engagement | `set_keys`, committee propose/vote/close |
| Granted by | the Cardano observer (locked-ADA weight) | the 3-of-5 committee (`set_allowance`) |
| Regenerates | lazily, per block, scaled by stake weight | by an `on_initialize` hook, toward a standing allowance |
| Transferable? | no (identity-bound virtual meter) | **no** (base call filter blocks the entire `pallet-balances` call surface, not just `transfer*`) |
| Can it post? | it *is* the posting right | **never** — the social layer never reads `Balances` |
| Revoked by | `CognoGate::revoke` (identity ban) | `GovernanceFuel::revoke` (drop allowance + claw back) |

**The invariant that keeps them separate.** Posting/voting eligibility flows *only* from
Cardano-observed stake → `TalkStake::AllowedStake` → microblog capacity, gated by a cogno-gate identity
binding. None of `microblog` / `cogno-gate` / `talk-stake` / `profile` depends on `pallet-balances` or
reads a free balance. **Granting fuel therefore confers zero posting power.** A future change that made a
social call fee-bearing would break this — don't.

**Why regenerating, and why mint-on-demand.** Fees are **burned** (`FungibleAdapter<Balances, ()>`), so a
fixed genesis supply is monotonically decreasing — left alone, governance eventually **bricks itself** when
it runs down. Worse, because `vote`/`close` refund `Pays::No` only *post*-dispatch, a member drained to
zero can't even vote to approve their own top-up (a self-refund deadlock). The regeneration hook dissolves
both problems: `set_allowance(who, max)` sets a per-account standing budget (and mints them up to it now);
each `RegenPeriod` the hook mints every funded account back up toward its ceiling. So a drained member
**auto-recovers next period** (no deadlock), and the supply **floats** with mint-on-demand (never depletes).
This is the first — and only — post-genesis mint path in the runtime; it is safe precisely *because* fuel
has no utility surface (can't post, can't be sold if non-transferable, isn't vote-weight — the committee is
1-member-1-vote — isn't consensus-weight — Aura is set-gated), and a 3-of-5 quorum that could abuse minting
already holds runtime-upgrade authority (strictly more power). There is a per-call `MaxAllowance` cap (bounds
a fat-finger) but deliberately **no cumulative issuance cap** (that would reintroduce the depletion brick).

**Fuel is also a seating prerequisite, not just a fee source.** The runtime *gates seating* on fuel: an
account must already hold a committee-granted allowance before it can be seated as a validator
(`ValidatorSet::add_validator` rejects an unfunded account with `NotFunded`) or added to the committee
(a `set_members` that seats a new, unfunded member is `CallFiltered` by the base call filter). So the
onboarding order is fixed — fuel `set_allowance` **then** `set-keys` / `members add` **then** `add_validator`
— because an unfunded member would only dilute the `EnsureProportionAtLeast` denominator (raising the
threshold) without adding votable capacity.

**Spam & offboarding.** A funded member's admin-spam is naturally bounded — per period they can spend at
most their allowance, and `FollowerMaxProposals`/block-weight bound throughput regardless. `revoke(who)`
drops the allowance (regeneration stops) **and** claws back the balance (escape-proof, since fuel is
non-transferable); pair it with `remove_validator` / `set_members` to strip the role. Because members carry
a standing allowance by default, the natural state is "everyone funded" — you'd have to *actively* revoke
to strand a seat, and that itself needs a quorum. **Operational invariant:** don't revoke the fuel of
committee members you still need for quorum.

> **Weights / naming.** `set_allowance`/`revoke` ship with placeholder `WeightInfo = ()` (conservative
> DB-weight estimates; graduating to a benchmarked `SubstrateWeight` is a deploy step, like
> `pallet-governed-upgrade`). The chainspec sets `tokenSymbol = "FUEL"` (display-only; consensus-neutral).

---

## 7. Feeless transactions & the new security surface

### How posts become feeless in FRAME

Two composable pieces, both standard:

1. **Waive the fee.** Either return `Weight::zero()` from the capacity extension's `weight()`/`post_dispatch_details()` (Gallois template approach), or annotate `post_message` with `#[pallet::feeless_if(|origin, args| …)]` and wrap `ChargeTransactionPayment` in `pallet-skip-feeless-payment`'s `SkipCheckIfFeeless`. Zero weight → zero fee.
2. **That is NOT spam protection.** `feeless_if` only *skips the fee in the payment extension* — it does not reject anything from the pool. Shipping only `feeless_if` is the classic mistake: a zero-balance account could then spam for free.

### The critical point: gate in `validate()`, not just on-chain

**Because there are no fees, all spam/DoS protection rests on the capacity check — and that check MUST run in `TransactionExtension::validate()` (mempool / pool level), not only as an on-chain `ensure!` inside `post_message`.**

An on-chain-only `ensure!(capacity_ok)` fires *too late*: a signature-valid but over-budget tx has already entered the mempool, been gossiped, and consumed validate/block-construction work — **for free**. On a feeless chain, that *is* the spam. Running the check in `validate()` is what bounds it:

```rust
// CheckCapacity TransactionExtension — modeled on Gallois's CheckRate
// (substrate-feeless-solochain-template, GPL-3.0 — note copyleft if vendored)
impl<T: Config> TransactionExtension<RuntimeCall> for CheckCapacity<T> {
    fn validate(&self, origin, call, info, len, ...) -> ValidateResult<...> {
        if let RuntimeCall::Microblog(Call::post_message { text, .. }) = call {
            let who  = /* signer from origin */;
            let now  = frame_system::Pallet::<T>::block_number();
            let have = pallet_microblog::Pallet::<T>::current_capacity(&who, now);  // 2 cheap reads
            let need = pallet_microblog::Pallet::<T>::post_cost(text.len() as u32);
            ensure!(have >= need,
                TransactionValidityError::Invalid(InvalidTransaction::ExhaustsResources)); // <- POOL REJECT
            // Tie priority/longevity to REMAINING capacity so an over-budget burst is
            // deprioritized and ages out fast, rather than relying on default().
            let vt = ValidTransaction { priority: (have - need) as u64, longevity: SHORT, ..Default::default() };
            return Ok((vt, val, origin));
        }
        Ok((ValidTransaction::default(), val, origin))
    }
    // prepare(): pass Val through.
    // post_dispatch_details(): pallet_microblog::consume(&who, now, cost); return Weight::zero();
}
```

**Gate in `validate()`, mutate in `post_dispatch()`** — never consume in `validate()` (the pool may call it many times per tx, which would over-charge) and never rely solely on the call body (the pool gate and state would desync). Keep `validate()` to a couple of **cheap storage reads** — `current_capacity` reads `AllowedStake` (weight) **and** `Capacity` (state), so it is ~two reads plus the block-number read, not one; co-locate weight and capacity in a single `StorageMap` entry if you want it down to one. **Do not** verify CIP-8 signatures or do crypto there (heavy compute in uncharged validation is itself a DoS vector).

**What `validate()` actually bounds — be precise.** Consumption happens only in `post_dispatch` (at inclusion), so `validate()` does **not** prevent a *same-account burst* from transiently entering and gossiping the mempool: several posts from one account with increasing nonces, submitted before a block is built, all read the *same* un-consumed `capacity_last`, all pass `validate()`, and all enter the pool. What is correctly bounded is **inclusion**: the block author re-runs `validate()` at build time, sees capacity already consumed by the first included post, and rejects the rest — so only ~`cap` posts land on-chain. The backstop against transient *burst pollution* of the mempool is therefore not `validate()` alone but the **pool's per-sender limits** (future/`nonce`-gap caps, ready/future queue limits) plus block-build re-validation, reinforced by the capacity-tied `priority`/`longevity` above. Net: posting is hard-bounded; mempool burst pollution is *throttled*, not impossible.

**Backstop unchanged:** FRAME's per-block weight limits still apply. `frame_system::BlockWeights` caps total per-block weight (Normal class = 75% of the block), `CheckWeight` returns `ExhaustsResources` when full. Capacity-gating throttles per-account inflow into the pool; block weight limits cap per-block execution. The two are layered, not alternatives. **Benchmark `post_message` to a real `Weight`** (don't ship `dev_mode` weights) so the block-limit math is honest.

---

## 8. Honest risks

- **Epoch-snapshot latency vs lock immediacy.** The Delegate path has a **~10-day** activation lag (a delegation in epoch N becomes election-active "set" stake only at N+2; epoch = 432,000 slots = 5 days) and 5-day quantization. A new user waits up to ~10 days for *any* weight, and un-delegation lingers up to ~2 epochs with no event-driven signal. This is fine for a slow loyalty multiplier and disqualifying for a responsive rate-limiter. **The Lock path's recognition latency is a deliberate confirmation-depth choice** — minutes at shallow depth for low-value locks, longer when stronger rollback safety is wanted — and it revokes event-driven on `spent_at`. Either way it is far below the Delegate path's ~10 days, which is the single biggest reason Lock is the primary source.
- **Whales.** A linear curve gives weight strictly proportional to wealth — a 1000-ADA holder gets 100× a 10-ADA holder's posting rate. If that is undesirable, a concave curve helps *but is Sybil-farmable* (§4.3). The honest resolution: ship linear with a hard ceiling (capped-linear) for v1; move to sqrt only behind a proven gate.
- **Capacity as sole security — and it constrains users, not the operator.** Capacity is the *only* anti-spam mechanism on a feeless chain — there is no fee floor underneath it. If the `validate()` gate is wrong (consume-in-validate, missing extension, crypto-in-validate), free spam is possible. The block-weight backstop bounds per-*block* damage but not mempool pollution. This must be implemented exactly as §7 specifies, and benchmarked. **One honest scoping note:** capacity throttles *non-operator users* only. On a 1–3-validator PoA chain the operator authors blocks and can include their own over-budget posts by simply not applying the gate at build time — exactly as they could have waived the old deposit. This is not a regression versus the deposit model, but it means capacity is a discipline on users, and consensus trust (the §8 weight-oracle / Aura-GRANDPA boundary) remains the real security boundary.
- **Unstake / power-down handling — clamp-only decay, NO on-chain cooldown (DR-13).** Withdrawing stake must not be a capacity-laundering exploit. ⛔ The earlier design here ("the lock must carry an unstake cooldown enforced on Cardano … a `lock_until` datum field in `talk-stake.ak` checked against the tx validity interval") is **SUPERSEDED by DR-13: v1 has no `lock_until` and no on-chain (or runtime) timelock.** A user *can* spend their lock UTxO on L1 at any moment. The anti-toggle defense is instead **structural and clamp-only**: capacity **starts at zero** for a new identity, **accrues only while the lock stays parked**, and **clamps to zero on unlock** (the follower writes `weight = 0`, and L3 clamps `current` to the new — zero — cap). Flash *unlock→relock* toggling buys nothing because a relock starts from a zero/forfeited bucket and must charge up again over `FILL_WINDOW` (and per §6.1 the `Capacity` row is never deleted, so a relock cannot read a `None` first-touch and re-mint a fresh bucket). An opt-in `lock_until` commitment-bonus is **deferred** (if ever added: decay-toward-new-cap + re-tighten to the whole owner Address first). On the (deferred) Delegate path the ~2-epoch lag would be a natural, ledger-enforced cooldown — but Delegate is not the v1 source.
- **What stops farming regen via many accounts — stated invariant, enforced both sides.** Nothing in the *curve* stops it; the bucket must be keyed to **one verified Cardano identity — the whole owner Address (payment + stake credential; CIP-8 whole-address match, DR-01), not a bare `owner_pkh`, not per sr25519 key, and not per UTxO**. This is an **invariant the gate must enforce, not an assumption**: with `AllowedStake`/`Capacity` keyed by Substrate `AccountId`, the 1-bucket-per-identity guarantee holds *only if* (a) **`pallet-cogno-gate` rejects binding a second Substrate account to an already-bound owner Address** (a hard 1:1 Address → account map; PLAN.md's `AllowedKeys` must state and enforce this — under DR-01 the L3 1:1 binding keys on `blake2b_256(owner Address)`, 32 bytes, which is also the beacon token_name), and (b) **the follower aggregates *all* of that owner Address's lock UTxOs into a single weight written to the single bound account**, never to a follower-chosen arbitrary account. If one identity could bind multiple accounts, each gets its own bucket and capacity multiplies — the anti-Sybil claim fails. (Alternatively, key `AllowedStake`/`Capacity` by `blake2b_256(owner Address)` directly, which makes the invariant structural.) Under a concave curve, splitting across *identities* is profitable, so each split must additionally cost a full pass through the CIP-8 gate (and, under M2b, ownership of a real on-chain thread — a scarce object). Anti-Sybil lives in the gate, never the curve.
- **Operator trust in the weight oracle.** `set_stake` is follower-submitted, so weight tracks Cardano with the follower's polling cadence + reorg-depth delay; the follower is a trusted oracle and a single point of failure (a follower outage freezes weight updates). This is the *same* trust boundary PLAN.md already accepts at `link_identity` — capacity does not add a new trust assumption, but it does raise the stakes (the follower now also controls posting *rate*, not just the allow bit). Put the `set_stake` `EnsureOrigin` behind the same multisig/threshold as `link_identity`.
- **Reorg correctness is the follower's job.** Never grant weight off a 0-confirmation lock. db-sync gives a deterministic block-at/before-slot read, so the follower must filter vault matches by `created_at`/`spent_at` slot past reorg depth (spentness from `tx_in`) before submitting `set_stake`. Get this wrong and a rolled-back lock mints phantom capacity.
- **Reward distribution (hybrid path) — deferred to M5 (DR-29); not a v1 concern.** v1 is a **plain Lock** on the light path, so there are no pooled rewards to distribute. When the hybrid lands at M5: locked-ADA staking rewards pool into one shared reward account; fair per-user distribution is an unsolved policy choice (pro-rata payout, compounding, or a disclosed DAO staking agent). Trustless per-user routing needs the thin-tooling type-3 path. Honest framing: rewards are *preserved*, their *fair split* is operator policy.

---

## 9. Plan deltas — exactly what changes in PLAN.md

Directly actionable edits, by section:

- **§1 (interpretations):** No change to the three-link framing. Add a sentence that link #1 (the CIP-8 gate) is now *also* the Sybil anchor for capacity, not just a membership check.
- **§2 (stack diagram):** Add `pallet-talk-stake` and `pallet-talk-capacity` (or fold capacity into `pallet-microblog`) to the runtime box. The follower now also reads **amounts** (locked lovelace), not just signatures — annotate the Cogno-Follower box: "reads CIP-8 identity **and** talk-stake lock amounts → `set_stake`." Annotate the data layer: "reads via **db-sync**, submits L1 txs via **Ogmios**."
- **§3 (approaches table):** Under Approach A, note the gate is now **metered** (regenerating capacity), and that the Lock path reads the vault via db-sync and submits L1 txs via Ogmios.
- **§4 (end-to-end):** 
  - ONBOARD: extend `link_identity` / `AllowedKeys` to also record the user's **stake/lock binding** (the whole owner **Address** is reused per DR-01; add the lock-UTxO observation), and **enforce a hard 1:1 owner-Address → Substrate account map** — reject binding a second account to a bound Address (the anti-Sybil invariant, §8; L3 keys this on `blake2b_256(owner Address)`). The follower gains a second job: index the lock validator, **aggregate all of an owner Address's lock UTxOs into one weight**, and submit `set_stake` to that one account. Stamp the capacity bucket empty (`{0, now}`) at first bind (§6.2).
  - POST (step 6): **remove** "takes a refundable `Hold` deposit (`BaseDeposit + ByteDeposit*len`)"; **replace** with "capacity checked in `validate()` (`ExhaustsResources` if over budget), consumed in `post_dispatch`; fee waived (`Weight::zero()`)." The gate becomes **metered capacity**, not a binary allow.
- **§5 (posts pallet):** This is the biggest change. Per the §6.3 table above: delete `HoldReason::PostDeposit`, the `MutateHold`/`Currency`/`BaseDeposit`/`ByteDeposit` config items, the `hold(...)` in `post_message`, and the `release(...)` in `delete_post`. Add the `Capacity` storage map, `CapacityState`, `current_capacity`/`post_cost`/`consume`, and the new capacity config constants. Rewrite the "Anti-spam summary" (line 264) from "refundable Hold" to "stake-weighted regenerating capacity, checked at the pool layer."
- **§6 (monorepo layout):** Under `pallets/` add `talk-stake/` (capacity logic is folded into `pallet-microblog`, DR-24). Under `cardano/` add the lock validator (sibling to `thread.ak`) — ⛔ per DR-13 it carries **NO `lock_until` datum field and NO validity-interval cooldown** in v1 (the commitment is enforced by L3 clamp-only decay, §8); the v1 datum is `VaultDatum { owner: Address }` (DR-01). (Per DR-18 the strict-beacon design merges mint+spend into a single `talk_vault(min_lock)` validator.) Under `services/cogno-follower/` note the added responsibility (index the lock validator, **aggregate all of an owner Address's unspent lock coins into one weight**, drive `set_stake` to the single bound account). The capacity `TransactionExtension` lives in the runtime's extension tuple.
- **§7 (how to interact):** Add a "Lock ADA to get talk capacity" step before posting; the UI should show current capacity, the sustained rate, and a regen countdown ("you have X, need Y, full again in Z"). For pure-Substrate demos, `sudo`-call `set_stake` to grant weight.
- **§8 (roadmap):** Insert a **new milestone** between M2/M2b and M3 — **"M2c — Talk capacity (feeless metered posting)"**: add `pallet-talk-stake`, the `CheckCapacity` TransactionExtension, the lazy bucket (capacity folded into `pallet-microblog`, DR-24); remove the Hold; demo feeless posting gated by an operator-set weight. Then **"M2d — Cardano-sourced weight (Lock)"**: deploy the lock validator — ⛔ per DR-13 **WITHOUT any on-chain `lock_until` cooldown** (PLAN.md §8 M2d's "deploy … with an on-chain `lock_until` cooldown" is **SUPERSEDED**; the anti-toggle defense is L3 clamp-only decay, not an L1 timelock). Extend the follower to read locks, aggregate per owner Address (DR-01), and drive `set_stake` to the single bound account. Fold the type-1 hybrid (yield-bearing lock) **and reward distribution into M5** (DR-29) as the "target design." Update **M0/M5** notes: M5 must benchmark `post_message` to a *real* weight (it now backs the *only* anti-spam mechanism, not just fees).
- **§9 (risks):** Add the §8 risks here: capacity-as-sole-security, the `validate()`-vs-`ensure!` requirement, toggle-farming defenses, reward-distribution policy. The revocation-gap discussion now also covers **weight** revocation (Lock path: event-driven via `spent_at`, strictly better than the wallet-only story).
- **§10 (open questions):** Add the §10 items below (regen window, curve choice, lock-vs-hybrid, decay policy, reward policy) — but note most were **RESOLVED** during the build-out (the decisions are inlined here; the internal register is not part of this repo), and there is **no on-chain cooldown** in v1 (DR-13).
- **§11 (first step):** Unchanged — M0 stands up the chain. The capacity work is M2c onward.

---

## 10. Open questions (resolved during the build-out)

> **RESOLVED during the build-out.** The dispositions are inlined per-question below (the internal decision register is not part of this repo); the original detail is preserved.

1. **Regen window. — DECIDED: ~5h (DR-10).** The v1 regen window is **~5 hours** (the worked-example baseline: 10 ADA → ~48 posts/day sustained, burst ~10) — faster than Hive's 5 days / Midnight's ~7 days so casual posters aren't locked out. This single constant defines the UX; other capacity constants stay tunable (proposed at M2c). *(Original question: how fast should an empty bucket refill?)*
2. **Curve & whale policy. — DECIDED: linear (capped-linear) + hard ceiling in v1; sqrt only later behind a proven gate (DR-11).** Ship linear/capped-linear with a hard ceiling for v1 (split-neutral, does not amplify a gate weakness). Graduate to sqrt only once the CIP-8 gate (keyed on the whole owner Address, DR-01; ideally M2b thread-ownership) is proven. *(Original question: linear vs anti-whale curve, and what ceiling?)*
3. **Cost granularity.** Flat `POST_COST` per message, or per-byte (`BASE + PER_BYTE*len`)? Should replies/comments cost less than top-level posts?
4. **Burst vs sustained.** What cap (burst) and what sustained rate at the baseline stake? Decoupling them gives "occasional poster" (big cap, small rate) vs "steady chatter" (small cap, big rate) UX.
5. **Weight source for launch. — DECIDED: plain Lock read via db-sync (Ogmios submits); hybrid + rewards deferred to M5 (DR-29, DR-33).** v1 reads exact locked lovelace from a **plain Lock** (no delegation) via db-sync; the default posting-power read is L3 `AllowedStake`, with a db-sync recompute as an optional cross-check and **no Blockfrost**. The yield-bearing "lock-that-delegates" hybrid and any reward routing are deferred to M5. Delegate-alone stays rejected (~10-day lag). *(Original question: Lock vs hybrid vs Delegate-bonus.)*
6. **Unstake cooldown & decay policy. — DECIDED: clamp-only decay, NO on-chain timelock (DR-13).** ⛔ The earlier "enforcement point is settled — it lives in `talk-stake.ak` as a `lock_until` datum check" is **SUPERSEDED**: v1 has **no `lock_until`, no on-chain cooldown, and no runtime timelock**. On unlock, capacity **clamps to zero** (clamp-only decay): talk starts at zero, accrues only while parked, and zeroes on unlock. An opt-in `lock_until` commitment-bonus (decay-toward-new-cap variant) is **deferred** (and if added would re-tighten to the whole owner Address first). *(Original question: cooldown length and decay-vs-zero on unlock — moot in v1, which zeroes.)*
7. **Reward distribution (if hybrid). — DEFERRED to M5 (DR-29).** Not a v1 question: v1 is a plain Lock with no pooled rewards to distribute. When the hybrid lands at M5, pooled staking rewards from locked ADA need a distribution policy (pro-rata payout, compounding, or a disclosed DAO/operator staking agent; per-user trustless routing needs the thin type-3 path).
8. **First-touch default — DECIDED: start at zero + accept a short charge-up (DR-12; §6.2).** New identities start at **zero** and charge up (full-on-first-touch + cheap identities = burst farm, and it reopens the relock farm). The onboarding sweetener is **copy-only: accept a short initial charge-up** — a new identity simply starts at 0 and waits a `FILL_WINDOW`-fraction for its first post; no free bucket is minted at bind time. Avoid Hive's account-creation cliff via messaging, not a minted allowance.
9. **Surge headroom.** Any explicit burst-above-stake allowance? If so, keep it small (2–3×) and advertise the *sustained* rate — do **not** repeat EOS's 1000× borrowed-burst trap.
10. **Delegation bonus.** Worth the db-sync burden to add a slow loyalty multiplier for users who delegate to the Cogno pool (which also bootstraps the project's own SPO), or keep it lock-only and stay on the light path?
