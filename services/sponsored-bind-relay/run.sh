#!/usr/bin/env bash
# Start the Sponsored-Bind Relay (D1 bind-funding). Pays the fee for the trustless on-chain identity
# bind (cognoGate.link_identity_signed) so a brand-new, unfunded posting account can register. The
# runtime is the sole verifier — the relay is a LIVENESS-only fee payer (cannot forge or retarget a
# binding). Uses the nvm node v22 (PAPI/MeshJS gotcha) and the app/node_modules symlink for PAPI deps.
#
#   ./run.sh                                                  # WS ws://127.0.0.1:9944, relay @ :8091
#   WS=ws://127.0.0.1:9945 RELAY_SEED=//Alice PORT=8091 ./run.sh
#
# RELAY_SEED is the FUNDED submitter (NOT a privileged key); default dev //Alice. Set a real funded
# seed in any real deployment (COGNO_PROFILE=prod refuses a public dev seed).
set -euo pipefail
cd "$(dirname "$0")"

# Use the nvm node v22.12.0 (the snap node writes stdout to /dev/null and importing MeshJS redirects
# stdio) — prepend it to PATH for all Node/PAPI work in this repo.
NVM_BIN="$HOME/.nvm/versions/node/v22.12.0/bin"
[ -d "$NVM_BIN" ] && export PATH="$NVM_BIN:$PATH"

# Recreate the gitignored deps symlink if missing (app must have run `npm install` first).
if [ ! -e node_modules ]; then
  ln -sfn ../../app/node_modules node_modules
fi
if [ ! -d node_modules ]; then
  echo "app deps not found — run 'npm install' in app/ first (it generates the PAPI descriptors too)." >&2
  exit 1
fi

exec node relay.mjs
