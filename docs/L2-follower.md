# cogno-chain L2 — The Follower / Bridge

> Deep-dive design for the cogno-chain **L2**: the follower/bridge that sits
> between **Cardano (L1)** and the **Substrate solochain (L3)**. It OBSERVES vault
> UTxOs, runs the **deterministic** `vaults → weight` function, VERIFIES a CIP-8
> controller proof, and WRITES weight + identity into L3. Written to be picked up
> cold and implemented from scratch. Companion to `docs/L1-cardano.md` (the vault)
> and `PLAN.md` / `ECONOMICS.md` (the L3 runtime).
>
> **The owner's explicit goal is MAXIMUM decentralization (a hyperstructure).** This
> doc honors that goal *and* the honest constraint that bounds it: **the follower
> can only be as trust-minimized as L3's consensus.** While L3 runs single-operator
> Aura/GRANDPA, the operator can already write any weight directly, so a fully
> trustless L2 is *partly moot* today. The recommendation is therefore a v1 that
> **ships honestly** (a labelled trusted oracle, with every input/output publicly
> re-derivable) on a **glide path** that becomes genuinely trustless the moment L3
> graduates to an SPO committee — throwing nothing away.

> **Updated 2026-06 for the L1 beacon model:** observation is now **largest-wins per owner ADDRESS (identity)** (select the single largest beacon UTxO, **never sum**), indexed by the **single `talk_vault` validator's policy id** (policy_id == vault script hash; the merged mint+spend validator). See `docs/L1-cardano.md` §10 / §10.7.

> **RECONCILED to DECISION-REGISTER.md (2026-06-16).** The decisions below OVERRIDE
> any conflicting text later in this doc; treat this block as the authoritative
> correction readers see first.
>
> - **Identity = the WHOLE owner Address, not `owner_pkh` (DR-01).** The L1 vault datum
>   is `VaultDatum { owner: Address }` — a full CIP-19 address (payment credential +
>   stake credential), with the payment credential restricted to `VerificationKey` in
>   v1. Everywhere this doc says "group by / bind / key on `owner_pkh`" it now means
>   **the serialized owner `Address`**. Supersedes the per-`owner_pkh` framing in §1,
>   §2, §6.1, §6.3, §6.4, §10.2, the §2.2 data-flow diagram, and §8.1.
> - **Beacon `token_name` = `blake2b_256(serialized owner Address)` = 32 bytes (DR-01,
>   DR-18).** NOT `blake2b_256(owner_pkh)` and NOT a 28-byte / `len()==28` key. The
>   integrity check is `util.beacon_name(address) == observed token_name`. Supersedes
>   §6.3, §6.4, §12 step 1/3.
> - **ONE merged validator, not two (DR-18).** There is a SINGLE validator
>   `talk_vault(min_lock)` carrying BOTH a mint handler and a spend handler (the
>   `cogno_v3` `thread.ak` shape): **policy_id == vault script hash**, and the mint arm
>   asserts the beacon lands at the script's OWN address (an on-chain "beacon ⇒ canonical
>   vault" guarantee). This DELETES the separate beacon minting policy, the
>   `beacon_policy_id` parameter, and the **entire hash-cycle concern (old L1 §4.5)**.
>   Index Kupo by **the `talk_vault` policy id** (== script hash). Supersedes the
>   "beacon POLICY id" / separate-policy wording throughout §2, §5, §6.1, §9, §12, and
>   App. A.
> - **CIP-8 = committed payload; bind-hijack is PREVENTED, not just detected (DR-02).**
>   The user signs domain-separated bytes committing { sr25519 account + L3 genesis
>   hash + fresh nonce }. The follower verifies: signature valid + **recovered signing
>   address == reconstructed `datum.owner` (EXACT whole-address match: payment AND stake
>   cred)** + the payload's sr25519 == the submitted sr25519. Supersedes §7.1, §7.3.
> - **The §7.4 binding-key gotcha is STRUCTURALLY CLOSED (DR-01, DR-02).** It is no
>   longer a "BLOCKING, do-not-ship" open question. Because `owner` is a whole Address,
>   the follower asserts the recovered signing address == `datum.owner` exactly; the
>   credential-kind question (open question #2) is **RESOLVED** (owner is an Address, not
>   a bare key-hash). Supersedes §7.4, §11 Q2, §12 step 5.
> - **Vault address stake-cred consistency (DR-01).** Enforce
>   `vault_address.stake_cred == datum.owner.stake_cred` on create and every
>   continuation, so the locked ADA provably delegates with the identity's stake key.
>   This re-tightens the old payment-cred-only relaxation (cf. §11 Q8).
> - **v1 = clamp-only decay, NO on-chain timelock / NO `lock_until` (DR-13).** The
>   commitment is enforced by L3 regen/clamp (talk starts at zero, accrues only while
>   parked, clamps to zero on unlock). There is no on-chain cooldown in `talk_vault`.
> - **Reorg burial (DR-09b):** pragmatic grant-*k* (a few hundred slots / minutes) + a
>   **SHORTER clamp-*k*** so clamps land faster than grants. Supersedes the "same *k*?"
>   framing in §6.2 / §11 Q3.
> - **Key management (DR-07):** v1 = a SINGLE follower key + a sudo escape hatch + the D0
>   audit log; the **3-of-5 k-of-t committee + rotation + on-chain committee-key update**
>   is the **D2 gate** (before any mainnet / real value). `FollowerOrigin` stays an
>   `EnsureOrigin`. Refines §8.4 / §8.5 / §11 Q4.
> - **Tooling / network (DR-26, DR-27, DR-31, DR-33):** devnet = **PREPROD** (light
>   Kupo/Ogmios, not db-sync); 1-3 honest permissioned operator nodes in v1; reference
>   indexer = SubQuery (PAPI-direct is the v1 baseline); default posting-power read =
>   L3 `AllowedStake` (Kupo optional cross-check, **no Blockfrost**); self-build / vendor
>   fork the follower (NOT the archived partner-chains repo).
> - **Stale-banner correction (DR-34):** the old L1 §0/§3 banner calling this doc
>   "group-and-sum / a LIVE double-dip" is FALSE — this doc is, and always was on disk,
>   **largest-wins / never-sum**. That framing is removed.
> - Other relevant decisions: u64 NextPostId (DR-21), MaxLength=512 /
>   MaxPostsPerAuthor=10_000 (DR-10b), comments/replies are gated (DR-14b), capacity
>   logic folded into `pallet-microblog` (DR-24), reward distribution deferred to M5
>   (DR-29), Mithril deferred to D4 (DR-25). Open question #2 is RESOLVED; see §11.

---

## 1. TL;DR

- **L2 is the bridge between L1 and L3.** It observes Cardano vault UTxOs, turns
  them into per-identity weight via a **pure function**, proves identity via CIP-8,
  and writes `set_stake` / `link_identity` into the L3 runtime.
- **The whole trust argument rests on DETERMINISM — and v1 MUST make it
  exercisable.** Observation is *objective Cardano state* + a *pure
  **group-by-owner-Address + largest-wins** function* — select the single largest
  beacon UTxO per owner **Address** (identity), **never sum** (`L1-cardano.md` §10.2;
  identity = the whole owner `Address`, DR-01). Each canonical-vault
  UTxO carries ADA + 1 beacon NFT; a beacon **burn (`mint −1`) is an equivalent
  leave signal** alongside `spent_at`. But "anyone can recompute" is an
  empty claim unless the substrate to recompute *against* ships. So **D0 is a v1
  deliverable, not a later one**: publish the versioned largest-wins pure-function
  spec, the `talk_vault` policy id (== vault script hash, DR-18), the tiebreak rule,
  depth *k*, and the as-of cursor rule;
  emit a per-write audit event
  `{owner_address, weight, cursor_slot}`; and ship a standalone recomputer that reads L1 +
  the spec and **proves divergence** from the on-chain weight set. Without that
  published+recomputable substrate, "determinism ⇒ auditable" is asserted, not real.
  Fraud is then **detectable/provable** by any third party (not yet on-chain-punishable).
- **The hard ceiling: L2 ≤ L3 consensus.** Under single-operator Aura/GRANDPA the
  operator already authors every block and can write any weight via the privileged
  path. So an elaborate fraud-proof / Mithril L2 **buys little NOW** — its payoff is
  **coupled to L3 graduating to an SPO/Ariadne committee.** Do not overclaim.
- **RECOMMENDED v1 = the Single Follower (Approach A).** One operator-run service
  (cardano-node + Kupo + Ogmios) runs the observation and the CIP-8 verify
  off-chain, and writes via **one `FollowerOrigin`-gated extrinsic**. This is a
  **trusted oracle** and a single point of failure — and that is *honest*, because
  under single-operator L3 it adds **no new trust** beyond "trust the operator."
- **Name exactly what you trust in v1.** A single party — the follower operator,
  holding **one privileged signing key** — is trusted to: **(i)** verify the CIP-8
  proof honestly (no on-chain re-check); **(ii)** observe **every** vault UTxO across
  **every** set-address (omission is invisible on-chain); **(iii)** run the pure
  aggregation correctly and bury past depth *k*; **(iv)** report weight + bindings
  truthfully **and promptly** (slow ⇒ stale voice). The L3 runtime does **zero**
  re-derivation of Cardano state. Any external-facing material MUST call v1 a
  **trusted oracle / single point of failure**, never "decentralized" or "trustless"
  — the README/marketing inherits the §10 *auditable ≠ trustless* discipline.
- **Cardano data enters L3 as a GATED EXTRINSIC, never an offchain-worker.** OCW
  HTTP reads are the explicit anti-pattern (non-deterministic, per-node, bypass
  transaction verification — `PLAN.md` line 118). Inherents and light-client/Mithril
  proofs are the trust-minimized targets, deferred until L3 has multiple producers.
- **Identity stays an OFF-CHAIN CIP-8 proof** carried by a gated/signed extrinsic —
  it is *not* deterministic-observation data and there is no productionized
  in-runtime COSE_Sign1 verifier. v1 reuses the proven `pycardano.cip.cip8.verify`
  path from `cogno_v3`.
