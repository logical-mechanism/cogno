#!/usr/bin/env python3
"""Cogno-Follower HTTP-layer + NonceCache tests (no live socket). Exercises the SILENT paths the
agreement tests don't reach:

  - the POST /bind decision MAPPING (decide_bind): VerifyError/ValueError→400, submit failure→502,
    submitter ok:false→409, ok:true→200 — the codes the agreement tests never assert on.
  - the NonceCache single-use guarantee under concurrency (two threads, same nonce → exactly one
    consumes, one raises) and at the TTL boundary (valid before, expired after).

decide_bind is the pure handler body (follower.py) — verify/submit/consume_nonce are injectable, so
this drives the real decision logic without binding a port. Matches the test_agreement style:
main() + ok() counter + print-✓ + SystemExit(1) on any FAIL.
"""
import json
import threading
import time
from types import SimpleNamespace

import follower
from follower import decide_bind, NonceCache
from verify import VerifyError

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


# A well-formed body so missing-field checks never short-circuit the path we want to test. The
# injected verify/submit decide the outcome, so the field VALUES are irrelevant (just non-empty).
GOOD_BODY = {
    "signature": "aa", "key": "bb", "signing_address": "addr_test1xyz",
    "sr25519_pubkey": "cd" * 32, "thread_pointer": None,
}

ACCEPT_NONCE = lambda acc, nonce: None  # noqa: E731 — a no-op nonce consumer for the decision tests


def test_http_codes():
    print("\n[http] POST /bind decision mapping (decide_bind)")

    # (a) missing fields → 400 (no verify call needed)
    code, obj = decide_bind({}, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
                            verify=lambda **k: (_ for _ in ()).throw(AssertionError("verify must NOT run on missing fields")),
                            submit=lambda *a: {"ok": True}, consume_nonce=ACCEPT_NONCE)
    ok(code == 400 and obj.get("ok") is False and "missing" in obj["error"],
       f"missing fields → 400 with 'missing' error ({obj.get('error', '')[:30]})")

    # (b) verify raises VerifyError → 400, error message preserved, submit NEVER called
    submit_called = []
    code, obj = decide_bind(
        GOOD_BODY, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
        verify=lambda **k: (_ for _ in ()).throw(VerifyError("nonce mismatch")),
        submit=lambda *a: submit_called.append(a) or {"ok": True},
        consume_nonce=ACCEPT_NONCE,
    )
    ok(code == 400 and obj["error"] == "nonce mismatch", "VerifyError → 400 with reason preserved")
    ok(not submit_called, "submit_link NOT called when verify rejects (nonce not burned downstream)")

    # (c) verify raises ValueError (e.g. payload.parse / beacon credential) → 400 too
    code, obj = decide_bind(
        GOOD_BODY, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
        verify=lambda **k: (_ for _ in ()).throw(ValueError("payload does not match")),
        submit=lambda *a: {"ok": True}, consume_nonce=ACCEPT_NONCE,
    )
    ok(code == 400 and "payload" in obj["error"], "ValueError from verify → 400 (not a 500 crash)")

    # (d) verify ok, submit raises → 502, identity_hash preserved for the caller to retry/inspect
    code, obj = decide_bind(
        GOOD_BODY, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
        verify=lambda **k: "ff" * 32,
        submit=lambda *a: (_ for _ in ()).throw(RuntimeError("node down")),
        consume_nonce=ACCEPT_NONCE,
    )
    ok(code == 502 and obj.get("identity_hash") == "ff" * 32 and "node down" in obj["error"],
       "submit failure → 502 with identity_hash preserved")

    # (e) verify ok, submit returns ok:false → 409 (chain rejected, e.g. account already bound)
    code, obj = decide_bind(
        GOOD_BODY, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
        verify=lambda **k: "ee" * 32,
        submit=lambda *a: {"ok": False, "error": "AccountAlreadyBound"},
        consume_nonce=ACCEPT_NONCE,
    )
    ok(code == 409 and obj.get("ok") is False and obj.get("identity_hash") == "ee" * 32,
       "submit ok:false → 409 (not a false 200)")

    # (f) verify ok, submit returns ok:true → 200, identity_hash + badges merged in
    code, obj = decide_bind(
        GOOD_BODY, genesis="0" * 64, expected_network=follower.EXPECTED_NETWORK,
        verify=lambda **k: "ab" * 32,
        submit=lambda *a: {"ok": True, "block": 42},
        consume_nonce=ACCEPT_NONCE,
    )
    ok(code == 200 and obj.get("ok") is True and obj.get("identity_hash") == "ab" * 32
       and obj.get("block") == 42 and "badges" in obj, "submit ok:true → 200 with merged result")

    # (g) the thread_pointer is threaded through to submit (optional 3rd arg)
    seen = {}
    decide_bind(
        {**GOOD_BODY, "thread_pointer": "dead"}, genesis="0" * 64,
        expected_network=follower.EXPECTED_NETWORK, verify=lambda **k: "01" * 32,
        submit=lambda ih, acc, thr: seen.update(ih=ih, acc=acc, thr=thr) or {"ok": True},
        consume_nonce=ACCEPT_NONCE,
    )
    ok(seen.get("thr") == "dead" and seen.get("ih") == "01" * 32,
       "verified identity_hash + thread_pointer forwarded to submit_link")


