#!/usr/bin/env bash
# Fail if the committed SCALE metadata snapshot has drifted from what the runtime actually produces.
#
# WHY THIS EXISTS. Pallet indices, call indices and enum variant indices are on-wire contracts, and SCALE
# indexes enum variants by DECLARATION ORDER. Deleting or reordering a variant silently shifts every one
# below it: the wire format changes with no compile error and no test failure. Before this gate the only
# thing pinning any of it was `#[codec(index = N)]` attributes — which pin the encoding but do not notice
# when someone CHANGES them — plus a handful of hand-written index assertions covering 6 of 19 pallets.
# A renumber passed every CI job.
#
# The committed `app/.papi/metadata/cogno.scale` is the strongest available pin: it is the runtime's whole
# type/call/storage/event surface in one blob. Diffing it against a freshly built runtime turns every one
# of those on-wire contracts into a single gate that cannot be satisfied by restating a literal.
#
# A DIFFERENCE IS NOT AUTOMATICALLY A BUG. A deliberate spec bump changes exactly one byte (the
# `spec_version` inside the `System::Version` constant, which embeds `RuntimeVersion`); the fix there is to
# re-snapshot. A difference anywhere else means a type, call, storage item or event MOVED — which is
# either intended (then re-snapshot, and check `transaction_version` / the PAPI descriptors) or is the
# silent-corruption bug this gate exists to catch. The script says which case it is.
#
# Usage:  ./scripts/check-metadata.sh              # verify
#         ./scripts/check-metadata.sh --write      # re-snapshot after an intended change
#
# Re-snapshot via THIS script, never via `papi add -w ws://…`: that command writes the node it was pointed
# at back into `app/.papi/polkadot-api.json` (`wsUrl`, plus that chain's `genesis` and `codeHash`), and
# once those are committed a later `papi generate` resolves against a local dev node instead of the
# committed metadata. This script touches only the .scale blob.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Both profiles agree on metadata — it is a pure function of the FRAME declarations, not the optimisation
# level — but only a binary BUILT FROM THE CURRENT TREE carries the current runtime, so take the NEWER of
# the two rather than a fixed profile order. CI's `build (workspace)` step produces the debug binary, a
# local `cargo build --release` the release one; a dev holding both would otherwise be gated against
# whichever happened to be stale, which reads as a false pass, or as a false drift that `--write` then
# commits as a stale snapshot. The recency pick is then VERIFIED against the commit stamp below.
# `NODE=/path/to/node` overrides the whole probe.
NODE_FROM_ENV=1
if [ -z "${NODE:-}" ]; then
  NODE_FROM_ENV=0
  NODE="$ROOT/target/release/cogno-chain-node"
  DEBUG_NODE="$ROOT/target/debug/cogno-chain-node"
  if [ -x "$DEBUG_NODE" ] && { [ ! -x "$NODE" ] || [ "$DEBUG_NODE" -nt "$NODE" ]; }; then
    NODE="$DEBUG_NODE"
  fi
fi
SNAPSHOT="${SNAPSHOT:-$ROOT/app/.papi/metadata/cogno.scale}"
PORT="${PORT:-19977}"
WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1

[ -x "$NODE" ] || { echo "no node binary at $NODE — run 'cargo build --release' first"; exit 1; }

# The embedded runtime is only the CURRENT one if the binary was built from the current tree, and this
# gate is worthless against a stale one: it reads the PREVIOUS runtime and reports the delta as an
# on-wire break — and under `--write` it would commit that stale blob over a correct snapshot.
# node/build.rs stamps the commit into --version via substrate_build_script_utils
# (`git rev-parse --short=11 HEAD`), so ask the binary rather than guessing from mtimes. Only the
# auto-probed binary is checked: an explicit `NODE=` is a deliberate choice (a CI artifact, a binary
# built from another checkout) and stays the escape hatch. No git checkout (a tarball build) skips it.
HEAD_SHA="$(git -C "$ROOT" rev-parse --short=11 HEAD 2>/dev/null || true)"
BUILT_VER="$("$NODE" --version 2>/dev/null | awk '{print $2}')"
if [ "$NODE_FROM_ENV" = 0 ] && [ -n "$HEAD_SHA" ] && [ -n "$BUILT_VER" ]; then
  case "$BUILT_VER" in
    *"$HEAD_SHA"*) : ;;
    *)
      echo "stale node binary: $NODE was built from ${BUILT_VER#*-}, HEAD is $HEAD_SHA."
      echo "  Rebuild it, or this gate compares the committed snapshot against the WRONG runtime"
      echo "  and reports the difference as an on-wire break."
      echo "  If you meant to gate against this exact binary, pass it explicitly: NODE=$NODE $0"
      exit 1 ;;
  esac
fi
echo "gating against $NODE (${BUILT_VER:-unknown})"

[ -f "$SNAPSHOT" ] || { echo "no committed snapshot at $SNAPSHOT"; exit 1; }

TMP="$(mktemp -d)"
cleanup() {
  [ -n "${NODE_PID:-}" ] && kill "$NODE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"$NODE" run --dev --tmp --rpc-port "$PORT" --no-prometheus --no-telemetry >"$TMP/node.log" 2>&1 &
NODE_PID=$!

# Wait for RPC. The runtime is embedded in the binary, so this needs no synced chain — only a live RPC.
for _ in $(seq 1 60); do
  if curl -sf --max-time 2 -H 'Content-Type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"system_name","params":[]}' \
      "http://127.0.0.1:$PORT" >/dev/null 2>&1; then
    break
  fi
  kill -0 "$NODE_PID" 2>/dev/null || { echo "node exited early:"; tail -20 "$TMP/node.log"; exit 1; }
  sleep 1
done

# PAPI pins metadata v16. `state_getMetadata` would hand back v14 (the legacy default) and silently
# compare two different formats, so ask for the version the snapshot is actually in.
curl -sf --max-time 20 -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"state_call","params":["Metadata_metadata_at_version","0x10000000"]}' \
  "http://127.0.0.1:$PORT" >"$TMP/resp.json"

