# cogno-chain L1 — Cardano Vault + Beacon

> Deep-dive design for the Cardano (L1) side of cogno-chain: an **owner-reclaimable
> ADA vault** marked by a per-user **beacon NFT**. Park ADA (≥ a single 100-ADA
> floor), reclaim it anytime; the beacon NFT (`token_name = blake2b-256(serialized
> owner Address)`) marks your **one canonical vault UTxO** and makes it trivially
> findable by asset. Written to be picked up cold and implemented from scratch.
> Style matches `cogno_v3_contracts` — the beacon mint/burn is the **exact
> `thread.ak` mint-on-create / burn-on-remove pattern**, realized as a **SINGLE
> merged validator** with both a `mint` and a `spend` handler
> (`mint(redeemer, policy_id, self)`, `MintRedeemer = List<MintTypeRedeemer>`,
> `mint_validation` + `mint_length_and_uniqueness`, the `assets.flatten` two-tuple
> swap). Aiken `v1.1.16` + stdlib `v2.2.0`, `plutus = v3`.
>
> **This doc EXTENDS the prior pure-vault design — it does not discard it.** Every
> spend-side finding (owner-sig-on-every-path, single-own-input, floor,
> value-non-decrease, ADA-only/token-set-frozen, datum-freeze, the creator-only
> escape hatch, no-timelock) carries forward **unchanged**. The beacon **adds** a
> mint handler (now merged into the same validator) and three new spend-side rules
> (carry-the-beacon-forward, burn-on-exit, no-strip) on top.
>
> **Two earlier premises stay dropped** (§2): a CIP-19 **script stake credential**
> pinning delegation, and an on-chain **timelock / cooldown**. **One premise is now
> COLLAPSED** (§9): the "parameterized `min_lock` ⇒ many contracts = tiers" idea is
> replaced by **ONE contract** (`min_lock = 100 ADA`); tiers are now simply how much
> ADA sits in your single beacon-marked vault (continuous capped-linear weight).
>
> **Status (2026-06): NOT YET COMPILED.** The skeleton (§8) is paste-and-ship-mature
> but uncompiled; the negative-test suite (§8.5) and `aiken check` MUST pass before
> any freeze (§12 step 4).

> **RECONCILED to DECISION-REGISTER.md (2026-06-16).** The decisions below are
> canonical and OVERRIDE any contrary statement that survives inline in this doc:
>
> - **DR-01 — identity = the WHOLE Address.** The vault datum is now
>   **`VaultDatum { owner: Address }`** (a full CIP-19 `Address` = payment credential
>   + stake credential), NOT `{ owner_pkh }` (supersedes §4.4, §5.1, §8.1). v1
>   restricts the payment credential to a `VerificationKey` (no script/multisig owner
>   yet). The beacon **`token_name = blake2b_256(serialized owner Address)`** (32
>   bytes), NOT `blake2b_256(owner_pkh)` (supersedes §1, §4.3, §7.12). The L2/L3
>   binding keys on `blake2b_256(owner Address)` (== the beacon name). **The
>   continuation/create rule now ALSO enforces `vault_address.stake_cred ==
>   datum.owner.stake_cred`** — re-tightening the old §4.6/§7.5 payment-cred-only
>   relaxation to whole-Address consistency.
> - **DR-18 — STRICT beacon via ONE merged validator.** There is now a **SINGLE
>   validator `talk_vault(min_lock)`** with BOTH a `mint` and a `spend` handler (the
>   cogno_v3 `thread.ak` shape): `policy_id == vault script hash`; the mint arm
>   asserts the beacon lands at the script's **OWN** address (a real on-chain
>   "beacon ⇒ canonical vault" guarantee). This **DELETES** the previous two-validator
>   design, the separate beacon minting policy, the `beacon_policy_id` PARAMETER, and
>   the **ENTIRE hash-cycle concern** (old §4.5 is now moot — there is no cycle with a
>   single validator). The beacon `policy_id` IS `this_hash` in both handlers
>   (supersedes §4.1, §4.5, §4.6, §8.3, §8.4, §9.2).
> - **DR-02 — CIP-8 = committed payload.** The off-chain identity proof is now a
>   domain-separated signature committing `{ sr25519 account + L3 genesis hash + fresh
>   nonce }`; the follower verifies signature valid + signing address == `datum.owner`
>   (the WHOLE address, payment AND stake) + payload-sr25519 == the submitted
>   sr25519. The old "wrong-address binding gotcha" is **structurally closed**
>   (supersedes the §10.2 "payment cred == owner_pkh" framing). The on-chain ed25519
>   self-proof is the deferred D1.
> - **DR-13 — v1 has NO on-chain timelock / NO `lock_until`** (already this doc's
>   final design, §7.13; now canonical — the ECONOMICS/PLAN cooldown-on-Cardano
>   language is superseded, not this doc).
> - **DR-34 — the old "L2 is still group-and-sum / a LIVE double-dip" banner is
>   FALSE and REMOVED.** `docs/L2-follower.md` on disk is already largest-wins /
>   never-sum; there is no live stake-splitting double-dip (supersedes the §0 status
>   banner, §1, §3, §7.14, §10 framing). §10.7 remains a useful cross-check list but
>   is **no longer a "mustFix-or-live-exploit."**
> - **DR-21 — NextPostId / post counters are `u64`** (an L3 fact; noted here only
>   where this doc gestures at L3).
>
> Where the inline text below still says `owner_pkh`, "two validators,"
> `beacon_policy_id`, `blake2b_256(owner_pkh)`, or "live double-dip," read it through
> this block: the reconciled shape above wins.

---

## 1. TL;DR

- **One vault + one beacon, ONE merged validator.** A plain **owner-reclaimable ADA
  vault** marked by an unforgeable **beacon NFT** that lives **inside** the vault
  UTxO. The vault spend and the beacon mint/burn are now the **same** validator
  `talk_vault(min_lock)` (a `mint` handler + a `spend` handler, the cogno_v3
  `thread.ak` shape) — so `beacon policy_id == vault script hash`. Park ADA, reclaim
  anytime. **No timelock, no `lock_until`, no cooldown.**