def test_concurrent_nonce_consume():
    print("\n[nonce] concurrent double-consume — exactly one wins")
    for trial in range(25):  # repeat: a race is probabilistic, one shot can miss it
        cache = NonceCache(ttl=300, max_entries=100)
        account = "ab" * 32
        nonce = cache.issue(account)
        results = []  # 'ok' for a clean consume, 'err' for a VerifyError
        barrier = threading.Barrier(2)  # release both threads as close to simultaneously as possible

        def worker():
            barrier.wait()
            try:
                cache.consume(account, nonce)
                results.append("ok")
            except VerifyError:
                results.append("err")

        t1, t2 = threading.Thread(target=worker), threading.Thread(target=worker)
        t1.start(); t2.start(); t1.join(); t2.join()
        if results.count("ok") != 1 or results.count("err") != 1:
            ok(False, f"trial {trial}: expected exactly 1 ok + 1 err, got {results}")
            break  # don't `return`: the burned-nonce sub-test below must still run
    else:
        ok(True, "two threads, same nonce → exactly one consume succeeds, one VerifyError (25 trials)")

    # And a third consume of an already-burned nonce always fails (single-use, no resurrection).
    cache = NonceCache(ttl=300, max_entries=100)
    account, nonce = "cd" * 32, None
    nonce = cache.issue(account)
    cache.consume(account, nonce)
    try:
        cache.consume(account, nonce); ok(False, "burned nonce re-consumed (should raise)")
    except VerifyError:
        ok(True, "a burned nonce cannot be consumed again (single-use)")


def test_nonce_expiry_boundary():
    print("\n[nonce] TTL boundary (mocked clock)")
    real_time = time.time
    base = 1_000_000.0
    clock = {"now": base}
    follower.time.time = lambda: clock["now"]
    try:
        account = "12" * 32

        # issue at T=base (expiry = base+300); consume at T+299.9 → still inside the window.
        cache = NonceCache(ttl=300, max_entries=100)
        clock["now"] = base
        nonce = cache.issue(account)
        clock["now"] = base + 299.9
        try:
            cache.consume(account, nonce)
            ok(True, "nonce valid at T+299.9 (inside TTL)")
        except VerifyError as e:
            ok(False, f"nonce wrongly expired at T+299.9: {e}")

        # fresh cache: issue at T=base; consume at T+300.1 → past TTL → expired AND evicted.
        cache = NonceCache(ttl=300, max_entries=100)
        clock["now"] = base
        nonce = cache.issue(account)
        clock["now"] = base + 300.1
        try:
            cache.consume(account, nonce); ok(False, "expired nonce consumed (should raise)")
        except VerifyError as e:
            ok("expired" in str(e), f"nonce expired past TTL → rejected ({str(e)[:40]})")
        # evicted: a follow-up consume reports 'no nonce issued', not 'expired'
        try:
            cache.consume(account, nonce); ok(False, "evicted nonce still present (should raise)")
        except VerifyError as e:
            ok("no nonce" in str(e), "expired nonce is evicted from the cache (not left to leak)")
    finally:
        follower.time.time = real_time


def test_nonce_overflow_eviction():
    print("\n[nonce] hard-cap eviction bounds the cache")
    cache = NonceCache(ttl=300, max_entries=4)
    for i in range(20):  # 20 distinct accounts, none consumed → a flood
        cache.issue(f"{i:064x}")
    ok(len(cache._d) <= 4, f"cache bounded at max_entries=4 under a 20-account flood (live={len(cache._d)})")


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


def test_submit_link_json():
    print("\n[submit] submit_link stdout/JSON robustness")
    saved = follower.subprocess.run

    def fake(stdout="", stderr="", rc=0):
        return lambda *a, **k: SimpleNamespace(stdout=stdout, stderr=stderr, returncode=rc)

    try:
        # (a) multiple JSON lines → the LAST is used (an early line can't masquerade as the result)
        follower.subprocess.run = fake(stdout='{"ok": false, "early": 1}\n{"ok": true, "block": 9}')
        res = follower.submit_link("aa", "bb", None)
        ok(res == {"ok": True, "block": 9}, "multiple JSON lines → last one is the result")

        # (b) nonzero exit, no JSON, stderr present → VerifyError surfacing rc + stderr (not silent)
        follower.subprocess.run = fake(stdout="", stderr="boom: submitter crashed", rc=1)
        try:
            follower.submit_link("aa", "bb", None); ok(False, "no-JSON exit should raise")
        except VerifyError as e:
            ok("exited 1" in str(e) and "boom" in str(e),
               "no-JSON nonzero exit → VerifyError carries exit code + stderr diagnostic")

        # (c) a JSON-looking but unparseable line → VerifyError, not a raw JSONDecodeError crash
        follower.subprocess.run = fake(stdout="{not valid json", rc=0)
        try:
            follower.submit_link("aa", "bb", None); ok(False, "unparseable JSON should raise VerifyError")
        except VerifyError as e:
            ok("unparseable" in str(e), "unparseable JSON line → VerifyError (handler doesn't crash)")
    finally:
        follower.subprocess.run = saved


def main():
    print("\n== Cogno-Follower HTTP + NonceCache tests ==")
    test_http_codes()
    test_concurrent_nonce_consume()
    test_nonce_expiry_boundary()
    test_nonce_overflow_eviction()
    test_rpc_json_retry()
    test_submit_link_json()
    print(f"\n== RESULT: {PASS} passed, {FAIL} failed ==\n")
    raise SystemExit(0 if FAIL == 0 else 1)


if __name__ == "__main__":
    main()
