# cogno-indexer — the L4 Tier-B SubQuery indexer (M4)

Self-hosted **SubQuery** indexer for cogno-chain (DR-27, the published reference indexer). It folds
the chain's public `Microblog` / `CognoGate` / `TalkStake` events into Postgres and serves a
**paginated, searchable, by-identity, threaded** feed over GraphQL — with **operator revoke/ban**
surfaced. PAPI-direct stays the v1 baseline + structural fallback (the frontend reads this only when
a GraphQL endpoint is configured). **Reads never touch Cardano.** Full write-up: `docs/M4-build.md`;
spec: `docs/L4-reading.md`.

## Files

- `schema.graphql` — the published open entity schema (`Author`/`Post`/`Thread`), versioned to runtime spec 104.
- `project.ts` — manifest: `chainId` = genesis pin, RPC-only (no dictionary/chaintypes), 5 event handlers.
- `src/mappings/mappingHandlers.ts` — the deterministic event→entity fold (storage-read for the post body; soft-delete; ban flag).
- `verify-m4c.mjs` — the **L4-M4c** gate: independent re-derivation from genesis == served feed (byte-for-byte).
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
npx subql codegen     # schema.graphql -> src/types
npx subql build       # src -> dist/index.js (+ project.yaml)

./run-indexer.sh      # ingest into Postgres (admin/health on :3001)
./run-query.sh        # GraphQL + playground at http://localhost:3000/

node verify-m4c.mjs   # the M4c re-derivation gate (A == B)
```

`run-indexer.sh` indexes **finalized** blocks by default (deterministic → the M4c reproducibility
property). Pass `--unfinalized-blocks=true` for an instant pre-finality feed with reorg rollback.

## Example queries (against http://localhost:3000/)

```graphql
# paginated global feed (newest first, non-deleted)
{ posts(first: 25, orderBy: ID_DESC, filter: {deleted: {equalTo: false}}) {
    totalCount pageInfo { hasNextPage endCursor }
    edges { cursor node { id authorId text parentId blockHeight deleted author { id banned } } } } }

# search (case-insensitive substring)
{ posts(filter: {deleted: {equalTo: false}, text: {includesInsensitive: "ledger"}}) { nodes { id text } } }

# profile by identity hash (32-byte blake2b_256(owner Address), DR-01)
{ authors(filter: {identityHash: {equalTo: "0x…"}}) {
    nodes { id banned postCount weight posts(orderBy: ID_DESC) { nodes { id text deleted } } } } }

# a thread: root + its replies
{ post(id: "0") { id text replies(orderBy: ID_ASC) { nodes { id authorId text parent { id } } } } }
```

## Notes / gotchas

See `docs/M4-build.md` for the full list. The load-bearing ones: TCP (not socket) Postgres host;
`TZ=UTC` required; `graphql` pinned to 15.10.2 via `overrides`; `src/global.d.ts` for the SubQuery
globals; `btree_gist` is trusted in PG16 (no superuser). A `spec_version` bump that changes
`PostCreated`/`Posts` encoding requires re-running `subql codegen`/`build` in lockstep with PAPI.
