"""The PINNED v1 CIP-8 bind payload (DR-02) — the single source of truth for the bytes the
user signs. A two-sided, byte-exact agreement with the frontend's MeshJS `signData`, proven in
`test_agreement.py` (the frontend signs exactly what `GET /nonce` returns from `build()`, and
`POST /bind` re-derives the same string here).

    cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<hex>

Why a single-line UTF-8 string (not raw concatenated bytes): pycardano's `cip8.verify` returns
`message = payload.decode("utf-8")`, so the committed payload MUST be valid UTF-8. ASCII-only,
fixed field order, ';' separator, no spaces → unambiguous and trivial to re-derive identically.

Fields (DR-02 — what the signature COMMITS, so bind-hijack is PREVENTED, not just detected):
  - domain  'cogno-chain/bind/v1'  — domain separation (this signature is a cogno-chain bind, v1)
  - genesis  the L3 genesis block hash, lowercase hex, 64 chars, no 0x  — anti-cross-chain
  - account  the 32-byte sr25519 posting pubkey, lowercase hex, 64 chars — commits the bind target
  - nonce    the follower-issued nonce, lowercase hex                    — anti-replay
"""
import re

DOMAIN = "cogno-chain/bind/v1"
_RE = re.compile(
    r"^cogno-chain/bind/v1;genesis=([0-9a-f]{64});account=([0-9a-f]{64});nonce=([0-9a-f]+)$"
)


def build(genesis_hex: str, account_hex: str, nonce_hex: str) -> str:
    """The exact UTF-8 string the user signs. `genesis`/`account` are 64-char lowercase hex."""
    return f"{DOMAIN};genesis={genesis_hex};account={account_hex};nonce={nonce_hex}"


def parse(message: str) -> dict:
    """Parse a verified payload back to its fields. Raises ValueError on any format mismatch
    (a wrong domain separator, wrong lengths, or extra bytes ⇒ reject — never coerce)."""
    m = _RE.match(message)
    if not m:
        raise ValueError("payload does not match the pinned 'cogno-chain/bind/v1' format")
    return {"genesis": m.group(1), "account": m.group(2), "nonce": m.group(3)}