- **Reorg-safety is non-negotiable and trust-model-independent.** Bury **both**
  `created_at` and `spent_at` past depth *k*; never cache "spent" as permanent (Kupo
  flips it back on rollback); clamp capacity to **zero** on observed unlock
  (`L1-cardano.md` §10.3–10.4). A short reorg can neither grant un-earned voice nor
  strand it.
- **Failure is silent and ASYMMETRIC — so the clamp path is a REQUIRED priority.** A
  dead follower is **safe-but-stale** for new grants (no weight until catch-up) but
  **UNSAFE-stale** for unlocks (an unlocked user keeps voice until the clamp lands).
  v1 MUST therefore make the **unlock→0 clamp path demonstrably faster and more
  reliable than the grant path** (separate, higher-priority work queue; backfill the
  clamp set first on restart) **and** alert on stalled observation cadence. Without
  prioritized clamping + backfill-on-restart, a follower outage leaves reclaimed users
  with live voice. Redundant followers come later (D2).
- **The identity bind is now structurally pinned (DR-01, DR-02):** the CIP-8 proof
  asserts the **recovered signing address == the reconstructed `datum.owner`** (a full
  CIP-19 Address — payment AND stake credential — matched exactly). Because identity is
  the whole Address (not a bare key-hash), the old "wrong-key / wrong-address" binding
  gotcha is **structurally closed**, not an open release gate; see §7.4. The payload is
  **committed** (sr25519 + L3 genesis hash + nonce), so bind-hijack is PREVENTED in v1.
- **Four approaches, one glide path:** Single (v1) → Committee (k-of-t) →
  Optimistic / Permissionless → Mithril/light-client inherent. Each rung is
  **throw-nothing-away**; the app pallets (`pallet-microblog`, `pallet-cogno-gate`,
  `pallet-talk-stake`) are **unchanged** across the whole path.
- **Key management is load-bearing and unsolved in v1.** The follower's
  `link_identity` / `set_stake` authority key is a crown jewel — compromise of that
  one key = full identity-forgery + arbitrary-weight capability. A single dev key is
  acceptable **only if labelled as such**. Before **any non-dev deployment** the
  policy MUST be written down: the **k-of-t threshold (e.g. N=5, M=3), the signer
  set, the rotation procedure, and the public audit log** of every
  binding/revocation. "Mitigate with multisig" is not credible until those four are
  specified. `FollowerOrigin` is an `EnsureOrigin`, so it widens to k-of-t **without**
  touching call signatures.
- **Recommendation in one line:** *ship the Single Follower behind a `FollowerOrigin`
  EnsureOrigin and a deterministic, publicly-recomputable observation, label it a
  trusted oracle, and design every hook (committee origin, inherent, Mithril) so the
  graduation tracks L3's consensus and discards nothing.*

---

## 2. What L2 does

### 2.1 The seven responsibilities

1. **OBSERVE** all beacon-bearing vault UTxOs, reorg-safe (Kupo/Ogmios), indexed by
   the **`talk_vault` policy id** (== vault script hash, DR-18; one `--match`;
   optionally per-asset by `token_name`); one merged validator / one contract in v1
   (`L1-cardano.md` §10.1).
2. **READ** parked `lovelace` + the inline datum's `owner` **Address** per UTxO
   (`VaultDatum { owner: Address }`, DR-01; `L1-cardano.md` §10.2).
3. **SELECT the largest beacon UTxO per owner Address** — group a user's beacon UTxOs
   by the whole `owner` **Address** and take the single one with **MAX `lovelace`**
   (tiebreak by output reference) as its **ONE weight**; **NEVER sum** across a user's
   UTxOs (summing is a stake-splitting double-dip).
4. **IDENTITY** — verify a CIP-8 (COSE_Sign1) **committed-payload** proof that the
   signer controls the `owner` **Address** (recovered signing address == `datum.owner`,
   DR-02), and bind it **1:1** to a Substrate **sr25519** account (reuse the proven
   `pycardano.cip.cip8.verify` path from `cogno_v3`).
5. **WRITE** weight + identity binding to L3 (`set_stake` / `link_identity`),
   **going-forward only** (monotonic-forward; no retroactive grants).
6. **CLAMP ON UNLOCK** — on an observed vault spend buried past reorg depth, set
   weight → 0 and clamp L3 capacity to zero for that `owner` Address.
7. **DELEGATION READ (deferred)** — best-effort read of an identity's current pool
   delegation for a **deferred Cogno-pool bonus** (`L1-cardano.md` §10.5);
   out-of-band, never on-chain, never weight-bearing in v1.

### 2.2 L1 → L2 → L3 data flow

```
  L1: CARDANO (objective state)            L2: FOLLOWER / BRIDGE                  L3: SUBSTRATE SOLOCHAIN
  ════════════════════════════             ════════════════════                  ═══════════════════════

  vault UTxO (beacon-bearing)                                                    pallet-cogno-gate
  ┌───────────────────────────┐  observe   ┌──────────────────────────┐         ┌──────────────────────┐
  │ value: ADA (>=floor)+1 bcn │ ────────▶ │ Kupo (1 --match, by       │         │ 1:1 owner Addr<->Acct│
  │ datum:{ owner: Address }   │  (Kupo)    │  talk_vault policy id)   │         │ binding map          │
  └───────────────────────────┘            └────────────┬─────────────┘         └──────────┬───────────┘
        (one identity may have                           │ read lovelace+datum             │ is_allowed?
         MANY same-name beacons)                         ▼                                 │
                                            ┌──────────────────────────┐                   │
  ┌───────────────────────────┐  RollBwd    │ REORG-SAFE BURIAL        │                   ▼
  │ created_at {slot,hash}     │ ──────────▶│ bury created_at & spent_at│        pallet-talk-stake / -capacity
  │ spent_at {slot,hash}|null  │  (flip)    │ (or beacon BURN, mint -1) │        ┌──────────────────────┐
  │ + beacon BURN (mint -1)    │            │ past depth k; never cache │        │ AllowedStake:        │
  └───────────────────────────┘            │ "spent" as permanent     │  WRITE  │ AllowedStake:        │
                                            └────────────┬─────────────┘  set_   │  owner Addr -> weight│
                                                         ▼               stake   │ token bucket sizes   │
                                            ┌──────────────────────────┐ ───────▶│  cap = weight*RATIO  │
                                            │ PURE FUNCTION (§10.2)    │ (gated  │  regen/block         │
                                            │ group by owner Address ->│  extr.) └──────────┬───────────┘
                                            │ LARGEST beacon UTxO ->   │                    │ reads weight
                                            │ 1 weight (NEVER sum)     │                    │
                                            └────────────┬─────────────┘                    ▼
                                                         │                        CheckCapacity TxExtension
   CIP-30 wallet                                         │                        ┌──────────────────────┐
  ┌───────────────────────────┐  COSE_Sign1 ┌──────────────────────────┐ link_   │ feeless post admitted│
  │ user signs COMMITTED       │ ──────────▶│ CIP-8 VERIFY (off-chain) │ identity│ iff bucket has room  │
  │ payload (sr25519+gen+nonce)│            │ pycardano.cip.cip8.verify│ ───────▶│ (M2c/M2d)            │
  └───────────────────────────┘            │ addr==datum.owner; bind sr│ (gated) └──────────────────────┘
                                            └──────────────────────────┘

  UNLOCK PATH (clamp):  vault spent / beacon BURN (mint -1) ──▶ Kupo spent_at | tx mint -1 ──▶ bury past k ──▶ set_stake{addr, 0} ──▶ capacity = 0
       (on rollback, spent_at flips back to null ──▶ follower recomputes ──▶ re-grants)

  ────────────────────────────────────────────────────────────────────────────────────────────────────────
  IDENTITY  enters as a GATED/SIGNED EXTRINSIC carrying an OFF-CHAIN CIP-8 proof  (never an inherent).
  WEIGHT    enters as a GATED EXTRINSIC (v1) ── on the glide path ── an INHERENT re-checked by every producer.
  Both WRITES' ordering/censorship are decided by L3 block production = the trust ceiling (§3).
```

The two halves are **independent**: identity (CIP-8, one-time onboarding) and weight
(continuous observation) bind to the same owner **Address** but flow through separate
code paths and separate extrinsics. The 1:1 owner-`Address` ↔ `AccountId` binding is the
**Sybil anchor** (`ECONOMICS.md` §8, `PLAN.md` §5).

---

## 3. The central tension

**A single follower is a trusted oracle — it is the least-hyperstructure part of the
whole system, and it is unilateral in v1.** Be brutally blunt about exactly what is
trusted. In v1 you trust **one party** — the follower operator, holding **one
privileged `FollowerOrigin` signing key** — to:

- **(a) verify the CIP-8 proof honestly** — the runtime does no on-chain re-check, so
  the operator could bind any owner `Address` to any sr25519 account (Sybil forgery);
- **(b) observe the full vault set faithfully across ALL set-addresses** — an *omitted*
  vault is invisible on-chain (nothing proves completeness), so the operator could
  silently deny voice;
- **(c) run the pure aggregation correctly and bury past reorg depth *k*** — the
  operator could set arbitrary weight / arbitrary capacity grants;
- **(d) report weight + bindings truthfully AND promptly** — a slow operator strands
  unlock-clamps (the asymmetric-failure window, §8.2/§10).

The L3 runtime does **zero** independent re-derivation of Cardano state — it trusts the
gated origin. A malicious or compromised follower can forge identities and grant
arbitrary weight via the single `FollowerOrigin`-gated extrinsic. **Crucially, this
oracle adds NO new trust under single-operator L3**: the same operator authors every
block and can already write any weight directly (§3.2), so "trust the follower"
collapses into "trust the operator." That is the *only* reason v1 is acceptable — and it
expires the instant L3 decentralizes, which is why D1 (on-chain CIP-8 self-proof) and
D2 (k-of-t) are sequenced to follow.

### 3.1 The two levers

