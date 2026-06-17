# cogno-chain L5 — The Client / Frontend / Onboarding

> Deep-dive design for the cogno-chain **L5**: the client — the **Next.js +
> MeshJS (CIP-30) + polkadot-api (PAPI)** static-export SPA that makes the
> L1–L4 stack *clickable*. L5 is the **only layer the user touches**: connect a
> Cardano wallet → lock ≥100 ADA + mint the beacon → CIP-8 sign once to prove the
> owner **Address** → manage a separate sr25519 posting key → the follower binds it →
> post feelessly → read the feed. Companion to `docs/L1-cardano.md` (the
> `talk_vault` + beacon), `docs/L2-follower.md` (the trusted follower + CIP-8
> binding), `docs/L3-chain.md` (the runtime + feeless posting), `docs/L4-reading.md`
> (reading + the capacity widget), `ECONOMICS.md`, and `PLAN.md`.
>
> **This doc BUILDS ON those — it does not re-derive them.** The vault txs
> (`L1-cardano.md` §6/§9), the CIP-8 binding gate (`L2-follower.md` §7), the
> feeless gate + `current_capacity()` (`L3-chain.md` §4.3/§5), and the read API +
> capacity replay (`L4-reading.md` §4/§5) are settled; cited, not redone. What is
> *new* here is the **dual-key UX**, the **Model-B sr25519 keystore + its browser
> threat model**, the **onboarding state machine derived from reads**, the **MeshJS
> tx recipes with their pre-flight guards**, the **PAPI post/read/capacity wiring**,
> and the **"Reading Room / Civic Ledger" visual system** — all at implement-from-cold
> detail.
>
> **The honest one-liner L5 must never violate:** *usable ≠ trustless · signed ≠
> included · feeless ≠ unstoppable · auditable ≠ trustless.* L5 holds no fund custody
> in the server sense and calls no follower-only extrinsic — but it (a) manages the
> at-rest-encrypted **posting key it decrypts in plaintext at sign time**, (b) builds
> the **script-spend txs that parked ADA's safety depends on**, and (c) is the layer
> most able to silently re-centralize reads or lie about capacity. And the larger,
> *continuously-active* trust sits one layer down: the **trusted follower** (it binds
> your key and sets your posting rate going forward) and the **L3 operator** (it
> decides whether your signed post is included, ordered, and finalized). Every one
> of those is named in plain copy here, not buried.

> **RECONCILED to DECISION-REGISTER.md (2026-06-16).** The canonical decisions OVERRIDE
> this doc where they conflict; the corrections below are authoritative. Read this block first.
>
> - **Identity = the WHOLE owner Address, not `owner_pkh` (DR-01).** The L1 vault datum is
>   `VaultDatum { owner: Address }` — a full CIP-19 Address (payment credential + stake
>   credential), with the payment credential restricted to a `VerificationKey` in v1 (no
>   script/multisig owner yet). Everywhere this doc says `datum.owner_pkh` it now means
>   `datum.owner` (an Address). Supersedes §1, §5.1/§5.5/§5.6, §7.1/§7.2, §8, §9.5 wherever
>   they treat the identity as a 28-byte payment-key-hash.
> - **The beacon `token_name` = `blake2b_256(serialized owner Address)` (32 bytes), NOT
>   `blake2b_256(owner_pkh)` (DR-01).** Supersedes §6.2, §7.1/§7.3/§7.5, §8.3, §10.3.
> - **The L3 1:1 binding/identity key = the 32-byte `blake2b_256(owner Address)` (== the
>   beacon name), NOT the 28-byte `owner_pkh` / `len()==28` (DR-01).** `CognoGate.PkhOf` /
>   `AccountOf` now key on the 32-byte address hash. Supersedes §5.5 step 5, §7.1's
>   "two lengths" rule, §8.3/§8.5.
> - **ONE merged validator `talk_vault(min_lock)` — no separate beacon policy, no hash
>   cycle (DR-18).** A single Aiken validator carries BOTH a mint handler and a spend
>   handler (the cogno_v3 `thread.ak` shape); `policy_id == vault script hash`; the mint arm
>   asserts the beacon lands at the script's OWN address. This DELETES the two-validator
>   design, the separate beacon minting policy, the `beacon_policy_id` parameter, and the
>   ENTIRE hash-cycle concern. §7.1's "break the hash cycle / compute beacon policy id
>   first" dance is SUPERSEDED — it is now "apply `min_lock` → ONE hash; vault address =
>   `Script(vault_hash)` + the user's stake cred." Supersedes §3 crux #3, §7.1, the
>   Appendix-A L1 hash-cycle reference.
> - **Enforce `vault_address.stake_cred == datum.owner.stake_cred` on create AND every
>   continuation (DR-01).** The locked ADA provably delegates with the identity's stake key.
>   Supersedes the §7.1/§7.7 "stake cred == the user's own stake-key hash" framing to
>   "stake cred == `datum.owner.stake_cred`."
> - **The CIP-8 bind is the COMMITTED payload AND an EXACT whole-address match — bind-hijack
>   is PREVENTED in v1, not merely detected (DR-02).** The user signs domain-separated bytes
>   committing `{ sr25519 account + L3 genesis hash + fresh nonce }`; the follower verifies
>   signature valid + recovered signing address == `datum.owner` (payment AND stake cred) +
>   payload-sr25519 == the submitted sr25519. This STRUCTURALLY CLOSES the old §5.6/§7.4
>   "wrong-address" gotcha and the §5.5 "trusted-bind / detection-only" framing: the
>   credential-kind question is RESOLVED (it is an Address), and the readback becomes a
>   belt-and-suspenders check, not the only defense. The on-chain `ed25519` self-proof
>   remains the DEFERRED D1. Supersedes §1, §3 crux #2, §5.5/§5.6, §6.2, §10.2/§10.6, §11.
> - **`owner_pkh` credential-kind is NO LONGER a BLOCKING open question (DR-01).** It is
>   RESOLVED: the identity is an Address; v1 restricts its payment credential to a
>   `VerificationKey`. The "BLOCKING upstream open question" / "hard release gate on Q2"
>   framing in §1, §3, §5.6, §7.2, §11, and §12-M4 is SUPERSEDED. The §5.6 guards that
>   reject a script-payment signing address and 64-byte extended keys STILL stand.
> - **KDF = Argon2id; no plaintext device-unlock default; Model C offered as opt-in in v1
>   (DR-28a/DR-28b).** §5.2/§5.4 PBKDF2-vs-Argon2id "open question" is decided: Argon2id.
>   Supersedes §5.2, §13 Q1.
> - **`NextPostId` is `u64`, not `u32` (DR-21)** — the §8.3/§11 `2^32` wrap caveat is
>   removed.
> - **v1 = clamp-only decay, NO on-chain timelock / `lock_until` (DR-13).** Consistent with
>   this doc's existing "no timelock; reclaimable anytime" stance (§10.6) — no change needed
>   here beyond noting it.
> - **`thread_pointer` storage = `ConstU32<10>` (10 hex) with an optional bind field
>   (DR-23)** — matches §5.5; the "never `<4>`" warning stands.
> - **Network = preprod (DR-31); reference indexer = SubQuery (DR-27); archive is COMMITTED
>   in v1 (DR-08); Kupo optional cross-check, NO Blockfrost as a sole source / default read
>   = L3 `AllowedStake` (DR-33).** Tightens §8.2/§10.3/§13 Q5 (drop the Blockfrost-as-option
>   ambiguity) and §10.4 ("open in principle" is now backed by a committed archive). The
>   Tier-B indexer named in §2.3/§8.2 is SubQuery.
> - **The L2 "group-and-sum / live double-dip" banner is FALSE (DR-34)** — L2 on disk is
>   already largest-wins/never-sum; this doc already states never-sum and needs no change.

---

## 1. TL;DR

- **L5 = the only layer the user touches.** Connect a Cardano wallet → lock ≥100
  ADA + mint the beacon (MeshJS, `L1-cardano.md` §6.1) → **create the sr25519 key +
  back up its mnemonic** → CIP-8 sign **once** to prove the owner **Address**
  (DR-01/DR-02; `L2-follower.md` §7.1/§7.4) → POST the proof to the follower, which binds it
  (`link_identity`, follower-only, `L3-chain.md` §4.1) → post feelessly (PAPI,
  sr25519, `L3-chain.md` §4.4/§5) → read the feed (L4). Browsing the feed needs
  **none** of this and is never gated.
- **DUAL KEY, NEVER CONFLATED.** The Cardano CIP-30 wallet is **identity + stake** — its
  whole **base Address** (payment VerificationKey + stake cred) IS the on-chain identity
  `datum.owner` (DR-01) — (signs CIP-8 exactly once; controls ADA, vault, delegation). A
  **separate sr25519 key** is the **posting key** (signs every `post_message`, feeless, low-value,
  rotatable). The Cardano wallet is **NEVER** the posting signer (`L3-chain.md` §7);
  the sr25519 key never controls ADA. Two visually-distinct chips; the composer
  always echoes **"Signing as `<ss58-short>`."**
- **sr25519 = Model B keystore (settled).** A **random** in-browser sr25519 key,
  AES-GCM-encrypted under a passphrase-derived WebCrypto key in IndexedDB, **mandatory
  mnemonic backup**, decrypted **only at sign time** and zeroized after. ⛔ **Model B
  is XSS-fatal by construction** (§5.4): an XSS or one compromised dependency in this
  same-origin SPA can steal the plaintext seed at sign time — the encryption protects
  only at-rest / cross-site, *not* against same-origin script. v1 ships a strict CSP,
  SRI/lockfile-pinned audited deps, **no "remember this device" default**, and an
  isolated keystore worker. Model A (CIP-8-derived) is **rejected** (non-deterministic
  across wallets/HW, `L2-follower.md` §7.4; bind-time seed leaks; cannot rotate);
  **Model C (Substrate extension) is the security-preferred path for high-value
  identities**, offered as an opt-in even in v1, default deferred.
- **The CIP-8 binding is PREVENTED, not merely detected, in v1 (DR-02).** The v1 proof is a
  CIP-8 signature over a **committed payload** — domain-separated bytes committing
  `{ sr25519 account + L3 genesis hash + fresh nonce }` (`L2-follower.md` §7.1, DR-02). The
  follower verifies: signature valid + recovered **signing address == reconstructed
  `datum.owner`** (payment AND stake cred, an EXACT whole-address match, DR-01) +
  payload-sr25519 == the submitted sr25519. Because the proof commits to your sr25519
  account, a captured proof **cannot** be replayed to bind a *different* account, and the
  follower **cannot** silently substitute one — **bind-hijack is prevented** in v1.
  ⛔ The follower is still the only *writer* (`L2-follower.md` §3/§10), so as a
  belt-and-suspenders check L5 still polls `CognoGate.AccountOf[id32]` (keyed on the 32-byte
  `blake2b_256(owner Address)`) and asserts it equals *my* sr25519 account before declaring
  onboarding complete (§5.4). The on-chain `ed25519` **self-proof** (so the binding is
  client-verifiable without trusting the follower's verification step at all) is the
  **DEFERRED D1 upgrade** (`L2-follower.md` §7.2 / §9 D1 / §12 step 8, `L3-chain.md` §11 Q10).
- **RESOLVED — the identity is the whole owner Address (DR-01), no longer a BLOCKING
  credential-kind question.** `datum.owner` is a full CIP-19 Address (payment credential +
  stake credential); v1 restricts the payment credential to a `VerificationKey`. The old
  "is `owner_pkh` a payment- or stake-key-hash?" question (`L2-follower.md` §11 Q2 /
  `L3-chain.md` §1) is RESOLVED in DECISION-REGISTER.md (2026-06-16): the derive→sign→assert
  chain matches the **whole Address**, so there is no wrong-credential failure mode left —
  L5 can ship `link_identity` onboarding. (The §5.6 guards rejecting a script-payment
  signing address and 64-byte extended keys still stand.)
- **Onboarding is an FSM derived from reads, not stored flags.** Every state is a
  pure function of public reads (Cardano beacon UTxO keyed on `blake2b_256(owner Address)`
  → `CognoGate.PkhOf` → `TalkStake.AllowedStake` → `Capacity`); only the **in-flight tx
  hashes** (and the
  partial-withdraw inter-tx marker) are persisted, so a refresh recovers truth
  (`L4-reading.md` §5). ⛔ **Never cache a Cardano confirm as permanent** — a rollback
  un-confirms (`L1-cardano.md` §10.3, `L2-follower.md` §6.2).
- **Two never-conflated balances.** "Parked now" (Cardano live, optional Kupo cross-check,
  NO Blockfrost — DR-33, off the post path) vs "Counted for posting" (L3 `AllowedStake`, the
  largest **buried** beacon as-of the follower cursor — **never summed**,
  `L1-cardano.md` §10 / `L2-follower.md` §6.4 / `L4-reading.md` §5.1). The hero
  posting number is **always** `AllowedStake`/capacity-derived.
- **`AllowedStake` is AUDITABLE, not trustless, and the follower controls it going
  forward.** It is recomputable by a third party from L1 + the published largest-wins
  spec (`L2-follower.md` §3.1, D0), **but** the follower can write any weight, omission
  is invisible on-chain (`L2-follower.md` §3(b)), and the follower controls posting
  **rate** continuously (`ECONOMICS.md` §8, `L3-chain.md` §9). Capacity dropping to
  zero can mean an **operator clamp**, not only a user unlock.
- **The capacity battery replays `current_capacity()` VERBATIM** (`L3-chain.md` §4.3,
  `L4-reading.md` §5.2) and is **advisory only — the pool's `CheckCapacity::validate()`
  is the authoritative gate** (`L3-chain.md` §5.1/§5.2): `None ⇒ 0` (not full),
  `w === 0n ⇒ "lock ADA to post"` (not a timer), guard `rate === 0n` **before** the
  BigInt ceil-division (`/0n` THROWS `RangeError`), `cap = min(weight*CapRatio,
  Ceiling)`, **`need > cap ⇒ "too long / weight too low"` (never a finite timer)**,
  clock = block number. Constants come from `api.constants.Microblog.*`; **fail-closed**
  (disable submit) on a boot spec mismatch or missing constants (§8.1) — never estimate.
- **Pre-flight + catch on post, disambiguated from client reads.** Disable submit with
  a live countdown via the client replay, AND catch the pool-level `ExhaustsResources`
  at `signAndSubmit` (`L3-chain.md` §5.1). ⛔ An **unbound / zero-weight** account also
  hits `ExhaustsResources` at the pool (`current_capacity == 0`, `L3-chain.md`
  §5.1/§4.2) — it must map to **"finish onboarding / lock ADA"** (no timer), **not**
  "post in N blocks." `NotAllowed` (`L3-chain.md` §4.4) is effectively unreachable via
  the public pool in v1; disambiguate from **client reads** (`PkhOf`, `AllowedStake`),
  never from the error variant. Block-level congestion also surfaces as
  `ExhaustsResources` (`L3-chain.md` §5.3) → "network busy, retry next block."
- **Neutrality is a v1 requirement, not a fast-follow.** Endpoint-as-config: two
  user-overridable ordered lists (L3 RPCs + optional L4 indexers) with PAPI-direct
  degradation, baked in from day one and acceptance-tested (`L4-reading.md`
  §6.2.3/§6.3, L4-M5). The follower endpoint is **also** config, **but** — unlike the
  RPC list — it buys **zero v1 route-around**: there is exactly one trusted follower
  (`L2-follower.md` §4.1/§10); the field is forward plumbing for D2, not neutrality.
- **TWO persistent honesty badges, not one.** `follower: trusted (v1)` **and**
  `chain: operator-run (v1)`. The operator (consensus) trust is at least as large as
  the follower's — it decides inclusion/ordering/finality and the chain inherits
  **none** of Cardano's security (`L3-chain.md` §8.1/§9, `ECONOMICS.md` §8,
  `PLAN.md` §1).
- **Visual system: "Reading Room / Civic Ledger."** Calm paper/ink surfaces, a real
  text typeface (text IS the product), one accent (verdigris) reserved almost entirely
  for capacity, honest monospace "ledger marginalia" (block N, finalized vs best,
  parked vs counted, the two trust badges). Hand-authored CSS-variable tokens; no
  shadcn/default-Tailwind look; `prefers-reduced-motion` respected.
- **Static-export, self-hostable, telemetry-free, reproducible.** A **hyperstructure-
  COMPATIBLE** client — but the *system's* open-reads property remains contingent on
  the not-yet-existing L4 archive (`L4-reading.md` §6.5, L4-M4c) and bounded by the
  trusted follower + operator. The **client** is neutral; the **stack is not yet a
  hyperstructure** (`L4-reading.md` §6.4/§7.4, *reproducible ≠ effortless*).

