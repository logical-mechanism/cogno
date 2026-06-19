"""The PINNED CIP-8 bind payload (DR-02) — the single source of truth for the bytes the user signs.
A byte-exact agreement across three implementations: the frontend's MeshJS `signData`, the on-chain
verifier's `parse_payload` (`pallet_cogno_gate::cip8`, which is what production checks now), and the
independent reference verifier here (`build`/`parse`, proven in `test_agreement.py`).

    cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<hex>

Why a single-line UTF-8 string (not raw concatenated bytes): pycardano's `cip8.verify` returns
`message = payload.decode("utf-8")`, so the committed payload MUST be valid UTF-8. ASCII-only,
fixed field order, ';' separator, no spaces → unambiguous and trivial to re-derive identically.

Fields (DR-02 — what the signature COMMITS, so bind-hijack is PREVENTED, not just detected):
  - domain  'cogno-chain/bind/v1'  — domain separation (this signature is a cogno-chain bind, v1)
  - genesis  the L3 genesis block hash, lowercase hex, 64 chars, no 0x  — anti-cross-chain
  - account  the 32-byte sr25519 posting pubkey, lowercase hex, 64 chars — commits the bind target
  - nonce    a 16-byte lowercase-hex value, 32 chars — FORMAT-checked only (D1). Replay is now
             prevented on-chain by the pallet's 1:1 maps + permanent tombstone, not by a server
             nonce cache; the field is retained so the signed-payload grammar stays fixed.

The nonce length is PINNED to exactly 32 hex chars, so neither the on-chain parser nor this reference
parser can be fed an arbitrarily long nonce field (follower-6).
"""
import re

DOMAIN = "cogno-chain/bind/v1"
_RE = re.compile(
    r"^cogno-chain/bind/v1;genesis=([0-9a-f]{64});account=([0-9a-f]{64});nonce=([0-9a-f]{32})$"
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
