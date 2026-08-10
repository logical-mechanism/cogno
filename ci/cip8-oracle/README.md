# cip8-oracle — the independent CIP-8 agreement oracle

An **independent second implementation** of the on-chain CIP-8 verifier
([`pallets/cogno-gate/src/cip8.rs`](../../pallets/cogno-gate/src/cip8.rs)), kept precisely because it does
**not** share the Rust verifier's lineage: it is a `pycardano`-based verifier whose only job is to catch a
divergence between two independent implementations of the anti-Sybil crown jewel. It is **not** part of the
running system — the all-Rust restart has no follower service, and nothing here reads or writes the chain.
It is an adversarial cross-check, run in CI and runnable by hand.

It moved here from the retired `services/cogno-follower/` when the backend went all-Rust, which is why the
Python still says "follower" in places. Do **not** port it to Rust — its value is the independent lineage.

## Files

| File | What |
|---|---|
| `verify.py` | The CIP-8 bind-proof verifier: `pycardano.cip.cip8.verify` for the COSE_Sign1 itself, then the cogno-chain invariants in order — recovered address == claimed address, payment credential must be a verification key (so a script/vault address is structurally rejected), network pin, payload grammar, genesis, committed account, and the nonce consumed **last** so a rejected proof never burns it. Returns the bound identity hash, or raises `VerifyError` — with one exception: a payload-grammar failure surfaces as the `ValueError` from `payload.parse`, which `verify_bind` does not wrap, so a caller must catch both (as `test_agreement.py` does). |
| `beacon.py` | The beacon-name derivation: `blake2b_256` over the **Plutus-Data** CBOR of the owner `Address` (Constr 0, indefinite-length arrays, no network byte) — not the raw CIP-19 address bytes. This is the L1 `token_name` / identity hash. |
| `payload.py` | The pinned `cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>` payload grammar. |
| `role_payload.py` | The pinned `cogno-chain/role/v1;…;role=<spo\|drep\|cc>` ROLE payload grammar — the only new surface of the role-key proof (`cip8::verify_bind_proof_role`); its COSE crypto path is identical to the bind path already covered by `verify.py`/`test_agreement.py`. |
| `test_agreement.py` | The oracle: generates real wallet-signed proofs via the headless MeshJS fixture ([`app/scripts/m2-cip8-fixture.mjs`](../../app/scripts/m2-cip8-fixture.mjs)) and asserts the Python verifier accepts the valid ones and rejects the tampered ones — wrong genesis, account substitution, bad nonce, a flipped signature byte, wrong network, and a claimed address that isn't the one signed with. The same accept/reject the Rust verifier must produce, and the only file here that needs Node. |
| `test_beacon.py` | Locks the beacon derivation to `6e2f65e9…`, the hex the Aiken contract's own `beacon_name_matches_follower` test asserts for the same owner, plus network-independence and the enterprise/script-stake variants. It also drives the credential-type guard directly: an owner shape the contract can't represent must raise, not be silently hashed into a bogus identity. |
| `test_role_payload.py` | Independent accept/reject cross-check of the role grammar — a Python `re` regex against the Rust hand-written byte scanner — mirroring the Rust `parse_role_payload_enforces_the_pinned_grammar` vectors (uppercase hex, a trailing byte, a bind-domain payload) and adding two that function doesn't carry: an unknown role token, which Rust asserts one level up in `role_proof_rejects_unknown_role_and_bind_domain`, and a trailing newline, which the Rust byte scanner rejects by construction but has no vector for. No third-party deps. |
| `requirements.txt` | `pycardano==0.19.2`, pinned exactly: `pycardano.cip.cip8.verify()` is byte-identical between 0.13.0 and 0.19.2 (only `sign()`, which this oracle never calls, changed), which is what made the jump safe. Plus `cbor2>=5.6,<6` — `beacon.py` imports `cbor2` directly and 6.x could change Plutus-Data CBOR encoding, which would move the beacon name. Both reasons are written out in the file. |

## Running

Despite the `test_` prefix, all three test files run as **plain scripts**: each has its own
`if __name__ == "__main__":` block and exits non-zero on failure, and nothing in this repo invokes
pytest. Only `test_role_payload.py` is additionally pytest-collectable — the other two expose a
single `main()`, so pytest would collect nothing from them.

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
# test_agreement.py shells out to the MeshJS fixture — use the nvm node (see the repo CLAUDE.md), not snap:
export NODE_BIN="$HOME/.nvm/versions/node/v22.12.0/bin/node"
python test_beacon.py         # pycardano only
python test_agreement.py      # needs `cd app && npm install` first (for the fixture's deps)
python test_role_payload.py   # no deps at all — runs against a bare interpreter
```

`APP_DIR` (default `../../app`, resolved from this directory, not the cwd) and `NODE_BIN` (default `node`)
are env-overridable.

## In CI

The `cip8-oracle` job in [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) runs those same three
commands in that order, on python 3.12, with `NODE_BIN=node` resolving to node 22.12.0 and `npm ci` already
run in `app/` for the fixture's deps. The job is gated on a path filter covering `ci/cip8-oracle/**`,
`app/scripts/**`, `app/package.json`, `app/package-lock.json`, `pallets/cogno-gate/**`, and the workflow
itself — so a change to the Rust verifier re-runs the independent implementation against it. Note the
filter deliberately excludes `app/**` at large: the fixture imports only from `node_modules`, so an
`app/src` change cannot affect it.
