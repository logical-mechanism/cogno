# chainspecs/

Committed **raw chain specs** for cogno-chain networks — the file you pass a node as
`--chain` to join a network with the right genesis + bootnodes.

| File | Network | Genesis hash | Runtime embedded in genesis |
|---|---|---|---|
| `preprod.raw.json` | **Cogno Preprod (operator)** (operator-run preprod testnet, `id: cogno-preprod-operator`, `chainType: Live`) | `0x73eaa4bf5facbb3f8f7c7479aeda88dee1e9d5dd61e4ffb98bf4cf9aa305ef09` | `cogno-chain-runtime` spec 203 |

> **That runtime column is the GENESIS wasm, not the chain's current runtime.** A raw spec freezes
> the `:code` the chain *started* with. cogno-chain has been upgraded on-chain many times since, so
> a node that syncs from this file replays those upgrades and lands on whatever the live runtime is
> today — ask the chain (`state_getRuntimeVersion`), never this file. The genesis blob itself can
> never be refreshed in place: changing it changes the genesis hash, which is a different network.

> **Note.** This committed `preprod.raw.json` is a **tracking-node convenience** spec — its
> `genesis.raw.top` is byte-identical to the live chain's, so a relay syncs against it out of the
> box. It is **not** an operator's production genesis: a fresh operator mints their own offline from
> `.skey` files and keeps it out of the repo (see
> [`../docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md) Step 1). Its `properties` read
> `tokenSymbol: "FUEL", tokenDecimals: 12` (display metadata, not consensus) and it sets no libp2p
> `protocolId`. Its single embedded bootnode is the **public relay** (`157.230.53.66` — the droplet
> that also serves cogno.forum), not the validator, which runs from the operator's home network
> behind NAT and is not publicly reachable. Regenerating the spec changes the genesis hash — update
> the table row above whenever you do.

These are **raw** specs: genesis is pre-encoded storage (40 keys) and embeds the zstd-compressed
runtime wasm (`:code`, ~530 KB), so the file is ~1.07 MB. That weight is the price of a node-ready,
genesis-pinned spec anyone can sync against without rebuilding the runtime.

## Use it

Run the local **relay / tracking node** (non-validator; P2P-syncs the network and serves
RPC to the frontend) — it defaults to this spec:

```bash
scripts/run-tracking-node.sh
# → --chain chainspecs/preprod.raw.json, RPC ws://127.0.0.1:9944, P2P :30333, DB in .relay-data/
```

It unsets `DBSYNC_URL`/`DBSYNC` on the way in, so the Cardano observer abstains on import and the
node tracks the chain without needing db-sync. Onboarding a real relay host is
[`../docs/RELAY-NODE.md`](../docs/RELAY-NODE.md).

Or pass it to any node directly:

```bash
./target/release/cogno-chain-node run --chain chainspecs/preprod.raw.json --base-path /tmp/cogno
```

The single embedded bootnode is the public relay:
`/dns4/157.230.53.66/tcp/30333/p2p/12D3KooWGuaAfQV5pafWLNsTdtwEdPN2jL3MmpAgvhdkHtcab3jj`. Add more
at run time with `--bootnodes <multiaddr>` (or `BOOTNODE=<multiaddr>` for the relay script).

## What is NOT here (and why)

- **No secrets.** This raw spec contains only public data (balances, the authority / committee
  **public** keys, the wasm). The operator's secret keys are the `.skey` files from
  `cogno-chain-cli key gen`, kept offline — see [Regenerate](#regenerate-operator).
- **No private bootnode.** `gen-chainspec --bootnode <multiaddr>` (repeatable) bakes bootnodes into
  the spec; omit it and `bootNodes` is empty. The committed copy carries only the **public** relay —
  no private/LAN address is embedded, which would leak a LAN IP and be useless off-LAN anyway.
- **No talk-stake weight.** An operator genesis seeds `pallet-talk-stake` **empty** — the
  `cardano-observer` inherent is the sole writer of weight and credits real locked-ADA vault weight
  from block 0. (Only the no-Cardano `--dev` / `local` presets seed posting weight.)
- **No governance-fuel allowances.** Genesis seeds a Balances endowment (`1 << 60` base units of the
  native FUEL, 12 decimals) to the validator + committee accounts plus anything passed to `--endow`.
  That endowment is the *only* funding it lays down: `pallet-governance-fuel@18` has **no** genesis
  config, so **zero** standing allowances exist at block 0. Every later seat is therefore
  **fund-before-seat**:
  - a **committee** seat — the base call filter rejects a `FollowerCommittee::set_members` that adds
    an account holding no allowance (it lands as `CallFiltered`). Accounts already in `Members` are
    exempt, so the genesis seats keep working and a rotation that re-lists them passes.
  - a **validator** — `ValidatorSet::add_validator` needs both a standing allowance
    (`ValidatorSet::NotFunded` otherwise) and already-registered session keys
    (`ValidatorSet::NoSessionKeys`).

  So the committee runs `fuel set-allowance` *before* `committee members set` / `validator add`, and
  a new validator runs `validator set-keys` on its own machine first (see
  [`../docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md) Step 6). The native token is
  non-transferable governance **FUEL** — not money, and not vote weight (committee votes are
  one-member-one-vote).

