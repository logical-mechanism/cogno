"""The PINNED CIP-8 ROLE payload — an independent second implementation of the grammar the on-chain
`pallet_cogno_gate::cip8::parse_role_payload` enforces. Sibling of `payload.py` (the bind grammar).

    cogno-chain/role/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>;role=<spo|drep|cc>

The `role/v1` domain (distinct from `bind/v1`) plus the trailing `role=` token are the anti-cross-replay
pins: a payment/stake bind proof can never satisfy this grammar, and a proof minted for one role can
never be matched to another. The role-key COSE_Sign1 crypto path (COSE parse + ed25519 verify +
address→payment-credential bind) is IDENTICAL to the bind path already covered by
`verify.py`/`test_agreement.py`, so the ONLY new surface — this grammar — is what this file
independently re-derives. `parse` here is a `re` regex; the on-chain parser is a hand-written byte
scanner: two independent implementations that MUST agree on every accept/reject (see
`test_role_payload.py`).
"""
import re

DOMAIN = "cogno-chain/role/v1"
ROLES = ("spo", "drep", "cc")
# `\A` / `\Z` anchor the WHOLE string — NOT `^`/`$`, whose `$` also matches just before a trailing
# newline, which would ACCEPT `…;role=spo\n` that the on-chain byte scanner (rest == b"spo") rejects.
_RE = re.compile(
    r"\Acogno-chain/role/v1;genesis=([0-9a-f]{64});account=([0-9a-f]{64});"
    r"nonce=([0-9a-f]{32});role=(spo|drep|cc)\Z"
)


def build(genesis_hex: str, account_hex: str, nonce_hex: str, role: str) -> str:
    """The exact UTF-8 string the role key signs. `genesis`/`account` are 64-char lowercase hex,
    `nonce` 32-char lowercase hex, `role` one of spo|drep|cc."""
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}")
    return (
        f"{DOMAIN};genesis={genesis_hex};account={account_hex};"
        f"nonce={nonce_hex};role={role}"
    )


def parse(message: str) -> dict:
    """Parse a verified role payload back to its fields. Raises ValueError on any format mismatch
    (wrong domain, wrong lengths, unknown role, or extra bytes ⇒ reject — never coerce)."""
    m = _RE.match(message)
    if not m:
        raise ValueError("payload does not match the pinned 'cogno-chain/role/v1' format")
    return {
        "genesis": m.group(1),
        "account": m.group(2),
        "nonce": m.group(3),
        "role": m.group(4),
    }
