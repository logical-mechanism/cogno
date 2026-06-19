# Trustless identity (D1) — on-chain CIP-8 self-proof

**Status: DONE (spec_version 108), proven live on a `--dev` node.** This is the D1 rung of the identity
trust ladder from [`L2-follower.md`](L2-follower.md) §7.2/§7.3: the trusted off-chain identity binding is
**replaced** by an on-chain cryptographic self-proof. It is **validator-independent** — it *removes* a
trusted party (the follower's bind-write key) without adding one.

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

## The on-chain flow (`pallet_cogno_gate`)

```
link_identity_signed(origin: Signed, cose_sign1: BoundedVec<u8,512>, cose_key: BoundedVec<u8,128>,
                     thread: Option<Vec<u8>>)
```

1. `ensure_signed(origin)` — the submitter is the **fee payer** (the DoS defence; the call is **NOT**
   feeless). The submitter is *not* the bound account.
2. `cip8::verify_bind_proof(cose_sign1, cose_key, CardanoNetwork)` — verify the wallet signature and
   reconstruct `{ identity, account, genesis }` (see below). A reject maps to `Error::ProofInvalid`.
3. **Genesis check** — the proof's committed `genesis` must equal `frame_system::BlockHash[0]`
   (anti-cross-chain replay), else `Error::WrongGenesis`.
4. **Bind** — `do_bind(account, identity, thread)`: refuse a tombstoned identity
   (`Error::IdentityTombstoned`); enforce the 1:1 invariant on **both** maps (`AccountAlreadyBound` /
   `PkhAlreadyBound`); write `PkhOf` + `AccountOf` (+ `ThreadOf`); prime the microblog capacity row +
   provider ref via `OnBind::on_bind`; emit `IdentityLinked`.

The **bound account is the one the proof cryptographically commits** — the submitter cannot retarget it.
Front-running a valid proof merely completes the intended bind.

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

## Weight / DoS posture

`link_identity_signed` is **not feeless** — the signed submitter pays, so a junk-proof spammer pays. The
FRAME-benchmarked weight is **≈ 67.85 µs / 6 reads / 5 writes** (the `ed25519_verify` + 2× blake2 + the
bounded CBOR/address/payload parse, on top of `do_bind`). On a testnet showcase the user's derived posting
account must hold a small balance to pay this fee (a faucet concern); the bound account == the submitter
in the frontend flow, but a third party *may* pay for someone else's bind (the proof fixes the target).

## Live proof (`app/scripts/d1-acceptance.mjs`)

Against a fresh `--dev` spec-108 node, a real headless-MeshJS wallet signed the pinned payload over the
live genesis; `//Alice` submitted `link_identity_signed`. **ALL PASSED:**

- `IdentityLinked.who == //CognoGateA` (the proof's account, **not** the `//Alice` submitter);
- `AccountOf[identity] == //CognoGateA` and `PkhOf[account] == identity` (1:1 both ways);
- the bound account posted **feelessly** (`PostCreated`);
- `revoke` → `Tombstoned[identity]` set, `AccountOf` cleared;
- **replaying the identical proof was rejected with `IdentityTombstoned`** — the eternally-valid proof
  cannot resurrect a banned identity.

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
  binding needs no Cardano observation at all (it is a pure signature — no Kupo/Ogmios).
- The **in-protocol weight observation** branch (PR #10) also targets spec 108; whichever merges second
  bumps to 109, and its `obs-shadow-demo.mjs` (which binds via the old `link_identity`/sudo) must be moved
  to `link_identity_signed`.