1. **Deterministic observation — operationalized, not asserted.** The observation is
   *objective Cardano state* + a *pure **group-by-owner-Address + largest-wins**
   function* — select the single largest beacon UTxO per owner `Address`, **never sum**
   (`L1-cardano.md` §10.2). That converts
   the oracle problem from "trust an attestation" into "verify a computation": a dispute
   has **exactly one provably-correct resolution** (re-run §10 against L1). This lever is
   only *real* if v1 actually ships the means to re-run it — so the determinism is
   **operationalized by D0** (§9, §12 step 7): a **published versioned spec** (largest-wins
   pure-function body + the `talk_vault` policy id (== vault script hash) + tiebreak rule
   + depth *k* + as-of cursor rule),
   a **per-write audit event** `{owner_address, weight, cursor_slot}`, and a **standalone
   recomputer** that reads
   L1 + the spec and emits a divergence proof. With those, **any third party can recompute**
   the expected `{owner_address → weight}` map and **prove** divergence. Determinism buys
   **auditability now** and is the foundation every later rung (optimistic challenge,
   inherent re-verification) builds on.
2. **IOG tooling exists.** You are not inventing primitives. **Mithril** gives
   stake-threshold certificates of Cardano state (so the *input* can later be
   Cardano-stake-certified rather than indexer-trusted). **Partner-chains** is the
   productionized "main-chain follower" pattern — observe a stable Cardano state,
   ingest it as an **inherent** carrying a pinned main-chain reference (`mcsh`),
   re-verify on import. These are the templates for the trust-minimized rungs.

### 3.2 The one constraint

**The follower can be no more trust-minimized than L3 consensus, and v1 L3 is the
binding constraint.** Under single-operator Aura/GRANDPA:

- The operator **already** authors every block and can write any weight directly via
  the privileged `set_stake` path (or `sudo`). So "trust the follower" **collapses
  into** "trust the operator" — they are the same party. Adding a fraud-proof or
  Mithril layer **adds essentially no new trust reduction** while it remains the only
  checker.
- Two trust points couple specifically to L3: **(a) write ordering / censorship** —
  the one block author decides if/when `link_identity` and `set_stake` land and could
  censor or reorder; **(b) observation correctness** — "all validators re-verify"
  degenerates to "asserted by the one operator," because there is one follower and one
  author.

**Honest framing:** the trustless target (*no-one-MUST-be-trusted*) is **deferred and
coupled** to L3 graduating from single-operator to an SPO/Ariadne-selected committee.
Until then, the realizable and genuinely valuable target is **auditability /
transparency** (*anyone CAN recompute and prove fraud*) — not trustlessness. Build the
hooks now; defer the machinery; gate it on the L3 milestone. **Determinism (anyone
CAN) is achieved at v1; trustlessness (no-one MUST) is not, and saying otherwise is
overclaiming.** This discipline is **binding on external-facing material**: the
project README and any marketing inherit the §10 *auditable ≠ trustless* rule and
label v1 a trusted oracle / single point of failure — they do **not** inherit the
hyperstructure aspiration as a present-tense claim.

---

## 4. Trust spectrum: four approaches

The four approaches differ only in **how the bridge INPUT is trusted** and **how the
write ENTERS L3**. They all reuse the same `L1-cardano.md` §10 observation, the same
CIP-8 verify, the same reorg burial, and the same app pallets — so moving between them
is throw-nothing-away.

| | **A. Single Follower (v1)** | **B. Threshold Committee** | **C. Optimistic / Permissionless** | **D. Mithril / light-client inherent** |
|---|---|---|---|---|
| **Trust assumption** | One trusted oracle (one operator key) | Honest M-of-N for safety; 1-honest-quorum for liveness (Wormhole/Hyperlane-multisig model) | 1-of-N honest, awake challenger + an objective dispute resolver (UMA / optimistic-ISM) | Honest-majority of Cardano **stake** (Mithril STM) + honest-majority of L3 producers re-deriving |
| **Decentralization** | Lowest — single point of forgery | Medium — no single forger; needs M-of-N collusion to lie | High in *design*; permissionless on both sides (anyone relays, anyone challenges) | Highest — input is Cardano-stake-certified; "trust Cardano itself" |
| **Liveness** | SPOF; silent asymmetric failure | Tolerates N−M outages; new failure = committee coordination/cursor skew | Needs ≥1 honest relayer (liveness) **and** ≥1 awake challenger per window (safety) | Each producer needs a synced indexer **+** reachable Mithril aggregator; lag → block rejection |
| **How weight enters L3** | Gated extrinsic (`FollowerOrigin = EnsureSignedBy<oneKey>`) | Gated extrinsic, `FollowerOrigin = EnsureProportionAtLeast<M,N>` (or in-pallet threshold-sig) | Optimistic gate: bonded `submit_weight_batch` → challenge window → `finalize_weight_batch` | **Inherent** (`ProvideInherent` + `check_inherent`) carrying a Mithril-certified, pure-function-derived delta |
| **Effort** | **Low** | Medium | High | Very high |
| **Coupling to L3** | Tight; trust = the L3 operator regardless | Tight; trust = `min(M-of-N, L3 operator)` = the operator today | Tight; operator can censor disputes / bypass the queue today | Tight; inherent re-verification is load-bearing **only** with multiple producers |

In all four, **identity** stays an off-chain CIP-8 proof (B/A attest it; C/D can
upgrade it to an **on-chain `ed25519_verify` self-proof** that removes the operator
from identity-correctness entirely — see §7). And in all four, the **end-to-end trust
today** equals the L3 operator, because that operator can censor/reorder the write or
bypass the path. The differences only become load-bearing once L3 has an independent
committee.

### 4.1 Recommendation

**Ship Approach A (Single Follower) for v1, structured to graduate.** Concretely:

- **v1 that ships honestly:** one operator-run follower (cardano-node + Kupo +
  Ogmios) running the §10 observation and the reused `pycardano.cip.cip8.verify`,
  writing via **one `FollowerOrigin`-gated `set_stake` / `link_identity` extrinsic**.
  Label it, plainly, a **trusted oracle and a single point of failure** — and note
  that this is *no less trustless than v1's single-operator L3 already is.* Matches
  `PLAN.md` M2 / M2c / M2d exactly; needs no design change to the app pallets.
- **Two cheap, high-leverage things you do even in v1** (these are the honest
  decentralization down-payment): **(1)** make the observation **publicly
  re-derivable** — publish the versioned largest-wins pure-function spec, the
  `talk_vault` policy id (== vault script hash), the tiebreak rule, the depth *k*, the
  "as-of" cursor rule, and emit a per-write audit event
  `{owner_address, weight, cursor_slot}` so any third party can recompute from L1 and
  detect divergence; **(2)** structure `FollowerOrigin` as an `EnsureOrigin` impl so
  it can widen from one key to k-of-t **without touching call signatures**.
- **A concrete graduation path to trust-minimized** (§9): A → harden `FollowerOrigin`
  to a **k-of-t collective** (Approach B); then, *gated on L3 → multi-producer SPO
  committee*, migrate the deterministic observation to an **inherent** re-checked by
  every node (Approach C/D), optionally with **Mithril-certified input** and an
  **optimistic challenge window**.

**Pragmatism that doesn't overclaim:** building the optimistic/Mithril/inherent
machinery *now* "buys little" because L3 is the ceiling — so it is **designed-in but
deferred**, sequenced *after* the L3 → SPO-committee milestone. The one trust reduction
worth doing early regardless of L3 is the **on-chain CIP-8 self-proof** for identity
(§7), because it is checkable in a single block by every node and is **not** gated on
L3 decentralization — but ship it **only behind an audit** of its `no_std` COSE/CBOR
verifier, which is the single piece of novel, Wormhole-class crypto in the system (§7.2).

---

## 5. How Cardano data enters L3

Four mechanisms can carry observed L1 state into the L3 runtime. Choosing among them
is a **consensus-safety** decision, not a convenience one.

| Mechanism | What it is | Trust property | Verdict |
|---|---|---|---|
| **(a) Inherent** (`ProvideInherent`) | Block author derives the data and includes it as a pre-extrinsic; **every other node re-derives from its own view in `check_inherent` and rejects the block on mismatch** | Trust-minimized **iff** multiple independent producers each re-derive | **Target** (gated on multi-producer L3) |
| **(b) Gated extrinsic** | A normal dispatchable guarded by `T::FollowerOrigin::ensure_origin(origin)?` instead of `ensure_signed`; the follower verifies/aggregates **off-chain** and submits | Trust the gated origin; runtime does **zero** re-derivation | **v1 choice** |
| **(c) Offchain worker (OCW) HTTP read** | A node-local async hook fetches Cardano and submits a tx back | Results **"are not subject to regular transaction verification"**; per-node, non-deterministic | **ANTI-PATTERN — never** |
| **(d) On-chain light-client / Mithril proof** | The runtime verifies a Mithril stake-threshold certificate (or a succinct proof) of Cardano state before accepting it | Trust shifts off the follower onto Cardano SPO stake | **North-star** (heaviest; gated on SPO-committee L3) |

### 5.1 The consensus-safety reasoning

- **Inherents (a)** are the canonical Substrate way to inject chain-observed external
  data **deterministically**: `create_inherent` builds the call from the author's
  view; `check_inherent`'s second argument is the data the **verifying** node computes
  from **its own** view, and any disagreement rejects the whole block. This is exactly
  the partner-chains `mcsh` pattern (and `pallet_timestamp`'s drift check is the
  canonical example). **But the trust-minimization only materializes when there are
  MULTIPLE independent block producers.** Under single-operator L3 the sole author is
  the only "checker," so an inherent is **no more trustless than a gated extrinsic** —
  while costing far more engineering (custom `InherentDataProvider` + `ProvideInherent`
  + import wiring). Its payoff is *coupled* to L3 decentralization.
- **Gated extrinsic (b)** is the honest, lowest-effort choice for v1 and **loses
  nothing on the glide path**: when L3 graduates, you migrate the *same* pure §10
  function from the off-chain follower into the inherent's `create_inherent` /
  `check_inherent` body — the hard part is already specified.
