# Running a relay (tracking) node — first-time setup

A **relay / tracking node** is a non-validator full node: it syncs the live cogno-chain over libp2p
P2P and serves RPC to a local frontend. It never authors blocks or votes finality, so it needs no
validator keys and no Cardano db-sync. Stand one up on any box (this one or a remote one) to read real
chain data (the node serves all reads via its runtime API) and broadcast txs without touching the
operator's validator.

```
 validator (producer) ──libp2p :30333──▶ this tracking node ──ws RPC :9944──▶ app (:3000)
```

> **There is no "libp2p" to install.** P2P networking is the `sc-network` crate (which wraps
> rust-libp2p), compiled *into* `cogno-chain-node`. The entire P2P "install" is `cargo build
> --release` — no daemon, no system package, nothing to `apt`/`npm install` for networking.

## One-time setup (fresh box)

1. **System deps + Rust toolchain** — see [README.md](../README.md#prerequisites): the `apt-get`
   build deps, then `rustup` (it auto-selects the pinned `1.93.0` from
   [`rust-toolchain.toml`](../rust-toolchain.toml); do **not** roll to plain `stable` — stay on the
   toolchain the pinned SDK release is verified against).
2. **Clone + build** (heavy first compile):
   ```bash
   git clone <repo> cogno-chain && cd cogno-chain
   cargo build --release        # → ./target/release/cogno-chain-node  (libp2p is baked in here)
   ```
3. **Chain spec** — the committed [`chainspecs/preprod.raw.json`](../chainspecs/preprod.raw.json) is the
   genesis-matching live spec (the default `CHAINSPEC` in `scripts/run-tracking-node.sh`). Its single
   embedded bootnode points at the validator over DDNS (`/dns4/…asuscomm.com/…`), so a relay needs no
   `--bootnodes` flag. (No operator keys? Reconstruct a genesis-identical spec from the validator's
   read-only RPC instead — see
   [`LOCAL-FRONTEND.md`](LOCAL-FRONTEND.md#1-build-a-genesis-matching-chain-spec).)

## Run

```bash
scripts/run-tracking-node.sh                 # RPC ws://127.0.0.1:9944, P2P :30333
scripts/run-tracking-node.sh -l sync=debug   # verbose peer/sync logging
```

Useful env overrides (see the script header for the full list): `RPC_PORT`, `P2P_PORT`,
`RELAY_NAME`, `RELAY_BASE` (DB path), and `BOOTNODE` to dial an extra/ad-hoc peer multiaddr.

## Verify it connected

- Logs go from `0 peers` → `1 peers (best: #…)` and begin importing/finalizing blocks.
- Pre-flight reachability of the validator's P2P port (works from any box; from a same-LAN box it
  relies on the router's NAT hairpin):
  ```bash
  nc -vz logicalmechanism.asuscomm.com 30333
  ```

## Notes

- **Outbound only.** A tracking node dials *out* to the validator; it needs no inbound port-forward
  or public address of its own. (The validator side does — stable peer ID + forwarded :30333 + a
  DDNS updater. See [README.md](../README.md) and `deploy/systemd/cogno-node.service`.)
- **RPC stays on `127.0.0.1`** by default for a co-located app. To expose it off-box, add
  `--rpc-external --rpc-methods safe --rpc-cors '<origins>'` (behind TLS) — a separate concern from P2P.
- **Archive pruning** (`--state-pruning/--blocks-pruning archive`, already in the script) keeps full
  history so the node can answer historical reads over its runtime API (DR-08's archival commitment).
- The node abstains on the Cardano observer with no db-sync configured (`CannotVerify` is non-fatal),
  so it syncs the live chain regardless — the script unsets `DBSYNC_URL`/`DBSYNC` to guarantee this.
