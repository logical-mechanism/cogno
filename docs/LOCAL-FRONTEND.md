# Iterate on the frontend against the REAL chain (local tracking node)

Develop the `app/` frontend locally while it reads **live data from the real Cogno chain**, without
running a validator or touching the operator's node. You run a **non-validator "relay"** — a tracking
full node — that syncs the real chain over P2P and serves RPC to your dev frontend on `127.0.0.1`.

```
 ┌────────────┐   libp2p P2P    ┌───────────────────────────┐   ws RPC :9944   ┌──────────────┐
 │ validator  │◀───────────────▶│  local tracking node       │◀───────────────▶│ app (next dev│
 │ (producer) │   :30333        │  (relay; --no validator)   │                 │  :3000)      │
 │ = SOURCE   │                 │  syncs + serves reads       │                 │              │
 │   OF TRUTH │                 └───────────────────────────┘                 └──────────────┘
```

The validator stays the **sole block producer and source of truth**. The relay only follows it and
answers reads (and broadcasts the posts you submit) — it can't author, equivocate, or affect
consensus. This is the same "tracking node" from the [README's "Your own network"](../README.md#run-the-chain)
section, packaged for the local-dev loop with two helper scripts.

## Prerequisites

- The node binary is built: `cargo build --release`.
- You can reach the validator two ways:
  1. its **JSON-RPC** endpoint (to learn the genesis + build a matching chain spec), and
  2. its **P2P port** (default `:30333`) — this must accept inbound TCP **from your machine** (see
     [Operator setup](#operator-setup-exposing-the-validator) if it's firewalled).
- Use the **nvm node** for the `.mjs` helper (`~/.nvm/versions/node/v22.12.0/bin` on `PATH`) — the snap
  node swallows stdout (see [CLAUDE.md](../CLAUDE.md)).

## 1. Build a genesis-matching chain spec

A tracking node must load the chain's **exact** genesis (same genesis block hash) or it forms a
different chain and never peers. The authoritative `raw.json` lives on the validator host and embeds
the ~500 KB genesis wasm, so instead of copying it, reconstruct it from the validator's **safe,
read-only RPC** — [`scripts/fetch-chainspec.mjs`](../scripts/fetch-chainspec.mjs) enumerates every
genesis storage key (`state_getKeysPaged`) and reads each value as-of genesis (`state_getStorage`),
which reproduces the genesis state root byte-for-byte:

```bash
# Point at the validator's HTTP JSON-RPC (a ws:// proxy usually also accepts HTTP POST on the same path).
# Get its peer id + listen addrs from the validator host: `cogno-chain-node key inspect-node-key ...`,
# or over RPC: system_localPeerId + system_localListenAddresses.
node scripts/fetch-chainspec.mjs http://<validator-host>/rpc \
  --bootnode /ip4/<validator-ip>/tcp/30333/p2p/<peer-id> \
  --id cogno --protocol-id cogno \
  --out network/raw.json
```

It prints the genesis hash and writes `network/raw.json` (gitignored) with the bootnode embedded. The
chain name + properties are read from the node; `--id`/`--protocol-id` must match what the network was
generated with (the [`gen-chainspec.mjs`](../scripts/gen-chainspec.mjs) default is `cogno`).

> If you already have the operator's real `network/raw.json` (e.g. from `gen-chainspec.mjs`), use it
> directly and skip this step — just make sure its `bootNodes` includes the validator, or pass
> `BOOTNODE=…` at launch.

## 2. Run the tracking node (relay)

[`scripts/run-tracking-node.sh`](../scripts/run-tracking-node.sh) launches the node as a
non-validator against `network/raw.json`, serving RPC on `127.0.0.1:9944`:

```bash
./scripts/run-tracking-node.sh                 # uses network/raw.json + its embedded bootnode
# tunables (env): NODE_BIN, CHAINSPEC, RELAY_BASE, RPC_PORT, P2P_PORT, RELAY_NAME, BOOTNODE
./scripts/run-tracking-node.sh -l sync=debug   # extra node flags pass through
```

By design it runs **without `--validator`** and **without db-sync**: the in-protocol Cardano observer
abstains on every import, which the runtime treats as `CannotVerify` (non-fatal — see
[`pallets/cardano-observer`](../pallets/cardano-observer/src/lib.rs)). So the relay syncs and follows
the chain even though it has no Cardano credentials and need not match the validator's exact client
commit. The chain DB lives in `./.relay-data` (gitignored; delete it to re-sync from scratch).

## 3. Point the frontend at the relay

The app's default WS endpoint is already `ws://127.0.0.1:9944` (the relay). For an explicit dev
default, set it in `app/.env.local` (gitignored):

```bash
# app/.env.local
NEXT_PUBLIC_WS_URL=ws://127.0.0.1:9944
```

Then run the dev server as usual — it reads live chain data through the relay:

```bash
cd app && npm run dev          # :3000  (use the nvm node)
```

A user can still override the endpoint at runtime in the UI (Endpoint Settings → persisted in
`localStorage`), which always wins over the build default.

> **Reads vs. writes.** Browsing the feed needs only the relay (reads). The full post/bind/lock flow
> additionally needs the follower / sponsored-bind relay / Blockfrost (see
> [app/README.md](../app/README.md)) — those are independent of this tracking-node setup.

## Verify it's syncing real data

```bash
RELAY=http://127.0.0.1:9944
# genesis must equal the validator's chain_getBlockHash(0):
curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"chain_getBlockHash","params":[0]}' $RELAY
# peers ≥ 1, isSyncing false once caught up:
curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"system_health","params":[]}' $RELAY
# the connected peer should be the validator, at the same best block:
curl -s -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"system_peers","params":[]}' $RELAY
```

The relay's `system_health.peers` should be ≥ 1 and its best block should track the validator's.

## Operator setup (exposing the validator)

For the relay to reach a validator you operate, that host must:

- **Serve RPC** to your dev machine — either bind RPC for the LAN (`--rpc-external --rpc-methods safe
  --rpc-cors <origins>`, ideally behind a TLS/filtering proxy) or expose it through a reverse proxy
  (the `…/rpc` form). Only the **safe** RPC set is needed (`state_getKeysPaged`, `state_getStorage`,
  `system_*`, `chain_*`).
- **Accept inbound P2P** on `:30333` from your machine. A tracking node syncs over libp2p, **not** RPC
  — if `:30333` is firewalled, sync never starts even though RPC works. Open it, e.g.:

  ```bash
  sudo ufw allow from <your-lan-subnet>/24 to any port 30333 proto tcp
  ```

  Confirm from your dev machine: `nc -z -w4 <validator-host> 30333`.
