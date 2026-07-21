# cip8-oracle — the independent CIP-8 agreement oracle (CI-only)

An **independent second implementation** of the on-chain CIP-8 verifier
([`pallets/cogno-gate/src/cip8.rs`](../../pallets/cogno-gate/src/cip8.rs)), kept precisely because it does
**not** share the Rust verifier's lineage: it is a `pycardano`-based verifier whose only job is to catch a
divergence between two independent implementations of the anti-Sybil crown jewel. It is **not** part of the
running system — the all-Rust restart has no follower service; this is a CI adversarial check.

It moved here from the retired `services/cogno-follower/` when the backend went all-Rust. Do **not** port
it to Rust — its value is the independent lineage.

## Files

| File | What |
|---|---|
| `verify.py` | The CIP-8 bind-proof verifier (COSE_Sign1 parse + `pycardano.cip.cip8.verify` + address/network check), returning the bound identity hash (or raising `VerifyError`). |
| `beacon.py` | The beacon-name derivation (`blake2b_256(cbor(owner))`) — the L1 `token_name` / identity hash. |
| `payload.py` | The pinned `cogno-chain/bind/v1;genesis=…;account=…;nonce=…` payload grammar. |
| `role_payload.py` | The pinned `cogno-chain/role/v1;…;role=<spo\|drep\|cc>` ROLE payload grammar — the only new surface of the role-key proof (`cip8::verify_bind_proof_role`); its COSE crypto path is identical to the bind path already covered by `verify.py`/`test_agreement.py`. |
| `test_agreement.py` | The oracle: generates real wallet-signed proofs via the headless MeshJS fixture (`app/scripts/m2-cip8-fixture.mjs`) and asserts the Python verifier accepts the valid ones + rejects the tampered ones — the same accept/reject the Rust verifier must produce. |
| `test_role_payload.py` | Independent accept/reject cross-check of the role grammar (Python `re` regex vs the Rust hand-parser), mirroring the Rust `parse_role_payload_enforces_the_pinned_grammar` vectors. No deps. |
| `test_beacon.py` | Unit tests for the beacon derivation. |
| `requirements.txt` | `pycardano` + `cbor2`. |

## Running (CI)

```bash
python -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
# test_agreement.py shells out to the MeshJS fixture — use the nvm node (see the repo CLAUDE.md), not snap:
export NODE_BIN="$HOME/.nvm/versions/node/v22.12.0/bin/node"
python test_beacon.py
python test_agreement.py     # needs `cd app && npm install` first (for the fixture's deps)
```

`APP_DIR` (default `../../app`) and `NODE_BIN` (default `node`) are env-overridable.
