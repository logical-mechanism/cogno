# cogno-chain — Exploration & Plan

> **Status: IMPLEMENTED through M8 (runtime spec 107).** This document is the original design;
> see [`docs/M*-build.md`](docs/) for what was actually built. Technically rigorous and
> deliberately honest about tradeoffs.
> **Owner context:** builder of **Cogno**, a Cardano-native forum/thread system. Verified against the live code: `cogno_v3/cogno_v3_contracts` (two validators only — `thread.ak`, `always_false.ak`) and the Django/pycardano backend at `cogno_v3/cogno_v3_app/backend`.
> **Goal:** A showcase monorepo that connects the **Polkadot SDK solochain template** to Cardano with a simple **"users post text, users read text"** app, gated by Cardano wallet ownership (CIP-8) and witnessed on Cardano.
> **Companion:** [`ECONOMICS.md`](ECONOMICS.md) specifies the **economic model** — a stake-weighted, regenerating, *feeless* "talk capacity" (Hive-RC / Midnight-DUST style) that **replaces** the per-post refundable deposit sketched in §5 below. Cogno's original fee-per-post model is exactly what killed it at volume; capacity is the fix. Where this document and `ECONOMICS.md` disagree on anti-spam, `ECONOMICS.md` is authoritative.

> **RECONCILED to docs/DECISION-REGISTER.md (2026-06-16).** The decisions below are canonical and OVERRIDE this doc where they conflict:
> - **DR-18 + DR-24 — one merged validator, capacity folded into microblog (supersedes §2 stack diagram, §3 table "B. Partner Chain"/pallet split, §5 skeleton, §6 layout, §8 M2c/M2d).** The L1 side is now a **single merged `talk_vault(min_lock)` validator** carrying BOTH a mint and a spend handler (the `cogno_v3` `thread.ak` shape): `policy_id == vault script hash`; the mint arm asserts the beacon lands at the script's own address. There is **no** separate beacon minting policy, **no** `beacon_policy_id` parameter, and the old hash-cycle concern is deleted. On the Substrate side, capacity logic is **folded into `pallet-microblog`** — there is **no** standalone `pallet-talk-stake`. The pallet set is `{cogno-gate, microblog (incl. capacity), anchor}`.
> - **DR-01 — identity is the WHOLE Address (supersedes §0/§2/§4/§5/§6 "pkh"/`cardano_pkh`/`owner: VKH` framing).** The L1 vault datum is **`VaultDatum { owner: Address }`** (a full CIP-19 Address = payment credential + stake credential), NOT `{ owner_pkh }`. v1 restricts the payment credential to `VerificationKey`. The beacon `token_name = blake2b_256(serialized owner Address)` (**32 bytes**). CIP-8 binding is an **exact whole-address match** (payment AND stake cred) — the old "wrong-address binding" gotcha is structurally closed. Enforce `vault_address.stake_cred == datum.owner.stake_cred` on create and every continuation. The L3 1:1 Sybil anchor keys on `blake2b_256(owner Address)` (32 bytes), not a 28-byte pkh.
> - **DR-02 — CIP-8 is a committed payload (refines §4/§7 onboarding).** The user signs domain-separated bytes committing `{ sr25519 account + L3 genesis hash + fresh nonce }`; the follower verifies signature valid + signing address == `datum.owner` + payload-sr25519 == the submitted sr25519. Bind-hijack is **prevented** in v1 (on-chain ed25519 self-proof is the deferred D1).
> - **DR-13 — v1 has NO on-chain timelock / NO `lock_until` (⛔ supersedes §8 M2d).** The §8 M2d line "deploy `talk-stake.ak` … with an on-chain `lock_until` cooldown" is SUPERSEDED. M2d deploys the merged `talk_vault` with `VaultDatum { owner: Address }` and **no** `lock_until`. The commitment is enforced entirely by L3 regen/clamp (talk starts at zero, accrues only while parked, clamps to zero on unlock). An opt-in `lock_until` bonus is DEFERRED.
> - **DR-21 / DR-23 — `NextPostId` is `u64` (not `u32`); the thread pointer is `ConstU32<10>` (10 hex), never `<4>`** (corrects the §5 skeleton).
> - **v1 posture choices that touch this doc:** devnet = **PREPROD** (db-sync for reads + Ogmios for submit) [DR-31] — supersedes the §2/§3/§6/§7 "preview" wording; pin the **latest stable polkadot-sdk monorepo release** at M0 [DR-03]; v1 = a **single follower key** + sudo escape hatch + audit log (3-of-5 committee gated to D2) [DR-07]; the **archive is committed** in v1 (operator runs `--pruning archive` + publishes genesis hash + chainspec; "anyone can verify" is honestly backed at launch) [DR-08]; the **Tier-A metadata anchor lands at M3** after the core loop, Tier-B deferred to M5 [DR-20]; reorg burial = grant-k (a few hundred slots) + a shorter clamp-k [DR-09b]; reference indexer = **SubQuery** with PAPI-direct as the v1 baseline [DR-27]; comments/replies are **gated** (inherit the 1:1 anchor + capacity) [DR-14b].
>
> The **Open questions (§10)** are RESOLVED — see docs/DECISION-REGISTER.md.

---

## 0. Ground truth: what cogno_v3 actually is

Before designing anything, here is what the live v3 code does — because the gate and the identity story must be built on this, not on the older v2 beacon/profile model.

- **Contracts.** `cogno_v3_contracts/validators/` contains exactly **`thread.ak`** and **`always_false.ak`**. There is **no** Cogno/identity minter, **no** `CognoDatum`, **no** profile UTxO, and **no** "cafebabe beacon." The only on-chain object is a **thread**.
- **The thread datum** is `ThreadDatum { owner: VerificationKeyHash, pointer: AssetName, that_token_name: Option<AssetName> }`. A `ThreadDatum` is a **post/thread**, not an identity.
- **The thread token name is 5 bytes.** `lib/util.ak`: `token_name = tx_id |> bytearray.push(tx_idx) |> bytearray.slice(0, 4)`. Aiken's `bytearray.slice(start, end)` is **inclusive**, so `slice(0, 4)` returns **5 bytes**. The contract's own test asserts `token_name(...) == #"00e5993fa3"` (5 bytes). The doc comment in `util.ak` says so explicitly: *"The first 5 bytes, 10 ascii characters, is the token name."* The frontend (`utils/tokenName.ts`) computes `(idxHex + txId).slice(0, 10)` = 10 hex chars = **5 bytes**, and the Django `Thread.token` field is `max_length=10` (hex). **The join key is 5 bytes / 10 hex chars — never 4.**
- **Login proves wallet-key control, not asset ownership.** `api/views/login/verify_view.py` verifies a CIP-8 `COSE_Sign1` with **`pycardano.cip.cip8.verify`**, checks the signed nonce and that the recovered address matches, then does `Wallet.objects.get_or_create(verification_key_hash=...)` keyed on the 28-byte payment-key-hash. **It never checks ownership of any on-chain asset.** Any wallet that can sign qualifies.
- **The verifier is Python.** `requirements.txt` pins `pycardano==0.13.0`, `ogmios==1.3.0`, `cose==0.9.dev8`. There are **zero** references to the `cardano-signer` binary anywhere in cogno_v3. The `cardano-signer-1.32.0` binary on disk is unrelated to Cogno.

