# M2d build log — Cardano-sourced weight (L1 vault + the beacon bridge)

**Status: PARTIAL (2026-06-17).** The self-contained, fully-verifiable half is **DONE**: the L1
`talk_vault` Aiken contract is **compiled** with a green freeze-gate suite, and the L1↔L2↔L3 beacon
identity hash is **proven byte-exact and reconciled**. The remaining half — **live** vault
observation (Kupo/Ogmios) driving `set_stake` from a real ADA lock — needs a **synced cardano-node +
Kupo on preprod/mainnet**, the one external dependency this environment can't satisfy. The pure
logic for it is built and fixture-tested; the live wiring is a thin, named wrapper.

## What M2d is

After M2, weight is still sudo-granted. M2d makes weight **Cardano-sourced**: a user locks ADA in the
L1 `talk_vault` (marked by a per-user beacon NFT), the follower **observes** that UTxO, and writes
`TalkStake.set_stake(account, weight)` from the locked ADA. The bind (M2) and the weight (M2d) are
independent halves that meet at the **beacon name** = the identity hash.

## 1. The L1 `talk_vault` contract — COMPILED (the long-blocked freeze gate)

`contracts/` (aiken v1.1.22, stdlib v2.2.0, plutus v3). ONE merged `talk_vault(min_lock)` validator
(DR-18): mint + spend, `policy_id == this validator's own hash`. `datum = VaultDatum { owner: Address }`
(DR-01, the whole CIP-19 address; no `lock_until`). Owner-reclaimable ADA vault + a beacon NFT whose
`token_name = blake2b_256(cbor.serialise(owner))`.

- **mint:** name binds to the whole owner Address; owner's payment vkey signs; exactly +1; lands at
  this script's OWN address; ≥ `min_lock` (100 ADA); `datum.owner == addr`; vault stake cred ==
  owner stake cred; ADA + 1 beacon only; no ref script. `Burn` = exactly −1. A length+uniqueness
  guard blocks +2 / a junk token / a duplicate redeemer.
- **spend:** owner payment sig on every path (before any value moves); single-own-input
  double-satisfaction guard; continuation = floor + value-non-decrease + beacon-forward +
  token-set-freeze + stake-cred-consistency + datum-freeze; full exit = burn the beacon bound to
  THIS datum; fan-out (>1 own output) rejected.

**`aiken check`: 18 checks, 0 errors, 0 warnings** — 4 positives (create / burn / top-up / full-exit)
+ 13 negatives (each tweaking one load-bearing line off a valid base so the trace shows exactly that
line rejecting) + the beacon-agreement lock test. Unparameterized validator hash `19bcec34…`; the
live vault hash applies `min_lock = 100_000_000` via `applyParamsToScript`, and the beacon policy id
IS that hash.

## 2. The beacon-name bridge (L1↔L2↔L3, DR-01) — PROVEN + RECONCILED

The identity hash that the gate binds (L3), the beacon `token_name` the contract mints (L1), and the
CIP-8 match (L2) must all be the **same 32 bytes** (DR-01). **M2 shipped the wrong serialization** —
`blake2b_256(raw CIP-19 address bytes)` — but:

- The on-chain name is `blake2b_256(cbor.serialise(owner))` = the **Plutus-Data CBOR** of the Aiken
  `Address` (Constr 0 / tag `121`, **indefinite-length arrays**), which has **NO network byte** (the
  Aiken `Address` type carries only the payment + stake credentials).
- The Aiken `Address` **cannot reconstruct** the raw CIP-19 bytes (no network), so the CBOR form is
  the only one all three layers can produce → it is canonical.

**Reconciled + proven byte-exact:**
- `contracts/validators/talk_vault.ak :: beacon_name_matches_follower` locks the name for owner
  `vkey(a1·28) + stake vkey(b2·28)` to `6e2f65e9160dfbef407bfd9bce3a0aa733e12b562a856327acc3092060e0ca50`.
