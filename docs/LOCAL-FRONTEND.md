# Iterate on the frontend against the real chain (local tracking node)

> **Just want to use cogno?** It is already hosted at **<https://cogno.forum>**, served by a public RPC
> endpoint at **`wss://cogno.forum/rpc`** — nothing to build. This doc is for *developing* the frontend.

Develop the `app/` frontend locally while it reads **live data from the real cogno-chain**, without
running a validator or touching the operator's node. You run a **tracking node** (a non-validator
"relay") that syncs the real chain over P2P and serves RPC to your dev frontend on `127.0.0.1`.

(You can also skip the node and point the dev server straight at the public RPC —
`NEXT_PUBLIC_WS_URL=wss://cogno.forum/rpc` — but then you are trusting the operator's node for reads.
Running your own tracking node is the point of the loop below.)

```
 ┌────────────┐   libp2p P2P    ┌───────────────────────────┐   ws RPC :9944   ┌──────────────┐
 │ validator  │◀───────────────▶│  local tracking node      │◀───────────────▶│ app          │
 │ (producer) │   :30333        │  (relay; no --validator)  │                 │ (next dev    │
 │ = truth    │                 │  syncs + serves reads     │                 │  :3000)      │
 └────────────┘                 └───────────────────────────┘                 └──────────────┘
```

The validator stays the sole block producer; the relay only follows it, answers reads, and broadcasts
the posts you submit — it can't author or affect consensus. Running the tracking node itself is covered
in [RELAY-NODE.md](RELAY-NODE.md); this doc is the frontend-dev loop on top of it.

## The loop

1. **Build the node** — `cargo build --release`.

2. **Run a tracking node.** The committed [`chainspecs/preprod.raw.json`](../chainspecs/preprod.raw.json)
   already matches the live chain (spec 203, genesis `0x73eaa4bf…`) and has the validator's bootnode
   embedded, so there's no spec-building step:

   ```bash
   ./scripts/run-tracking-node.sh          # non-validator, no db-sync; RPC on 127.0.0.1:9944, DB in ./.relay-data
   ```

   Use the **nvm node** (`~/.nvm/versions/node/v22.12.0/bin` on `PATH`) for anything Node-related — the
   snap node swallows stdout. The observer abstains with no db-sync configured (non-fatal), so the relay
   syncs and follows the chain regardless.

3. **Point the frontend at it.** The app already defaults to `ws://127.0.0.1:9944` (the relay). To be
   explicit, set it in `app/.env.local` (gitignored), then run the dev server:

   ```bash
   # app/.env.local
   NEXT_PUBLIC_WS_URL=ws://127.0.0.1:9944
   ```
   ```bash
   cd app
   npm install                    # postinstall runs `papi` → generates @polkadot-api/descriptors
   npm run dev                    # :3000 (nvm node) — reads live chain data through the relay
   ```

   A user can override the endpoint at runtime in Settings (persisted in `localStorage`), which always
   wins over the build default.

> **Descriptors must match the live runtime.** The bundled `@polkadot-api/descriptors` are generated at
> `npm install` from a metadata snapshot. If the live chain runs a different runtime than they were built
> against, decode/encode fails — regenerate against the relay: from `app/`,
> `rm .papi/descriptors/generated.json && npx papi add cogno -w ws://127.0.0.1:9944`, then re-run `npm run dev`.

> **Reads vs. writes.** Browsing the feed needs only the relay. The full post/bind/lock flow also needs
> Blockfrost (the in-browser CIP-30 vault; see [app/README.md](../app/README.md)). CIP-8 binds are feeless
> (bare unsigned, verified at pool admission), so the browser submits them directly — no bind relay.

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

## If the network was relaunched — rebuild the spec

Only needed if the committed `chainspecs/preprod.raw.json` is stale (a relaunch changes the genesis
hash). Reconstruct it from the validator's **read-only** RPC — [`scripts/fetch-chainspec.mjs`](../scripts/fetch-chainspec.mjs)
enumerates every genesis storage key and reads each value as-of genesis, reproducing the genesis state
root byte-for-byte:

```bash
node scripts/fetch-chainspec.mjs http://<validator-host>/rpc \
  --bootnode /ip4/<validator-ip>/tcp/30333/p2p/<peer-id> \
  --id cogno-preprod-operator \
  --out network/raw.json
# then: CHAINSPEC=network/raw.json ./scripts/run-tracking-node.sh
```

`--id` must match what the network was generated with (`gen-chainspec` derives it from `--base`). The
script prints the genesis hash so you can confirm it against the validator. If you already have the
operator's real `network/raw.json`, use it directly and skip this.

## Operator setup (exposing the validator)

For the relay to reach a validator you operate, that host must:

- **Serve RPC** to your dev machine — bind RPC for the LAN (`--rpc-external --rpc-methods safe
  --rpc-cors <origins>`, ideally behind a TLS/filtering proxy). Only the **safe** RPC set is needed.
- **Accept inbound P2P** on `:30333` from your machine. A tracking node syncs over libp2p, **not** RPC —
  if `:30333` is firewalled, sync never starts even though RPC works:

  ```bash
  sudo ufw allow from <your-lan-subnet>/24 to any port 30333 proto tcp
  # confirm from your dev machine: nc -z -w4 <validator-host> 30333
  ```
