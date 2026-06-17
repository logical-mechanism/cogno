#!/usr/bin/env bash
# Run the cogno-chain SubQuery INDEXER NODE (ingest) against the local archive node + Postgres.
# No Docker: a plain @subql/node process talking to the already-running Postgres 16 cluster over
# TCP (127.0.0.1, scram) as the isolated `cogno` role (creds in .env). Requires node/npx on PATH
# (this box: `export PATH="$HOME/.nvm/versions/node/v22.12.0/bin:$PATH"`).
#
# Indexes FINALIZED blocks by default (deterministic → the L4-M4c reproducibility property).
# Pass --unfinalized-blocks=true for an instant (pre-finality) feed with reorg rollback.
set -euo pipefail
export TZ=UTC   # @subql/node refuses to start unless the env TZ is UTC
cd "$(dirname "$0")"

# DB creds from .env (gitignored). @subql/node builds a postgres URL, so DB_HOST must be a
# TCP host (a unix-socket path is not a valid URL host) → connect via 127.0.0.1 + scram.
[ -f .env ] && set -a && . ./.env && set +a
export DB_USER="${DB_USER:-cogno}"
export DB_PASS="${DB_PASS:-}"
export DB_DATABASE="${DB_DATABASE:-cogno_indexer}"
export DB_HOST="${DB_HOST:-127.0.0.1}"
export DB_PORT="${DB_PORT:-5432}"

exec node_modules/.bin/subql-node \
  -f . \
  --db-schema=cogno \
  --batch-size=20 \
  --workers=1 \
  --port=3001 \
  "$@"
