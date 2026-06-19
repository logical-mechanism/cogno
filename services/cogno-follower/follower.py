#!/usr/bin/env python3
"""The Cogno-Follower (M2 → D1) — a small read-only HTTP helper for the cogno-chain identity gate.

**D1 (trustless identity): the follower no longer verifies or writes bindings.** Identity binding is
now the permissionless ON-CHAIN self-proof `cognoGate.link_identity_signed` — the runtime itself
verifies the CIP-8 (COSE_Sign1) wallet signature (`pallet_cogno_gate::cip8`), so no trusted off-chain
writer exists. The old `POST /bind` (pycardano verify → sudo/committee `link_identity`) is RETIRED.

What remains here is a tiny convenience + observability shell:
  GET  /health (/healthz)  → node-reachable + genesis-match liveness (503 when unhealthy)
  GET  /metrics            → Prometheus text (up / node_reachable / genesis_ok)
  GET  /nonce?account=…    → the EXACT bind payload to sign + the LIVE genesis (stateless; the nonce
                             is NO LONGER load-bearing on-chain — the client may build this itself)
  POST /bind               → 410 Gone (binding is the on-chain self-proof; see above)

The independent CIP-8 reference verifier (`verify.py` + `beacon.py`) is KEPT as a cross-impl agreement
oracle for the on-chain crown-jewel verifier (run in CI via `test_agreement.py` against real MeshJS
fixtures + adversarial negatives) — it is NOT on any production write path. The M2d vault→weight
oracle (`vault.py`) is unrelated to identity binding and unaffected.

⚠ DEV: loopback-bound plain HTTP + permissive CORS for the localhost showcase. A real deployment is
HTTPS-only behind a proxy with a pinned origin + rate limiting. Named, not hidden.
"""
import json
import os
import secrets
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import payload as payload_mod

# ── config (env-overridable) ─────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
NODE_HTTP = os.environ.get("NODE_HTTP", "http://127.0.0.1:9944")
PORT = int(os.environ.get("PORT", "8090"))

# ── transport hardening (prod-readiness Phase 3) ────────────────────────────────────────────────
HOST = os.environ.get("HOST", "127.0.0.1")           # bind host; 127.0.0.1 for the localhost showcase
CORS_ORIGIN = os.environ.get("CORS_ORIGIN", "*")     # set to your frontend origin in production
RATE_LIMIT_PER_MIN = int(os.environ.get("RATE_LIMIT_PER_MIN", "60"))  # per-IP req/min on /nonce (0=off)

# `chain` is operator-run (v1); `identity` is now the trustless on-chain self-proof (D1). The follower
# itself is a read-only helper — it can no longer fabricate bindings (it does not write the chain).
BADGES = {"identity": "trustless self-proof (D1, on-chain)", "follower": "read-only helper (v1)",
          "chain": "operator-run (v1)"}


class RateLimiter:
    """Per-IP sliding-window limiter (Phase 3): bound /nonce so one client can't flood it. Thread-safe
    for ThreadingHTTPServer. per_min <= 0 disables it."""

    def __init__(self, per_min: int, window: float = 60.0):
        self.per_min = per_min
        self.window = window
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, ip: str) -> bool:
        if self.per_min <= 0:
            return True
        now = time.time()
        with self._lock:
            hits = [t for t in self._hits.get(ip, []) if now - t < self.window]
            if len(hits) >= self.per_min:
                self._hits[ip] = hits
                return False
            hits.append(now)
            self._hits[ip] = hits
            if len(self._hits) > 4096:  # opportunistic prune of idle IPs to bound memory
                for k in [k for k, v in self._hits.items() if not v or now - v[-1] > self.window]:
                    self._hits.pop(k, None)
            return True


def _rpc_json(method: str, params: list, *, retries: int = 3, backoff: float = 0.5) -> dict:
    """A JSON-RPC POST to the L3 node with bounded retry/backoff — a transient node blip shouldn't
    crash startup (follower-7). Raises RuntimeError after `retries` attempts."""
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
    """The L3 genesis block hash (lowercase hex, no 0x) via JSON-RPC. Returned by /nonce so a client
    builds the bind payload against THIS chain (anti-cross-chain)."""
    return _rpc_json("chain_getBlockHash", [0])["result"].lower().replace("0x", "")


