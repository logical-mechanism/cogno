# cogno-chain — Architecture

This is the design entry point: one current overview of how the whole system fits together. The
trust posture, the repository layout, and the pallet-index map live in the
[README](../README.md) — this document does not repeat them. Instead it goes deep on the three
things that make cogno-chain unusual: how it **observes** Cardano, how posting stays **feeless**,
and how it **authors and seals** blocks.

The live chain is **spec_version 203 / transaction_version 3**, genesis `0x73eaa4bf`.

## What it is

cogno-chain is a Polkadot-SDK (Substrate) app-chain for a *feeless* "post text / read text" social
app. There are no per-post fees. The right to post is metered by a regenerating, stake-weighted
**talk-capacity** that an account earns by locking ADA in a Cardano contract.

Cardano is **observed, not bridged**. It supplies three things and holds no custody of chain state:

1. **Identity** — a 1:1 binding between a Cardano address (proved by a CIP-8 wallet signature) and a
   posting account. This is the anti-Sybil root; see [`TRUSTLESS-IDENTITY.md`](TRUSTLESS-IDENTITY.md).
2. **Weight** — the ADA an account locks in the `talk_vault` contract becomes its posting power; the
   total stake behind the bound credential becomes its voting power.
3. **A clock** — each block header seals the hash of a stable, finalized Cardano block, so every node
   reduces the same Cardano state at the same point in the chain's history.