- **The beacon NFT.** `policy_id =` the **`talk_vault` script hash** (the merged
  validator IS the policy); `token_name = blake2b_256(serialized owner Address)`
  (32 bytes — exactly the asset-name max; matches cogno_v3's blake2b hashing style).
  Mint **exactly +1** on register, burn **exactly −1** on full exit. The full asset
  `(policy_id, token_name)` is a **deterministic function of the owner Address** →
  trivially findable.
- **Only YOU can mint YOUR beacon.** The mint arm requires the signer whose Address
  **hashes** to the minted name (`blake2b_256(serialized owner Address) ==
  token_name` **and** `owner.payment_credential`'s vkey-hash `∈ extra_signatories`)
  **and** that the beacon lands at the script's **OWN** address (`policy_id ==
  this_hash`). Unforgeable, no griefing, no name-squatting.
- **The vault UTxO** = parked ADA (`lovelace ≥ min_lock`) **+ exactly 1 beacon**,
  and **nothing else** (ADA + that one beacon ONLY). Inline datum =
  `VaultDatum { owner: Address }` — one field, a **whole CIP-19 Address** (payment
  `VerificationKey` cred + stake cred), the identity anchor.
- **Address = CIP-19 BASE (type-1) address:** SCRIPT payment credential
  (`talk_vault`) + the **USER'S OWN** key-hash stake credential (header high nibble
  `0b0001`, §4.2). **That stake credential MUST equal `datum.owner.stake_cred`**
  (DR-01) — the locked ADA provably delegates with the identity's stake key.
  Delegate to **any** pool, keep your **own** rewards; the script never runs on a
  stake action. The beacon does **not** change the address form.
- **Spend enforces (EVERY path):** owner sig — `datum.owner.payment_credential`'s
  vkey-hash in `extra_signatories`; **single own-script input** (double-satisfaction
  guard, REINFORCED by the beacon, §7.4).
- **Spend enforces (continuation):** every continuing output carries the **SAME 1
  beacon forward**, `lovelace ≥ min_lock`, value **non-decreasing**, datum frozen,
  is **ADA + exactly the 1 beacon ONLY** (no other tokens, no second beacon), and
  has `output.address.stake_cred == datum.owner.stake_cred` (whole-Address
  consistency, DR-01).
- **Full exit MUST burn the beacon** (`mint == −1` of this beacon); a full exit has
  no continuing output, so the beacon has nowhere to go and is retired. A bare
  reclaim that *leaks* the beacon to a side wallet is **forbidden** (§7.11).
- **Operations:** create = **mint beacon** + pay `≥ min_lock` ADA with
  `{ owner: Address }` datum; top-up = add ADA (beacon forward, value
  non-decreasing); **partial-withdraw = TWO sequential txs** (full exit/burn, then
  re-register/mint at the smaller `≥ min_lock` amount) — a one-tx shrinking
  continuation is **impossible** (§6.3); full-withdraw / LEAVE = **burn beacon** +
  reclaim all ADA.
- **On-chain CANNOT enforce global one-beacon-per-identity.** A mint handler is
  **tx-local** — it cannot see other UTxOs, so an identity can mint a second beacon
  in a separate tx. **This is fine and is NOT an L1 fund hole** (the beacon confers
  no on-chain authority). **Do not claim the mint guarantees global uniqueness.**
- **Uniqueness is the FOLLOWER's largest-wins rule** (§10): index by beacon
  **policy id** (== the vault hash), group by the **owner Address**, and for
  duplicates use the **LARGEST** (most ADA) beacon UTxO for weight — **NEVER sum**.
  This makes a second beacon pointless and incentivizes consolidating to one vault.
  The L2 follower on disk is already largest-wins (DR-34) — **there is no live
  summing double-dip.**
- **Multi-set COLLAPSED to ONE contract** (§9): `min_lock = 100_000_000` lovelace
  (100 ADA). Tiers are now continuous capped-linear weight in your single vault's
  ADA, **not** separate parameterized contracts. A higher-floor second contract may
  be deployed later but is **not** the tiering mechanism.
- **The beacon is NOT the talk token.** It is a **registration / uniqueness /
  findability** marker. Talk capacity is a **non-transferable L3 runtime number**;
  identity is the **whole owner Address** proven via **CIP-8** off-chain (L2). Under
  DR-02 the CIP-8 message is a **committed payload** (`{ sr25519 account + L3 genesis
  hash + fresh nonce }`); the follower verifies the recovered signing **address ==
  `datum.owner`** (payment AND stake cred — an exact whole-address match), so a
  bind-hijack is **prevented**, not just detected.
- **No-timelock voice-lag** (a user can unlock anytime) is closed at **L2**, not
  on-chain: bury past depth k before granting weight; clamp L3 capacity to zero on
  observed unlock (a beacon **burn** is an equivalent leave signal, §10.4).

---

## 2. Scope & decided design

### 2.1 What L1 IS responsible for

- **Holding parked ADA** at the single vault address (`min_lock = 100 ADA`).
- **Minting / burning the beacon NFT** unforgeably (only the owner can mint their
  own; exactly +1 register, exactly −1 leave).
- **Enforcing the floor** (`lovelace ≥ min_lock`) on every continuing output **and
  at mint time** (creation runs no spend, §7.8).
- **Owner-only spend** of a vault UTxO (`datum.owner.payment_credential`'s vkey-hash
  in `extra_signatories`) — on every path.
- **Continuation integrity** — `datum.owner` (the whole Address) frozen, value
  non-decreasing, **ADA + exactly the 1 beacon ONLY** on any continuing output,
  **same beacon carried forward**, and `output.address.stake_cred ==
  datum.owner.stake_cred` (whole-Address consistency, DR-01).
- **Burn-on-exit** — a full exit (no continuing output) must burn the beacon, bound
  to *this* vault's datum name (§7.11).
- **Double-satisfaction prevention** across vault inputs (single-own-input guard)
  and across mint↔spend (each side checks its own invariant, §7.8).

### 2.2 What L1 is NOT responsible for

- **Global one-beacon-per-identity uniqueness.** Impossible on-chain (mint is
  tx-local). The follower's **largest-wins** rule is the uniqueness mechanism (§10).
  L1 must not pretend otherwise.
- **Capacity / talk math is L3.** Regen, decay, "cost per post," and the
  per-identity ceiling/cap (capped-linear: floor at `min_lock`, saturating to a max
  at high stake; numbers TBD in L3). L1 exposes only parked-lovelace + the owner
  `Address` + the beacon per UTxO.
- **Aggregation, duplicate-resolution + CIP-8 verification is L2.** Selecting the
  largest beacon UTxO per owner Address, the reorg-safe read model, and binding an
  L3 account to an owner Address via CIP-8 (the DR-02 committed-payload proof) are
  the follower's job (§10).
- **The no-timelock voice-lag window is L2/L3** (§10.5), not on-chain.

### 2.3 Two explored-and-dropped premises (one line each)

- **Dropped: CIP-19 script stake credential.** An earlier draft pinned delegation
  via a script STAKE credential. Dropped when delegation became **any-pool**: the
  user keeps their own key-hash stake credential and delegates wherever they like.
- **Dropped: timelock / cooldown.** An earlier draft gated spend on a `lock_until`
  slot. Dropped because **L3 regen already enforces the commitment** (talk starts at
  zero, accrues only while parked, clamps to zero on unlock). May return **later as
  an opt-in commitment bonus** — not in v1.

### 2.4 One COLLAPSED premise (the multi-set → single-contract change)

- **Collapsed: parameterized `min_lock` ⇒ many "tier" contracts.** The prior doc
  minted a distinct script hash per `min_lock` value, each a separate "set/tier."
  **v2 ships ONE contract** at `min_lock = 100_000_000` lovelace. **Tiers are now
  continuous:** how much ADA sits in your single beacon-marked vault, scored by a
  capped-linear weight (floor at `min_lock`, ceiling at L3). A second higher-floor
  contract could be deployed later but is **not** the tiering mechanism. The
  follower therefore indexes **one** policy / **one** address in v1 (§10).

---

## 3. Feasibility verdict

**Verdict: MATURE design, LOW-RISK for parked funds — but NOT YET FROZEN (2026-06).**
The on-chain design is funds-safe and paste-and-ship-mature; the **only** outstanding
work before freeze is mechanical and is enumerated in §3's "still needs care" list and
the §0 milestones: (1) the §6.3 partial-withdraw is two txs (now stated correctly),
(2) compile + run the §8.5 negative suite, (3) the trivial `use cardano/transaction`
import (§8.4), (4) wire the merged single validator (DR-18 — `policy_id == this_hash`,
no separate beacon policy, no build-order cycle). The old "L2 is still group-and-sum /
a LIVE double-dip" item is **gone** (DR-34): the follower on disk is already
largest-wins; §10.7 is a cross-check, not a live exploit.

The vault half is a textbook owner-reclaimable continuing-output vault — the most
well-trodden pattern on Cardano. The beacon half is the **exact mint-on-create /
burn-on-remove pattern `cogno_v3/thread.ak` already ships, in the same SINGLE merged
validator** (`mint(redeemer, policy_id, self)` + `spend(...)` →
`validate.mint_validation` + `validate.mint_length_and_uniqueness`; `Burn(tkn)` →
`quantity_of == -1`; the `assets.flatten` two-tuple swap). There is **one deliberate
deviation** from `thread.ak`: its token name is a 5-byte slice of a spent
`OutputReference` (`util.token_name(txid, idx)`, for per-thread uniqueness), whereas
the beacon name is `blake2b_256(serialized owner Address)` so the asset is a
**stable, publicly re-derivable function of identity** (DR-01). The destination check
is `output_hash == policy_id` — exactly `thread.ak`'s own `output_hash ==
currency_symbol`, because under DR-18 the beacon policy id **IS** the vault script
hash (the merged validator: `policy_id == this_hash`). Every primitive used exists
with the exact signatures used in vendored stdlib `v2.2.0` (verified against the
**source**, not the rendered HTML).

**Mature (paste-and-ship):**

- The mint handler shape, the `Mint`/`Burn` redeemer-list recursion, the
  `mint_length_and_uniqueness` guard, the no-trash `policies(value) |> length == 2`
  idiom, and the `option.is_none(reference_script)` check are **verbatim
  `thread.ak`/`validate.ak`** (only the token-name source changes; the destination
  check `output_hash == policy_id` is `thread.ak` verbatim — DR-18's merged
  validator restores `policy_id == this_hash`).
- The spend handler shape, owner-sig idiom, and continuing-output checks are exactly
  `thread.ak`'s primitives (`list.has(extra_signatories, owner)?`,
  `transaction.find_input`, `expect Script(this_hash)`, the `list.all(outputs,
  quantity_of == 0)` burn check, `and { ..? }`).
- The CIP-19 **type-1 base address** is the single most common script address form
  on Cardano; off-chain construction is turnkey in Mesh (`mesh-core-cst`).

**Still needs care — the residual risk is in the on-chain *skeleton* and the
off-chain *creation*, not the design:**

- ✅ **The follower's largest-wins rule is already on disk (DR-34).** With the
  tx-local mint, a user *could* mint N same-name beacons in N separate txs, but the
  L2 follower groups by the owner Address and uses the **largest** beacon UTxO,
  never sums — so a second beacon confers no extra voice. §10.7 is a consistency
  cross-check, **not** a live exploit. No L1 funds were ever at risk here.
- ⛔ **The single-own-input double-satisfaction guard** (`== 1`) is the one
  load-bearing check a "simplifying" edit can silently delete (§7.4). The beacon
  adds a second, independent DS defense (per-input beacon tagging) but does **not**
  replace the count guard — both of a user's vaults share the **same** beacon name,
  so the beacon does not disambiguate them; the guard is on payment-cred **count**.
- ⛔ **The beacon must be carried forward on every continuation and burned on every
  full exit.** Dropping the carry-forward strips the beacon to a side output
  (breaks findability / strands the beacon, §7.10); dropping the burn-on-exit leaks
  an orphan beacon into the follower index (§7.11). The burned name MUST be derived
  from *this* vault's datum so a tx cannot burn-A-while-exiting-B (§7.11).
- ⛔ **The mint arm and the spend arm must each independently enforce their own
  invariant** — the classic cross-script double-satisfaction hole (Vacuumlabs #2).
  This is true **even though they are now the same validator (DR-18)**: the two
  handlers run on different purposes and must not assume the other ran. A fresh
  register runs **only the mint** handler (no spend on creation), so the **mint**
  must itself check the beacon lands in a well-formed vault output at the script's
  OWN address (`output_hash == policy_id`), `≥ min_lock` (§7.8); a full exit's spend
  must itself check `mint == −1` (§7.11) and **not** trust "the mint verified the
  burn." The list-form redeemer + uniqueness guard blocks a self-cancelling
  `+1(A)/−1(B)` launder in one tx (§7.7).
- **Creation correctness is load-bearing off-chain** (§6.1) — but the mint-time
  datum check (`datum.owner == reconstructed signer Address`) **provably neutralizes**
  the bad-datum-vs-beacon interaction: a real beacon can never be minted **into** a
  malformed-datum vault (§7.6). The remaining bad-datum/no-datum escape hatches lose
  only the **creator's own** ADA, never a third party's.
- ⛔ **`token_name = blake2b_256(serialized owner Address)` is exactly 32 bytes** —
  the asset-name maximum, zero headroom. Do **not** prefix/suffix it (e.g. a CIP-67
  label) or the mint becomes invalid; if a label is ever wanted, switch to
  `blake2b_224` (28 B) (§7.12). The mint arm, the spend arm, **and** the follower
  must use the **identical** `util.beacon_name` function (over the same serialized
  Address) or they index a different asset.
- ⛔ **`policies(value) |> length == 2` is CORRECT (do not "fix" it to `== 1`).** In
  stdlib `v2.2.0` SOURCE `policies = dict.keys(self.inner)` and lovelace lives under
  the empty policy id `""`, so `policies` **includes** the lovelace policy. Length 2
  = lovelace + the one beacon. The rendered HTML doc misleadingly says `policies`
  excludes Ada; the **source** is authoritative, and `validate.ak:54` uses `== 2`
  verbatim (§7.8). `add()` strips zero-quantity keys, so the `without_lovelace`
  equality (§7.10) is an **exact** non-ADA token-set match.

Honest one-liner: **PARKED FUNDS ARE SAFE — every spend path is gated by
`list.has(extra_signatories, owner_payment_vkey_hash)` unconditionally before any
value moves, and the floor / non-decrease / single-own-input / token-set-freeze /
datum-freeze / whole-Address-stake-consistency / beacon-forward / burn-on-exit guards
close every high/critical attack. The only ways to get hurt are to relax one of those
guards, to let the mint handler trust the spend handler (or vice-versa), to use a
mismatched token-name hash, or to mis-create the vault off-chain (creator-only
footgun).** The follower largest-wins rule is already on disk (DR-34), so the old
"summing double-dip" exit is closed. The ⛔ markers in §7/§8/§10 flag every such line.

---

## 4. Architecture

### 4.1 ONE merged validator (DR-18)

There is **ONE** on-chain validator `talk_vault(min_lock)` with **both** a `mint` and
a `spend` handler — the cogno_v3 `thread.ak` shape, where `policy_id == script_hash`.
The beacon policy id **IS** the vault script hash; the mint arm can therefore assert
the beacon lands at the script's **OWN** address with `output_hash == policy_id` (a
real on-chain "beacon ⇒ canonical vault" guarantee). There is no separate beacon
policy, no `beacon_policy_id` parameter, and **no hash cycle** (the old §4.5 concern
is moot with a single validator).

```aiken
// ONE merged validator (DR-18): the beacon policy id IS this validator's hash.
validator talk_vault(min_lock: Int) {
  // beacon mint/burn (thread.ak shape; policy_id == this script hash)
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    // Mint(addr): blake2b_256(serialize(addr))==token_name, owner's PAYMENT vkey
    //             signs, exactly +1, lands at THIS script's OWN address
    //             (output_hash == policy_id), >= min_lock, datum.owner == addr,
    //             output stake_cred == addr.stake_cred, ADA + that 1 beacon ONLY,
    //             no ref script.
    // Burn(tkn):  exactly -1 of (policy_id, tkn).
  }
  // owner-reclaimable ADA vault
  spend(maybe_datum: Option<Data>, redeemer, utxo: OutputReference, self: Transaction) {
    // owner PAYMENT-key sig (every path) + single-own-input + (on continuation)
    // floor / value-non-decrease / ADA+1-beacon-only / datum-freeze /
    // beacon-forward / stake_cred == datum.owner.stake_cred; (on full exit) burn
    // the beacon bound to this datum's owner Address.
  }
  else(_) { fail }
}
```

`min_lock` is collapsed to a single value (`100_000_000`); it is **no longer** the
tiering knob (§9), and it is now the **only** parameter. The spend handler reads its
own payment credential off the input (`expect Script(this_hash)`), exactly as
`thread.ak` does, and references the beacon under that same `this_hash` (the policy id
== the script hash). The mint handler likewise references the beacon under the
ledger-supplied `policy_id`, which equals the script hash.

### 4.2 The base address (unchanged)

The vault address is a **CIP-19 BASE address with a SCRIPT payment credential and a
KEY-HASH stake credential**. The beacon does **not** change the address form. Per
CIP-19, the header high nibble:

- `0b0000` = type 0 = KEY payment + KEY stake.
- **`0b0001` = type 1 = SCRIPT payment + KEY stake.** ← **this is our address.**
- `0b0010` = type 2 = key payment + script stake; `0b0011` = type 3 = script
  payment + script stake (the dropped design).

The off-chain builder and its header-nibble assertion (§12 step 5) MUST use
`0b0001`. Bytes after the header: 28-byte script payment hash ‖ 28-byte stake key
hash.

- **PAYMENT credential** = `Script(talk_vault_hash)` — gates *spending* the UTxO
  (runs `talk_vault.spend`).
- **STAKE credential** = `Inline(VerificationKey(user_own_stake_key_hash))` — the
  **user's own** key-hash stake cred, governing delegation (any pool),
  vote-delegation, and reward withdrawal, witnessed by their own key. The
  `talk_vault` script never runs on any stake action; the parked ADA stays
  script-locked. Delegation is **non-custodial**.
- **DR-01 — whole-Address consistency.** This vault-address stake credential MUST be
  **byte-identical to `datum.owner.stake_cred`**, enforced on create (mint arm) and
  every continuation (spend arm). Because identity is now the **whole** owner
  `Address`, the locked ADA provably delegates with the identity's own stake key —
  the old §4.6/§7.5 payment-cred-only relaxation is **re-tightened** to whole-Address.

### 4.3 The beacon NFT

- **`policy_id`** = the **`talk_vault` script hash** (DR-18: the merged validator IS
  the policy; `policy_id == this_hash`). There is no separate beacon minting policy.
- **`token_name`** = `blake2b_256(serialized owner Address)` — a 32-byte digest of
  the **whole CIP-19 owner Address** (payment `VerificationKey` cred + stake cred),
  within the 0–32-byte asset-name limit; chosen for a clean 32-byte name in
  cogno_v3's blake2b style; `blake2b_224` (28 B) would also fit if a shorter name
  were ever needed, e.g. to leave room for a CIP-67 label. **Deterministic per owner
  Address** ⇒ given an Address you compute its `token_name`; given the policy id you
  index **all** beacons. The serialization is the canonical CIP-19 address bytes
  (the same the off-chain builder and the follower must use — §7.12).
- **Lifecycle:** minted **exactly +1** when the user registers (creates their
  vault), burned **exactly −1** on full exit/LEAVE. Lives **inside** the vault UTxO.

### 4.4 The vault UTxO

A vault is exactly one UTxO:

- **`value`**: parked ADA, `lovelace ≥ min_lock`, **+ exactly 1 beacon**, and
  **nothing else** (ADA + that 1 beacon ONLY — the no-trash `policies(value) |>
  length == 2` idiom: lovelace policy `""` + beacon policy = exactly 2 policies).
- **`datum`** (inline): `VaultDatum { owner: Address }` — a **whole CIP-19 Address**
  (payment `VerificationKey` credential + stake credential; v1 restricts the payment
  cred to `VerificationKey`, DR-01). No time field, no token pointer. (Note: unlike
  `ThreadDatum`, the beacon name is **not** stored in the datum — it is *derived*
  from `blake2b_256(serialized owner)`, so it cannot drift.) The vault address's own
  stake credential MUST equal `owner.stake_cred` (DR-01, §4.2).

### 4.5 ONE merged validator — no hash cycle (DR-18)

> **SUPERSEDED.** This section previously argued for TWO validators (a separate
> beacon minting policy + the vault spend) to avoid a hash cycle, and resolved the
> cycle by having the beacon policy *not* check the destination address. **DR-18
> deletes all of that.** There is now a **single** validator
> `talk_vault(min_lock)` with both a `mint` and a `spend` handler (the cogno_v3
> `thread.ak` shape). The detail below records the new, simpler reality.

A single `validator talk_vault { mint; spend }` (the `thread.ak` shape, where
`policy_id == script_hash`) is exactly what cogno_v3 does, and is what we ship. The
old worry — "the mint side wants to verify the beacon goes into a real vault output
at the vault address, which needs the vault hash, and if the vault hash were
parameterized by the beacon policy id you'd have a hash cycle" — **does not arise**,
because with one merged validator the beacon `policy_id` simply **IS** the script
hash. There is nothing to parameterize by and nothing to compute in a particular
order.

- **No cycle: single validator.** The mint handler asserts the beacon lands at the
  script's **OWN** address with `output_hash == policy_id` (the ledger supplies
  `policy_id`, which equals the script hash) — a real on-chain "beacon ⇒ canonical
  vault" guarantee, exactly the way cogno_v3's `validate.ak:50` does
  (`output_hash == currency_symbol`). It checks: `blake2b_256(serialize(owner)) ==
  token_name`, the owner's **payment** vkey signs, **exactly +1**, the beacon lands
  at `output_hash == policy_id` carrying a well-formed `VaultDatum` whose `owner ==`
  the minted Address with `lovelace ≥ min_lock`, `output.stake_cred ==
  owner.stake_cred`, ADA + that 1 beacon only, no ref script. The **spend** handler
  enforces beacon-in-**this**-vault on every continuation and burn-on-exit, under the
  same `this_hash`.
- **No `beacon_policy_id` parameter.** The only compile-time parameter is `min_lock`.
  Both handlers reference the beacon under the script's own hash (mint: the
  ledger-supplied `policy_id`; spend: `this_hash` read off the input). ⛔ Do **not**
  reintroduce a `beacon_policy_id` param or a second validator — that was the old
  two-validator shape (DELETED by DR-18). The off-chain build script computes the
  single script hash, derives the beacon policy id from it (they are equal), and
  asserts the type-1 base-address header high nibble is `0b0001` (§9.2, §12 step 5).

### 4.6 Address / UTxO / mint / spend flows (ASCII)

```
                  CIP-19 TYPE-1 BASE VAULT ADDRESS  (ONE merged validator; min_lock = 100 ADA)
                  header high nibble 0b0001 = SCRIPT payment + KEY stake
   +-------------------------------------------------------------------------+
   |  PAYMENT cred = Script(H_vault)    STAKE cred = Key(user_own_stake_key)  |
   |  H_vault = blake2b224( talk_vault $ (min_lock) )                         |
   |  stake part is the USER'S OWN key -> delegate ANY pool, keep own rewards |
   |  ⛔ stake cred MUST == datum.owner.stake_cred  (DR-01 whole-Address)      |
   +-------------------------------------------------------------------------+
                              |
                       spends |  (talk_vault.spend runs)
                              v
                  +--------------------------------------+
                  |            VAULT UTxO                 |
                  |  value: parked ADA (>= 100 ADA)      |   <- ADA + EXACTLY 1 beacon
                  |       +  1 x BEACON NFT               |      ONLY (policies len == 2)
                  |  beacon = (H_vault, blake2b256(addr)) |   <- policy id == script hash
                  |  datum: VaultDatum { owner: Address } |   <- whole CIP-19 Address
                  +--------------------------------------+

   MINT handler  (P_beacon == H_vault; talk_vault.mint)         -- thread.ak shape, MERGED
   -------------------------------------------------------------------------------------
   redeemer: MintRedeemer = List<MintTypeRedeemer>   (Mint(addr) | Burn(tkn))
   Mint(addr):   blake2b_256(serialize(addr)) == token_name (name bound to Address)
                 addr.payment vkey-hash in extra_signatories (only YOU mint YOURS)
                 quantity_of(mint, policy_id, name) == 1      (EXACTLY +1)
                 beacon lands at THIS script's OWN address:
                   output_hash == policy_id (== this hash),
                   datum.owner == addr, output.stake_cred == addr.stake_cred,
                   lovelace >= min_lock,
                   ADA + that 1 beacon ONLY (policies len 2), no ref script
                                                             (mint stands ALONE)
   Burn(tkn):    quantity_of(mint, policy_id, tkn) == -1      (EXACTLY -1)
   guard:        dict.size(tokens(mint, policy_id)) == len(redeemer); list.unique
                 (blocks +2, a 2nd name/junk, dup entries, +1(A)/-1(B) launder)

   SPEND handler (PAYMENT cred) — the vault logic
   ----------------------------------------------
   redeemer: Spend            (optionally TopUp | PartialWithdraw | FullWithdraw)
   ALWAYS (every path, BEFORE the branch):
     - list.has(extra_signatories, owner.payment vkey-hash) (owner signed)
     - EXACTLY ONE own-script input                         (double-satisfaction)
   IF a continuing output exists ([cont]):
     - lovelace_of(cont.value) >= min_lock                  (floor)
     - lovelace_of(cont.value) >= lovelace_of(in)           (NON-DECREASING)
     - quantity_of(cont.value, this_hash, name) == 1        (SAME beacon forward)
     - without_lovelace(cont.value) == without_lovelace(in) (ADA + that 1 beacon ONLY)
     - cont.address.stake_cred == datum.owner.stake_cred    (whole-Address, DR-01)
     - cont.datum == this_input.output.datum                (owner Address frozen)
   IF NO continuing output ([] = full exit / LEAVE):
     - quantity_of(self.mint, this_hash, name) == -1        (BURN this datum's beacon)
     - list.all(outputs, qty(beacon) == 0)                  (beacon in NO output)
   IF MORE THAN ONE own-script output (_):
     - False                                                (fan-out rejected)

   FLOWS
   -----
   create   : MINT beacon (+1) + pay ADA (>= min_lock) + that beacon to the addr
              with VaultDatum { owner: Address }.       [talk_vault.mint runs; no spend]
   top-up   : spend, ONE continuing output, ADA GROWS (non-decreasing), SAME beacon
              forward, datum frozen.                     [talk_vault.spend [cont] arm]
   partial  : IMPOSSIBLE in one tx (continuation can't shrink; same-name burn+remint
              blocked by mint_length_and_uniqueness). Do TWO sequential txs:
              tx1 = full exit/burn; tx2 = re-register/mint at the smaller >= min_lock
              amount. (Or "over-park then never reduce".)             -- §6.3
   full     : owner spends, NO continuing output, BURN the beacon (-1), reclaim all ADA.

   NO validity-interval / time check anywhere.  NO publish/withdraw handler.
```

**Cross-cutting note (RE-TIGHTENED by DR-01).** The stake credential is the **user's
own** key, but it is now **weight-bearing identity** (the beacon name hashes the whole
Address). So a continuing output MUST keep `output.address.stake_cred ==
datum.owner.stake_cred` — it may **not** re-point to a different stake key. The old
relaxation that pinned only the PAYMENT credential is **superseded**: the
continuation now pins the **whole Address** (payment cred via the script + stake cred
via this equality + datum-freeze on `owner`), plus floor / value-non-decrease /
ADA+beacon-only / beacon-forward (§7.5). Re-pointing the stake key is now a leave +
re-register (a new Address ⇒ a new beacon name).

---

## 5. Datum & redeemers

### 5.1 Vault datum (`lib/types.ak`, mirroring `ThreadDatum` field-comment style)

```aiken
use cardano/address.{Address}

pub type VaultDatum {
  // owner of this vault; the identity anchor (DR-01). The WHOLE CIP-19 Address:
  // payment credential (v1: VerificationKey only) + stake credential. CIP-8
  // signatures resolve to this whole address off-chain (committed payload, DR-02).
  // The beacon token_name is blake2b_256(serialize(owner)) -- DERIVED, never stored.
  owner: Address,
}
```

**One field, justified (DR-01):** `owner` is the only identity primitive L1 needs, and
it is the **whole** CIP-19 Address. Its **payment credential** (a `VerificationKey`
in v1) is what `extra_signatories` is checked against on spend; the **whole serialized
Address** is what the beacon `token_name` is derived from
(`blake2b_256(serialize(owner))`); and the whole Address is what the L2 follower
groups vault UTxOs by. The vault address's own **stake credential MUST equal
`owner.stake_cred`** (§4.2, §7.5). **No time field** (no `lock_until` to compare
against; the commitment is an L3 runtime property, DR-13). **The beacon name is not a
datum field** — deriving it from the Address means a malicious datum can never claim a
beacon name that mismatches its owner, and the derived name cannot drift across a
continuation (the datum is frozen, §7.3). It is also what binds the burned name on
full exit to *this* vault (§7.11).

> v1 **restricts the payment credential to `VerificationKey`** (no script/multisig
> owner yet — a script owner is a deferred extension). The mint/spend handlers should
> `expect VerificationKey(owner_vkh) = owner.payment_credential` so a script-payment
> Address is rejected on create.

### 5.2 Vault redeemer (`lib/types.ak`, enum like `ThreadRedeemer`)

A **single `Spend` variant is sufficient** — the validator's logic is identical
regardless of intent (owner sig + single-own-input always; the continuation/exit
rule branches on continuing-output count, not on the redeemer).

```aiken
pub type VaultRedeemer {
  Spend
}
```

**Optional named intents** (off-chain readability only; one on-chain code path; **all
require the owner sig**): `TopUp | PartialWithdraw | FullWithdraw`. Ship the single
nullary `Spend` (cleanest, most cogno_v3-like). **There is no `Lock`/`Create`
redeemer** — creation is *minting + paying* into the address; the spend validator
never runs on creation.

### 5.3 Mint redeemer (`lib/types.ak`, mirroring `MintTypeRedeemer` / `MintRedeemer`)

Mirror `thread.ak`'s list-style redeemer and per-entry recursion **exactly** —
**one deviation (DR-01)**: `Mint` now carries the **whole owner `Address`** so the
mint handler can recompute the token name (`blake2b_256(serialize(addr))`) and check
the owner's **payment-key** signer (cogno_v3's `Mint` is nullary because its name
comes from a spent UTxO; ours comes from the Address).

```aiken
use cardano/address.{Address}
use cardano/assets.{AssetName}

pub type MintTypeRedeemer {
  Mint(Address)   // register: owner Address -> token_name = blake2b_256(serialize(addr))
  Burn(AssetName) // leave: burn exactly -1 of this beacon (thread.ak verbatim)
}

pub type MintRedeemer =
  List<MintTypeRedeemer>
```

The list form + `mint_length_and_uniqueness` (§7.7) is what blocks a single tx from
minting `+1` of beacon-for-A while burning `-1` of beacon-for-B to launder a
cross-script double-satisfaction, **and** is precisely why a one-tx same-name
burn+remint partial-withdraw is impossible (a `[Burn(name), Mint(addr)]` redeemer has
length 2 but a `+1/−1` of one name gives `dict.size(tokens) == 1`, so the guard fails —
§6.3).

---

## 6. Operations & lifecycle

Each step names the validator/policy that fires (or notes that none does).

### 6.1 create-vault (register) — MINT the beacon + pay into the address

In one tx: **mint exactly +1** of `(this_hash, blake2b_256(serialize(owner)))`, and
pay parked ADA (`lovelace ≥ min_lock`) **plus that beacon** to the type-1 base
address with inline `VaultDatum { owner }`.

- **Fires: `talk_vault.mint` (the `Mint(addr)` arm).** It enforces, atomically and
  **standing alone** (there is no spend running on a fresh register, §7.8):
  `blake2b_256(serialize(addr)) == token_name`; `addr.payment` vkey-hash `∈
  extra_signatories`; **exactly +1**; the beacon lands at the script's **OWN** address
  (`output_hash == policy_id == this_hash`) carrying a well-formed `VaultDatum` whose
  `owner == addr`, `output.stake_cred == addr.stake_cred`, `lovelace ≥ min_lock`,
  ADA + that 1 beacon only (`policies len == 2`), no ref script. **The spend handler
  does NOT run on creation.**
- **Off-chain responsibility (LOAD-BEARING):** build a type-1 base address whose stake
  cred == `owner.stake_cred`, attach a well-formed `VaultDatum { owner }`, `lovelace ≥
  min_lock`, ADA + the 1 beacon only. The mint-time datum check means a real beacon
  **cannot** be minted into a malformed-datum vault (§7.6), which provably neutralizes
  the bad-datum-vs-beacon interaction — but a sub-floor creation is still a
  creator-only footgun (loses only the creator's own ADA). The on-chain
  `output_hash == policy_id` check (DR-18) now also guarantees a real beacon can only
  exist at the canonical vault address. Enforce in tx-builder tests (§12 steps 5–6).

### 6.2 top-up — add value (beacon carried forward)

Spend the vault with **one continuing output** back to the same script address,
`lovelace ≥ lovelace_in` (non-decreasing), `owner` (the whole Address) unchanged,
`output.stake_cred == datum.owner.stake_cred`, **the same 1 beacon carried forward**,
ADA + that 1 beacon only.

- **Fires (ALL, every time): `talk_vault.spend`** — owner payment-key sig;
  single-own-input guard; continuing-output floor (`≥ min_lock`); value-non-decrease
  (`≥ lovelace_in`); **beacon-forward** (`quantity_of(cont.value, this_hash, name)
  == 1`); ADA+beacon-only (`without_lovelace` equality, which now pins the beacon as
  the only non-ADA token); whole-Address stake-cred consistency; datum-freeze. **No
  mint runs** (the beacon is not minted or burned — it rides forward inside the
  continuation).
- **⛔ Owner sig is required on top-up, no exception** (§7.1, §7.9). **⛔ The beacon
  MUST be in the continuation, not merely "somewhere in the tx"** (§7.10).

### 6.3 partial-withdraw — reducing below the input is TWO sequential txs

**A one-tx partial-withdraw that reduces a vault below its input value is
IMPOSSIBLE.** Two independent on-chain rules forbid it:

- **The continuation cannot shrink.** The `[cont]` arm enforces `lovelace_of(cont) ≥
  lovelace_of(in)` (value non-decreasing, §7.9), so a continuing output can never be
  **smaller** than the input. There is no shrinking-continuation code path.
- **An in-tx same-name burn+remint is also blocked.** A `+1`/`−1` of the **same**
  beacon name gives `dict.size(tokens(mint, policy)) == 1`, but the redeemer
  `[Burn(name), Mint(addr)]` has `length == 2`, so `mint_length_and_uniqueness`
  (§7.7) **FAILS**. You cannot burn-and-remint the same name in one tx to "reset" the
  value.

**Therefore a partial-withdraw is TWO sequential txs:**

1. **tx1 — full exit / burn:** owner spends the vault with no continuing output and
   **burns the beacon** (`mint == −1`, §6.4), reclaiming all ADA.
2. **tx2 — re-register / re-mint:** in a later tx, mint a fresh `+1` beacon and park
   the smaller (still `≥ min_lock`) amount into a new vault (§6.1).

Equivalently, **"over-park then never reduce"** — top-ups only grow the vault, so size
it at creation. **Consolidating** several of the owner's vaults follows the same
shape: spending two beacon UTxOs in one tx is blocked by the single-own-input guard
(`== 1`, §7.4), so consolidation is a **sequence** of leaves (burns) + one re-create;
the follower's largest-wins rule (§10) then makes the surviving largest vault the one
that counts. **Do not imply a single-tx shrinking continuation exists — it does not.**

**Why this is fine:** "shrink the vault" is exactly the shape a value-siphon takes;
forbidding it on-chain routes every value reduction through the owner-signed
full-exit path. The two-tx cost is a deliberate, sound trade.

### 6.4 full-withdraw (reclaim) / LEAVE — remove all value + BURN the beacon

Owner spends the vault with **no continuing output** back to the script, and the tx
**burns the beacon** (`mint == −1` of this beacon).

- **Fires: `talk_vault.spend` `[]` arm** — owner payment-key sig; single-own-input
  guard; **and the new burn check** `quantity_of(self.mint, this_hash, name) == −1`,
  where `name = util.beacon_name(owner)` is derived from **this** vault's frozen datum
  Address (plus belt-and-suspenders: the beacon survives in no output). **Fires:
  `talk_vault.mint` the `Burn(name)` arm** — `quantity_of(mint, policy_id, name) ==
  −1`. **Both handlers independently assert the −1** (§7.11) — neither trusts the
  other (still true with one merged validator: the two handlers run on separate
  purposes).
- **⛔ A full exit MUST burn the beacon.** A bare `[] -> True` that reclaims the ADA
  while leaking the beacon to a side wallet is **forbidden** (§7.11) — it would
  strand an orphan beacon that pollutes the follower index. **⛔ The burned name is
  bound to THIS datum**, so a tx cannot burn beacon-A while exiting vault-B. **⛔ Do
  NOT couple the burn to a value/destination check** — the owner already signed; the
  ADA goes wherever they send it; coupling adds a new double-satisfaction surface for
  zero safety (§7.11).

### 6.5 stake register / delegate / withdraw — out-of-band (unchanged)

Entirely independent of the vault script and the beacon. The user registers their
own stake key, delegates to **any** pool, and withdraws **their own** rewards, each
witnessed by their own stake key. **Fires:** *nothing in `talk_vault`* — the merged
validator has only `mint` and `spend` handlers, no `publish`/`withdraw` handler; the
script never runs on a stake action. (DR-01 only requires the vault's stake cred to
**equal** `datum.owner.stake_cred`; it does not make the script run on staking.)

---

## 7. Enforcement proofs

For each property, the exact check that guarantees it. ⛔ marks a line a careless
edit must not relax. §7.1–7.6/7.9 carry forward from the pure-vault doc; §7.7–7.8,
7.10–7.12 are the beacon additions.

### 7.1 Owner-only spend (every path) — closes "steal another user's parked funds"

`spend` requires `list.has(self.extra_signatories, owner_vkh)`, where
`expect VerificationKey(owner_vkh) = datum.owner.payment_credential` (DR-01: the
payment credential of the whole owner Address; v1 restricts it to `VerificationKey`).
This sits in the **unconditional final `and { .. }`** on **every** path of the
`Some(VaultDatum)` branch — checked **before any output check**, so a non-owner fails
before any value moves. `extra_signatories` is the ledger-populated vkey-witness list.
Same primitive as `thread.ak`'s `list.has(extra_signatories, owner)?`. There is **no**
`must_be_signed_by` in stdlib. ⛔ Never gate behind a redeemer arm; never create a
no-sig path (§7.9); never check a stake-cred or whole-Address against
`extra_signatories` (only the payment vkey-hash witnesses a spend). **Attack closed:**
stealing parked ADA from another user's vault is blocked here — non-owners never reach
an output check.

### 7.2 Value `≥ min_lock` on every continuation AND at mint

`assets.lovelace_of(cont.value) >= min_lock` on every continuing output, where
`min_lock` is the compile-time parameter (`100_000_000`). Enforced on **every**
continuing output, and **at mint time** on creation (which runs no spend script,
§7.8). `min_lock` is a **lower cutoff**, never an equality, never a max. ⛔ Never
drop.

### 7.3 Datum integrity (owner Address frozen)

`cont.datum == this_input.output.datum` on every continuing output. Comparing the
raw `Datum` bytes is the tightest invariant for a single-field datum and guarantees
the whole `owner` Address (payment cred AND stake cred) is byte-identical — which also
means the **derived beacon name cannot change** across a continuation. Forbids a
stranger funding a top-up from rewriting ownership. Combined with §7.5's
`cont.address.stake_cred == datum.owner.stake_cred`, the continuation is pinned to the
**whole Address** (DR-01). ⛔ Never loosen.

### 7.4 Single own-input / no double-satisfaction (REINFORCED by the beacon)

`list.count(inputs, fn(i) { i.output.address.payment_credential == Script(this_hash) }) == 1`,
asserted via `expect` **BEFORE** the continuation branch. `list.find`/`list.any`
return the **first** match, so two vault inputs spent together could let **one**
continuing output "satisfy" both, pocketing the second's value. Counting own inputs
and requiring **exactly one** closes this (Vacuumlabs #1). **The beacon ADDS a
second, independent DS defense** (each continuing output is tagged with the beacon at
qty exactly 1 — the "token tagging" mitigation Vacuumlabs #2 recommends) — **but the
count guard must NOT be removed on the strength of the beacon** (defense in depth: the
beacon tags identity, the count guard bounds quantity). **Critically, two of an
owner's vaults at the SAME Address carry the SAME beacon name** (both
`blake2b_256(serialize(owner))`), so the beacon does **NOT** disambiguate them; the
guard is correctly on payment-cred **count**, still `== 1`, still structural. ⛔ Run
it **before** the continuation branch; never `>= 1`; never `list.find`/`list.any`.
**Attack closed:** cross-vault double-satisfaction (one continuation satisfying two
inputs).

### 7.5 No migration off the address (continuing output stays at this script — whole-Address)

The continuing output is located with `transaction.find_script_outputs(outputs,
this_hash)`, which returns only outputs whose payment credential is this script. A
foreign-address output is simply not in the `[cont]` list; sending everything
elsewhere is a full exit (`[]` arm, which burns the beacon and is owner-signed).
**RE-TIGHTENED to whole-Address (DR-01).** The continuation now pins the **whole**
Address: payment cred (via the script hash), stake cred (via the explicit check
`cont.address.stake_cred == datum.owner.stake_cred`), the `owner` Address itself (via
datum-freeze, §7.3), plus floor + value-non-decrease + ADA+beacon-only +
beacon-forward. The old payment-cred-only relaxation is **superseded** because the
stake cred is now weight-bearing identity (it is part of the beacon-name preimage). ⛔
Keep the `stake_cred` equality on every continuation; re-pointing the stake key is a
leave + re-register (a new Address ⇒ a new beacon name), not a continuation.

### 7.6 Bad-datum / no-datum escape hatch (creator-only footgun; beacon interaction)

The `else { True }` (non-`VaultDatum`) and `None -> True` arms make a malformed vault
freely spendable by anyone — fine for ADA (creator-only footgun, the `thread.ak`
idiom; loses only the creator's own ADA, never a third party's). **Beacon
interaction:** a malformed-datum vault that carried a real beacon would let an
attacker strip/relocate that beacon freely (no datum → no beacon-forward check). The
**neutralizer:** the mint handler's `Mint(addr)` arm requires `datum.owner == addr`
(the whole Address) **and** `output_hash == policy_id` at **mint time** (DR-18), so
**a real beacon can never be minted INTO a malformed-datum vault, nor into an output
that is not at the canonical vault address, in the first place** (§7.8), and the
`[cont]` datum-freeze (`cont.datum == in.datum`) prevents a continuation producing a
malformed beacon-bearing output. So no real beacon ever sits behind the hatch. ⛔ Keep
**both** checks together — the hatch AND the mint-time datum check. If that mint-time
datum check were ever removed, the hatch would let anyone strip a beacon off a
bad-datum vault (§7.6/7.8). Treat creation correctness as load-bearing off-chain
regardless.

### 7.7 Only-owner-can-mint + exactly-one + length/uniqueness — closes "unauthorized mint" & "mint qty>1 / junk"

The `Mint(addr)` arm requires the quartet **`list.has(extra_signatories, owner_vkh)`
(where `expect VerificationKey(owner_vkh) = addr.payment_credential`) AND
`blake2b_256(serialize(addr)) == token_name` AND `datum.owner == addr` AND
`output_hash == policy_id` (the beacon lands at THIS script's own address — DR-18)**,
plus `assets.quantity_of(mint, policy_id, token_name) == 1`. Because the name is a
collision-resistant **hash of the whole Address** and the matching payment key must
**sign**, only the victim can mint the victim's beacon — **no griefing, no
name-squatting, no forging** (forging needs a blake2b-256 collision **AND** the
colliding secret key). The `mint_length_and_uniqueness` guard —
`(assets.tokens(mint, policy_id) |> dict.size) == list.length(redeemer)` and
`list.unique(redeemer) == redeemer` — blocks minting **+2** of a name (fails `== 1`),
minting a **second name / junk token** under the policy (fails `dict.size`),
**duplicate** redeemer entries, and a self-cancelling `+1`/`−1` cross-asset launder.
⛔ All (payment-sig, name-binds-to-Address, datum-owner-match, own-address
destination, exactly-+1) plus the length/uniqueness guard are load-bearing; this is
**verbatim** `validate.ak`'s `Mint` arm + `mint_length_and_uniqueness`, with the
token-name source swapped to the Address hash — and the destination check is
`output_hash == policy_id` exactly as cogno_v3's `validate.ak:50`, because the merged
validator makes `policy_id == this_hash` (DR-18; the old two-validator `output_hash ==
vault_hash` param is GONE). **Attacks closed:** squatting/griefing-mint of
`blake2b_256(serialize(victim_addr))` without the victim's signature; minting qty>1, a
second beacon, or junk under the policy; minting a real beacon into a non-canonical
address.

### 7.8 Mint stands alone — closes cross-script double-satisfaction (Vacuumlabs #2)

A fresh register runs **only the mint handler** (creation runs no spend), so the
**mint** must itself check the beacon lands in a real vault output at the script's
**OWN** address: `output_hash == policy_id` (== this hash, DR-18), carrying a
`VaultDatum` with `owner == addr`, `output.stake_cred == addr.stake_cred`,
`lovelace ≥ min_lock`, **no-trash** (`assets.policies(value) |> list.length == 2` ⇒
ADA + that 1 beacon only), and `option.is_none(reference_script)`. Symmetrically, the
spend's full-exit arm must itself check `mint == −1` (§7.11) and **not** trust "the
mint handler verified the burn." This independence holds **even though mint and spend
are now the same validator (DR-18)** — they run on different purposes and must not
assume the other ran. The list-form redeemer + uniqueness guard (§7.7) blocks a
self-cancelling `+1(A)/−1(B)` launder in one tx. ⛔ Each handler stands alone — the
classic Vacuumlabs #2 cross-script double-satisfaction hole is closed by neither
handler trusting the other. (This is why `validate.ak`'s `Mint` arm re-checks the
output datum/destination itself.)
⛔ **`policies(value) |> length == 2` is CORRECT.** Stdlib `v2.2.0` SOURCE
`policies = dict.keys(self.inner)` includes the lovelace policy (stored under the
empty policy id `""`), so length 2 = lovelace + the one beacon. Do not "fix" this to
`== 1` based on the rendered HTML doc (which misleadingly says `policies` excludes
Ada); the source is authoritative, and cogno_v3's own `validate.ak:54` uses `== 2`.

### 7.9 No value siphon (value non-decreasing + owner sig on every path)

`assets.lovelace_of(cont.value) >= assets.lovelace_of(this_input.output.value)` on
every continuing output, **plus** the owner sig on every path (§7.1). A non-owner
fails the sig first; even an owner-signed continuation cannot shrink below the input
(value removal goes through the owner-signed full-exit). This is also why a one-tx
partial-withdraw cannot shrink the vault (§6.3). ⛔ Do **not** ship a no-sig top-up;
do **not** weaken `>= value_in` to `>= min_lock` (a shrinking continuation is exactly
the shape of a siphon). Keep **both**.

### 7.10 Beacon carried forward / no-strip — closes "strip/relocate the beacon on top-up"

On a `[cont]` (top-up) output, **TWO coexisting checks** pin the beacon:
`assets.quantity_of(cont.value, this_hash, beacon_name) == 1` (the beacon is **in the
continuation**; the beacon policy id is the vault script hash, DR-18) **AND**
`assets.without_lovelace(cont.value) == assets.without_lovelace(in.value)` (the non-ADA
token set is **frozen** — and because
a stdlib `Value` never holds a zero quantity, this is an *exact* token-set match:
since the input held ADA + exactly the 1 beacon, the continuation does too — **no
second beacon, no foreign token, no missing beacon**). The `_ -> False` fan-out arm
(more than one own-script output) forbids splitting the beacon off into a second
own-script output. ⛔ **Both** the qty-1 check AND the `without_lovelace` equality are
needed — qty-1 alone permits adding a foreign token; the freeze alone (without qty-1)
plus a strip would slip a different token set through; **neither alone suffices.**
Without them, an owner-signed top-up could **strip** the beacon to a side output
(breaking findability / stranding it) or recreate a sub-floor decoy while keeping the
ADA. The beacon must be **IN the continuation**, not merely somewhere in the tx.
**Attack closed:** beacon strip/relocate to a side output on a top-up.

### 7.11 Burn-on-exit / no-leak — closes "full exit without burning (leak the beacon)"

On a `[]` (full exit) output set, change the pure-vault `[] -> True` to `[] ->`
`assets.quantity_of(self.mint, this_hash, beacon_name) == -1` (the beacon is
**burned**; the beacon policy id is the vault script hash, DR-18), **plus** a
belt-and-suspenders `list.all(outputs, fn(o){ quantity_of(o.value, this_hash,
beacon_name) == 0 })` (the beacon survives in **no** output — `mint == −1` proves it
was burned; `all == 0` proves it wasn't quietly re-parked into a side output). A
leaked beacon still leaves `find_script_outputs == []` (forcing the burn check) and is
caught by the `all == 0` conjunct. This is structurally `thread.ak`'s `RemoveThread`
burn check (`list.all(outputs, quantity_of == 0)`) **plus** the explicit `mint == −1`
so the spend handler does not merely trust the mint handler. ⛔ Without this, a full
reclaim could **leak** the beacon to a side wallet — a permanently-orphaned beacon
polluting the follower index, re-parkable later to fake a registration. ⛔ The spend's
required burned name MUST be `beacon_name = util.beacon_name(owner)` derived from
**this** vault's frozen datum Address (not any redeemer-supplied name); the `Burn(tkn)`
arm only governs the −1 quantity of `tkn`, so the spend's own derivation is what binds
the burn to **this** vault — relaxing it to "−1 of any name" would let a tx **burn
beacon-A while exiting vault-B**. ⛔ Do **NOT** couple the burn to a value/destination check ("on burn, X ADA
must go to Y") — the owner already signed; the reclaimed ADA goes wherever they
direct; coupling adds a new double-satisfaction surface for **zero** gain. Burn rides
**only** on `mint == −1` + the no-continuation arm. **Attacks closed:** full exit that
leaks the beacon; burn-A-while-exiting-B. **Burn-without-releasing-value is a
non-issue by design** — the burn is intentionally decoupled from value/destination;
the owner already signed, so no third party is harmed.

### 7.12 Token-name correctness (32-byte hash, identical on all three sides)

`token_name = blake2b_256(serialize(owner))` is **exactly 32 bytes** — the asset-name
maximum, **zero headroom**. ⛔ Do **not** prefix/suffix the name (a CIP-67 label
would push it over 32 B and make the mint invalid; switch to `blake2b_224`, 28 B, if a
label is ever wanted). ⛔ The mint handler, the spend handler, **and** the L2 follower
MUST use the **identical** function (`util.beacon_name`) over the **identical**
serialization of the whole Address (the canonical CIP-19 address bytes) — a mismatch
indexes a different asset and the beacon becomes invisible / correctly-unspendable.
Derive the name **on-chain from the datum `owner` Address (spend) / the `Mint(addr)`
redeemer Address (mint)**, never trust a redeemer-supplied token name as authoritative
for the presence checks. ⛔ Because the preimage is the WHOLE Address, two Addresses
differing only in stake cred produce **different** beacon names — this is intended
(the stake cred is weight-bearing identity, DR-01).

### 7.13 No time bypass (unchanged)

No validity-interval / time check at all; no `lock_until` field. ⛔ Do not add
`validity_range` to the `Transaction` destructure or import `aiken/interval` — dead
code that misleadingly implies a timelock.

### 7.14 Global one-per-identity is NOT on-chain (honest statement)

A mint handler is evaluated only against the single tx that triggers it (the `mint`
field of `self`). It has **no view** of UTxO-set history or other txs, so it cannot
know whether a beacon with this `token_name` already exists. A user can mint beacon
#1 today and beacon #2 (same name, same Address) in a separate, separately-signed tx
tomorrow — **both individually valid**. This is **inherent and acceptable**: the
beacon confers **no on-chain authority**. Same-name duplicates are **expected, not
anomalous** (CIP-89: beacons are structural UTxO tags, not global per-identity
guarantees). ⛔ **Do NOT document the mint as guaranteeing global uniqueness.**
Uniqueness is the follower's **largest-wins** rule (§10), full stop. The L2 follower
on disk is already largest-wins / never-sum (DR-34), so this acknowledged
non-guarantee does **not** create any live stake-splitting double-dip — a second
beacon is harmless social-weight-wise (only the largest counts).

---

## 8. Aiken skeleton (safe-by-default)

Shaped like `cogno_v3` (`mint(redeemer, policy_id, self)` + the `Option<Data>` /
`if datum is X` soft-cast spend, `and { ..? }` with the `?` trace operator,
`else(_) { fail }`). Types align with vendored stdlib `v2.2.0`. **Not yet compiled —
run `aiken check` before any freeze (§8.5, §12).** ⛔ marks a line that must not be
relaxed.

### 8.1 `lib/types.ak`

```aiken
use cardano/address.{Address}
use cardano/assets.{AssetName}

pub type VaultDatum {
  // owner of this vault; the identity anchor (DR-01). The WHOLE CIP-19 Address
  // (payment VerificationKey cred + stake cred). CIP-8 (committed payload, DR-02)
  // resolves to this whole address off-chain. beacon token_name =
  // blake2b_256(serialize(owner)) is DERIVED, never stored.
  owner: Address,
}

pub type VaultRedeemer {
  Spend
}

// Mirror thread.ak's MintTypeRedeemer/MintRedeemer EXACTLY, with one deviation
// (DR-01): Mint carries the whole owner Address (cogno_v3's Mint is nullary; its
// name comes from a UTxO).
pub type MintTypeRedeemer {
  Mint(Address)   // register: token_name = blake2b_256(serialize(owner))
  Burn(AssetName) // leave: burn exactly -1 (verbatim thread.ak)
}

pub type MintRedeemer =
  List<MintTypeRedeemer>
```

### 8.2 `lib/util.ak` (the ONE deviation from cogno_v3 + the reused finder)

```aiken
use aiken/cbor  // cbor.serialise -- canonical CBOR bytes of the Address (see note)
use aiken/crypto
use cardano/address.{Address}
use cardano/assets.{AssetName, PolicyId}
use cardano/transaction.{Output}

// THE DEVIATION FROM cogno_v3: thread.ak's util.token_name slices a txid for
// per-thread uniqueness; the beacon name is a STABLE, identity-bound hash of the
// WHOLE owner Address (DR-01) so it is publicly re-derivable by the follower.
// blake2b_256 -> 32 bytes (asset-name max). The MINT handler, the SPEND handler AND
// the FOLLOWER MUST use this EXACT fn over the EXACT same Address serialization
// (a mismatch indexes a different asset -- §7.12).
// ⛔ SERIALIZATION CHOICE IS LOAD-BEARING: pick ONE canonical encoding of the
//    Address and use it identically on-chain (mint+spend) and off-chain (follower +
//    tx builder). aiken/cbor.serialise of the Address is the simplest on-chain
//    option; the follower MUST reproduce the byte-identical CBOR. (If a CIP-19
//    raw-address encoding is preferred for cross-tool stability, define it once and
//    use it everywhere.) Confirm the chosen bytes match across all three sides in
//    the §8.5 integrity test before freeze.
pub fn beacon_name(owner: Address) -> AssetName {
  crypto.blake2b_256(cbor.serialise(owner))
}

// Reused VERBATIM from cogno_v3 util.ak -- locate the vault output holding the
// freshly-minted beacon. `fail`s on [] (a register with no beacon-bearing output
// must fail); returns the FIRST output holding qty==1, which is safe because the
// Mint arm re-checks that output's hash / datum / floor / no-trash.
pub fn search_for_output_by_token(
  outputs: List<Output>,
  pid: PolicyId,
  tkn: AssetName,
) -> Output {
  when outputs is {
    [output, ..rest] ->
      if assets.quantity_of(output.value, pid, tkn) == 1 {
        output
      } else {
        search_for_output_by_token(rest, pid, tkn)
      }
    [] -> fail
  }
}
```

### 8.3 `lib/validate.ak` — the mint helpers (DR-18: folded into ONE merged validator)

> **RESHAPED by DR-18 + DR-01.** Previously this was a *separate* `validators/beacon.ak`
> minting policy parameterized by `(vault_hash, min_lock)`. There is now **no separate
> beacon validator** — the mint handler lives in the **single merged
> `talk_vault(min_lock)`** (§8.4), and the helpers below sit in `lib/validate.ak`
> (mirroring cogno_v3's `thread.ak → validate.ak` split). The destination check is
> `output_hash == currency_symbol` (== `policy_id` == this script hash) — exactly
> cogno_v3's `validate.ak:50` — because `policy_id == this_hash` for a merged
> validator. The token name comes from the WHOLE owner `Address` (DR-01), not a pkh.

```aiken
//// Mint helpers for the cogno-chain merged talk_vault validator. Mirrors cogno_v3
//// validate.ak's Mint/Burn arms + mint_length_and_uniqueness EXACTLY. Deviations:
//// token_name = blake2b_256(serialize(owner Address)) (util.beacon_name), and the
//// destination is the script's OWN address (output_hash == currency_symbol, which
//// IS this script hash for a merged validator -- DR-18).

use aiken/collection/dict
use aiken/collection/list
use aiken/crypto.{VerificationKeyHash}
use aiken/option
// NB: Credential / VerificationKey / Script / Address all live in cardano/address
// (PaymentCredential = Credential; stake_credential is Option<StakeCredential>).
use cardano/address.{Address, Credential, Script, VerificationKey}
use cardano/assets.{AssetName, PolicyId, Value}
use cardano/transaction.{InlineDatum, Output}
use types.{Burn, Mint, MintRedeemer, VaultDatum}
use util

// ---- adapted from cogno_v3 lib/validate.ak (Mint arm + Burn arm) ----
// NB: no vault_hash param -- the destination IS this script (currency_symbol ==
// policy_id == this_hash, DR-18). NB: thread.ak passes `inputs` because its name
// comes from a spent OutputReference; the beacon name comes from the Address, so
// `inputs` is NOT needed -- omitted.
pub fn mint_validation(
  mint_redeemer: MintRedeemer,
  mint_value: Value,
  currency_symbol: PolicyId,
  outputs: List<Output>,
  extra_signatories: List<VerificationKeyHash>,
  min_lock: Int,
) -> Bool {
  when mint_redeemer is {
    [mint_type, ..rest] -> {
      let valid_mint =
        when mint_type is {
          Mint(owner) -> {
            // DR-01: name from the WHOLE owner Address, not a pkh / txid slice.
            let token_name: AssetName = util.beacon_name(owner)
            // v1: payment cred MUST be a VerificationKey (no script owner yet).
            expect VerificationKey(owner_vkh): Credential =
              owner.payment_credential
            // find the output that holds the freshly minted beacon, read its datum
            expect Output {
              address: Address {
                payment_credential: Script(output_hash),
                stake_credential: out_stake,
              },
              value,
              datum: InlineDatum(output_datum_data),
              reference_script,
            } =
              util.search_for_output_by_token(
                outputs,
                currency_symbol,
                token_name,
              )
            expect VaultDatum { owner: datum_owner } = output_datum_data
            and {
              // ⛔ beacon goes INTO this script's OWN address (DR-18: policy_id ==
              //    this_hash, so output_hash == currency_symbol) -- §7.7/7.8
              (output_hash == currency_symbol)?,
              // ⛔ whole-Address: vault stake cred == owner.stake_cred (DR-01)
              (out_stake == owner.stake_credential)?,
              // ⛔ no ref-script attacks (validate.ak:52)
              option.is_none(reference_script)?,
              // ⛔ no-trash: ADA + exactly the 1 beacon (validate.ak:54). policies
              //    INCLUDES lovelace ("" policy), so == 2. Do NOT change to == 1.
              (( assets.policies(value) |> list.length ) == 2)?,
              // ⛔ floor enforced AT MINT (creation runs no spend) -- §7.2/7.8
              (assets.lovelace_of(value) >= min_lock)?,
              // ⛔ ONLY YOU mint YOURS: name binds to Address AND the payment vkey
              //    signs -- §7.7
              list.has(extra_signatories, owner_vkh)?,
              // ⛔ beacon can't be minted into a vault that names someone else
              //    -- §7.6/7.8 (whole-Address match; also makes the hatch safe)
              (datum_owner == owner)?,
              // ⛔ EXACTLY +1 (validate.ak:58)
              (assets.quantity_of(mint_value, currency_symbol, token_name) == 1)?,
            }
          }
          // VERBATIM thread.ak / validate.ak:61-62 -- exactly -1, no more. The
          // spend side independently binds the burned name to its datum (§7.11).
          Burn(tkn) ->
            (assets.quantity_of(mint_value, currency_symbol, tkn) == -1)?
        }
      valid_mint && mint_validation(
        rest,
        mint_value,
        currency_symbol,
        outputs,
        extra_signatories,
        min_lock,
      )
    }
    [] -> True
  }
}

// VERBATIM cogno_v3 validate.ak:77-89 -- blocks +2 / extra junk / dup redeemer /
// the self-cancelling +1/-1 cross-asset launder (and the one-tx same-name
// burn+remint partial, §6.3: a [Burn,Mint(addr)] redeemer has len 2 but
// dict.size==1).
pub fn mint_length_and_uniqueness(
  mint: Value,
  mint_redeemer: MintRedeemer,
  currency_symbol: PolicyId,
) -> Bool {
  and {
    ((
      assets.tokens(mint, currency_symbol)
        |> dict.size
    ) == list.length(mint_redeemer))?,
    (list.unique(mint_redeemer) == mint_redeemer)?,
  }
}
```

### 8.4 `validators/talk_vault.ak` (the ONE merged validator — mint + spend, DR-18)

> **RESHAPED by DR-18 + DR-01.** Previously this was a spend-only validator
> parameterized by `(min_lock, beacon_policy_id)`. There is now a **single** validator
> `talk_vault(min_lock)` with **both** a `mint` handler (the beacon policy; `policy_id
> == this_hash`) and a `spend` handler (the vault) — the cogno_v3 `thread.ak` shape.
> No `beacon_policy_id` param (it IS this script hash). The owner identity is the whole
> `Address`; the owner signature checks the payment vkey-hash; continuations pin the
> whole Address (stake-cred consistency added).

```aiken
//// An owner-reclaimable ADA vault marked by a beacon NFT, as ONE merged validator
//// (DR-18): the beacon policy id IS this script hash. No timelock (DR-13).
//// Parameterized by min_lock ONLY. The mint handler runs on register/leave; the
//// spend handler runs on top-up/leave. Mint helpers live in lib/validate.ak (§8.3).

use aiken/collection/list
// NB: Credential / VerificationKey / Script / PaymentCredential all live in
// cardano/address (PaymentCredential == Credential).
use cardano/address.{Credential, PaymentCredential, Script, VerificationKey}
use cardano/assets.{PolicyId}
// ⛔ The UNQUALIFIED import is REQUIRED: the body calls qualified
//    transaction.find_input / transaction.find_script_outputs. Importing only the
//    types below is NOT enough -- aiken check fails without this line. (mustFix)
use cardano/transaction
use cardano/transaction.{Input, Output, OutputReference, Transaction}
use types.{MintRedeemer, VaultDatum, VaultRedeemer}
use util
use validate

validator talk_vault(min_lock: Int) {
  // ---- BEACON MINT/BURN (policy_id == this_hash, DR-18) ----
  mint(redeemer: MintRedeemer, policy_id: PolicyId, self: Transaction) {
    let Transaction { outputs, extra_signatories, mint, .. } = self
    and {
      validate.mint_validation(
        redeemer,
        mint,
        policy_id,        // == this script hash; mint arm asserts output_hash == it
        outputs,
        extra_signatories,
        min_lock,
      )?,
      validate.mint_length_and_uniqueness(mint, redeemer, policy_id)?,
    }
  }

  // ---- VAULT SPEND ----
  spend(
    maybe_datum: Option<Data>,
    _redeemer: VaultRedeemer,
    utxo: OutputReference,
    self: Transaction,
  ) {
    when maybe_datum is {
      Some(datum) ->
        if datum is VaultDatum {
          // `mint` is destructured -- needed for the burn-on-exit check.
          let Transaction { inputs, outputs, extra_signatories, mint, .. } = self
          expect Some(this_input): Option<Input> =
            inputs |> transaction.find_input(utxo)
          expect Script(this_hash): PaymentCredential =
            this_input.output.address.payment_credential
          let VaultDatum { owner } = datum
          // v1: payment cred MUST be a VerificationKey (no script owner yet, DR-01).
          expect VerificationKey(owner_vkh): Credential = owner.payment_credential
          let in_value = this_input.output.value
          // derive the beacon name ON-CHAIN from the datum owner Address -- §7.12.
          // This binds the burn-on-exit (below) to THIS vault, blocking
          // burn-A-while-exiting-B. The beacon policy id IS this_hash (DR-18).
          let beacon = util.beacon_name(owner)

          // ---- DOUBLE-SATISFACTION GUARD (§7.4) -- EVERY spend, BEFORE branch ----
          // ⛔ keep == 1; never >= 1; never list.find/list.any. Beacon tagging is
          // a SECOND defense, NOT a replacement for this count.
          let own_input_count =
            list.count(
              inputs,
              fn(i) { i.output.address.payment_credential == Script(this_hash) },
            )
          expect (own_input_count == 1)?

          // ---- CONTINUATION / EXIT RULE -- by continuing-output count ----
          let continuation_ok =
            when transaction.find_script_outputs(outputs, this_hash) is {
              // [] = FULL EXIT / LEAVE: the beacon MUST be burned (§7.11).
              // ⛔ NOT `True`. ⛔ do NOT couple burn to a value/destination check.
              [] ->
                and {
                  // ⛔ burn THIS datum's beacon (name bound above) -- §7.11.
                  //    policy id == this_hash (DR-18).
                  (assets.quantity_of(mint, this_hash, beacon) == -1)?,
                  // belt+suspenders: beacon survives in NO output (§7.11)
                  list.all(
                    outputs,
                    fn(Output { value, .. }) {
                      assets.quantity_of(value, this_hash, beacon) == 0
                    },
                  )?,
                }
              // [cont] = top-up (a SHRINKING continuation is impossible: the
              //          non-decrease line below forbids it -- §6.3/7.9).
              [cont] ->
                and {
                  // ⛔ floor on EVERY continuation (§7.2)
                  (assets.lovelace_of(cont.value) >= min_lock)?,
                  // ⛔ value NON-DECREASING -> no siphon (§7.9). Never >= min_lock.
                  (assets.lovelace_of(cont.value)
                    >= assets.lovelace_of(in_value))?,
                  // ⛔ SAME beacon carried forward (§7.10). policy id == this_hash.
                  (assets.quantity_of(cont.value, this_hash, beacon) == 1)?,
                  // ⛔ ADA + that 1 beacon ONLY / token set frozen: no strip, no
                  //    second beacon, no foreign token (§7.10). With the line
                  //    above this pins the beacon as the only non-ADA token.
                  (assets.without_lovelace(cont.value)
                    == assets.without_lovelace(in_value))?,
                  // ⛔ whole-Address: stake cred consistency on continuation (DR-01)
                  (cont.address.stake_credential == owner.stake_credential)?,
                  // ⛔ owner Address frozen -> beacon name can't drift either (§7.3)
                  (cont.datum == this_input.output.datum)?,
                }
              // ⛔ fan-out rejection: >1 own-script output -> False (§7.4/7.10)
              _ -> False
            }

          and {
            // ⛔ owner signed this tx (§7.1) -- EVERY path; thread.ak idiom; NOT
            //    must_be_signed_by. NEVER move behind a redeemer arm / no-sig path.
            //    Checks the payment vkey-hash of the owner Address (DR-01).
            //    Checked BEFORE any value moves (continuation_ok is just a Bool).
            list.has(extra_signatories, owner_vkh)?,
            continuation_ok?,
          }
        } else {
          // bad datum type is spendable (thread.ak escape-hatch idiom, §7.6).
          // SAFE w.r.t. the beacon: a real beacon can never be minted into a
          // malformed-datum vault (mint-time datum check, §7.6/7.8) -- so this
          // hatch loses only the creator's OWN ada, never a third party's.
          True
        }
      // no datum is spendable (creator-only footgun, §7.6)
      None -> True
    }
  }

  else(_) {
    fail
  }
}
```

**Notes on the skeleton (where a careless edit reopens a hole):**

- ⛔ **`own_input_count == 1` before the continuation branch** — the cross-vault DS
  guard, REINFORCED (not replaced) by beacon tagging; the beacon does NOT
  disambiguate two same-name vaults, so the count is load-bearing (§7.4).
- ⛔ **`[] -> { mint == -1 (this datum's name) ; all outputs qty == 0 }`** — never the
  pure-vault `[] -> True`; a full exit must burn THIS vault's beacon, not leak it,
  not burn another vault's (§7.11).
- ⛔ **`quantity_of(cont.value, this_hash, beacon) == 1`** on `[cont]` —
  the beacon-forward / no-strip invariant; the beacon policy id IS `this_hash`
  (DR-18) (§7.10).
- ⛔ **`without_lovelace(cont.value) == without_lovelace(in_value)`** — exact
  token-set freeze (`add()` drops zero quantities): exactly the 1 beacon, no second
  beacon, no foreign token (§7.10). Neither this nor the qty-1 line alone suffices.
- ⛔ **`cont.address.stake_credential == owner.stake_credential`** on `[cont]` —
  whole-Address consistency (DR-01, §7.5); pairs with the datum-freeze to pin the
  whole Address. Re-pointing the stake key is a leave + re-register.
- ⛔ **Owner payment-key sig in the final `and { .. }`, every path; value
  non-decreasing; floor on the continuation; datum-freeze** — all carried forward
  (§7.1/7.9/7.2/7.3). The non-decrease line is also what makes a one-tx shrinking
  partial impossible (§6.3).
- ⛔ **The beacon policy id IS `this_hash`** — mint and spend are the SAME merged
  validator (DR-18). The mint arm's `output_hash == policy_id` is therefore the real
  on-chain "beacon ⇒ canonical vault" guarantee (the old two-validator
  `beacon_policy_id` PARAM and `vault_hash` PARAM are GONE).
- ⛔ **No `validity_range`** (§7.13). Keep the `else { True }` / `None -> True`
  hatches (§7.6). End with `else(_) { fail }` (thread.ak form), not `fail @"..."`.
- ⛔ **`expect VerificationKey(owner_vkh) = owner.payment_credential`** — v1 rejects a
  script-payment owner (DR-01); the sig check uses `owner_vkh`, never the stake cred.
- **Imports needed in the merged validator:** `use aiken/crypto`, `use
  aiken/collection/{list, dict}`, `use aiken/option`, `use cardano/assets.{...}`,
  `use cardano/address.{Address, Credential, Script, VerificationKey}` (Credential /
  VerificationKey live in `cardano/address`, NOT a `cardano/credential` module),
  `use aiken/cbor` (in `util` for the Address serialization), **the UNQUALIFIED `use
  cardano/transaction`** (required for the qualified `transaction.find_input` /
  `find_script_outputs` calls) **alongside** `use cardano/transaction.{Output,
  InlineDatum, Transaction, Input, OutputReference}`.

### 8.5 `lib/validate.ak` extraction + inline tests (compile + run before freeze)

Mirror the `thread.ak → validate.ak` split and the `lib/*.ak` inline-test convention
(hand-built fixtures, `?` traces). **⛔ Run `aiken check` before any freeze — the
skeleton above is uncompiled.** Cover the beacon negatives, the carried-forward spend
invariants, **and** the one-tx-partial-is-rejected case (mustFix):

```aiken
// MINT (talk_vault.mint via lib/validate.ak)
// test beacon_name_matches_across_sides()    -> on-chain == follower CBOR:  PASS  (§7.12)
// test mint_with_wrong_token_name_fails()    -> blake2b_256(serialize(addr))!=name: FAIL (§7.7)
// test mint_without_owner_sig_fails()        -> addr.payment vkh not in sigs: FAIL (§7.7)
// test mint_script_owner_rejected()          -> payment cred not VerificationKey: FAIL (§5.1)
// test mint_two_beacons_in_one_tx_fails()    -> dict.size != len(redeemer): FAIL (§7.7)
// test mint_plus_two_same_name_fails()       -> quantity_of(mint) == 2:    FAIL  (§7.7)
// test mint_extra_junk_token_under_policy_fails() -> length+unique:        FAIL  (§7.7)
// test mint_into_non_own_address_fails()     -> output_hash != policy_id:  FAIL  (§7.8 DR-18)
// test mint_into_bad_datum_output_fails()    -> datum.owner != addr:       FAIL  (§7.6/7.8)
// test mint_wrong_stake_cred_fails()         -> out.stake != addr.stake:   FAIL  (§7.8 DR-01)
// test mint_below_floor_fails()              -> lovelace_of(value)<min_lock:FAIL  (§7.8)
// test mint_into_trashy_output_fails()       -> policies len != 2:         FAIL  (§7.8)
// test burn_minus_one_succeeds()             -> quantity_of == -1:         PASS  (§7.11)
// test burn_other_amount_fails()             -> quantity_of != -1:         FAIL  (§7.11)
// test same_name_burn_plus_remint_one_tx_fails() -> [Burn,Mint(addr)] len 2 but
//                                               dict.size==1: FAIL (§6.3 partial)
//
// SPEND (talk_vault.spend)
// test non_owner_cannot_spend()              -> payment sig missing:       FAIL  (§7.1)
// test two_own_inputs_fails()                -> own_input_count == 2:      FAIL  (§7.4)
// test fan_out_two_script_outputs_fails()    -> _ -> False arm:            FAIL  (§7.4)
// test continuation_below_min_lock_fails()   -> cont.lovelace < min_lock:  FAIL  (§7.2)
// test continuation_shrinks_value_fails()    -> cont.lovelace < in:        FAIL  (§7.9/6.3)
// test continuation_dropping_beacon_fails()  -> quantity_of(cont,beacon)!=1:FAIL (§7.10)
// test continuation_adds_token_fails()       -> without_lovelace != in:    FAIL  (§7.10)
// test continuation_changes_stake_cred_fails()-> cont.stake != owner.stake:FAIL  (§7.5 DR-01)
// test continuation_changes_owner_fails()    -> cont.datum != in.datum:    FAIL  (§7.3)
// test topup_carries_beacon_succeeds()       -> grows, beacon==1, frozen:  PASS  (§7.10)
// test full_exit_must_burn_beacon_fails()    -> [] with mint != -1:        FAIL  (§7.11)
// test full_exit_burns_beacon_succeeds()     -> [] with mint == -1:        PASS  (§7.11)
// test exit_B_burning_A_name_fails()         -> [] burns a DIFFERENT name:  FAIL  (§7.11)
```

### 8.6 `aiken.toml`

```toml
name = "logical-mechanism/cogno-chain-l1"
version = "0.0.0"
compiler = "v1.1.16"
plutus = "v3"

[[dependencies]]
name = "aiken-lang/stdlib"
version = "v2.2.0"
source = "github"
```

Match the builder's pin exactly (this is cogno_v3's pin). **Do not bump** to stdlib
`v3.x` — `v3.0.0` dropped/changed APIs and the vendored signatures (`quantity_of`,
`tokens`, `flatten`, `without_lovelace`, `policies`, `lovelace_of`, `find_input`,
`find_script_outputs`, `blake2b_256`) would drift.

---

## 9. Single contract + the multi-set collapse

### 9.1 One contract, continuous tiers (the collapse)

The prior doc minted a distinct script hash **per `min_lock`** value, each a separate
"set/tier," and the follower summed a pkh's UTxOs **across sets**. **v2 collapses
this to ONE contract** at `min_lock = 100_000_000` lovelace (100 ADA):

- **Tiers are now continuous.** Your "tier" is simply **how much ADA sits in your
  single beacon-marked vault**, scored by a **capped-linear** weight: floor at
  `min_lock`, rising with ADA, saturating to an **L3** ceiling. There is no
  per-tier address. The beacon is a **registration / uniqueness / findability**
  marker — **not** the talk token; talk capacity is a non-transferable L3 runtime
  number.
- **The floor still lives in the parameter** (`talk_vault(min_lock)` bakes `min_lock`
  into the bytecode → address-encoded, unforgeable — a datum-field floor would be
  forgeable per-UTxO; the parameter is not). `min_lock` is now the **only** parameter
  (DR-18 removed `beacon_policy_id`).
- **A second, higher-floor contract could be deployed later** (a different `min_lock`
  → a different hash/address/policy — and, since the beacon policy id IS the script
  hash, a different beacon policy too) — but it is **NOT** the tiering mechanism; it
  is just another deployment the follower would index separately. v1 ships exactly
  one.

### 9.2 How off-chain applies the params (ONE validator, no cycle — DR-18)

> **SUPERSEDED build order (DR-18).** There is no longer a separate beacon blueprint,
> no `beacon_policy_id` param, and **no hash cycle to resolve**. Apply ONE param
> (`min_lock`) to ONE blueprint; the beacon policy id IS the script hash.

```ts
// DR-18: ONE merged validator. min_lock is the ONLY param. The beacon policy id IS
// the talk_vault script hash -- nothing to compute in a particular order, no cycle.
//
// 1. apply min_lock to the single talk_vault blueprint, get the script hash:
const vaultCbor = applyParamsToScript(talkVaultBlueprint.compiledCode,
                                      [{ int: 100000000 }], "JSON");
const vaultHash = resolveScriptHash(vaultCbor /* V3 */);

// 2. the beacon policy id IS the vault hash (merged validator):
const beaconPolicyId = vaultHash;

// 3. pair the vault script payment cred with the USER'S OWN stake-key hash to form
//    the CIP-19 TYPE-1 base address (header high nibble 0b0001). DR-01: this stake
//    cred MUST equal the stake cred inside the VaultDatum.owner Address the user
//    will lock under -- the on-chain mint/spend enforce stake_cred == owner.stake.
const baseAddr = scriptHashToBech32(vaultHash, userStakeKeyHash, networkId);
assert((firstHeaderByte(baseAddr) >> 4) === 0b0001);   // type-1 header assertion

// 4. the beacon token_name = blake2b_256(serialize(owner Address)). The follower and
//    the tx builder MUST use the BYTE-IDENTICAL Address serialization the on-chain
//    util.beacon_name uses (aiken/cbor.serialise of the Address -- §8.2). Confirm it
//    matches on-chain in a fixture test before publishing.
const beaconName = blake2b256(serializeAddress(baseAddrAsOwner));
```

⛔ **There is no §4.5 cycle to resolve** — that was the old two-validator shape (DELETED
by DR-18). Apply `min_lock` to the single blueprint; the beacon policy id is the
resulting script hash.
⛔ Param types in `applyParamsToScript` must match the on-chain types (`Int` →
`{ int }`); a shape mismatch silently yields a wrong/uncallable script. **The follower
MUST derive the address, the beacon policy id (== the script hash) AND the beacon name
from the SAME applied blueprint + the SAME Address serialization the contracts ship**
(same `min_lock`, same compiler/stdlib pin) or it indexes the wrong hash/asset. ⛔
**Assert the type-1 base-address header high nibble is `0b0001`** before publishing the
address, and assert the vault address stake cred == the owner Address stake cred
(DR-01).

### 9.3 L1 declares the floor; L3 caps the ceiling

`min_lock` is the **lower cutoff** L1 enforces on-chain. The **per-identity
ceiling/cap** is a **deferred L3 runtime param** (capped-linear: floor at `min_lock`,
saturating at high stake; numbers TBD). L1 never sees the ceiling.

---

## 10. L1 → L2 interface (the largest-wins beacon read model)

The follower (L2, out of scope to build, in scope to specify) turns beacon-bearing
vault UTxOs into per-identity weight. **The beacon SIMPLIFIES this: index by one
policy id (== the vault script hash, DR-18), and select — never sum.**

> ✅ **No live double-dip (DR-34).** `docs/L2-follower.md` on disk is **already**
> largest-wins / never-sum, so the tx-local mint (§7.14) does **not** let a user
> multiply their L3 voice by minting N same-name beacons — only the largest counts.
> The §10.7 list below is a **consistency cross-check** to keep the two docs aligned
> (e.g. group by the WHOLE owner Address now, not `owner_pkh`), **not** a
> mustFix-or-live-exploit. (The old banner that called L2 a "live double-dip" was
> false — removed per DR-34.)

### 10.1 Index by the beacon POLICY id (db-sync)

Read **db-sync** by the **beacon policy id** (which **equals the
`talk_vault` script hash**, DR-18; optionally per-asset by `policy_id.token_name`).
Beacons are **trivially findable by asset**, so you query the exact set of
canonical-vault UTxOs directly, instead of scanning all UTxOs at an address and
deciding which count. With the multi-set collapse (§9) there is **one** policy /
**one** address in v1.

```
# db-sync: select vault UTxOs driven by tx_out.payment_cred = <vault_hash>
#          (vault_hash == beacon policy id, DR-18; or per-user by token_name)
```

For each output db-sync gives `transaction_id`, `output_index`, `address`, `value`
(coins as `::text` — lovelace > 2^53), inline `datum`, the creating block's
`slot_no`/`header_hash`, and spentness from `tx_in`. Read the live (unspent) beacon
UTxOs; a beacon UTxO consumed by a `tx_in` (buried) is a leave signal.

### 10.2 Read amount + datum; group by owner Address; LARGEST-wins (never sum)

For each beacon UTxO: `parked_lovelace = assets.lovelace_of(value)`; `owner =
parse_inline_datum(datum).owner` (the whole Address, DR-01); assert exactly 1 beacon
present; **integrity check** `blake2b_256(serialize(owner)) == observed token_name`
(the **identical** `util.beacon_name` fn the validators use, over the byte-identical
Address serialization, §7.12 — ignore a UTxO whose name mismatches its datum owner).
Then:

- **Group by the whole `owner` Address** (the identity, DR-01 — NOT `owner_pkh`).
  Among an Address's buried beacon UTxOs, **select the one with MAX `lovelace`**;
  deterministic tiebreak on equal lovelace by **output reference** (`(transaction_id,
  output_index)` lexicographic). `weight_input` = **that single UTxO's lovelace**. ⛔
  **NEVER sum** across an Address's UTxOs.
- **Why largest-wins (the actual uniqueness mechanism):** (a) prevents double-dipping
  (you can't split 300 ADA into 3×100-ADA beacons to triple voice — only the biggest
  counts); (b) incentivizes consolidation to ONE vault; (c) never zeroes a user (a
  transient duplicate never strips voice — you always keep your biggest). Because the
  mint is **tx-local** (§7.14), this follower rule — not any on-chain check — is what
  delivers one-effective-beacon-per-identity.
- **Same-name duplicates are EXPECTED, not anomalous.** Two of an Address's beacons
  share an **identical asset id** (same policy == vault hash, same `token_name =
  blake2b_256(serialize(owner))`), differing only by output reference — so a per-asset
  db-sync read returns **multiple UTxOs for one user**. Don't assume one-asset ⇒
  one-UTxO; group by datum `owner` Address and select max over the returned set. With
  largest-wins it is pure over the buried snapshot and self-heals on reorg (DR-34: the
  follower on disk is already largest-wins, so there is no summing double-dip).
- **Floor-check defensively:** the selected largest UTxO must itself be `≥ min_lock`
  to grant weight (the L1 continuation/mint rules guarantee any valid beacon-bearing
  output is `≥ min_lock`, but floor-check anyway against a malformed creation).

`weight = capped-linear(largest_buried_lovelace)`: floor at `min_lock` (100 ADA),
saturating to the L3 ceiling. L2 emits only `{ owner Address → chosen_lovelace }`; L3
turns it into capacity. **1:1 owner-Address → one L3 account** (the L3 binding keys on
`blake2b_256(serialize(owner Address))` == the beacon name, DR-01). **CIP-8 is the
off-chain proof** a controller presents to bind an account to an owner Address —
under **DR-02** a **committed payload**: the user signs domain-separated bytes
committing `{ sr25519 account + L3 genesis hash + fresh nonce }`, and the follower
verifies the signature is valid **and the recovered signing address == `datum.owner`**
(an **exact whole-address match**: payment AND stake cred) **and** the payload's
sr25519 == the submitted sr25519. This **prevents** (not merely detects) a
bind-hijack. The mint handler **cannot** verify CIP-8 (it only sees
`extra_signatories` at mint time) — do not conflate the on-chain owner-sig-on-mint
with the off-chain CIP-8 committed-payload proof.

### 10.3 Reorg-safe filter (load-bearing, unchanged in spirit)

- Count a UTxO only once its creating `slot_no` is **buried past depth k**. On
  `RollBackward` to slot S, discard observations with `slot_no > S` and recompute;
  db-sync removes a rolled-back spend (the `tx_in` row goes away), so **never cache
  "spent" as permanent.** Bury **both** the creating and the spending slot past k. The largest-wins
  selection re-runs on every recompute (it is **pure** over the buried snapshot), so
  a reorg that adds/removes a duplicate, or swaps which beacon is largest, **self-
  heals** — provided you **never cache the chosen UTxO as permanent** and always
  re-run max-per-pkh.

### 10.4 Leave / clamp path — a burn is an equivalent leave signal

A full exit burns the beacon (`mint == −1`) and produces **no** continuing beacon
UTxO, so the follower sees it **two ways**: (i) the beacon UTxO is spent (a `tx_in`
consumes it), and (ii) the tx `mint` field shows the beacon policy at `−1`. **Either**, buried past
k, means that beacon is gone — **a burn == a leave**. If it was the Address's largest,
recompute promotes the next-largest remaining beacon; if it was the Address's only
beacon, **clamp weight → 0**. **Consolidation subtlety:** a user merging two beacons
burns one and continues the other — but **both share the same `token_name`**
(`blake2b_256(serialize(owner))`), so the follower **cannot** distinguish duplicates
by asset id; it MUST group by datum `owner` Address and dedupe/select by **output
reference + lovelace**. Largest-wins over output-refs handles it.

### 10.5 No-timelock voice-lag mitigation (off-chain, unchanged)

Because there is no timelock, a user can unlock anytime. **Closed at L2/L3:** require
burial past depth k before granting weight; clamp L3 capacity to zero on observed
unlock (a spend **or** a beacon burn); recompute on rollback. ⛔ Do **not** fix
this with an on-chain cooldown.

### 10.6 What L2 does NOT get from L1

No capacity math, no regen, no ceiling, no per-user reward figure. L1 → L2 is exactly
`{ owner Address, largest_buried_lovelace, beacon_asset }` per identity (the
**largest** single buried beacon UTxO — **not** a sum). The rest is L3.

### 10.7 Consistency cross-check for `docs/L2-follower.md`

> **REFRAMED by DR-34 + DR-01.** The L2 doc on disk is **already largest-wins /
> never-sum** — it is NOT a "group-and-sum / live double-dip." So this section is no
> longer a "mustFix-or-live-exploit"; it is a **consistency cross-check** to keep L2
> aligned with this doc's reconciled shape. The one substantive alignment L2 still
> needs is **DR-01**: group by the **whole owner Address**, not `owner_pkh`, and use
> `token_name = blake2b_256(serialize(owner Address))` (== the beacon = the vault
> hash policy, DR-18). Verify each item against the current L2 doc before relying on
> it; where L2 already says largest-wins, only the Address/serialization wording
> changes.

- **§1 TL;DR / §3.1 lever-1**: ensure the largest-wins phrasing groups by the **whole
  owner Address** (not `owner_pkh`); keep "select the single largest beacon UTxO,
  never sum." Keep the beacon (value = ADA + 1 beacon) and the burn=leave signal.
- **§2.1 responsibility #3**: "select the largest beacon UTxO per **owner Address**
  (never sum)."
- **§2.2 ASCII data-flow box**: "group by **owner Address** → **LARGEST beacon UTxO**
  → 1 weight"; the db-sync box reads "**by beacon policy id (== the vault hash)**"; keep
  the beacon (ADA + 1 beacon) and the **burn=leave** signal alongside the spend.
- **§6.1**: "**Index beacon-bearing UTxOs by the beacon POLICY id** (== the vault
  script hash, DR-18) (read db-sync by `tx_out.payment_cred`; optionally per-asset by
  `token_name`); **one policy/contract in v1** (multi-set collapsed to 100 ADA)."
- **§6.2 Reorg-safe read**: in the "**Never cache 'spent' as permanent**" bullet,
  keep that a beacon **BURN (`mint −1`) is an equivalent leave signal** alongside
  the spend (bury both past depth k).
- **§6.3 the deterministic pure function**: ensure the body is **group-by-`owner`
  Address + MAX-by-lovelace** (tiebreak by output reference), **never `+=`**.
  Signature: `fn beacons_to_weights(buried_beacon_utxos) -> Map<owner Address,
  lovelace>` = for each `owner` Address, **max-by (lovelace, then outref)**. Add the
  `blake2b_256(serialize(owner)) == token_name` integrity assertion using the
  **identical** `util.beacon_name` fn the validators use, over the **byte-identical
  Address serialization**.
- **§6.4**: "**Largest-wins per `owner` Address** (no cross-UTxO, no cross-set
  aggregation)"; emit `{ owner Address → largest_buried_lovelace }`.
- **§9 D0 + §12 steps 1/3/7**: publish the **largest-wins function + the beacon
  POLICY id (== vault hash) + the Address serialization + the tiebreak rule
  (output-ref order) + depth k + cursor rule**; the standalone recomputer recomputes
  **max-per-Address**; step-1 db-sync read → "select vault UTxOs by **beacon policy id**
  (== vault hash, via `tx_out.payment_cred`) … **select max lovelace** per `owner`
  Address"; step-3 property test asserts
  determinism of the **MAX + tiebreak** independent of read order, and **explicitly
  tests the duplicate-beacon case** (two equal-lovelace beacons pick the same one by
  outref).
- **Appendix A**: keep the L1 §10 reference pointing at the **beacon-based,
  whole-Address** interface (db-sync per-policy-id == vault hash; largest-wins, never
  sum); **state explicitly that on-chain does NOT guarantee global one-per-identity
  and that the follower largest-wins rule IS the uniqueness mechanism** (do not claim
  the mint enforces it).
- **Companion note:** this L1 doc's §10 is the read contract L2 consumes; the two
  docs should track each other (DR-01 owner-Address grouping; DR-18 policy id == vault
  hash; DR-02 committed-payload CIP-8). DR-34: there is no longer a summing
  double-dip to fix — L2 is already largest-wins.

---

## 11. Secondary decisions & open questions

| Topic | Recommendation / tension | Status |
|---|---|---|
| **Identity = whole Address (DR-01)** | `VaultDatum { owner: Address }` (payment `VerificationKey` cred + stake cred); beacon `token_name = blake2b_256(serialize(owner Address))`; vault stake cred == `owner.stake_cred` on create + continuation. | **Decided: whole Address (DR-01).** |
| **Single contract (multi-set collapse)** | ONE contract, `min_lock = 100_000_000` (100 ADA). Tiers are continuous capped-linear weight in your single vault's ADA, not separate addresses (§9). | **Decided: one contract.** |
| **Beacon `token_name`** | `blake2b_256(serialize(owner Address))` (32 B, the asset-name max). `blake2b_224` (28 B) also fits and leaves room for a CIP-67 label if ever needed. Same fn + same Address serialization on-chain (mint + spend) AND in the follower. | **Decided: `blake2b_256`.** |
| **One merged validator (mint+spend) (DR-18)** | ONE validator `talk_vault(min_lock)` with BOTH a `mint` and a `spend` handler (thread.ak shape); beacon `policy_id == this_hash`; the mint arm asserts `output_hash == policy_id` (beacon ⇒ canonical vault). No separate beacon policy, no `beacon_policy_id` param, **no hash cycle** (§4.1/4.5/9.2). | **Decided: ONE merged validator (DR-18).** |
| **Mint `Mint` carries Address** | `Mint(Address)` (deviates from cogno_v3's nullary `Mint`, whose name comes from a UTxO) so the mint recomputes the name + checks the owner's payment-key sig. `Burn(AssetName)` verbatim. | **Decided: `Mint(Address)`.** |
| **`policies` length == 2** | Correct (lovelace `""` policy + the 1 beacon). The rendered HTML doc misleads; the v2.2.0 SOURCE `policies = dict.keys(self.inner)` includes lovelace. ⛔ Do not "fix" to 1. | **Decided: == 2 (matches cogno_v3).** |
| **Partial-withdraw** | A one-tx shrinking continuation is **impossible** (value-non-decrease + same-name burn+remint blocked by `mint_length_and_uniqueness`). Partial = TWO sequential txs (full exit/burn, then re-mint at the smaller amount), or "over-park then never reduce" (§6.3). | **Decided: two-tx.** |
| **Global one-per-identity** | ⛔ **NOT enforceable on-chain** (mint is tx-local). The follower's largest-wins rule is the uniqueness mechanism (§7.14, §10). Do not claim the mint guarantees it. | **Decided: follower-side.** |
| **Follower duplicate rule** | **Largest-wins, never sum**, deterministic tiebreak by output reference, grouped by the whole owner Address (§10.2). Same-name duplicates are expected. DR-34: L2 on disk is already largest-wins — no live double-dip. | **Decided: largest-wins.** |
| **Burn coupling** | ⛔ Burn rides ONLY on `mint == −1` + the no-continuation arm. Do NOT couple to a value/destination check (new DS surface, zero safety, §7.11). Spend binds the burned name to its datum (blocks burn-A-while-exiting-B). | **Decided: decoupled.** |
| **Owner sig on top-up** | ⛔ Required on every path, no exception, before any value moves; checks the owner Address's payment vkey-hash (§7.1, §7.9). | **Decided: sig on EVERY path.** |
| **Continuing-output address rule** | **Whole-Address** (DR-01): payment-cred (via script) + stake-cred == `owner.stake_cred` + datum-freeze on `owner`, plus floor + value-non-decrease + ADA+beacon-only + beacon-forward (§7.5). The old payment-cred-only relaxation is re-tightened. | **Decided: whole-Address (DR-01).** |
| **Per-identity ceiling/cap** | Capped-linear; floor at `min_lock`, saturating at high stake. L3 runtime param, numbers TBD. | **Deferred to L3.** |
| **Identity-proof scheme** | Whole owner Address proven via CIP-8 **committed payload** (DR-02): signs `{ sr25519 + L3 genesis hash + fresh nonce }`; follower verifies signing address == `datum.owner` (whole address) + payload sr25519 == submitted. Bind-hijack prevented. On-chain ed25519 self-proof = deferred D1; Seedelf privacy = deferred v2. | **Decided: CIP-8 committed payload (DR-02).** |
| **Opt-in `lock_until` (future)** | DR-13: v1 has **NO on-chain timelock / NO `lock_until`** (clamp-only decay; L3 regen enforces commitment). A timelock may return later as an opt-in commitment bonus only. | **Decided: no timelock in v1 (DR-13).** |
| **Address header type** | Script payment + key-hash stake base = CIP-19 type 1, high nibble `0b0001` (§4.2). The vault stake cred MUST == `datum.owner.stake_cred` (DR-01). Assert in the off-chain builder. | **Decided: type-1 / `0b0001`.** |

**Open questions for the owner:**

> **RESOLVED in DECISION-REGISTER.md (2026-06-16) — see that doc.** The
> credential-kind question is resolved (identity is a whole `Address`, DR-01); the
> simple-vs-strict beacon-policy question is moot (ONE merged validator, DR-18). The
> detail below is retained for the record.

1. ~~**Simple vs strict beacon-policy form (§4.5).**~~ **RESOLVED (DR-18): ONE merged
   validator.** There is no separate beacon policy and no simple/strict choice — the
   mint arm asserts `output_hash == policy_id` (== this hash), the real on-chain
   "beacon ⇒ canonical vault" guarantee.
2. **`blake2b_256` (32 B) vs `blake2b_224` (28 B) token name.** 256 is the stated
   default (clean 32 B); 224 leaves 4 bytes for a possible CIP-67 label. Pick one
   **before** the follower indexes anything (all three sides must match exactly, over
   the same Address serialization). *(Still open: hash width + the canonical Address
   serialization to hash — pin both before indexing.)*
3. **Consolidation UX.** Largest-wins makes a second beacon harmless but not free
   (the user paid min fees + locked ADA). Should the wallet actively prompt users to
   burn redundant beacons and consolidate? (Off-chain UX, no on-chain effect.)

---

## 12. Implementation milestones (L1 only)

Bite-sized, executable cold. Each builds on the last.

1. **Scaffold.** New Aiken project pinned to `v1.1.16` + stdlib `v2.2.0`,
   `plutus = v3`, matching the `cogno_v3` layout. Add `VaultDatum { owner: Address }`,
   `VaultRedeemer`, `MintTypeRedeemer { Mint(Address) Burn(AssetName) }`,
   `MintRedeemer` to `lib/types.ak`; add `beacon_name(owner: Address)` (over a
   canonical Address serialization) + `search_for_output_by_token` to `lib/util.ak`,
   with `?`-style inline tests. Add `mint_validation` + `mint_length_and_uniqueness`
   to `lib/validate.ak`.

2. **Mint helpers (`lib/validate.ak`).** Implement `mint_validation` (§8.3): the
   `Mint(addr)` arm (name-binds-to-Address, owner payment-key sig, exactly +1,
   beacon-at-own-address `output_hash == policy_id` `≥ min_lock` with matching datum +
   stake-cred, no-trash `policies == 2`, no ref script, v1 payment-cred must be
   `VerificationKey`) + the `Burn(tkn)` arm (exactly −1) + `mint_length_and_uniqueness`.
   **No `vault_hash` / `beacon_policy_id` param** (DR-18: the destination IS this
   script — `policy_id == this_hash`).

3. **Merged validator (`validators/talk_vault.ak`).** Implement `talk_vault(min_lock)`
   with BOTH a `mint` handler (calls the §8.3 helpers; `policy_id` == this hash) and a
   `spend` handler (§8.4): **add the unqualified `use cardano/transaction`**; owner
   payment-key sig on every path (before any value moves), single-own-input guard
   before the branch, `[]` full-exit **burn-THIS-datum's-beacon** (`mint == −1` + `all
   outputs qty == 0`), `[cont]` floor + value-non-decrease + **beacon-forward** +
   ADA+beacon-only + **stake-cred consistency** + datum-freeze, `_ -> False`. End in
   `else(_) { fail }`.

4. **Compile + negative tests (the safety net).** **Run `aiken check`** (the skeleton
   is uncompiled). Inline tests (§8.5) covering the mint negatives (wrong name; no
   sig; script-owner rejected; +2; two beacons/junk; into non-own-address / bad-datum
   / wrong-stake-cred / sub-floor / trashy output; burn ≠ −1; **same-name burn+remint
   in one tx fails**) **and** the spend negatives (non-owner; two own inputs; fan-out;
   below floor; shrinking value; **dropping the beacon**; adding a token; **changed
   stake cred**; changed `owner` Address; full exit that does **not** burn;
   **exit-B-burning-A's-name fails**) plus the positives (register; top-up carrying
   the beacon; full exit that burns) and the **beacon-name-matches-across-sides**
   integrity test (on-chain == follower CBOR). Confirm the soft-cast arms and `expect
   (own_input_count == 1)?` compile.

5. **Parameterization & address build.** `applyParamsToScript` for `talk_vault`
   (`min_lock` ONLY) → vault hash; the **beacon policy id IS the vault hash** (DR-18,
   nothing to compute in order, no cycle). Build the **type-1 base** address pairing
   the vault payment cred with the user's own stake-key hash (Mesh `mesh-core-cst`),
   **with that stake cred == the `VaultDatum.owner` Address stake cred** (DR-01).
   **Assert the header high nibble is `0b0001`** — not `0b0000`, not enterprise — and
   assert the vault stake cred == owner stake cred.

6. **Off-chain tx builders (Mesh).** register (mint beacon + pay `≥ min_lock` ADA +
   beacon, well-formed `VaultDatum { owner: Address }`, type-1 base whose stake cred
   == owner stake cred), top-up (beacon forward, value grows, stake cred unchanged),
   partial-withdraw (**two sequential txs**: full exit/burn, then re-mint at the
   smaller `≥ min_lock` amount, §6.3), full-withdraw/LEAVE (burn beacon, reclaim all
   ADA). Assert each output's value = ADA + exactly 1 beacon (or 0 on full exit),
   datum well-formed, beacon name == `blake2b_256(serialize(owner))`.

7. **L2 interface stub.** Minimal db-sync reader: select vault UTxOs by the **beacon
   policy id** (== the vault hash, DR-18, via `tx_out.payment_cred`; optionally
   per-asset), parse datum → `owner` Address, integrity-check
   `blake2b_256(serialize(owner)) == token_name` (same `util.beacon_name` fn + same
   serialization), group by the whole `owner` Address, **select max lovelace**
   (tiebreak by output reference), bury past depth k, handle `RollBackward`, clamp on
   an observed spend **or** beacon burn. Confirms the §10
   contract; property-test read-order-independence + the equal-lovelace tiebreak + the
   duplicate-beacon case. **Cross-check `docs/L2-follower.md` per §10.7** (DR-34: L2 is
   already largest-wins; the alignment is the whole-Address grouping + serialization).

8. **Blueprint freeze.** Emit `plutus.json`, record the vault hash (== the beacon
   policy id, DR-18) (`hashes/`), freeze the validator version before any mainnet
   register. Do **not** freeze until §8.5 / step 4 pass under `aiken check`.

---

## Appendix A — Key references

- **cogno_v3 `thread.ak`** — the **single-validator** mint-beacon-on-create /
  burn-on-remove pattern this doc clones (DR-18: `mint(redeemer, policy_id, self)` +
  `spend(...)` in ONE `validator`, `policy_id == script_hash`; `RemoveThread` burns
  via `list.all(outputs, quantity_of == 0)` + owner-sig, value-decoupled;
  `UpdateThread` does the atomic burn-old / mint-new `assets.flatten` two-tuple swap;
  the `find_input` / `expect Script(this_hash)` spend idiom):
  `cogno_v3_contracts/validators/thread.ak`
- **cogno_v3 `lib/validate.ak`** — `mint_validation` (`Mint` arm:
  `search_for_output_by_token` → `output_hash == policy` (:50), `option.is_none(
  ref_script)` (:52), `policies(value) |> length == 2` no-trash (:54),
  `list.has(extra_signatories, owner)` (:55), `pointer == token_name` (:57),
  `quantity_of(mint) == 1` (:58); `Burn` arm: `quantity_of == -1` (:61-62))
  + `mint_length_and_uniqueness` (:77-89: `dict.size(tokens) == len(redeemer)`,
  `list.unique`). Cloned with `token_name = blake2b_256(serialize(owner Address))`
  (DR-01) and the destination check `output_hash == currency_symbol` kept verbatim
  (DR-18: the MERGED validator makes `policy_id == this_hash`, so the cogno_v3 :50
  check applies directly — no `vault_hash` param):
  `cogno_v3_contracts/lib/validate.ak`
- **cogno_v3 `lib/types.ak`** — `MintTypeRedeemer { Mint Burn(AssetName) }`,
  `MintRedeemer = List<MintTypeRedeemer>`; beacon changes `Mint` →
  `Mint(Address)` (DR-01): `cogno_v3_contracts/lib/types.ak`
- **cogno_v3 `lib/util.ak`** — `token_name(txid, idx)` (the txid-slice the beacon
  **replaces** with `crypto.blake2b_256(cbor.serialise(owner))`, DR-01) and
  `search_for_output_by_token` (reused as-is): `cogno_v3_contracts/lib/util.ak`
- **Aiken stdlib `aiken/crypto`** — `blake2b_256` (32 B), `blake2b_224` (28 B),
  `VerificationKeyHash = Hash<Blake2b_224, VerificationKey>`:
  https://aiken-lang.github.io/stdlib/aiken/crypto.html
- **Aiken stdlib `cardano/assets`** — `quantity_of`, `tokens` (→ `Dict`, so
  `dict.size` counts asset-names), `flatten`, `lovelace_of`, `without_lovelace`,
  `policies`; `AssetName` = 0–32 bytes; `PolicyId` = blake2b-224 (28 B). ⛠ Use the
  **source** for `policies` (`= dict.keys(self.inner)`, includes the lovelace `""`
  policy → length 2) and for `add()` (drops zero quantities → `without_lovelace`
  equality is an exact token-set match) over the rendered HTML (which misleadingly
  excludes Ada): https://aiken-lang.github.io/stdlib/cardano/assets.html ·
  https://raw.githubusercontent.com/aiken-lang/stdlib/v2.2.0/lib/cardano/assets.ak
- **Aiken stdlib `cardano/transaction`** (`find_input` → `Option<Input>`,
  `find_script_outputs` → `List<Output>` filtered to a script hash, `Output`,
  `InlineDatum`, `Transaction { inputs, outputs, extra_signatories, mint, .. }`;
  `mint` is a `Value` with burns as negative quantities; **note the qualified
  `transaction.*` calls require the unqualified `use cardano/transaction`**):
  https://aiken-lang.github.io/stdlib/cardano/transaction.html
- **Aiken stdlib `aiken/collection/{list,dict}`** (`count`/`has`/`all`/`unique`/
  `length`; `find`/`any` return the FIRST match — the double-satisfaction hazard;
  `dict.size`): https://aiken-lang.github.io/stdlib/aiken/collection/list.html
- **Aiken — Validators** (a single `validator` with BOTH `mint(redeemer, policy_id,
  self)` and `spend(...)` handlers → `policy_id == script_hash`, the DR-18 merged
  shape; params embedded in compiled code → unique policy id):
  https://aiken-lang.org/language-tour/validators
- **Aiken — Gift Card** (canonical mint +1 / burn −1 via
  `tokens |> dict.to_pairs`; exact-one-asset idiom; note gift-card bakes the name as
  a PARAM whereas the beacon DERIVES it from the pkh):
  https://aiken-lang.org/example--gift-card
- **Aiken — Common Design Patterns** (one-shot / NFT mint; double-satisfaction;
  beacon-token indexing; output tagging):
  https://aiken-lang.org/fundamentals/common-design-patterns
- **Vacuumlabs — Double Satisfaction #1 / #2** (the single-own-input `== 1` guard;
  cross-script DS via minting + the "each side must check independently" / output-
  tagging mitigations that motivate §7.4 and §7.8):
  https://medium.com/@vacuumlabs_auditing/cardano-vulnerabilities-1-double-satisfaction-219f1bc9665e
  · https://medium.com/@vacuumlabs_auditing/cardano-vulnerabilities-2-double-satisfaction-continued-a66043d025c0
- **CIP-0089 — Distributed DApps & Beacon Tokens** (beacons are UTxO TAGS discovered
  by policy/asset filtering; minted-on-create / burned-on-spend; **structural** — NOT
  global per-identity — guarantees; backs "don't claim global uniqueness; the
  follower handles it"): https://cips.cardano.org/cip/CIP-0089
- **CIP-0019 — address header nibbles** (type-1 = script payment + key stake, high
  nibble `0b0001`; unchanged by the beacon):
  https://github.com/cardano-foundation/CIPs/blob/master/CIP-0019/README.md
- **CIP-0008 — message signing** (the off-chain identity proof: under DR-02 a
  controller signs a **committed payload** `{ sr25519 + L3 genesis hash + fresh
  nonce }` from an address that must recover to == `datum.owner` (the WHOLE Address,
  payment AND stake); an L2 concern, NOT verifiable by the mint handler):
  https://github.com/cardano-foundation/CIPs/tree/master/CIP-0008
- **db-sync** (read-only Postgres, the sole Cardano data/observation layer via
  `DBSYNC_URL`; select vault UTxOs by `tx_out.payment_cred = <policy id>`; spentness
  from `tx_in`; coins/qty as `::text`; a rolled-back spend's `tx_in` row is removed):
  https://github.com/IntersectMBO/cardano-db-sync
- **Companion docs:** `docs/L2-follower.md` (already largest-wins / never-sum on disk,
  DR-34 — cross-check per §10.7 for the whole-Address grouping + serialization, NOT a
  live double-dip); `DECISION-REGISTER.md` (the canonical decisions DR-01/DR-02/DR-13/
  DR-18/DR-34 reconciled into this doc); this file REPLACES the prior pure-vault
  `docs/L1-cardano.md` (the base it preserves + extends).
- **Style reference:** `cogno_v3_contracts/{validators/thread.ak, lib/{types,validate,
  util}.ak}` — Aiken `v1.1.16` + stdlib `v2.2.0`, `plutus = v3`.
