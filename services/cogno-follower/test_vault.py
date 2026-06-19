#!/usr/bin/env python3
"""M2d vault→weight logic tests (fixture-driven; no synced node needed). Proves the parsing,
the LARGEST-WINS-per-identity / never-sum rule, the curve floor, and the set_stake plan."""
from vault import (parse_matches, weights_by_identity, weight_for_lock, plan_set_stakes,
                   cardano_reference_slot, observe_as_of, canonical_hex)

POLICY = "19bcec346695badd915551db1b9e7caf9d1af92a015fc5a446b69c13"
A = "6e2f65e9160dfbef407bfd9bce3a0aa733e12b562a856327acc3092060e0ca50"  # identity A's beacon
B = "9a8cdaa7df32352a" + "00" * 24  # identity B's beacon (synthetic)

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


def utxo(beacon_hex, coins, extra_assets=None):
    assets = {f"{POLICY}.{beacon_hex}": 1}
    if extra_assets:
        assets.update(extra_assets)
    return {"transaction_id": "tx", "output_index": 0, "value": {"coins": coins, "assets": assets}}


def main():
    print("\n== M2d vault→weight logic ==")

    # curve floor
    ok(weight_for_lock(100_000_000) == 100_000_000, "weight = locked lovelace at/above floor")
    ok(weight_for_lock(99_999_999) == 0, "below min_lock → weight 0 (defensive)")

    # parse: a clean single-beacon vault
    ms = [utxo(A, 150_000_000)]
    ok(parse_matches(ms, POLICY) == [(A, 150_000_000)], "parse a single-beacon vault UTxO")

    # parse ignores a UTxO carrying a foreign extra token under another policy (still 1 beacon ok)
    ms2 = [utxo(A, 150_000_000, {"deadbeef.cafe": 5})]
    ok(parse_matches(ms2, POLICY) == [(A, 150_000_000)], "extra foreign token doesn't break the parse")

    # multi-beacon under THE SAME policy: the on-chain mint guards 1-beacon-per-vault, but the
    # follower must NEVER trust that — a UTxO carrying 2 beacons under POLICY is dropped entirely
    # (not arbitrarily crediting one of them, which would let a crafted UTxO inject weight).
    multi = [{"value": {"coins": 500_000_000, "assets": {f"{POLICY}.{A}": 1, f"{POLICY}.{B}": 1}}}]
    ok(parse_matches(multi, POLICY) == [], "multi-beacon UTxO (2 beacons, same policy) → rejected")
    ok(weights_by_identity(multi, POLICY) == {}, "multi-beacon UTxO grants ZERO weight (never trusted)")

    # a beacon present but with quantity != 1 (NFT invariant broken) is also dropped.
    qty = [{"value": {"coins": 200_000_000, "assets": {f"{POLICY}.{A}": 2}}}]
    ok(parse_matches(qty, POLICY) == [], "beacon quantity != 1 → rejected (not a valid NFT vault)")

    # malformed / empty Kupo entries don't crash the parser (defensive against bad node JSON).
    ok(parse_matches([{}, {"value": {}}, {"value": {"assets": None}}], POLICY) == [],
       "empty / malformed UTxO entries are skipped, not fatal")

    # LARGEST-WINS, NEVER SUM: identity A has two vaults (200 + 350 ADA) → credit the larger only.
    dup = [utxo(A, 200_000_000), utxo(A, 350_000_000), utxo(B, 120_000_000)]
    w = weights_by_identity(dup, POLICY)
    ok(w[A] == 350_000_000, "largest-wins: A credited its biggest vault (350M), NOT the sum (550M)")
    ok(w[B] == 120_000_000, "B credited its single vault (120M)")
    ok(len(w) == 2, "two distinct identities")

    # plan_set_stakes: maps identities to bound accounts, skips the unbound.
    accounts = {A: "5GrwAccountA", B: None}  # B has a vault but isn't bound yet → skipped
    plan = plan_set_stakes(dup, POLICY, lambda b: accounts.get(b))
    ok(plan == [("5GrwAccountA", 350_000_000)], "plan: bound A gets weight 350M; unbound B skipped")

    # ── DETERMINISTIC as-of-reference observation (in-protocol-observation step 2 / D4) ─────────────
    print("\n-- as-of-reference deterministic observation --")

    def m_utxo(beacon, coins, created=0, spent=None, tx="tx", ix=0, extra=None):
        assets = {f"{POLICY}.{beacon}": 1}
        if extra:
            assets.update(extra)
        m = {"transaction_id": tx, "output_index": ix,
             "value": {"coins": coins, "assets": assets},
             "created_at": {"slot_no": created, "header_hash": "hh"}}
        m["spent_at"] = None if spent is None else {"slot_no": spent, "header_hash": "hh"}
        return m

    # cardano_reference_slot: fail-closed, checked arithmetic. Preprod anchor (NOT systemStart).
    PREPROD = dict(shelley_start_unix=1655769600, shelley_start_slot=86400, stability_slots=129600)
    ok(cardano_reference_slot(1655769600 + 200000, **PREPROD) == 86400 + 200000 - 129600,
       "preprod round-trip: ref = shelleySlot(t) − window")
    ok(cardano_reference_slot(1654041600, **PREPROD) is None,
       "pre-Shelley (Byron systemStart 1654041600) time ⇒ None (wrap-safe, fail closed)")
    ok(cardano_reference_slot(0, **PREPROD) is None, "epoch-0 time ⇒ None (never a giant slot)")
    ok(cardano_reference_slot(1655769600 + 100, **PREPROD) is None, "reference before the Shelley slot ⇒ None")

    REF = 1000
    # the as-of-ref window: spent AFTER ref still counted; spent at/before ref not; created after ref not.
    ok(observe_as_of([m_utxo(A, 250_000_000, created=10)], POLICY, REF).get(A) == 250_000_000,
       "buried-before-ref unspent vault credited at its lovelace")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=10, spent=1500)], POLICY, REF).get(A) == 200_000_000,
       "spent AFTER the reference ⇒ still locked-as-of-ref ⇒ credited (the ?unspent-would-drop case)")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=10, spent=1000)], POLICY, REF) == {},
       "spent exactly AT the reference ⇒ NOT credited")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=10, spent=500)], POLICY, REF) == {},
       "spent BEFORE the reference ⇒ NOT credited")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=1500)], POLICY, REF) == {},
       "created AFTER the reference ⇒ too fresh ⇒ NOT credited")
    # largest-wins, never sum (as-of ref).
    aw = observe_as_of([m_utxo(A, 100_000_000, created=1), m_utxo(A, 250_000_000, created=2),
                        m_utxo(B, 120_000_000, created=1)], POLICY, REF)
    ok(aw == {A: 250_000_000, B: 120_000_000}, "largest-wins per identity as-of ref (never sum)")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=1)], POLICY, REF, reasons=None) is not None, "null reasons is allowed")
    ok(observe_as_of([m_utxo(A, 200_000_000, created=1)], POLICY, None) == {}, "None reference (abstain) ⇒ empty")

    # canonical bytes: order-independent, reference committed, and BYTE-IDENTICAL to the JS encoder.
    AA = "aa" * 32  # the same vector asserted in services/_shared/observation.test.mjs
    ok(canonical_hex(0, {}) == "0000000000000000" + "00", "empty observation ⇒ u64(0) + compact(0)")
    ok(canonical_hex(1, {AA: 1}) == "0100000000000000" + "04" + "aa" * 32 + "01" + "00" * 15,
       "single-entry canonical bytes match the SCALE vector (== the JS encoder, cross-language)")
    ok(canonical_hex(7, {A: 1, B: 2}) == canonical_hex(7, {B: 2, A: 1}),
       "canonical bytes are independent of dict insertion order")
    ok(canonical_hex(7, {A: 1}) != canonical_hex(8, {A: 1}), "the reference slot is committed in the bytes")

    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==\n")
    raise SystemExit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