- **OCW (c)** is the **named anti-pattern** (`PLAN.md` line 118): OCW results bypass
  normal transaction verification, run only on opt-in nodes outside block execution,
  and are non-deterministic per node. Using an OCW HTTP read for a consensus-relevant
  weight/identity decision is precisely the wrong tool. (OCWs are fine for
  non-consensus side-effects like notifications.)
- **Light-client / Mithril (d)** is the maximal-trust-minimization option and the
  natural pairing for an SPO-committee L3 — but it requires implementing Mithril
  certificate verification in-runtime, and **Mithril proves tx *membership*, not
  address-*completeness*** (it catches a follower that *invents* vault events, not one
  that *omits* them — omission is caught only by an honest recompute). Build it only
  when the committee exists.

### 5.2 What v1 uses vs what the target uses

- **WEIGHT — v1:** **gated extrinsic (b)**, `FollowerOrigin = EnsureSignedBy<oneKey>`.
  **Target:** **inherent (a)** re-checked by every committee member, optionally with
  **Mithril-certified input (d)** — once L3 is multi-producer.
- **IDENTITY — v1:** **gated/signed extrinsic** carrying an **off-chain** CIP-8 proof
  (it is not deterministic-observation data; there is no productionized in-runtime
  COSE_Sign1 verifier). **Target (and a recommended early upgrade independent of L3):**
  an **on-chain `ed25519_verify` self-proof** extrinsic (§7) — checkable in one block
  by every node, so it needs no challenge window and removes the operator from identity
  correctness; only its *ordering* still depends on L3 consensus.
- **Invariant across all paths:** the **going-forward-only** + **unlock-clamp-to-zero**
  semantics are enforced in the pallet on **every** `set_stake` write, regardless of
  ingress. In the v1 gated-extrinsic path the call is gated by
  `T::FollowerOrigin::ensure_origin` (never `ensure_signed`), so the public tx pool
  cannot forge it. On the inherent path (target), `ProvideInherent::is_inherent` must
  return `true` for the weight call so it is admitted **only** as a block-author
  inherent (re-checked by `check_inherent`) and **can never** be submitted through the
  public tx pool. The two ingress mechanisms are mutually exclusive per call — never
  expose the same dispatchable as both a signed extrinsic and an inherent.

---

## 6. The observation pipeline

This is the deterministic core. It is identical in all four approaches; only **who
runs it** and **how its output is trusted** differ. Reuses `L1-cardano.md` §10
verbatim.

### 6.1 Index beacon-bearing UTxOs by the `talk_vault` policy id (Kupo/Ogmios)

Run Kupo with **one `--match` on the `talk_vault` policy id** — which, under the merged
single-validator design (DR-18), **equals the vault script hash** (the validator carries
both the mint and spend handlers; `policy_id == script_hash`) — optionally per-asset by
`policy_id.token_name`, so every canonical-vault UTxO is indexed directly by asset
instead of scanning an address and deciding which UTxOs count. With the multi-set
collapse and the merged validator there is **one policy / one contract / one address in
v1** (`min_lock`; `L1-cardano.md` §9, §10.1):

```
kupo --match <talk_vault_policy_id>              # == vault script hash; one contract in v1
kupo --match <talk_vault_policy_id>.<token_name> # optional: per-user (one identity's beacons)
```

For each match Kupo returns `{transaction_id, output_index, address, value, datum
(inline), created_at {slot_no, header_hash}, spent_at {slot_no, header_hash} | null}`.
The follower MUST derive the `talk_vault` policy id (== script hash) from the **same
applied blueprint** the contracts ship (same `min_lock`, same compiler/stdlib pin) or it
will index the wrong asset (`L1-cardano.md` §9.2). Because the mint arm asserts the
beacon lands at the script's own address, the policy-id match is a real "beacon ⇒
canonical vault" guarantee (DR-18) — there is no separate beacon policy and no hash-cycle
to reason about (the old L1 §4.5 concern is DELETED). **Ogmios** supplies network params + tx
submission and is needed only for the **write/anchor** side, not for observation —
mirroring the partner-chains "db-sync-for-observe / Ogmios-for-submit" split.

### 6.2 Reorg-safe read (the load-bearing part)

Reorg-safety is **orthogonal to every trust model** and must hold in all of them
(`L1-cardano.md` §10.3):

- **Bury before counting — and clamp faster than you grant (DR-09b).** Count a UTxO
  toward weight only once `created_at.slot_no` is buried past the **grant-*k*** below tip
  — v1 uses a **pragmatic grant-*k*** (a few hundred slots / minutes, not the full ~2160
  `securityParam`). Counting at the tip lets a short reorg grant transient capacity. The
  safety-critical **clamp** (unlock → 0) uses a deliberately **SHORTER clamp-*k*** so it
  lands faster than grants (the failure asymmetry of §8.2 makes a slow clamp the
  dangerous one); raise the grant-*k* toward `securityParam` for any mainnet / real-value
  deployment.
- **Pin to a stable cursor, not "tip".** Aggregate "as-of" a chosen stable Cardano
  point `(slot_no, header_hash)` — the analog of partner-chains' `mcsh` / `CARDANO_
  SECURITY_PARAMETER (~2160) + BLOCK_STABILITY_MARGIN`. (In v1 a single follower
  trivially agrees with itself; this becomes load-bearing in B/C/D where multiple
  honest parties must compute the *same* "correct" map — without a shared cursor they
  diverge and never reach quorum / a dispute has no canonical resolution.)
- **Never cache "spent" as permanent.** Kupo flips `spent_at` back to `null` on
  rollback. On `RollBackward` to slot S, discard observations with `slot_no > S` and
  recompute. Bury **both** `created_at` **and** `spent_at` past depth *k*. A **beacon
  BURN (`mint −1` of the `talk_vault` policy) is an equivalent leave signal** alongside
  `spent_at` — a full exit burns the beacon, so the tx `mint` field shows the policy
  at −1 (`L1-cardano.md` §10.4); bury the burn past the (shorter) clamp-*k* too, and
  likewise never cache it as permanent (a rollback un-burns it). Use Kupo's
  ETag/checkpoint for rollback handling; never treat a single read as final.

### 6.3 The deterministic `beacons → weights` pure function

The function the whole trust argument rests on (`L1-cardano.md` §10.2). It is **pure**:
same Cardano state in → same map out, on every node. **On-chain does NOT guarantee
global one-beacon-per-identity** — a minting policy is tx-local, so a user can mint a
second same-name beacon (same `token_name = blake2b_256(serialized owner Address)`) in a
separate tx (`L1-cardano.md` §7.14). **This follower's largest-wins rule IS the
uniqueness mechanism**: it makes a second beacon pointless (only the biggest counts) and
is the only thing delivering one-effective-beacon-per-identity — do **not** claim the
mint policy enforces it.

```
# DR-01 / DR-18: identity = the whole owner Address; key on the SERIALIZED Address.
# token_name = blake2b_256(serialized owner Address)  (32 bytes), NOT a pkh hash.
fn beacons_to_weights(buried_beacon_utxos) -> Map<owner_address, lovelace>:
    best = {}                                              # owner_addr -> (lovelace, outref)
    for utxo in buried_beacon_utxos:                       # only UTxOs buried past depth k
        owner = parse_inline_datum(utxo.datum).owner       # VaultDatum { owner: Address }
        # INTEGRITY: ignore a UTxO whose beacon name mismatches its datum owner Address.
        # Use the IDENTICAL util.beacon_name fn the L1 validator uses (§7.12);
        # util.beacon_name(addr) == blake2b_256(serialize(addr))  (32 bytes).
        if util.beacon_name(owner) != utxo.beacon_token_name: continue
        # CONSISTENCY (DR-01): the vault address's stake cred must match the datum's.
        if utxo.address.stake_cred != owner.stake_cred: continue
        lovelace = assets.lovelace(utxo.value)             # ADA-only; lovelace_of
        outref = (utxo.transaction_id, utxo.output_index)
        # LARGEST-WINS: keep the MAX-lovelace beacon; tiebreak by output reference.
        if owner not in best
           or lovelace > best[owner].lovelace
           or (lovelace == best[owner].lovelace and outref < best[owner].outref):
            best[owner] = (lovelace, outref)               # NEVER += ; NEVER sum
    return { owner: v.lovelace for owner, v in best }      # one weight per identity (Address)