def node_probe(timeout: float = 2.0):
    """Cheap SINGLE-SHOT liveness probe of the L3 node for /health + /metrics (prod-readiness Phase 2):
    returns the node's current genesis hash (lowercase, no 0x), or None if unreachable. No retry — a
    health endpoint must answer fast even when the node is down, unlike _rpc_json's bounded retry."""
    req = urllib.request.Request(
        NODE_HTTP,
        data=json.dumps({"id": 1, "jsonrpc": "2.0", "method": "chain_getBlockHash", "params": [0]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            res = json.load(r).get("result")
            return res.lower().replace("0x", "") if res else None
    except Exception:  # noqa: BLE001 — any transport/HTTP/JSON error ⇒ node not healthily reachable
        return None


# A short TTL cache over node_probe() so the UNTHROTTLED /health + /metrics endpoints can't spawn
# unbounded concurrent 2s node RPCs under a probe flood. A burst inside HEALTH_PROBE_TTL (default 2s)
# shares one result instead of one RPC each.
_PROBE_TTL = float(os.environ.get("HEALTH_PROBE_TTL", "2"))
_probe_cache = {"genesis": None, "at": 0.0}
_probe_lock = threading.Lock()


def cached_node_probe():
    """node_probe() memoized for HEALTH_PROBE_TTL seconds (thread-safe). Caching None (unreachable) for
    the window is intentional — a health flood during a node outage must not stampede it with retries."""
    now = time.time()
    with _probe_lock:
        if now - _probe_cache["at"] < _PROBE_TTL:
            return _probe_cache["genesis"]
    g = node_probe()
    with _probe_lock:
        _probe_cache["genesis"] = g
        _probe_cache["at"] = time.time()
    return g


def health_status(current_genesis, pinned_genesis: str) -> tuple[int, dict]:
    """PURE /health decision (unit-testable, no socket): given the node's current genesis (or None if
    unreachable) and the follower's pinned genesis, return (http_code, fields). Healthy only when the
    node answers AND its genesis matches the one the follower hands out in /nonce payloads — a node that
    is down, or a genesis that changed after a re-spin, both report unhealthy (503)."""
    node_ok = current_genesis is not None
    genesis_ok = (current_genesis == pinned_genesis) if node_ok else None
    healthy = bool(node_ok and genesis_ok)
    return (200 if healthy else 503), {
        "ok": healthy,
        "node_reachable": node_ok,
        "genesis_ok": genesis_ok,
        "current_genesis": current_genesis,
    }


GENESIS = ""  # set in main()
RATE = RateLimiter(RATE_LIMIT_PER_MIN)


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def _send_text(self, code: int, text: str, content_type: str = "text/plain; version=0.0.4"):
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # quieter logs
        pass

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        u = urlparse(self.path)
        if u.path in ("/health", "/healthz"):
            # LIVE probe (Phase 2): re-check the node + genesis (TTL-cached ~2s so a flood can't stampede
            # the node), not a boot-time cache.
            code, h = health_status(cached_node_probe(), GENESIS)
            return self._send(code, {**h, "genesis": GENESIS, "badges": BADGES,
                                     "domain": payload_mod.DOMAIN})
        if u.path == "/metrics":
            # Prometheus text exposition (hand-rolled — no client lib). Node reachability + genesis match,
            # so the follower (a documented operator service) is alertable like the relayer.
            current = cached_node_probe()
            node_ok = 1 if current is not None else 0
            lines = [
                "# HELP cogno_follower_up 1 while the follower process is running",
                "# TYPE cogno_follower_up gauge",
                "cogno_follower_up 1",
                "# HELP cogno_follower_node_reachable 1 if the L3 node RPC answered",
                "# TYPE cogno_follower_node_reachable gauge",
                f"cogno_follower_node_reachable {node_ok}",
            ]
            # Emit genesis_ok ONLY when the node is reachable — otherwise the match is UNKNOWN, not a
            # mismatch. Omitting the sample keeps a genesis-mismatch alert from firing on a plain outage.
            if current is not None:
                lines += [
                    "# HELP cogno_follower_genesis_ok 1 if the node genesis matches the follower's pinned genesis",
                    "# TYPE cogno_follower_genesis_ok gauge",
                    f"cogno_follower_genesis_ok {1 if current == GENESIS else 0}",
                ]
            return self._send_text(200, "\n".join(lines) + "\n")
        if u.path == "/nonce":
            if not RATE.allow(self.client_address[0]):
                return self._send(429, {"error": "rate limited — slow down"})
            q = parse_qs(u.query)
            account = (q.get("account") or [""])[0].lower().replace("0x", "")
            if len(account) != 64 or any(c not in "0123456789abcdef" for c in account):
                return self._send(400, {"error": "account must be a 32-byte sr25519 pubkey hex"})
            # Stateless convenience: a fresh nonce + the EXACT payload string to sign over the LIVE
            # genesis. NOTE: the nonce is NO LONGER load-bearing on-chain — the on-chain verifier checks
            # the nonce's FORMAT only; replay is prevented by the pallet's 1:1 maps + permanent tombstone.
            # The client may equally build this itself (the frontend does, from the PAPI-read genesis).
            nonce = secrets.token_hex(16)
            return self._send(200, {
                "nonce": nonce, "genesis": GENESIS,
                "payload": payload_mod.build(GENESIS, account, nonce),
            })
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        if u.path == "/bind":
            # RETIRED for D1: binding is the permissionless on-chain self-proof
            # `cognoGate.link_identity_signed` — the follower no longer verifies or writes bindings.
            return self._send(410, {
                "ok": False,
                "error": "POST /bind is retired (D1): submit cognoGate.link_identity_signed on-chain "
                         "(the trustless self-proof) — the follower no longer writes bindings",
            })
        return self._send(404, {"error": "not found"})


def main():
    global GENESIS
    try:
        GENESIS = fetch_genesis()
    except Exception as e:
        # Don't dump a bare traceback on a node that isn't up yet — say WHAT failed and WHERE to look.
        print(f"[startup-error] could not fetch L3 genesis from {NODE_HTTP}: {e}", flush=True)
        print("  Is the cogno-chain node running and reachable at NODE_HTTP? Aborting.", flush=True)
        raise SystemExit(1)
    print(f"Cogno-Follower (v1, {BADGES}) on {HOST}:{PORT}", flush=True)
    print(f"  genesis  = {GENESIS}", flush=True)
    print(f"  node     = {NODE_HTTP}", flush=True)
    print("  role     = read-only helper — identity binds are the on-chain link_identity_signed self-proof (D1)", flush=True)
    print(f"  limits   = {RATE_LIMIT_PER_MIN}/min per-IP on /nonce, CORS {CORS_ORIGIN}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
