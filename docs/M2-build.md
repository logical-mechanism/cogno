# M2 build log — the Cardano CIP-8 identity gate (the "READ link")

**Status: DONE (2026-06-17).** Posting now requires a 1:1 Cardano-identity binding. An unbound
account is rejected with `NotAllowed`; a real CIP-8 signature over a committed payload binds the
**whole owner Address** to an sr25519 posting key, after which that account posts **feelessly**.
Built on M0 (chain) + M1 (frontend) + M2c (feeless capacity). Spec **102 → 103**, `transaction_version`
unchanged (2). Cardano-sourced **weight** is still M2d (weight is sudo-granted in M2).

This log is the resumable record: the design, the **exact pinned CIP-8 payload bytes**, the follower
API, what is real vs stubbed, the v1 trust limits, the gotchas, and the acceptance evidence.

---

## 1. What M2 added (three pieces)

| Piece | Where | What |
|---|---|---|
| **pallet-cogno-gate** @ index 8 | `pallets/cogno-gate/` | the 1:1 owner-Address↔account binding (the anti-Sybil anchor) + `is_allowed` |
| **Cogno-Follower** | `services/cogno-follower/` | a Python HTTP service: real CIP-8 verify (pycardano) → `link_identity` |
| **frontend bind flow** | `app/src/lib/cardano/`, `hooks/useIdentity.ts`, `IdentityRail` | CIP-30 connect → signData → POST → `AccountOf` readback + the gate UI |

The demo flow: **link_identity (bind, via the follower)** → **set_stake (weight, sudo — M2d makes
this Cardano-sourced)** → **feeless post**.

---

## 2. The chain: pallet-cogno-gate (@ runtime index 8)

- **Identity key = `[u8; 32]`** = `blake2b_256(serialized owner Address)` (DR-01; == the L1 beacon
  `token_name`, NOT a bare 28-byte `owner_pkh`). A fixed array, not a `BoundedVec` — exactly a hash,
  so the codec enforces the length and the `AccountOf` key is the raw 32 bytes (no length prefix), so
  the client readback keys on identical bytes.
- **Storage:** `PkhOf: AccountId → [u8;32]` + `AccountOf: [u8;32] → AccountId` (both directions →
  a 2nd bind on either side is O(1)-rejectable) + `ThreadOf: AccountId → BoundedVec<u8, ConstU32<10>>`
  (the optional cogno_v3 thread pointer; **10** hex chars, never `<4>`, DR-23).
- **`link_identity(origin, identity_hash, substrate_account, thread_pointer?)`** — `FollowerOrigin`-gated.
  Rejects double-bind (`AccountAlreadyBound` / `PkhAlreadyBound`). Calls `on_first_bind` (microblog) to
  prime the capacity row + provider ref. **Calls `on_first_bind` only — NOT a separate `inc_providers`**
  (on_first_bind already does it; doing both double-counts — diverges from the task's literal wording,
  see gotchas).
- **`revoke(origin, substrate_account)`** — `FollowerOrigin`-gated, the DR-14 manual-ban path. Removes
  both maps (→ `is_allowed` false → posting blocked) + frees the identity to re-bind. **Leaves** the
  capacity row + provider ref in place (they pair with microblog's never-delete-row invariant; full
  teardown is M2b — a deliberate, documented stub).
- **`is_allowed(who) = PkhOf::contains_key(who)`** — the authoritative on-chain Sybil gate.
- **`FollowerOrigin = EnsureRoot<AccountId>`** in v1 dev (the DR-07 sudo escape hatch). An
  `EnsureOrigin`, so the widen to a 3-of-5 k-of-t committee (D2) is signature-free.

### The crate-cycle gotcha (the key M2 architecture decision)

microblog needs `is_allowed` from the gate; the gate needs `on_first_bind` from microblog → a Cargo
cycle if implemented literally. **Broken by two traits that BOTH live in `pallet-microblog`** (the
depended-upon crate): `IsAllowed<AccountId>` and `OnIdentityBind<AccountId>`. cogno-gate (which already
depends on microblog) **implements** `IsAllowed` and **consumes** `OnIdentityBind` (wired to `Microblog`
in the runtime). Neither pallet names the other's crate in a trait bound. microblog `post_message` gains
`ensure!(T::IdentityGate::is_allowed(&who), Error::NotAllowed)` right after `ensure_signed`.

---

## 3. THE PINNED CIP-8 COMMITTED PAYLOAD (DR-02) — the byte-exact agreement

The single most important interface in M2: a **two-sided, byte-exact** agreement between the frontend's
MeshJS `signData` and the follower's pycardano `verify`. No doc pinned the literal bytes — **this is the
decision**, and it is **proven** to agree (`test_agreement.py`).

The exact UTF-8 string the user signs:

```
cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<hex>
```

- **It is a single-line UTF-8 string, not raw concatenated bytes.** Hard constraint: pycardano
  `verify` returns `message = payload.decode("utf-8")`, so the payload MUST be valid UTF-8. ASCII-only,
  fixed field order, `;` separator, no spaces → unambiguous, trivially re-derived identically.
