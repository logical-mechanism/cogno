# chainspecs/

Committed **raw chain specs** for cogno-chain networks — the file you pass a node as
`--chain` to join a network with the right genesis + bootnodes.

| File | Network | Genesis | Runtime |
|---|---|---|---|
| `preprod.raw.json` | **Cogno Preprod (operator)** (operator-run preprod testnet, `id: cogno-preprod-operator`, `chainType: Live`) | `0x73eaa4bf5facbb3f8f7c7479aeda88dee1e9d5dd61e4ffb98bf4cf9aa305ef09` | `cogno-chain-runtime` spec 203 |

> **Note.** This committed `preprod.raw.json` is a **tracking-node convenience** spec — it matches the
> live chain's genesis and spec-203 runtime (`properties` read `tokenSymbol: "FUEL", tokenDecimals: 12`),
> so a relay syncs against it out of the box. It is **not** an operator's production genesis: a fresh
> operator mints their own offline from `.skey` files and keeps it out of the repo (see
> [`../docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md) Step 1). Its single embedded bootnode carries
> the live validator's libp2p peer id. Regenerating the spec changes the genesis hash — update the table
> row above whenever you do.

These are **raw** specs: genesis is pre-encoded storage and embeds the runtime wasm
(`:code`, ~500 KB), so the file is ~1.05 MB. That weight is the price of a node-ready,
genesis-pinned spec anyone can sync against without rebuilding the runtime.

## Use it

Run the local **relay / tracking node** (non-validator; P2P-syncs the network and serves
RPC to the frontend) — it defaults to this spec:

```bash
scripts/run-tracking-node.sh
# → --chain chainspecs/preprod.raw.json, RPC ws://127.0.0.1:9944, DB in .relay-data/
```

Or pass it to any node directly:

```bash
./target/release/cogno-chain-node run --chain chainspecs/preprod.raw.json --base-path /tmp/cogno
```

The single embedded bootnode is the operator's public DDNS node
(`/dns4/logicalmechanism.asuscomm.com/tcp/30333/...`). Add more with `--bootnodes <multiaddr>`
(or `BOOTNODE=<multiaddr>` for the relay script).

## What is NOT here (and why)

- **No secrets.** This raw spec contains only public data (balances, the authority / committee
  **public** keys, the wasm). The operator's secret keys are the `.skey` files from
  `cogno-chain-cli key gen`, kept offline — see [Regenerate](#regenerate-operator).
- **Bootnodes are added by hand.** `gen-chainspec` emits an empty `bootNodes`; the committed copy
  carries only the operator's **public** DDNS bootnode (added after generation). No private/LAN
  address is embedded — it would leak a LAN IP and be useless off-LAN.
- **No governance-fuel allowances.** Genesis seeds only a Balances endowment (`1 << 60` native FUEL) to
  the validator + committee accounts; `pallet-governance-fuel@18` has **no** genesis config, so **zero**
  standing fuel allowances are seeded. Under spec 203 a new committee seat or validator is gated on
  already holding a committee-granted regenerating fuel allowance (else `ValidatorSet::NotFunded` /
  `CallFiltered`), so federating out is **fund-before-seat**: the committee runs `fuel set-allowance`
  *before* `committee members add` / `validator add` (see
  [`../docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md) Step 6). The native token is non-transferable
  governance **FUEL** — not money or vote-weight.

## Regenerate (operator)

`cogno-chain-node gen-chainspec` mints a fresh operator-keyed spec (`raw.json` + a plain, inspectable
spec) from the `.skey` files produced by `cogno-chain-cli key gen` (kept offline). To publish a new
genesis, copy the generated raw spec here as `preprod.raw.json`, add the operator's public DDNS
bootnode to its `bootNodes` (the generator leaves the list empty), and update the genesis hash above.

> **Regenerating the network changes the genesis** — every account, identity bind, and post from the
> previous genesis is gone. Point every node (and the frontend's RPC endpoint) at the new spec.