Everything below is built on these facts.

---

## 1. What this could be

In plain terms: **a dedicated, high-throughput "post text / read text" chain whose membership is proven by your Cardano wallet, and whose integrity is witnessed on Cardano.** Cardano stays the place you prove *who signs*; a small Substrate chain becomes cheap, fast blockspace for *what you say*.

The phrase "connect a solochain to Cardano" has **three honest interpretations**, each buying you something different:

1. **Cardano as a wallet-ownership oracle (read-only).** Cardano answers one question: *"can this person produce a valid CIP-8 signature from a Cardano wallet?"* (optionally: *"and does that wallet own ≥1 existing `cogno_v3` thread?"*). The solochain owns all posts. Loosest coupling. Buys you: a real "your Cardano wallet is your identity" story with almost no Cardano infra and the fastest possible demo.
2. **Cardano as a tamper-evidence witness (write-only).** The solochain periodically writes a **finalized** state-root to Cardano (metadata or a tiny Plutus checkpoint). Cardano can't *stop* a bad block, but — **given that the block data is independently available** — anyone can later *prove* the operator silently rewrote history. Buys you: a publicly verifiable, Cardano-timestamped integrity claim.
3. **Cardano as the validator set (consensus coupling).** Cardano SPOs register on L1 and the Ariadne/D-parameter algorithm elects the chain's block-producing committee (the IOG Partner Chains model). Buys you: the strongest "secured by Cardano stake" narrative — at a very high cost, and on an **archived** toolkit (see §3).

**The pragmatic showcase combines #1 and #2** (gate on a Cardano wallet signature, anchor finalized roots to Cardano) while leaving a credible upgrade path to #3. **None of these makes the solochain inherit Cardano's economic finality or security** — be clear about that throughout. The solochain's safety is its own Aura/GRANDPA, run by the operator.

---

## 2. The stack

```
                                   ┌──────────────────────────────────────────────┐
                                   │                  FRONTEND                    │
                                   │  Next.js + MeshJS (CIP-30 wallet connect)    │
                                   │  polkadot-api (PAPI) typed client            │
                                   │  WRITE: tx.Microblog.post_message(...)       │
                                   │  READ:  query.Microblog.Posts.watchEntries() │
                                   └───────┬───────────────────────────┬──────────┘
                       CIP-30 signData     │                           │  ws://localhost:9944
                       (one-time wallet     │                          │  (PAPI / subxt)
                        ownership proof)    │                           │
                                   ┌────────▼─────────────┐    ┌────────▼──────────────────────────┐
                                   │  COGNO-FOLLOWER       │    │   SUBSTRATE SOLOCHAIN (cogno-chain) │
                                   │  (Python service)     │    │   Polkadot-SDK solochain-template  │
                                   │  reuses pycardano.cip  │   │   Aura authoring + GRANDPA finality │
                                   │  .cip8.verify          │   │                                    │
                                   │  (proven v3 verifier)  │   │   runtime (WASM):                  │
                                   │                        │link│   System/Timestamp/Aura/Grandpa/   │
                                   │  OPTIONAL: db-sync     │ _id │  Balances/TxPayment/Sudo +        │
                                   │  checks signer owns    │enty │  ┌─ pallet-cogno-gate            │
                                   │  ≥1 vault UTxO  ──────▶│ ──▶ │   ├─ pallet-microblog             │
                                   │                        │     │   │    (Posts + capacity, DR-24)  │
                                   │                        │     │   └─ pallet-anchor (checkpoints)  │
                                            │                    └───────┬───────────────┬──────────┘
                       db-sync              │                            │ finality        │ PostCreated
                       (vault reads,        │                            │ notification    │ events
                        read-only)          │                    ┌───────▼────────┐  ┌─────▼─────────┐
                                   ┌────────▼──────────┐         │  ANCHOR RELAYER │  │  INDEXER (opt) │
                                   │  CARDANO L1        │         │  builds+submits  │  │  SubQuery     │
                                   │  cardano-node      │◀────────┤  anchor tx for   │  │  Postgres+    │
                                   │  + Ogmios          │  Ogmios │  last FINALIZED   │  │  GraphQL feed │
                                   │  ONE merged        │  tx     │  root             │  └───────────────┘
                                   │  talk_vault(min_   │  submit │  (metadata Tier-A │
                                   │   lock) validator: │         │   or Aiken         │
                                   │   mint+spend; NFT  │         │   checkpoint UTxO)│
                                   │   beacon = bb2b_256│         └───────────────────┘
                                   │   (owner Address); │
                                   │   VaultDatum{owner:│
                                   │   Address} (DR-18) │
                                   └────────────────────┘
```

**Legend of layers:** (1) Cardano L1 + the **single merged `talk_vault(min_lock)` validator** (mint+spend, `VaultDatum { owner: Address }`, beacon `token_name = blake2b_256(serialized owner Address)`; DR-18/DR-01) — built fresh for cogno-chain in the `cogno_v3` `thread.ak` style; the `cogno_v3` `thread.ak` itself remains a separate reusable artifact for the optional thread-ownership check, (2) bridge/follower services (Cogno-Follower + Anchor Relayer — both off-chain, operator-run), (3) the Substrate solochain + custom pallets (capacity is **folded into `pallet-microblog`**, DR-24), (4) the frontend. Indexer and the optional vault/thread-ownership check are only for scale/strictness.

---

## 3. Architecture: three approaches