---

## 2. Scope: what L5 DOES / does NOT / DEFERS

L5 is the fifth layer; its boundaries are settled by L1–L4. This section pins them so
nothing is re-derived below (mirrors `L4-reading.md` §2).

### 2.1 L5 DOES

- **Connects a Cardano CIP-30 wallet** (MeshJS `BrowserWallet`) and builds the vault
  lifecycle txs — create (mint + lock), top-up, full-exit/burn, and the two-tx
  partial-withdraw orchestrator (`L1-cardano.md` §6).
- **Generates, encrypts, backs up, and signs with a Model-B sr25519 posting key** (§5),
  exposing it to PAPI as a `PolkadotSigner` only at sign time.
- **Drives the CIP-8 bind**: picks the correct signing address, calls `signData`,
  enforces the §5.6 binding-key gate, and POSTs the proof to the follower (§5.5/§5.6).
  L5 **never** calls `link_identity` itself.
- **Posts** (`Microblog.post_message`, sr25519) with capacity pre-flight + pool-reject
  handling (§8.4).
- **Reads** the feed, profiles, threads, and identity via **PAPI-direct (Tier A,
  v1 baseline)**, degrading from an optional indexer (Tier B) for search/deep-paging
  (`L4-reading.md` §3).
- **Renders the live capacity battery** by replaying `current_capacity()` client-side
  (§8.5, `L4-reading.md` §5.2).
- **Derives onboarding state from reads** and surfaces the two-balance display, the
  multi-wait copy, and follower/operator liveness (§6).
- **Ships neutrality as structure**: endpoint-as-config (RPC + indexer + follower),
  PAPI-direct fallback, the two honesty badges, the "About trust" surface (§7/§8).

### 2.2 L5 does NOT

- **L5 does NOT move ADA or post/bind autonomously.** Every write is an explicit user
  signature (Cardano wallet for vault txs + the one CIP-8; sr25519 for posts). ⛔ But
  this is *not* "cannot post on your behalf" in the strong sense: for posting, L5
  generates, stores (encrypted), and **decrypts the sr25519 key in plaintext at sign
  time**, so a compromised client build (XSS / hostile host), especially with any
  device-unlock convenience on, *is* a real posting-key threat (§5.4).
- **L5 does NOT call any `FollowerOrigin`-gated extrinsic.** `link_identity` /
  `set_stake` / `revoke` are the follower's job (`L2-follower.md` §8.1, `L3-chain.md`
  §4.1/§4.2). L5 never self-binds.
- **L5 does NOT read Cardano on the post path or the capacity path.** Those read **L3
  only** (`L4-reading.md` §2.2/§5.1). Cardano is read on exactly one off-path screen
  (parked-now, optional).
- **L5 does NOT re-verify on-chain facts.** A profile's owner **Address** (DR-01) is
  **trust-inherited** from the follower (`L4-reading.md` §2.2, `L3-chain.md` §4.1/§9);
  L5 surfaces it as-is, never as L5-re-verified.
- **L5 does NOT guarantee inclusion.** A signed post can still be censored, reordered,
  delayed, or never finalized by the trusted L3 operator (`L3-chain.md` §8.1/§9,
  `ECONOMICS.md` §8). *Signed ≠ included; feeless ≠ unstoppable.*
- **L5 is NOT the source of truth** and owns no fund custody in the server sense — but
  parked ADA's *safety* still depends on L5 building correct script-spend txs (§7,
  `L1-cardano.md` §6.1/§7.1).

### 2.3 L5 DEFERS

