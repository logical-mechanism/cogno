#!/usr/bin/env python3
"""The Cogno-Follower (M2) — a small HTTP service that turns a real Cardano CIP-8 signature into a
1:1 identity binding on the cogno-chain L3. v1 = a SINGLE TRUSTED follower (DR-07): it both runs
the CIP-8 verification (pycardano, the proven cogno_v3 path) and is the sole writer of bindings.
This is named honestly — `follower: trusted (v1)` — not "decentralized"; the on-chain self-proof
that would remove it from the trust path is the deferred D1 upgrade.

Flow (L2-follower.md §7 / L5-frontend.md §5.5):
  GET  /nonce?account=<sr25519_hex>  → issue a 300s nonce + return the EXACT payload to sign
  POST /bind  { signature, key, signing_address, sr25519_pubkey, thread_pointer? }
        → pycardano verify + the cogno-chain binding checks (verify.py) → sudo(link_identity)

Submission reuses the proven PAPI path via a Node subprocess (app/scripts/submit-link.mjs) rather
than re-encoding the custom feeless TxExtension set off PAPI. Dev only: link_identity is written
through sudo (//Alice), the DR-07 escape hatch (FollowerOrigin = EnsureRoot in v1 dev).

⚠ DEV: loopback-bound plain HTTP + permissive CORS for the localhost showcase. A real deployment is
HTTPS-only behind a proxy with a pinned origin + rate limiting, and the FollowerOrigin key in an
HSM/k-of-t (D2). Named, not hidden.
"""
import json
import os
import secrets
import subprocess
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from pycardano.network import Network

import payload as payload_mod
from verify import verify_bind, VerifyError

# ── config (env-overridable) ─────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.environ.get("APP_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "app")))
NODE_HTTP = os.environ.get("NODE_HTTP", "http://127.0.0.1:9944")
WS = os.environ.get("WS", "ws://127.0.0.1:9944")
# The Node binary used to drive the PAPI submitter. Defaults to `node` on PATH (the operator selects
# the right version, e.g. via nvm); env-override NODE_BIN for a non-PATH install. No developer-home
# path baked in (follower-8).
NODE_BIN = os.environ.get("NODE_BIN", "node")
PORT = int(os.environ.get("PORT", "8090"))
NONCE_TTL = int(os.environ.get("NONCE_TTL", "300"))
# Hard cap on outstanding nonces, so a flood of distinct account hexes to /nonce can't grow the cache
# without bound (follower-6).
MAX_NONCES = int(os.environ.get("MAX_NONCES", "10000"))
# The Cardano network this follower binds for. A recovered signing address from the WRONG network is
# rejected (follower-5): the beacon-name identity hash carries no network byte, so without this a
# mainnet proof could bind on a preprod follower (and vice-versa).
CARDANO_NETWORK = os.environ.get("CARDANO_NETWORK", "testnet").strip().lower()
EXPECTED_NETWORK = Network.MAINNET if CARDANO_NETWORK in ("mainnet", "1") else Network.TESTNET
SUBMIT = os.path.join(APP_DIR, "scripts", "submit-link.mjs")

BADGES = {"follower": "trusted (v1)", "chain": "operator-run (v1)"}


