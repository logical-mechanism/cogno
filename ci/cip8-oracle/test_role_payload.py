"""Independent grammar cross-check for the ROLE payload.

The Python `re` regex in `role_payload.py` and the Rust hand-written byte scanner in
`pallets/cogno-gate/src/cip8.rs::parse_role_payload` are two independent implementations of the pinned
`cogno-chain/role/v1;…;role=<spo|drep|cc>` grammar. They MUST agree on every accept/reject — the same
adversarial vectors asserted in the Rust test `parse_role_payload_enforces_the_pinned_grammar` are
asserted here against the independent implementation. Runs with no deps (`python test_role_payload.py`).
"""
import role_payload

G = "27" * 32
A = "30" * 32
N = "ab" * 16


def _rejects(msg: str) -> bool:
    try:
        role_payload.parse(msg)
        return False
    except ValueError:
        return True


def test_roundtrip_each_role():
    for role in ("spo", "drep", "cc"):
        msg = role_payload.build(G, A, N, role)
        assert role_payload.parse(msg) == {
            "genesis": G,
            "account": A,
            "nonce": N,
            "role": role,
        }


def test_rejects_bad_grammar():
    # a bind payload (wrong domain) can never satisfy the role grammar
    assert _rejects(f"cogno-chain/bind/v1;genesis={G};account={A};nonce={N}")
    # unknown role token
    assert _rejects(f"cogno-chain/role/v1;genesis={G};account={A};nonce={N};role=admin")
    # uppercase hex is rejected (same [0-9a-f] strictness as the on-chain parser)
    assert _rejects(f"cogno-chain/role/v1;genesis={'2A' * 32};account={A};nonce={N};role=spo")
    # trailing byte after the role token
    assert _rejects(role_payload.build(G, A, N, "spo") + "x")
    # trailing NEWLINE after the role token — the on-chain scanner rejects it, so the `\Z` anchor here
    # must too (a plain `$` would wrongly ACCEPT it, diverging from the runtime).
    assert _rejects(role_payload.build(G, A, N, "spo") + "\n")
    # missing the role= field entirely
    assert _rejects(f"cogno-chain/role/v1;genesis={G};account={A};nonce={N}")
    # short genesis
    assert _rejects(f"cogno-chain/role/v1;genesis={'27' * 31};account={A};nonce={N};role=spo")


def test_build_rejects_unknown_role():
    try:
        role_payload.build(G, A, N, "admin")
        assert False, "build must reject an unknown role"
    except ValueError:
        pass


if __name__ == "__main__":
    test_roundtrip_each_role()
    test_rejects_bad_grammar()
    test_build_rejects_unknown_role()
    print("role_payload agreement OK")
