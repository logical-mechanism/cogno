# On-chain CIP-8 identity self-proof

Cogno-chain has no accounts of its own to trust. Instead, a user proves — cryptographically, on-chain —
that they control a Cardano wallet, and that proof binds that wallet to an app-chain posting account. No
trusted off-chain service verifies the proof and no operator writes the binding: the runtime itself
checks the signature on every full node.

The mechanism lives in `pallet_cogno_gate` and its verifier `pallet_cogno_gate::cip8`
(`pallets/cogno-gate/src/cip8.rs`). The system overview is [`ARCHITECTURE.md`](ARCHITECTURE.md).

## What it binds

A bind is a **1:1 link between one Cardano owner Address and one app-chain posting account**, enforced in
both directions:

- one Cardano address can bind at most one account (`PkhOf`), and
- one account can bind at most one Cardano address (`AccountOf`).

The link is proven with **CIP-8 / COSE_Sign1**: the user's Cardano wallet signs a pinned payload, and the
runtime verifies that signature. The identity key is
`identity = blake2b_256(plutus_data_cbor(owner Address))` — the same value used as the L1 `talk_vault`
beacon `token_name`, reproduced byte-for-byte so a bind matches an observed vault.

The **account the proof commits to is the one that gets bound** — the payload names it, and there is no
separate submitter who could retarget it. So no one can bind a victim's key, and front-running a valid
proof merely completes the bind the signer already authorized.

## The bind is feeless and unsigned

The bind extrinsic `link_identity_signed` (`call_index(2)`) is submitted as a **bare, unsigned**
extrinsic:

```
link_identity_signed(origin: None,
                     cose_sign1: BoundedVec<u8, 512>,
                     cose_key:   BoundedVec<u8, 128>,
                     thread:     Option<Vec<u8>>)
```

The **CIP-8 proof is the authorization** — there is no fee payer, no nonce, and no signing account. That
is what lets a brand-new, zero-balance account complete its first on-chain action with no funded sponsor:
the browser derives a posting key from the wallet signature, then submits the bind itself
(`app/src/lib/chain/identity.ts`).

The proof is verified **twice**, with the same verifier both times:

1. **At pool admission** — `#[pallet::validate_unsigned]` runs on every full node when the extrinsic is
   gossiped. It runs `cip8::verify_bind_proof`, checks the committed genesis matches this chain, and
   mirrors the state rejections: a tombstoned or already-bound side is rejected `Stale`, a bad or
   cross-chain proof is rejected `BadProof`. A `provides` tag (the identity hash) lets the pool dedupe
   repeats. This is the whole spam gate now that there is no fee.
2. **At block inclusion / dispatch** — `ensure_none(origin)` then re-runs the verifier authoritatively to
   derive `{ account, identity }` and calls `do_bind`, which enforces the 1:1 invariant on both maps,
   writes `PkhOf` + `AccountOf`, primes the microblog capacity row via `OnBind::on_bind`, and emits
   `IdentityLinked`. Because `validate_unsigned` also runs at inclusion (via `pre_dispatch`), an importing
   node re-checks and rejects any block carrying a junk bind.

## The verifier — the anti-Sybil crown jewel

`cip8::verify_bind_proof` is a pure, total, `no_std` function over byte slices. What it proves:

1. The Ed25519 signature is valid over the COSE `Sig_structure` (`sp_io::crypto::ed25519_verify`).
2. The verifying key (the COSE_Key `-2` field) hashes (blake2b-224) to the address's payment credential —
   the signer controls the address.
3. The address is a VerificationKey-payment base/enterprise address on the configured network (rejecting
   script-payment, pointer, stake-only, Byron, and wrong-network addresses).
4. `identity = blake2b_256(plutus_data_cbor(owner Address))`, reproduced byte-exact.
5. The signed payload is exactly `cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>`.

### Security invariants

Each of these is load-bearing:

- **Single key source.** The verification key is the COSE_Key `-2` field only — the same 32 bytes are both
  ed25519-verified and blake2b-224-hashed for the address bind. A KID in the protected header, if present,
  must equal it byte-for-byte. (Closes the "verify one key, hash another" forge.)
- **Verbatim `Sig_structure`.** The protected header and payload are spliced in as the exact wire bytes the
  wallet signed, never re-encoded; the address is parsed out of those same bytes in place. (Closes the COSE
  parser-differential.)
- **Strict canonical CBOR.** Definite lengths, minimal encodings, no indefinite forms, no duplicate map
  keys, no trailing bytes. Every reader is total — checked access, no panics (the wasm runtime builds with
  overflow checks off, so a panic on attacker input would halt block import).
