#!/usr/bin/env python3
"""M2d vault→weight logic tests (fixture-driven; no synced node needed). Proves the parsing,
the LARGEST-WINS-per-identity / never-sum rule, the curve floor, and the set_stake plan."""
from vault import parse_matches, weights_by_identity, weight_for_lock, plan_set_stakes

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

    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==\n")
    raise SystemExit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
