#!/usr/bin/env bash
# Start the Cogno-Follower read-only helper (M2 → D1). Uses the in-repo venv
# (services/cogno-follower/.venv) by default; override COGNO_FOLLOWER_PY to point at your own venv
# python. See README.md for venv setup.
#
#   ./run.sh                                  # node @ http://127.0.0.1:9944, follower @ :8090
#   PORT=8090 NODE_HTTP=http://127.0.0.1:9944 ./run.sh
#
# Requires only a running cogno-chain node (for the genesis fetch + the /health probe). D1 retired the
# bind-WRITE, so the follower no longer shells out to a Node submitter and needs no signing key / WS /
# committee seeds — binding is the on-chain `cognoGate.link_identity_signed` self-proof.
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
exec "$PY" follower.py
