"""The CIP-8 bind verification — the INDEPENDENT REFERENCE verifier (a CI-only adversarial oracle).

⚠ This is NOT on any production write path. Identity binding is the permissionless on-chain self-proof
`cognoGate.link_identity_signed`, where the RUNTIME verifies the CIP-8 signature itself
(`pallet_cogno_gate::cip8`). This module is KEPT as a second, independent implementation of the same
checks, run in CI (`test_agreement.py`) against real MeshJS fixtures + adversarial negatives — a
cross-impl agreement oracle for the unaudited on-chain crown-jewel verifier. Nothing here reads or
writes the chain; it is a pure verifier over the proof bytes.

REUSES the proven `pycardano.cip.cip8.verify` path from cogno_v3 (verify_view.py) — it does NOT
re-implement COSE_Sign1. `verify()` returns {verified, message, signing_address}; its `verified`
flag already folds in the Ed25519 signature check AND that the COSE-header address hashes to the
signing key. On top of that this asserts the cogno-chain-specific binding invariants — the SAME ones
the on-chain verifier enforces, so the two implementations must agree (a disagreement is a bug).

Scope: WALLET-ONLY CIP-8. This oracle verifies the signature and the identity hash only — it does
not observe the Cardano vault, so "whole-Address ==
datum.owner" reduces to: the recovered signing Address IS the owner identity (its hash is what we
bind), and it must be a VerificationKey-payment, non-script address. The vault-datum cross-check
(recovered address == the observed vault's datum.owner) is the M2d seam — flagged below.
"""
from pycardano.address import Address
from pycardano.hash import VerificationKeyHash
from pycardano.network import Network
from pycardano.cip.cip8 import verify as cip8_verify

import payload as payload_mod
from beacon import beacon_name_hex


class VerifyError(Exception):
    """A binding proof failed a check; the reason is in the exception message."""


def identity_hash_hex(addr: Address) -> str:
    """The identity = the L1 beacon token_name = blake2b_256(cbor.serialise(owner Address)) —
    the Plutus-Data CBOR of the credentials (NO network byte), NOT the raw CIP-19 address bytes.
    Proven byte-identical to the Aiken contract's util.beacon_name (test_beacon.py), so the contract,
    the chain and the client all
    key on the SAME 32 bytes — this is what lets the follower match a CIP-8 binding to an observed
    on-chain vault UTxO in M2d."""
    return beacon_name_hex(addr)


def verify_bind(
    *,
    data_signature: dict,        # the CIP-30 DataSignature {"signature": hex, "key": hex}
    claimed_address: str,        # the bech32 address the frontend says it signed with
    sr25519_pubkey_hex: str,     # the 32-byte posting account hex (POST body)
    expected_genesis: str,       # the follower's known cogno-chain genesis hash (lowercase hex)
    consume_nonce,               # callable(account_hex, nonce_hex) -> None; raises VerifyError if invalid
    expected_network: Network = Network.TESTNET,  # the Cardano network this follower binds for (follower-5)
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

    # (2) the payment credential must be a VerificationKey — this STRUCTURALLY rejects
    #     any script-payment address, including the L1 vault (type-1) address one must never sign
    #     from (the wrong-address gotcha, structurally closed).
    if not isinstance(addr.payment_part, VerificationKeyHash):
        raise VerifyError("payment credential is not a verification key (script/vault address rejected)")

    # (2.5) Network pin (follower-5): the beacon-name identity hash carries NO network byte, so a
    #       proof from the wrong network (mainnet address on a preprod follower, or vice-versa) would
    #       otherwise bind to the same 32 bytes. Reject any address not on this follower's network.
    if addr.network != expected_network:
        raise VerifyError(f"signing address network {addr.network} != follower network {expected_network}")

    # (3) The committed payload must match the pinned format and commit the right things.
    fields = payload_mod.parse(res["message"])  # raises ValueError → surfaced as a verification failure

    # (4) genesis — anti-cross-chain: a proof signed for another chain's genesis is rejected.
    if fields["genesis"] != expected_genesis:
        raise VerifyError("committed genesis != this chain's genesis (wrong chain / replay)")

    # (5) The committed account must equal the submitted posting key — this is what PREVENTS the
    #     operator re-pointing the bind at a different chain account.
    if fields["account"].lower() != sr25519_pubkey_hex.lower():
        raise VerifyError("committed account != submitted sr25519 pubkey")

    # (6) nonce — anti-replay, consumed single-use. LAST, so a rejected proof doesn't burn it.
    consume_nonce(sr25519_pubkey_hex.lower(), fields["nonce"])

    # ── M2d SEAM: here is where the follower will additionally assert that this recovered Address
    #    matches the `datum.owner` of an OBSERVED on-chain talk_vault UTxO (db-sync) before
    #    granting weight. This oracle is wallet-only CIP-8: it never reads a vault — the address is
    #    self-asserted; the committed payload + the 1:1 on-chain anchor are the v1 defenses. ──

    return identity_hash_hex(addr)