- `genesis` — the L3 genesis block hash, lowercase hex, 64 chars, no `0x` (**anti-cross-chain**).
- `account` — the 32-byte sr25519 posting pubkey, lowercase hex, 64 chars (**commits the bind target →
  anti-hijack**: the operator cannot re-point an honest proof at another account).
- `nonce` — the follower-issued nonce, lowercase hex (16 bytes), single-use, 300s TTL (**anti-replay**).

**The identity hash bound on-chain** = `blake2b_256(serialized owner Address)` (the raw CIP-19 address
bytes), 32 bytes. Proven byte-identical across **MeshJS `Address.toBytes()`** and **pycardano
`Address.to_primitive()`** → L1 beacon name, L3 binding key, and L5 readback all key on the same bytes.

Source of truth: `services/cogno-follower/payload.py` (`build`/`parse`). The frontend signs the string
the follower returns from `/nonce` (and re-checks it commits its own account + genesis before signing).

---

## 4. The Cogno-Follower (`services/cogno-follower/`)

Reuses **`pycardano.cip.cip8.verify`** — the proven cogno_v3 path (`verify_view.py`), pinned
`pycardano==0.13.0`. Does NOT reimplement COSE_Sign1. On top of `verify()`'s own checks (Ed25519 +
the COSE-header address hashes to the signing key) it asserts the binding invariants (`verify.py`):

1. `verified == True`
2. recovered signing Address `== claimed signing_address` (catches a lying client)
3. the payment credential is a **VerificationKey** (rejects script/vault addresses — DR-01; structurally
   closes the "never sign from the vault" gotcha)
