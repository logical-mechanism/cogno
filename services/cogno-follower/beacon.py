"""The beacon name / identity hash — the L1↔L2↔L3↔L5 join key (DR-01).

The on-chain L1 `talk_vault` contract names each beacon `blake2b_256(cbor.serialise(owner Address))`
where `cbor.serialise` is the Plutus-Data CBOR of the Aiken `Address` type — Constr 0 (tag 121) with
INDEFINITE-length arrays, and (load-bearing) NO network byte (the Aiken `Address` carries only the
payment + stake credentials, not the network). So the L3 identity hash MUST be computed the same way
— NOT from the raw CIP-19 address bytes.

This module reproduces that serialization byte-for-byte in pycardano. Proven identical to the Aiken
contract's `util.beacon_name` (test_beacon.py asserts the same locked value the contract's
`beacon_name_matches_follower` test asserts).

Plutus-Data shape (Plutus ledger / Aiken):
  Address    = Constr 0 [ payment_credential, Option<Referenced<Credential>> ]
  Credential = VerificationKey(h) -> Constr 0 [h] ;  Script(h) -> Constr 1 [h]
  Option     = Some(x) -> Constr 0 [x]            ;  None      -> Constr 1 []
  Referenced = Inline(c) -> Constr 0 [c]          ;  Pointer{..} -> Constr 1 [slot, txidx, certidx]
"""
import hashlib

from cbor2 import CBORTag
from pycardano import RawPlutusData
from pycardano.address import Address, PointerAddress
from pycardano.hash import ScriptHash, VerificationKeyHash
from pycardano.serialization import IndefiniteList


def _constr(ix: int, fields: list) -> CBORTag:
    # Plutus constr: tag 121+ix for ix in 0..6, fields as an INDEFINITE-length array.
    return CBORTag(121 + ix, IndefiniteList(fields))


def _credential(part) -> CBORTag:
    if isinstance(part, VerificationKeyHash):
        return _constr(0, [part.payload])
    if isinstance(part, ScriptHash):
        return _constr(1, [part.payload])
    raise ValueError(f"unsupported payment/stake credential: {type(part).__name__}")


def _stake(part) -> CBORTag:
    if part is None:
        return _constr(1, [])  # Nothing (enterprise address)
    if isinstance(part, PointerAddress):
        # Some(Pointer{slot, tx_index, cert_index}) — exotic; v1 owner addresses are base/enterprise.
        ptr = _constr(1, [part.slot, part.tx_index, part.cert_index])
        return _constr(0, [ptr])
    # Some(Inline(credential)) — the base-address case.
    return _constr(0, [_constr(0, [_credential(part)])])


def address_plutus_cbor(addr: Address) -> bytes:
    """The exact bytes `aiken/cbor.serialise(owner)` produces for this Address."""
    data = _constr(0, [_credential(addr.payment_part), _stake(addr.staking_part)])
    return RawPlutusData(data).to_cbor()


def beacon_name(addr: Address) -> bytes:
    """The 32-byte beacon `token_name` / L3 identity hash for `addr` (DR-01)."""
    return hashlib.blake2b(address_plutus_cbor(addr), digest_size=32).digest()


def beacon_name_hex(addr: Address) -> str:
    return beacon_name(addr).hex()
