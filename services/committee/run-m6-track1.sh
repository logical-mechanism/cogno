#!/usr/bin/env bash
# M6 Track 1 orchestrator — stand up a 3-node `--chain local` network and run the mutable-validator
# acceptance (services/committee/m6-validators.mjs).
#
#   Alice  :9944 (genesis authority)    Bob :9945 (genesis authority)
#   Charlie:9946 (full node, --charlie keys, onboarded as a NEW validator by the acceptance)
#
# Usage:  services/committee/run-m6-track1.sh          # add/remove via sudo (default)
#         VIA=committee services/committee/run-m6-track1.sh
set -uo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
NODE="$ROOT/target/release/cogno-chain-node"
DIR=/tmp/cogno-m6
SPEC="$DIR/local-spec.json"
# Ensure a real (non-snap) node is on PATH — the snap `node` writes stdout to /dev/null. Point
# COGNO_NODE_BIN_DIR at your node bin dir (e.g. ~/.nvm/versions/node/v22.12.0/bin) if needed.
[ -n "${COGNO_NODE_BIN_DIR:-}" ] && export PATH="$COGNO_NODE_BIN_DIR:$PATH"
command -v node >/dev/null 2>&1 || { echo "node not found on PATH — install node v22 or set COGNO_NODE_BIN_DIR"; exit 1; }

[ -x "$NODE" ] || { echo "node binary not found at $NODE — build it first"; exit 1; }

echo "── cleanup: free ports + kill stale nodes ─────────────────────────────────"
pkill -f 'cogno-chain-node' 2>/dev/null; sleep 2
rm -rf "$DIR"; mkdir -p "$DIR"

echo "── build raw chain spec (local: Alice+Bob genesis authorities) ─────────────"
"$NODE" build-spec --chain local --raw --disable-default-bootnode > "$SPEC" 2>/dev/null
echo "spec: $(wc -c < "$SPEC") bytes"

start_node() { # name account p2p rpc [bootnode]
  local name=$1 acct=$2 p2p=$3 rpc=$4 boot=${5:-}
  local args=(--"$acct" --validator --chain "$SPEC" --tmp --unsafe-force-node-key-generation \
    --port "$p2p" --rpc-port "$rpc" --rpc-cors all --no-mdns --no-telemetry --name "$name")
  [ -n "$boot" ] && args+=(--bootnodes "$boot")
  "$NODE" "${args[@]}" > "$DIR/$name.log" 2>&1 &
  echo $!
}

echo "── start Alice (bootnode) ──────────────────────────────────────────────────"
APID=$(start_node alice alice 30333 9944)
# Wait for Alice's libp2p peer id from the log.
PEERID=""
for i in $(seq 1 30); do
  PEERID=$(grep -oE "12D3[A-Za-z0-9]+" "$DIR/alice.log" 2>/dev/null | head -1)
  [ -n "$PEERID" ] && break; sleep 1
done
[ -n "$PEERID" ] || { echo "FAILED to read Alice peer id"; cat "$DIR/alice.log" | tail -20; pkill -f cogno-chain-node; exit 1; }
BOOT="/ip4/127.0.0.1/tcp/30333/p2p/$PEERID"
echo "Alice peer id: $PEERID"

echo "── start Bob + Charlie (bootnode = Alice) ──────────────────────────────────"
BPID=$(start_node bob bob 30334 9945 "$BOOT")
CPID=$(start_node charlie charlie 30335 9946 "$BOOT")

echo "── wait for the network to peer + author + sync (up to 90s) ────────────────"
for i in $(seq 1 90); do
  best=$(grep -oE "best: #[0-9]+" "$DIR/alice.log" 2>/dev/null | tail -1 | grep -oE "[0-9]+")
  peers=$(grep -oE "[0-9]+ peers" "$DIR/alice.log" 2>/dev/null | tail -1 | grep -oE "^[0-9]+")
  if [ "${best:-0}" -ge 3 ] && [ "${peers:-0}" -ge 2 ]; then
    echo "Alice best #$best, $peers peers — network up"; break
  fi
  sleep 1
done

echo "── run the Track-1 acceptance ──────────────────────────────────────────────"
WS=ws://127.0.0.1:9944 BOB_WS=ws://127.0.0.1:9945 CHARLIE_WS=ws://127.0.0.1:9946 VIA="${VIA:-sudo}" \
  node "$ROOT/services/committee/m6-validators.mjs"
RC=$?

echo "── corroborate: did //Charlie actually author blocks? (its own node log) ──"
grep -E "Prepared block for proposing|Pre-sealed block|🎁|🔖" "$DIR/charlie.log" 2>/dev/null | tail -4 \
  || echo "(no authoring lines in charlie.log — check the acceptance result above)"

echo "── teardown ────────────────────────────────────────────────────────────────"
kill "$APID" "$BPID" "$CPID" 2>/dev/null; pkill -f 'cogno-chain-node' 2>/dev/null
echo "Track 1 exit code: $RC"
exit $RC