python3 - "$TMP/resp.json" "$TMP/live.scale" <<'PY'
import json, sys
raw = bytes.fromhex(json.load(open(sys.argv[1]))["result"][2:])
if not raw or raw[0] != 1:
    sys.exit("runtime did not return metadata v16 (Option::None) — is Metadata_metadata_versions missing 16?")
b = raw[1:]
f = b[0] & 0b11                                    # SCALE compact length prefix
if f == 0:   n, off = b[0] >> 2, 1
elif f == 1: n, off = int.from_bytes(b[:2], 'little') >> 2, 2
elif f == 2: n, off = int.from_bytes(b[:4], 'little') >> 2, 4
else:
    k = (b[0] >> 2) + 4
    n, off = int.from_bytes(b[1:1+k], 'little'), 1 + k
open(sys.argv[2], 'wb').write(b[off:off+n])
PY

# A `--features try-runtime` build carries the extra TryRuntime runtime API and the try_state hooks, so
# its metadata is ~1 KB LARGER than the runtime that actually ships. docs/UPGRADES.md builds exactly that
# binary for the pre-enactment dry-run and says never to enact it — but it lands at
# target/release/cogno-chain-node, where the recency probe above will happily pick it. Gating against it
# is a guaranteed false drift, and `--write` against it would commit a snapshot of a runtime that does
# not exist, breaking CI and hiding whatever really moved. Refuse rather than compare.
if grep -q "TryRuntime" "$TMP/live.scale"; then
  echo "refusing to use $NODE: its runtime was built with --features try-runtime (the metadata carries"
  echo "  the TryRuntime API), so it is ~1 KB larger than the runtime that ships. That is the dry-run"
  echo "  binary from docs/UPGRADES.md, not an enactment build."
  echo "  Fix: rebuild without the feature ('cargo build --release'), or point NODE at a clean binary."
  exit 1
fi

if [ "$WRITE" = "1" ]; then
  cp "$TMP/live.scale" "$SNAPSHOT"
  echo "re-snapshotted $SNAPSHOT ($(wc -c <"$SNAPSHOT") bytes)"
  exit 0
fi

if cmp -s "$TMP/live.scale" "$SNAPSHOT"; then
  echo "metadata ok — the committed snapshot matches the runtime exactly."
  exit 0
fi

python3 - "$TMP/live.scale" "$SNAPSHOT" <<'PY'
import sys
live = open(sys.argv[1], 'rb').read()
snap = open(sys.argv[2], 'rb').read()
# Scan the LONGER blob and compare 1-byte SLICES: an out-of-range slice is b'', so a byte that exists in
# only one blob counts as differing. Scanning `min()` with `live[i]` would leave `diffs` EMPTY when one
# blob is a strict prefix of the other (a truncated snapshot), and `diffs[0]` below would IndexError.
# `cmp -s` above already proved the blobs differ, so with this scan `diffs` is non-empty by construction.
diffs = [i for i in range(max(len(live), len(snap))) if live[i:i+1] != snap[i:i+1]]
print(f"METADATA DRIFT: {len(diffs)} differing byte(s); live={len(live)}B snapshot={len(snap)}B")
if len(live) == len(snap) and len(diffs) == 1:
    # `System::Version` embeds the RuntimeVersion, so a lone byte delta is almost certainly spec_version.
    i = diffs[0]
    print(f"  byte {i}: snapshot=0x{snap[i]:02x} ({snap[i]}) -> live=0x{live[i]:02x} ({live[i]})")
    print("  A SINGLE byte delta is the signature of a deliberate spec_version bump (System::Version")
    print("  embeds RuntimeVersion). No type, call, storage or event shape moved.")
    print("  Fix: ./scripts/check-metadata.sh --write")
elif len(live) != len(snap) and not [i for i in diffs if i < min(len(live), len(snap))]:
    # One blob is a strict PREFIX of the other: nothing in the shared span moved, the LENGTH did.
    n = min(len(live), len(snap))
    shorter = "snapshot" if len(snap) < len(live) else "live"
    print(f"  the shared first {n} bytes are IDENTICAL — the {shorter} blob just ends there.")
    print("  A real metadata change cannot look like this: every SCALE Vec in the blob carries a compact")
    print("  length prefix at its START, so growing anything moves an early byte. This is a TRUNCATED or")
    print("  EMPTY file, not a shape change.")
    print("  Fix: restore the committed snapshot from git, or re-run --write. Do not go hunting for a")
    print("  renumber.")
else:
    lo, hi = max(0, diffs[0] - 32), diffs[-1] + 32
    print(f"  first differing byte {diffs[0]}, last {diffs[-1]}")
    print(f"  live[{lo}:{hi}] = {live[lo:hi]!r}")
    print(f"  snap[{lo}:{hi}] = {snap[lo:hi]!r}")
    print("  MORE THAN spec_version MOVED — a type, call, storage item or event changed shape.")
    print("  If that was intended: re-snapshot with --write, and re-check transaction_version")
    print("  (a call ARGUMENT change moves it) and whether the PAPI descriptors need regenerating.")
    print("  If it was NOT intended, you have found a silent on-wire break. Do not re-snapshot.")
sys.exit(1)
PY
