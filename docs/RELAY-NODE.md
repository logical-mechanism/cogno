# Running a relay (tracking) node — first-time setup

A **relay / tracking node** is a non-validator full node: it syncs the live cogno-chain over libp2p
P2P and serves RPC to a local frontend. It never authors blocks or votes finality, so it needs no
validator keys and no Cardano db-sync. Stand one up on any box (this one or a remote one) to read real
chain data (the node serves all reads via its runtime API) and broadcast txs without touching the
operator's validator.

```
 public relay ──libp2p :30333──▶ this tracking node ──ws RPC :9944──▶ app (:3000)
      ▲
      └── the validator (sole producer) sits behind it — dialed by nobody
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
   git clone https://github.com/logical-mechanism/cogno.git && cd cogno
   cargo build --release        # → ./target/release/cogno-chain-node  (libp2p is baked in here)
   ```
3. **Chain spec** — the committed [`chainspecs/preprod.raw.json`](../chainspecs/preprod.raw.json) is the
   genesis-matching live spec (the default `CHAINSPEC` in `scripts/run-tracking-node.sh`). Its single
   embedded bootnode is the operator's **public cloud relay** — the network's entry point — so a relay
   needs no `--bootnodes` flag. The validator itself is not publicly dialable and is not in the spec.
   (If the network was relaunched and the committed spec is stale, rebuild a genesis-identical one from
   read-only RPC — see
   [`LOCAL-FRONTEND.md`](LOCAL-FRONTEND.md#if-the-network-was-relaunched--rebuild-the-spec).)

## Run

```bash
scripts/run-tracking-node.sh                 # RPC ws://127.0.0.1:9944, P2P :30333
scripts/run-tracking-node.sh -l sync=debug   # verbose peer/sync logging
```

Useful env overrides (see the script header for the full list): `RPC_PORT`, `P2P_PORT`,
`RELAY_NAME`, `RELAY_BASE` (DB path), and `BOOTNODE` to dial an extra/ad-hoc peer multiaddr.

## Verify it connected

- Logs go from `0 peers` → `1 peers (best: #…)` and begin importing/finalizing blocks. This is the
  authoritative check — it is the only one that proves a real libp2p session.
- A pre-flight TCP probe of whatever bootnode the spec actually carries (no hardcoded host, so it can't
  rot):
  ```bash
  python3 -c "import json,re;a=json.load(open('chainspecs/preprod.raw.json'))['bootNodes'][0];m=re.match(r'/(?:dns4|ip4)/([^/]+)/tcp/(\d+)',a);print(m[1],m[2])" | xargs nc -vz
  ```
  A successful `nc` only proves the socket accepts — it does not prove a libp2p handshake.

## Notes

- **Outbound only.** A tracking node dials *out* to the bootnode relay; it needs no inbound port-forward
  or public address of its own. Only the public relay accepts inbound P2P, and it holds no keys — see
  [`../deploy/README.md`](../deploy/README.md).
- **RPC stays on `127.0.0.1`.** Leave it there. To serve a public app, put a TLS reverse proxy in front
  of the loopback bind rather than reaching for `--rpc-external` — see
  [`deploy/nginx/cogno.conf`](../deploy/nginx/cogno.conf) and
  [`deploy/systemd/cogno-relay.service`](../deploy/systemd/cogno-relay.service), which is the production
  version of this script. A separate concern from P2P.
- **Archive pruning** (`--state-pruning/--blocks-pruning archive`, already in the script) keeps full
  history so the node can answer historical reads over its runtime API (the archival commitment).
- The node abstains on the Cardano observer with no db-sync configured (`CannotVerify` is non-fatal),
  so it syncs the live chain regardless — the script unsets `DBSYNC_URL`/`DBSYNC` to guarantee this.
