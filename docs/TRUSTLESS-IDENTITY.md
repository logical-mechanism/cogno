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
link_identity_signed(origin:     None,
                     cose_sign1: BoundedVec<u8, 512>,
                     cose_key:   BoundedVec<u8, 128>)
```

(Until spec 211 the call carried a third `thread_pointer: Option<Vec<u8>>` argument — a cogno_v3
forum pointer that was never committed by the signed payload, so any submitter of a valid proof
could attach an arbitrary value. It had no readers and was removed together with its `ThreadOf`
storage; the removal moved `transaction_version` 6 → 7.)

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

## The posting key is derived from the wallet, and the derivation is normative

The account that signs a post is not stored anywhere. It is a pure function of a signature the
Cardano wallet produces over one fixed message, so a user re-derives it by signing again and there is
no key to back up, export or lose.

That makes an account portable between clients for free — someone who onboarded on cogno.forum
arrives at any other client as the same account — but only if every client derives **identically**.
A client that gets any step wrong mints a different account, and since the identity bind is 1:1 and
`revoke` writes a permanent tombstone, a wrong derivation is not something the user can undo.

So this is a specification, not an implementation note. The reference implementation is
`app/src/lib/signer/wallet-derive.ts`.

1. Take the wallet's **change address** (CIP-30 `getChangeAddress()`), bech32. Not the reward
   address, and not the first used address.
2. Reject the wallet if the address's payment credential is **not a verification key** (type `0`). A
   script or vault credential has no key to sign with, so there is nothing to derive from.
3. Have the wallet CIP-8-sign this **exact string**, with that same address as the signing address:

   ```
   cogno-chain · derive my posting key (v1). Signing this unlocks your posting identity on this device; the signature never leaves it. Do NOT sign this exact message in any other app.
   ```

   The `·` is U+00B7 MIDDLE DOT and the string is UTF-8. There is no nonce, no genesis hash and no
   chain id in it, deliberately: the key must be stable across sessions and across chains, and the
   per-chain anti-replay lives in the bind payloads above, not here.

4. Take the **`signature` field** of the CIP-30 `DataSignature` — the COSE_Sign1 bytes, hex — and
   decode it to bytes. Not the `key` field, and not the bare 64-byte Ed25519 signature inside it.
5. `seed = blake2b(signature_bytes, 32)` — blake2b with a 32-byte digest, unkeyed.
6. `keypair = sr25519_derive(seed, path = "")` — an **empty** derivation path (a soft/hard junction
   would give a different key).
7. The account is that keypair's public key at **SS58 prefix 42**.

The wallet's Ed25519 signature is deterministic (RFC 8032), so the whole chain is deterministic: the
same wallet and message always give the same account.

### Test vectors

Steps 4 to 7 are a pure transform over bytes, so an implementation can check itself against these
without a Cardano wallet, a network or any Cardano tooling. The inputs are fixed stand-in signature
bytes, not a real wallet's output — only the transform is under test.

| signature bytes (hex) | resulting account |
|---|---|
| `aa` × 32 | `5CDrV6ENfvCvLfaxzmuEs7bj1GUsGbJLhVH4WHUYm7ta8MUU` |
| `bb` × 32 | `5HK93uxFLmK3o6ZT6DuZVBbqHcTAxpGGuBgYunH1WFiDEZA2` |

For the first, in full:

```
signature   aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
seed        0x046c0d987075db8217087bae19e9f753305890fc6772908c57f07878211cc8cb
public key  0x06fa40c2f135f8f8d0603152246ce2c0b251f466a1ba02cf79c710dfce0cd471
account     5CDrV6ENfvCvLfaxzmuEs7bj1GUsGbJLhVH4WHUYm7ta8MUU
```

These are the same vectors `app/src/lib/signer/derive-golden.test.ts` enforces in CI, deliberately —
one set of numbers, checked by a test, rather than a second set in prose that can drift away from the
code. That test also pins the well-known `//Alice`, `//Bob` and `//Charlie` dev accounts, which are
fixed by the wider Substrate ecosystem rather than by us: if those move, the sr25519 implementation
underneath has changed and every existing user has been re-keyed. That is a dependency bump to
reject, not a test to update.

### What the derived key is and is not

It signs **posts only**. It never controls funds: the ADA stays in the Cardano wallet, which is not
derived from anything. So a phished derive-signature costs impersonation, never theft.

It also **cannot be rotated**. There is no nonce, so re-deriving returns the same key, and `revoke`
is committee-only and permanent. A leaked signature is unfixable impersonation, and the warning in
the message text — which the wallet displays — is the entire mitigation. That is a real, accepted
weakness, and it is the reason the message says what it says.

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

This is a single-operator preprod testnet (spec_version 204, transaction_version 3, genesis
`0x73eaa4bf`): usable, honestly labelled, not yet trustless. A mainnet deployment would re-introduce an
anti-bloat cost — a refundable deposit or a PoW stamp — as a documented `MAINNET PREREQUISITE`.

Proven live on preprod: a zero-balance account completes both the identity and the stake bind as bare
unsigned extrinsics (Δbalance = 0), posts feelessly, and a replayed proof is refused at the pool
(`Invalid: Stale`) by the tombstone while a junk proof is refused as `Invalid: BadProof`. (The driver that
demonstrated this, `app/scripts/d1-acceptance.mjs`, has been removed — it grants weight through
`Sudo.sudo(TalkStake.set_stake(...))`, and neither the Sudo pallet nor that call exists any more.)

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
