#!/usr/bin/env bash
# Run the cogno-chain SubQuery GRAPHQL QUERY service (serve) — postgraphile over the indexed
# Postgres schema. GraphQL + playground at http://localhost:3000/. Start the indexer node FIRST
# (it creates the `cogno` schema; the query service fails until that exists). Requires node on PATH.
set -euo pipefail
export TZ=UTC   # @subql/node refuses to start unless the env TZ is UTC
cd "$(dirname "$0")"

[ -f .env ] && set -a && . ./.env && set +a
export DB_USER="${DB_USER:-cogno}"
export DB_PASS="${DB_PASS:-}"
export DB_DATABASE="${DB_DATABASE:-cogno_indexer}"
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"

exec node_modules/.bin/subql-query \
  --name=cogno \
  --playground \
  --port=3000 \
  "$@"
