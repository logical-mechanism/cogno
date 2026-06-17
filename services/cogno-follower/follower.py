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

⚠ DEV: plain HTTP + permissive CORS for the localhost showcase. A real deployment is HTTPS-only
with a pinned origin and the FollowerOrigin key in an HSM/k-of-t (D2). Named, not hidden.
"""
import json
import os
import secrets
import subprocess
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

import payload as payload_mod
from verify import verify_bind, VerifyError

# ── config (env-overridable) ─────────────────────────────────────────────────────────────────
HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.environ.get("APP_DIR", os.path.normpath(os.path.join(HERE, "..", "..", "app")))
NODE_HTTP = os.environ.get("NODE_HTTP", "http://127.0.0.1:9944")
WS = os.environ.get("WS", "ws://127.0.0.1:9944")
NODE_BIN = os.environ.get("NODE_BIN", "/home/logic/.nvm/versions/node/v22.12.0/bin/node")
PORT = int(os.environ.get("PORT", "8090"))
NONCE_TTL = int(os.environ.get("NONCE_TTL", "300"))
SUBMIT = os.path.join(APP_DIR, "scripts", "submit-link.mjs")

BADGES = {"follower": "trusted (v1)", "chain": "operator-run (v1)"}


def fetch_genesis() -> str:
    """The L3 genesis block hash (lowercase hex, no 0x) via JSON-RPC. Committed in every payload
    so a proof for another chain is rejected."""
    req = urllib.request.Request(
        NODE_HTTP,
        data=json.dumps({"id": 1, "jsonrpc": "2.0", "method": "chain_getBlockHash", "params": [0]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.load(r)["result"].lower().replace("0x", "")


class NonceCache:
    """Per-account, single-use, TTL'd nonces (server-cache, 300s — the cogno_v3 nonce_view.py
    pattern). v1 ALSO commits the nonce inside the signed payload (DR-02), so this is belt-and-
    suspenders; a fully-valid proof consumes it (no replay)."""

    def __init__(self, ttl: int):
        self.ttl = ttl
        self._d: dict[str, tuple[str, float]] = {}

    def issue(self, account_hex: str) -> str:
        nonce = secrets.token_hex(16)
        self._d[account_hex.lower()] = (nonce, time.time() + self.ttl)
        return nonce

    def consume(self, account_hex: str, nonce_hex: str) -> None:
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
    """Shell out to the proven PAPI submitter to write sudo(link_identity). Returns its JSON."""
    cmd = [NODE_BIN, SUBMIT, identity_hash_hex, account_hex]
    if thread_hex:
        cmd.append(thread_hex)
    proc = subprocess.run(cmd, cwd=APP_DIR, capture_output=True, text=True, timeout=60,
                          env={**os.environ, "WS": WS})
    last = [ln for ln in proc.stdout.strip().splitlines() if ln.strip().startswith("{")]
    if not last:
        raise VerifyError(f"submit failed (no JSON): {proc.stderr.strip()[:300] or proc.stdout.strip()[:300]}")
    return json.loads(last[-1])


GENESIS = ""  # set in main()
NONCES = NonceCache(NONCE_TTL)


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
            return self._send(400, {"error": f"bad JSON body: {e}"})

        try:
            sig = body.get("signature")
            key = body.get("key")
            claimed = body.get("signing_address")
            sr25519 = (body.get("sr25519_pubkey") or "").lower().replace("0x", "")
            thread = body.get("thread_pointer")  # optional hex
            if not (sig and key and claimed and sr25519):
                raise VerifyError("missing one of: signature, key, signing_address, sr25519_pubkey")

            identity_hash = verify_bind(
                data_signature={"signature": sig, "key": key},
                claimed_address=claimed,
                sr25519_pubkey_hex=sr25519,
                expected_genesis=GENESIS,
                consume_nonce=NONCES.consume,
            )
        except (VerifyError, ValueError) as e:
            return self._send(400, {"ok": False, "error": str(e)})

        # Verified → write the binding (the D0 audit line: a fraudulent follower is provably so,
        # since the binding is public and recomputable from this exact input).
        print(f"[bind] verified {claimed[:18]}… → account {sr25519[:12]}… id_hash {identity_hash[:12]}…", flush=True)
        try:
            result = submit_link(identity_hash, sr25519, thread)
        except Exception as e:
            return self._send(502, {"ok": False, "error": f"submit error: {e}", "identity_hash": identity_hash})
        code = 200 if result.get("ok") else 409
        return self._send(code, {**result, "identity_hash": identity_hash, "badges": BADGES})


def main():
    global GENESIS
    GENESIS = fetch_genesis()
    print(f"Cogno-Follower (v1, {BADGES}) on :{PORT}", flush=True)
    print(f"  genesis  = {GENESIS}", flush=True)
    print(f"  node     = {NODE_HTTP} (submit via {WS})", flush=True)
    print(f"  submitter= {SUBMIT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