def _rpc_json(method: str, params: list, *, retries: int = 3, backoff: float = 0.5) -> dict:
    """A JSON-RPC POST to the L3 node with bounded retry/backoff — a transient node blip shouldn't
    crash startup or a bind (follower-7). Raises RuntimeError after `retries` attempts."""
    req = urllib.request.Request(
        NODE_HTTP,
        data=json.dumps({"id": 1, "jsonrpc": "2.0", "method": method, "params": params}).encode(),
        headers={"Content-Type": "application/json"},
    )
    last = None
    for attempt in range(1, retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 — retry any transient transport/HTTP/JSON error
            last = e
            # Log each retry so a flaky/slow node is diagnosable instead of silently backing off.
            print(f"[rpc-retry] {method} attempt {attempt}/{retries}: {e}", flush=True)
            if attempt < retries:
                time.sleep(backoff * 2 ** (attempt - 1))
    raise RuntimeError(f"node RPC {method} failed after {retries} attempts: {last}")


def fetch_genesis() -> str:
    """The L3 genesis block hash (lowercase hex, no 0x) via JSON-RPC. Committed in every payload
    so a proof for another chain is rejected."""
    return _rpc_json("chain_getBlockHash", [0])["result"].lower().replace("0x", "")


class NonceCache:
    """Per-account, single-use, TTL'd nonces (server-cache, 300s — the cogno_v3 nonce_view.py
    pattern). v1 ALSO commits the nonce inside the signed payload (DR-02), so this is belt-and-
    suspenders; a fully-valid proof consumes it (no replay).

    Bounded (follower-6): expired entries are swept on every issue, and a hard cap evicts the
    soonest-to-expire, so a flood of distinct account hexes to /nonce can't grow it without bound."""

    def __init__(self, ttl: int, max_entries: int = 10000):
        self.ttl = ttl
        self.max_entries = max(1, max_entries)
        self._d: dict[str, tuple[str, float]] = {}
        # ThreadingHTTPServer dispatches each request on its own thread, and issue/consume are compound
        # read-modify-write sequences (get → check → pop). Guard the cache with a lock so two
        # concurrent same-account requests can't both pass consume()'s check before either pops — a
        # single-use-nonce double-consume race. (Defence-in-depth: the nonce is also committed in the
        # signed payload and consumed last, so this only closes the cache layer's race window.)
        self._lock = threading.Lock()

    def _evict(self, now: float) -> None:
        # Caller holds self._lock (issue); not re-entrant, so it must NOT re-acquire.
        for k in [k for k, (_, exp) in self._d.items() if exp <= now]:
            self._d.pop(k, None)
        if len(self._d) >= self.max_entries:
            # still over cap after sweeping expired → drop the soonest-to-expire to bound memory.
            # Log it: hitting the cap means a flood of distinct accounts requesting nonces without
            # using them (a possible DoS), which is otherwise an invisible no-op.
            overflow = sorted(self._d.items(), key=lambda kv: kv[1][1])[: len(self._d) - self.max_entries + 1]
            print(f"[nonce-evict] cache at cap {self.max_entries} (live={len(self._d)}); "
                  f"evicting {len(overflow)} soonest-to-expire — possible nonce flood", flush=True)
            for k, _ in overflow:
                self._d.pop(k, None)

    def issue(self, account_hex: str) -> str:
        with self._lock:
            now = time.time()
            self._evict(now)
            nonce = secrets.token_hex(16)
            self._d[account_hex.lower()] = (nonce, now + self.ttl)
            return nonce

    def consume(self, account_hex: str, nonce_hex: str) -> None:
        with self._lock:
            rec = self._d.get(account_hex.lower())
            if not rec:
                raise VerifyError("no nonce issued for this account (or already used)")
            nonce, expiry = rec
            if time.time() > expiry:
                self._d.pop(account_hex.lower(), None)
                raise VerifyError("nonce expired (re-fetch and re-sign)")
            if nonce != nonce_hex:
                raise VerifyError("nonce mismatch")
            self._d.pop(account_hex.lower(), None)  # single-use


def submit_link(identity_hash_hex: str, account_hex: str, thread_hex: str | None) -> dict:
    """Shell out to the proven PAPI submitter to write sudo(link_identity). Returns its JSON.
    A non-zero exit with no JSON is a hard error (not silently read as a malformed success), and
    unparseable JSON is surfaced rather than crashing the handler (follower-7)."""
    cmd = [NODE_BIN, SUBMIT, identity_hash_hex, account_hex]
    if thread_hex:
        cmd.append(thread_hex)
    proc = subprocess.run(cmd, cwd=APP_DIR, capture_output=True, text=True, timeout=60,
                          env={**os.environ, "WS": WS})
    last = [ln for ln in proc.stdout.strip().splitlines() if ln.strip().startswith("{")]
    if not last:
        detail = proc.stderr.strip()[:300] or proc.stdout.strip()[:300]
        raise VerifyError(f"submitter exited {proc.returncode} with no JSON result: {detail}")
    try:
        return json.loads(last[-1])
    except json.JSONDecodeError as e:
        raise VerifyError(f"submitter emitted unparseable JSON ({e}): {last[-1][:200]}")


GENESIS = ""  # set in main()
NONCES = NonceCache(NONCE_TTL, MAX_NONCES)


def decide_bind(body: dict, *, genesis: str, expected_network: Network,
                verify=verify_bind, submit=submit_link, consume_nonce=None) -> tuple[int, dict]:
    """The pure POST /bind decision: from a parsed JSON body, run verify_bind then submit_link and
    return (http_code, response_obj). No socket, no globals — so the rejection/acceptance MAPPING
    (VerifyError/ValueError→400, submit failure→502, ok:false→409, ok:true→200) is unit-testable
    (test_http.py). The Handler is a thin shell over this. `verify`/`submit`/`consume_nonce` are
    injectable for tests; production passes the real verify_bind/submit_link/NONCES.consume."""
    consume = consume_nonce if consume_nonce is not None else NONCES.consume
    sig = body.get("signature")
    key = body.get("key")
    claimed = body.get("signing_address")
    sr25519 = (body.get("sr25519_pubkey") or "").lower().replace("0x", "")
    thread = body.get("thread_pointer")  # optional hex
    try:
        if not (sig and key and claimed and sr25519):
            raise VerifyError("missing one of: signature, key, signing_address, sr25519_pubkey")
        identity_hash = verify(
            data_signature={"signature": sig, "key": key},
            claimed_address=claimed,
            sr25519_pubkey_hex=sr25519,
            expected_genesis=genesis,
            expected_network=expected_network,
            consume_nonce=consume,
        )
    except (VerifyError, ValueError) as e:
        # D0 audit line: a REJECTED proof must be provably so — log it (not just 400 the caller).
        print(f"[bind-reject] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
              f"claimed={str(claimed)[:18]}… sr25519={str(sr25519)[:12]}… reason={e}", flush=True)
        return 400, {"ok": False, "error": str(e)}

    # Verified → write the binding (the D0 audit line: a fraudulent follower is provably so,
    # since the binding is public and recomputable from this exact input).
    print(f"[bind] verified {claimed[:18]}… → account {sr25519[:12]}… id_hash {identity_hash[:12]}…", flush=True)
    try:
        result = submit(identity_hash, sr25519, thread)
    except Exception as e:
        print(f"[submit-error] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
              f"identity_hash={identity_hash[:12]}… account={sr25519[:12]}… error={e}", flush=True)
        return 502, {"ok": False, "error": f"submit error: {e}", "identity_hash": identity_hash}
    code = 200 if result.get("ok") else 409
    if code == 409:
        print(f"[submit-rejected] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
              f"identity_hash={identity_hash[:12]}… account={sr25519[:12]}… result={result}", flush=True)
    return code, {**result, "identity_hash": identity_hash, "badges": BADGES}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # quieter logs
        pass

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/health":
            return self._send(200, {"ok": True, "genesis": GENESIS, "badges": BADGES,
                                    "network": CARDANO_NETWORK,
                                    "domain": payload_mod.DOMAIN, "nonce_ttl": NONCE_TTL})
        if u.path == "/nonce":
            q = parse_qs(u.query)
            account = (q.get("account") or [""])[0].lower().replace("0x", "")
            if len(account) != 64 or any(c not in "0123456789abcdef" for c in account):
                return self._send(400, {"error": "account must be a 32-byte sr25519 pubkey hex"})
            nonce = NONCES.issue(account)
            return self._send(200, {
                "nonce": nonce, "genesis": GENESIS, "ttl": NONCE_TTL,
                # The EXACT string to sign — the frontend signs this verbatim (and should re-derive
                # + assert it commits its own account + genesis before signing, defense in depth).
                "payload": payload_mod.build(GENESIS, account, nonce),
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path != "/bind":
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception as e:
            # Log malformed bodies (probing/attack signal) before 400'ing — silent otherwise.
            print(f"[bad-json] {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} "
                  f"from={self.client_address[0]} error={e}", flush=True)
            return self._send(400, {"error": f"bad JSON body: {e}"})

        code, obj = decide_bind(body, genesis=GENESIS, expected_network=EXPECTED_NETWORK)
        return self._send(code, obj)


def main():
    global GENESIS
    try:
        GENESIS = fetch_genesis()
    except Exception as e:
        # Don't dump a bare traceback on a node that isn't up yet — say WHAT failed and WHERE to look.
        print(f"[startup-error] could not fetch L3 genesis from {NODE_HTTP}: {e}", flush=True)
        print("  Is the cogno-chain node running and reachable at NODE_HTTP? Aborting.", flush=True)
        raise SystemExit(1)
    print(f"Cogno-Follower (v1, {BADGES}) on :{PORT}", flush=True)
    print(f"  genesis  = {GENESIS}", flush=True)
    print(f"  network  = {CARDANO_NETWORK} ({EXPECTED_NETWORK})", flush=True)
    print(f"  node     = {NODE_HTTP} (submit via {WS})", flush=True)
    print(f"  submitter= {SUBMIT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