- **The on-chain `ed25519` CIP-8 self-proof (D1).** ⛔ Note: in v1 the CIP-8 payload is
  ALREADY committed (sr25519 account + L3 genesis + nonce, DR-02) and the follower checks
  the EXACT whole-address match — so bind-hijack is prevented in v1. What remains DEFERRED
  to D1 is the **on-chain** `ed25519_verify` self-proof (so the binding is verifiable
  *without trusting the follower's verification step*), built behind a `selfProofMode` flag,
  dark until it ships (`L2-follower.md` §7.2/§9 D1, `L3-chain.md` §11 Q10).
- **Model C (Substrate extension)** as the *default* signer — offered as opt-in for
  high-value identities, default later (§5.2).
- **The indexer (Tier B)** — PAPI-direct is the v1 baseline; the indexer is a scale
  add for search/deep-pagination, not built first (`L4-reading.md` §3.3, L3 M4).
- **The optional cogno_v3 `thread_pointer` join step** — surfaced as an optional bind
  field (§5.5), wired when cogno_v3 thread joining ships (`PLAN.md` §5, M2b).
- **Self-service revocation / re-bind** — v1 revocation is **operator-mediated, weak,
  and the `revoke` call is an M2b hook that may not be live** (`L2-follower.md` §7.5,
  `L3-chain.md` §4.1 — `revoke` is the M2b revocation hook). The mnemonic backup is the
  load-bearing recovery; generate-new-and-re-bind is presented honestly as
  operator-gated and possibly unavailable (§5.7).
- **The parked-now Cardano cross-check** — an optional **Kupo** toggle (light
  Kupo/Ogmios on **preprod**, DR-31; **NO Blockfrost**, DR-33), never the sole source,
  never on the post path (§8.3).

---

## 3. Feasibility verdict (mature vs needs-care)

L5 is mostly an integration of mature, standard pieces — but four parts carry real
risk and are treated at depth below.

**Mature / standard (low risk):**

- **PAPI read/write.** Typed client, `getValue`/`getEntries`/`watchEntries`/`watchValue`,
  `finalizedBlock$`, `getPolkadotSigner` over an hdkd sr25519 keypair, `signAndSubmit`
  — the exact path `L3-chain.md` §7 and `L4-reading.md` §4.2 specify. Standard.
- **MeshJS CIP-30 connect + tx building.** `BrowserWallet`, `MeshTxBuilder`,
  `mint`/`spend` Plutus V3 recipes, `signData` — turnkey for the type-1 address and
  the mint/spend flows (`L1-cardano.md` §3 calls type-1 construction "turnkey in Mesh").
- **Static-export Next.js SPA.** No SSR data dependency, no server secrets; the read
  layer is client-only. Standard.
- **The client-side capacity replay.** A pure re-implementation of a settled pure
  function (`L4-reading.md` §5.2) — standard once the edge cases are honored.

**Needs care (the four crux areas):**

1. **The dual-key model + Model-B browser key custody (§5).** The novel UX risk is a
   user conflating identity (Cardano wallet) with posting (sr25519), and the novel
   *security* risk is that Model B holds the **plaintext seed at sign time in a
   same-origin SPA** — an XSS/supply-chain compromise = full posting-key theft (§5.4).
   This demands a first-class threat model, CSP/SRI, no plaintext-by-default device
   unlock, and worker isolation — not a one-liner.
2. **The binding-key correctness gate (§5.5/§5.6).** ⛔ RESOLVED upstream (DR-01/DR-02):
   the credential-kind question is gone (the identity is the whole owner **Address**), and
   the v1 bind is **prevented**, not merely detected — the CIP-8 proof commits to your
   sr25519 account and the follower enforces an **exact whole-address match** (recovered
   signing address == reconstructed `datum.owner`). The §5.6 pre-flight is still a real
   release gate (pick a user-controlled, non-vault, non-extended-key signing address;
   reconstruct and match the whole `datum.owner`), and the `AccountOf` readback remains as
   belt-and-suspenders — but the "blocking open question / detection-only" framing is no
   longer true.
3. **MeshJS vault-tx correctness (§7).** ⛔ The old "L1 hash-cycle" is GONE (DR-18: ONE
   merged `talk_vault(min_lock)` validator, `policy_id == vault script hash`). The
   remaining footguns are the type-1 `0b0001` header, the exact mint/datum/value shapes,
   the **stake-cred-equality** check (`vault_address.stake_cred == datum.owner.stake_cred`,
   DR-01), and the token-set / datum freeze on top-up (`L1-cardano.md` §7.10/§7.3) — all
   creator-only: a wrong hash or wrong address sends the creator's own ADA to an unspendable
   place. Pre-flight and boot-time re-assertion are mandatory.
4. **Capacity honesty + latency UX (§6/§8).** The replay must fail-closed and never
   produce a false-ready timer; the FSM must keep the three post-bind waits distinct,
   make the asymmetric unlock clamp first-class, and route the unbound-user pool reject
   to onboarding (not a countdown). These are the two failure modes the whole design
   refuses: silently re-centralizing reads and silently lying about capacity.

---

## 4. Architecture

### 4.1 Component / module map

L5 is a **static-export Next.js SPA** organized into typed libs + a token-driven
component layer. Three external shoulders: the **Cardano wallet** (CIP-30, via
MeshJS), the **L3 node(s)** (PAPI/WS), and the **follower HTTP endpoint** (one POST,
onboarding only). The keystore + sr25519 signer live in an **isolated worker** (§5.4).

```
  ┌────────────────────────────────────────────────────────────────────────────────┐
  │                              L5  (static Next.js SPA)                              │
  │                                                                                   │
  │  COMPONENTS (token-driven, bespoke widgets)                                       │
  │   <BrowseShell>  <Feed>  <Thread>  <Composer>  <ProfilePage>                       │
  │   <CapacityBattery>  <IdentityRail>  <TwoBalances>  <OnboardingStepper>            │
  │   <ProvenanceLine>  <EndpointSettings>  <TrustExplainer>  <RecoveryFlow>           │
  │                                   │                                               │
  │  STATE / HOOKS                    │                                               │
  │   useOnboardingState  (FSM, DERIVED-FROM-READS; persists only in-flight tx hashes)│
  │   useCapacity         (watchValue + interpolation tick; fail-closed on metadata)  │
  │   useReadProvider     (Tier-B indexer if reachable, else Tier-A PAPI-direct)       │
  │   useDualKey          (cardanoWallet | postingKey — two never-conflated identities)│
  │   useFollowerHealth   (cursor freshness → "pending" vs "service delayed")          │
  │                                   │                                               │
  │  lib/cardano (MeshJS)      lib/chain (PAPI)         lib/keystore  (ISOLATED WORKER)│
  │   wallet.ts  scripts.ts     client.ts (boot guard)   create / encrypt / backup /   │
  │   txs.ts     preflight.ts   signer.ts (sr25519)      decrypt-at-sign / zeroize     │
  │   cip8.ts (bind proof)      post.ts   reads.ts       lib/follower (one HTTPS POST + │
  │                             capacity.ts (§8.5 replay)   AccountOf readback check)   │
  │  lib/design (CSS-var tokens; the ONLY source of color/radius/shadow/motion)        │
  └───────┬───────────────────────────────┬───────────────────────────┬──────────────┘
          │ CIP-30 (connect, addresses,    │ PAPI / WS :9944           │ HTTPS-ONLY (config,
          │ signData ONCE, build vault tx) │ reads + the post path     │ list-capable, ONE POST)
          ▼                                ▼                           ▼
   ┌──────────────┐                ┌──────────────────┐         ┌──────────────────┐
   │ Cardano wallet│               │ L3 node(s)        │         │ Cogno-Follower    │
   │ (Eternl/Lace) │               │ (endpoint-as-cfg) │         │ (TRUSTED oracle,  │
   │ self-custodial│               │  + optional       │         │  v1, SPOF — binds │
   └──────┬───────┘                │  L4 indexer(s)    │         │  + sets rate)     │
          │ submit vault tx        └──────────────────┘         └──────────────────┘
          ▼
   ┌──────────────┐
   │ Cardano L1   │  talk_vault + beacon (L1)
   └──────────────┘
```

### 4.2 The L1 ↔ L5 ↔ L3/L4 data flow

```
  ONBOARD (one-time, the FSM of §6)
  ─────────────────────────────────
   user ── connect wallet ──▶ L5
   L5 ── ONE talk_vault validator: mint beacon(+1) + lock ≥100 ADA to script addr ──▶ Cardano L1
        (datum {owner:Address}; vault stake_cred==datum.owner.stake_cred; beacon to OWN addr;
         beacon_name=blake2b_256(owner Address); ⛔ confirm NOT permanent — bury before bind, §6.2)
   L5 ── generate random sr25519 + AES-GCM encrypt + MANDATORY mnemonic backup ──▶ IndexedDB
   L5 ── pick user addr == datum.owner; signData over COMMITTED PAYLOAD ──▶ Cardano wallet
        (payload commits {sr25519 acct + L3 genesis + nonce}; ⛔ never the vault address;
         follower asserts recovered signing addr == reconstructed datum.owner, §5.6)
   L5 ── POST {cose_sign1_blob, signing_address, sr25519_pubkey, thread_pointer?} ──▶ Follower
   Follower ── verify CIP-8 (pycardano) + whole-addr match + payload-sr25519==submitted,
               link_identity (FollowerOrigin) ──▶ L3 CognoGate
   Follower ── observe vault, bury past k, largest-wins, set_stake ──▶ L3 TalkStake
   L5 ── poll AccountOf[id32]==MY sr25519 acct? ──▶ L3 (belt-and-suspenders, §5.4)

  POST + READ (steady state — L3 ONLY, never Cardano)
  ───────────────────────────────────────────────────
   L5 ── current_capacity() replay (advisory) ──▶ enable/disable submit
   L5 ── post_message(text,parent) signed by sr25519 ──▶ L3 pool CheckCapacity::validate()
        (⛔ pool is the gate; have<need OR unbound ⇒ ExhaustsResources, §8.4)
   L3 ── PostCreated / Posts / ByAuthor / Capacity ──▶ L5 (PAPI watchEntries / getValue)
   L5 ── threads rebuilt client-side from Post.parent (tolerate dangling/tombstoned) ──▶ Feed
```

### 4.3 Tech stack (chosen)

- **Next.js (static export, App Router, client components).** No SSR data fetch, no
  server secrets, no required backend. `output: 'export'` → a static bundle hostable on
  IPFS or any static host (§8.4). Build is reproducible and the build hash is published
  (so self-hosters can verify the artifact — this doubles as the custody-integrity story
  for Model B, §5.4).
- **MeshJS** — `@meshsdk/core` (`BrowserWallet`, `MeshTxBuilder`) + `@meshsdk/core-cst`
  (`applyParamsToScript`, `resolveScriptHash`, `serializeAddressObj`/`scriptHashToBech32`,
  `deserializeBech32Address`, `CoseSign1`, `blake2b`) for the Cardano side (§7).
- **polkadot-api (PAPI)** — `polkadot-api`, `polkadot-api/ws-provider/web`, generated
  `@polkadot-api/descriptors` (`npx papi add cogno -w <ws>`; `npx papi`), and
  `@polkadot-labs/hdkd` + `@polkadot-labs/hdkd-helpers` for sr25519 derive + signer (§8).
- **WebCrypto (SubtleCrypto)** — AES-GCM + the passphrase KDF for the keystore; the
  sr25519 *signature* itself is done by hdkd (sr25519 is not a WebCrypto primitive), so
  WebCrypto encrypts the **seed bytes**, not the signature (§5.2).
- **Hand-authored CSS-variable token layer** (`lib/design`) — the only sanctioned source
  of color/radius/shadow/motion; bespoke widgets; no component library (§7-visual, Part B).

---

## 5. The DUAL-KEY model & sr25519 posting-key management

This is the central crux. Two keys with two jobs, two custody models, two visual
languages — and the one place v1's trust posture is easiest to overstate.

### 5.1 Two identities, two widgets, two visual languages

| | **Cardano wallet (identity + stake)** | **sr25519 posting key** |
|---|---|---|
| What it is | CIP-30 wallet; the **whole base Address** (payment VKey + stake cred) IS `datum.owner` (DR-01) | A **random** sr25519 keypair generated in-browser |
| Custody | **Self-custodial**; keys never leave the wallet | App-managed at-rest (AES-GCM); **plaintext in worker memory only at sign time** (§5.4) |
| Signs | CIP-8 `signData` **exactly once** at bind; the vault txs | **Every** `post_message`; nothing else |
| Permanence | Permanent root that controls ADA + the vault | Disposable / rotatable; recoverable by mnemonic, else by re-bind (§5.7) |
| Surfaced as | A **"seal"** chip (identity/stake), owner **Address** short-hash (DR-01) | A **"key"** chip (posting), ss58 short, "rotate / back up / forget" |

The persistent **`<IdentityRail>`** renders the two with distinct shapes/colors
(`--identity-cardano` vs `--identity-substrate`) so a user can never think the Cardano
wallet posts. The composer's submit area **always** echoes **"Signing as
`<ss58-short>`."** This mirrors L4's two-balances discipline (`L4-reading.md` §5.1) at
the key layer. ⛔ At every key-loss surface, show the reassurance: **"Losing this
posting key does NOT risk your ADA — your funds stay in your self-custodial Cardano
vault; you can withdraw anytime and bind a new posting key"** (§5.7).

### 5.2 SETTLED DECISION — Model B keystore

- **Generate** a **random** sr25519 key in-browser via `@polkadot-labs/hdkd-helpers`
  (`sr25519CreateDerive(mnemonicToEntropy(generateMnemonic()))(...)` over an hdkd
  keypair). ⛔ Use a CSPRNG-sourced mnemonic; never derive the seed from any wallet
  signature (see §5.3 — the rejected Model A leak).
- **Encrypt** the seed with **AES-GCM** under a key derived from a user passphrase via a
  **KDF = Argon2id** (DR-28a; WebCrypto AES-GCM for the cipher, an Argon2id implementation
  for the KDF since `crypto.subtle.deriveKey` does not expose Argon2id natively). Persist
  `{ ciphertext, salt, iv, kdfParams, sr25519_pubkey }` in IndexedDB. sr25519 is not a
  WebCrypto algorithm, so we encrypt the **seed bytes**; the signature is done by hdkd at
  sign time. ⛔ **No plaintext device-unlock default** (DR-28a): a passphrase (Argon2id) is
  required on every device; any convenience mode is opt-in, time-boxed, memory-only, and
  cleared on tab blur (§5.4).
- **Force a mnemonic backup** during onboarding (the seed's recovery phrase). ⛔ This is
  the **load-bearing recovery** path — the only one that does **not** depend on an
  operator-mediated revoke (§5.7).
- **Decrypt only at sign time, in the isolated keystore worker, then zeroize.** The
  plaintext seed is never persisted in plaintext and is held in worker memory only
  transiently; the buffer is overwritten immediately after each sign (§5.4).

**Why not Model A (derive the seed from a CIP-8 signature):** **rejected.** CIP-8
signatures are non-deterministic across wallets and HW signers (non-canonical S,
wallet-built COSE header — `L2-follower.md` §7.4), so live re-derivation orphans the
binding; a seed derived from the bind-time signature is sent to the trusted-but-loggable
follower (`L2-follower.md` §8.5/§10), making the key effectively public; and it **cannot
rotate**.

**Why Model C (Substrate extension) is offered, not just deferred:** a second wallet
install hurts the one-wallet onboarding story for a *low-value* key, so it is **not the
default** — but it is the **security-preferred path** because the seed never enters this
SPA's memory, sidestepping the §5.4 XSS-fatality entirely. v1 **offers it as opt-in for
high-value identities** behind the same `PolkadotSigner` interface (so no rework when it
becomes default later).

### 5.3 ⛔ No "single-root from a wallet signature" carve-out

Do **not** seed the keystore from any wallet/CIP-8 signature, not even once on first
run. If the seeding signature is the same one later sent to the follower as the bind
proof, the seed becomes a deterministic function of a value the trusted-but-loggable
follower receives — exactly the Model-A leak (§5.2). Even a *separate* `signData` call
is fragile: CIP-8 is non-deterministic across wallets/HW (`L2-follower.md` §7.4), so the
"single root" is not reproducible, and any signature the wallet can be induced to
reproduce becomes a seed-recovery oracle. **Generate a CSPRNG seed and stop.**

### 5.4 ⛔ The browser threat model (Model B is XSS-fatal — name it)

Model B's encryption protects the key **at rest and across sites**. It does **NOT**
protect against same-origin script. In a static-hosted SPA (§8.4) that pulls large
dependency trees (MeshJS, polkadot-api, and their transitive deps), an XSS **or one
compromised npm dependency** runs in the same origin and can:

1. read the IndexedDB ciphertext **and** keylog the passphrase at the decrypt prompt,
   exfiltrating the seed;
2. if any "remember this device" plaintext-in-memory mode is on, read the plaintext
   seed straight out of memory with **zero** passphrase;
3. silently swap the `text`/`parent` of a `post_message`, or present a malicious bind.

A stolen posting key = **full impersonation of that identity's voice** until a
follower-mediated re-bind, which is operator-gated and possibly unavailable (§5.7). The
"low-value / rotatable / feeless" framing does **not** wave this away. v1 **requirements**
(not nice-to-haves):

- **Strict Content-Security-Policy** shipped with the static export: no inline scripts,
  no `eval`, pinned `script-src`, locked `connect-src` to the configured endpoint origins.
- **Subresource Integrity + lockfile-pinned, audited deps**; publish the build hash so
  self-hosters can verify the artifact byte-for-byte (§4.3).
- **NO "remember this device" default.** If offered at all, it is **opt-in, time-boxed,
  memory-only, cleared on tab blur/visibility-hidden**, never plaintext on disk.
- **Zeroize** the plaintext seed buffer immediately after each sign.
- **Isolate the keystore + signer in a dedicated Web Worker (ideally a separate
  origin/iframe)** so a post-page XSS cannot reach the seed; the worker exposes only
  "sign these exact bytes," never "give me the seed."
- **Belt-and-suspenders readback for the bind** (§5.6): poll `AccountOf` after the bind.
  (⛔ Bind-hijack itself is now *prevented* cryptographically — DR-02's committed payload +
  whole-address match — so this is a defense-in-depth check, not the sole defense.)

⛔ Trust-explainer copy (§ Part B) states this **plainly**: *"the app handles your
PLAINTEXT posting key at sign time; an XSS in this client can steal it. For high-value
identities, use the Substrate-extension signer (Model C)."* Never write the misleading
"app only touches the at-rest-encrypted key."

### 5.5 The bind proof — a COMMITTED payload + an EXACT whole-address match (DR-02/DR-01)

⛔ **v1 anti-replay is the COMMITTED CIP-8 payload, and the bind is keyed on the WHOLE
owner Address.** (This is DR-02 — it SUPERSEDES the earlier "follower-issued opaque
server-cache nonce, no payload commitment" design that lived in this section.) The fixed
order is **create key → fetch nonce → sign the committed payload → submit**:

1. **Create + back up** the sr25519 key (§5.2) — it must exist *before* signing so the
   user is binding a key they hold (its account must go *into* the signed payload).
2. **Fetch a fresh nonce** from the follower (300s TTL, `L2-follower.md` §7.1).
3. **Build the committed payload and sign it.** The signed bytes are **domain-separated
   bytes committing `{ sr25519 account + L3 genesis hash + fresh nonce }`** (DR-02), signed
   via `wallet.signData(addr, payloadBytes)` from the **correct** address (§5.6, == the
   whole `datum.owner`). The v1 follower verifies via `pycardano.cip.cip8.verify`
   (`verified == true`), then asserts **(a)** the recovered **signing address ==
   reconstructed `datum.owner`** (payment AND stake cred — an EXACT whole-address match,
   DR-01), and **(b)** the payload's sr25519 account == the submitted `sr25519_pubkey`
   (`L2-follower.md` §7.1). Because the payload commits to the account, a captured proof
   cannot be replayed to bind a different account, and the follower cannot substitute one —
   **bind-hijack is prevented**, not merely detectable.
4. **POST** `{ cose_sign1_blob, signing_address, sr25519_pubkey, thread_pointer? }` over
   **HTTPS-only** to the configured follower; the follower calls the
   `FollowerOrigin`-gated `link_identity{ owner_address, thread_pointer: Option<10-hex>,
   substrate_account }` (`L2-follower.md` §8.1, `L3-chain.md` §4.1) — keyed by the 32-byte
   `blake2b_256(owner Address)` (DR-01). L5 calls **no** follower-only extrinsic.
5. **Readback (belt-and-suspenders, §5.4):** poll
   `CognoGate.AccountOf.getValue(Binary.fromBytes(id32))` — where `id32 =
   blake2b_256(serialized owner Address)` (DR-01) — and **assert it equals MY sr25519
   account** before declaring onboarding complete. With DR-02 the bind is already
   prevented; this readback is defense-in-depth against a buggy follower, and still surfaces
   a **hard error** on mismatch.

The 1:1 binding is the Sybil anchor; a second bind on **either** side is rejected
(`AccountAlreadyBound` / `PkhAlreadyBound`, `L3-chain.md` §4.1) — surface that honestly,
do not retry blindly.

**⛔ What is DEFERRED is the ON-CHAIN self-proof (D1), not payload commitment.** In v1 the
payload is ALREADY committed (sr25519 account + L3 genesis + nonce, DR-02) and the follower
enforces the whole-address match — so the binding is correct in v1. What remains DEFERRED
to D1 is the **on-chain** `ed25519_verify` self-proof (so the binding is verifiable on-chain
*without trusting the follower's verification step at all*) of `L2-follower.md` §7.2 / §9 D1
/ §12 step 8 (`L3-chain.md` §11 Q10). Build the on-chain-proof path behind a `selfProofMode`
flag that is **dark in v1**; do not present *on-chain* self-verification as a v1 guarantee.

**`thread_pointer` (optional cogno_v3 join key).** The bind interface carries an optional
`thread_pointer` — **5 raw bytes / 10 hex chars** (DR-23; `L3-chain.md` §4.1 stores
`ThreadOf` as `BoundedVec<u8, ConstU32<10>>`; `L2-follower.md` §8.1; `PLAN.md` §5).
⛔ **Never 4 bytes / never `ConstU32<4>`** (`PLAN.md` §5 warning). v1 may surface this as an
optional "link my cogno_v3 thread" step or defer the *UX* (citing M2b) — but L5 must not
silently drop a settled interface field; the POST schema includes it.

### 5.6 The binding-key correctness gate — RESOLVED to a whole-address match (DR-01/DR-02)

This is still a **real release gate** — but the framing changes: the old "BLOCKING
credential-kind open question" is **RESOLVED** (DR-01), and the old "wrong-address gotcha"
is now **structurally closed** by an exact whole-address match (DR-02).

- ⛔ **RESOLVED — the identity is the whole owner Address (DR-01).** `datum.owner` is a full
  CIP-19 Address (payment credential + stake credential); v1 restricts the payment
  credential to a `VerificationKey`. The earlier "is `owner_pkh` a payment- or
  stake-key-hash?" question (`L2-follower.md` §11 Q2 / `L3-chain.md` §1) is **gone** — the
  gate matches the **whole Address**, not a single credential, so there is no
  wrong-credential failure mode and L5 **can ship** `link_identity` onboarding.

The gate, enforced as **ALL** of (do **not** rely on MeshJS `checkSignature`, which
verifies the COSE sig against the *address* generically, not against the reconstructed
`datum.owner`):

```ts
// 1. RECONSTRUCT the owner Address from the datum (DR-01): datum.owner is a full CIP-19
//    Address (payment VerificationKey cred + stake cred). Serialize it canonically.
// 2. PICK the signing address: an address the USER CONTROLS that is EXACTLY datum.owner
//    (payment AND stake cred), AND that is type-6 (enterprise) or type-0 (base) — a normal
//    wallet addr. ⛔ REJECT any address whose PAYMENT credential is a script hash (the
//    vault script addr): header high nibble must NOT be 0b0001 / 0b0011 / 0b0111.
// 3. Build the COMMITTED payload {sr25519 account + L3 genesis + nonce} (DR-02, §5.5);
//    signData(signingAddr, payloadBytes) -> COSE_Sign1 blob.
// 4. RECOVER vk OURSELVES: CoseSign1.fromCbor(blob) -> protected/unprotected -> vk bytes.
//    ⛔ v1 accepts ONLY 32-byte CIP-30 keys; REJECT 64-byte extended (vk‖chain_code) keys
//       (L2 §7.4 extended-key note).
// 5. ASSERT the recovered SIGNING ADDRESS == the reconstructed datum.owner BYTE-FOR-BYTE
//    (whole-address match — payment cred AND stake cred, DR-01/DR-02). This is what the
//    follower also enforces; it STRUCTURALLY closes the old "wrong-address" gotcha.
//    (Equivalently: blake2b224(vk) == datum.owner's payment-VKey cred AND the stake cred
//     matches — but match the WHOLE Address, never just the payment part.)
// 6. HARD-BLOCK submit on ANY mismatch, on a script-payment signing address, or on a
//    64-byte key. Surface the specific error (wrong_cip8_address), never a generic toast.
```

⛔ **Verifier note (v1 vs deferred).** In v1 the **only** verifier is the follower's
`pycardano.cip.cip8.verify` (`L2-follower.md` §7.1); L5's job is the pre-flight above plus
building the committed payload (DR-02). The "pin one canonical verifier semantics
(ed25519-zebra vs libsodium)" concern belongs to the **deferred on-chain self-proof**
(`L2-follower.md` §7.2/§7.4) — there is no v1 L5-vs-follower borderline-signature split to
reconcile, because both rely on the same pycardano path. The 32-byte-only restriction is a
sound v1 simplification regardless.

⛔ **Release gate:** add the **wrong-address negative test** (`L2-follower.md` §12 step 5)
as an L5 release gate — onboarding signing from the vault address, or from any address that
is **not** exactly `datum.owner` (wrong payment OR wrong stake cred), MUST be blocked
before submit.

### 5.7 The sr25519 → PAPI signer adapter

At sign time the keystore worker decrypts the seed → builds an hdkd keypair → exposes a
`PolkadotSigner` via `getPolkadotSigner(pubkey, "Sr25519", signFn)` → passed to
`api.tx.Microblog.post_message(...).signAndSubmit(signer)` (`L3-chain.md` §7,
`PLAN.md` §5). **No popup per post** (correct for a feeless chain). The CIP-30 `signData`
path is used **once at bind, never on the post path** (`L4-reading.md` §4.2). The seed
buffer is zeroized after each sign (§5.4).

### 5.8 Recovery (honest about the v1 limits)

- **Restore from mnemonic** — the **primary, load-bearing** path, no follower needed.
  Re-import the phrase → re-encrypt as a fresh Model-B keystore → the same sr25519
  account resumes (the binding still points at it). Surface this prominently as
  "your funds were never at risk."
- **Generate-new-and-re-bind — operator-gated and possibly unavailable in v1.** Create a
  fresh key and submit a new CIP-8 proof. ⛔ But the 1:1 binding makes a naive re-bind
  fail `PkhAlreadyBound` (`L3-chain.md` §4.1); clearing the old binding needs an
  **operator-mediated revoke**, and **revocation is weak and manual in v1**
  (`L2-follower.md` §7.5) — the `revoke` call is an **M2b hook** (`L3-chain.md` §4.1),
  not a guaranteed-live v1 dispatchable. So:
  - Do **not** present re-bind as a self-service one-click action.
  - State plainly: **in v1 a lost key with no mnemonic backup may be stranded until/unless
    an operator-mediated revoke ships; until revoke lands the OLD binding holds
    (`PkhAlreadyBound`).** Show the real request channel + SLA (open question, §9).
  - ⛔ Reassure at this exact moment of fear: **your ADA is safe in the self-custodial
    vault and fully reclaimable** — only the *posting voice* is affected. A `PkhAlreadyBound`
    is **not** fund loss.

---

## 6. The onboarding STATE MACHINE

### 6.1 Principle: derive state from reads; persist only in-flight tx markers

A stored enum desyncs on reconnect; almost every state is a pure function of public
reads. Each render computes the state from a **read bundle**:
`{ cardanoVault (beacon UTxO, confirmed + buried + tip depth), PkhOf[acct],
AllowedStake[acct], Capacity[acct], finalizedBlock, followerCursorAge }`. The **only**
persisted state is in-flight tx markers (tx hash + timeout) and the **partial-withdraw
inter-tx marker** (§7.6) so a refresh recovers truth (`L4-reading.md` §5). ⛔ **Never
cache a Cardano confirm as permanent — a rollback un-confirms** (`L1-cardano.md` §10.3,
`L2-follower.md` §6.2). The **browse track is fully decoupled**: any state (including
`no_wallet`) can read the feed at all times (reads are open, `L4-reading.md` §3.1); the
FSM gates **only** the write path.

### 6.2 States, advancing reads, and honest copy

```
  no_wallet ──connect──▶ wallet_connected
                              │ (no beacon UTxO named blake2b_256(owner Address), DR-01)
                              ▼
                          no_vault ──MeshJS createVault tx──▶ vault_tx_seen (0-conf, optimistic marker)
                                                                  │ (included on Cardano)
                                                                  ▼
                                              vault_confirming  ── depth < k:
                                                  │              "Deposit confirming on Cardano; it must
                                                  │               bury ~k blocks before it counts. A short
                                                  │               rollback can still un-confirm it."
                                                  │ (buried past k OR user accepts shallow-confirm risk)
                                                  ▼
                                              vault_buried_unbound
                                                  │ (keystore created + mnemonic backed up + nonce fetched)
                                                  ▼
                                              cip8_signing ──POST to follower──▶ binding_pending
                                                  │ (poll PkhOf; FOLLOWER latency)        │
                                                  ▼                                       │
   ┌──── PkhOf[acct].isSome  AND  AccountOf[id32]==MY acct (⛔ belt-and-suspenders readback,
   │       id32=blake2b_256(owner Address); bind itself PREVENTED by DR-02, §5.4) ◀─────────┘
   │       (mismatch ⇒ ERROR bound_to_wrong_key — operator revoke needed, §5.7)
   ▼
  bound_but_no_weight  ── AllowedStake==0: "Pending burial (~k blocks, up to ~Xh).
        │                  Last follower activity: Nm ago."  (BURIAL latency, L2 §6.2/§8.2)
        │ (AllowedStake > 0)
        ▼
  weight_granted_charging ── Capacity charging from 0 (None⇒0). First-post wait DEPENDS on the
        │                     onboarding sweetener (ECONOMICS §6.2 / L3 §11 Q3 — OPEN): a one-time
        │                     free allowance, a low BaseCost first post, or a short charge-up.
        │                     Derive the copy from metadata, do not assert a wait.
        │ (current_capacity >= post_cost(draft))
        ▼
  ready_to_post ──post (sr25519)──▶ posting ──(included)──▶ ready_to_post
        │
        │ (user unlocks vault on Cardano — fullExit)
        ▼
  unlocking ── ⛔ STAYS here until AllowedStake reads 0 (asymmetric clamp, L2 §8.2):
        │       voice persists until the spend buries past k AND set_stake{0} lands.
        │       "Your posting voice is removed only after the follower observes and clamps.
        │        During a follower outage this delay is UNBOUNDED."  (never show 'left' on spend submit)
        ▼
  unbound_after_unlock

  PARTIAL-WITHDRAW TRACK (a multi-step orchestrator, §7.6 — durable marker survives refresh):
   ready_to_post ──tx1 fullExit/burn──▶ pw_step2_required
        │  ⛔ "Step 2 of 2 required: re-lock X ADA or your vault stays closed and your posting
        │     voice stays at 0. You are fully unlocked until tx2 buries + re-grants."
        ▼ (tx2 createVault@smaller) ──▶ vault_confirming (re-enters the funding waits)

  ERROR SET (finite, each with SPECIFIC copy, never a generic toast):
   wrong_cip8_address (L2 §7.4)  ·  below_floor (<100 ADA, L1 §6.1)  ·
   bound_to_wrong_key (AccountOf readback mismatch — operator revoke, §5.4/§5.7)  ·
   pkh_already_bound (re-bind needs operator revoke first; NOT fund loss, §5.7)  ·
   follower_unreachable (onboarding only — reads + existing posters unaffected, §6.4)  ·
   follower_delayed (cursor stale beyond SLA — "service delayed", not "broken", §6.4)  ·
   over_budget (ExhaustsResources + bound + weight>0 + need<=cap — normal feeless wait)  ·
   too_long_for_capacity (need>cap — shorten or raise weight; NOT a timer, §8.5)  ·
   not_onboarded (ExhaustsResources + unbound/zero-weight — "finish onboarding", §8.4)  ·
   network_busy (ExhaustsResources + have>=need locally — block congestion, §8.4)  ·
   cardano_rollback (un-confirm; drop to vault_confirming/no_vault and recompute, §6.2)
```

### 6.3 The two (then three) post-bind waits the FSM must NOT collapse

After CIP-8 there are **two distinct waits** (`L3-chain.md` §2.2, `L2-follower.md`
§8.2): (1) **follower latency** until `PkhOf` becomes `Some` (`binding_pending` →
`bound_but_no_weight`), and (2) **burial latency** past depth *k* until `AllowedStake`
goes positive (`bound_but_no_weight` → `weight_granted_charging`). Then a **third**
wait: **capacity charges from 0** before the first post is affordable (`None ⇒ 0`) —
**unless** the chosen onboarding sweetener removes it (`ECONOMICS.md` §6.2, `L3-chain.md`
§11 Q3 — OPEN; the copy is conditional on metadata, not hard-coded). One "setting up"
spinner makes a bound, weight-zero user look stuck — render the three as distinct steps.

⛔ **Bound the open-ended waits honestly.** Translate "~k blocks" into wall-clock
(`k × Cardano slot time`, "up to ~Xh"; *k* ≈ 2160 ≈ ~12h is the upper end,
`L2-follower.md` §11 Q3). Surface **follower liveness** (poll the follower's published
audit-event `cursor_slot` / last `IdentityLinked`/`StakeSet` timestamp, `L2-follower.md`
§9/§12 step 7) as "last follower activity: Nm ago," so a user in `bound_but_no_weight`
can tell **normally-pending** from **the trusted oracle is down**. If the cursor is stale
beyond an SLA, downgrade copy from "pending" to "onboarding service appears delayed" — do
**not** claim it's broken (`L2-follower.md` §8.2/§10).

### 6.4 The follower-down decomposition (load-bearing honesty)

Follower-down is **not app-down** (`L2-follower.md` §10): **reads keep working**
(L3-only/PAPI), and **existing posters keep posting** (their sr25519 key signs locally;
their already-written `AllowedStake` is L3 state, not follower-gated per-post). **Only new
onboarding (`link_identity`) and weight updates (`set_stake`) stall.** Render
"Onboarding temporarily unavailable — reading and posting are unaffected." ⛔ **Never gate
reads or the post path behind a follower health check.**

⛔ **But qualify "posting unaffected" honestly — the asymmetric window.** An account that
has **already unlocked** its Cardano vault is also an "existing poster" whose
`AllowedStake` is **stale-positive**: while the follower is down, the clamp-on-unlock
stalls, so it **retains posting voice it no longer backs** until the follower recovers and
backfills the clamp first (`L2-follower.md` §8.2(ii)/§8.4/§10). This is a present-tense
trust limit — surface it in the `unlocking` state copy (§6.2, "delay is unbounded if the
follower is down") **and** name it in the trust explainer (Part B).

### 6.5 The two-balance display, in the FSM

Everywhere a balance appears, render **two distinct rows** (`L4-reading.md` §5.1/§8):
**"Parked now: X ADA (Cardano, live)"** (optional, off-path, §8.3) vs **"Counted for
posting: Y ADA (as of #N)"** with a "pending burial (~k blocks)" note while
`bound_but_no_weight`. ⛔ The hero posting number is **always** the `AllowedStake`/
capacity-derived value — never the live ADA — re-creating the §8 two-balance discipline
at the design layer.

---

## 7. Cardano tx recipes (MeshJS)

All Cardano interaction is MeshJS: `BrowserWallet` (connect, addresses, `signData`),
`MeshTxBuilder` (txs), `@meshsdk/core-cst` (`applyParamsToScript`, `resolveScriptHash`,
`blake2b`, `deserializeBech32Address`, `scriptHashToBech32`/`serializeAddressObj`,
`CoseSign1`).

### 7.1 `lib/cardano/scripts.ts` — ONE merged `talk_vault(min_lock)` hash, cached as constants

⛔ **DR-18 (merged single validator) SUPERSEDES the old "break the hash cycle" design.**
There is now **ONE** validator `talk_vault(min_lock)` carrying BOTH a mint handler and a
spend handler (the cogno_v3 `thread.ak` shape); its **`policy_id == vault script hash`** and
the mint arm asserts the beacon lands at the script's **own** address. There is **no
separate beacon minting policy, no `beacon_policy_id` parameter, and no hash cycle** —
derivation is a single `applyParamsToScript(min_lock)` → one hash:

```ts
// 1. ONE validator: apply min_lock ONLY -> one hash. policy_id == vault script hash (DR-18).
const vaultCbor = applyParamsToScript(talkVaultBlueprint.compiledCode,
                                      [{ int: 100_000_000 }], "JSON");
const vaultHash = resolveScriptHash(vaultCbor /* V3 */);   // == the beacon policy id
const beaconPolicyId = vaultHash;                          // ⛔ they are THE SAME hash (DR-18)
// 2. script-payment address = Script(vaultHash) + the user's OWN stake cred. ⛔ The stake cred
//    MUST equal datum.owner.stake_cred (DR-01) so the locked ADA delegates with the identity.
const stakeCred = deserializeBech32Address(usedAddress).stakeCredentialHash; // == datum.owner.stake_cred
const baseAddr  = scriptHashToBech32(vaultHash, stakeCred, networkId);       // script-stake flag FALSE
// 3. ⛔ ASSERT the header high nibble is 0b0001 (script-payment + key-stake, L1 §4.2):
assert((firstHeaderByte(baseAddr) >> 4) === 0b0001);
// 4. beacon_name = blake2b_256(serialized owner Address) — EXACTLY 32 bytes, NO CIP-67 label
//    (DR-01; == the L3 identity key id32). The whole CIP-19 owner Address is the preimage.
```

⛔ **Pin the `applyParamsToScript` argument types explicitly** (`Int → {int}`): a shape
mismatch **silently** yields a wrong hash (`L1-cardano.md` §9.2). ⛔ **Cache**
`{ vault_cbor, vault_hash (== beacon_policy_id) }` as deployment constants verified against
the blueprint, and **re-assert at app boot** that recomputing from `min_lock` reproduces
them (catch a wrong constant once, loudly).

⛔ **One derivation now drives BOTH keys (DR-01).** The **Cardano beacon `token_name`** and
the **L3 `CognoGate` identity key** are the **SAME** 32-byte value: `id32 =
blake2b_256(serialized owner Address)` (used for the beacon name AND for
`PkhOf`/`AccountOf`, `L3-chain.md` §4.1; Kupo lookups, §8.3). The old "two lengths — 28-byte
`owner_pkh` for L3 vs 32-byte hash for the beacon — never cross them" rule is **gone**: both
are the 32-byte address hash.

### 7.2 The owner Address (DR-01)

`datum.owner` is the **whole CIP-19 base Address** — payment `VerificationKey` credential +
stake credential — obtained from the connected wallet's used address
(`deserializeBech32Address(usedAddress)` yields both the payment key-hash and the stake
cred). ⛔ **RESOLVED (DR-01):** the identity is the Address, not a single `owner_pkh`; v1
restricts the payment credential to a `VerificationKey`. Serialize the whole Address
canonically to compute `id32 = blake2b_256(Address)` (the beacon name + the L3 key) and to
build the script-payment vault address (whose stake cred MUST equal `datum.owner.stake_cred`,
§7.1). (Do not use `resolvePaymentKeyHash`.)

### 7.3 `createVault` — mint beacon (+1) via the merged validator + pay ≥100 ADA + beacon to the script addr

⛔ The beacon is minted by the **merged `talk_vault` validator's mint handler** (DR-18) —
`policy == vaultHash`, **not** a separate beacon policy. `mintPlutusScriptV3` (mint 1 beacon
under `mintingScript(vaultCbor)`, redeemer = the mint arm carrying the owner **Address**) ·
`requiredSignerHash(owner payment VKey hash)` · `txOut(scriptAddr, [100_000_000 lovelace +
1 beacon])` with `txOutInlineDatumValue(conStr(...owner Address...))` (the `VaultDatum {
owner: Address }`, DR-01) · collateral · `selectUtxosFrom` · change addr · `complete` ·
sign · submit (`L1-cardano.md` §6.1). The mint arm asserts the beacon lands at the script's
**own** address and the owner-sig + datum + value + **stake-cred-equality**
(`vault_address.stake_cred == datum.owner.stake_cred`, DR-01) invariants are mint-time
checks (`L1-cardano.md` §6.1/§7.8). ⛔ A sub-floor, wrong-address, or mismatched-stake-cred
create loses only the **creator's own** ADA — but L5 prevents it outright in pre-flight (§7.7).

### 7.4 `topUp` — grow the vault (one continuing output, everything else frozen)

`spendPlutusScriptV3` · `txIn(vaultUtxo)` · `txInScript(vaultCbor)` ·
`txInInlineDatumPresent` · `txInRedeemerValue(mConStr0([]))` (Spend) ·
`requiredSignerHash(owner payment VKey hash)` · **one continuing output** to the same
script addr with **grown lovelace**, the **same beacon carried forward**, the **frozen
`VaultDatum { owner: Address }`**, and the **same stake cred**
(`vault_address.stake_cred == datum.owner.stake_cred` re-asserted on the continuation,
DR-01) (`L1-cardano.md` §6.2). ⛔ Value must be **non-decreasing**, the beacon
`quantity == 1` must ride in the **continuation**, the **non-ADA token set must be EXACTLY
equal** (`without_lovelace(cont) == without_lovelace(in)`, `L1-cardano.md` §7.10 — no second
beacon, no foreign token, no strip), and the **datum bytes must be byte-equal**
(`L1-cardano.md` §7.3). Pre-flight these like create (§7.7).

### 7.5 `fullExit` — spend with no continuation + burn beacon (−1)

Spend with **no continuing output** **and** `mint -1` (under the **merged validator's**
policy, `policy == vaultHash`, DR-18) with `mConStr1([beacon_name])` (`Burn(name)`); reclaim
all ADA to the user's wallet. Full exit BURNS the beacon (`L1-cardano.md` §6.4); requires the
owner signer. ⛔ The burned `name` MUST be derived from **this** vault's datum
(`blake2b_256(serialized this.owner Address)`, DR-01) so a tx cannot burn-A-while-exiting-B
(`L1-cardano.md` §7.11).

### 7.6 `partialWithdraw` — TWO sequential txs (a durable orchestrator)

A one-tx shrink is **impossible** (`L1-cardano.md` §6.3: the continuation cannot shrink,
and a same-name burn+remint fails the redeemer uniqueness guard). It is **tx1 = fullExit
(burn)** then **tx2 = createVault at the smaller (still ≥100 ADA) amount**. L5 exposes
this as a **multi-step FSM track with a durable marker** (§6.2 `pw_step2_required`):

- ⛔ **Pre-flight before tx1 is signed:** assert the wallet will hold **≥ the re-lock
  amount + fees** after tx1, so the user cannot strand themselves with no ADA for tx2.
- ⛔ **Persist `{ intended_relock_amount, tx1_hash }`** so a refresh / wallet failure
  after tx1 can **resume tx2**; on reload, detect the burned beacon / reclaimed UTxO and
  resume.
- ⛔ **Hard FSM gate, not just copy:** require an explicit two-signature acknowledgement
  that this is two independent signatures with a **voice-gap** (weight clamps to 0 after
  tx1 buries, `L2-follower.md` §8.2 / `L1-cardano.md` §6.4) and re-charges across the gap.
  This also defends against a phisher framing tx1 alone as "confirm withdrawal" to achieve
  a full unlock + voice-loss — the UI makes the gap unmistakable.

### 7.7 `lib/cardano/preflight.ts` — assert before EVERY submit

Refuse `signAndSubmit` on any mismatch (`L1-cardano.md` §6.1/§7):

- **create:** `lovelace >= 100_000_000` · `VaultDatum { owner: Address }` datum shape
  (DR-01) · **exactly two value units** (ADA + the one beacon) · `beacon_name ==
  blake2b_256(serialized owner Address)` (32 bytes, DR-01) · `requiredSigner ==
  datum.owner`'s payment VKey hash.
- ⛔ **on the output ADDRESS (create + topUp continuation):** assert the header high
  nibble `== 0b0001` (`L1-cardano.md` §4.2), the **payment cred == the cached,
  boot-verified `vault_hash`** (== `beacon_policy_id`, DR-18), and the **stake cred ==
  `datum.owner.stake_cred`** (DR-01, `deserializeBech32Address`). This catches a per-tx
  address built from a stale/wrong cached constant AND a vault whose stake cred would not
  delegate with the identity — the boot re-assert (§7.1) catches a wrong constant *once*,
  this catches a stale-constant / wrong-stake-cred *use* (`L1-cardano.md` §9.2
  type-coercion footgun).
- ⛔ **topUp continuation:** `lovelace(cont) >= lovelace(in)` · `without_lovelace(cont)
  == without_lovelace(in)` (exact non-ADA token-set match, `L1-cardano.md` §7.10) ·
  `cont.datum` byte-equal to `in.datum` (`L1-cardano.md` §7.3) · `cont.stake_cred ==
  datum.owner.stake_cred` (DR-01) · beacon `quantity == 1`.
- **fullExit:** `mint == -1` under the **merged validator's policy** (`policy == vaultHash`,
  DR-18) of `(vaultHash, beacon_name)` with `name` from this datum · no continuing output to
  the script · beacon in no output.

### 7.8 `lib/cardano/cip8.ts` — the bind proof (the §5.6 gate)

`signData` over the **committed payload** `{ sr25519 account + L3 genesis + nonce }` (DR-02)
from the address that is **exactly `datum.owner`** (whole Address — payment AND stake cred,
DR-01) and is **type-6/type-0** (not the vault script addr) → recover `vk` via
`CoseSign1.fromCbor` ourselves → assert the **recovered signing address == reconstructed
`datum.owner`** byte-for-byte (whole-address match, DR-01/DR-02) → reject 64-byte extended
keys → hard-block on any mismatch. ⛔ Do **not** rely on `checkSignature` for the gate (it
verifies the *address* generically, not against the reconstructed `datum.owner`). See
§5.5/§5.6 for the full order; the old "BLOCKING credential-kind dependency" is RESOLVED
(DR-01).

---

## 8. Substrate post + read + the capacity widget (PAPI)

### 8.1 `lib/chain/client.ts` + the read/write-aware boot metadata guard

`createClient(getWsProvider(<config ws URL>))` → `getTypedApi(cogno)` (descriptors from
`npx papi add cogno`; endpoint is **config, not hardcoded** — `L4-reading.md` §6.2.3).

⛔ **Boot guard, read/write-aware** (`L3-chain.md` §3.3/§9, `L4-reading.md` §1/§6.2.3):
read `spec_version` via `api.constants.System.Version` and compare to the descriptor
version. On mismatch:

- **Block the WRITE path** (composer + onboarding) with **"update required to post —
  regenerate descriptors"** — a silent spec bump mis-encodes posts.
- **Keep READS running** in best-effort decode mode with a visible banner — a no-wallet
  reader must **not** be blanked by a posting-encoding concern (`L4-reading.md` §3.1/§6
  open-reads stance). Re-fetch `api.constants.Microblog.*` on any detected upgrade.

⛔ **The capacity replay fails closed** (§8.5): on a spec mismatch **or** missing
`api.constants.Microblog.*`, the composer disables submit with "client out of date" —
never estimate from hardcoded/stale constants.

### 8.2 The read provider abstraction (Tier-B if reachable, else Tier-A)

`useReadProvider` prefers a configured + reachable **indexer (Tier B — the reference
indexer is SubQuery, built at M4, DR-27)** for search/deep-pagination, and **automatically
degrades to PAPI-direct (Tier A, the v1 baseline)** for
single-post (`Posts.getValue`), profile-by-author (`ByAuthor`), identity resolution
(`CognoGate.PkhOf`/`AccountOf`), live feed (`Posts.watchEntries`), and the **entire
capacity widget**, against any public RPC (`L4-reading.md` §3.1/§3.3/§6.2.3). It shows a
visible **"degraded reads (no indexer): search / deep-paging unavailable"** banner —
never a silent break. ⛔ The capacity widget and the post path are **always** Tier-A
(L3-only, must match the runtime — `L4-reading.md` §5.1, §3.3 table).

### 8.3 Reads (Tier-A surfaces; `L4-reading.md` §4.2)

- **Live feed:** `Posts.watchEntries()` (add/delete deltas + full `Post`) as primary;
  `PostCreated` as an optional badge. ⛔ Read the live feed at **`'best'`** for snappiness
  and **explicitly label "showing best (unfinalized) — finalized to #N"** (handle
  `watchBest`'s `type:'drop'` on reorg). Finality can **stall** on a 1–3-authority chain
  (`L3-chain.md` §8.1) — a stalled feed must read as **"chain not advancing,"** and a
  no-wallet reader must never mistake a finality stall (best-chain has posts, finalized is
  empty) for a genuinely empty chain.
- **Single post:** `Posts.getValue(id, { at })`.
- **Profile by account:** `ByAuthor.getValue` → `Posts.getValues`.
- **Profile by identity:** `CognoGate.AccountOf.getValue(Binary.fromBytes(id32))` →
  `ByAuthor`, where `id32 = blake2b_256(serialized owner Address)` (32 bytes, DR-01);
  reverse via `PkhOf` (which returns the owner Address). ⛔ The owner **Address** is
  **trust-inherited** (`L4-reading.md` §2.2) — never presented as L4/L5-re-verified.
- **Threads:** build the children map client-side from `Post.parent` (no on-chain
  children index — `L3-chain.md` §4.4, `L4-reading.md` §3.1/§4.1). ⛔ **Tolerate dangling
  and tombstoned parents** — a deleted parent (`Posts.getValue` returns `undefined`,
  `L3-chain.md` §4.4) must **not** orphan its children.
- **`ByAuthor`** is a `BoundedVec` capped at `MaxPostsPerAuthor` (`L3-chain.md` §4.5) —
  full per-author history at scale is the indexer's job.

### 8.4 `lib/chain/post.ts` — the post wrapper (pre-flight + disambiguated catch)

Build `api.tx.Microblog.post_message({ text: Binary.fromText(t), parent: number |
undefined })` → `signAndSubmit(sr25519Signer)`. It MUST:

- **pre-flight** against the client-side replay (§8.5) and refuse + show the right state
  when `have < need` — distinguishing the **finite-timer** case from the **never** case
  (`need > cap`, §8.5);
- wrap `signAndSubmit` in try/catch and detect the pool-level
  `InvalidTransaction::ExhaustsResources`, then **disambiguate from CLIENT READS, not the
  error variant** (`L3-chain.md` §5.1/§5.3, `L4-reading.md` §5.2):

```
  on ExhaustsResources:
    if PkhOf[acct].isNone OR AllowedStake[acct] == 0:        // ⛔ unbound / zero-weight
        -> "finish onboarding / lock ADA to post"  (NO timer; rate==0 ⇒ never resolves)
    else if currentCapacity(acct) >= need:                   // personal capacity was fine
        -> "network busy — retrying next block"    (block-level CheckWeight, L3 §5.3)
    else if need > cap:                                       // un-postable at this length/weight
        -> "too long for your capacity — shorten it"  (NOT a timer, §8.5)
    else:                                                     // bound + weight>0 + need<=cap
        -> "you can post in N blocks"  (normal feeless out-of-capacity wait, NO fee, L3 §5.1)
```

⛔ **`NotAllowed` is effectively unreachable via the public pool in v1** — an unbound
account is rejected at `validate()` by `ExhaustsResources` *before* the body's
`ensure!(is_allowed)` can run (`L3-chain.md` §5.1 vs §4.4). Never route the unbound user
through the "post in N blocks" countdown (a false-ready promise that never resolves).

On success use `result.txHash` + block + the `PostCreated` event for an optimistic insert.

### 8.5 `lib/chain/capacity.ts` — `current_capacity()` replayed VERBATIM (advisory only)

⛔ **The client replay is ADVISORY UX only; the authoritative gate is the pool's
`CheckCapacity::validate()`** (`L3-chain.md` §5.1/§5.2). On any boot-guard failure or
missing `api.constants.Microblog.*`, **fail closed** (disable submit, "client out of
date") rather than estimate from stale/hardcoded constants — never enable a button the
pool will reject, and never disable one for a funded user.

Inputs (all L3 reads / metadata): `w = TalkStake.AllowedStake.getValue` (0 if unbound),
`bucket = Microblog.Capacity.getValue` (`{cap_last,last_block}` or `undefined`),
`now` (block number), `K = api.constants.Microblog.*` (`CapRatio, RegenPerBlock,
Ceiling, BaseCost, PerByteCost`). The function is `L4-reading.md` §5.2 / `L3-chain.md`
§4.3:

```ts
function currentCapacity(w: bigint, bucket: {cap_last: bigint, last_block: number} | undefined,
                         now: number, K: Consts): bigint {
  const capLinear = w * K.CapRatio;
  const cap = capLinear < K.Ceiling ? capLinear : K.Ceiling; // ⛔ capped-linear (L1 §9.3)
  if (!bucket) return 0n;                                     // ⛔ None = first-touch = 0, NOT full
  const elapsed = BigInt(now) - BigInt(bucket.last_block);
  const filled  = bucket.cap_last + w * K.RegenPerBlock * elapsed;
  return filled < cap ? filled : cap;
}

const cap   = (w * K.CapRatio) < K.Ceiling ? (w * K.CapRatio) : K.Ceiling;
const need  = K.BaseCost + K.PerByteCost * BigInt(len);
const rate  = w * K.RegenPerBlock;
const now0  = currentCapacity(w, bucket, now, K);

// ⛔ EDGE ORDER MATTERS — each guard before the next:
const status =
    need > cap          ? "never_at_this_length"            // ⛔ rate>0 but regen saturates BELOW need:
  : rate === 0n         ? "lock_ADA"                        //   a finite ceil-div here would LIE (§ below)
  : now0 >= need        ? "ready"
  :                       "wait";
const blocksUntilAffordable =
    status === "wait" ? Number((need - now0 + rate - 1n) / rate)  // ceil-div; rate>0n guaranteed here
  : status === "ready" ? 0
  : Infinity;                                               // never_at_this_length / lock_ADA
```

⛔ **The five edge states the widget MUST render as first-class, distinct visuals**
(each with a TEXT label + shape/icon, color is decorative-redundant — WCAG 1.4.1):

1. **`bucket === undefined` (None) ⇒ charging-from-0**, not full — a freshly-bound
   identity charges up (the single most likely UI bug, `L4-reading.md` §5.2).
2. **`w === 0n` ⇒ "no capacity — lock ADA to post"**, not a finite timer.
   ⛔ `rate === 0n` is guarded **before** the BigInt ceil-division — `BigInt / 0n` THROWS
   `RangeError`, it does **not** yield `+Infinity` (`L4-reading.md` §5.2).
3. **`need > cap` ⇒ "too long for your capacity — shorten it / raise weight"**, **never a
   finite timer.** `rate > 0n` so the guard passes, but regen saturates at `cap < need`
   so the post is **never** affordable; a naive ceil-div returns a finite-but-meaningless
   N (`L3-chain.md` §4.3 min-clamp). This is the **fifth** battery state and a `Composer`
   guard, surfaced when `need` (draft-length-dependent, `BaseCost + PerByteCost·len`)
   exceeds `min(weight·CapRatio, Ceiling)`.
4. **Stalled clock ⇒ "regen paused — chain not advancing"** (`L3-chain.md` §4.3/§8.1).
5. **`now0 < need` (bound, weight>0, need≤cap) ⇒ "can post in N blocks."**

⛔ **`<CapacityBattery>` overlays the draft's `need` as a threshold marker** whenever the
composer is non-empty, so **"battery above the line" == "submit enabled"** is visually
tautological — never a full-looking battery with a disabled button (account state vs
draft-relative gate must agree on screen).

**Live tick + reweight discontinuity.** Subscribe once with
`Microblog.Capacity.watchValue({ at: 'best' })`, then a local `setInterval` interpolates
`now = lastBlock + (Date.now() - lastBlockWallclock) / slotMs` (`slotMs` from the Aura
slot duration); each emission and each new block resyncs to chain truth (`L4-reading.md`
§5.2). ⛔ **On any `AllowedStake` / `Capacity` change, hard-resync the interpolation
baseline and suppress the upward tween for that frame** (snap to the new clamped current),
so a weight **decrease** (partial-withdraw, §7.6) reads as an honest step-down, not a
flicker (`L3-chain.md` §4.3 min-clamp on decrease). Under `prefers-reduced-motion`,
throttle the numeric countdown to **per-block** updates (not per-interpolation-frame) and
**freeze** it entirely in the paused state.

⛔ **Label the block the capacity is "as of."** The widget reads at `'best'`; the
`<ProvenanceLine>` "capacity as of #N" must mark **best-vs-finalized** and handle a
best-block drop the same way the feed does (§8.3), so a reorg-dropped best block does not
make capacity appear to move backward unannounced (`L4-reading.md` §5.2/§8).

### 8.6 Capacity is sized by L3 only — and the follower controls it going forward

⛔ Capacity is driven **only** by L3 `AllowedStake` (the largest **buried** beacon as-of
the follower cursor, **never summed**), **never** the live Cardano vault balance
(`L4-reading.md` §5.1/§8). The post and capacity paths never read Cardano
(`L4-reading.md` §2.2). And `AllowedStake` is **AUDITABLE, not trustless**: the follower
can write any weight and controls posting **rate** continuously (`ECONOMICS.md` §8,
`L3-chain.md` §9, `L2-follower.md` §3) — so a capacity drop to zero may be an **operator
clamp**, not only a user unlock. The trust explainer (Part B) names this; the widget never
implies `AllowedStake` is a follower-independent fact.


## 9. Visual & interaction design system: "Reading Room / Civic Ledger"

L5 is the only layer with a face, and the face is load-bearing for two of the
project's deepest claims: that **text is the product** (the whole reason cogno-chain
exists is that per-post L1 fees killed a forum, `PLAN.md` §1) and that **the docs'
adversarial honesty is a real property, not a disclaimer**. The visual system makes
both literal: a calm reading surface that respects long-form text, and quiet monospace
"ledger marginalia" that turns *usable ≠ trustless · signed ≠ included · feeless ≠
unstoppable · auditable ≠ trustless* into something you can see on every screen.

### 9.1 Direction (primary + the alternative held in reserve)

**Primary — "Reading Room / Civic Ledger."** Credibly-neutral public infrastructure
*for reading and writing text*, not a "web3 app." Two halves, both honest:

- **Reading Room** — paper-leaning surfaces, a real text typeface, generous measure,
  almost no chrome around the post body. The feed should read like a well-set page,
  not a feed-of-cards.
- **Civic Ledger** — every *chain-truth fact* (block N, finalized vs best, the two
  balances, the two trust badges, ids/pkh/ss58/lovelace) is rendered in a consistent
  monospace "ledger" voice: present, auditable, never hyped. The ledger voice is what
  makes the honesty structural — the trust limits are *typeset into the chrome*, not
  hidden in an About page.

**Rejected directions** (named so a careless redesign doesn't drift back): cream +
serif + terracotta editorial (too lifestyle), near-black + acid-neon (too crypto),
generic broadsheet (too cold for the onboarding newcomer the dual-key flow must
welcome), shadcn-default / default-Tailwind (templated; see §9.9), neon-gradient web3
(the exact aesthetic that signals "speculative app," which this is not).

**Alternative held in reserve — "Terminal Civic"** (a monospace operator console) for
a later **power-user mode**. It is too cold to greet a first-time user mid-way through
a dual-key onboarding, so it is *not* the v1 default — but it is the natural skin for
the endpoint/diagnostics surfaces (§10) and a future self-hoster dashboard.

### 9.2 Typography — three load-bearing roles, open typefaces only

Three roles, each a single consistent voice, all open-licensed (so the static,
self-hostable artifact ships its own fonts — no Google-Fonts call, which would leak a
request and violate telemetry-free-by-default, §10.5):

| Role | Typeface (primary / fallback) | Why |
|---|---|---|
| **Post body** (text IS the product) | **Source Serif 4** / Newsreader | A real reading serif; long threads must not fatigue. |
| **UI chrome** (nav, buttons, labels) | **Inter Tight** / Hanken Grotesk | Quiet, modern, recedes behind the text. |
| **Chain-truth data** (ids, block #, pkh, ss58, lovelace, capacity) | **IBM Plex Mono** / Commit Mono | "Verifiable on-chain fact" gets one unmistakable voice. |

⛔ **The monospace role is reserved for chain truth.** Never use it for decoration. If
a value is mono, the user is being told *this is a fact you can independently check*
(a post id resolvable via `Posts.getValue`, a pkh resolvable via `AccountOf`, a block
number). This is the typographic half of the honesty thesis.

**Scale (fluid, `clamp()`-based, paper-page rhythm):**

```
  --fs-post      : clamp(1.0625rem, 0.98rem + 0.4vw, 1.1875rem);  /* body serif, ~17–19px */
  --fs-post-lh   : 1.6;                                            /* generous leading      */
  --fs-ui        : 0.9375rem;   /* 15px chrome   */
  --fs-ui-sm     : 0.8125rem;   /* 13px labels   */
  --fs-mono      : 0.8125rem;   /* 13px ledger; tabular-nums ON for block #/lovelace */
  --fs-h-feed    : clamp(1.25rem, 1.1rem + 0.6vw, 1.5rem);
  --measure-post : 66ch;        /* §9.8 reading measure cap */
```

### 9.3 Color & surface palette — one accent, reserved for capacity

Two surface ramps (a paper-leaning **light** and a true-ink **dark**), a greyscale ink
scale for text/chrome, and **one** restrained accent. ⛔ All color/radius/shadow/motion
comes from the `lib/design` CSS-variable token layer — it is the **only** sanctioned
source (§9.9). No hex literals in components.

```
  /* SURFACE (light)                         SURFACE (dark)                       */
  --surface-0 : #FAF8F3;  /* paper        */ /* dark: #14161A true-ink            */
  --surface-1 : #F2EFE7;  /* raised page  */ /* dark: #1B1E24                     */
  --surface-2 : #E8E4D9;  /* sunken/hair  */ /* dark: #23272E                     */
  --ink-900   : #1C1B19;  /* body text    */ /* dark: #ECE9E2                     */
  --ink-600   : #565248;  /* secondary    */ /* dark: #A8A399                     */
  --ink-400   : #8A8579;  /* ledger muted */ /* dark: #6F6B62                     */
  --hairline  : #D9D4C7;                      /* dark: #2C313A                     */

  /* THE ONE ACCENT — verdigris / oxidized copper, reserved for CAPACITY/REGEN    */
  --verdigris      : #2E7D6B;   /* light-anchor; patina = permanence              */
  --verdigris-soft : #6FB3A2;   /* fill / charging                                */
  --verdigris-ink  : #1C5145;   /* on-light text/borders                          */

  /* SEMANTIC capacity + identity tokens (components reference ONLY these)        */
  --cap-charging   : var(--verdigris-soft);
  --cap-full       : var(--verdigris);
  --cap-empty      : var(--ink-400);     /* NOT red — "lock ADA" is not an error  */
  --cap-paused     : var(--ink-400);     /* dashed, frozen — "chain not advancing"*/
  --cap-toolong    : #B4603A;            /* the ONLY warm tone; draft-too-long    */
  --identity-cardano   : #3E4C59;        /* "seal" chip — slate, NOT Cardano blue */
  --identity-substrate : var(--verdigris-ink);  /* "key" chip                     */
```

⛔ **Accent budget.** Verdigris is reserved **almost entirely for the capacity/regen
system** (patina = permanence; Cardano-*adjacent* without using Cardano's brand blue —
because the app **observes** Cardano, it is not Cardano, §10.2). Buttons and links stay
greyscale + ink with an accent **hairline** on the *primary* action only — **never** a
filled neon CTA. The capacity battery is the one place color carries identity, and even
there it is always paired with a label (§9.7). ⛔ The `--cap-empty` "lock ADA" state is
**ink-grey, not red** — having no capacity is not an error, it is "you haven't locked
ADA yet" (§8.5 edge 2).

### 9.4 The SIGNATURE widget — `<CapacityBattery>`

The one novel mechanic in the whole stack is regenerating talk-capacity (`ECONOMICS.md`
§4), so it gets the one bespoke signature widget. It is a **horizontal segmented charge
meter** fed **verbatim** by the §8.5 `currentCapacity()` replay. ⛔ **Segment count and
the rate label are derived from PAPI metadata** (`api.constants.Microblog.*`), never
hardcoded — a `spec_version` bump that changes `CapRatio`/`Ceiling` must change the
battery, or the battery lies (§8.1 fail-closed applies here too).

```
  STEADY (bound, weight>0, charged):                  draft need-marker overlaid:
  ┌──────────────────────────────────────────┐       ┌─────────────────┊────────────┐
  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░  78%        │       │ ▓▓▓▓▓▓▓▓▓▓▓▓░░░░┊░░░░░░░░░░░░ │
  └──────────────────────────────────────────┘       └─────────────────┊────────────┘
   capacity   1,240 / 1,600   ·   +12 / block          have 740   ·   ┊ = this draft needs 980
   as of #84,213 (best · finalized #84,201)             ▶ "submit enabled when fill ≥ ┊"

  ⛔ The draft need-marker (┊) is overlaid whenever the composer is non-empty, so
     "fill above the line" == "submit enabled" is visually TAUTOLOGICAL — never a
     full-looking battery beside a disabled button (§8.5).
```

**The five first-class edge states** (each a *distinct visual* — a TEXT label + a
shape/icon, with color decorative-redundant per WCAG 1.4.1, §9.6). These map 1:1 to the
§8.5 replay branches; the battery may not show anything the replay does not compute:

```
  1. CHARGING-FROM-0   bucket===undefined (None ⇒ 0, NOT full).  L4 §5.2's #1 likely bug.
     ┌──────────────────────────────────────────┐
     │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  0%  ↗      │   "charging up — new posting key"
     └──────────────────────────────────────────┘   (soft verdigris pulse, reduced-motion off)

  2. NO-CAPACITY       w===0n (⛔ guard rate===0n BEFORE ceil-div; /0n THROWS).
     ┌──────────────────────────────────────────┐
     │ ▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢▢  —         │   "no capacity — lock ADA to post"
     └──────────────────────────────────────────┘   (ink-grey outline, NOT red, NOT a timer)

  3. TOO-LONG-FOR-DRAFT  need > cap  (rate>0 but regen saturates BELOW need — NEVER a timer).
     ┌─────────────────────────────────────┊────┐
     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ cap  ✗ ┊     │   "too long for your capacity —
     └─────────────────────────────────────┊────┘    shorten it or raise your weight"
                                            need is past the ceiling (warm --cap-toolong)

  4. PAUSED            block clock stalled (finality/best not advancing, L3 §8.1).
     ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
     │ ▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░  frozen      │   "regen paused — chain not advancing"
     └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘   (dashed border, NO tick, NO pulse)

  5. WAIT              now0<need, bound, weight>0, need<=cap.
     ┌──────────────────────────────────────────┐
     │ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░  62%        │   "can post in 7 blocks" (~42s)
     └──────────────────────────────────────────┘   (the ONLY state with a countdown)
```

⛔ Only state 5 shows a countdown. States 1–4 must **never** render a timer — that is
exactly the "false-ready" lie the whole capacity design refuses (§8.5).

### 9.5 The dual-key indicator — `<IdentityRail>`

Two keys, two jobs, two custody models → two **visually distinct** chips so a user can
never think the Cardano wallet posts (§5.1). Persistent, top-right, collapsible.

```
  ┌─────────────────────────────────────────────────────────────────────────┐
  │  ◈ SEAL  addr1q9k…7f3p   identity + stake (Cardano, self-custodial)        │  --identity-cardano
  │  ⬡ KEY   5GrwvaEF…utQY   posting  (sr25519, app-managed · ⚠ XSS-exposed)   │  --identity-substrate
  └─────────────────────────────────────────────────────────────────────────┘
        ▲ different SHAPE (◈ seal vs ⬡ hex key) + different COLOR + different LABEL
```

- The **seal** chip (Cardano) = a notarial-seal glyph, slate; the value is the owner
  **Address** short-hash (DR-01 — the whole base address is the identity); actions: manage
  vault / delegate / disconnect.
- The **key** chip (sr25519) = a hex-key glyph, verdigris-ink; the value is the
  `ss58` short; actions: **back up mnemonic · rotate · forget**. ⛔ It carries a small,
  honest **"app-managed · XSS-exposed at sign time"** affordance linking to the §10.6
  trust copy (the Model-B browser-custody reality, §5.4) — the chip must not imply the
  posting key is as safe as the self-custodial wallet.
- ⛔ The composer's submit area **always** echoes **"Signing as `<ss58-short>`"** so the
  signer is unambiguous at the moment of writing.
- ⛔ At every **key-loss** surface (rotate, forget, recovery), show the reassurance copy:
  **"Losing this posting key does NOT risk your ADA — your funds stay in your
  self-custodial Cardano vault; you can withdraw anytime and bind a new posting key"**
  (§5.8) — `PkhAlreadyBound` is *not* fund loss.
- On mobile the rail collapses to an expandable pill, but **never** so far that the user
  can't tell which key posts.

### 9.6 `<ProvenanceLine>` — the ledger marginalia (where honesty becomes visual)

A quiet mono strip (`--ink-400`, `--fs-mono`) under the feed/header that operationalizes
the adversarial voice as a *visual property*, not a disclaimer:

```
   at #84,213 · best  (finalized #84,201)   │   capacity as of #84,213 · best
   ─────────────────────────────────────────────────────────────────────────────
   [ follower: trusted (v1) ]   [ chain: operator-run (v1) ]   ⓘ About trust
```

⛔ **TWO persistent honesty badges, neither subordinate** (§9 honesty, mirroring the
TL;DR): `follower: trusted (v1)` **and** `chain: operator-run (v1)`. The operator
(consensus) trust is at least as large as the follower's — it decides
inclusion/ordering/finality and the chain inherits **none** of Cardano's security
(`L3-chain.md` §8.1/§9, `ECONOMICS.md` §8, `PLAN.md` §1). Both link to the matching
row of the §10.6 honesty table. The line also carries best-vs-finalized for the feed
(§8.3) and the "capacity as of #N · best" label (§8.5).

### 9.7 `<TwoBalances>` — the design-layer guard against the two-balance lie

```
   Parked now        12,500 ADA   (Cardano · live · optional)        ── off the post path
   ─────────────────────────────────────────────────────────────
   Counted for posting   11,800 ADA   as of #84,201                  ── the hero number
        ⤷ pending burial (~k blocks) of a +700 ADA top-up
```

⛔ Two **separate rows**, never a single number; the **hero posting number is always**
the `AllowedStake`/capacity-derived value, never the live ADA (re-creating the
`L4-reading.md` §5.1/§8 two-balance discipline at the design layer). "Parked now" is
optional, off-path, and explicitly labeled live-Cardano (§8.3). ⛔ "Counted for posting"
carries the **AUDITABLE-not-trustless** caveat on hover/info: the follower can write any
weight and a drop to zero may be an **operator clamp**, not only a user unlock (§8.6,
`ECONOMICS.md` §8).

### 9.8 Key-screen wireframes

**Feed (browse track — no wallet required, §6.1):**

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  cogno · reading room                       [ ◈ connect ]  ⓘ About trust   │
  │  at #84,213 · best (finalized #84,201)   [follower:trusted(v1)] [chain:op…]│  ← ProvenanceLine
  ├──────────────────────────────────────────────────────────────────────────┤
  │  addr1q9k…7f3p · #4021 · #84,180 ✓final                                    │
  │    A long-form post set in Source Serif 4, ≤66ch measure, reading-room     │
  │    leading. The text is the product; chrome recedes.                       │
  │    ↳ 3 replies · reply · ⋯                                                  │  ← thread via Post.parent
  │  ────────────────────────────────────────────────────────────────────────│
  │  5Grw…utQY · #4022 · #84,205 best                                          │
  │    Another post. (best/unfinalized rows marked; a finality stall reads as  │
  │    "chain not advancing," never as an empty feed, §8.3.)                   │
  │  ────────────────────────────────────────────────────────────────────────│
  │  ⓘ degraded reads (no indexer): search / deep-paging unavailable           │  ← Tier-B→A banner (§8.2)
  └──────────────────────────────────────────────────────────────────────────┘
```

**Composer (capacity battery + dual-key echo):**

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  ⬡ Signing as 5GrwvaEF…utQY                              [ Reading Room ]   │
  │  ┌──────────────────────────────────────────────────────────────────────┐ │
  │  │ Write a post…                                                         │ │
  │  └──────────────────────────────────────────────────────────────────────┘ │
  │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░┊░░░░  have 740 / cap 1,600 · +12/blk · need 520     │  ← CapacityBattery + ┊
  │  280 chars                                              [  Post  ]          │  ← enabled iff fill ≥ ┊
  └──────────────────────────────────────────────────────────────────────────┘
   • unbound/zero-weight → button reads "finish onboarding / lock ADA" (NO timer, §8.4)
   • need>cap            → "too long for your capacity — shorten it"   (NO timer, §8.5)
   • bound, wait         → "can post in N blocks (~Ns)"                (the only countdown)
```

**Profile / thread:**

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  ◈ addr1q9k…7f3p   owner Address (DR-01)  (trust-inherited — not L5-re-verified)│ ← §8.3 ⛔
  │  Counted for posting 11,800 ADA · as of #84,201    [follower-set, auditable]│
  ├──────────────────────────────────────────────────────────────────────────┤
  │  #4021  parent post                                                         │
  │   ├ #4044  reply                                                            │
  │   │  └ #4061  reply                                                         │
  │   └ #4052  reply to a [deleted] parent — child preserved (⛔ tolerate       │
  │            dangling/tombstoned, §8.3)                                       │
  └──────────────────────────────────────────────────────────────────────────┘
```

**Onboarding panel (the §6 FSM, three distinct post-bind waits):**

```
  ┌──────────────────────────────────────────────────────────────────────────┐
  │  Get a voice                                                  step 3 of 5  │
  │  ① connect ✓   ② lock ≥100 ADA + beacon ✓   ③ create posting key ➜         │
  │                                                                            │
  │  ⬡  Create your posting key                                                 │
  │     A random sr25519 key, encrypted in your browser. ⛔ Back up the         │
  │     mnemonic now — it is the only recovery that doesn't need the operator.  │
  │     [ reveal 12-word phrase ]  ☑ I saved it                                 │
  │     ⚠ app-managed: an XSS in this client can steal it at sign time.         │
  │        High-value identity? use the Substrate extension (Model C).          │
  │                                                                            │
  │  next ▸ prove ownership (CIP-8, one signature, from your wallet address)    │
  └──────────────────────────────────────────────────────────────────────────┘

  later states (each DISTINCT, never one spinner — §6.3):
   ▸ "Deposit confirming on Cardano (depth 1/k · ~Xh) — a short rollback can un-confirm it"
   ▸ "Binding… (follower latency). Last follower activity: 2m ago"
   ▸ "Bound ✓ — pending burial (~k blocks, up to ~Xh)"
   ▸ "Charging up…"  (or, if the sweetener ships: "ready — first post is on us", §6.3)
```

### 9.9 Styling stack & what to AVOID (so it isn't templated)

- **Stack:** Next.js (static export) + a **hand-authored CSS-variable token layer**
  (`lib/design/tokens.css`) that is the **only** sanctioned source of
  color/radius/shadow/motion. Tailwind is permitted **only** with a fully-overwritten
  config that maps to the tokens (no default palette, no default shadow/ring scale).
  All bespoke widgets (`<CapacityBattery>`, `<IdentityRail>`, `<TwoBalances>`,
  `<ProvenanceLine>`) come from **no** component library.
- **Semantic tokens only in components:** `--cap-charging/-full/-empty/-paused/-toolong`,
  `--identity-cardano/-substrate`, `--surface-*`, `--ink-*`, `--hairline`. ⛔ No hex
  literal, no raw Tailwind color class, ever, in a component.
- ⛔ **AVOID (the templated tells):** the shadcn card-with-soft-shadow grid; default
  Inter-everywhere with no reading serif; a filled bright-primary CTA; neon gradients;
  glassmorphism; emoji-as-iconography; a Google-Fonts `<link>` (ship the fonts, §9.2);
  using the accent for anything but capacity; a single "balance" number; one spinner
  for the three onboarding waits; red for "no capacity."

### 9.10 Motion & accessibility (`prefers-reduced-motion` first-class)

- **Reduced-motion:** disable the continuous battery fill; ⛔ also **throttle the numeric
  countdown to per-block updates** (not per-interpolation-frame — a per-second changing
  number is itself vestibular-triggering) and **freeze it entirely in the paused state**
  (§8.5). No pulse when full or zero.
- **Color is never the sole carrier of meaning** (WCAG 1.4.1): every capacity edge state
  and every identity chip is bound to a distinct **TEXT label + shape/icon**, not just a
  `--cap-*`/`--identity-*` color (§9.4/§9.5). This is testable and a §12 release gate.
- **Contrast:** all chain-data mono text meets WCAG AA on both surface ramps; the
  verdigris fill meets AA against its track.
- **Responsive:** feed measure caps ~66ch desktop with a **compact-density toggle**
  (open question, §13); the battery becomes a compact inline meter in the composer on
  mobile; the `<IdentityRail>` collapses to a pill but never hides which key posts.

---

## 10. Client-layer neutrality, self-custody & the HONEST trust posture

L5 is the layer most able to *quietly* re-centralize the open chain (one hard-wired
indexer) or *quietly* overstate what is trusted. Neutrality is therefore a **v1
requirement with an acceptance test** (`L4-reading.md` §6.3/L4-M5), not a fast-follow —
and the honest posture is **typeset into the UI** (§9.6), not relegated to an About page.

### 10.1 Endpoint-as-config + PAPI-direct fallback (the read-neutrality guarantee)

`<EndpointSettings>` exposes **two user-editable ordered lists** — L3 RPC endpoints and
optional L4 indexer/GraphQL endpoints — persisted to localStorage, with curated
defaults, a visible **active-endpoint** indicator, one-click switch, and per-endpoint
health/finality status. ⛔ **No endpoint may be compiled in as the sole authority**
(`L4-reading.md` §6.2.3/§6.3). The capacity widget and post path are **always** Tier-A
(L3-only, PAPI-direct); the indexer is Tier-B for search/deep-paging only, with
**visible** degradation to PAPI-direct (§8.2). **Acceptance test (L4-M5):** *the app
works against a second, independently-run endpoint AND against PAPI-direct with no
indexer.* That is the **structural** (not promised) guarantee that no indexer is the
read authority.

### 10.2 The follower endpoint — a named centralization point, NOT a route-around

A **list-capable, HTTPS-only** follower-endpoint config field, used **only** for the
one-time CIP-8 bind POST (§5.5), labeled **"trusted onboarding service (single point of
failure in v1)."** ⛔ **Unlike the RPC/indexer lists (§10.1), follower-endpoint config
buys ZERO v1 neutrality:** there is exactly **one** trusted follower in v1
(`L2-follower.md` §4.1/§10 — "unilateral in v1"); the field is **forward plumbing** for
the D2 k-of-t committee, not a present-tense route-around. Do not present it as an
equivalent neutrality guarantee to the read lists.

Two follower-related attack surfaces L5 cannot fully defend, surfaced honestly:

- ⛔ **HTTPS-only + pinned default.** Refuse `http://` follower endpoints; the curated
  default URL is **pinned/signed in the build**, and overriding it requires an explicit,
  friction-ful confirmation (defends a phishing page preloading a hostile follower URL
  into localStorage).
- ⛔ **Bind hijack is PREVENTED in v1 (DR-02), not merely detected.** The v1 CIP-8 proof is
  a **committed payload** ({ sr25519 account + L3 genesis + nonce }) and the follower enforces
  an **exact whole-address match** (recovered signing address == reconstructed `datum.owner`,
  DR-01) — so a captured proof cannot be replayed to bind a different account and the follower
  cannot silently substitute one (§5.5). The follower is still the only *writer*, so the
  **`AccountOf` readback** after the bind (§5.4) remains as belt-and-suspenders. The on-chain
  `ed25519` self-proof (verifiable without trusting the follower's verification step at all)
  is the deferred D1. The honesty table (§10.6) names this plainly.
- **Follower-down ≠ app-down**, with the asymmetric-window caveat: render "Onboarding
  temporarily unavailable — reading and posting are unaffected"; ⛔ but qualify it — an
  account that already unlocked retains stale voice until the clamp lands (§6.4,
  `L2-follower.md` §8.2/§10).

### 10.3 No managed-provider lock-in — default read = L3 `AllowedStake`, NO Blockfrost (DR-33)

The default "posting power" read is **L3 `AllowedStake`** — the largest **buried** beacon
lovelace the follower already published, needing **zero Cardano access** and fully
recomputable from L1 + the published largest-wins spec (`L4-reading.md` §5.1,
`L2-follower.md` §3.1/D0; DR-33). The Cardano **"parked now" cross-check** is an **OPTIONAL,
user-supplied Kupo URL** (light Kupo/Ogmios on **preprod**, DR-31; **NO Blockfrost**, DR-33):
⛔ never the sole source, never Cardano on the post path. (Kupo read:
`GET <kupo>/matches/<vaultHash>.<token_name>?unspent`, where `policy_id == vaultHash` (DR-18)
and `token_name = blake2b_256(serialized owner Address)` (DR-01), **largest** unspent match —
mirroring largest-wins, never summed.) Per DR-33 a managed Blockfrost option is **not**
offered.

### 10.4 Open-source, self-hostable, forkable, telemetry-free, reproducible

Static export (`output:'export'`), no required backend, no SSR data dependency, no
server secrets, **no telemetry by default** (and no Google-Fonts call, §9.2);
reproducibly buildable with a **published build hash** so self-hosters can verify the
artifact byte-for-byte (this doubles as the §5.4 Model-B custody-integrity story).
Self-hostable on IPFS / any static host; constants read from PAPI metadata so a fork
against a different runtime stays correct. ⛔ **The CLIENT is a hyperstructure-COMPATIBLE
artifact; the STACK is not yet a hyperstructure** — the system's open-reads property
remains contingent on the not-yet-existing L4 archive (`L4-reading.md` §6.5, L4-M4c) and
bounded by the trusted follower + operator. Carry L4's framing verbatim:
**reproducible ≠ effortless** (`L4-reading.md` §6.4/§7.4). Client copy says **"open in
principle, contingent on the published archive,"** not "open reads," until M4c passes.

### 10.5 What L5 does NOT decentralize (say it plainly)

Even a perfectly neutral client cannot route around the two trusted parties one layer
down. ⛔ The client must never let its own self-hostability imply the *system* is
trustless:

- **The follower** binds your key and sets your posting **rate** going forward
  (`L2-follower.md` §3, `ECONOMICS.md` §8) — one operator, no v1 alternate (§10.2).
- **The L3 operator** decides whether your **signed** post is **included, ordered, and
  finalized**, and the chain inherits **none** of Cardano's security; finality can stall
  on 1–3 authorities (`L3-chain.md` §8.1/§9, `PLAN.md` §1). *Signed ≠ included; feeless
  ≠ unstoppable.*

### 10.6 The "usable ≠ trustless" client honesty table (`<TrustExplainer>`)

A persistent **"About trust"** surface (linked from both §9.6 badges), in the docs'
adversarial voice. ⛔ **No "trustless" / "fully decentralized" copy anywhere in the
client.** The table — *what is trusted, by whom, with what fallback*:

| What you trust | To do what | In v1 it is… | Your fallback / recourse |
|---|---|---|---|
| **The L3 operator** (consensus) | Include, order, finalize your signed post; not censor; produce blocks | A single operator (or 1–3 authorities); **no Cardano security inherited**; finality can **stall** (`L3-chain.md` §8.1/§9) | None in v1 beyond *exit* — your sr25519 key + data are portable to any future operator. *Signed ≠ included.* |
| **The follower operator** | Verify your CIP-8 once; bind your owner **Address** to **your** sr25519 key; set your posting **rate** going forward (`AllowedStake`) | **One** trusted writer; can set **any** weight and **omission is invisible** on-chain (`L2-follower.md` §3/§10) — **but** the bind is now keyed on the committed payload + whole-address match, so it **cannot** bind you to a key you did not commit (DR-02) | `AllowedStake` is **auditable** (recomputable per D0) but **not trustless**; capacity→0 may be an **operator clamp** (§8.6); plus the `AccountOf` readback (§5.4) as belt-and-suspenders. |
| **Your CIP-8 binding correctness** | Prove the right key was bound | **PREVENTED in v1 (DR-02):** the proof is a committed payload (sr25519 account + L3 genesis + nonce) and the follower enforces an exact whole-address match (recovered signing addr == reconstructed `datum.owner`, DR-01). The **on-chain** `ed25519` self-proof (verifiable without trusting the follower's verify step) is the **deferred D1** (`L2-follower.md` §7.2/§9 D1) | The committed proof + whole-address match (primary); `AccountOf` readback (§5.4); mnemonic backup + (operator-mediated, possibly-unavailable) re-bind (§5.8). |
| **Your posting (sr25519) key** | Sign every post | **App-managed at rest** (AES-GCM in IndexedDB); ⛔ **decrypted to PLAINTEXT at sign time** — an XSS / hostile host / compromised dep in this client **can steal it** (§5.4) | Strict CSP + SRI + pinned build hash + worker isolation + no plaintext-by-default device unlock; **Model C (Substrate extension) is the security-preferred path** for high-value identities. *A stolen posting key impersonates your voice until re-bind.* |
| **Your Cardano wallet + parked ADA** | Hold ADA; sign vault txs + the one CIP-8 | **Self-custodial keys**, BUT parked ADA sits at a **SCRIPT-payment vault address** — reclaim depends on the `talk_vault` validator **and on L5 building the tx correctly** (`L1-cardano.md` §4.2/§7.1, §7.7) | Owner-reclaimable **anytime** (no timelock) via a correct script spend; **reclaimable ≠ as-liquid/safe-as-in-wallet**. |
| **Your chosen RPC / indexer** | Serve the feed, profiles, capacity reads | Whatever you point at — a hosted default unless you self-host | **Endpoint-as-config + PAPI-direct fallback** (§10.1), acceptance-tested (L4-M5). |
| **The open archive** (for "open reads") | Let anyone re-derive the feed from genesis | **Does not yet exist** — gated by L4-M4c (`L4-reading.md` §6.5) | "Open **in principle**, contingent on the published archive" — not "open reads" yet. |

⛔ **The binding slogan, shown verbatim:** *usable ≠ trustless · signed ≠ included ·
feeless ≠ unstoppable · auditable ≠ trustless.* And the visual-honesty line (§9.3/§9.6):
**Cardano is an information ORACLE here (observed, not bridged — no assets move); posts
inherit NONE of Cardano's finality or stake security (`PLAN.md` §1, `L3-chain.md` §8.1).
The verdigris/permanence motif is aesthetic, not a durability claim.**

---

## 11. Honest risks

Mirrors the L1–L4 "Honest risks" sections — every real footgun + limit L5 carries.

- ⛔ **Model B is XSS-fatal by construction (the single largest L5 risk).** The keystore
  encryption protects the seed at rest / cross-site, **not** against same-origin script.
  An XSS or one compromised dependency in this static-hosted SPA can keylog the passphrase
  + exfiltrate the seed, or — with any plaintext device-unlock on — read the seed with no
  passphrase, or swap a post's `text`/`parent`, or present a malicious bind (§5.4). A
  stolen posting key = full voice impersonation until an operator-gated, possibly-
  unavailable re-bind. Mitigations (strict CSP, SRI/lockfile-pinned audited deps, no
  plaintext device-unlock default, zeroize-after-sign, worker isolation, published build
  hash) **reduce but do not eliminate** this; Model C (extension) is the only real escape.
- ⛔ **The v1 binding is PREVENTED, not merely trusted (DR-02) — but the follower is still
  the only writer.** The v1 CIP-8 proof is a **committed payload** ({ sr25519 account + L3
  genesis + nonce }) and the follower enforces an **exact whole-address match** (recovered
  signing address == reconstructed `datum.owner`, DR-01), so a captured proof cannot be
  replayed to bind a different account and the follower cannot substitute one. The residual
  risk is that the follower remains the sole *writer* (it can omit / set any weight,
  `L2-follower.md` §3/§10); L5 keeps the `AccountOf` readback (§5.4) as belt-and-suspenders.
  The **on-chain** `ed25519` self-proof (verifiable without trusting the follower's verify
  step at all) is the **deferred D1** (`L2-follower.md` §7.2/§9 D1, `L3-chain.md` §11 Q10).
- ⛔ **RESOLVED — the identity is the whole owner Address (DR-01), no longer a BLOCKING
  credential-kind question.** `datum.owner` is a full CIP-19 Address (payment `VerificationKey`
  + stake cred); the old "is `owner_pkh` a payment- or stake-key-hash?" question
  (`L2-follower.md` §11 Q2, `L3-chain.md` §11 Q5) is resolved. L5 **can ship**
  `link_identity` onboarding — the derive→sign→assert chain matches the whole Address, so
  there is no wrong-credential failure mode left (§5.6).
- ⛔ **Vault-tx correctness is creator-loses-own-ADA.** A wrong hash (an
  `applyParamsToScript` type-coercion silently yielding a wrong vault hash,
  `L1-cardano.md` §9.2 — now a SINGLE `talk_vault(min_lock)` hash, no separate beacon
  policy, DR-18), a wrong (non-type-1) address, a sub-floor create, a stake cred ≠
  `datum.owner.stake_cred` (DR-01), or a top-up that breaks the token-set/datum freeze
  (`L1-cardano.md` §7.10/§7.3) sends or strands the **creator's own** ADA. The §7.1 boot
  re-assert + §7.7 per-tx pre-flight (header nibble, payment-cred==cached `vault_hash`,
  stake-cred==`datum.owner.stake_cred`, token-set/datum equality) are mandatory.
- ⛔ **Partial-withdraw strands voice in an interruptible gap.** It is two txs (burn,
  then re-create, `L1-cardano.md` §6.3); between them the beacon is burned and weight
  clamps to 0 (`L2-follower.md` §8.2). An abandoned/failed tx2 — or a phisher framing tx1
  alone as "confirm withdrawal" — leaves the user fully unlocked with no vault. The §7.6
  durable inter-tx marker + pre-flight (wallet holds ≥ re-lock + fees before tx1) +
  resume-tx2-on-reload + the hard two-signature/voice-gap FSM gate are required.
- ⛔ **False-ready capacity timers are a lie the client must refuse.** `None ⇒ 0` (not
  full); `rate === 0n` guarded **before** the BigInt ceil-div (`/0n` THROWS, not
  `+Infinity`); `need > cap ⇒ never` (not a finite N); an **unbound / zero-weight** pool
  reject routes to "finish onboarding," **never** "post in N blocks" (`L3-chain.md`
  §5.1/§4.4 — `NotAllowed` is effectively unreachable via the pool, §8.4). The replay is
  **advisory only — the pool's `validate()` is the gate** — and it **fails closed** on a
  spec/metadata mismatch (§8.1/§8.5).
- **The asymmetric unlock window (system-honesty, not just the unlocker's).** An account
  that already unlocked retains stale voice until the spend buries **and** `set_stake{0}`
  lands; the window **widens** while the follower is down (`L2-follower.md` §8.2/§8.4).
  "Posting unaffected" during follower-down is qualified, and the window is named in the
  trust table (§6.4/§10.6).
- **Recovery is operator-gated and may be unavailable in v1.** Mnemonic restore is the
  load-bearing path; generate-new-and-re-bind needs an **operator-mediated revoke** that
  is **weak, manual, and an M2b hook that may not be live** (`L2-follower.md` §7.5,
  `L3-chain.md` §4.1). A lost key with no mnemonic may be stranded; ⛔ but it is **not**
  fund loss (§5.8).
- **Soft read re-centralization.** A default hosted RPC/indexer everyone uses is a
  de-facto read authority; mitigated **structurally** by endpoint-as-config + PAPI
  fallback (§10.1), not promised. And "open reads" stays contingent on the not-yet-
  existing L4 archive (`L4-reading.md` §6.5).
- **Operator post-path trust (the larger, continuously-active one).** A signed, feeless
  post can still be censored, reordered, delayed, or never finalized; the chain inherits
  none of Cardano's security; finality can stall (`L3-chain.md` §8.1/§9, `ECONOMICS.md`
  §8). *Signed ≠ included.*
- **Metadata coupling.** A `spec_version` bump that changes encoding mis-encodes posts /
  mis-decodes the feed unless descriptors are regenerated (`L3-chain.md` §3.3/§9). The
  read/write-aware boot guard (§8.1) blocks the write path loudly while keeping reads in
  best-effort decode — but a no-wallet reader must never be blanked by a posting concern.
- **Supported-wallet reality.** v1 restricts to 32-byte CIP-30 keys and one verifier
  (`L2-follower.md` §7.4) and to wallets exposing a base address (payment `VerificationKey` +
  stake cred) + 32-byte CIP-30 keys (DR-28c). A wallet that only exposes extended keys, or
  only a vault-adjacent address that is **not** the owner `datum.owner` Address (wrong
  payment OR wrong stake cred, DR-01), breaks onboarding for those users — the
  supported-wallet matrix is an open question (§13).
- **`u64` post-id space (DR-21).** `NextPostId` is **u64** (DR-21 removed the old `u32` wrap
  at `2^32`, `L3-chain.md` §4.4); client thread/optimistic-insert logic keyed on `id` no
  longer carries a practical wrap caveat — out of L5's remit regardless.

---

## 12. Implementation milestones (L5)

Bite-sized, executable cold; aligned with `L3-chain.md` M3/M4 and `L4-reading.md`
L4-M3 onward. Each has an acceptance test. ⛔ Several gate on upstream confirmations
(noted) — do not ship past them blind.

1. **L5-M0 — Browse track + boot guard (no wallet, with L4-M3).** Static-export
   Next.js + PAPI client; endpoint-as-config (RPC list, §10.1); live feed via
   `watchEntries({at:'best'})` with best-vs-finalized labels; single-post + thread
   (client-side from `Post.parent`, tolerate dangling/tombstoned); the read/write-aware
   boot guard (§8.1). The `lib/design` token layer + the "Reading Room" shell (§9).
   **Acceptance:** the feed renders with **no wallet connected**; a spec-version mismatch
   blocks the (absent) write path but keeps reads in best-effort decode with a banner;
   threads survive a deleted parent; a finality stall reads as "chain not advancing,"
   never an empty feed.
2. **L5-M1 — Capacity battery + post wrapper (with L3 M3 / L4-M3).** The §8.5
   `currentCapacity()` replay (verbatim, fail-closed, constants from metadata); the
   bespoke `<CapacityBattery>` with all **five** edge states + the draft need-marker; the
   §8.4 post wrapper with reads-disambiguated `ExhaustsResources` handling.
   **Acceptance:** `bucket===undefined`→"charging from 0", `w===0n`→"lock ADA" (no
   `RangeError`), `need>cap`→"too long" (no timer), unbound pool-reject→"finish
   onboarding" (no timer), bound-over-budget→"post in N blocks"; the battery fill ≥ the
   need-marker iff the Post button is enabled; reduced-motion throttles to per-block.
3. **L5-M2 — Model-B keystore + sr25519 signer (isolated, with L3 M3).** Random
   sr25519 keygen, AES-GCM-in-IndexedDB, mandatory mnemonic backup, decrypt-at-sign +
   zeroize, **keystore/signer in an isolated Web Worker**; the `getPolkadotSigner` adapter
   (§5.7); strict CSP + SRI shipped with the export; no plaintext device-unlock default.
   **Acceptance:** a post is signed with no per-post popup; the seed is never in
   page-context memory (worker-only) and is zeroized after sign; the shipped CSP blocks
   inline/eval; the build hash is published and reproducible.
4. **L5-M3 — Vault txs + pre-flight + boot re-assert (with L1 deploy).** `lib/cardano`:
   the §7.1 **single merged `talk_vault(min_lock)`** script derivation (one hash, no
   separate beacon policy, DR-18) cached as constants + boot re-assert; the
   create/top-up/full-exit recipes (§7.3–7.5); the §7.7 pre-flight (incl. header nibble,
   payment-cred==cached `vault_hash`, stake-cred==`datum.owner.stake_cred` (DR-01), top-up
   token-set/datum equality); the §7.6 **durable** partial-withdraw orchestrator.
   **Acceptance (gates on L1 deploy):** recomputing the script from `min_lock` at boot
   reproduces the deployment constants; a sub-floor / wrong-address / wrong-stake-cred /
   token-set-breaking tx is **refused before submit**; tx1 of a partial-withdraw is gated on
   the wallet holding ≥ re-lock + fees, and a reload after tx1 resumes tx2.
5. **L5-M4 — CIP-8 bind + follower POST + readback (with L2-M5).** ⛔ The old "GATES on
   `L2-follower.md` §11 Q2 (owner_pkh credential kind)" is **RESOLVED** (DR-01: the identity
   is the whole owner Address) — M4 no longer blocks on it; it still gates on the
   wrong-address negative test (`L2-follower.md` §12 step 5). The §5.5/§5.6 bind: pick the
   type-6/type-0 user-controlled address that is **exactly `datum.owner`**, `signData` over
   the **committed payload** (sr25519 account + L3 genesis + nonce, DR-02), recover `vk`
   ourselves, assert the **recovered signing address == reconstructed `datum.owner`**
   (whole-address match, DR-01/DR-02), reject 64-byte keys, hard-block the vault address;
   HTTPS-only POST with the optional `thread_pointer` (5-byte/10-hex) field; the **`AccountOf`
   readback** (§5.4). **Acceptance:** signing from the vault address or from any address that
   is not exactly `datum.owner` (wrong payment OR stake cred) is **blocked before submit**
   (the negative test passes); after a successful bind, `AccountOf[id32]` (id32 =
   `blake2b_256(owner Address)`) resolves to **my** sr25519 account before onboarding declares
   complete; a forced readback mismatch surfaces a hard `bound_to_wrong_key` error.
6. **L5-M5 — The full onboarding FSM (derived-from-reads, with L2 + L3 M2/M3).** The §6
   state machine: states derived every render from the read bundle; the three distinct
   post-bind waits; follower-liveness via the published `cursor_slot` (§6.3); the
   asymmetric-unlock clamp first-class (`unlocking` stays until `AllowedStake==0`); the
   two-balance display; persist only in-flight tx hashes + the partial-withdraw marker.
   **Acceptance:** a refresh mid-flow recovers truth from reads; a freshly-funded user
   sees confirming → binding → pending-burial → charging as **distinct** steps (never one
   spinner); an unlock holds `unlocking` until weight reads 0; follower-down shows
   "onboarding unavailable; reading + posting unaffected" with the asymmetric-window
   caveat in the `unlocking` copy.
7. **L5-M6 — Neutrality + honesty surface (with L4-M5).** `<EndpointSettings>` (RPC +
   indexer + HTTPS-only pinned-default follower lists, §10.1/§10.2); the optional **Kupo**
   parked-now cross-check (NO Blockfrost, DR-33; §10.3); the two §9.6 honesty badges; the §10.6
   `<TrustExplainer>` table; the "open in principle, contingent on the archive" copy.
   **Acceptance (mirrors L4-M5):** the app works against a **second, independently-run
   endpoint** AND against **PAPI-direct with no indexer**; an `http://` follower endpoint
   is refused; overriding the pinned default follower requires explicit confirmation; no
   "trustless" / "fully decentralized" string appears anywhere in the built artifact
   (grep-tested); no telemetry / Google-Fonts request fires (network-tested).
8. **L5-M7 — A11y + reduced-motion + supported-wallet matrix.** WCAG AA on both ramps;
   color-never-sole-meaning bound for all five battery states + both identity chips;
   reduced-motion per-block throttle + paused freeze; the documented supported-wallet
   matrix (§13) with graceful "unsupported wallet" copy. **Acceptance:** an automated a11y
   pass (axe) is clean on feed/composer/onboarding; each capacity state and identity chip
   is distinguishable with color removed; each in-scope wallet completes the bind, and an
   out-of-scope (extended-key-only / vault-adjacent-address-only) wallet shows the honest
   "unsupported in v1" message rather than a silent break.
9. **L5-M8 (deferred) — Model C signer + D1 self-proof mode + indexer search UI.** Offer
   the Substrate-extension signer behind the same `PolkadotSigner` interface (the
   security-preferred path, §5.2); the `selfProofMode`-flagged **on-chain** D1 self-proof
   (the CIP-8 payload is already committed in v1, DR-02; what is dark until D1 is the
   on-chain `ed25519_verify` verification, §5.5); Tier-B search/deep-pagination UI when an
   indexer is configured (with the visible degradation, §8.2). **Acceptance:** Model C posts
   with no in-app key storage; `selfProofMode` stays dark in v1; search degrades visibly to
   PAPI-direct when no indexer is reachable.

---

## 13. Open questions for the owner

⛔ **Several of these are RESOLVED in DECISION-REGISTER.md (2026-06-16) — see that doc.**
Q1 (KDF = Argon2id, no plaintext device-unlock default — DR-28a), Q2 (CIP-8 = a COMMITTED
payload committing { sr25519 account + L3 genesis + nonce }, not an opaque nonce — DR-02),
Q5 (parked-now = Kupo only, NO Blockfrost — DR-33; network = preprod — DR-31), Q6 (supported
wallets = those exposing a base address + 32-byte CIP-30 keys — DR-28c), and Q9 (Model C
offered as an opt-in in v1 — DR-28b) are **decided**; the detail below is kept for context.

1. **sr25519 keystore KDF + lock UX.** ⛔ **RESOLVED — DR-28a:** KDF = **Argon2id**; **no
   plaintext device-unlock default** (a passphrase is required on every device; any
   convenience mode is opt-in, time-boxed, memory-only, cleared on blur). Remaining owner
   call: the Argon2id **parameters** (memory/iterations/parallelism) and whether to offer
   the convenience mode at all. (The old "PBKDF2 vs Argon2id" choice is settled to Argon2id.)
2. **CIP-8 v1 payload shape (build byte-for-byte what the follower verifies).** ⛔
   **RESOLVED — DR-02:** v1 anti-replay is a **COMMITTED payload** — domain-separated bytes
   committing **{ sr25519 account + L3 genesis hash + fresh nonce }** (not an opaque
   server-cache nonce). Remaining owner call: the exact domain-separation tag / byte layout
   so L5 and the follower's `pycardano.cip.cip8.verify` agree. The **on-chain** self-proof
   (`ed25519_verify`) is the **deferred D1** (`L2-follower.md` §7.2) — keep that behind
   `selfProofMode`.
3. **Recovery / re-bind operator policy + SLA.** Revocation is operator-mediated, weak,
   manual, and an M2b hook that may not be live in v1 (`L2-follower.md` §7.5, §11 Q7,
   `L3-chain.md` §4.1). What is the **user-facing request channel + SLA** for "I lost my
   key, please revoke and let me re-bind"? Without it, a lost key with no mnemonic is
   effectively unrecoverable and the §5.8 copy must say so honestly.
4. **Default endpoint set + a public read-RPC for the PAPI-direct fallback.** Which
   curated L3 RPC(s) and (optional) L4 indexer(s) ship as defaults, and does the owner run
   a **public, rate-limited read RPC** so the PAPI-direct fallback has a real default
   (`L4-reading.md` §10 / L4-M5b)? The neutrality property needs ≥1 independently-runnable
   default **plus** the documented exit.
5. **Parked-now cross-check provider.** ⛔ **RESOLVED — DR-33/DR-31:** ship a **Kupo URL
   field** (light Kupo/Ogmios on **preprod**); **NO Blockfrost** option (default read =
   L3 `AllowedStake`, DR-33). This is the only place L5 reads Cardano off the post path.
   Remaining owner call: the default Kupo endpoint (if any) shipped with the build.
6. **Mobile / hardware-wallet CIP-8 reality (the supported-wallet matrix).** ⛔ **RESOLVED
   in shape — DR-28c:** supported wallets = those exposing a **base address (payment
   `VerificationKey` + stake cred)** + 32-byte CIP-30 keys (v1 restricts to 32-byte keys and
   one verifier, `L2-follower.md` §7.4). Remaining owner call: pin the concrete matrix
   (Eternl / Lace / …) and confirm each reliably exposes an address that is **exactly
   `datum.owner`** (the whole base Address, DR-01 — not only an extended key, not only the
   vault-adjacent address). A popular wallet outside the matrix breaks onboarding for those
   users.
7. **Onboarding sweetener (drives the first-post UX, §6.3).** `ECONOMICS.md` §6.2 /
   `L3-chain.md` §11 Q3 leave it open: a **one-time small free allowance at bind**, a
   **low `BaseCost` first post**, or **accept a short charge-up**? The FSM derives the
   first-post copy from metadata, but the owner picks the mechanic (and must keep any
   free-allowance below one post's `post_cost` so it doesn't reopen a cheap-identity burst
   farm, `L3-chain.md` §11 Q3).
8. **Composer scope vs `ECONOMICS`.** Should L5 surface a **"sustained rate" / "full
   again in Z"** readout (`ECONOMICS.md` §9) beyond the per-draft countdown, and does the
   owner want a **compact-density feed mode** at launch or deferred (§9.10)? Both are
   UX-scope calls, not derivable from the lower layers.
9. **Model C timing.** ⛔ **RESOLVED — DR-28b:** offer the Substrate-extension signer as an
   **opt-in in v1** (Model B stays the default); behind the same `PolkadotSigner` interface
   (§5.2). The remaining work is purely build sequencing (it lands in the deferred L5-M8).

---

## Appendix A — Key references

- **In-repo (authoritative — build on these, do not re-derive):**
  - `docs/L1-cardano.md` — the merged `talk_vault` validator (mint + spend, DR-18) + beacon.
    §4.2 type-1 `0b0001` header; §4.3/§7.12 ⛔ `beacon_name = blake2b_256(serialized owner
    Address)` (32 bytes, DR-01 — NOT `blake2b_256(owner_pkh)`); ⛔ the old §4.5 hash-cycle
    is DELETED (DR-18: one validator, `policy_id == vault hash`); §9.2 the
    `applyParamsToScript` type footgun; §5.1 ⛔ `datum.owner` = a full CIP-19 **Address**
    (DR-01 — NOT a single payment-key-hash; the old "pending §11 Q" is RESOLVED); §6.1–§6.4
    create/top-up/full-exit; §6.3 two-tx partial-withdraw; §7.1 "PARKED FUNDS ARE SAFE" +
    the creator-only off-chain footgun; §7.3/§7.10 datum + token-set freeze; §7.11
    burn-this-name; §9.3 floor-vs-ceiling; §10.3 never-cache-confirm.
  - `docs/L2-follower.md` — the trusted follower + CIP-8 binding. §3 trust items
    (a forge / b omission); §6.2/§6.4 burial + largest-wins; §7.1 v1 ⛔ **COMMITTED CIP-8
    payload** (sr25519 account + L3 genesis + nonce, DR-02 — NOT an opaque server-cache
    nonce) + the whole-address match; §7.2 / §9 D1 the **deferred on-chain** self-proof;
    §7.4 + §11 Q2 ⛔ the binding-key gate — **RESOLVED** to a whole-address match (DR-01),
    no longer a BLOCKING credential-kind question; §7.5 / §11 Q7 weak/manual revocation;
    §8.1 `link_identity{ owner_address, thread_pointer (10-hex, DR-23), substrate_account }`;
    §8.2/§8.4/§10 the asymmetric clamp + SPOF; §12 step 5 the wrong-address negative test,
    step 7 the audit `cursor_slot`.
  - `docs/L3-chain.md` — the runtime + feeless posting. §3.3/§9 metadata coupling +
    operator trust; §4.1 CognoGate `PkhOf`/`AccountOf` ⛔ keyed on the **32-byte**
    `blake2b_256(owner Address)` (DR-01 — NOT the old 28-byte `owner_pkh`) + `revoke` M2b
    hook; §4.3 `current_capacity` (None⇒0, capped-linear, min-clamp) + constants; §4.4
    `Posts`/`parent`/`NotAllowed`/delete-tombstone + ⛔ `NextPostId` is **u64** (DR-21);
    §5.1 `CheckCapacity::validate` (`have<need` only) + §5.3 `CheckWeight` congestion (both
    surface `ExhaustsResources`); §7 the PAPI sr25519 signer; §8.1 finality stall / honest
    centralization; §11 Q3 sweetener, Q5 credential kind (RESOLVED — DR-01), Q10 D1.
  - `docs/L4-reading.md` — reading + the capacity widget. §2.2/§5.1 post path = L3-only;
    §3.1/§3.3 Tier-A baseline + Tier-B degradation; §4.2 the read snippets; §5.2 the
    `current_capacity` replay edge cases; §6.2.3/§6.3 endpoint-as-config + L4-M5; §6.4/§7.4
    *reproducible ≠ effortless*; §6.5 the M4c archive prerequisite; §8 two-balances +
    finalized-vs-best.
  - `ECONOMICS.md` — §6.2 the onboarding sweetener; §8 the operator/weight-oracle trust
    (follower controls **rate**); §9 sustained-rate readout.
  - `PLAN.md` — §1 "no Cardano security inherited / observed not bridged"; §5 the link
    interface + the **5-byte/never-4-byte** `thread_pointer` warning + the PAPI signer.
- **External (implementation):**
  - **MeshJS** — `@meshsdk/core` (`BrowserWallet`, `MeshTxBuilder`,
    `mintPlutusScriptV3`/`spendPlutusScriptV3`, `signData`); `@meshsdk/core-cst`
    (`applyParamsToScript`, `resolveScriptHash`, `deserializeBech32Address`,
    `scriptHashToBech32`/`serializeAddressObj`, `CoseSign1`, `blake2b`).
  - **polkadot-api (PAPI)** — `polkadot-api`, `polkadot-api/ws-provider/web`, generated
    `@polkadot-api/descriptors` (`npx papi add cogno -w <ws>`; `npx papi`);
    `getTypedApi`, `getValue`/`getEntries`/`watchEntries`/`watchValue`, `finalizedBlock$`,
    `getPolkadotSigner`; `@polkadot-labs/hdkd` + `@polkadot-labs/hdkd-helpers` (sr25519
    derive, mnemonic).
  - **CIP-8 / CIP-30 / CIP-19** — CIP-30 `signData` (`COSE_Sign1`), CIP-8 message signing,
    CIP-19 address structure (type-1 / type-6 / type-0, header nibbles); the follower's
    `pycardano.cip.cip8.verify` is the v1 verifier of record (`L2-follower.md` §7.1).
  - **WebCrypto (SubtleCrypto)** — AES-GCM for the keystore cipher + an **Argon2id** KDF
    (DR-28a; Argon2id is not a native `crypto.subtle.deriveKey` algorithm) for the
    passphrase-derived key (encrypts the **seed bytes**; the sr25519 signature is done by
    hdkd, §5.2).
  - **Next.js** — static export (`output: 'export'`), App Router, client components;
    Content-Security-Policy + Subresource Integrity for the §5.4 browser threat model.