The chain inherits **none** of Cardano's finality or security. It runs its own operator-run **Aura**
(block production) and **GRANDPA** (finality), and never writes anything back to Cardano — no bridge,
no message passing, no metadata anchoring. It is a single-operator preprod testnet: trust-minimized,
not trustless, and honest about it. The full trust posture is in the
[README](../README.md#what-youre-trusting).

## The Cardano contract (`talk_vault`)

`contracts/` holds an Aiken (Plutus V3) validator called `talk_vault`. To join, a user locks ADA at
the vault and commits their posting account and identity in the datum. The lock does double duty: it
is the account's posting deposit *and* the source of its weight. The vault also mints a **beacon**
token whose name is `blake2b_256(cbor(owner))` — the on-chain identity hash the observer looks for.
Exiting burns the beacon and releases the ADA. Custody never leaves Cardano; the app-chain only reads
the lock.

The contract is **live on preprod, and its script hash is load-bearing**: any production edit under
`contracts/` recompiles the validator and moves the hash, orphaning the deployed vault. Treat it as
frozen — even a `trace` line bakes into the script and moves the hash. See
[`contracts/README.md`](../contracts/README.md).

## Observation — Cardano → weight

Weight enters the chain through exactly one path: the **`cardano-observer` inherent**. Every block,
the authoring node reduces current Cardano state to a weight table and proposes it; every other node
re-runs the same reduction and rejects a block whose result differs. There is no admin "set weight"
call. Because all nodes must agree byte-for-byte, a divergence between two readers is not a glitch —
it is a **chain fork**. That constraint drives every design choice below.

- **db-sync is the only source.** The node reads Cardano through a read-only db-sync Postgres via the
  shared `cogno-dbsync` crate, in two places: the inherent-data provider that writes consensus weight,
  and a non-blocking `config_check` probe at boot. A **golden fixture** in `cogno-dbsync` pins both to
  the same bytes. Ogmios still *submits* L1 transactions and serves cost models, and the browser wallet
  uses Blockfrost — but no consensus-critical read ever touches anything but db-sync.
- **The reduction is deliberately literal**, so it stays identical across nodes and db-sync versions:
  - spentness comes from the **`tx_in`** table, never the denormalized `consumed_by_tx_id`;
  - coin and quantity amounts are read as **`::text`** (lovelace exceeds 2⁵³ and would lose precision
    as a float or 64-bit int);
  - the vault UTxO set is driven from **`tx_out.payment_cred = <script hash>`**;
  - when `tx_in` is missing the observer **fails closed and abstains**, so a pruned or wrong-mode
    db-sync can never report a spent vault as still locked;
  - when one identity controls several vault UTxOs, the **largest wins** — weights are never summed.
- **Enforcement is on from genesis** on preprod/mainnet. The dev/local presets seed weight at genesis
  instead, because there is no Cardano to observe.

The resulting weight lands in the `TalkStake` ledger (`AllowedStake` for posting, `VotingPower` for
votes). The CLI's `query weight` reads that ledger over RPC — it does not read db-sync. Full detail:
[`IN-PROTOCOL-OBSERVATION.md`](IN-PROTOCOL-OBSERVATION.md). db-sync must run FULL (non-pruned),
`tx_in`-enabled (not `--consumed-tx-out`), and — for mainnet — over TLS.

## The feeless model — capacity and governance fuel

Posting and the social actions around it (votes, polls, quotes, follows, profile edits) carry no fee.
Instead each account holds a **talk-capacity**: a budget that regenerates over time in proportion to
its observed weight and is spent per action. A social extrinsic is admitted only if the account has
capacity for it. The **`CheckCapacity`** transaction extension enforces this at the transaction-pool
boundary, and the **`SkipFeelessPayment`** extension waives the normal fee so nothing is charged. Lock
more ADA and your capacity ceiling and regeneration rate both rise — this is the whole "pay with
stake, not fees" mechanic.

Governance and operator calls are the exception. Committee propose/vote/close, `set_keys`, and the
like stay ordinary fee-bearing calls paid in the native token. To keep that from becoming a trap — a
committee that drains its balance could no longer govern, and the token is otherwise unspendable —
those fees are paid from **governance fuel**: a non-transferable native balance administered by
`pallet-governance-fuel`. The committee grants an account a standing allowance with `set_allowance`;
an `on_initialize` hook mints it back up each period, so fuel **regenerates** and a drained member can
never be locked out. Fuel cannot be moved (the base call filter blocks every `Balances` call) and
cannot post (the social layer never reads balances). See [`ECONOMICS.md`](ECONOMICS.md).

## Consensus and the header seal

Aura produces blocks and GRANDPA finalizes them, over an authority set the operator runs. The set is
**mutable**: `pallet-session` plus a forked `pallet-validator-set` let the committee add and remove
producers at session boundaries. Onboarding is **fund-before-seat** — a new producer needs a
governance-fuel allowance and registered session keys first, so the order is `set_allowance` →
`set_keys` → `add`, and an unfunded or keyless add is rejected on-chain. See
[`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md) Step 6. At low authority counts GRANDPA finality is fragile
by design; the honest floor and `MinAuthorities` are documented mainnet prerequisites, left low for
testnet.

**The header seal** is what makes observation deterministic. `node/src/consensus/` is a custom block
author (a reimplementation of the Apache-2.0 partner-chains proposer and inherent-digest machinery)
that, at the moment it authors a block, picks a stable finalized Cardano block and writes its anchor
into the block header as a `PreRuntime` digest tagged **`cobs`**. Every node then reduces Cardano
state against *that exact anchor* rather than against "now", which is why two honest nodes compute the
same weight. This seal is the surviving purpose of that consensus code — it is not the old
metadata-anchoring path, which was removed.

## Reads — folded into the node

There is no external indexer. The runtime exposes a **`MicroblogApi`** (an `sp_api` read API served
over `state_call`) that returns enriched, viewer-aware feed / thread / profile / search / people /
replies pages in one call, plus poll tallies, follow edges, and identity resolution. These run
off-chain and are not block-weight-metered, so bounded linear scans are acceptable. How the node serves
the whole feed with no external indexer is in [`SCALE-NODE-READS.md`](SCALE-NODE-READS.md).

## The frontend and the CLI

`app/` is a Next.js 16 **static export**. It reads and writes the chain node-direct through PAPI —
reads via `MicroblogApi`, writes as ordinary or bare-unsigned extrinsics (a CIP-8 bind is bare because
the wallet signature is itself the authorization). It uses MeshJS for the CIP-30 browser wallet and
the `talk_vault` lock/exit, submitting Cardano transactions via Blockfrost with live Ogmios cost
models. It is the only non-Rust surface and holds no privileged keys. Run it against a real chain:
[`LOCAL-FRONTEND.md`](LOCAL-FRONTEND.md).

`cogno-chain-cli` is the all-Rust admin tool. It builds typed `RuntimeCall` values only, so calls that
don't exist by design — `set_stake`, `sudo`, `set_code`, `anchor` — literally cannot be constructed.
It takes keys by file path, drives the committee lifecycle (propose / vote / close over
`FollowerCommittee`), submits bare identity binds, and runs `query state` / `query weight` over RPC.
The node carries the matching operator subcommands (`gen-chainspec`, which refuses dev keys;
`export-chain-spec`; `key insert` / `inspect-node-key`), and runs the db-sync `config_check` probe
once at boot.

## Operating it

- Bring up a fresh chain: [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md).
- Run a tracking / relay node: [`RELAY-NODE.md`](RELAY-NODE.md).
- Upgrade a running chain (committee-authorized): [`UPGRADES.md`](UPGRADES.md).
- Committee custody / rotation / audit: [`D2-custody-runbook.md`](D2-custody-runbook.md).
- Deployment (systemd + monitoring): [`../deploy/README.md`](../deploy/README.md).
