# cogno-chain docs

Pick your lane. Most people want the first one.

## Just use it

The app is live at **<https://cogno.forum>**, against a public RPC endpoint at **`wss://cogno.forum/rpc`**.
Nothing to build. You need a Cardano preprod wallet and 100 ADA to lock before you can post.

## Run it yourself

Sync the live chain on your own machine and point the app at your own node — no keys, no Cardano
db-sync, no validator.

1. Build the node — [`../README.md`](../README.md#build) (`cargo build --release`).
2. **[RELAY-NODE.md](RELAY-NODE.md)** — run a tracking node that syncs the live preprod chain and
   serves it to your browser.
3. **[LOCAL-FRONTEND.md](LOCAL-FRONTEND.md)** — point the app at your node and post.

## Run a chain of your own

- **[PREPROD-BRINGUP.md](PREPROD-BRINGUP.md)** — stand up your own validator: mint keys, generate a
  genesis, produce blocks, and drive the on-chain admin loop.
- **[../deploy/README.md](../deploy/README.md)** — the always-on server runbook (systemd, backups,
  monitoring).
- **[UPGRADES.md](UPGRADES.md)** — ship new runtime code to a live chain (the two-command, sudo-free
  upgrade; single- vs multi-operator).
- **[D2-custody-runbook.md](D2-custody-runbook.md)** — split committee keys across custodians when you
  federate to real independent operators.

## Understand how it works

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — start here: the whole stack, the trust model, the pallets.

Then the focused deep-dives, if you want the detail:

- **[ECONOMICS.md](ECONOMICS.md)** — why posting is feeless and how talk-capacity (your stake = your
  rate limit) works.
- **[IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md)** — how the node reads Cardano
  deterministically to credit weight.
- **[TRUSTLESS-IDENTITY.md](TRUSTLESS-IDENTITY.md)** — the on-chain CIP-8 identity proof.
- **[VERIFIABLE-ROLE-TAGS.md](VERIFIABLE-ROLE-TAGS.md)** — verified SPO / dRep / CC profile badges, proven
  by CIP-8 and confirmed live by the observer.
- **[SCALE-NODE-READS.md](SCALE-NODE-READS.md)** — why the node serves reads directly, with no
  external indexer.
- **[PROTOCOL-PARAMS.md](PROTOCOL-PARAMS.md)** — every tunable (block time, capacity costs, bounds,
  governance thresholds) with its current value and where to change it in the code.

> These explain *why*, not *how to run*. They're the reference for understanding the design — you
> don't need any of them to run or test the chain; the lanes above cover that.