| Dimension | **A. Anchor (lightest)** | **B. Partner Chain** | **C. Wallet-ownership gate** |
|---|---|---|---|
| **Cardano coupling** | Read (CIP-8 wallet gate) + write (finalized state-root witness); both off-chain, one-directional | Cardano SPOs *elect the committee* via Ariadne/D-param (inherent data) | Read-only CIP-8 wallet gate; no state anchoring |
| **Effort** | **Low** — clone template, add 3 small pallets, reuse pycardano verifier | **Very high** — dual Cardano+Substrate+Nix expertise | **Medium** — wrap the existing cogno_v3 pycardano CIP-8 path as a service |
| **Security** | Operator-run Aura/GRANDPA (permissioned); Cardano = tamper-*evidence* only | Committee weighted by real ADA stake — but chain still runs its own Aura/GRANDPA | Same as A on consensus; the gate is a trusted oracle |
| **"Cardano-ness"** | Medium (wallet gate + finalized-root timestamp witness) | **Highest** (block producers *are* SPOs) | Medium (gated by Cardano wallet ownership) |
| **Demo speed** | **Days** | Weeks→months; needs db-sync per validator | ~1–2 weeks (reuses cogno_v3 CIP-8 verify) |
| **Toolkit health** | Active: solochain-template + PAPI | **ARCHIVED 2026-04-23** (folded into Midnight, frozen v1.8.1) | Active |
| **Per-validator Cardano infra** | Operator only (db-sync + Ogmios) | **Every** block producer: cardano-node + db-sync + Postgres (~24GB RAM, 700GB+ SSD) | Operator only |

### RECOMMENDATION: **Approach A (Anchor) as the build, structured so it graduates toward B/C.**

Reasoning:

- **It demos fast and honestly.** Clone the release-pinned `solochain-template`, add three small FRAME pallets, run `--dev`, and you have a working post/read chain in days. The story — *"gated by your Cardano wallet, witnessed on Cardano"* — is exactly what the code does, with zero overclaiming.
- **It reuses the proven verifier.** The live `cogno_v3` backend already verifies CIP-8 with `pycardano.cip.cip8.verify`; the Cogno-Follower reuses that exact battle-tested path (a small Python service), rather than re-implementing CIP-8 against the unrelated `cardano-signer` binary. The thread join key (5-byte `pointer`) is also already produced by the live contract and frontend.
- **It avoids the archived stack.** Approach B builds on a deprecated, alpha, "not for production" toolkit (`input-output-hk/partner-chains`, read-only since 2026-04-23, frozen at v1.8.1, folded into Midnight). Starting there for a showcase is a liability.
- **A *is* C plus a witness.** The wallet-gating in A is identical to the Wallet-ownership gate; A simply adds the (cheap, optional) finalized-root anchor. So choosing A gives you C "for free" and the witness on top.
- **Clean glide path.** `pallet-microblog` and `pallet-cogno-gate` are unchanged if you later swap operator-run Aura authorities for an Ariadne SPO committee. You throw nothing away when graduating to B.

The remainder of this document specifies **Approach A**.

---

## 4. How it works end-to-end (Approach A)

The Cardano linkage is **two one-directional, read/witness-only links**. Cardano never validates the chain's state; the chain never mutates Cardano.

**ONBOARD — one-time wallet binding (the Cardano READ link):**
1. The user has a Cardano wallet. This is the credential — and per **DR-01 the identity is the WHOLE CIP-19 Address** (payment credential + stake credential), not just the payment-key hash. (Optionally, see step 3b, you also require them to own a live `talk_vault` UTxO and/or a `cogno_v3` thread.)
2. In the dApp they connect a CIP-30 wallet and sign a server-issued **committed payload** → CIP-8 `COSE_Sign1` (`wallet.signData`). Per **DR-02** the signed bytes are domain-separated and commit `{ sr25519 account + L3 genesis hash + fresh nonce }`, so bind-hijack is *prevented*, not just detected.
3. The **Cogno-Follower** verifies the signature off-chain by reusing the proven `pycardano.cip.cip8.verify` path from `cogno_v3` (the same machinery as `verify_view.py`: check `verified`, that the signed payload is the issued committed payload, and — per DR-01 — that the **recovered signing address exactly matches** `datum.owner` (payment AND stake credential), and that the payload-embedded sr25519 equals the submitted sr25519). The bound key is the **whole Address** (its `blake2b_256` is the 32-byte beacon name / 1:1 anchor), not a bare 28-byte pkh.
3b. *(Optional strictness — Tier-2 gate.)* If you want more than a valid signature, the follower additionally confirms via **db-sync** that the signer owns ≥1 live `talk_vault` `VaultDatum` UTxO whose `owner` Address matches (and/or a live `cogno_v3` `ThreadDatum`), past reorg depth. The vault beacon NFT name is `blake2b_256(serialized owner Address)` (32 bytes); the optional thread check still **binds the 5-byte thread `pointer` (10 hex chars), not a non-existent 4-byte beacon.**
4. On success it submits a privileged `link_identity { owner_address, vault_beacon: Option, substrate_account }` extrinsic into `pallet-cogno-gate`'s `AllowedKeys` map (keyed on `blake2b_256(owner Address)`, the 32-byte 1:1 Sybil anchor). **Cardano data enters via a deterministic, operator-run path — never a non-deterministic Substrate offchain-worker HTTP call** (the explicit anti-pattern for consensus-relevant reads).

**POST — a user posts text:**
5. The user signs `post_message({ text })` with their Substrate sr25519 key (PAPI: `typedApi.tx.Microblog.post_message({ text: Binary.fromText('gm') }).signAndSubmit(signer)`).
6. `pallet-microblog` runs `ensure_signed` → `pallet-cogno-gate::is_allowed(who)` (rejects `NotAllowed` if unbound) → `text.try_into::<BoundedVec>()` (rejects `TooLong`) → checks/consumes **regenerating talk-capacity** (folded into `pallet-microblog`, DR-24; the over-budget case is rejected at the mempool with `ExhaustsResources` — no `Hold` deposit, see §5/ECONOMICS) → assigns `id` from `NextPostId` (a **`u64`**, DR-21) → inserts the `Post` → emits `PostCreated{ id, author }`.
7. Aura seals the block; GRANDPA finalizes. The post is now canonical on cogno-chain.

**READ — another user reads the feed:**
8. The reader's dApp queries the chain directly — `query.Microblog.Posts.getEntries()` (one-shot) or `watchEntries()` (live), or subscribes to `PostCreated` events (the PAPI-direct v1 baseline). For scale it hits the **SubQuery** GraphQL endpoint instead (DR-27). **No Cardano round-trip on the read path.**