## Regenerate (operator)

This mints a **new** genesis. If you want to *join* the live chain, take the committed file above or
reconstruct one from a running node (next section) — a fresh `gen-chainspec` will not peer with it.

`cogno-chain-node gen-chainspec` builds an operator-keyed spec from the `.skey` files produced by
`cogno-chain-cli key gen` (kept offline), reading only their **public** keys. It refuses the
well-known dev keys, and refuses a key file that is group- or other-readable — `--allow-dev-keys`
turns off **both** checks at once, so it is for dev-keyed test specs and nothing else. It writes
**two** files: a plain, inspectable spec (`--out-plain`, default `cogno-operator.plain.json`) and
the raw, sealed one (`--out-raw`, default `cogno-operator.raw.json`) — the raw one is what `--chain`
takes.

Bake the public bootnode in at generation time; it needs the trailing `/p2p/<PeerId>`, which
`cogno-chain-node key inspect-node-key --file <node.key>` prints (the p2p key itself comes from
`cogno-chain-cli key generate-node-key`).

```bash
cogno-chain-node gen-chainspec --base cogno-preprod \
  --validator-account-key val-account.skey \
  --validator-aura-key val-aura.skey --validator-grandpa-key val-grandpa.skey \
  --committee-key seat1.skey \
  --bootnode /dns4/<relay-host>/tcp/30333/p2p/<peer-id> \
  --out-plain preprod.plain.json --out-raw preprod.raw.json
```

`--committee-key` is repeatable and defaults to the validator account (the single-operator
bootstrap); the committee must end up at 1 seat or ≥3, because `ceil(2·3/5)=2` makes a 2-seat
committee a unanimity trap that one lost key bricks with no sudo recovery. `--endow <SS58>`
(repeatable) funds extra accounts.

To publish a new genesis, copy the generated raw spec here as `preprod.raw.json` and update both the
genesis hash and the genesis-runtime column above.

> **Regenerating the network changes the genesis** — every account, identity bind, and post from the
> previous genesis is gone. Point every node (and the frontend's RPC endpoint) at the new spec.

## Reconstruct one from a running node

If the spec you need is for a network that already exists, you do not have to copy anyone's
`raw.json`. `scripts/fetch-chainspec.mjs` rebuilds a genesis-identical raw spec from an **archive**
node's **safe, read-only** HTTP JSON-RPC: it pages every storage key at the genesis block
(`state_getKeysPaged`) and reads each value as-of genesis (`state_getStorage`), which is exactly the
`genesis.raw.top` map. Copying those bytes reproduces the genesis state root, so the genesis hash
matches by construction — the script prints it, and a launched node's `chain_getBlockHash(0)` must
agree.

Archive is the part that bites: both calls are as-of block 0, and a node on the SDK default
(`--state-pruning 256`) threw that trie away long ago, so it answers `State already discarded` and
the script aborts on the first error. The deployed relay and `scripts/run-tracking-node.sh` both run
`--state-pruning archive --blocks-pruning archive`, which is why they can serve this.

```bash
node scripts/fetch-chainspec.mjs https://cogno.forum/rpc \
  --bootnode /dns4/157.230.53.66/tcp/30333/p2p/12D3KooWGuaAfQV5pafWLNsTdtwEdPN2jL3MmpAgvhdkHtcab3jj \
  --id cogno-preprod-operator \
  --out network/raw.json
```

It speaks JSON-RPC over HTTP, not WebSocket, and rejects a `ws://`/`wss://` endpoint outright (a
node's ws proxy usually also accepts HTTP POST on the same path). Everything it writes besides
`genesis.raw.top` — `name`, `id`, `protocolId`, `chainType`, `bootNodes`, `properties` — is metadata
that does not enter the genesis hash; `--id`, `--protocol-id`, `--chain-type` and `--bootnode` set
it. Pass `--id` anyway. Omitted, the script slugs `system_chain` and you get
`cogno_preprod_(operator)` (and `protocolId` copied from it) instead of the real
`cogno-preprod-operator`. Nothing about peering depends on that — libp2p derives the sync protocol
name from the genesis hash and falls back to `protocolId` only if it cannot — but the id names the
node's base-path subdirectory, and [`../docs/LOCAL-FRONTEND.md`](../docs/LOCAL-FRONTEND.md) tells
you to match what the network was generated with. Run it with the nvm node, not the snap one.
