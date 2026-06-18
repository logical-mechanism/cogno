# Cogno-Follower (M2)

The off-chain bridge that turns a real Cardano **CIP-8 signature** into a 1:1 identity binding on
the cogno-chain L3. This is the "Cardano READ link" — it lets a user prove control of a Cardano
owner Address and bind it to their Substrate posting account, so one Cardano identity ⇒ one
posting account (the anti-Sybil anchor).

## v1 trust posture — named honestly (DR-07)

`follower: trusted (v1)` · `chain: operator-run (v1)`

The follower is a **single trusted oracle**: it both runs the CIP-8 verification *and* is the sole
writer of bindings (via `FollowerOrigin`, which is `EnsureRoot`/sudo in v1 dev). A malicious or
buggy follower could fabricate bindings. What the design **prevents** (not just detects) in v1: the
committed payload binds `{sr25519 account + L3 genesis + nonce}` *inside* the signature, so the
follower cannot re-point an honest user's proof at a different account, and the on-chain 1:1 anchor
rejects double-binds. The on-chain ed25519 self-proof that would remove the follower from the trust
path entirely is the **deferred D1** upgrade; a 3-of-5 k-of-t `FollowerOrigin` is **D2** (before any
mainnet). Not "decentralized", not "trustless" — said plainly.

## The CIP-8 verify path (reused, not reimplemented)

Uses `pycardano.cip.cip8.verify` — the **proven** path from cogno_v3 (`verify_view.py`), pinned to
`pycardano==0.13.0`. On top of `verify()`'s own checks (Ed25519 + the COSE-header address hashes to
the signing key) the follower asserts the cogno-chain binding invariants (see `verify.py`).

## The pinned committed payload (DR-02) — a two-sided byte-exact agreement

The exact UTF-8 string the user signs (must be UTF-8: pycardano returns `payload.decode("utf-8")`):

```
cogno-chain/bind/v1;genesis=<64hex>;account=<64hex>;nonce=<hex>
```

`genesis` (anti-cross-chain) · `account` = the 32-byte sr25519 posting pubkey (commits the bind
target, anti-hijack) · `nonce` (anti-replay, single-use, 300s). The frontend's MeshJS `signData`
and this follower's pycardano verify agree on these bytes **byte-for-byte** — proven in
`test_agreement.py`. The identity key bound on-chain is `blake2b_256(serialized owner Address)`
(== the L1 beacon `token_name`, DR-01), proven identical across MeshJS `Address.toBytes()` and
pycardano `Address.to_primitive()`.

## API

| Route | | |
|---|---|---|
| `GET /health` (`/healthz`) | → `{ ok, node_reachable, genesis_ok, current_genesis, genesis, nonces_cached, badges, … }`; **503** when unhealthy | LIVE probe: re-checks the node + genesis each call (not a boot cache) |
| `GET /metrics` | → Prometheus text (`cogno_follower_up`, `_node_reachable`, `_genesis_ok`, `_nonces_cached`) | scrape target |
| `GET /nonce?account=<sr25519_hex>` | → `{ nonce, genesis, ttl, payload }` | issue a nonce + the **exact** payload to sign |
| `POST /bind` | `{ signature, key, signing_address, sr25519_pubkey, thread_pointer? }` → `{ ok, identity_hash, account, error? }` | verify the CIP-8 proof + submit `link_identity` |

`signature`/`key` are the CIP-30 `DataSignature` from `signData`. The follower NEVER receives a
private key; the only key it holds is the dev sudo key it signs the `link_identity` submit with.

## Run

```bash
# 1. a cogno-chain --dev node on :9944   (spec_version >= 103)
# 2. the follower (reuses cogno_v3's venv by default):
./run.sh
# 3. prove it end-to-end (real headless-MeshJS CIP-8 → verify → submit → on-chain readback → post):
cd ../../app && node scripts/m2-follower-e2e.mjs
# verify-only unit + negative tests (no node needed):
<venv>/bin/python test_agreement.py
```

## ⚠ Dev shortcuts (named, to be removed before any real deployment)

- Plain **HTTP** + permissive CORS (localhost showcase). Prod = HTTPS-only, pinned origin.
- Bindings are written through **sudo** (`//Alice`); the dedicated `EnsureSignedBy<FollowerKey>`
  arm + an HSM/k-of-t key is the D2 hardening.
- **No Cardano vault observed yet** (wallet-only CIP-8, DR-14). The recovered owner Address is
  self-asserted; cross-checking it against an on-chain `talk_vault` UTxO (and sourcing *weight*
  from the locked ADA) is **M2d** — see the seam in `verify.py`.

## Files

- `payload.py` — the pinned payload (single source of truth: build + parse)
- `verify.py` — the CIP-8 + binding-invariant verification (pure, testable)
- `follower.py` — the HTTP service (nonce cache + `/bind` → PAPI submit subprocess)
- `test_agreement.py` — both-sides-agree + the wrong-address/tamper negative tests
- submit path: `../../app/scripts/submit-link.mjs` (proven PAPI sudo `link_identity`)
