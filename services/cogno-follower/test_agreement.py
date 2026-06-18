#!/usr/bin/env python3
"""Cogno-Follower verification tests — the two-sided byte agreement (DONE-WHEN #3) + the negative
tests (the wrong-address release gate, L2-follower.md §12). Generates REAL CIP-8 signatures with a
headless MeshJS wallet (app/scripts/m2-cip8-fixture.mjs) and runs them through the actual
verify.py path, so this proves the frontend's signData and the follower's pycardano verify agree
on the exact bytes — and that a bad proof is rejected.

Run with the cogno_v3 venv python (pinned pycardano 0.13.0):
  cd services/cogno-follower && ../../<venv>/bin/python test_agreement.py
"""
import json
import os
import subprocess

import payload as payload_mod
from verify import verify_bind, VerifyError, identity_hash_hex
from beacon import beacon_name_hex
from pycardano.address import Address
from pycardano.network import Network

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.environ.get("APP_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "app")))
NODE_BIN = os.environ.get("NODE_BIN", "node")
FIXTURE = os.path.join(APP_DIR, "scripts", "m2-cip8-fixture.mjs")

PASS = 0
FAIL = 0


def ok(cond, msg):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {msg}")
    else:
        FAIL += 1
        print(f"  ✗ FAIL: {msg}")


def gen_fixture(*args) -> dict:
    out = subprocess.run([NODE_BIN, FIXTURE, *args], cwd=APP_DIR, capture_output=True, text=True, timeout=90)
    line = [ln for ln in out.stdout.strip().splitlines() if ln.strip().startswith("{")]
    if not line:
        raise RuntimeError(f"fixture failed: {out.stderr[-400:]}")
    return json.loads(line[-1])


def accepting_nonce(expected_nonce):
    def consume(account_hex, nonce_hex):
        if nonce_hex != expected_nonce:
            raise VerifyError("nonce mismatch")
    return consume


def main():
    GENESIS = "27af38570ab072a2a78232fdf46ac5e957eaa4c44a5c92d06b564558bfb2ed16"

    print("\n== Cogno-Follower verify — agreement + negative tests ==")

    print("\n[payload] build/parse round-trip")
    p = payload_mod.build(GENESIS, "11" * 32, "ab" * 16)
    f = payload_mod.parse(p)
    ok(f["genesis"] == GENESIS and f["account"] == "11" * 32 and f["nonce"] == "ab" * 16, "build→parse round-trips")
    try:
        payload_mod.parse("not-a-cogno-payload"); ok(False, "malformed payload rejected")
    except ValueError:
        ok(True, "malformed payload rejected")

    print("\n[positive] a REAL MeshJS CIP-8 signature verifies + the identity hash agrees")
    fx = gen_fixture("//CognoGateA", "cd" * 16)  # nonce cd*16
    idh = verify_bind(
        data_signature={"signature": fx["signature"], "key": fx["key"]},
        claimed_address=fx["signing_address"],
        sr25519_pubkey_hex=fx["accountHex"],
        expected_genesis=GENESIS,
        consume_nonce=accepting_nonce("cd" * 16),
    )
    # The identity hash is the L1 beacon name = blake2b_256(cbor.serialise(owner Address)) — the
    # Plutus-Data CBOR (DR-01), NOT the raw CIP-19 bytes. test_beacon.py locks it to the Aiken value.
    addr = Address.decode(fx["signing_address"])
    expected = beacon_name_hex(addr)
    ok(idh == expected, f"verify_bind returns the L1 beacon-name identity hash ({idh[:16]}…)")
    ok(identity_hash_hex(addr) == expected, "identity hash == the L1 beacon name (DR-01)")

    print("\n[negative] tampered / wrong proofs are REJECTED")

    def rejects(desc, **kw):
        try:
            verify_bind(**kw); ok(False, f"{desc} (should have raised)")
        except (VerifyError, ValueError) as e:
            ok(True, f"{desc} → rejected: {str(e)[:60]}")

    base = dict(
        data_signature={"signature": fx["signature"], "key": fx["key"]},
        claimed_address=fx["signing_address"],
        sr25519_pubkey_hex=fx["accountHex"],
        expected_genesis=GENESIS,
        consume_nonce=accepting_nonce("cd" * 16),
    )
    # wrong genesis (cross-chain replay)
    rejects("wrong genesis", **{**base, "expected_genesis": "00" * 32})
    # wrong submitted account (committed account != posted account)
    rejects("account substitution", **{**base, "sr25519_pubkey_hex": "99" * 32})
    # bad nonce (replay / not issued)
    rejects("invalid nonce", **{**base, "consume_nonce": accepting_nonce("ff" * 16)})
    # tampered signature bytes
    bad_sig = fx["signature"][:-2] + ("00" if fx["signature"][-2:] != "00" else "11")
    rejects("tampered signature", **{**base, "data_signature": {"signature": bad_sig, "key": fx["key"]}})
    # wrong network: a (testnet) preprod proof presented to a follower configured for mainnet (follower-5)
    rejects("wrong network (testnet proof, mainnet follower)", **{**base, "expected_network": Network.MAINNET})

    # wrong-address: sign with wallet A but CLAIM a different address (the release-gate negative test)
    print("\n[negative] wrong-address gate (claimed address != signing address)")
    wx = gen_fixture("//CognoGateA", "ee" * 16, "--wrong-claim")
    rejects("claimed address != recovered", **{
        "data_signature": {"signature": wx["signature"], "key": wx["key"]},
        "claimed_address": wx["signing_address"],  # a DIFFERENT address than was signed
        "sr25519_pubkey_hex": wx["accountHex"],
        "expected_genesis": GENESIS,
        "consume_nonce": accepting_nonce("ee" * 16),
    })

    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==\n")
    raise SystemExit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
