# M4 build log — Indexer + richer feed (the L4 Tier-B read layer)

**Status: DONE — proven locally (2026-06-17).** A self-hosted **SubQuery** indexer (DR-27) ingests
cogno-chain's public events into Postgres and serves a **paginated, searchable, by-identity,
threaded** feed over **GraphQL**, with **operator revoke/ban surfaced** on the feed — while the
existing **PAPI-direct** read path stays the credibly-neutral fallback (endpoint-as-config, zero
on-chain change). The **L4-M4c re-derivation gate passes**: an independent fold of the public events
from genesis reproduces the served entities **byte-for-byte** (A == B) — each post's `{author, text,
parent, blockHeight, deleted}` and each author's `{banned, identityHash, weight, postCount}` — so
"open reads / anyone can reproduce the feed" is a *tested* property, not a slogan (the honest scope +
what's not-yet-folded is in §3 and *Honest limits* below). `docs/L4-reading.md` §3/§4/§6/§11; PLAN §8
(M4 row), §9; DR-27, DR-14b, DR-08.

## What M4 is

L4 is the **read/serve** layer. M0–M3 built the chain + the two Cardano links + a PAPI-direct
frontend feed (`watchEntries`). M4 adds **Tier B**: an indexer → Postgres → GraphQL for the queries
PAPI can't do cheaply — recency-paginated whole-feed with stable cursors, case-insensitive substring
search (`includesInsensitive`/ILIKE — the v1 implementation; not the `@fullText`/tsvector search L4
§4.1 anticipates), materialized threads, profile-by-identity joins, and ban/revoke surfacing. **Same on-chain events,
so zero runtime change** (spec_version stays **104**; confirmed — the indexer only reads existing
events). Reads **never touch Cardano** (L4 hard invariant). No indexer is the source of truth: it is
a replaceable cache over public on-chain truth, and the PAPI-direct path is the structural fallback.

### Decision: the REAL SubQuery path (no Docker needed)

The brief flagged an infra check. **Docker daemon is down on this box (no passwordless sudo, user
not in the `docker` group), but SubQuery does NOT need Docker** — it runs fine as local processes
(`@subql/node` + `@subql/query`) against the already-running **Postgres 16** cluster. So this is the
*real* indexer path, not the documented-only fallback. The one Postgres prerequisite —
`btree_gist` (for SubQuery's historical `_block_range` GiST exclusion constraint) — is a **trusted
extension in PG16**, so a non-superuser DB owner can `CREATE EXTENSION` it. The PAPI-direct baseline
is still shipped and kept as the fallback (DR-27), exactly as L4 requires.

## The three parts (all done + verified)

### 1. The SubQuery project — `services/indexer/`

A self-hosted SubQuery project, RPC-only (a custom solochain is in no dictionary): **no `dictionary`,
no `chaintypes`** — the runtime emits metadata V14+, so `@polkadot/api` auto-decodes every custom
pallet event/storage.

- **`schema.graphql`** — the **published open schema** (L4 §4.1 / §6.2.1, the convergence contract,
  versioned to spec 104). `Author { id(ss58), identityHash, banned, weight, postCount, posts }`,
  `Post { id(u64 string), author, text, parent(self-rel), replies, blockHeight, timestamp, deleted }`,
  `Thread { id, root, replyCount, lastActivity }`.
- **`project.ts`** — TS manifest (`specVersion 1.0.0`). `network.chainId` = the chain's **genesis
  hash** `0x41467cdc…65cd` (the chain-identity pin; a fresh `--dev` rebuild changes it — re-capture,
  never hardcode beyond the pin). Five event handlers: `Microblog.PostCreated`/`PostDeleted`,
  `CognoGate.IdentityLinked`/`Revoked`, `TalkStake.StakeSet`. (Module names are camelCase
  `microblog`/`cognoGate`/`talkStake`; methods are the PascalCase event variants.)
- **`src/mappings/mappingHandlers.ts`** — the deterministic event→entity mapping. The key move:
  **`PostCreated{id,author}` carries no body**, so the handler does a **storage read**
  `api.query.microblog.posts(id)` *at the event's block* (the global `api` is an at-block
  `ApiDecoration`; `--state-pruning archive` guarantees the row is readable) to get `text`/`parent`.
  `PostDeleted` → **soft-delete** (`deleted = true`, row KEPT — preserves thread structure +
  reproducibility; the pinned convergence policy, L4 §4.1). `IdentityLinked` → set `identityHash`,
  `banned = false`. `Revoked` → `banned = true` (revoke leaves posts on-chain by design, so the
  feed must *flag* the author, not drop the posts). `StakeSet` → `weight`.
- Postgres connection: `@subql/node` builds a connection **URL**, so a unix-socket-dir host is
  rejected (`TypeError: Invalid URL`) → connect over **TCP `127.0.0.1` (scram)** as an isolated
  `cogno` role (creds in gitignored `.env`). `@subql/node` also **refuses to start unless
  `TZ=UTC`**. The query service needs a **single `graphql` version** — `@subql/cli` hoists
  `graphql@16` while `@subql/query`/postgraphile need `graphql@15`, so `package.json` pins
  `"overrides": { "graphql": "15.10.2" }`.

Run scripts (portable; `.env` holds DB creds; node on PATH via nvm v22.12.0):
`run-indexer.sh` (`@subql/node -f . --db-schema=cogno --port=3001`, finalized-only by default —
deterministic for M4c; `--unfinalized-blocks=true` for an instant pre-finality feed with reorg
rollback) and `run-query.sh` (`@subql/query --name=cogno --playground --port=3000`).

### 2. The frontend — GraphQL feed source behind the existing seam (`app/`)

A `FeedSource` abstraction reads through the indexer when a GraphQL endpoint is configured, and
falls back to PAPI-direct otherwise — all behind the existing `lib/types.ts` seam, so the change is
**additive** (`reads.ts` / `watchFeed` are untouched and stay the fallback). `npm run build` is green
(static export, 194 kB First Load JS).

- **`lib/feed/source.ts`** — the `FeedSource` interface: `kind: 'papi'|'graphql'`, `caps
  {search,pagination,threads,revocation}`, `watch(): Observable<FeedSnapshot>` (live),
  `page(FeedQuery)`/`thread(rootId)`/`profile(args)` (request/response) + an `UnsupportedQuery` error.
  The asymmetry is honest: PAPI is live-rxjs and can't paginate/search; GraphQL does both.
- **`lib/feed/index.ts`** — `makeFeedSource(api, graphqlUrl)`: non-empty URL ⇒ the indexer reader,
  else PAPI-direct. **The indexer is never load-bearing** — clearing the endpoint always falls back.
- **`lib/feed/papi-source.ts`** — wraps `reads.ts` (`watchFeed`/`buildThreadIndex`/`getPost`)
  unmodified. Revocation = `CognoGate.PkhOf[acct]` **absent** (chain truth — revoke removes the
  binding, leaves the posts); profile-by-identity via the reverse `CognoGate.AccountOf`; weight via
  `TalkStake.AllowedStake`. `caps.search`/`caps.pagination` = **false** → `page()` throws
  `UnsupportedQuery` for `search`/`after`.
- **`lib/graphql/{client,queries,feed-source}.ts`** — `gqlRequest<T>()` is plain `fetch` (no Apollo)
  with a typed `GraphqlError` (network/http/graphql) so a CORS/unreachable indexer surfaces honestly
  instead of blanking the feed. `queries.ts` holds the **verified** postgraphile query strings
  (cursor `edges`/`pageInfo`, `includesInsensitive` search, `@derivedFrom` relation names
  `posts`/`replies`). `feed-source.ts` does all node→`CognoPost` mapping at the boundary: **BigInt
  ids** (u64, never via `Number`), **`at = blockHeight`** (not the timestamp), `deleted`, and
  `authorRevoked = author.banned`. `watch()` is a poll-backed Observable (`timer(0, 6s)` →
  abortable fetch of recent `first:50`) and is **resilient**: each poll is wrapped in `catchError`
  so a transient indexer/CORS blip retains the last good snapshot and self-heals on the next tick
  instead of permanently terminating the rxjs stream (persistent outages still surface on the
  interactive search/load-more path, which throws a typed error).
- **Endpoint-as-config (DR-27):** `lib/config/endpoints.ts` gains `getGraphqlUrl()/setGraphqlUrl()`
  (key `cogno.graphql`, default `""`, SSG-safe); `EndpointSettings.tsx` adds a separate single-line
  GraphQL field ("leave empty to read directly from the node (PAPI) — slower, no search"); the WS
  list is unchanged. `page.tsx` rebuilds the source on endpoint change and shows an honest
  **"reads: indexer" vs "reads: direct node"** indicator (the best-vs-finalized `ProvenanceLine`
  stays PAPI-driven — the chain is truth regardless of read source).
- **Views:** `SearchBar.tsx` (gated on `caps.search`); `Feed.tsx` gains a "load more" affordance +
  indexer-error notice in paginated mode (the live PAPI path unchanged); `PostItem.tsx` renders a
  mono "· revoked" marginalia tag (dimmed) for `authorRevoked` and a "(deleted)" tombstone — reusing
  `--cap-empty`/`--ink-400`, **no new colors** (revoked/deleted is not an error state). Profile +
  thread `FeedSource` methods are implemented and verified, ready to wire to a future route.

### 3. The L4-M4c re-derivation gate — `services/indexer/verify-m4c.mjs`

The COMMITTED v1 acceptance test (DR-08 / L4 §6.5, §11). It imports **zero indexer code** (no
schema, no mappings, no DB): using `@polkadot/api` against the **archive** node, it walks the chain
from genesis, folds the **public** `Microblog`/`CognoGate`/`TalkStake` events into a Post set + an
author state (the same deterministic fold any third party would run), then diffs it **byte-for-byte**
against what the indexer SERVES over GraphQL — over the **union** of ids on both sides, so neither
side can hide an extra row. It compares each post's `{author, text, parent, blockHeight, deleted}`
and each author's `{banned, identityHash, weight, postCount}`. Three guards make the comparison
sound: (1) **chain identity** — the live node genesis *and* the indexer's `_metadata.genesisHash`
must both equal the published `GENESIS.txt` pin; (2) **caught-up** — the indexer's
`_metadata.lastProcessedHeight` must be ≥ the node's finalized head (else the two are unsynchronized
snapshots) and `indexerHealthy`; (3) any field/count mismatch is a **HARD FAIL**. *Not* folded:
`Post.timestamp` (block wall-clock) and the `Thread` convenience aggregate (a derived view; the feed
reads the faithful `Post.parent → replies` relation, not `Thread`) — see *Honest limits*.

## Live acceptance (local)

**Stack:** archive node `cogno-chain-node --dev --base-path /tmp/cogno-m4 --state-pruning archive
--blocks-pruning archive --rpc-port 9944` (genesis `0x41467cdc…65cd`, spec 104) → `@subql/node`
(:3001) → Postgres `cogno_indexer` (schema `cogno`) → `@subql/query` GraphQL (:3000).

**Seed** (`app/scripts/m4-seed.mjs` + `m4-seed-finish.mjs`, built on `grant-weight.mjs`): 10 posts
(ids 0–9) — 5 top-level, 3 threaded replies (#5,#6 → #0; #7 → #1), 2 by a **revoked** author
(`5F1bzCuT…MatWVt`); `delete_post(#4)` (soft-delete); 6 `IdentityLinked`; `Revoked` of the demo
author; 6 `StakeSet`.

**GraphQL acceptance (real queries against :3000):**
- Global feed, cursor-paginated: `posts(first, after, orderBy: ID_DESC, filter:{deleted:{equalTo:false}})`
  → `totalCount 9` (10 − 1 deleted), `pageInfo{hasNextPage,endCursor}`, `edges{cursor,node}` ✓.
- Search: `filter:{text:{includesInsensitive:"reply"}}` → the 3 replies ✓.
- Profile-by-identity: `authors(filter:{identityHash:{equalTo:"0x309f…d347"}})` → the revoked author,
  `banned: true`, her 2 posts ✓.
- Thread: `post(id:"0"){ replies(orderBy:ID_ASC){ nodes{ id parent{id} } } }` → 2 replies ✓.
- Soft-delete: post #4 returns with `deleted:true` (kept), excluded by the feed filter ✓.

**Frontend (`app/`):** `npm run build` green (static export, 194 kB First Load JS). The GraphQL
feed source verified live against `:3000` — page-1 feed returns the 9 non-deleted posts (bigint ids,
`at===blockHeight`), `search:"ledger"` → 1 match, posts #8/#9 carry `authorRevoked`, thread(0) → 2
replies, profile-by-identity resolves the revoked author `banned===true`. With an empty GraphQL
endpoint the app reads PAPI-direct (`watchFeed`) exactly as in M1–M3; setting `http://localhost:3000/`
activates the indexer path; clearing it falls back.

**L4-M4c gate (`node verify-m4c.mjs`):**
```
live node genesis : 0x41467cdca29a25549388e5f2f387fc2dd54fce7000d494d2578cbd0afcce65cd
indexer genesis   : 0x41467cdca29a25549388e5f2f387fc2dd54fce7000d494d2578cbd0afcce65cd
published pin     : 0x41467cdca29a25549388e5f2f387fc2dd54fce7000d494d2578cbd0afcce65cd
indexer health    : healthy=true lastProcessed=568 target=568 nodeFinalized=566
folding public events from genesis → #566 (indexer-processed snapshot) …
re-derived 10 posts, 6 authors from events
  ✓ #0 … ✓ #4 (deleted) … ✓ #5 ↳#0 … ✓ #7 ↳#1 … ✓ #9
  ✓ author 5GrwvaEF… postCount=3 weight=10000000 bound=y   (…Bob/Charlie similarly)
  ✓ author 5HGjWAeF… postCount=0 weight=null bound=y        (bound, never staked — matches both sides)
  ✓ author 5F1bzCuT… banned (revoked), state matches
🎯 M4c VERIFIED — posts {author,text,parent,blockHeight,deleted} + authors
   {banned,identityHash,weight,postCount} are byte-for-byte reproducible from genesis (A == B).
```
All 10 posts (incl. the #4 tombstone + the threading) and all 6 authors' full state reproduced exactly
from the public event log — over the union of ids on both sides, with the chain-identity + caught-up
guards holding. "Open reads" is honestly backed at launch (scoped per *Honest limits*).

## Reproducibility artifacts (M4c / DR-08)

- `services/indexer/GENESIS.txt` — the published genesis-hash pin (committed).
- `services/indexer/chainspec.dev.raw.json` — the exported raw chainspec (gitignored, ~825KB;
  regenerable: `cogno-chain-node export-chain-spec --chain dev --raw`). An independent verifier syncs
  an archive from this spec; the genesis must match the pin.

## Honest limits (L4 §6.3–§6.5, §7.4, §8 — carried, not dropped)

M4 makes "open reads" a *tested* property, but the L4 honest posture must travel with the claim:

- **Reproducible ≠ effortless.** "Anyone CAN run an indexer and reproduce the feed" is an **exit
  option**, not a free lunch — running Postgres + indexer + GraphQL 24/7 costs money, and a custom
  solochain is in no decentralized archive (RPC-only sync). The median user hits a hosted endpoint;
  the guarantee is verifiability + permissionless reproduction + fallback, not that everyone
  self-hosts (L4 §6.4/§7.4).
- **Soft re-centralization is real.** A frontend everyone points at ONE indexer makes that endpoint
  a de-facto read authority + single point of failure (it can omit/reorder/delay/censor) even though
  L3 stays open. M4's defenses are **structural, not a promise**: the published open schema +
  mapping, **endpoint-as-config** (the GraphQL field), and the **PAPI-direct fallback** that is never
  load-bearing (clear the endpoint → read the node directly). (L4 §6.3.)
- **Data availability is the load-bearing dependency** (L4 §6.5 / DR-08) — the indexer is
  replaceable; archived history is not. M4 runs a `--state-pruning archive` node + publishes the
  genesis pin + chainspec, and the M4c gate tests re-derivation against it. The residual risk is
  **operational** (the operator must keep the archive node up + reachable), not an open who/whether.
- **What M4c does NOT yet fold** (the byte-for-byte claim is scoped to what's checked): `Post.timestamp`
  (block wall-clock) and the `Thread` convenience aggregate. The feed's thread view does not depend on
  `Thread` (it uses the faithful `Post.parent → replies` relation), and `Thread` is keyed on the
  **immediate parent**, not the transitive conversation root for depth-2+ replies — a known limitation
  of an unconsumed convenience entity, documented in `schema.graphql`.
- **Search is substring, not full-text.** v1 uses `includesInsensitive` (Postgres ILIKE) — no
  tsvector/stemming/ranking. `@fullText`/`searchPost` (L4 §4.1) is the scale upgrade, not yet wired.
- **Finality.** The indexer indexes **finalized** blocks by default (deterministic → the M4c
  property); the live PAPI `watchFeed` reads `best`, so a just-posted message can appear in the
  PAPI-direct feed before the indexer. `--unfinalized-blocks=true` trades that for instant indexing
  with reorg rollback (requires historical, on by default).

## Notes

- **Dev-server port collision:** the app's `npm run dev` uses port **3000** and the SubQuery GraphQL
  endpoint also defaults to **3000**. To run both locally at once, move one (e.g. `next dev -p 3002`,
  or run the query service on another port and update the configured GraphQL endpoint). The
  static-export build is unaffected.
- **Out-of-scope working-tree change:** `contracts/aiken.toml` carries an unrelated `aiken-lang/stdlib`
  bump (`v2.2.0 → v3.1.0`) from prior L1 work — **not part of M4** (a pure read-layer change, no
  runtime/contract change). Keep it out of any "M4" commit (or split it out + recompile/re-verify L1).

## Gotchas recorded (M4-specific)

- **`@subql/node` builds a Postgres connection URL** → `DB_HOST` must be a TCP host, **not** a
  unix-socket path (`/var/run/postgresql` → `TypeError: Invalid URL`). Use `127.0.0.1` + a role with
  a scram password.
- **`TZ=UTC` is mandatory** — `@subql/node` aborts at startup otherwise ("Environment Timezone is
  not set to UTC").
- **Duplicate `graphql` module** — `@subql/cli` (build tool) pulls `graphql@16`, the query
  runtime needs `graphql@15` → Apollo throws "Cannot use GraphQLSchema … from another module or
  realm". Fix: `"overrides": { "graphql": "15.10.2" }` in `package.json`.
- **SubQuery globals in the TS build** — `api`/`store`/`logger` are runtime globals declared in
  `@subql/types`; add `src/global.d.ts` (`import "@subql/types/dist/global"`) and do **not** restrict
  `tsconfig.compilerOptions.types`, or `subql build` fails with `TS2304: Cannot find name 'store'`.
  Keep `project.ts` out of the tsc `include` (it's evaluated separately) or `rootDir` conflicts.
- **`btree_gist` is required but trusted in PG16** — `CREATE EXTENSION btree_gist` needs only DB
  ownership, no superuser. (Alternatively `--historical=false` avoids it, but also disables
  `--unfinalized-blocks` + reorg rollback.)
- **Historical rows in raw tables** — with historical indexing on (default), the raw `posts`/`authors`
  tables hold multiple `_block_range`-versioned rows per id; the **GraphQL layer collapses to current
  state**. M4c compares the GraphQL (current) view, not raw rows.
- **`@derivedFrom` relation names** — SubQuery's GraphQL exposes reverse relations under the *schema*
  field names (`posts`, `replies`), NOT postgraphile's `postsByAuthorId`/`postsByParentId`.
- **Module-name casing in handler filters** — pallet → camelCase (`cognoGate`, `talkStake`); event →
  PascalCase (`IdentityLinked`).

## How to run (cold)

```bash
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"
# 1. archive node (stable genesis, full history)
./target/release/cogno-chain-node --dev --base-path /tmp/cogno-m4 \
  --state-pruning archive --blocks-pruning archive --rpc-port 9944 &
# 2. seed (binds/stakes dev accounts, then posts/replies/revoke/delete)
cd app && node scripts/grant-weight.mjs && node scripts/m4-seed.mjs && node scripts/m4-seed-finish.mjs && cd ..
# 3. one-time DB
createdb cogno_indexer && psql -d cogno_indexer -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'
#    (create the `cogno` login role + put creds in services/indexer/.env)
# 4. indexer + GraphQL
cd services/indexer && npm install && npx subql codegen && npx subql build
./run-indexer.sh &   # ingest → Postgres (:3001 admin)
./run-query.sh   &   # GraphQL + playground at http://localhost:3000/
# 5. the M4c gate
node verify-m4c.mjs  # 🎯 A == B
# 6. frontend: point the app's GraphQL endpoint at http://localhost:3000/ (empty = PAPI-direct fallback)
```
