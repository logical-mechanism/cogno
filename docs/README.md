# cogno-chain docs

Pick your lane. Most people want the first one.

## Try it — see the app against the live chain

The fastest path to actually using cogno-chain. No keys, no Cardano, no validator.

1. Build the node — [`../README.md`](../README.md#build) (`cargo build --release`).
2. **[RELAY-NODE.md](RELAY-NODE.md)** — run a tracking node that syncs the live preprod chain and
   serves it to your browser.
3. **[LOCAL-FRONTEND.md](LOCAL-FRONTEND.md)** — point the app at your node and post.

## Run a node of your own

- **[PREPROD-BRINGUP.md](PREPROD-BRINGUP.md)** — stand up your own validator: mint keys, generate a
  genesis, produce blocks, and drive the on-chain admin loop.
- **[../deploy/README.md](../deploy/README.md)** — the always-on server runbook (systemd, backups,
  monitoring).
- **[UPGRADES.md](UPGRADES.md)** — ship new runtime code to a live chain (the two-command,
  sudo-free upgrade; single- vs multi-operator).
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
- **[SCALE-NODE-READS.md](SCALE-NODE-READS.md)** — why the node serves reads directly, with no
  external indexer.

> **Deep-dives contain design history.** ECONOMICS and IN-PROTOCOL-OBSERVATION carry build-era
> decisions and status notes alongside the current design — they explain *why*, but they are not
> onboarding steps. To run or test the chain you only need the two lanes above.

## Not built yet

- **[CLIENT-SIDE-RANKING.md](CLIENT-SIDE-RANKING.md)** — a design for client-side feed ranking.
  Proposal, not shipped.