```

- **Parse** the inline datum to `owner` — a full CIP-19 `Address` (payment + stake
  credential; payment restricted to `VerificationKey` in v1, DR-01). The serialized
  `Address` is the identity key, **not** a bare `owner_pkh`.
- **Integrity-check** `util.beacon_name(owner_address) == observed token_name`, where
  `util.beacon_name(addr) = blake2b_256(serialize(addr))` (32 bytes) — the **identical**
  `util.beacon_name` fn the merged L1 validator uses (`L1-cardano.md` §7.12); drop any
  UTxO whose beacon name mismatches its datum owner Address. Also enforce
  `vault_address.stake_cred == datum.owner.stake_cred` (DR-01) so the locked ADA provably
  delegates with the identity's stake key.
- **Select the max-lovelace** beacon UTxO per `owner_address`, with a deterministic
  tiebreak on equal lovelace by **output reference** (`(transaction_id, output_index)`
  lexicographic) — `assets.lovelace` is exact because vaults are ADA + 1 beacon only by
  the L1 continuation rule, so token-padding cannot fake it. ⛔ **NEVER `+=` / NEVER
  sum** across an identity's UTxOs — summing is the stake-splitting double-dip.
- It is **versioned and pinned**: the function body, the `talk_vault` policy id (== vault
  script hash), the tiebreak rule (output-ref order), depth *k*, and the "as-of" rule are
  published so two honest parties cannot compute different "correct" answers. This is the
  cheap commitment every later rung depends on.

### 6.4 Largest-wins per owner `Address` (no cross-UTxO, no cross-set aggregation)

**Group a user's beacon UTxOs by the whole `owner` Address and select the single largest
(max-lovelace, tiebreak by output reference) — NEVER sum.** An identity with many
same-name beacons (transient duplicates, or a consolidation in flight) resolves to the
**one biggest beacon UTxO** as its weight for **one** L3 account (the 1:1 binding, §7).
Largest-wins is deliberate: it prevents the stake-splitting double-dip (you cannot
split 300 ADA into 3×100-ADA beacons to triple voice — only the biggest counts),
incentivizes consolidation to one vault, and never zeroes a user on a transient
duplicate. The output is exactly `{ owner_address → largest_buried_lovelace }` as-of the
pinned cursor — nothing more. (The L3 runtime turns that lovelace into capacity: `cap =
weight*CAP_RATIO`, regen = `weight*REGEN_PER_BLOCK`; `ECONOMICS.md` §4. L2 never
computes capacity.)

---

## 7. Identity binding (CIP-8)

Identity binds the **owner `Address` ↔ Substrate sr25519 account**, **1:1**, and is the
Sybil anchor. There are **two separable trust points**: CIP-8 **verification
correctness**, and **write ordering**. Only the second truly needs L3 consensus.

### 7.1 The proven pycardano path, with a COMMITTED payload (v1, DR-02)

Reuse the `cogno_v3` flow, upgraded to a **committed payload** so bind-hijack is
**PREVENTED in v1** (not merely detected):

- **Committed payload (DR-02).** The user signs **domain-separated bytes that COMMIT**
  `{ sr25519 account + L3 genesis hash + fresh nonce }`. The genesis hash is anti-cross-
  chain; the nonce is anti-replay; binding the sr25519 inside the signature is what
  prevents an operator (or anyone) from re-pointing the proof at a different L3 account.
  A server-cache nonce (300s TTL, reuse `nonce_view.py`) is still acceptable in v1; the
  fully on-chain-committed-nonce / ed25519 self-proof (§7.2) is the **deferred D1**.
- **User signs.** CIP-30 wallet `signData` produces a **CIP-8 COSE_Sign1** over the
  committed payload, **from an address the user controls** (see §7.4).
- **Verify (whole-Address match, DR-01/DR-02).** Reuse `pycardano.cip.cip8.verify`
  (`verify_view.py`): assert `verified == true`; **reconstruct the signing `Address`
  (payment AND stake credential) and assert it == the `datum.owner` Address EXACTLY**;
  assert the signed payload's committed sr25519 == the submitted sr25519, and its
  genesis hash + nonce are valid. The match is the **whole Address**, not a bare
  key-hash — this is what structurally closes the old wrong-key gotcha (§7.4).
- **Bind.** Submit `link_identity{ owner_address, thread_pointer?, substrate_account }`
  via the `FollowerOrigin`-gated extrinsic → `pallet-cogno-gate` writes the 1:1
  binding (reject if either side already bound).

**Identity is a GATED EXTRINSIC, never an inherent.** CIP-8 is an off-chain proof of
*key control*, not deterministic-observation data, and chain-inclusion proofs cannot
prove key-control (so Mithril is irrelevant to identity).

### 7.2 The trust-minimization options (and their cost)

1. **On-chain `ed25519_verify` self-proof (recommended early upgrade).** CIP-8 is at
   its core a single Ed25519 verify over a deterministically-reconstructable CBOR
   `Sig_structure = cbor(["Signature1", protected_hdr, external_aad=b"", payload])`.
   Substrate exposes `sp_io::crypto::ed25519_verify` as a **native host function**
   (~tens of microseconds, far cheaper than the extrinsic's own storage I/O), and
   `blake2b-224` is a host primitive. So `link_identity{ cose_sign1_blob }` can be a
   **permissionless `ensure_signed`** call where the pallet reconstructs the
   `Sig_structure`, runs `ed25519_verify`, computes the payment credential
   `blake2b224(vk)`, **reconstructs the full owner `Address`** (that payment credential +
   the stake credential the proof carries) and asserts it equals `datum.owner` **exactly**
   (whole-Address match, DR-01), asserts the signed payload commits to the caller's
   sr25519 account + L3 genesis-hash + nonce (anti-replay / cross-chain, DR-02), and
   writes the 1:1 binding. (This is the **deferred D1** on-chain ed25519 self-proof; v1
   ships the off-chain §7.1 verify, which already does the whole-Address match.)
   **This removes the operator from the identity-correctness path entirely** — every
   full node re-verifies in one block; only *ordering* still depends on L3.
   **Cost / critical attack surface (treat as load-bearing if adopted):** the
   `no_std` COSE/CBOR decode + `Sig_structure` re-serialization is the **only novel
   crypto** in the whole system, and a verifier bug is **catastrophic, Wormhole-class**
   (Wormhole's $325M loss was a signature-verifier bug, not a quorum break). Before
   relying on it as the 1:1 Sybil anchor, **pin the verifier semantics and audit them**:
   - **Accept only 32-byte CIP-30 keys on-chain.** Reject anything that is not a
     standard 32-byte ed25519 verification key; handle extended/BIP32 (64-byte
     `vk‖chain_code`) keys **off-chain** only (see §7.4 extended-key note). This removes
     a whole class of length/trim ambiguity from the consensus path.
   - **Account for `ed25519-zebra` (Substrate) vs `libsodium` (pycardano) edge-case
     divergence** — small-order points, non-canonical S. Pin **one** canonical verifier
     semantics so the off-chain oracle and the on-chain pallet **cannot disagree** on a
     borderline signature (a disagreement is itself an exploitable split).
   - **Fix the exact `Sig_structure` bytes** (`cbor(["Signature1", protected_hdr,
     external_aad=b"", payload])`) and fuzz the decoder against malformed COSE blobs.
   **Not** gated on L3 decentralization — worth doing early, but **only behind an audit**.
2. **User self-proof (the payload binds everything).** Move the anti-replay value
   (per-account nonce or recent L3 block hash) **and** the L3 genesis/chain-id **inside
   the signed CIP-8 payload**, so a captured proof is not replayable on another
   chain/account and there is no trusted server nonce. Pairs with option 1.

### 7.3 Recommendation

- **v1 (DR-02):** reuse the proven off-chain `pycardano.cip.cip8.verify` path behind the
  gated extrinsic, with a **committed payload** ({ sr25519 + L3 genesis hash + nonce })
  and a **whole-Address match** (recovered signing Address == `datum.owner`). Lowest
  effort, matches `PLAN.md` M2, and already PREVENTS bind-hijack.
- **D1 — DONE (spec 109; developed at 108, folded to 109 when the in-protocol-observation pallet merged):** the on-chain `ed25519_verify` self-proof
  (`cognoGate.link_identity_signed`, `pallet_cogno_gate::cip8`) **replaces** the trusted
  off-chain bind — the runtime verifies the wallet signature, removing the operator from
  the identity-correctness path entirely. The trusted `link_identity` is removed; the
  follower is now a read-only helper; `FollowerOrigin` gates only `revoke` (a permanent
  tombstone). Shipped **enabled on testnet**, labelled `MAINNET PREREQUISITE` (the §7.2
  verifier audit is still owed). See **[`TRUSTLESS-IDENTITY.md`](TRUSTLESS-IDENTITY.md)**.

### 7.4 The binding-key gotcha is now STRUCTURALLY CLOSED (RESOLVED, DR-01/DR-02)

**RESOLVED in DECISION-REGISTER.md (2026-06-16).** This was previously framed as a
"BLOCKING, do-not-ship-until-resolved" release gate. It is no longer: the whole-Address
datum + whole-Address CIP-8 match closes it structurally. **owner is a full `Address`;
the follower asserts the recovered signing Address == `datum.owner` exactly; the
credential-kind question (open question #2) is RESOLVED** (owner is an `Address`, not a
bare key-hash). The detail below is retained for context.

**Why it was a risk under the old `owner_pkh` design.** The old gap could produce a
*wrong-key* binding because the datum held only a bare 28-byte key-hash and `cogno_v3`'s
`verify_view` naively derived a hash from `Address.payment_part` of whatever wallet
address signed — so signing from the wrong address proved control of a key that was not
the intended owner.

**Why it is structurally closed now (DR-01, DR-02):**

1. **The datum holds the WHOLE owner `Address`** (`VaultDatum { owner: Address }`) — a
   full CIP-19 address (payment + stake credential), payment restricted to
   `VerificationKey` in v1. There is no bare key-hash to mis-derive.
2. **The proof asserts the whole signing `Address`, not a payment-part hash.** The
   follower **reconstructs the signing Address (payment AND stake credential) and asserts
   it == `datum.owner` EXACTLY**. There is no longer any "which credential do I hash?"
   ambiguity: both credentials must match the datum's Address byte-for-byte. **NEVER**
   sign from the vault (type-1, script-payment) address — its payment part is the script,
   so it cannot equal a v1 `VerificationKey`-payment owner Address — and **NEVER** rely
   on `cogno_v3`'s bare `Address.payment_part` derivation; assert the whole Address.
3. **Stake-cred consistency is enforced on-chain (DR-01).** Create and every
   continuation enforce `vault_address.stake_cred == datum.owner.stake_cred`, so the
   identity's stake credential is provably the one the locked ADA delegates with — the
   off-chain match against `datum.owner` therefore matches a credential the L1 contract
   itself pins.

Open question #2 (payment-vs-stake key-hash semantics) is therefore **moot/RESOLVED** —
the identity is an Address, matched whole. The §12 step-5 "wrong-address negative test"
becomes a **whole-Address match test** (assert a proof from a different Address — payment
OR stake cred differing — is rejected), no longer a release-blocking unknown.

**Two further CIP-8 gotchas to pin:**

- **Extended (BIP32-Ed25519) keys.** CIP-30 browser wallets return a 32-byte ed25519
  KID + a standard signature (the common case — plain `ed25519_verify` works). Some
  hardware/CLI signers attach a **64-byte extended key** (`vk‖chain_code`); an on-chain
  pallet using `sp_io` MUST feed it the **32-byte** key (trim the chain code), and
  pycardano's extended-path address check does **not** auto-trim — a latent
  inconsistency. Simplest on-chain policy: **accept only 32-byte CIP-30 proofs
  on-chain**, handle extended keys off-chain.
- **ed25519 malleability.** `ed25519-zebra` (Substrate) and `libsodium` (pycardano) can
  differ on edge cases (small-order points, non-canonical S). It does not enable
  forgery for a 1:1 binding, but **pin the exact verifier semantics** or honest
  re-verifiers (off-chain oracle vs on-chain pallet) can disagree.

### 7.5 Revocation is weak by construction

A wallet key never "burns" or "moves," so wallet-only bindings effectively **never
auto-revoke** — only the operator can ban an identity. Weight-zeroing on **unlock** is
event-driven and works (§6, §8), but **identity** revocation is manual. v1 policy
(DR-14): **wallet-only CIP-8 gate → manual operator ban**. Thread-ownership gating
(`PLAN.md` M2b — poll thread UTxOs past reorg depth, revoke on disappearance) is
**optional / later** (DR-14, DR-14b: comments/replies are gated too, inheriting the same
1:1 Sybil anchor + capacity meter).

---

## 8. Weight write protocol

### 8.1 `set_stake` / `link_identity` semantics

Both are normal `#[pallet::call]` dispatchables on `pallet-cogno-gate` /
`pallet-talk-stake`, but **guarded by `T::FollowerOrigin::ensure_origin(origin)?`**
(an `EnsureOrigin` impl) instead of `ensure_signed`:

- `link_identity{ owner_address, thread_pointer: Option<ConstU32<10>>, substrate_account }`
  — writes the hard **1:1** owner-`Address` ↔ `AccountId` binding; **reject if either side
  is already bound** (the Sybil anchor). The on-chain 1:1 key is
  `blake2b_256(serialized owner Address)` (32 bytes, == the beacon `token_name`, DR-01),
  replacing the old 28-byte `owner_pkh` / `len()==28` key. The thread-pointer is
  `ConstU32<10>` (10 hex, DR-23), never `<4>`/5-byte; the bind field is optional.
- `set_stake{ owner_account, weight }` — writes `weight` to the single 1:1-bound account;
  sizes the `pallet-talk-capacity` bucket (`cap = weight*CAP_RATIO`). Note: capacity logic
  is folded into `pallet-microblog` (DR-24); the names here are illustrative.

### 8.2 Going-forward-only; unlock → weight 0 + clamp

- **Going-forward-only (monotonic-forward).** Writes are not retroactive; a new vault
  grants no weight until it is buried and applied. There is no back-dating of voice.
- **Unlock → 0 + clamp (clamp-only decay, NO on-chain timelock — DR-13).** On an
  observed unlock (`spent_at` set and **buried** past the shorter clamp-*k*), submit
  `set_stake{ owner_account, 0 }` **immediately**, clamping `pallet-talk-capacity` to
  **zero** for that owner `Address` (`L1-cardano.md` §10.4). The capacity bucket collapses
  on next access. v1 has **no `lock_until` / no on-chain cooldown** — the commitment is
  enforced entirely by L3 regen/clamp (talk starts at zero, accrues only while parked,
  clamps to zero on unlock); an opt-in `lock_until` bonus is DEFERRED.
- **The clamp path MUST be demonstrably faster + more reliable than the grant path**
  (required, not advisory — the failure asymmetry of §8.4 makes a slow clamp the
  dangerous one). Concretely: **(i)** run clamps on a **separate, higher-priority work
  queue** that is drained before new grants; **(ii)** on restart, **backfill the clamp
  set FIRST** (re-scan for buried `spent_at` and zero those accounts before applying any
  new grants); **(iii)** **alert on stalled observation cadence** — if the cursor has
  not advanced within an SLA, page the operator, because every stalled minute is live
  voice for already-reclaimed users. Measure and assert clamp-latency ≤ grant-latency in
  testing.

### 8.3 Idempotency / reorg re-derivation

The follower MUST be **idempotent and restart-safe**: on startup, **re-derive** weight
from the buried Kupo snapshot rather than trusting any cached "spent" state. A backfill
path re-applies skipped vault events on restart. On a Cardano rollback that flips
`spent_at` back to `null`, the follower **recomputes** and re-grants — never caching
spent-as-permanent. Net invariant: a reorg can **never** grant un-earned capacity, and
an unlocked user loses voice promptly once the spend buries.

### 8.4 The `FollowerOrigin` / committee / threshold behind it

`FollowerOrigin` is an `EnsureOrigin` impl, structured so the **call signatures never
change** as it widens:

- **v1 (DR-07):** a **single `AccountId`** via `EnsureSignedBy` (the follower's key),
  plus a **sudo escape hatch** — `EitherOfDiverse<EnsureRoot, FollowerOrigin>` — during
  bring-up (`PLAN.md` writes bindings via `sudo` in pure-Substrate demos), plus the D0
  audit log. This single-key posture is the explicit v1 decision (testnet showcase only).
- **D2 gate (DR-07) — before ANY mainnet / real value:** widen `FollowerOrigin` to a
  **3-of-5 k-of-t committee** — `pallet-collective` with the 5 followers as members and
  `EnsureProportionAtLeast<3, 5>` — **or** an in-pallet check of an **aggregate threshold
  signature** against a stored committee verification key, **with key rotation and an
  on-chain committee-key update**. Removes the single crown-jewel key; compromise of up to
  2 follower keys forges nothing. `FollowerOrigin` stays an `EnsureOrigin` throughout.
- **Trustless (Approaches C/D, gated on L3 → committee):** the gate becomes
  *"a bonded assertion that survived a fraud window"* (optimistic) or
  *"a Mithril-certified inherent re-checked by every producer"*.

### 8.5 Key management (load-bearing, unsolved in v1)

The follower's `link_identity` / `set_stake` authority key is a **crown jewel** — it
can grant posting rights and set arbitrary weight, so **compromise of that one key =
full identity-forgery + weight-manipulation capability**. A **single dev key is
acceptable ONLY if explicitly labelled as such**, and only for dev/testnet.

**Hard gate (the D2 gate, DR-07) — before ANY mainnet / real-value deployment, write
down and implement all four of these** (until then, "mitigate with multisig" is not a
credible mitigation, it is a placeholder):

1. **The k-of-t threshold** — v1's decided target is **3-of-5** (N=5 signers, M=3
   required).
