# chainspecs/

Committed **raw chain specs** for cogno-chain networks — the file you pass a node as
`--chain` to join a network with the right genesis + bootnodes.

| File | Network | Genesis | Runtime |
|---|---|---|---|
| `cogno-raw.json` | **Cogno** (operator-run preprod testnet, `id: cogno`, `chainType: Live`) | `0xde7a60b1675e2652cd40e8a329222a952d41d1597b219904e68b66a9dd0ff33c` | `cogno-chain-runtime` spec 117 |

> **Note.** `cogno-raw.json` is the **pre-restart** genesis (spec 117). The `fork/all-rust` restart
> relaunches the chain at a **fresh genesis** on the current `spec_version` 200 runtime — an operator
> ceremony that has not run yet (see [`../docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md)). When it
> does, regenerate this spec (below) and update the genesis-hash + spec row.

These are **raw** specs: genesis is pre-encoded storage and embeds the runtime wasm
(`:code`, ~480 KB), so the file is ~950 KB. That weight is the price of a node-ready,
genesis-pinned spec anyone can sync against without rebuilding the runtime.

## Use it

Run the local **relay / tracking node** (non-validator; P2P-syncs the network and serves
RPC to the frontend) — it defaults to this spec:

```bash
scripts/run-tracking-node.sh
# → --chain chainspecs/cogno-raw.json, RPC ws://127.0.0.1:9944, DB in .relay-data/
```

Or pass it to any node directly:

```bash
./target/release/cogno-chain-node --chain chainspecs/cogno-raw.json --base-path /tmp/cogno
```

The single embedded bootnode is the operator's public DDNS node
(`/dns4/logicalmechanism.asuscomm.com/tcp/30333/...`). Add more with `--bootnodes <multiaddr>`
(or `BOOTNODE=<multiaddr>` for the relay script).

## What is NOT here (and why)

- **No secrets.** This raw spec contains only public data (balances, the authority / committee
  **public** keys, the wasm). The operator's secret keys are the `.skey` files from
  `cogno-chain-cli key gen`, kept offline — see [Regenerate](#regenerate-operator).
- The private/LAN bootnode the generator embeds for local peering is trimmed from the committed
  copy (it leaks a LAN IP and is useless off-LAN). The operator's own `network/raw.json` keeps it.

## Regenerate (operator)

`cogno-chain-node gen-chainspec` mints a fresh operator-keyed spec (`raw.json` + a plain, inspectable
spec) from the `.skey` files produced by `cogno-chain-cli key gen` (kept offline). To publish a new
genesis, copy `network/raw.json` here (trimming the LAN bootnode) and update the genesis hash above.

> **Regenerating the network changes the genesis** — every account, identity bind, and post from the
> previous genesis is gone. Point every node (and the frontend's RPC endpoint) at the new spec.
