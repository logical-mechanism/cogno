# cogno-chain frontend — the Reading Room / Civic Ledger

The Next.js 14 **static-export** SPA for cogno-chain: a "post text / read text" interface styled as
a **Reading Room** (the feed) over a **Civic Ledger** (the on-chain provenance — identity binding,
Cardano-sourced talk capacity, and the Cardano anchor are all visible, not hidden). It talks to the
app-chain with **PAPI** (`polkadot-api`) and to Cardano with **MeshJS** (CIP-30 wallet + Blockfrost).
There is no backend and no telemetry — it self-hosts on any static host (`output: "export"`, see
`next.config.mjs`). For the full project, see the top-level [`README.md`](../README.md); for the
design, [`docs/L5-frontend.md`](../docs/L5-frontend.md).

## Run

**Use the nvm node, not the snap node.** The system `node` here is a snap build whose stdout is
`/dev/null`; prepend the nvm node to `PATH` first:

```bash
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"

cd app
npm install        # `postinstall` runs `papi` to generate the typed @polkadot-api/descriptors
npm run dev        # dev server on http://localhost:3000, points at ws://127.0.0.1:9944 by default
npm run build      # Next.js static export → app/out/ (self-hostable on any static host / IPFS)
```

`npm run dev` expects a cogno-chain `--dev` node on `ws://127.0.0.1:9944` (see the top-level
README's "Stand up the stack"). After a runtime `spec_version` bump the bundled PAPI descriptors go
stale — regenerate them against a live node:

```bash
rm .papi/descriptors/generated.json && npx papi add cogno -w ws://127.0.0.1:9944
```

There are also headless verification scripts under `scripts/` (e.g. `e2e-m7-browse.mjs`, the M2d
lock/bind/post drivers) used by the build logs.

## Config surface

Every endpoint is **user-configurable** (neutrality is a v1 requirement — no hardcoded "blessed"
node) and persisted in `localStorage`. A build can ship its own defaults via `NEXT_PUBLIC_*`
(inlined at build time); a user override in **Settings** always wins over the build-time default,
which wins over the localhost fallback.

| Settings field | Build-time env | Default | What it is |
|---|---|---|---|
| WebSocket endpoint(s) | `NEXT_PUBLIC_WS_URL` | `ws://127.0.0.1:9944` | the app-chain node the SPA reads/writes through (PAPI) |
| Follower URL | `NEXT_PUBLIC_FOLLOWER_URL` | `http://127.0.0.1:8090` | the trusted v1 cogno-follower the CIP-8 bind POSTs to |
| GraphQL indexer URL | `NEXT_PUBLIC_GRAPHQL_URL` | *(empty)* | the optional SubQuery indexer for feed/search/threads; empty ⇒ read directly from the node (PAPI-direct) |
| Blockfrost project id | `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | the **preprod** Blockfrost project id the in-browser vault lock/exit txs use; empty ⇒ the lock action is hidden |

The Blockfrost project id is exposed client-side **by design** — so any visitor can lock from their
own wallet without a backend — and must be a **preprod** key. Config lives in
`src/lib/config/endpoints.ts`.

## The dual-key model

cogno-chain separates **identity/stake** from **posting**, and the two are different keys:

- **Cardano CIP-30 wallet** (the identity + stake key). Connected in the browser. It signs the
  one-time **CIP-8 bind** (proving control of the owner Address → the 1:1 app-chain identity) and
  the L1 **lock / exit** transactions that put ADA into / pull ADA out of the `talk_vault`. Locking
  ADA is what earns talk capacity. The ADA never leaves the owner's control — the vault is
  owner-reclaimable and exit is one click.
- **sr25519 posting key** (the spend key for the chain). Signs **every feeless post**. It can be a
  well-known dev account, a memory-only session key, or — since M8 — a durable key restored from the
  **hardened encrypted keystore**: the mnemonic is held as PBKDF2(310k) → AES-GCM-256 ciphertext in
  `localStorage`; only ciphertext + salt + iv are stored, and unlocking it requires the password
  each session. (`src/lib/signer/keystore.ts`. Honest threat model: this protects the key **at
  rest** — a stolen storage dump is useless without the password — but it does **not** defend
  against XSS on this origin once unlocked. Treat it as a convenience posting key, not cold storage.)

The two keys are bound 1:1 by the M2 CIP-8 bind: one Cardano identity ⇒ one posting account.

## The honesty badges

The UI states its trust limits plainly, on-screen, as small bordered mono badges
(`src/components/HonestyBadge.tsx`) — not alarming, not hidden. Each label is the on-screen claim;
hovering shows the plain-language detail. They encode the "usable ≠ trustless" posture:

| Badge | What it means |
|---|---|
| `chain: operator-run (v1)` | the app-chain is a single operator-run node — its safety is the operator's Aura/GRANDPA, not Cardano's finality |
| `follower: trusted (v1)` | the cogno-follower is a single trusted party that both verifies the CIP-8 proof and writes the binding/weight |
| `capacity: follower-metered (v1)` | locking ADA earns capacity only **after** the trusted follower observes the lock on Cardano and writes your weight — a successful lock is "submitted", not "you can post now" |
| `anchor: evidence, not enforcement` | the Cardano anchor lets a third party **detect** a silent history rewrite after the fact; it cannot prevent a bad block, fork, or censorship |

These mirror the prose posture in the service READMEs and `docs/DECISION-REGISTER.md` (DR-07). The
3-of-5 committee path that backs the privileged calls is real but **D2-SHAPED, not D2-TRUST** on a
single-operator stack.
