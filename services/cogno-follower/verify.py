"""The Cogno-Follower's CIP-8 verification — the trusted v1 binding check (L2-follower.md §7).

REUSES the proven `pycardano.cip.cip8.verify` path from cogno_v3 (verify_view.py) — it does NOT
re-implement COSE_Sign1. `verify()` returns {verified, message, signing_address}; its `verified`
flag already folds in the Ed25519 signature check AND that the COSE-header address hashes to the
signing key. On top of that the follower asserts the cogno-chain-specific binding invariants.

v1 trust posture (named honestly): the follower is the SOLE verifier and the sole writer — a
malicious/buggy follower could fabricate a binding. The committed payload (account + genesis +
nonce inside the signature) PREVENTS re-pointing an honest user's proof at another account; the
on-chain ed25519 self-proof (which would remove the follower from the trust path) is deferred D1.

M2 scope: WALLET-ONLY CIP-8 (DR-14). There is no observed Cardano vault yet, so "whole-Address ==
datum.owner" reduces to: the recovered signing Address IS the owner identity (its hash is what we
bind), and it must be a VerificationKey-payment, non-script address. The vault-datum cross-check
(recovered address == the observed vault's datum.owner) is the M2d seam — flagged below.
"""
import hashlib

from pycardano.address import Address
from pycardano.hash import VerificationKeyHash
from pycardano.cip.cip8 import verify as cip8_verify

import payload as payload_mod


class VerifyError(Exception):
    """A binding proof failed a check. The HTTP layer maps this to 400 with the reason."""


def identity_hash_hex(addr: Address) -> str:
    """DR-01 identity = blake2b_256 of the WHOLE serialized CIP-19 owner Address (== the L1 beacon
    token_name). `to_primitive()` is the raw address bytes — proven byte-identical to MeshJS
    `Address.toBytes()` in test_agreement.py, so L1/L3/L5 all key on the same 32 bytes."""
    return hashlib.blake2b(addr.to_primitive(), digest_size=32).hexdigest()


def verify_bind(
    *,
    data_signature: dict,        # the CIP-30 DataSignature {"signature": hex, "key": hex}
    claimed_address: str,        # the bech32 address the frontend says it signed with
    sr25519_pubkey_hex: str,     # the 32-byte posting account hex (POST body)
    expected_genesis: str,       # the follower's known L3 genesis hash (lowercase hex)
    consume_nonce,               # callable(account_hex, nonce_hex) -> None; raises VerifyError if invalid
) -> str:
    """Verify a CIP-8 bind proof. Returns the 32-byte identity hash (hex) to bind, or raises
    VerifyError. The order matters: cheap structural checks first, nonce consumed LAST (only a
    fully-valid proof burns the nonce)."""
    # (0) The COSE_Sign1 signature itself — reuse the proven pycardano path.
    try:
        res = cip8_verify(data_signature)
    except Exception as e:  # malformed cbor/hex, bad vk, etc.
        raise VerifyError(f"CIP-8 verify raised: {e}")
    if res.get("verified") is not True:
        raise VerifyError("CIP-8 signature did not verify")

    addr: Address = res["signing_address"]

    # (1) The recovered signing address must equal the address the client claims (cogno_v3
    #     verify_view.py:57) — catches a client that lies about which address it used.
    if addr.encode() != claimed_address:
        raise VerifyError("recovered signing address != claimed signing_address")

    # (2) v1: the payment credential must be a VerificationKey (DR-01) — this STRUCTURALLY rejects
    #     any script-payment address, including the L1 vault (type-1) address one must never sign
    #     from. (L2-follower.md §7.4 — the wrong-address gotcha, structurally closed.)
    if not isinstance(addr.payment_part, VerificationKeyHash):
        raise VerifyError("payment credential is not a verification key (script/vault address rejected)")

    # (3) The committed payload must match the pinned format and commit the right things.
    fields = payload_mod.parse(res["message"])  # raises ValueError → caught by the HTTP layer

    # (4) genesis — anti-cross-chain: a proof signed for another chain's genesis is rejected.
    if fields["genesis"] != expected_genesis:
        raise VerifyError("committed genesis != this chain's genesis (wrong chain / replay)")

    # (5) The committed account must equal the submitted posting key — this is what PREVENTS the
    #     operator re-pointing the bind at a different L3 account (DR-02).
    if fields["account"].lower() != sr25519_pubkey_hex.lower():
        raise VerifyError("committed account != submitted sr25519 pubkey")

    # (6) nonce — anti-replay, consumed single-use. LAST, so a rejected proof doesn't burn it.
    consume_nonce(sr25519_pubkey_hex.lower(), fields["nonce"])

    # ── M2d SEAM: here is where the follower will additionally assert that this recovered Address
    #    matches the `datum.owner` of an OBSERVED on-chain talk_vault UTxO (Kupo/Ogmios) before
    #    granting weight. In M2 (wallet-only CIP-8, DR-14) there is no vault yet — the address is
    #    self-asserted; the committed payload + the 1:1 on-chain anchor are the v1 defenses. ──

    return identity_hash_hex(addr)
