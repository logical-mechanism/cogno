# Cogno-Follower (M2 → D1: read-only helper)

Originally the off-chain bridge that turned a Cardano **CIP-8 signature** into a 1:1 identity binding
on the cogno-chain L3. **As of D1 (trustless identity) the bind WRITE path is retired:** binding is now
the permissionless on-chain self-proof `cognoGate.link_identity_signed`, where the runtime itself
verifies the CIP-8 (COSE_Sign1) wallet signature (`pallet_cogno_gate::cip8`). No trusted off-chain
writer exists, so the follower is now a small **read-only helper** (genesis/payload + health), not a
binding oracle.

## Trust posture — named honestly

`identity: trustless self-proof (D1, on-chain)` · `follower: read-only helper (v1)` · `chain: operator-run (v1)`

The follower can no longer fabricate bindings — it does not write the chain. Identity correctness is
re-verified by every full node from the user's own wallet signature. (A 3-of-5 k-of-t `FollowerOrigin`
is **D2**; it now gates only `revoke`, the moderation ban. The CIP-8 verifier is the anti-Sybil crown
jewel and is **NOT externally audited** — `MAINNET PREREQUISITE`, see `pallet_cogno_gate::cip8` +
`docs/TRUSTLESS-IDENTITY.md`.)

## The pinned committed payload (DR-02) — still the canon, now signed by the user

The exact UTF-8 string the user's wallet signs (the on-chain verifier parses the identical grammar):

```
cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<32hex>
```

`genesis` (anti-cross-chain — must be THIS chain's block-0 hash) · `account` = the 32-byte sr25519
posting pubkey the bind commits to · `nonce` (format-checked only — replay is now prevented by the
pallet's 1:1 maps + permanent tombstone, not a server cache). The identity bound on-chain is
`blake2b_256(plutus_data_cbor(owner Address))` (== the L1 beacon `token_name`, DR-01), reproduced
byte-exact by the on-chain verifier and by `beacon.py` (`test_beacon.py`).

## The independent reference verifier (kept as a cross-impl oracle)

`verify.py` + `beacon.py` are a SECOND, independent implementation of the on-chain verifier's checks
(pycardano CIP-8 + the binding invariants + the beacon-name identity). They are **not** on any
production write path — they exist so CI (`test_agreement.py`) can prove an independent implementation
agrees with the on-chain verifier on real MeshJS fixtures and rejects adversarial proofs. Cross-impl
agreement is the safety net for the unaudited on-chain crown-jewel verifier.

## API

| Route | | |
|---|---|---|
| `GET /health` (`/healthz`) | → `{ ok, node_reachable, genesis_ok, current_genesis, genesis, badges, … }`; **503** when unhealthy | LIVE probe: re-checks the node + genesis each call |
| `GET /metrics` | → Prometheus text (`cogno_follower_up`, `_node_reachable`, `_genesis_ok`) | scrape target |
| `GET /nonce?account=<sr25519_hex>` | → `{ nonce, genesis, payload }` | stateless convenience: the exact payload to sign + the live genesis (the client may build this itself) |
| `POST /bind` | → **410 Gone** | retired (D1): submit `cognoGate.link_identity_signed` on-chain instead |

`/nonce` is rate-limited per-IP (`RATE_LIMIT_PER_MIN`); `HOST` + `CORS_ORIGIN` are configurable. The
follower needs no signing key, no `WS`, no committee/sudo seeds — it only reads the node genesis.

## Run

```bash
# 1. a cogno-chain --dev node on :9944   (spec_version >= 109)
# 2. the follower (reuses cogno_v3's venv by default):
./run.sh
# 3. read-only-helper unit tests (no node needed):
<venv>/bin/python test_http.py
# 4. the independent reference verifier — agreement + negative tests (needs node for the fixture gen):
<venv>/bin/python test_agreement.py
```

## ⚠ Dev shortcuts (named)

- Plain **HTTP** + permissive CORS (localhost showcase). Prod = HTTPS-only, pinned origin.
- The Cardano vault→weight oracle (`vault.py`, M2d — unrelated to identity binding) still self-asserts
  the owner Address; sourcing *weight* from a buried `talk_vault` UTxO is the separate weight track.

## Files

- `payload.py` — the pinned bind-payload grammar (single source of truth: build + parse)
- `verify.py` / `beacon.py` — the independent REFERENCE CIP-8 verifier + beacon-name identity hash
  (cross-impl oracle for the on-chain `pallet_cogno_gate::cip8`; not a production writer)
- `follower.py` — the read-only HTTP helper (`/health`, `/metrics`, `/nonce`; `/bind` → 410 Gone)
- `vault.py` — the M2d vault→weight oracle (separate track, unaffected by D1)
- `test_agreement.py` — cross-impl agreement + the wrong-address/tamper negative tests
- `test_http.py` — the follower's remaining pure logic (rpc retry + health decision)
