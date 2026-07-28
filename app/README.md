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

Identity is a one-time **CIP-8 bind** (one Cardano owner Address ⇒ one app-chain account), plus a
second **stake bind** that unlocks stake-weighted voting power. Both are required before you can
write; both are **permanent**. The client reads **everything node-direct** — feed / thread / profile /
search over **PAPI** (`polkadot-api`) + the node's runtime read API — and reaches Cardano with
**MeshJS** (CIP-30 wallet + Blockfrost) for the L1 vault lock/exit. The chain is **observe-only**: it
reads Cardano, never writes back. No backend, no telemetry; it self-hosts on any static host
(`output: "export"`, see `next.config.mjs`). For the full project see the top-level
[`README.md`](../README.md); for the design, [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

This is what runs at **<https://cogno.forum>**.

## Run

**Use Node v22.12.0** — see `.nvmrc`. On this machine the system `node` is a snap build whose stdout
goes to `/dev/null`, which turns every script failure silent; `nvm use` (or prepend the nvm bin dir to
`PATH`) before touching anything here.

```bash
nvm use                     # or: export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"

cd app
npm ci                      # `postinstall` runs `papi` to generate the typed @polkadot-api/descriptors
npm run dev                 # http://localhost:3000 — points at the LIVE preprod chain, no config needed
npm run build               # static export → app/out/ (host it anywhere; nothing server-side)
```

`npm run dev` needs no configuration: with `NEXT_PUBLIC_WS_URL` unset the app connects to
`wss://cogno.forum/rpc`, the public preprod endpoint, so a fresh clone shows the real chain and real
posts on first load. Point it somewhere else by exporting `NEXT_PUBLIC_WS_URL`, or from **Settings** in
the running app — the setting is per-browser and always wins over the build-time default.

To run it against your own node instead — a throwaway `cogno-chain-node run --dev` on
`ws://127.0.0.1:9944`, or a local node tracking the live chain (see
[`docs/LOCAL-FRONTEND.md`](../docs/LOCAL-FRONTEND.md)):

```bash
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:9944 npm run dev
```

The other gates, all of which CI runs:

```bash
npm run lint                # eslint (--max-warnings 0) + the CSS-token and spec_version checks
npm run typecheck           # tsc --noEmit over the whole project, not just the bundled graph
npm test                    # vitest
npm run smoke               # sanity-check a built app/out/
```

`npm run psi` audits the **deployed** site with Google PageSpeed Insights (7 guest-visible routes ×
mobile/desktop). It is not a CI gate and needs a `PAGESPEED_API_KEY` in `.env.local` or the repo-root
`.env` — the API answers `429` to anonymous callers. Two things about reading its output:

```bash
npm run psi                      # medians of 3 runs
npm run psi -- --label after --runs 5
npm run psi -- --origin http://localhost:3000
```

**The performance score is very noisy** — the home page has scored 93, 83 and 64 on three consecutive
runs of identical deployed bytes — which is why every route is sampled N times and the report prints
the min-max range beside the median. Read the range before believing a delta. `CLS` and the category
scores other than performance come back stable, so those are the ones to trust for a before/after.

**PageSpeed's sandbox does not proxy WebSockets**, so the chain connection always fails and no post
ever renders. That means `errors-in-console` can never pass (every error it collects is the browser's
own failed-WebSocket message, none originate in app code, and the audit fails on any error at all), and
anything measured on a chain-backed route is measuring the app's empty state. Real-user CLS is *higher*
than reported, because the skeleton-to-content swap PSI never triggers is a larger shift than the ones
it does see.

After a runtime `spec_version` bump the bundled PAPI descriptors go stale — regenerate them against a
node running the new runtime (`npm run lint` fails until you do):

```bash
rm .papi/descriptors/generated.json && npx papi add cogno -w ws://127.0.0.1:9944
```

`scripts/` holds the headless tooling (`check-tokens`, `check-spec`, `smoke-export`, the CIP-8 fixtures
the Rust tests and the CI oracle pin by name, and `verify-account-votes`). `scripts/cardano-reference/`
holds the Cardano drivers — the only working lock/exit drivers for the live preprod `talk_vault`, and
the provenance for the browser ports in `src/lib/cardano/`.

## Config surface

Every endpoint is **user-configurable** — neutrality is a requirement, so nothing is hardcoded except
a default you can replace. Settings persists to `localStorage` and always wins over the build-time
`NEXT_PUBLIC_*` seed, which wins over the built-in default.

| Setting | Build-time env | Default | What it is |
|---|---|---|---|
| WebSocket endpoint(s) | `NEXT_PUBLIC_WS_URL` | `wss://cogno.forum/rpc` | the app-chain node the SPA reads and writes through (PAPI) — the SOLE chain surface: feed / thread / profile / search all come from the node's `MicroblogApi` runtime read API |
| Blockfrost project id | `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | the Blockfrost project id the in-browser vault lock/exit txs use; empty ⇒ the lock action is hidden |
| Serve denylist (authors) | `NEXT_PUBLIC_DENY_AUTHORS` | *(empty)* | comma-separated ss58 addresses THIS deployment declines to render — posts, profile, search rows, mentions and all. Changes what the site serves, never the chain |
| Serve denylist (posts) | `NEXT_PUBLIC_DENY_POSTS` | *(empty)* | comma-separated post ids, same rule |

The first two are build-time seeds with a `localStorage` override the app reads on every call. There is
no UI that writes either one today — no node switcher, no provider field in Settings — so a deployment
sets them through the env.

The two denylists are **operator** config, not user config: they have no `localStorage` override, by
design (a visitor must not be able to edit them in their own browser, in either direction), and they are
inlined into the bundle and therefore public. They ship empty, and empty is a literal no-op — the read
seam returns the unwrapped source. A malformed entry fails a production build rather than being silently
dropped. This is the lever `POLICY.md` describes: it changes what **this site** shows, and nothing about
the chain, which every node still serves in full. See `src/lib/config/denylist.ts` and
`src/lib/feed/denylist-source.ts`.

A production `npm run build` will refuse a plaintext `ws://` pointed at a public host — an https page
mixed-content-blocks it, so the bundle would silently read nothing. `wss://`, or a `ws://127.0.0.1`
loopback for a local export, or leave it unset.

The Blockfrost project id is exposed client-side **by design**, so any visitor can lock from their own
wallet without a backend. It must be a key for the network *the chain names* — the app reads that from
`CognoGate.CardanoNetwork` / `CardanoRoles.CardanoNetwork` at boot and refuses a project id for a
different one rather than quietly building txs against the wrong ledger, so a preprod deployment takes
a preprod key and a mainnet one takes a mainnet key, with no frontend edit either way. Config lives in
`src/lib/config/endpoints.ts`; the network resolution lives in `src/lib/cardano/network.ts`.

## The dual-key model

cogno-chain separates **identity/stake** from **posting**, and the two are different keys:

- **Cardano CIP-30 wallet** (the identity + stake key). Connected in the browser. It signs the
  one-time **CIP-8 identity bind** (proving control of the owner Address → the 1:1 app-chain identity),
  the **CIP-8 stake bind** (proving control of the Cardano stake credential), and the L1 **lock /
  exit** transactions that put ADA into / pull ADA out of the `talk_vault`. The two Cardano-sourced
  weights are distinct: locking ADA in the vault earns **posting capacity** (`AllowedStake`), while the
  stake bind grants **voting/poll power** (`VotingPower` = the total Cardano stake of that credential).
  The ADA never leaves the owner's control — the vault is owner-reclaimable and exit is one click.
- **sr25519 posting key** (the spend key for the chain). Signs **every feeless post**. It is
  **sign-to-derive — nothing is stored**: the Cardano wallet signs one fixed, domain-separated CIP-8
  message; that signature (deterministic Ed25519) is `blake2b_256`'d into the seed for the sr25519
  posting key (`src/lib/signer/wallet-derive.ts` → `signerFromSeed` in `src/lib/signer/index.ts`). Same
  wallet ⇒ same posting account, re-derived each session by signing again — no mnemonic, no password,
  nothing to back up. (`//Alice…//Eve` dev accounts remain as a testing fallback.)

The threat model, stated plainly: the derived key signs **posts only** and never controls funds, so a
phished signature costs impersonation, never theft. But it **cannot be rotated** — the key is a pure
function of the wallet — and only the 3-of-5 committee can revoke a binding, which leaves a permanent
tombstone. It also does not defend against XSS on this origin once the key is in memory.

The two keys are bound 1:1 by the CIP-8 bind: one Cardano identity ⇒ one posting account, permanently.

## Trust posture

There are no on-screen "honesty badges" — the UI is chain-backed surfaces only. The posture they used
to encode still holds, and is documented in [`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): the
app-chain is a single operator-run node (its safety is the operator's Aura/GRANDPA, not Cardano's
finality); locking ADA earns capacity only once the on-chain observer writes your weight, so a
successful lock is "submitted", not "post now"; and Cardano is **observed, not bridged** — the chain
reads it (identity, weight, block clock) but never writes back and inherits none of its security. The
3-of-5 committee behind the privileged calls is real, but on a single-operator stack it is a shape, not
a guarantee.
