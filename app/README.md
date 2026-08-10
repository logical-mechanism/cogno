# cogno-chain frontend — a feeless social client

The Next.js 16 **static-export** SPA for cogno-chain: a dark-first, Twitter-style client where you
**post text and read text**, and everything is **feeless** — metered by Cardano-sourced *talk-capacity*
(lock ADA on Cardano → earn capacity) instead of per-action fees.

What it does:

- **Feed, explore, search** — a home timeline (For you / Following), a discovery firehose, and search
  across post text and people. Hashtags are a client-side convention over the same search, with
  followable topics.
- **Post, reply, quote, poll** — threaded replies, quote-with-comment, and stake-weighted polls.
- **Governance polls** — action-tagged polls on `/governance/`, filterable by status, action type,
  deciding chamber and order, every axis in the URL. A poll's headline bars are read through one lens:
  own-stake for a `Stake` or `Governance` poll, and the SPO or dRep chamber directly for a
  single-chamber one. The chain accepts a vote from any bound account, but a chamber tally is folded
  from the voters' observed roles, so only a live role-holder's vote weighs anything there — this
  client disables the control for everyone else rather than record a vote that chamber will never see.
- **Vote on posts *and* on accounts** — up/down votes weighted by your Cardano stake; account votes are
  a community anti-Sybil / anti-impersonation reputation signal shown on profiles and people rows.
- **Verified role tags** — an SPO / dRep / Constitutional Committee chip on an identity line, written by
  the chain's observer rather than typed into a bio, and gone the moment the pool retires, the dRep
  deregisters, or the claim is released. SPO and dRep are claimable from Settings; a CC badge is
  display-only and carries no chamber weight.
- **Profiles and follows** — editable profiles (pinned post; Posts / Replies / Upvotes tabs),
  follower/following lists with tappable counts, and who-to-follow.
- **Notifications** — replies, likes, reputation votes, poll votes, follows and @mentions, folded
  client-side from the reverse indexes the chain already keeps. No server, no push, and the scan is
  bounded, so a capped read says so instead of pretending to be complete.