**ANCHOR — periodic tamper-evidence (the Cardano WRITE link):**
9. The **Anchor Relayer** subscribes to the node's **GRANDPA finality notifications**. Every N finalized blocks it reads the **post-state storage root of the last finalized block** (a root that GRANDPA has actually committed to — not a best-chain or in-progress root) plus `{ block_number, post_count, timestamp }`. (`pallet-anchor` only *records* the last acknowledged checkpoint on-chain via `anchor_ack`; it does **not** snapshot a "finalized root" from inside `on_initialize`, which would expose only block N-1's state and could anchor a root that later loses to a different finalized fork.)
10. The relayer builds a Cardano tx embedding that finalized root — **Tier-A:** tx metadata under a registered label (cheapest, proves existence/timestamp, enforces nothing); **Tier-B (optional):** spend+recreate a singleton "checkpoint UTxO" at a tiny Aiken validator gated by the operator/k-of-t signature — signs with the operator key, submits via **Ogmios**, and on confirmation calls `anchor_ack{ block_number, cardano_txhash }` back so the UI can show *"anchored to Cardano at tx X."*

**VERIFY — anyone, anytime (subject to data availability):** given independent access to the solochain's block/state history at `block_number`, re-derive the finalized state-root and compare it to the root recorded on Cardano. A match proves no silent rewrite before that anchor; a mismatch is public, on-Cardano evidence of tampering. **This check is only possible if the block data is independently retained** (archive node, indexer snapshot, or published per-checkpoint data) — see §9.

> **The honest line:** integrity-against-silent-rewrite is *witnessed* by Cardano and *checkable only if the underlying data is independently available*; liveness, censorship-resistance, and block validity rest on trusting the chain operator.

---

## 5. The posts pallet

A textbook custom FRAME pallet. `pallet-cogno-gate` holds the allowlist; `pallet-microblog` stores posts and checks the gate.

> **⚠ Superseded anti-spam.** The refundable `Hold` deposit (`BaseDeposit`/`ByteDeposit`) shown below is **replaced** by the stake-weighted regenerating **talk-capacity** model in [`ECONOMICS.md`](ECONOMICS.md) §6–§7 (DR-13: v1 = **clamp-only decay, no on-chain timelock** — talk starts at zero, accrues only while parked, clamps to zero on unlock). Net change: delete `HoldReason`, the `MutateHold` currency, and the `hold(...)`/`release(...)` calls; add a `Capacity` map **inside `pallet-microblog`** (DR-24 — there is no standalone `pallet-talk-stake`) checked at the **mempool** layer (a `TransactionExtension::validate()` returning `ExhaustsResources` when over budget), consumed in `post_dispatch`, with the fee waived (`Weight::zero()`). The `is_allowed` identity gate (now also the Sybil anchor — enforce a hard 1:1 **`blake2b_256(owner Address) → AccountId`**, 32 bytes per DR-01, NOT a 28-byte pkh) and the `BoundedVec` length bound both stay. Read the skeleton below for the storage/event/`BoundedVec` shape only.

> ⛔ **The skeleton below predates docs/DECISION-REGISTER.md and shows the OLD `Hold`-deposit + `u32`-id shape.** Read it for the storage/event/`BoundedVec` layout only. Per the decisions, the live shape is: **capacity folded in** (no `HoldReason`/`MutateHold`/`hold`/`release`; a `Capacity` map + `CheckCapacity` `TransactionExtension`, DR-24/DR-13), **`NextPostId`/post ids are `u64`** (DR-21), **the thread pointer is `ConstU32<10>`** (10 hex, never `<4>` which truncates, DR-23) plus an optional bind field, the **`ByAuthor` cap is `MaxPostsPerAuthor = 10_000`** and **`MaxLength = 512`** (DR-10b), and the gate keys on **`blake2b_256(owner Address)` (32 bytes)** not a 28-byte pkh (DR-01). Comments/replies (`parent`) are **gated** like top-level posts (DR-14b).

```rust
// pallets/microblog/src/lib.rs  (FRAME v2, current #[frame_support::runtime]-style runtime)
// ⛔ SUPERSEDED SHAPE — see the note above: no Hold deposit (capacity folded in, DR-24/DR-13);
//    NextPostId/ids are u64 (DR-21); gate keyed on blake2b_256(owner Address) (DR-01).
#![cfg_attr(not(feature = "std"), no_std)]
pub use pallet::*;

#[frame_support::pallet]
pub mod pallet {
    use frame_support::{pallet_prelude::*, traits::fungible::{MutateHold, Inspect}};
    use frame_system::pallet_prelude::*;

    type BalanceOf<T> =
        <<T as Config>::Currency as Inspect<<T as frame_system::Config>::AccountId>>::Balance;

    #[pallet::composite_enum]
    pub enum HoldReason { PostDeposit }

    #[derive(Encode, Decode, Clone, PartialEq, Eq, RuntimeDebug, TypeInfo, MaxEncodedLen)]
    #[scale_info(skip_type_params(T))]
    pub struct Post<T: Config> {
        pub author:  T::AccountId,
        pub text:    BoundedVec<u8, T::MaxLength>,    // bounded -> finite PoV
        // cogno_v3 thread pointer, stored as 10 hex chars = 5 raw bytes.
        // Matches Thread.token (max_length=10) and thread.ak token_name (slice(0,4) -> 5 bytes).
        // None when gated only on wallet ownership (no thread required).
        pub thread:  Option<BoundedVec<u8, ConstU32<10>>>,
        pub parent:  Option<u32>,                     // replies/threading
        pub at:      BlockNumberFor<T>,
    }

    #[pallet::config]
    pub trait Config: frame_system::Config {
        type RuntimeEvent: From<Event<Self>> + IsType<<Self as frame_system::Config>::RuntimeEvent>;
        type RuntimeHoldReason: From<HoldReason>;
        type Currency: MutateHold<Self::AccountId, Reason = Self::RuntimeHoldReason>;
        type CognoGate: crate::CognoGate<Self::AccountId>;   // pallet-cogno-gate::is_allowed
        #[pallet::constant] type MaxLength: Get<u32>;        // anti-spam: cap text size / PoV
        #[pallet::constant] type BaseDeposit: Get<BalanceOf<Self>>;
        #[pallet::constant] type ByteDeposit: Get<BalanceOf<Self>>;
        type WeightInfo: WeightInfo;
    }

    #[pallet::pallet] pub struct Pallet<T>(_);

    #[pallet::storage] pub type NextPostId<T> = StorageValue<_, u32, ValueQuery>;
    #[pallet::storage] pub type Posts<T: Config> = StorageMap<_, Blake2_128Concat, u32, Post<T>>;
    #[pallet::storage] pub type ByAuthor<T: Config> =
        StorageMap<_, Blake2_128Concat, T::AccountId, BoundedVec<u32, ConstU32<1024>>, ValueQuery>;

    #[pallet::event] #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        PostCreated { id: u32, author: T::AccountId },
        PostDeleted { id: u32 },
    }

    #[pallet::error]
    pub enum Error<T> { TooLong, NotFound, NotAuthor, NotAllowed }

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        #[pallet::call_index(0)]
        #[pallet::weight(T::WeightInfo::post_message(text.len() as u32))]
        pub fn post_message(origin: OriginFor<T>, text: Vec<u8>, parent: Option<u32>) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(T::CognoGate::is_allowed(&who), Error::<T>::NotAllowed);     // <- Cardano gate
            let thread = T::CognoGate::thread_of(&who);                          // Option<5-byte pointer>
            let bounded: BoundedVec<_, _> = text.try_into().map_err(|_| Error::<T>::TooLong)?;

            let deposit = T::BaseDeposit::get()
                .saturating_add(T::ByteDeposit::get().saturating_mul((bounded.len() as u32).into()));
            T::Currency::hold(&HoldReason::PostDeposit.into(), &who, deposit)?;  // refundable

            let id = NextPostId::<T>::mutate(|n| { let id = *n; *n += 1; id });
            let at = <frame_system::Pallet<T>>::block_number();
            Posts::<T>::insert(id, Post { author: who.clone(), text: bounded, thread, parent, at });
            let _ = ByAuthor::<T>::try_mutate(&who, |v| v.try_push(id));
            Self::deposit_event(Event::PostCreated { id, author: who });
            Ok(())
        }

        #[pallet::call_index(1)]
        #[pallet::weight(T::WeightInfo::delete_post())]
        pub fn delete_post(origin: OriginFor<T>, id: u32) -> DispatchResult {
            let who = ensure_signed(origin)?;
            let post = Posts::<T>::get(id).ok_or(Error::<T>::NotFound)?;
            ensure!(post.author == who, Error::<T>::NotAuthor);
            let deposit = T::BaseDeposit::get()
                .saturating_add(T::ByteDeposit::get().saturating_mul((post.text.len() as u32).into()));
            T::Currency::release(&HoldReason::PostDeposit.into(), &who, deposit, Precision::BestEffort)?;
            Posts::<T>::remove(id);
            Self::deposit_event(Event::PostDeleted { id });
            Ok(())
        }
    }
}
```