- `services/cogno-follower/beacon.py` reproduces it in pycardano via
  `RawPlutusData(CBORTag(121, IndefiniteList([...]))).to_cbor()` → the SAME bytes
  (`d8799fd8799f581c a1… ff d8799fd8799fd8799f581c b2… ffffffff`) → the SAME hash. `test_beacon.py`
  asserts the locked value; it is network-independent (mainnet owner → same name) and handles
  base / enterprise / script-stake credentials.
- `verify.py` now derives the L3 identity hash via `beacon_name` (not `to_primitive()`), so a CIP-8
  binding can be matched to an observed vault UTxO in M2d.

The M2 follower/e2e tests were updated to the beacon-name hash (`test_agreement.py` 9/9,
`m2-follower-e2e.mjs` 9/9 — real CIP-8 → the follower binds the beacon-name hash → `AccountOf`
readback → feeless post). **The M2 already-committed runtime/gate is unaffected** (it stores whatever
32 bytes the follower submits); only the follower's *derivation* changed.

## 3. The vault→weight pipeline — LOGIC BUILT + FIXTURE-TESTED

`services/cogno-follower/vault.py`:
- `parse_matches` — extract `(beacon_name, lovelace)` from Kupo `/matches/{policy}.*` JSON.
- `weights_by_identity` — **LARGEST-WINS per identity, NEVER SUM** (a Sybil can't multiply weight by
  fragmenting a lock; nobody is zeroed). `weight = locked lovelace` (the L3 `CapRatio`/`Ceiling`
  apply the capped-linear curve + the per-identity ceiling; L1 only enforces `min_lock`).
- `plan_set_stakes` — map each observed identity → its bound account (`CognoGate.AccountOf[beacon]`),
  skipping the unbound; yields `[(account, weight)]`.
- `query_kupo` / live submit — **thin wrappers needing a synced node** (named, not hidden).

`test_vault.py` 8/8: curve floor; parse; **largest-wins (A's two vaults 200+350 → 350, not the
sum 550)**; the set_stake plan (bound A weighted, unbound B skipped).

## 4. The remaining live integration (the external wall — your hand-off)

`aiken`, `kupo`, `ogmios`, `cardano-node`, `cardano-cli` are all installed (`/usr/local/bin`), but
**no node is synced** here. To close M2d live:

1. **Publish the parameterized vault address.** `applyParamsToScript(talk_vault, [100_000_000])` →
   the vault hash; pair its script payment cred with your stake key → the type-1 base address;
   beacon policy id = the vault hash. (An off-chain helper in `app/scripts/` using
   `@meshsdk/core-cst` `applyParamsToScript` + `resolveScriptHash`.)
2. **Sync** a preprod `cardano-node`, point **Ogmios** at it and **Kupo** at the beacon policy id.
3. **Lock** ≥100 ADA at the vault address with `VaultDatum { owner }` + mint the beacon (a MeshJS tx;
   `Mint(owner)` redeemer).
4. **Follower:** add a `query_kupo` poll loop → `plan_set_stakes` → submit `sudo(set_stake)` (a
   `submit-stake.mjs`, mirroring `submit-link.mjs`); add the **vault-datum cross-check** at the
   `verify.py` M2d seam (recovered CIP-8 owner Address == the observed `datum.owner`).
5. **Demo:** lock ADA → the follower grants weight → post feelessly with **zero sudo grant**.

Also deferred (a hardening, not a blocker): the **frontend** currently uses the follower's returned
identity hash for the `AccountOf` readback. For a fully independent client check it should compute the
beacon name itself (MeshJS Plutus-Data CBOR of the address — the same recipe as `beacon.py`).

## Acceptance evidence

`aiken check` 18/18 · `test_beacon.py` 4/4 · `test_vault.py` 8/8 · `test_agreement.py` 9/9 ·
`m2-follower-e2e.mjs` 9/9. Next: the live preprod wiring above, then **M3 (anchor)** per PLAN §8.
