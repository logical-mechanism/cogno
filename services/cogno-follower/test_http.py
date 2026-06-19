#!/usr/bin/env python3
"""Cogno-Follower read-only-helper tests (no live socket). Since D1 retired the bind WRITE path
(`/bind` → pycardano verify → on-chain submit), the follower's remaining pure logic is the L3-node
liveness plumbing:

  - `_rpc_json` retry/backoff (a transient node blip must not crash a /nonce or startup genesis fetch)
  - `health_status` decision mapping (node up + genesis match → 200; down or mismatch → 503)

The CIP-8 verify agreement (the independent reference verifier) lives in `test_agreement.py`; the
on-chain verifier is what production uses now (`pallet_cogno_gate::cip8`). Style matches the repo's
*.py acceptance scripts: main() + ok() counter + print-✓ + SystemExit(1) on any FAIL.
"""
import json

import follower

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


class _FakeResp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self):
        return self._b


def test_rpc_json_retry():
    print("\n[rpc] _rpc_json retry / backoff")
    saved = (follower.urllib.request.urlopen, follower.time.sleep)
    follower.time.sleep = lambda s: None  # don't actually back off in the test
    try:
        # (a) transient failure on attempt 1 → succeeds on attempt 2 (no RuntimeError)
        calls = {"n": 0}

        def flaky(req, timeout=10):
            calls["n"] += 1
            if calls["n"] < 2:
                raise OSError("connection refused")
            return _FakeResp({"result": "0xdead"})

        follower.urllib.request.urlopen = flaky
        r = follower._rpc_json("chain_getBlockHash", [0])
        ok(r == {"result": "0xdead"} and calls["n"] == 2,
           "transient failure on attempt 1 → retried and succeeded on attempt 2")

        # (b) all attempts fail → RuntimeError naming the method + the LAST underlying exception
        calls["n"] = 0

        def always(req, timeout=10):
            calls["n"] += 1
            raise OSError("node down")

        follower.urllib.request.urlopen = always
        try:
            follower._rpc_json("some_method", [], retries=3)
            ok(False, "all-retries-fail should raise RuntimeError")
        except RuntimeError as e:
            ok(calls["n"] == 3 and "some_method" in str(e) and "node down" in str(e),
               "all 3 attempts fail → RuntimeError carrying method + last exception")
    finally:
        follower.urllib.request.urlopen, follower.time.sleep = saved


def test_health_status():
    print("\n[health] health_status decision (Phase 2 — live /health)")
    g = "ab" * 32
    code, h = follower.health_status(g, g)
    ok(code == 200 and h["ok"] is True and h["node_reachable"] is True and h["genesis_ok"] is True,
       "node up + genesis matches → 200 ok")
    code, h = follower.health_status(None, g)
    ok(code == 503 and h["ok"] is False and h["node_reachable"] is False and h["genesis_ok"] is None,
       "node unreachable → 503 (the old boot-cache always-ok bug is gone), genesis_ok None")
    code, h = follower.health_status("cd" * 32, g)
    ok(code == 503 and h["ok"] is False and h["node_reachable"] is True and h["genesis_ok"] is False,
       "node up but genesis mismatch (a re-spin) → 503")


def test_bind_write_is_retired():
    print("\n[D1] the bind WRITE path is gone (no verify/submit/nonce-cache on the follower)")
    # The trusted writer internals were removed for D1 — assert they cannot reappear by accident.
    for gone in ("submit_link", "decide_bind", "NonceCache", "SubmitPending"):
        ok(not hasattr(follower, gone), f"follower.{gone} no longer exists (binding is the on-chain self-proof)")


def main():
    print("\n== Cogno-Follower read-only-helper tests ==")
    test_rpc_json_retry()
    test_health_status()
    test_bind_write_is_retired()
    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==\n")
    raise SystemExit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
