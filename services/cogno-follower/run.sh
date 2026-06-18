#!/usr/bin/env bash
# Start the Cogno-Follower (M2). Uses the in-repo venv (services/cogno-follower/.venv) by default;
# override COGNO_FOLLOWER_PY to point at your own venv python. See README.md for venv setup.
#
#   ./run.sh                 # node @ ws://127.0.0.1:9944, follower @ :8090
#   PORT=8090 NODE_HTTP=http://127.0.0.1:9944 WS=ws://127.0.0.1:9944 ./run.sh
#
# Requires: a running cogno-chain node (for the genesis fetch + the link_identity submit) and a real
# node v22 (the submitter uses app/scripts/submit-link.mjs via PAPI). NOTE: the snap `node` writes
# stdout to /dev/null — set NODE_BIN to an absolute non-snap node if PATH `node` is the snap.
set -euo pipefail
cd "$(dirname "$0")"
PY="${COGNO_FOLLOWER_PY:-.venv/bin/python}"
if [ ! -x "$PY" ]; then
  echo "follower python not found/executable at '$PY'." >&2
  echo "Create the venv (see services/cogno-follower/README.md), e.g.:" >&2
  echo "  python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" >&2
  echo "or set COGNO_FOLLOWER_PY=/path/to/venv/bin/python" >&2
  exit 1
fi
export NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || { echo "NODE_BIN '$NODE_BIN' not found — set it to a real (non-snap) node v22 binary." >&2; exit 1; }
exec "$PY" follower.py