4. committed `genesis ==` this chain's genesis (anti-cross-chain)
5. committed `account ==` the submitted `sr25519_pubkey` (anti-hijack)
6. nonce valid + single-use (consumed last, so a rejected proof doesn't burn it)
7. → bind `blake2b_256(address.to_primitive())`

**API:** `GET /health` · `GET /nonce?account=<hex>` → `{nonce, genesis, payload}` (the exact string to
sign) · `POST /bind {signature, key, signing_address, sr25519_pubkey, thread_pointer?}` → verify + submit.
The follower never sees a private key; it submits `link_identity` via the proven PAPI path
(`app/scripts/submit-link.mjs`, sudo-wrapped — the DR-07 dev escape hatch) rather than re-encoding the
custom feeless `TxExtension` set off PAPI.

**Run:** `services/cogno-follower/run.sh` (reuses cogno_v3's venv by default). Genesis is fetched from the
node via JSON-RPC at startup (`27af3857…bfb2ed16`, deterministic for `--dev`).

---

## 5. The frontend (`app/`)

- `lib/cardano/cip8.ts` — the bind flow (MeshJS **dynamic-imported** inside the async fns so the static
  export stays SSG-safe). Picks a VerificationKey-payment change address (rejects script via
  `Address.getProps().paymentPart.type !== 0`); re-checks the follower's payload commits MY account + this
  genesis before signing; client pre-flight rejects 64-byte extended keys (`getPublicKeyFromCoseKey`);
  POSTs to the follower.
- `lib/chain/identity.ts` — `isAccountBound` (PkhOf) + `readAccountOf` (the readback). `hooks/useIdentity.ts`
  — bind state + action; after the follower submits, polls `AccountOf(idHash)` until it resolves to MY
  account (bind = chain-confirmed, not just POST-accepted).
- `IdentityRail` — the Cardano seal chip is LIVE: "bind Cardano →" (unbound) → wallet picker → "bound ✓".
  `ProvenanceLine` — a 2nd honesty badge **`follower: trusted (v1)`** beside `chain: operator-run (v1)`.
  `Composer` — gated on the identity ("bind a Cardano identity to post"; null/unknown never blocks —
  the runtime is the authority, consistent with the capacity gate).
- `npm run grant` now also **sudo-binds** dev accounts (DR-07) so the pure-Substrate showcase works
  without a Cardano wallet (deterministic dev hash = `blake2b_256("cogno-dev-bind:" + ss58)`).

---

## 6. v1 trust limits (named honestly — no overclaiming)

- **`follower: trusted (v1)`** — the follower is the SOLE verifier AND writer. A malicious/buggy follower
  could fabricate a binding. **Prevented** in v1 (not just detected): the committed payload binds
  `{account + genesis + nonce}` *inside* the signature, so it cannot re-point an honest user's proof; the
  1:1 on-chain anchor rejects double-binds; the `AccountOf` readback is the client's check. The on-chain
  ed25519 self-proof (removes the follower from the trust path) is **D1**; a 3-of-5 k-of-t key is **D2**.
- **`chain: operator-run (v1)`** — single dev node; signed ≠ included.
- **Wallet-only CIP-8 (DR-14).** No Cardano vault is observed yet → the owner Address is self-asserted;
  cross-checking it against an on-chain `talk_vault` UTxO (and sourcing **weight** from the locked ADA) is
  **M2d** (the seam is flagged in `verify.py`). Weight is sudo-granted in M2.
- Dev HTTP + permissive CORS + sudo-wrapped submit are dev shortcuts, named in the follower README.

---

## 7. Build/runtime gotchas (each could cost a cycle)

1. **Double `inc_providers`.** `link_identity` must call `on_first_bind` ONLY — it already does
   `inc_providers` (microblog). Calling both double-counts; `revoke`'s single `dec` would then leave it
   stuck. (Diverges from the task's literal "inc_providers + on_first_bind" wording — verified against the
   live code.)
2. **The crate cycle** — both loose-coupling traits live in microblog (§2). microblog must NOT depend on
   cogno-gate.
3. **Identity key = `[u8;32]`, not Vec/BoundedVec** — exact bytes for the cross-system key agreement;
   `FixedSizeBinary.fromBytes` is the PAPI encoding (encoded call head `0x0800a1a1…` = pallet 8, call 0,
   32 raw bytes, no length prefix).
4. **The payload MUST be UTF-8** (pycardano does `payload.decode("utf-8")`) — a string, not raw bytes.
5. **MeshJS `signData(payload, address)`** — payload FIRST (MeshJS order, not CIP-30's `(addr, data)`).
6. **MeshJS must be dynamic-imported** in the frontend (browser-only) or the static export build breaks.
7. **`transaction_version` stays 2** — the gate adds storage/calls/an error (spec_version bump) but NO
   new `TxExtension`. Bumping tx_version needlessly would break PAPI/wallet extrinsic construction.
8. **A fresh `--tmp` node** is needed per `m2-acceptance.mjs` run (a prior run's bindings contaminate the
   baseline). The `--dev` genesis is deterministic, so the follower's hardcoded genesis survives restarts.

---

## 8. Acceptance evidence (real output)

**Pallet unit tests — 33 green** (`cargo test -p pallet-cogno-gate -p pallet-microblog -p pallet-talk-stake`):
cogno-gate **11** (incl. the real gate↔microblog↔talk-stake integration mock: unbound→NotAllowed,
link→is_allowed→post, double-bind both sides, revoke→re-lock→re-bind), microblog **17** (incl. the new
`unbound_identity_cannot_post`), talk-stake **5**. Release node builds clean.

**Chain acceptance — `node scripts/m2-acceptance.mjs` PASS 21/21** (sudo-driven, no Cardano):
spec 103 · CognoGate@8 · unbound (even when weighted + capacity-primed) post → `NotAllowed` (identity ≠
rate-limit) · `sudo(link_identity)` binds · `AccountOf`/`PkhOf` resolve · **feeless post (free Δ=0)** ·
double-bind rejected both ways (PkhAlreadyBound / AccountAlreadyBound) · revoke re-locks then frees the
identity to re-bind.

**Follower verify — `test_agreement.py` PASS 10/10** (real headless-MeshJS CIP-8 through the actual
`verify.py`): a real signature verifies · `pycardano to_primitive() == MeshJS toBytes()` ·
`blake2b_256(address)` agrees byte-for-byte (`e794ac8d…da8ee95`) · **5 negative tests reject** (wrong
genesis, account substitution, bad nonce, tampered signature, wrong-address).

**Follower → chain e2e — `node scripts/m2-follower-e2e.mjs` PASS 9/9**: `GET /nonce` → MeshJS sign →
`POST /bind` → the follower verifies the REAL CIP-8 + submits `link_identity` → on-chain
`AccountOf(idHash) == my account` → FEELESS post (free Δ=0).

**Browser — `node scripts/e2e-m2.mjs` PASS** (headless Chrome on the built static SPA): both honesty
badges render · bound `//Alice` posts to the live feed · switching to a fresh UNBOUND session key flips
the seal to "bind Cardano →" and GATES the composer (Post disabled). Screenshots in `/tmp/cogno-m2/`.

**The one manual step (the real DONE-WHEN #4 wallet click-through):** binding via a real CIP-30 browser
extension (Eternl/Lace) can't be driven headlessly. Run the stack (below), connect a wallet, click the
seal's "bind Cardano →", sign once, and watch the `AccountOf` readback confirm the bind. The headless
`m2-follower-e2e.mjs` proves the identical path programmatically.

### How to run the full stack

```bash
# 1. chain (fresh)
./target/release/cogno-chain-node --dev --tmp --rpc-port 9944
# 2. follower
services/cogno-follower/run.sh                         # :8090
# 3. app (dev) OR the built SPA
cd app && npm run dev                                  # :3000   (or: npm run build && serve out/ on :8099)
# pure-Substrate quick demo (no Cardano wallet): bind+weight+charge a dev account via sudo
cd app && node scripts/grant-weight.mjs //Alice
```

---

## 9. Next: M2d (Cardano-sourced weight)

Compile the L1 Aiken `talk_vault` + add Kupo/Ogmios vault observation to the follower (the seam in
`verify.py`): assert the recovered owner Address `== datum.owner` of an observed vault UTxO, and drive
`set_stake` from the locked ADA (largest-UTxO-wins per pkh). Then M3 (anchor) per PLAN §8.