- **Device-local bookmarks, lists and mute/block/hide** — saved posts, account lists and moderation live
  in your browser only (a public chain can't keep those private), bucketed per account.

**Reading needs nothing.** A signed-out visitor browses the timeline, `/explore/`, `/governance/`, any
post, any profile, the legal/privacy/policy pages and the two purely device-local surfaces
(`/bookmarks/`, `/lists/`) with no wallet, no session and no chain identity — the chain socket is
independent of any wallet. Three segments are walled: `/compose/`, `/notifications/` and `/settings/`.
The wall does not redirect; it renders a "needs an account" notice in place of the page, inside the
shell, with a sign-in link that carries `?next=`. What it tests is a **bound identity**, not merely a
stored session: a connected wallet that has not completed the CIP-8 bind is still mid-signup and stays
outside. The route table is `src/lib/routeAccess.ts`, it fails closed, and a node test reads `src/app`
off disk and fails the build if any route is unclassified.

Identity is a one-time **CIP-8 identity bind**: one Cardano owner Address ⇒ one app-chain account.
Writing needs that bind **and** non-zero posting capacity from ADA locked in the L1 `talk_vault` — the
two gates the runtime itself enforces (`IdentityGate::is_allowed` and `CheckCapacity`), mirrored in the
client as `identity.bound === true && postingPower > 0n`. A **second, optional CIP-8 stake bind** proves
control of your Cardano stake key and is worth exactly vote weight: skip it and you can still post, your
votes just carry 0. Requiring it was a frontend policy that locked out every wallet that cannot sign
over a reward address, on a step the chain never asks for.

The identity bind is permanent from the account's side — there is no self-service unbind, and only the
3-of-5 committee can revoke one, which tombstones the identity so the eternally-valid proof cannot
re-bind it. The stake bind is not: `CognoGate.unlink_stake` is signed, self-service and feeless, though
this client ships no button for it.

The client reads **everything node-direct** — feed / thread / profile / search over **PAPI**
(`polkadot-api`) and the node's `MicroblogApi` runtime read API — and reaches Cardano with **MeshJS**
(CIP-30 wallet + Blockfrost) for the L1 vault lock/exit, plus Blockfrost REST for pool, dRep and
governance-action metadata. The chain is **observe-only**: it reads Cardano, never writes back. No
backend, no telemetry; it self-hosts on any static host (`output: "export"`, see `next.config.mjs`). For
the full project see the top-level [`README.md`](../README.md); for the design,
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md).

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
posts on first load. Point it somewhere else by exporting `NEXT_PUBLIC_WS_URL` — that is the only way,
because there is no node switcher in the UI. The `localStorage` override that would beat it exists and
is read on every call, but nothing writes it; see [Config surface](#config-surface).

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

`scripts/` holds the headless tooling. Wired to an npm script: `check-tokens` and `check-spec` (both run
by `npm run lint`), `gen-licenses` (run by `prebuild`), `smoke-export`, `seed-fixtures`, `shoot`,
`check-overflow` and `psi`. Not wired to one: `m2-cip8-fixture.mjs` and `m2-cip8-stake-fixture.mjs` —
the CIP-8 proof minters the Rust tests and the CI oracle pin by name — and `verify-account-votes.mjs`.
`scripts/lib/` carries the shared Chromium and nginx-accurate export-server harness, `scripts/fixtures/`
the adversarial seed catalogue.

`npm run shoot` (screenshots) and `npm run check:overflow` (nothing scrolls sideways) drive the **built**
export in Chromium and need `npx playwright install chromium` once per machine; `npm ci` does not
download browsers, and neither script runs in CI.

`scripts/cardano-reference/` holds the node-side Cardano drivers for the preprod `talk_vault`. They are
frozen legacy demo tooling that needs a local db-sync plus Ogmios, and they are the provenance for the
browser ports in `src/lib/cardano/` — in the product, locking and exiting happen through the in-browser
CIP-30 flow, not here.

## Config surface

Neutrality is a requirement, so no host is hardcoded except a default you can replace. Resolution order
is `localStorage` override → build-time `NEXT_PUBLIC_*` seed → the built-in default. There are four
`NEXT_PUBLIC_*` vars in total.

| Setting | Build-time env | Default | What it is |
|---|---|---|---|
| WebSocket endpoint(s) | `NEXT_PUBLIC_WS_URL` | `wss://cogno.forum/rpc` | the app-chain node the SPA reads and writes through (PAPI) — the SOLE chain surface: feed / thread / profile / search all come from the node's `MicroblogApi` runtime read API |
| Blockfrost project id | `NEXT_PUBLIC_BLOCKFROST_PROJECT_ID` | *(empty)* | the Blockfrost project id the in-browser vault lock/exit txs use; empty ⇒ the lock action is hidden |
| Serve denylist (authors) | `NEXT_PUBLIC_DENY_AUTHORS` | *(empty)* | comma-separated ss58 addresses THIS deployment declines to render — posts, profile, search rows, mentions and all. Changes what the site serves, never the chain |
| Serve denylist (posts) | `NEXT_PUBLIC_DENY_POSTS` | *(empty)* | comma-separated post ids, same rule |

The first two are build-time seeds with a `localStorage` override (`cogno.endpoints`, `cogno.blockfrost`)
that the app reads on every call. **No UI writes either one** — `setEndpoints`, `setBlockfrostProjectId`
and `useChain.reconnect(url)` have zero callers, so there is no node switcher and no provider field in
Settings, and a deployment configures itself through the env.

The two denylists are **operator** config, not user config: they have no `localStorage` override, by
design (a visitor must not be able to edit them in their own browser, in either direction), and they are
inlined into the bundle and therefore public. They ship empty, and empty costs one `Array.filter` per
page over a predicate that returns false on its first line — the read seam wraps unconditionally,
because a runtime `/denylist.json` can land after the moment a wrap-or-not decision would have been
made. A malformed entry fails a production build rather than being silently dropped. On top of the
baked entries the app fetches an optional `/denylist.json` once at boot (nginx
maps it to `/etc/cogno/denylist.json`), which fails **open**: a 404 is the normal state and is silent,
and malformed entries there are logged and dropped rather than thrown, so the durable entries belong in
the env vars. This is the lever [`POLICY.md`](../POLICY.md) describes: it changes what **this site**
shows, and nothing about the chain, which every node still serves in full. See
`src/lib/config/denylist.ts` and `src/lib/feed/denylist-source.ts`.

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
  the **optional CIP-8 stake bind** (proving control of the Cardano stake credential), and the L1
  **lock / exit** transactions that put ADA into / pull ADA out of the `talk_vault`. The two
  Cardano-sourced weights are distinct: locking ADA in the vault earns **posting capacity**
  (`AllowedStake`), while the stake bind grants **voting/poll power** (`VotingPower` = the total Cardano
  stake of that credential). The ADA never leaves the owner's control — the vault is owner-reclaimable
  and exit is one click.
- **sr25519 posting key** (the spend key for the chain). Signs **every feeless post**. It is
  **sign-to-derive — nothing is stored**: the Cardano wallet signs one fixed, domain-separated CIP-8
  message; that signature (deterministic Ed25519) is `blake2b_256`'d into the seed for the sr25519
  posting key (`src/lib/signer/wallet-derive.ts` → `signerFromSeed` in `src/lib/signer/index.ts`). Same
  wallet ⇒ same posting account, re-derived each session by signing again — no mnemonic, no password,
  nothing to back up. (`//Alice…//Eve` dev accounts survive as a programmatic fallback; no UI reaches
  them.)

A **role key** is a third thing and deliberately outside both. It is usually offline, so each Settings →
Verified roles card bakes a fully-pinned `cardano-signer` command to run on the key machine and
pre-flights the pasted-back COSE blobs before submitting the feeless claim. A dRep may sign in-wallet
instead where the wallet supports CIP-95.

Only PUBLIC fields are persisted: `cg-session` in `localStorage` holds the CIP-30 wallet id, the Cardano
address (bech32 plus its raw hex form) and the posting account's ss58 and sr25519 public key — never the
COSE signature and never the seed, which IS the mini-secret. A restored session rebuilds a lazy signer
that can encode an extrinsic immediately and asks the wallet for one prompt at signing time, checking
the re-derived key still reproduces the same ss58 so an in-wallet account switch cannot go unnoticed.

The threat model, stated plainly: the derived key signs **posts only** and never controls funds, so a
phished signature costs impersonation, never theft. But it **cannot be rotated** — the key is a pure
function of the wallet — and only the 3-of-5 committee can revoke an identity binding, which leaves a
permanent tombstone. It also does not defend against XSS on this origin once the key is in memory.

The two keys are bound 1:1 by the CIP-8 identity bind: one Cardano identity ⇒ one posting account,
permanently.

## Trust posture

There are no on-screen "honesty badges" and no block-number chrome on the feed surfaces — the UI is
chain-backed surfaces only. The posture they used to encode still holds, and is documented in
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md): the app-chain is a single operator-run node (its
safety is the operator's Aura/GRANDPA, not Cardano's finality); locking ADA earns capacity only once the
on-chain observer writes your weight, so a successful lock is "submitted", not "post now"; and Cardano
is **observed, not bridged** — the chain reads it (identity, locked-ADA weight, stake voting power, role
tags, block clock) but never writes back and inherits none of its security. The 3-of-5 committee behind
the privileged calls is real, but on a single-operator stack it is a shape, not a guarantee.

The one thing the app does report, because a frozen observer is otherwise invisible from the client, is
the observer's own state. The observer inherent is the sole writer of capacity, voting power and role
badges; if it stalls, blocks keep arriving, the socket stays up, the feed keeps moving and nothing else
would say a word. So Settings → Diagnostics reads `CardanoObserver` storage directly and shows the
connection, the Cardano read, credential-scan coverage, the genesis hash (click to copy), the network
version and the block heights — and the same read backs the notices at the write sites, instead of
telling someone who just locked 100 ADA that "it should still land". Nothing in Diagnostics is editable
and nothing there is a secret.