> **Storage note on the thread pointer.** It is stored as **10 hex chars (`ConstU32<10>`)** to match the live `Thread.token` field (`max_length=10`) and the frontend's `slice(0, 10)`, so the value joins directly against the existing cogno_v3 data. If you prefer raw bytes, use `ConstU32<5>` and hex-decode at the follower — but never `ConstU32<4>`, which would silently truncate every real pointer by one byte.

**TypeScript read/write (polkadot-api / PAPI):**

```ts
import { createClient, Binary } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws-provider/web";
import { cogno } from "@polkadot-api/descriptors"; // npx papi add cogno -w ws://localhost:9944 && npx papi

const client = createClient(getWsProvider("ws://localhost:9944"));
const api = client.getTypedApi(cogno);

// WRITE
const tx  = api.tx.Microblog.post_message({ text: Binary.fromText("gm cogno"), parent: undefined });
const res = await tx.signAndSubmit(signer);              // signer = sr25519 (Substrate key)
console.log(res.ok, res.txHash);

// READ — one-shot feed
const entries = await api.query.Microblog.Posts.getEntries();
const feed = entries.map(e => ({ id: e.keyArgs[0], ...e.value }));

// READ — live feed
api.query.Microblog.Posts.watchEntries().subscribe(({ deltas }) => { /* render new posts */ });
```

> Note: posting is signed by the user's **Substrate sr25519 key**, not the Cardano wallet. The Cardano CIP-30 `signData` is used **once**, at onboarding, to bind that sr25519 account in `pallet-cogno-gate`.

**Anti-spam summary:** `BoundedVec<u8, MaxLength>` caps PoV/proof size; a refundable `Hold` (`BaseDeposit + ByteDeposit*len`) prices storage and is returned on `delete_post`; transaction fees add baseline resistance; an optional per-author cooldown can be layered later. *(Use `dev_mode`/placeholder weights for the demo only. The deposit-and-fee anti-spam story relies on real weights — benchmark before any non-dev deployment; see M5.)*

---

## 6. Monorepo layout

```
cogno-chain/
├─ Cargo.toml                       # Rust workspace (node, runtime, pallets, relayer)
├─ package.json                     # JS/TS workspace (app, indexer, scripts)
├─ rust-toolchain.toml              # pinned to the chosen monorepo commit's toolchain (see M0)
├─ README.md
│
├─ node/                            # cogno-chain-node binary (forked solochain-template)
│  └─ src/{chain_spec.rs, service.rs, main.rs}   # Aura authoring + GRANDPA, WS :9944, P2P :30333
│
├─ runtime/                         # cogno-chain-runtime (WASM state transition)
│  └─ src/lib.rs                    # #[frame_support::runtime]: System/Timestamp/Aura/Grandpa/
│                                   #   Balances/TxPayment/Sudo + CognoGate + Microblog + Anchor
│
├─ pallets/
│  ├─ cogno-gate/                   # AllowedKeys map (blake2b_256(owner Address) [32B] -> AccountId; DR-01); is_allowed
│  ├─ microblog/                    # Posts/NextPostId(u64)/ByAuthor; post_message/delete_post; events
│  │                                #   + FOLDED talk-capacity (Capacity map + CheckCapacity ext; DR-24)
│  └─ anchor/                       # LastCheckpoint; anchor_ack (records relayer-confirmed finalized root)
│
├─ services/
│  ├─ cogno-follower/               # Python: reuse pycardano.cip.cip8.verify (proven v3 path); DR-02 committed
│  │                               #   payload; exact whole-Address match (DR-01); single follower key v1 (DR-07)
│  │                               #   OPTIONAL db-sync vault/thread-ownership check -> link_identity/revoke
│  └─ anchor-relayer/               # Rust/TS: subscribe GRANDPA finality -> build/sign/submit via Ogmios
│                                   #   -> anchor_ack; manages UTxO/fees/collateral/idempotency (see §9)
│
├─ cardano/                         # Cardano-side, built fresh + some vendored/referenced
│  ├─ talk-vault/                   # ONE merged talk_vault(min_lock) validator (mint+spend; DR-18):
│  │                                #   policy_id == script hash; beacon = blake2b_256(owner Address) [32B];
│  │                                #   VaultDatum { owner: Address } (DR-01); NO lock_until (DR-13);
│  │                                #   NO separate beacon policy / beacon_policy_id param / hash-cycle
│  ├─ cogno-v3/                     # symlink/submodule -> cogno_v3_contracts (thread.ak; optional thread check)
│  └─ checkpoint-validator/         # Tier-B ONLY: tiny Aiken checkpoint validator (checkpoint-validator.ak)
│
├─ app/                             # Next.js + MeshJS (CIP-30) + PAPI typed client
│  ├─ .papi/descriptors/            # generated from chain metadata (papi add -w)
│  └─ src/{wallet-connect, login, feed, post}
│
├─ indexer/                         # OPTIONAL: SubQuery (reference indexer, DR-27) -> Postgres + GraphQL feed
│                                   #   (PAPI-direct is the v1 baseline; run a public rate-limited read RPC)
│
└─ infra/
   └─ devnet/
      ├─ docker-compose.yml         # cardano-node(PREPROD; DR-31) + Ogmios + db-sync + [Postgres for indexer]
      ├─ .env.example
      └─ scripts/{run-node.sh, seed-accounts.sh, fund-relayer.sh}
```

