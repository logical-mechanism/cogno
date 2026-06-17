#!/usr/bin/env bash
# Start the Cogno-Follower (M2). Reuses cogno_v3's proven venv (pinned pycardano 0.13.0) by
# default; override COGNO_FOLLOWER_PY to point at your own venv python.
#
#   ./run.sh                 # node @ ws://127.0.0.1:9944, follower @ :8090
#   PORT=8090 NODE_HTTP=http://127.0.0.1:9944 WS=ws://127.0.0.1:9944 ./run.sh
#
# Requires: a running cogno-chain --dev node (for the genesis fetch + the link_identity submit)
# and Node on PATH (the submitter uses app/scripts/submit-link.mjs via PAPI).
set -euo pipefail
cd "$(dirname "$0")"
PY="${COGNO_FOLLOWER_PY:-/home/logic/Documents/LogicalMechanism/cogno_v3/cogno_v3_app/backend/venv/bin/python}"
export NODE_BIN="${NODE_BIN:-/home/logic/.nvm/versions/node/v22.12.0/bin/node}"
exec "$PY" follower.py