- **Reject `hashed:true`, detached payloads, non-empty external_aad** (external_aad is hard-coded `h''`).
- **32-byte keys only** — reject 64-byte extended keys.
- **Network pin** (`CardanoNetwork`, testnet = 0). The beacon-name identity carries no network byte, so
  without this a mainnet and a testnet address with the same credentials would collide.
- **Determinism.** Substrate's `ed25519_verify` is `ed25519-zebra`; the off-chain reference is libsodium.
  Both reject the same borderline signatures for a 1:1 binding — do not register `UseDalekExt`, which would
  change the semantics and could split honest re-verifiers.

### Cross-implementation agreement

The identity derivation is implemented three independent ways that must agree:

- the on-chain Rust verifier (`cip8.rs`), with locked cross-impl vectors, a real `MeshWallet.signData`
  fixture, and adversarial negatives in `pallets/cogno-gate/src/cip8/tests.rs`;
- an off-chain Python reference (`ci/cip8-oracle/`), run in CI by `test_agreement.py` against real MeshJS
  fixtures — kept only as this agreement oracle, it writes nothing and serves nothing;
- the frontend, via `@meshsdk/core-cst`.

## The stake bind unlocks voting power

`link_stake_signed` (`call_index(3)`) is the same shape — feeless, unsigned, verified at the pool — but
proves the wallet's **stake key** over its reward address instead of the payment key, binding the account
to a 28-byte stake credential (1:1). This is the anchor for **stake-weighted voting power**: a whale's
stake cannot be claimed by anyone who does not hold its stake key. It is optional (an account can post
without it) and must follow the identity bind — `validate_unsigned` requires the account to already be
payment-bound.

## Revocation is a permanent tombstone

`revoke` (`call_index(1)`) is the one privileged call here — it is gated by `FollowerOrigin` (the
committee's moderation ban). It removes both maps and inserts the identity into `Tombstoned`. `do_bind`
refuses a tombstoned identity, so an eternally-valid CIP-8 proof replayed after a ban can never resurrect
the binding.

## DoS posture

With no fee, the compute-DoS defence moves entirely to pool admission. Oversized blobs fail for free at
SCALE decode (the `BoundedVec` call args) and malformed COSE fails the verifier's pre-`ed25519` parse, so
only a well-formed proof reaches the signature check. A well-formed junk/wrong-genesis/already-bound proof
costs one `ed25519` verify (~68 µs) but is rejected at the pool before gossip or inclusion; the `provides`
tag dedupes repeats and `CheckWeight` bounds the aggregate at inclusion.

Crucially, a bind grants **nothing actionable** on its own: posting capacity comes from the observed
locked-ADA vault and voting power from the observed Cardano stake, both requiring real on-chain Cardano
value. A flood of valid binds of fresh, empty addresses buys zero weight; its only effect is storage
growth, rate-bounded per block. Per-IP rate-limiting lives at the RPC ingress, protecting all feeless
calls.

This is a single-operator preprod testnet (spec_version 203, transaction_version 3, genesis
`0x73eaa4bf`): usable, honestly labelled, not yet trustless. A mainnet deployment would re-introduce an
anti-bloat cost — a refundable deposit or a PoW stamp — as a documented `MAINNET PREREQUISITE`.

Proven live by `app/scripts/d1-acceptance.mjs`: a zero-balance account completes both the identity and the
stake bind as bare unsigned extrinsics (Δbalance = 0), posts feelessly, and a replayed proof is refused at
the pool (`Invalid: Stale`) by the tombstone while a junk proof is refused as `Invalid: BadProof`.

## MAINNET PREREQUISITE — independent verifier audit

The verifier is the anti-Sybil crown jewel: a bug in it forges *any* identity. A signature-verifier bug is
catastrophic — that class of flaw has cost other protocols hundreds of millions — which is why `cip8.rs` is
the single most sensitive attack surface in the codebase. It is hardened by an adversarial threat-model and
extensive unit/cross-impl tests, but it has **not had a formal external audit**. It ships enabled on the
testnet as a proof of concept; an independent audit is required before mainnet or real value. Do not weaken
any check in `cip8.rs`.

## Out of scope

- **The external audit** above.
- **A committed nonce.** The payload nonce is format-checked only; replay is prevented by the 1:1 maps plus
  the permanent tombstone, not by a server-side nonce cache.
- **Cardano observation.** Identity binding is a pure signature check — it needs no db-sync or Ogmios. The
  weight path (locked ADA, stake) is observed separately; see
  [`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md). The observer credits weight only to a vault
  whose owner has already pre-bound via this self-proof; there is no operator bind path.