---

## 7. How to interact

**A. Bring up the local devnet**

```bash
# 1. Build the chain (heavy first compile — see M0 for prerequisites)
cargo build --release

# 2. Run a single-node dev chain (Alice/Bob Aura authorities, Alice = sudo, WS on :9944)
./target/release/cogno-chain-node --dev

# 3. (Cardano side, for wallet gating + anchoring) bring up the stack against PREPROD (DR-31)
docker compose -f infra/devnet/docker-compose.yml up -d    # cardano-node(preprod) + Ogmios + db-sync

# 4. Generate the typed client for the frontend / services
cd app && npx papi add cogno -w ws://localhost:9944 && npx papi
```

**B. Get gated as a Cardano wallet holder (the binding)**

1. Open the dApp, connect a CIP-30 wallet (Eternl/Lace via MeshJS).
2. Sign the server-issued **committed payload** (`wallet.signData` → CIP-8 `COSE_Sign1`) — domain-separated bytes committing `{ sr25519 account + L3 genesis hash + fresh nonce }` (DR-02).
3. The **Cogno-Follower** verifies with the reused `pycardano.cip.cip8.verify` path, asserts the **recovered signing address exactly matches `datum.owner` (whole Address: payment AND stake cred, DR-01)** and that the payload sr25519 equals the submitted one, *(optional)* confirms the signer owns ≥1 live `talk_vault`/`cogno_v3` UTxO via db-sync, and submits `link_identity{ owner_address, vault_beacon, substrate_account }` (gate keyed on `blake2b_256(owner Address)`). **No valid signature → no binding → `post_message` fails with `NotAllowed`.** (For pure-Substrate demos before the Cardano side is wired, use `sudo` — the v1 escape hatch, DR-07 — to write a binding.)

**C. Post text** — three ways:
- **Wallet/frontend:** type a message, the dApp calls `tx.Microblog.post_message(...).signAndSubmit(sr25519Signer)`.
- **CLI/headless:** derive an sr25519 key from a mnemonic (`@polkadot-labs/hdkd` + `getPolkadotSigner`) and submit via PAPI, or use `subxt` from Rust.
- **polkadot.js Apps:** point `polkadot.js.org/apps` at `ws://localhost:9944`, Developer → Extrinsics → `microblog.postMessage`.

**D. Read the feed** — `query.Microblog.Posts.getEntries()` (one-shot), `watchEntries()` (live), event subscription on `PostCreated`, or the **SubQuery** GraphQL endpoint (reference indexer, DR-27; PAPI-direct is the v1 baseline) for paginated/searchable feeds. **No wallet needed to read.**

**E. See the Cardano anchor** — the UI reads `pallet-anchor`'s last `anchor_ack` and links to the Cardano tx ("anchored at tx X"); a skeptic with access to retained block data re-derives the finalized state-root and compares.

---

## 8. Phased roadmap

| Milestone | Deliverable | Done when |
|---|---|---|
| **M0 — Solochain stands up, plain text posting (NO Cardano)** | Pin the **latest stable polkadot-sdk monorepo release** (DR-03; record its exact `rust-toolchain.toml` and wasm target); install system deps; add `pallet-microblog` (`post_message`/`delete_post`, bounded text — capacity folded in per DR-24/§5, no Hold) with **no gate**; runs `--dev`. | The pinned release compiles, `--dev` produces blocks, a signed `post_message` lands, `Posts.getEntries()` returns it. Treated as its own de-risking task, not a given (see §9 first-build risk). |
| **M1 — Frontend post/read loop** | Next.js + PAPI app: hdkd/sr25519 signer, post a message, render a live feed via `watchEntries()`. | A user types text in the browser, signs with an sr25519 key, and sees it appear in the feed in real time. |
| **M2 — Wallet gate (the Cardano READ link)** | `pallet-cogno-gate` with `AllowedKeys` + `is_allowed`; `pallet-microblog` calls it; **Cogno-Follower** (Python, **single follower key** v1 + sudo escape hatch, DR-07) reuses `pycardano.cip.cip8.verify`, verifies the **committed payload** (DR-02) and the **exact whole-Address match** (DR-01), submits `link_identity` (keyed on `blake2b_256(owner Address)`). | Posting fails `NotAllowed` for an unbound account; succeeds only after a real CIP-8 signature over the committed payload binds the whole owner Address to its sr25519 key. |
| **M2b — Optional vault/thread-ownership strictness** | Follower additionally checks via db-sync that the signer owns ≥1 live `talk_vault` `VaultDatum` UTxO whose `owner` Address matches (and/or a live `cogno_v3` `thread.ak` UTxO binding the 5-byte `pointer`). | Posting requires both a valid CIP-8 signature **and** an existing vault/thread; the bound vault beacon = `blake2b_256(owner Address)` (32B) / thread pointer matches `Thread.token`. |
| **M2c — Talk capacity (feeless metered posting)** | Add the capacity logic **inside `pallet-microblog`** (DR-24 — no standalone `pallet-talk-stake`): a `Capacity` map (operator-set weight) + a `CheckCapacity` `TransactionExtension` + the lazy token bucket; **remove** the Hold deposit (DR-13); posts are feeless and gated by regenerating capacity. New identities start at **zero** capacity. See `ECONOMICS.md` §6–§7. | An over-budget account's `post_message` is rejected at the pool with `ExhaustsResources`; an account with weight posts feelessly until its bucket drains, then waits for regen. |
| **M2d — Cardano-sourced weight (the merged talk_vault Lock)** | Deploy the **single merged `talk_vault(min_lock)` validator** (mint+spend; `VaultDatum { owner: Address }`; beacon `token_name = blake2b_256(owner Address)`; DR-18/DR-01) — **NO on-chain `lock_until` / no timelock (DR-13)**; the commitment is enforced by L3 regen/clamp (talk starts at zero, accrues only while parked, clamps to zero on unlock). Follower indexes vaults, **aggregates all of an owner Address's vault UTxOs into one weight** (largest-wins/never-sum, DR-34), drives `set_stake` to the single 1:1-bound account. | Locking N ADA grants proportional talk capacity within reorg-safe confirmation depth (grant-k; DR-09b); spending the vault clamps weight to zero event-driven. Opt-in `lock_until` bonus and yield-bearing hybrid deferred. |
| **M3 — Anchor to Cardano, Tier-A (the WRITE link)** | Lands **after the core loop** (DR-20; Tier-A = evidence, not enforcement): `pallet-anchor` (`anchor_ack`) + **Anchor Relayer** driven off **GRANDPA finality**; writes the last finalized state-root as **tx metadata** via Ogmios; relayer handles UTxO/fee/idempotency (§9); UI shows "anchored at tx X". The **archive is committed** in v1 (operator runs a `--pruning archive` node + publishes genesis hash + chainspec; DR-08), so the verify step is honestly backed at launch. | Every N finalized blocks a real metadata tx appears on Cardano carrying the matching finalized root; `anchor_ack` records the txhash exactly once; verify (M4c-style re-derivation from genesis) passes against the committed archive. |
| **M4 — Indexer + richer feed** | **SubQuery** (DR-27) ingests `PostCreated`/`PostDeleted` into Postgres + GraphQL; threading via `parent` (comments/replies are **gated**, DR-14b); per-identity (owner-Address) profile views; ban/revoke handling (see §9 revocation). | Paginated, searchable, by-identity feed served from GraphQL; an operator `revoke`/ban removes posting rights. |
| **M5 — Benchmarking, Tier-B hardening + decentralization story** | Run FRAME benchmarks and replace `dev_mode` weights with real `WeightInfo`; optional Aiken `checkpoint-validator.ak` (singleton checkpoint UTxO, operator/k-of-t-gated, append-only root log); document the Ariadne SPO-committee graduation path (Approach B). | Pallets carry benchmarked weights; anchors spend+recreate the checkpoint UTxO with the new finalized root in its datum; a written design doc maps the pallets onto an SPO-selected committee with no app-pallet changes. |

