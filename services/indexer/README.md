# cogno-indexer — the L4 Tier-B SubQuery indexer

Self-hosted **SubQuery** indexer for cogno-chain (DR-27, the published reference indexer). It folds
the chain's public `Microblog` / `Profile` / `CognoGate` / `TalkStake` events into Postgres and serves
a **paginated, searchable, by-identity, threaded** feed over GraphQL **plus the Twitter-like social
surface** — stake-weighted votes + polls, reposts, quotes, the follow graph, and profiles/pinned posts
— with **operator revoke/ban** surfaced. PAPI-direct stays the v1 baseline + structural fallback (the
frontend reads this only when a GraphQL endpoint is configured). **Reads never touch Cardano.** Full
write-up: `docs/M4-build.md`; spec: `docs/L4-reading.md`.

Versioned to runtime **spec_version 113** (the social features + the project's first storage migration,
`Post.quote`). Note: `delete_post` was removed (content is a permanent ledger), so there is no
`PostDeleted` handler and **no `Post.deleted` field** — a frontend that wants to hide content filters
client-side.

## Files

- `schema.graphql` — the published open entity schema, versioned to runtime spec 113. Entities:
  `Author` (+ profile fields, follow counts), `Post` (+ quote, isPoll, stake-weighted vote tally,
  score, repostCount), `Vote`, `Repost`, `Follow`, `Poll`, `PollOption`, `PollVote`, `Thread`.
- `project.ts` — manifest: `chainId` = genesis pin (env-driven: `CHAIN_ID`/`GENESIS`, `WS_ENDPOINT`/`WS`),
  RPC-only (no dictionary/chaintypes), 16 event handlers (microblog ×8, profile ×4, cognoGate ×2, talkStake ×1).
- `src/mappings/mappingHandlers.ts` — the deterministic event→entity fold (storage-reads for post
  body/quote, poll options, profile; the **event-only** stake-weighted reverse-then-apply tally fold; ban flag).
- `src/mappings/pure.ts` (+ `pure.test.ts`) — the pure, unit-tested fold arithmetic (saturating
  reverse-then-apply for votes + poll votes, vote-dir normalization, score).
- `verify-m4c.mjs` — the **L4-M4c** gate: independent re-derivation from genesis == served feed
  (byte-for-byte), covering posts/authors **and** the full social surface incl. the weighted tallies.
- `social-seed.mjs` — generates one of every social event on a fresh `--dev` node (binds via CIP-8,
  weights, then drives posts/votes/reposts/follows/polls/profiles/pins) so the indexer + gate have data.
- `GENESIS.txt` — the published genesis-hash pin (DR-08).
- `run-indexer.sh` / `run-query.sh` — local run (no Docker; Postgres over TCP).

## Run (no Docker)

```bash
export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"   # node v22

# one-time DB (Postgres 16 already running): a DB + the trusted btree_gist extension + a login role
createdb cogno_indexer
psql -d cogno_indexer -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'
# create the `cogno` login role with a scram password, ALTER DATABASE cogno_indexer OWNER TO cogno,
# then write the creds into .env (gitignored):  DB_USER/DB_PASS/DB_DATABASE/DB_HOST=127.0.0.1/DB_PORT

npm install
npx subql codegen     # schema.graphql -> src/types   (run BEFORE build — handlers import ../types)
npx subql build       # src -> dist/index.js (+ project.yaml; chainId/endpoint bake in from env here)

./run-indexer.sh      # ingest into Postgres (admin/health on :3001)
./run-query.sh        # GraphQL + playground at http://localhost:3000/

node verify-m4c.mjs   # the M4c re-derivation gate (A == B), incl. the social surface + weighted tallies
node --experimental-strip-types src/mappings/pure.test.ts   # the pure fold unit tests
```

To regenerate test data on a fresh `--dev` chain (then drop the `cogno` schema + reindex from genesis):

```bash
GENESIS=0x<dev block-0 hash> CHAIN_ID=0x<...> WS=ws://127.0.0.1:9944 node social-seed.mjs
psql -d cogno_indexer -c 'DROP SCHEMA IF EXISTS cogno CASCADE;'   # schema changed → no in-place migration
```

