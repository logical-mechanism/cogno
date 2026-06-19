# Sponsored-Bind Relay (D1 bind-funding)

Closes the **new-user funding gap** for the trustless identity bind, without weakening the chain's
DoS defence.

## The gap it closes

D1 made identity binding the permissionless on-chain call `cognoGate.link_identity_signed` (the runtime
verifies a CIP-8 wallet signature in `pallet_cogno_gate::cip8`). That call is **deliberately NOT
feeless** — the verify is ~68 µs of ed25519 + 2× blake2 + CBOR, so a free call would be a cheap
compute-DoS; `ensure_signed` makes the **submitter** pay. But in the frontend the submitter is the
user's freshly sign-to-derived sr25519 posting account, which on a new chain has **zero balance** → the
bind tx can't pay → it fails. A real new user couldn't complete a bind in the browser.

This small **funded** service accepts a signed proof and submits `link_identity_signed` with its **own**
funded key, paying the fee. The DoS defence stays intact — *someone* always pays (here, the relay,
which also rate-limits per-IP) — and the user needs no funds.

## Trust posture — named honestly

`identity: trustless self-proof (D1, on-chain)` · `relay: sponsored bind — liveness-only fee payer (cannot forge)` · `chain: operator-run (v1)`

The relay is a **LIVENESS party, never a CORRECTNESS party.** The CIP-8 proof cryptographically commits
`{account, genesis}`, and the **runtime is the sole verifier**, so the relay **cannot forge or retarget
a binding**, and a tombstoned identity is refused on-chain. A compromised relay key can spam its own
funds away or refuse service (censor) — it can **not** fabricate a single identity.

> **Contrast the retired follower `POST /bind`** (M2), whose key *was* a correctness party: a follower
> compromise could forge any identity. D1 removed that. This relay does **not** bring it back — it holds
> **no** committee / sudo / `FollowerOrigin` authority; its key is merely funded. It does **not** verify
> the proof (the chain does); it pre-checks size bounds only to avoid wasting fees on junk.

The frontend keeps a **trustless fallback**: if the posting account can pay its own fee it self-submits
and never touches the relay (`app/src/lib/chain/identity.ts → submitBindSponsored`). A fresh derived
account (balance 0) takes the relay path; a funded one does not.

## API

| Route | | |
|---|---|---|
| `POST /bind` | `{ cose_sign1, cose_key, thread_pointer? }` (hex) → submits `cognoGate.link_identity_signed`, fee-paid by the relay key. `200 { ok, identity, who }` on success; `422 { ok:false, error }` for a chain rejection (`ProofInvalid` / `WrongGenesis` / `IdentityTombstoned` / `AccountAlreadyBound` …), relayed **verbatim**; `400` for a malformed body; `429` when rate-limited |
| `GET /health` (`/healthz`) | → `{ ok, node_reachable, relay_funded, relay_balance, min_balance, badges }`; **503** when the node is unreachable or the relay is below `MIN_BALANCE` (it can't pay a fee ⇒ unhealthy) |
| `GET /metrics` | → Prometheus text (`cogno_bind_relay_up`, `_node_reachable`, `_balance_planck`, `_binds_total`, `_binds_ok_total`, `_binds_rejected_total`, `_rate_limited_total`) |

Submissions are **serialized** on the single relay key so concurrent POSTs don't race the account nonce.

## Config (env)

| Var | Default | |
|---|---|---|
| `WS` | `ws://127.0.0.1:9944` | the L3 node the relay submits to |
| `PORT` / `HOST` | `8091` / `127.0.0.1` | listen address (the follower is `8090`) |
| `RELAY_SEED` | `//Alice` | the **funded** submitter — a `//derivation` or a full mnemonic. **NOT a privileged key.** `COGNO_PROFILE=prod` refuses a public dev seed |
| `RATE_LIMIT_PER_MIN` | `10` | per-IP cap on `/bind` (anti-abuse / liveness; `0` = off) |
| `MIN_BALANCE` | `1000000000` | planck floor below which `/health` reports unhealthy |
| `GENESIS` | *(unset)* | if set, refuse to sponsor binds on a chain whose genesis ≠ this (wrong-chain guard) |
| `CORS_ORIGIN` | `*` | set to your frontend origin in production |

## Run

```bash
# 1. a cogno-chain --dev node (spec_version >= 108)
# 2. the relay (uses the nvm node v22 + the app/node_modules symlink for PAPI deps):
WS=ws://127.0.0.1:9944 RELAY_SEED=//Bob PORT=8091 ./run.sh
# 3. unit tests (pure helpers; no node, no install — imports only ./lib.mjs + ../_shared):
node relay.test.mjs
```

Deps are shared with the frontend via `node_modules -> ../../app/node_modules` (a gitignored symlink,
recreated by `run.sh` and in CI). The full live path (a brand-new zero-balance account binds + posts
feelessly through the relay) is proven by `app/scripts/d1-bind-funding-acceptance.mjs`.

⚠ DEV: loopback-bound plain HTTP + permissive CORS for the localhost showcase. A real deployment is
HTTPS-only behind a proxy with a pinned origin + rate limiting, and a real funded `RELAY_SEED`. Named,
not hidden. See `docs/TRUSTLESS-IDENTITY.md`.