> M0 is **not free**: the standalone mirror's tags (latest `v0.0.2`, Aug 2024) lag the monorepo and use the older `construct_runtime!` macro instead of `#[frame_support::runtime]`, the wasm target is mid-migration (`wasm32-unknown-unknown` → `wasm32v1-none`), and a first `cargo build --release` of a Substrate node is a heavy, dependency-heavy compile that commonly fails on missing `clang`/`protobuf-compiler`/`cmake`/`libssl-dev`/`make`. Per **DR-03, pin the latest stable polkadot-sdk monorepo release** (not the lagging standalone mirror), record its exact toolchain + wasm target, and pre-install those deps before treating M0 as done.

---

## 9. Honest risks, tradeoffs & operational gaps

- **Is this over-engineered vs a Cardano-native dApp?** Often, yes — and you should say so. `cogno_v3` already proves the forum/thread pattern fully on Cardano. The **only legitimate reason for a separate chain is performance**: storing post text in Cardano UTxO datums hits tx-size caps, growing per-comment validation cost, and min-ADA-per-byte scaling. If posting volume is low (forum-style), a native Aiken dApp is the better engineering choice and this whole stack is unjustified. The separate chain earns its keep **only** under sustained high write volume.
- **Solochain security is weak — be blunt.** A few operator-run Aura authorities is effectively a **permissioned/centralized service**. Aura is round-robin PoA with a known single-node "cloning attack" (arXiv 1902.10244); GRANDPA breaks above 1/3 Byzantine and can stall if validators go offline. This is a genuine security **downgrade** versus a Cardano-native dApp, and the solochain **does not inherit Cardano's finality or stake security**.
- **Anchoring is evidence, not enforcement — and only as good as data availability.** Tier-A metadata is logging, not a bridge — Cardano cannot reject a wrong root or roll back the chain. Tier-B proves *who* posted a root, not that the root is *honest*. Anchoring lets observers **detect** a silent rewrite after the fact; it cannot **prevent** a bad block or a fork. Crucially, the anchor is only **checkable** if a skeptic has independent access to the solochain's block/state history at the anchored block. If the sole operator prunes or withholds history, the anchor points at a root with nothing to compare it against. **Mitigation: run an independent archive node, retain indexer snapshots per checkpoint, or publish per-checkpoint state so a third party can actually verify.** Without this, "anyone can verify" is unbacked.
- **The gate is centralized at the binding step.** `pallet-cogno-gate::AllowedKeys` is written by the operator's follower key. Users trust the operator to verify CIP-8 proofs honestly. On-chain `ed25519_verify` of a reconstructed CIP-8 `Sig_structure` is *possible* but heavy and deliberately avoided for speed — so the bridge is the trusted oracle and a primary attack surface.
- **Key management is unsolved here and must be specified before any real deployment.** Two operator keys are the crown jewels: the follower's `link_identity` authority key (can grant posting rights) and the relayer's Cardano signing key (can spend the relayer wallet and post anchors). For the showcase, a single dev key per service is acceptable **if labelled as such**. For anything beyond: put the `link_identity` authority behind a runtime multisig/threshold collective (e.g. `pallet-collective` or a k-of-t signer set), keep the Cardano signing key in a separate funded hot wallet with a native-script/multisig spend policy, define a rotation procedure, and keep a public audit log of every binding/revocation. "Mitigate with multisig" is only credible once the threshold, signer set, and rotation are written down.
- **Relayer Cardano-tx lifecycle is the bulk of the real work — budget it.** Posting anchors via Ogmios requires: UTxO selection and management for the relayer wallet, fee and min-ADA handling, **collateral** for Tier-B Plutus spends, avoiding UTxO contention between consecutive checkpoints (chain the relayer's own outputs or serialize submissions), handling **Cardano rollbacks** (re-submit if an anchor tx is rolled back), and **idempotency** so a retried submission doesn't cause `anchor_ack` to be double-counted (key `anchor_ack` by `block_number` and make it a no-op if already recorded). None of this is incidental; it is most of the relayer.
- **The two off-chain services are single points of failure, and failures are silent.** If the relayer dies, anchoring silently stops and tamper-evidence gaps open; if the follower dies, onboarding stops (existing posters are unaffected). For a demo this is acceptable. To *claim* tamper-evidence it is not: add health checks, alerting on missed checkpoints (expected-vs-actual `anchor_ack` cadence), and a backfill path that anchors any finalized blocks that were skipped while the relayer was down.
- **Revocation is weak by construction — be honest about what the credential is.** The credential is a Cardano wallet (the whole owner Address, DR-01) — and, with M2b, the existence of a `talk_vault`/thread at binding time. **v1 = wallet-only CIP-8 gate + manual operator ban (DR-14)**: a wallet key does not "burn" or "move," so there is **no on-chain event to watch that automatically revokes** wallet-only bindings; they effectively never revoke unless the operator bans the owner Address. Under the strict path the watchable on-chain change is the user spending their UTxO: the **merged `talk_vault` burns its beacon NFT** (`token_name = blake2b_256(owner Address)`) on unlock — and likewise `cogno_v3`'s `RemoveThread` burns the pointer token — so the follower can poll past reorg depth and call `revoke`/clamp weight to zero. Define the policy explicitly: (a) wallet-only gate → manual operator ban only (v1 default); (b) vault/thread-gated → poll the vault/thread UTxOs at a stated cadence and revoke on disappearance. (Unlike old-v3 prose, there now **is** a beacon-burn trigger because the merged talk_vault mints/burns a per-Address beacon NFT, DR-18.)
- **Operational burden, even on the light path.** The operator still runs `cardano-node` + db-sync + Ogmios. Initial `cardano-node` sync is multi-day on mainnet (use **preprod** for the devnet, DR-31). Approach B would impose `cardano-node + db-sync + Postgres` (~24GB RAM, 700GB+ high-IOPS SSD) on **every** block producer — the reason we are not recommending it for the showcase.
- **No composability with Cardano dApps.** Posts live on a separate chain; other Cardano contracts can't read them via reference inputs the way they can a native `cogno_v3` thread. You trade L1 permanence/composability for throughput — and, per the anchoring caveat, **if the operators vanish and no archive was kept, both the feed and the verifiability of its anchors are gone.**
- **Metadata-coupled clients.** Every runtime change (new pallet/call) requires bumping `spec_version` and regenerating PAPI/subxt descriptors, or calls fail to encode.

---

## 10. Open questions for the user

> **RESOLVED in docs/DECISION-REGISTER.md (2026-06-16) — see that doc.** The questions below are kept for the rationale they record, but each is now decided: Q1 (answered — Cogno died from per-post L1 fees); Q2 permanence/`u64` ids (DR-21) + posts stay feeless under capacity, no held deposit (DR-13); Q3 gate strictness = wallet-only CIP-8 committed-payload gate v1, vault/thread check optional (DR-14/DR-02), on-chain `ed25519_verify` deferred (D1); Q4 anchor = Tier-A at M3, Tier-B at M5, archive committed (DR-20/DR-08); Q5 decentralization = 1-3 honest permissioned operator nodes v1, self-build/vendor-fork not the archived partner-chains repo (DR-26); Q6 revocation = wallet-only manual operator ban v1 (DR-14); Q7 key custody = single follower key + sudo + audit log v1, 3-of-5 committee gated to D2 (DR-07); Q8 indexer = SubQuery, PAPI-direct baseline (DR-27); Q9 commenting = **gated** (DR-14b).
>
> Economic-model questions (regen window, anti-whale curve, lock vs yield-bearing hybrid, unstake cooldown, reward distribution) now live in [`ECONOMICS.md`](ECONOMICS.md) §10. Question #1 below is **answered**: the owner confirms Cogno died from per-post L1 fees, so sustained high-volume social posting is exactly the case the separate feeless chain exists to serve.

1. **Throughput reality:** what post/comment volume do you actually expect? If forum-scale, does a separate chain earn its keep, or should this stay a `cogno_v3` extension?
2. **Permanence model:** posts permanent (deposit held indefinitely) or pruneable/deletable to reclaim deposits? Full text on-chain, or hash/CID with body on IPFS?
3. **Gate strictness:** wallet-only (CIP-8 signature, recommended for the demo) or also require an existing `cogno_v3` thread (M2b)? Per-post on-chain `ed25519_verify` is expensive — worth it?
4. **Anchor enforcement:** is Tier-A metadata enough for the showcase, or do you want Tier-B's auditable on-Cardano root log from the start? And what archival commitment (archive node / published checkpoints) backs the "anyone can verify" claim?
5. **Decentralization endgame:** is 1–3 operator nodes acceptable at launch (honest "permissioned service"), or is graduating to an Ariadne SPO committee a hard requirement — and on which stack (archived `partner-chains` fork vs tracking Midnight's crates)?
6. **Revocation policy:** is manual operator ban acceptable (wallet-only gate), or do you need thread-disappearance-driven revocation (M2b) — and at what polling cadence and reorg depth?
7. **Key custody:** where do the follower authority key and relayer Cardano key live, who controls them, and what multisig/threshold + rotation policy do you want from day one?
8. **Indexer hosting:** self-host SQD/SubQuery (Postgres + GraphQL) or a managed service, given SQD's Oct-2025 acquisition? Affects ops cost and decentralization claims.
9. **Commenting:** in `cogno_v3` commenting is permissionless by design — should comments on cogno-chain also be gated, or open?

---

## 11. First step

Begin **M0** — stand up the solochain template and confirm it builds. Pin the **latest stable polkadot-sdk monorepo release** (DR-03; not the lagging standalone mirror), and install the system prerequisites first:

```bash
# Prereqs (Debian/Ubuntu): the most common first-build failures
sudo apt-get update && sudo apt-get install -y \
  clang protobuf-compiler cmake libssl-dev pkg-config make build-essential

# Clone the monorepo and check out the LATEST STABLE release tag (DR-03; record the exact tag/hash):
git clone https://github.com/paritytech/polkadot-sdk.git \
  /home/logic/Documents/LogicalMechanism/cogno-chain/_sdk && \
  cd /home/logic/Documents/LogicalMechanism/cogno-chain/_sdk && \
  git checkout <LATEST_STABLE_RELEASE_TAG> && \
  # Read the ACTUAL toolchain + wasm target this commit expects before building:
  cat rust-toolchain.toml && \
  cd templates/solochain && \
  cargo build --release && \
  ./target/release/solochain-template-node --dev
```

This gives a running dev chain on `ws://localhost:9944` (Alice/Bob Aura authorities, Alice as sudo) to build `pallet-microblog` against. **Confirm the exact `rust-toolchain.toml` and wasm target from the pinned commit** — newer SDK uses `#[frame_support::runtime]` and is migrating the wasm target from `wasm32-unknown-unknown` toward `wasm32v1-none`, so do not copy build flags from the older `v0.0.2` mirror. Treat "template compiles and `--dev` produces blocks" as a real de-risking task, not a given.
