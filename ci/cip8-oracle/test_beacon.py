#!/usr/bin/env python3
"""Lock the contract-vs-follower beacon-name agreement: the follower's beacon_name() must equal the Aiken
contract's util.beacon_name byte-for-byte. The contract's `beacon_name_matches_follower`
test asserts the SAME hex for the SAME owner (vkey a1*28 payment + vkey b2*28 stake)."""
from pycardano import Address, Network
from pycardano.hash import VerificationKeyHash, ScriptHash

import beacon
from beacon import beacon_name_hex

# The value locked in contracts/validators/talk_vault.ak :: beacon_name_matches_follower.
LOCKED = "6e2f65e9160dfbef407bfd9bce3a0aa733e12b562a856327acc3092060e0ca50"


def main():
    ok = 0
    base = Address(
        VerificationKeyHash(bytes.fromhex("a1" * 28)),
        VerificationKeyHash(bytes.fromhex("b2" * 28)),
        network=Network.TESTNET,
    )
    got = beacon_name_hex(base)
    assert got == LOCKED, f"MISMATCH: follower={got} aiken={LOCKED}"
    print(f"  ✓ base-address beacon_name == Aiken contract == {LOCKED}")
    ok += 1

    # Network-independence (the Plutus-Data form carries no network byte): mainnet gives the SAME.
    base_main = Address(
        VerificationKeyHash(bytes.fromhex("a1" * 28)),
        VerificationKeyHash(bytes.fromhex("b2" * 28)),
        network=Network.MAINNET,
    )
    assert beacon_name_hex(base_main) == LOCKED
    print("  ✓ network-independent (mainnet owner → same beacon name)")
    ok += 1

    # Enterprise (no stake) + script-stake variants compute without crashing (Some/None + vkey/script).
    ent = Address(VerificationKeyHash(bytes.fromhex("a1" * 28)), network=Network.TESTNET)
    scr = Address(
        VerificationKeyHash(bytes.fromhex("a1" * 28)),
        ScriptHash(bytes.fromhex("cc" * 28)),
        network=Network.TESTNET,
    )
    assert len(beacon_name_hex(ent)) == 64 and beacon_name_hex(ent) != LOCKED
    assert len(beacon_name_hex(scr)) == 64 and beacon_name_hex(scr) != LOCKED
    print(f"  ✓ enterprise (no stake) beacon: {beacon_name_hex(ent)[:16]}…")
    print(f"  ✓ script-stake beacon:          {beacon_name_hex(scr)[:16]}…")
    ok += 2

    # Unsupported credential type → ValueError (beacon.py:38). NEVER reached by a normal Address, so
    # drive it directly: an off-chain Address subtype the contract's owner type can't represent must
    # be REJECTED, not silently hashed into a bogus identity.
    try:
        beacon._credential(object())
        assert False, "unsupported payment credential type was NOT rejected"
    except ValueError as e:
        assert "unsupported payment/stake credential" in str(e), f"wrong error: {e}"
    print("  ✓ unsupported credential type → ValueError (rejected, not coerced)")
    ok += 1

    # Same guard fires for a bad STAKE credential reached through the full beacon_name_hex path
    # (Some(Inline(credential)) → _credential), proving the rejection isn't payment-part-only.
    bad_stake = Address(
        VerificationKeyHash(bytes.fromhex("a1" * 28)),
        VerificationKeyHash(bytes.fromhex("b2" * 28)),
        network=Network.TESTNET,
    )
    object.__setattr__(bad_stake, "_staking_part", 12345)  # an int is neither vkey/script/pointer
    try:
        beacon_name_hex(bad_stake)
        assert False, "unsupported STAKE credential type was NOT rejected"
    except ValueError as e:
        assert "unsupported payment/stake credential" in str(e), f"wrong error: {e}"
    print("  ✓ unsupported stake credential type → ValueError (via beacon_name_hex)")
    ok += 1

    print(f"\n== beacon agreement: {ok} checks passed ==")


if __name__ == "__main__":
    main()