`run-indexer.sh` indexes **finalized** blocks by default (deterministic → the M4c reproducibility
property). Pass `--unfinalized-blocks=true` for an instant pre-finality feed with reorg rollback.

## Example queries (against http://localhost:3000/)

```graphql
# paginated global feed (newest first) with the stake-weighted vote tally + repost count
{ posts(first: 25, orderBy: ID_DESC) {
    totalCount pageInfo { hasNextPage endCursor }
    edges { cursor node { id authorId text parentId quoteId isPoll
      upWeight downWeight upCount downCount score repostCount author { id banned } } } } }

# search (case-insensitive substring)
{ posts(filter: {text: {includesInsensitive: "ledger"}}) { nodes { id text score } } }

# profile by identity hash (32-byte blake2b_256(owner Address), DR-01) + follow counts + profile
{ authors(filter: {identityHash: {equalTo: "0x…"}}) {
    nodes { id banned weight postCount followerCount followingCount displayName bio avatar pinnedPostId } } }

# a thread: root + its replies
{ post(id: "0") { id text replies(orderBy: ID_ASC) { nodes { id authorId text parent { id } } } } }

# a post's votes; and a poll with its options + per-option weights (Poll.id == the host post id)
{ post(id: "0") { id votes { nodes { voterId dir weight } } } }
{ poll(id: "4") { id options(orderBy: INDEX_ASC) { nodes { index label weight count } }
    votes { nodes { voterId option weight } } } }

# the follow graph + who an author follows / is followed by (reverse edges)
{ follows { nodes { followerId followeeId } } }
{ author(id: "5F…") { outgoingFollows { nodes { followeeId } } incomingFollows { nodes { followerId } } } }
```

## Notes / gotchas

See `docs/M4-build.md` for the full list. The load-bearing ones: TCP (not socket) Postgres host;
`TZ=UTC` required; `graphql` pinned to 15.10.2 via `overrides`; `src/global.d.ts` for the SubQuery
globals; `btree_gist` is trusted in PG16 (no superuser). A `spec_version` bump that changes encoding
requires re-running `subql codegen`/`build` in lockstep with PAPI.

- **Schema change ⇒ drop the `cogno` schema + reindex.** SubQuery does NOT auto-migrate a changed
  `schema.graphql` against an existing db-schema on a normal run (it only `CREATE TABLE IF NOT EXISTS`),
  so after editing entities: `psql -d cogno_indexer -c 'DROP SCHEMA IF EXISTS cogno CASCADE;'` then
  reindex from `startBlock: 1`. Do NOT enable `--allow-schema-migration` (it can't add non-null columns).
- **Non-null scalars have NO schema default** — every `Entity.create({...})` must pass them explicitly
  (e.g. `upWeight: 0n`, `followerCount: 0`); `.get()` round-trips preserve existing values.
- **Reverse-relation names avoid the count-orderBy collision.** The follow reverse edges are named
  `outgoingFollows`/`incomingFollows`, NOT `following`/`followers`, so postgraphile's auto-generated
  `*_COUNT` orderBy enum does not clash with the `followingCount`/`followerCount` scalar columns.
- **Stake-weighted tallies are folded from EVENTS, never read from `VoteTally`/`PollTally` storage** —
  the reverse-then-apply (saturating) fold in `pure.ts` is what lets `verify-m4c` reproduce them.

**Chain identity is env-driven (build-time).** `chainId`/`endpoint` come from `CHAIN_ID`/`GENESIS` and
`WS_ENDPOINT`/`WS`. SubQuery resolves them when you run `subql build` (they bake into `project.yaml`),
so to target a relaunched/different chain: re-capture its genesis with `chain_getBlockHash(0)`, write it
to `GENESIS.txt` (the `verify-m4c` pin) and set the env, then rebuild. A relaunch always mints a new
genesis. The social features are on the `appchain-social-features` branch (spec 113) — the committed
`GENESIS.txt`/default `chainId` still point at the live preprod chain, so set `GENESIS`/`WS` to your
spec-113 node before building/verifying locally.
