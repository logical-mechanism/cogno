# Trustless identity (D1) — on-chain CIP-8 self-proof

> **Note.** The mechanism (on-chain CIP-8 self-proof, `cip8.rs`) is current and present in the
> `fork/all-rust` runtime (`spec_version` **201**). The spec numbers below (e.g. 116) are **pre-restart
> build history**, a few cross-references point to the retired pre-restart layered specs (`L2-follower`,
> `L3-SPO-graduation`), and the CI oracle cited as `services/cogno-follower/{verify,beacon}.py` now lives
> at `ci/cip8-oracle/`. The current system overview is [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Status: DONE, proven live on a `--dev` node. The bind is now FEELESS (spec_version 116): the two CIP-8
self-proofs — `link_identity_signed` (@2) and `link_stake_signed` (@3) — are submitted as BARE (unsigned)
extrinsics and verified at transaction-pool admission (`#[pallet::validate_unsigned]`), so a brand-new
zero-balance account binds with no fee and NO funded relay (the Sponsored-Bind Relay is removed). The
crown-jewel verifier `cip8.rs` is byte-identical; only the origin (signed → none) and the spam gate (a fee
→ pool-admission verify) changed.** This is the D1 rung of the identity trust ladder: the trusted
off-chain identity binding (an earlier design) is **replaced** by an
on-chain cryptographic self-proof. It is **validator-independent** — it *removes* a trusted party (the
follower's bind-write key) without adding one.

## What changed

| | Before (M2, v1) | After (D1) |
|---|---|---|
| Who verifies the CIP-8 proof | the trusted off-chain Cogno-Follower (`pycardano`) | **the runtime**, on every full node (`pallet_cogno_gate::cip8`) |
| Who writes the binding | the follower, via `FollowerOrigin`-gated `link_identity` | **anyone**, via permissionless `link_identity_signed` |
| Trust in the binding's correctness | the follower's key (compromise ⇒ forge any identity) | **none** — re-verified from the user's own wallet signature |
| `FollowerOrigin` now gates | `link_identity` + `revoke` | **only `revoke`** (the moderation ban) |
| The Cogno-Follower service | trusted verifier + sole writer | **read-only helper** (`/health`, `/metrics`, `/nonce`) — writes nothing |

The trusted `link_identity` dispatchable is **removed**; its `call_index(0)` is permanently vacant
(on-wire call indices are a contract). `link_identity_signed` (`call_index(2)`) is the only bind path.

## The on-chain flow (`pallet_cogno_gate`) — FEELESS, unsigned (spec 116)

```
link_identity_signed(origin: None, cose_sign1: BoundedVec<u8,512>, cose_key: BoundedVec<u8,128>,
                     thread: Option<Vec<u8>>)        // a BARE (unsigned) extrinsic
```

The bind is **feeless** and submitted as a **bare (unsigned) extrinsic**: the CIP-8 proof *is* the
authorization, so there is no fee payer, no nonce, and no signing account. That is what lets a brand-new
sign-to-derived posting account — **zero balance, zero provider references** — complete its FIRST
on-chain action with no funded sponsor (the old bind-funding gap, closed without a relay; see below).

There are two gates, the same verifier in both:

1. **Pool admission** — `#[pallet::validate_unsigned]` runs on every full node at gossip AND at block
   inclusion (via `pre_dispatch`, which is consensus-enforced: an importer re-runs it and rejects a block
   carrying a junk bind). It runs `cip8::verify_bind_proof`, the genesis check, and then mirrors
   `do_bind`'s state rejections **at the pool**: a tombstoned identity, or either side of the 1:1 already
   bound, is rejected `Stale`; a bad/cross-chain proof is `BadProof`. So junk + already-settled binds are
   refused *before* they are gossiped or included for free, and a `provides` tag (the identity hash) lets
   the pool dedupe repeats. This is the WHOLE spam gate now that the fee is gone (see the DoS posture).
2. **Dispatch** (`ensure_none(origin)`) — re-runs `cip8::verify_bind_proof` + the genesis check
   (authoritatively, to derive `{ account, identity }`) and calls `do_bind(account, identity, thread)`:
   refuse a tombstoned identity (`Error::IdentityTombstoned`); enforce the 1:1 invariant on **both** maps
   (`AccountAlreadyBound` / `PkhAlreadyBound`); write `PkhOf` + `AccountOf` (+ `ThreadOf`); prime the
   microblog capacity row + provider ref via `OnBind::on_bind`; emit `IdentityLinked`.

The verify (`verify_bind_proof` / `verify_bind_proof_stake` in `cip8.rs`) is **byte-identical** to before
— only the *origin* (signed → none) and the *gate* (a fee → `validate_unsigned`) changed; `cip8.rs` was
not touched. The stake (voting-power) bind `link_stake_signed` (`call_index 3`) is the same shape:
feeless, unsigned, verified at the pool, with `validate_unsigned` additionally requiring the committed
account to be payment-bound (the frontend submits it only after the identity bind is in a block).

The **bound account is the one the proof cryptographically commits** — there is no submitter to retarget
it, so no one can bind a victim's key. Front-running a valid proof merely completes the intended bind.

### Revocation is a permanent tombstone (DR-14)

`revoke` (still `FollowerOrigin`-gated — the operator-ban moderation lever) removes both maps and inserts
the identity into `Tombstoned`. `do_bind` refuses a tombstoned identity, so an **eternally-valid CIP-8
proof replayed after a ban can never resurrect the binding**. "Ban means ban."

## The verifier (`pallet_cogno_gate::cip8`) — the anti-Sybil crown jewel

A pure, total, `no_std` function over byte slices. It mirrors the off-chain `verify.py` exactly, made
on-chain. What it proves:

1. The Ed25519 signature is valid over the COSE `Sig_structure` (`sp_io::crypto::ed25519_verify`).
2. The verifying key (the COSE_Key `-2` field, the **single key source**) hashes (blake2b-224) to the
   address's payment credential — the signer controls the address.
3. The address is a VerificationKey-payment base/enterprise address **on the configured network**
   (rejects script-payment, pointer, stake-only, Byron, wrong-network).
4. `identity = blake2b_256(plutus_data_cbor(owner Address))` — the **L1 beacon `token_name`**, reproduced
   byte-exact (so a bind matches an observed `talk_vault`).
5. The signed payload is exactly `cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>`; the
   caller checks `genesis` and binds the committed `account`.

### Security invariants (from the adversarial threat-model — every one load-bearing)

- **Single key source.** The verification key is the COSE_Key `-2` ONLY — the SAME 32 bytes are both
  ed25519-verified AND blake2b-224-hashed for the address bind. A KID in the protected header, if present,
  must equal it byte-for-byte. (Closes the "verify one key, hash another" forge.)
- **Verbatim `Sig_structure`.** `protected_bstr` and `payload_bstr` are spliced as the EXACT wire bytes
  the wallet signed — never re-encoded; the address is parsed out of those same bytes in place. (Closes
  the COSE parser-differential.)
- **Strict canonical CBOR.** Definite lengths, minimal-length encodings, no indefinite forms, no duplicate
  map keys, no trailing bytes — every reader is TOTAL (checked access, no panics; the wasm runtime builds
  with overflow-checks off, so a panic on attacker input would halt block import).
- **Reject `hashed:true`, detached payloads, non-empty external_aad** (hard-coded `h''`).
- **32-byte keys only** — reject 64-byte extended keys (one rule, no truncation).
- **Network pin** (`CardanoNetwork`, = 0 testnet) — the beacon-name identity carries no network byte, so
  without this a mainnet and a testnet address with the same credentials would collide.
- **Determinism.** Substrate's `ed25519_verify` is `ed25519-zebra`. The off-chain reference is
  `libsodium` (pycardano). Both reject the same borderline signatures for a 1:1 binding; **do not register
  `UseDalekExt`** (it would change `ed25519_verify` semantics and could split honest re-verifiers).

### Cross-impl agreement (the safety net for an unaudited verifier)

The identity derivation is independently implemented **three** ways and they must agree:

- the on-chain Rust verifier (`cip8.rs`), with a locked cross-impl vector in `cip8/tests.rs`
  (`6e2f65e9…`) + a real `MeshWallet.signData` fixture + adversarial negatives;
- the off-chain Python reference (`services/cogno-follower/verify.py` + `beacon.py`), run in CI by
  `test_agreement.py` against real MeshJS fixtures + adversarial negatives (kept *only* as this oracle —
  it writes nothing);
- the frontend (`@meshsdk/core-cst`).

The live `d1-acceptance.mjs` run confirmed the on-chain identity (beacon name
`9a8cdaa7df32352a…` for the fixture address) equals the Python reference's output — independent
implementations agreeing on real bytes.

## Weight / DoS posture (feeless — spec 116)

The fee is **gone**; the compute-DoS it defended is moved EARLIER, to **pool admission**. The whole
defence is now `#[pallet::validate_unsigned]`. The FRAME-benchmarked dispatch weight is unchanged
(**≈ 67.85 µs / 6 reads / 5 writes** — the `ed25519_verify` + 2× blake2 + the bounded CBOR/address/payload
parse, on top of `do_bind`); it lands in the block-weight budget so `CheckWeight` bounds how many binds a
block can carry. The honest spam analysis:

- **What is rejected for free** (no crypto): oversized blobs are rejected at SCALE **decode** (the call
  args are `BoundedVec<.., 512>` / `BoundedVec<.., 128>`); a malformed COSE structure is rejected by the
  verifier's own pre-`ed25519` parse (`verify_bind_proof` returns before the signature check). Only a
  *well-formed* proof reaches the (unavoidable, audited) `ed25519` verify.
- **What costs one `ed25519`** (~68 µs, uncompensated): a well-formed proof with a junk signature, a
  wrong-genesis proof, or a valid proof for an already-bound / tombstoned identity. All are rejected at
  the pool (`BadProof` / `Stale`) *before* gossip or inclusion. The `provides`-tag dedupes exact repeats;
  a short `longevity` ages stragglers out. The aggregate cost is bounded by the pool's size/peer caps and
  by `CheckWeight` at inclusion — an attacker cannot fill blocks faster than the per-block weight budget.
- **No amplification.** A bind grants **nothing actionable** on its own: posting talk-capacity comes from
  the observed locked-ADA vault and voting power from the observed Cardano stake, both keyed on the bound
  credential and both requiring **real on-chain Cardano value**. So a flood of *valid* binds of fresh,
  empty Cardano addresses (which an attacker can keygen cheaply) is **not** a Sybil/economic win — it
  buys zero posting or voting weight. Its only effect is permanent storage growth, rate-bounded per block
  as above. (The prior fee bounded that growth; a mainnet deployment would re-introduce an anti-bloat
  cost — a refundable deposit or a PoW stamp — as a documented `MAINNET PREREQUISITE`, not a testnet bug.)
- **Per-IP rate-limiting still exists** — it moves from the (now-deleted) relay's app code to the **RPC
  ingress** (nginx / the node's RPC limits), where it protects *all* feeless calls (posts included), not
  just binds.
- **Authorization is not weakened.** The proof still commits `{account, genesis}` and the runtime is the
  sole verifier, so removing the fee/relay does **not** let anyone bind a victim's key or retarget a
  bind; a tombstoned identity is still refused — now at the pool, not only at dispatch.

This is an honestly-labelled **testnet** posture (`usable ≠ trustless`). Proven live by
`app/scripts/d1-acceptance.mjs`: a brand-new **zero-balance** account completes BOTH the identity and the
stake bind as bare unsigned extrinsics with **Δbalance = 0** (no fee, no relay), posts feelessly, then a
replayed proof is **refused at the pool** (`Invalid: Stale`) by the tombstone, and a junk proof is
refused at the pool (`Invalid: BadProof`).

## Bind funding — closed by making the bind feeless (no relay)

Before spec 116, `link_identity_signed` was **not feeless**, so a freshly sign-to-derived posting account
(zero balance on a new chain) could not pay the fee — a real new user could not complete a bind in the
browser. That gap was previously closed by a funded off-chain "Sponsored-Bind Relay" that paid the fee.

That relay is **removed**. Making the bind feeless (a bare unsigned extrinsic, verified at pool admission)
closes the funding gap *directly*: there is no fee, so there is nothing to sponsor and no funded service
to run, custody a key for, or rate-limit. The browser submits the bind itself
(`app/src/lib/chain/identity.ts → submitLinkIdentityFeeless` / `submitLinkStakeFeeless`, via PAPI
`tx.getBareTx()` + the low-level `client.submit`). This also *strengthens* the trust story: the relay was
a liveness party that could censor and whose funds an attacker could drain (bounded only by per-IP
limits); a feeless self-submitted bind has neither weakness.

## Live proof (`app/scripts/d1-acceptance.mjs`)

Against a fresh `--dev` spec-116 node, a real headless-MeshJS wallet signed the pinned payload over the
live genesis; the proof was submitted as a **bare (unsigned) extrinsic** — no submitter, no fee, no relay.
**ALL PASSED:**

- the bound account `//CognoGateA` starts at **zero balance** and stays there — `Δbalance = 0` after both
  binds (no fee path exists, so no `InvalidTransaction::Payment`);
- `IdentityLinked.who == //CognoGateA` (the proof's account — there is no submitter to retarget it);
- `AccountOf[identity] == //CognoGateA` and `PkhOf[account] == identity` (1:1 both ways);
- the bound account posted **feelessly** (`PostCreated`);
- the **stake** (voting-power) bind `link_stake_signed` likewise bound feelessly (`StakeLinked`,
  `StakeCredOf[account]` = the proven credential), again `Δbalance = 0`;
- `revoke` → `Tombstoned[identity]` set, `AccountOf` cleared;
- **replaying the identical proof was refused AT THE POOL** (`Invalid: Stale`) — the eternally-valid proof
  cannot resurrect a banned identity, and is rejected *before* inclusion, not only at dispatch;
- a **junk proof** is refused at the pool (`Invalid: BadProof`) — the spam gate, live.

## ⚠ MAINNET PREREQUISITE — independent verifier audit

The verifier is the **anti-Sybil crown jewel**: a bug forges *any* identity (Wormhole-class — Wormhole's
$325M loss was a signature-verifier bug, not a quorum break, `L2-follower.md` §7.2). It is hardened by a
4-agent adversarial threat-model + unit/cross-impl tests, but it has **NOT had a formal external audit**.
This ships **enabled on testnet** as an honestly-labelled proof-of-concept; an independent audit of
`cip8.rs` is required before mainnet / real value. Do not weaken any check in `cip8.rs`.

## Out of scope / not done

- **External audit** of the verifier (the prerequisite above).
- **Committed nonce.** The payload nonce is now **format-checked only** — replay is prevented by the 1:1
  maps + the permanent tombstone, not by a server nonce cache (the follower's nonce cache is removed).
- **Ariadne / SPO-graduation** for the *weight* path is separate (see `L3-SPO-graduation.md`); identity
  binding needs no Cardano observation at all (it is a pure signature — no db-sync/Ogmios).
- **Trust-ladder / merge note:** the **in-protocol weight observation** branch (PR #10) also targeted
  spec 108 and merged to `main` first. This branch merged second, so the combined runtime (the trustless
  gate **and** the `cardanoObserver` pallet @16) bumped to **spec 109** and the PAPI descriptors were
  regenerated against it. The observer's `obs-shadow-demo.mjs` used to bind the live vault beacon via the
  old `link_identity`/sudo — which D1 removed — so it now **requires the beacon to be pre-bound** via the
  trustless self-proof (`link_identity_signed`); it no longer binds (there is no operator/sudo bind).
