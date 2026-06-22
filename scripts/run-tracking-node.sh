#!/usr/bin/env bash
# run-tracking-node.sh — run a LOCAL, non-validator "relay" node that syncs the real cogno-chain over
# P2P and serves RPC to the frontend. Lets you iterate on the app against REAL chain data without
# touching the operator's validator: the validator stays the sole block producer / source of truth;
# this node just follows it and answers reads (+ broadcasts the user's txs) on 127.0.0.1.
#
#   ┌────────────┐  libp2p P2P   ┌──────────────────────┐  ws RPC :9944  ┌────────────┐
#   │ validator  │◀─────────────▶│ this tracking node    │◀──────────────▶│ app (:3000)│
#   │ (producer) │  :30333       │ (--no validator role) │                │            │
#   └────────────┘               └──────────────────────┘                └────────────┘
#
# First-time setup (fresh box) is documented in docs/RELAY-NODE.md. In short:
#   - Ubuntu build deps:  sudo apt-get install -y clang protobuf-compiler cmake libssl-dev pkg-config make build-essential
#     (there is NO libp2p package — P2P is the sc-network crate, compiled into the binary by `cargo build --release`)
#   - Rust toolchain via rustup (auto-selects the pinned 1.90.0 from rust-toolchain.toml)
#
# Prereqs:
#   1. The node binary is built:               cargo build --release
#   2. A genesis-matching raw spec exists:      node scripts/fetch-chainspec.mjs <rpc> --bootnode <ma> --out network/raw.json
#      (the committed network/raw.json already has DDNS + LAN bootNodes — no --bootnodes flag needed)
#   3. The validator's P2P port is reachable from here (it must accept inbound on :30333).
#
# This is a TRACKING node, by design:
#   • NO --validator  → it never authors; it cannot equivocate or affect consensus.
#   • NO db-sync      → the in-protocol Cardano observer abstains on import (CannotVerify is non-fatal,
#                       pallets/cardano-observer: it accepts every block without re-checking the observation).
#                       So it syncs regardless of whether its client commit matches the validator's, and
#                       needs no Cardano credentials. DBSYNC_URL/DBSYNC are unset below to guarantee this.
#
# Tunables (env):
#   NODE_BIN    path to the built node      [<repo>/target/release/cogno-chain-node]
#   CHAINSPEC   raw chain spec to follow    [<repo>/network/raw.json]
#   RELAY_BASE  base-path (chain DB; gitignored) [<repo>/.relay-data]
#   RPC_PORT    ws/http RPC port (the app)  [9944]
#   P2P_PORT    libp2p port                 [30333]
#   RELAY_NAME  node display name           [cogno-relay-local]
#   BOOTNODE    extra bootnode multiaddr    [unset → uses the spec's embedded bootNodes]
# Extra node flags pass through, e.g.:  scripts/run-tracking-node.sh -l sync=debug
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$REPO/target/release/cogno-chain-node}"
CHAINSPEC="${CHAINSPEC:-$REPO/network/raw.json}"
RELAY_BASE="${RELAY_BASE:-$REPO/.relay-data}"
RPC_PORT="${RPC_PORT:-9944}"
P2P_PORT="${P2P_PORT:-30333}"
RELAY_NAME="${RELAY_NAME:-cogno-relay-local}"

[ -x "$NODE_BIN" ]   || { echo "✗ node binary not found/executable: $NODE_BIN  (run: cargo build --release)" >&2; exit 1; }
[ -f "$CHAINSPEC" ]  || { echo "✗ chain spec not found: $CHAINSPEC  (run: node scripts/fetch-chainspec.mjs <rpc> --bootnode <ma> --out network/raw.json)" >&2; exit 1; }

# Force the observer to abstain: never let an inherited DBSYNC_URL pull this tracking node into
# re-deriving (and potentially fatally mismatching) the Cardano observation on import.
unset DBSYNC_URL DBSYNC || true

# A db-sync-less tracking node abstains on EVERY block import, so the observer logs one "abstaining"
# line per block forever — pure noise here. Quiet just that target by default (override via RUST_LOG).
export RUST_LOG="${RUST_LOG:-info,cardano-observer=error}"

echo "→ tracking node '$RELAY_NAME'"
echo "    spec     : $CHAINSPEC"
echo "    base-path: $RELAY_BASE"
echo "    RPC      : ws://127.0.0.1:$RPC_PORT   (point the app here)"
echo "    P2P      : :$P2P_PORT"
[ -n "${BOOTNODE:-}" ] && echo "    +bootnode: $BOOTNODE"
echo

exec "$NODE_BIN" \
  --chain "$CHAINSPEC" \
  --base-path "$RELAY_BASE" \
  --name "$RELAY_NAME" \
  --rpc-port "$RPC_PORT" \
  --port "$P2P_PORT" \
  --rpc-cors all \
  --no-mdns \
  --state-pruning archive \
  --blocks-pruning archive \
  ${BOOTNODE:+--bootnodes "$BOOTNODE"} \
  "$@"
