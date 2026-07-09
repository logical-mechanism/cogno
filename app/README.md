# cogno-chain frontend — a feeless social client

The Next.js 16 **static-export** SPA for cogno-chain: a dark-first, Twitter-style client where you
**post text and read text**, and everything is **feeless** — metered by Cardano-sourced *talk-capacity*
(lock ADA on Cardano → earn capacity) instead of per-action fees.

What it does:

- **Feed, explore, search** — a home timeline, a following timeline, and full-text search over posts
  and people.
- **Post, reply, quote, poll** — threaded replies, quote-with-comment, and stake-weighted polls.
- **Vote on posts *and* on accounts** — up/down votes weighted by your Cardano stake; account votes are
  a community anti-Sybil / anti-impersonation reputation signal shown on profiles and people rows.
- **Profiles and follows** — editable profiles (pinned post; Posts / Replies / Likes / Following tabs),
  follower/following lists with tappable counts, and who-to-follow.
- **Device-local bookmarks and mute/hide** — saved and muted lists live in your browser only (a public
  chain can't keep those private).

Identity is a one-time **CIP-8 bind** (one Cardano owner Address ⇒ one app-chain account), with an
optional second **stake bind** that unlocks stake-weighted voting power. The client reads
**everything node-direct** — feed / thread / profile / search over **PAPI** (`polkadot-api`) + the
node's runtime read API, no indexer and no follower — and reaches Cardano with **MeshJS** (CIP-30
wallet + Blockfrost) for the L1 vault lock/exit. The chain is **observe-only**: it reads Cardano, never
writes back. No backend, no telemetry; it self-hosts on any static host (`output: "export"`, see
`next.config.mjs`). For the full project see the top-level [`README.md`](../README.md); for the design,
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

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
| WebSocket endpoint(s) | `NEXT_PUBLIC_WS_URL` | `ws://127.0.0.1:9944` | the app-chain node the SPA reads/writes through (PAPI) — the SOLE read/write surface (feed / thread / profile / search served node-direct via the node's MicroblogApi read API; no indexer or follower) |
| Blockfrost project id | `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | the **preprod** Blockfrost project id the in-browser vault lock/exit txs use; empty ⇒ the lock action is hidden |

The Blockfrost project id is exposed client-side **by design** — so any visitor can lock from their
own wallet without a backend — and must be a **preprod** key. Config lives in
`src/lib/config/endpoints.ts`.

## The dual-key model

cogno-chain separates **identity/stake** from **posting**, and the two are different keys:

- **Cardano CIP-30 wallet** (the identity + stake key). Connected in the browser. It signs the
  one-time **CIP-8 identity bind** (proving control of the owner Address → the 1:1 app-chain identity),
  an optional second **CIP-8 stake bind** (proving control of the Cardano stake credential), and the L1
  **lock / exit** transactions that put ADA into / pull ADA out of the `talk_vault`. The two
  Cardano-sourced weights are distinct: locking ADA in the vault earns **posting capacity**
  (`AllowedStake`), while the stake bind grants **voting/poll power** (`VotingPower` = the total Cardano
  stake of that credential). The ADA never leaves the owner's control — the vault is owner-reclaimable
  and exit is one click.
- **sr25519 posting key** (the spend key for the chain). Signs **every feeless post**. Since M8 it
  is **sign-to-derive — nothing is stored**: the Cardano wallet signs one fixed, domain-separated
  CIP-8 message; that signature (deterministic Ed25519) is `blake2b_256`'d into the seed for the
  sr25519 posting key (`src/lib/signer/wallet-derive.ts` → `signerFromSeed` in
  `src/lib/signer/index.ts`). Same wallet ⇒ same posting account, re-derived each session by signing
  again — no mnemonic, no password, no `localStorage` ciphertext, nothing to back up. (`//Alice…//Eve`
  dev accounts remain as a testing fallback.) Honest threat model: the derived key signs **posts
  only** and never controls funds, so the worst case if it is phished is impersonation (revoke +
  re-derive), never theft — but it does **not** defend against XSS on this origin once derived in
  memory.

The two keys are bound 1:1 by the M2 CIP-8 bind: one Cardano identity ⇒ one posting account.

## Trust posture

The earlier on-screen "honesty badges" were **dropped** (locked design decision — cogno-brand +
Twitter-UX, chain-backed surfaces only). The posture they encoded still holds and is documented in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): the app-chain is a single operator-run node (its
safety is the operator's Aura/GRANDPA, not Cardano's finality); locking ADA earns capacity only once
the on-chain observer writes your weight, so a successful lock is "submitted", not "post now"; and
Cardano is **observed, not bridged** — the chain reads it (identity, weight, block clock) but never
writes back and inherits none of its security. The 3-of-5 committee behind the privileged calls is
real but **D2-SHAPED, not D2-TRUST** on a single-operator stack.