2. **The signer set** — who holds each key, on what hardware, in what custody domains
   (independence matters: 3 keys in one operator's control is not 3-of-5).
3. **The rotation procedure** — how a key is replaced/revoked without halting the
   follower, and how the on-chain committee verification key is updated.
4. **The public audit log** — every `link_identity` / set/revocation emitted as a
   public, recomputable record (pairs with the D0 audit event, §9/§12 step 7).

Because `FollowerOrigin` is an `EnsureOrigin` impl, widening one key → k-of-t collective
(`EnsureProportionAtLeast<M,N>`) or threshold-sig touches **no call signatures** — the
architectural hook is already in place (§8.4). The Cardano signing key on the
**write/anchor** side (if any) is a separate funded hot wallet with its own
native-script/multisig spend policy.

---

## 9. Decentralization path

Concrete milestones from single follower to trust-minimized. Each rung names exactly
**which trust it unlocks** and **whether it requires L3's SPO-committee graduation**.
The app pallets (`pallet-microblog`, `pallet-cogno-gate`, `pallet-talk-stake`,
`pallet-talk-capacity`) are **unchanged** across the entire path — only `FollowerOrigin`
and the follower topology change.

| Step | What you build | Unlocks | Requires L3 → SPO committee? |
|---|---|---|---|
| **D0. Single follower + auditability — SHIPS IN v1** | Approach A: gated extrinsic; **publish** the versioned **largest-wins** pure-function spec, the **`talk_vault` policy id (== vault script hash)**, the **tiebreak rule (output-ref order)**, depth *k*, cursor rule; emit a per-write audit event `{owner_address, weight, cursor_slot}`; **ship a standalone recomputer** that recomputes **max-per-owner-Address** (not a sum), reads L1 + the spec, and proves divergence | **Auditability** — fraud is detectable/provable by any third party (not yet punishable). *Without this, the entire "determinism ⇒ auditable" argument is unbacked.* | **No — and not optional in v1** |
| **D1. On-chain CIP-8 self-proof (DR-02 deferred D1)** | Move `link_identity` to an in-runtime `ed25519_verify` self-proof over the **committed payload**, reconstructing the full owner `Address` and matching `datum.owner` whole (§7.2) — **only behind an audit** of the `no_std` COSE/CBOR verifier (critical, Wormhole-class attack surface; 32-byte keys only on-chain) | **Identity trust → nobody** (operator removed from identity correctness) | **No** |
| **D2. k-of-t committee** | Approach B: widen `FollowerOrigin` to `EnsureProportionAtLeast<M,N>` (or threshold-sig); recruit ≥3 independent follower operators; pin a shared cursor + function version | **Removes the single follower** as a point of forgery and of liveness failure (tolerates N−M outages); needs M-of-N collusion to lie | **No** (but marginal trust benefit is small until D4) |
| **D3. Optimistic / permissionless relay** | Approach C: bonded `submit_weight_batch` → challenge window → `finalize_weight_batch`; permissionless relayers + watchtowers; on-chain dispute resolver re-runs §10 for the disputed slice | **Removes the trusted writer without a fixed committee** — 1 honest challenger defeats fraud | **Effectively yes** — the operator can censor disputes / bypass the queue until L3 includes challenge extrinsics honestly |
| **D4. Inherent re-verification (+ Mithril input)** | Approach D: migrate the pure §10 function to a `ProvideInherent` pallet (`create_inherent` / `check_inherent`); every producer re-derives from its own buried indexer; optionally gate the input on a **Mithril** stake-threshold cert verified in-runtime | **Trustlessness end-to-end** — observation becomes consensus-pinned and re-verifiable by all; input becomes Cardano-stake-certified | **YES** — `check_inherent`'s "all validators re-verify" is load-bearing **only** with multiple independent producers |

**The throughline:** D0 and D1 are *free* of the L3 constraint and should be done in
v1. D2 is buildable today but its trust benefit is *largely moot* until L3
decentralizes (it hardens the off-chain half while the on-chain half is still one
party). **D3 and D4 only pay off once L3 graduates to an SPO/Ariadne committee** — at
which point the *same* §10 function, the *same* bonded-queue / inherent pallet, and the
*same* CIP-8 self-proof all become load-bearing with **zero rework**. Sequence the
Mithril/inherent investment to **track the L3 milestone**, not ahead of it.

---

## 10. Honest risks

- **Trusted-oracle reality in v1.** The follower's privileged key can bind any owner
  `Address` to any sr25519 account and set arbitrary weight; a compromised or buggy
  follower =
  arbitrary identity forgery and weight manipulation. This is **the** least-decentralized
  part of the system. It is honest *only* because under single-operator L3 it adds no
  new trust beyond "trust the operator" — and that excuse evaporates the moment L3
  decentralizes, so D1/D2 must follow.
- **Liveness / SPOF, silent and asymmetric.** A dead follower stops onboarding and
  weight updates. Existing on-L3 weights and bindings **persist** (they are L3 state).
  The failure is **safe-but-stale for new grants** but **UNSAFE-stale for unlocks** —
  an unlocked user retains voice until catch-up, widening the §10.4 voice-lag window.
  **Required mitigations** (not optional, §8.2): prioritized clamp queue drained before
  grants, **clamp-set-first backfill on restart**, health checks, and **alerting on
  stalled observation cadence**; redundant followers come later (D2). (Because v1 uses a
  gated extrinsic, a lagging follower does **not** stall L3 block production — unlike the
  inherent path, where a validator whose follower lags rejects valid blocks and gets
  peer-banned.)
- **CIP-8 attestation trust.** In v1 the follower both runs the crypto **and** is the
  sole writer — it could bind any owner `Address` to any account. The committed-payload
  bind (DR-02) means it cannot re-point an *honest user's* proof at a different sr25519
  (bind-hijack PREVENTED), but a *malicious* follower can still fabricate bindings; this
  residual is reduced to **zero** only by the on-chain `ed25519_verify` self-proof (§7.2,
  deferred D1). The old **binding-key mismatch** gap (§7.4) is now **structurally CLOSED**
  by the whole-`Address` datum + whole-`Address` match (DR-01) — no longer an open risk.
- **Reorg correctness.** If weight is granted on shallow confirmations, or "spent" is
  cached as permanent, a transient reorg grants un-earned voice or strands it. The
  bury-both-past-*k* + never-cache-spent + clamp-on-unlock rules (§6.2, §8.3) are
  mandatory and trust-model-independent. A fraud-proof scheme that asserts un-buried
  tip state can be made to "lie" truthfully via a transient reorg.
- **Key custody.** The `link_identity` / `set_stake` authority key is a crown jewel
  (§8.5) — compromise of that one key = full identity-forgery + arbitrary-weight. A
  single dev key is a labelled-only stopgap. **Before any non-dev deployment, the
  k-of-t threshold, signer set, rotation procedure, and public audit log MUST be
  written down** (§8.5) — "mitigate with multisig" is not a mitigation until they are.
  Unsolved in v1.
- **Voice-lag on unlock.** With no L1 timelock, a user can unlock anytime; voice
  persists until the spend buries and the clamp lands. The window **widens** while the
  follower is down, and (later) the optimistic challenge window in D3 **adds** latency
  on top of burial — keep both, and rush the clamp path.
- **Operational burden.** Even the light path runs cardano-node + Kupo + Ogmios;
  initial mainnet sync is multi-day (use preview/preprod for devnet). The heavy
  inherent topology (D4) imposes a synced indexer **+** Mithril client on **every**
  producer.
- **Overclaiming (Mithril / light-client, 2026 reality).** Do **not** market v1 as
  "trustless." It is **auditable** (anyone CAN recompute), not **trustless** (no-one
  MUST be trusted) — and the README/marketing inherit this discipline (§3.2). Be exact
  about what Mithril does and does **not** give you as of 2026:
  - Mithril proves transaction **MEMBERSHIP, not address COMPLETENESS** — it catches a
    follower that *invents* vault events, **not** one that *omits* them (omission is
    caught only by an honest recompute against the full set). So even with Mithril, the
    completeness assumption (§3 trust item (b)) is **not** discharged.
  - Mithril is **still beta with a single IOG aggregator** and gives **no live,
    address-keyed UTxO query**; pin the client to **≥0.12.2** (post-advisory
    GHSA-724h-fpm5-4qvr / GHSA-qv97-5qr8-2266). It is a **deferred north-star that
    hardens the INPUT** (D4), not a v1 trustless oracle.
  - **Partner-chains** (the main-chain-follower / inherent template) was **archived
    ~2026-04 and folded into Midnight** — study it as a template, do **not** depend on
    the archived repo.
  - "Trustless because Cardano-backed" before **both** D4 **and** an SPO-committee L3 is
    an overclaim — the inherent's "all validators re-verify" is load-bearing only with
    multiple independent producers (§5.1).

---

## 11. Open questions for the owner

**RESOLVED in DECISION-REGISTER.md (2026-06-16) — see that doc.** Several of these are now
decided (notably **Q2 is RESOLVED**: owner is a full `Address`, matched whole — the
credential-kind question is moot; see §7.4). The detail below is retained; the per-item
notes flag what changed.

1. **CIP-8 self-proof now or later?** *(DR-02: DEFERRED to D1 — the on-chain ed25519
   self-proof is the deferred D1; v1 ships the off-chain committed-payload verify.)* Is
   the on-chain `ed25519_verify` self-proof
   (§7.2, removes the operator from identity correctness, not gated on L3) in scope for
   v1, or deferred? It is the single highest-leverage early trust reduction — but it
   adds `no_std` COSE/CBOR decode as critical attack surface.
2. **`owner` key semantics (§7.4) — RESOLVED (DR-01/DR-02).** owner is a full CIP-19
   **`Address`** (payment + stake credential; payment restricted to `VerificationKey` in
   v1), matched **whole**: the follower asserts the recovered signing Address ==
   `datum.owner` exactly. The old payment-vs-stake-key-hash question is **moot** — there
   is no bare key-hash, and there is no payment-part-derivation ambiguity. The user signs
   from an address they control whose payment+stake credentials reconstruct
   `datum.owner`; never from the vault (script-payment) address. Stake-cred consistency
   (`vault_address.stake_cred == datum.owner.stake_cred`) is enforced on-chain.
3. **Reorg depth *k*.** *(DR-09b: pragmatic grant-*k* + a SHORTER clamp-*k*; raise
   grant-*k* for mainnet.)* Full Cardano `securityParam` (~2160 ≈ 12h) or a smaller
   pragmatic depth? Trades voice-grant latency against reorg safety. **Decided:** v1 uses
   a pragmatic grant-*k* (a few hundred slots / minutes) and a **shorter** clamp-*k* so
   the safety-critical clamp lands faster than grants.
4. **Committee size and recruitment (D2).** *(DR-07: 3-of-5 at the D2 gate; DR-26: 1-3
   honest permissioned operator nodes in v1.)* Is recruiting ≥3 independent follower
   operators realistic for v1.x, and what M-of-N? **Decided:** **N=5, M=3** at the D2 gate
   (before any mainnet/real value), with rotation + on-chain committee-key update.
5. **Decentralization endgame timing.** *(DR-26: 1-3 operator nodes at launch (honest
   permissioned); document the SPO/Ariadne graduation; self-build / vendor-fork, NOT the
   archived partner-chains repo.)* Is 1–3 operator nodes acceptable at launch, or is
   graduating to an Ariadne SPO committee a hard requirement — and on which stack? **v1
   posture decided:** 1-3 honest permissioned nodes; track Midnight's crates / self-build
   for the eventual graduation.
6. **Mithril dependency.** *(DR-25: Mithril DEFERRED to D4.)* Acceptable to depend on
   Mithril (beta, single IOG aggregator, membership-not-completeness) for the D4 input, or
   wait for multi-aggregator decentralization? Pin to which client/aggregator version
   (post-advisory ≥0.12.x)?
7. **Revocation policy (§7.5).** *(DR-14: wallet-only CIP-8 gate + manual operator ban in
   v1; thread-ownership M2b optional/later.)* Manual operator ban for wallet-only
   bindings, or thread-disappearance-driven revocation (`PLAN.md` M2b) — at what polling
   cadence and reorg depth? **v1 decided:** manual operator ban.
8. **Deferred Cogno-pool bonus.** Confirm it stays out-of-band and **non-weight-bearing**
   in v1 (if it ever becomes weight-bearing on a *continuation's* stake cred, the L1
   §7.5 payment-cred-only relaxation must be re-tightened to whole-`Address` equality
   first — note DR-01 already re-tightens create + every continuation to
   `vault_address.stake_cred == datum.owner.stake_cred`).
9. **Audit-log surface.** Where does the public recompute-and-verify audit log live
   (on-chain events vs an off-chain published feed), and who is expected to run an
   independent recomputer/watchtower?

---

## 12. Implementation milestones (L2 only)

Bite-sized, executable cold. Each builds on the last. Aligns with `PLAN.md`
M2 / M2c / M2d / M5.

1. **Observation stub.** Stand up cardano-node + Kupo + Ogmios on **PREPROD** (the v1
   devnet, DR-31; light Kupo/Ogmios, not db-sync). One Kupo `--match` by the
   **`talk_vault` policy id (== vault script hash, DR-18)** (optionally per-asset by
   `token_name`; derived from the same applied blueprint the contracts ship). Parse inline
   datum → `owner` **Address** (`VaultDatum { owner: Address }`, DR-01), integrity-check
   `util.beacon_name(owner_address) == token_name` (where `token_name =
   blake2b_256(serialized owner Address)`, 32 bytes), enforce
   `vault_address.stake_cred == owner.stake_cred`, and **select max `assets.lovelace` per
   owner `Address`** (largest-wins, never sum). Confirm the L1 → L2 read contract
   (`L1-cardano.md` §10).

2. **Reorg-safe core.** Implement burial of **both** `created_at` and `spent_at` past
   depth *k*; pin to a stable cursor `(slot_no, header_hash)`; handle `RollBackward`
   (discard `slot_no > S`, recompute); **never** cache spent-as-permanent. Make the
   follower **idempotent / restart-safe** (re-derive from the buried snapshot).

3. **Pure `beacons → weights` function.** Implement and **version** the
   group-by-owner-`Address` + **largest-wins** function (max-lovelace, tiebreak by output
   reference; **never sum**) of §6.3. Publish the spec, the `talk_vault` policy id (==
   vault script hash), the tiebreak rule, *k*, and the "as-of" rule. Add a property test:
   same buried state → same map, **the MAX + tiebreak is independent of read order**, and
   **explicitly test the duplicate-beacon case** — two equal-lovelace same-name beacons
   (same `token_name = blake2b_256(serialized owner Address)`) must pick the same one by
   output reference.

4. **`pallet-cogno-gate` + `FollowerOrigin`.** Build the 1:1 owner-`Address` ↔
   `AccountId` binding map (keyed on `blake2b_256(serialized owner Address)`, 32 bytes,
   DR-01) and the per-account weight, with `set_stake` / `link_identity` guarded
   by `T::FollowerOrigin::ensure_origin(origin)?` (v1 = a **single** `EnsureSignedBy<oneKey>`,
   wrapped in `EitherOfDiverse<EnsureRoot, _>` for the sudo escape hatch — DR-07; the
   3-of-5 committee is the D2 gate). Enforce the hard 1:1 binding and going-forward-only +
   clamp-to-zero on every `set_stake` write (clamp-only decay, no on-chain timelock,
   DR-13).

5. **CIP-8 verify (off-chain, reused, committed payload — DR-02).** Wire the
   Cogno-Follower's identity job to `pycardano.cip.cip8.verify` (`verify_view.py`) + the
   `nonce_view.py` pattern. The user signs a **committed payload** that commits
   `{ sr25519 account + L3 genesis hash + nonce }`. **Whole-Address match (RESOLVED, no
   longer a blocking gap — §7.4):** reconstruct the signing `Address` (payment AND stake
   credential) and assert it **== `datum.owner` EXACTLY**, and assert the payload's
   committed sr25519 == the submitted sr25519. (owner is a full `Address`; there is no
   bare-key-hash derivation and open question #2 is resolved.) Keep a **negative test**:
   a proof whose reconstructed Address differs from `datum.owner` in *either* the payment
   or the stake credential MUST be rejected. Submit via the gated extrinsic. Posting fails
   `NotAllowed` until a real CIP-8 signature binds the account.

6. **Weight write + clamp loop (clamp path prioritized — REQUIRED).** Drive `set_stake`
   from the buried aggregation (grants buried past grant-*k*); on an observed unlock
   buried past the **shorter clamp-*k*** (DR-09b), submit `set_stake{ ., 0 }` and verify
   `pallet-talk-capacity` clamps to zero. Run clamps on a
   **separate higher-priority queue drained before grants**; on restart **backfill the
   clamp set FIRST**, then grants. Add health checks + **alerting on stalled observation
   cadence** (page if the cursor stalls past SLA). Assert in testing that
   clamp-latency ≤ grant-latency (§8.2/§8.4 asymmetry).

7. **Audit-log + public recompute (D0 — SHIPS IN v1, not optional).** Publish the
   versioned **largest-wins** pure-function spec + the **`talk_vault` policy id (== vault
   script hash)** + the **tiebreak rule (output-ref order)** + depth *k* + as-of cursor
   rule; emit a per-write audit event `{owner_address, weight, cursor_slot}`; **ship the
   standalone recomputer** that reads L1 + the published spec, recomputes
   **max-per-owner-Address** (not a sum), and **proves divergence** from the on-chain
   weight set. This is the
   decentralization down-payment that makes
   the "determinism ⇒ auditable" claim actually exercisable — without it, "anyone can
   verify" is unbacked. Decide where the audit log lives (open question #9).

8. **(Deferred D1 — only behind an audit) On-chain CIP-8 self-proof.** Implement
   `link_identity{ cose_sign1_blob }` with in-runtime `ed25519_verify` over the
   reconstructed `Sig_structure`, reconstruct the full owner `Address` (`blake2b224(vk)`
   payment cred + the stake cred the proof carries) and assert it `== datum.owner` whole
   (DR-01), + payload-committed sr25519 / genesis-hash / nonce (§7.2, DR-02). **Treat as
   critical, Wormhole-class attack
   surface:** accept **only 32-byte CIP-30 keys on-chain** (extended/BIP32 keys handled
   off-chain), pin one canonical verifier semantics to avoid `ed25519-zebra` vs
   `libsodium` edge-case divergence (small-order points / non-canonical S), fuzz the
   COSE/CBOR decoder, and **audit before relying** on it as the 1:1 Sybil anchor. Then
   remove the operator from identity correctness.

9. **(Deferred, gated on L3 → committee) Trust-min hooks.** Widen `FollowerOrigin` to
   k-of-t (D2); then migrate the pure §10 function into a `ProvideInherent` pallet with
   `check_inherent` re-derivation (D4), optionally with Mithril-certified input and an
   optimistic challenge window (D3). Build only when L3 has multiple independent
   producers — and change **no** app pallet to do it.

---

## Appendix A — Key references

- **cogno-chain L1 design** (`docs/L1-cardano.md`) — the **single merged
  `talk_vault(min_lock)` validator** (mint + spend handlers; policy_id == vault script
  hash, DR-18) + beacon NFT, and §10 the L1 → L2 read interface (Kupo by the
  **`talk_vault` policy id**, == script hash; group-by-owner-`Address` + **largest-wins**
  — select the single largest beacon UTxO, **never sum**; tiebreak by output reference;
  reorg burial; clamp-to-zero on `spent_at` **or** a beacon burn; deferred delegation
  read). The vault datum is `VaultDatum { owner: Address }` (DR-01) and the beacon
  `token_name = blake2b_256(serialized owner Address)` (32 bytes). The pure observation
  this doc consumes. **On-chain does NOT guarantee global one-beacon-per-identity** — the
  mint policy is tx-local (`L1-cardano.md` §7.14), so an identity can hold multiple
  same-name beacons. **The follower's largest-wins rule IS the uniqueness mechanism**
  (only the biggest counts); do **not** claim the mint policy enforces global uniqueness.
  (The old separate beacon minting policy, the `beacon_policy_id` parameter, and the L1
  §4.5 hash-cycle concern are DELETED by the merge, DR-18.)
- **cogno-chain PLAN.md** — Approach A (Anchor) recommendation; M2/M2c/M2d/M5
  milestones; `pallet-cogno-gate` / `AllowedKeys` / `is_allowed`; the OCW anti-pattern
  (line 118); key-management and revocation framing (§5/§9).
- **cogno-chain ECONOMICS.md** — the lazy token-bucket capacity (`cap =
  weight*CAP_RATIO`, regen per block); the 1:1 Sybil anchor (§8). The downstream
  consumer of the weight L2 writes.
- **cogno_v3 CIP-8 path (LOCAL, proven):** `…/cogno_v3/cogno_v3_app/backend/api/views/
  login/verify_view.py` (`pycardano.cip.cip8.verify`; ⛔ its bare
  `verification_key_hash`-from-`Address.payment_part` derivation is SUPERSEDED by the
  **whole-`Address` match** of DR-01/DR-02 — reconstruct the full signing Address and
  assert `== datum.owner`, do not bind a bare payment-part hash), `…/login/nonce_view.py`
  (server-cache nonce; v1 also commits the nonce + sr25519 + genesis hash IN the signed
  payload, DR-02),
  `…/venv/.../pycardano/cip/cip8.py` (the verify, incl. the 64-byte extended-key
  branch), `…/cose/messages/sign1message.py` (the exact `Sig_structure` bytes).
- **Substrate inherents:** `ProvideInherent` (`create_inherent` / `check_inherent` /
  `is_inherent` / `is_inherent_required`) —
  https://paritytech.github.io/polkadot-sdk/master/frame_support/inherent/trait.ProvideInherent.html
  ; `pallet_timestamp` (canonical re-check-and-reject example).
- **Offchain workers (the anti-pattern):** results "are not subject to regular
  transaction verification" —
  https://github.com/substrate-developer-hub/substrate-docs/blob/main/content/md/en/docs/learn/offchain-operations.md
- **`sp_io::crypto::ed25519_verify`** (native host fn, backed by `ed25519-zebra`) —
  https://github.com/paritytech/substrate/blob/master/primitives/core/src/ed25519.rs
- **`pallet-collective`** (`EnsureProportionAtLeast<M,N>` for the k-of-t
  `FollowerOrigin`) —
  https://github.com/paritytech/substrate/blob/master/frame/collective/src/lib.rs
- **IOG partner-chains** (the main-chain-follower / `mcsh` inherent / Ariadne pattern;
  `CARDANO_SECURITY_PARAMETER` + `BLOCK_STABILITY_MARGIN`). **ARCHIVED ~2026-04, folded
  into Midnight — study as a template, do not depend on:**
  https://github.com/input-output-hk/partner-chains/blob/master/docs/intro.md
- **Mithril** (stake-threshold certs; `cardano-transaction certify <hashes>` =
  *membership* proofs only, no address-completeness; still beta, single IOG aggregator;
  pin client ≥0.12.2 post-advisory) — https://mithril.network/doc/ ; advisories
  GHSA-724h-fpm5-4qvr, GHSA-qv97-5qr8-2266.
- **Kupo** (reorg-safe index; `created_at`/`spent_at` slot+header-hash; `spent_at`
  flips to `null` on rollback) — https://github.com/CardanoSolutions/kupo
- **Trust-pattern references:** Wormhole Guardians (13-of-19 PoA); Hyperlane Multisig /
  Optimistic ISM (1-of-N watcher); UMA optimistic oracle (assert-then-challenge);
  Axelar (PoS + quadratic voting); Snowbridge (permissionless relayer outside the trust
  boundary).
- **CIP-8 / CIP-30** (COSE_Sign1 message signing; `signData`) —
  https://cips.cardano.org/cip/CIP-8 , https://cips.cardano.org/cip/CIP-0030
