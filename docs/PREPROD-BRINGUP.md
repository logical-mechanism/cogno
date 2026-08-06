# Preprod single-observer bring-up runbook

How to stand up a **real, persistent, single-operator** cogno-chain on Cardano **preprod** and exercise the
full dapp loop (lock ADA → bind identity → earn talk-capacity → feeless post → read), then **federate out**.
This is the end-to-end companion to [deploy/README.md](../deploy/README.md) (the `systemd` mechanics) and
[docs/IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md) (the observer design). It ties genesis → node →
observed weight → frontend → federation into one sequence.

> **Posture.** A live, single-operator preprod testnet. The Cardano observer enforces from genesis (it's
> the sole writer of weight — no `set_stake`, no follower), and the full dapp loop is real, but with one
> producer it isn't trustless (that needs ≥3 independent producers, deliberately deferred). Full trust
> model: [ARCHITECTURE.md](ARCHITECTURE.md). `set_enforcement(false)` is a committee-gated emergency
> weight-freeze, not a routine mode.

## Prerequisites (external infrastructure you run separately)

The versions below are the ones this repo is built and run against. The one that matters for consensus is
**db-sync**: the observer's SQL depends on its schema, and a wrong or pruned instance is the only prereq a
bad choice can silently distort — so pin it.

| Component | Version here | Why |
|---|---|---|
| [rustup](https://rustup.rs/) → rustc | **1.93.0** (auto-selected from [`rust-toolchain.toml`](../rust-toolchain.toml)) | the toolchain the pinned polkadot-sdk `stable2606` train is verified against |
| [cardano-node](https://github.com/IntersectMBO/cardano-node) | **11.0.1**, synced on preprod | feeds db-sync |
| [cardano-db-sync](https://github.com/IntersectMBO/cardano-db-sync) | **13.7.x** | the observer's sole Cardano read |
| [PostgreSQL](https://www.postgresql.org/download/) | **16** | db-sync's database |
| [Node.js](https://github.com/nvm-sh/nvm) (nvm, **not** snap) | **v22.12.0** | the frontend only |
| [Ogmios](https://github.com/CardanoSolutions/ogmios) | **v6.14** (:1337) | frontend L1 lock/exit: tx submit + live cost models |
| [Aiken](https://github.com/aiken-lang/aiken/releases) | **v1.1.22** ([`contracts/aiken.toml`](../contracts/aiken.toml)) | only to *check* the contract — do not rebuild it, the hash is live |

- **db-sync must be FULL / non-pruned** (it retains history back to the reference) and **`tx_in`-enabled**
  (NOT `--consumed-tx-out` — spentness is read from `tx_in`). Expose a read-only role (e.g. `cogno_reader`)
  as `DBSYNC_URL`. A wrong or pruned db-sync does **not** silently fork the chain: the node's boot
  `config_check` flags it, and the read's `EXISTS (SELECT 1 FROM tx_in)` gate makes the observer **abstain
  fail-closed** rather than report a spent vault as still locked. MAINNET PREREQUISITE: db-sync over TLS.
- **Tune the Postgres, and add one index db-sync does not ship.** Both are pure operator config with no
  consensus surface, and between them they move the observer's per-block cost more than any code change
  on the roadmap.

  ```sql
  -- The role read was 81% of the four-read total, and ~230 ms of it was one thing: a parallel
  -- sequential scan of the whole tx_metadata table to find label-867 Calidus registrations. db-sync
  -- indexes tx_metadata on (id) and (tx_id) only — never on `key` — so the scan discarded 1 637 391
  -- rows to return 153.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_metadata_key ON tx_metadata (key);
  ```

  **Applied to the live preprod db-sync on 2026-08-04**, and measured either side of it at the same
  reference slot: 228.8–237.3 ms before, 8.1 ms cold and ~2.6 ms warm after, with `tx_metadata` buffer
  reads falling from 91 757 to 139 for the same 153 rows. A fresh db-sync needs it too — it is not a
  one-off repair.

  The Constitutional-Committee half of the same read needs a second one, and it is a **prerequisite,
  not tuning**:

  ```sql
  -- committee_registration carries 648 767 rows (56 MB) on preprod: one actor proposed a 30-member
  -- committee and then batched AuthCommitteeHot certificates for every cold key in it. db-sync indexes
  -- the table on (id) only, so resolving the sitting members' hot keys seq-scans all of it, every block.
  CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_committee_registration_cold_key
    ON committee_registration (cold_key_id);
  ```

  **Not yet applied** (the node says so at boot; see below), and not yet *costing* anything either: the
  committee block is gated on a non-empty claimed set, so while no account has claimed a CC credential
  the planner skips it outright. Measured warm on the live instance at the same reference slot, the
  whole role read is 65 ms with the gate closed and 160 ms with it open — roughly 100 ms a block once
  the axis is in use, of which the seq scan is ~96 ms. One feeless `claim_role_signed` opens the gate,
  so treat this as due before the first CC claim, not after.

  Why it is a prerequisite rather than a nicety: the cost is **linear in the row count**, not in the
  handful of rows the query returns, and the *entire* role read shares one 2 s fail-closed budget. Grown
  far enough the table does not make the CC badge slow — it times the read out, and
  `read_role_observation` returning `Err` abstains the whole observation. Vault credit, `VotingPower` and
  every SPO/dRep badge stop with it, chain-wide, for as long as the table stays that size. (The chain
  itself stays live: an abstaining author simply emits no observation.) At the measured ~0.14 µs/row that
  margin runs out around 10–14 M rows warm.

  How reachable that is, stated precisely rather than assumed: **not** by anyone, for free. cardano-ledger
  gates `AuthCommitteeHot` on `isCurrentMember || isPotentialFutureMember`, rejecting anything else with
  `ConwayCommitteeIsUnknown`, so growing the table needs a **live, deposit-backed `UpdateCommittee`
  proposal** (1 000 ADA on preprod) naming the cold keys, and growth stops when the proposal expires.
  Preprod's 648 767 rows resolve to 43 cold keys from exactly one such proposal, which expired at epoch
  194 — which is why the table has not grown since July 2025. So this is a bounded operational cost, not
  an open denial-of-service. It still wants the index: 21× is a plausible amount of history for a chain
  to accumulate over years, and the index removes the scaling term rather than widening the margin.

  Both indexes are checked at boot: the node's `config_check` probes `pg_index` and logs an ERROR naming
  the missing one and the exact statement to run. Same `inet_server_addr()` caveat as above.

  The full write-up, the invalid-index recovery, the vacuum settings and the trap that cost an hour here
  (a second preprod db-sync on another host will accept the `CREATE INDEX` and report success, while the
  database the node actually reads is untouched) are in
  [`docs/DBSYNC-INDEXING.md`](DBSYNC-INDEXING.md). Confirm `inet_server_addr()` matches `DBSYNC_URL`
  before running anything.

  Separately, check `shared_buffers` and `work_mem`. A stock Postgres runs `shared_buffers = 128MB`
  against what is already a 34 GB database on preprod, and the vault read's heap traffic cannot stay
  cached at that size. Still open, and deliberately left until after the index so each change has its own
  measurement. Raising it moves every number in
  [`docs/OBSERVATION-READ-SHAPE-PLAN.md`](OBSERVATION-READ-SHAPE-PLAN.md).
- **The built node binary**, from a clean `cargo build --release`. The **same** binary must generate the
  genesis and run the node — a `--features runtime-benchmarks` build embeds a runtime a normal node can't
  run, and a different build changes the genesis.
- **Ogmios + Blockfrost** are needed only by the **frontend's** L1 lock/exit. The node never talks to them;
  skip for a first bring-up.

## The loop at a glance

```
   Cardano preprod (db-sync, read-only)
            │  observe (deterministic, every block)
            ▼
   ┌──────────────────────────────────────┐
   │  cogno-chain-node (Aura+GRANDPA)      │   the cardano-observer inherent is the SOLE writer:
   │    · observer inherent → credits      │   it credits talkStake.AllowedStake / VotingPower directly
   │      talkStake.AllowedStake directly  │   (EnforceWeight = true from genesis — no committee sync-weight)
   │    · feeless bare-unsigned CIP-8 binds │◀── link_identity_signed / link_stake_signed, verified at
   │    · serves ALL reads (runtime API)   │    pool admission — submitted straight from the browser
   └──────────┬───────────────────────────┘
              │ ws://…:9944 (PAPI)
              ▼
   app/ (Next.js + MeshJS + PAPI)  ──L1 lock/exit──▶ Ogmios / Blockfrost
```

## Step 1 — Generate + archive the operator-keyed genesis

The committed [`chainspecs/preprod.raw.json`](../chainspecs/preprod.raw.json) is a *tracking-node
convenience* spec for the operator's **existing** live chain — it is not a genesis you can reuse. Your own
network needs its own genesis, minted once from your own keys and kept out of the repo. That is this step.
From a checkout, with the clean release binary:

```bash
CLI=./target/release/cogno-chain-cli
$CLI key gen --scheme sr25519 --out val-account.skey
$CLI key gen --scheme sr25519 --out val-aura.skey
$CLI key gen --scheme ed25519 --out val-grandpa.skey
$CLI key gen --scheme sr25519 --out seat1.skey
$CLI key generate-node-key   --out val-p2p.key         # libp2p node (p2p) key — installed to /etc/cogno/node.key in Step 2

./target/release/cogno-chain-node gen-chainspec --base cogno-preprod \
  --validator-account-key val-account.skey \
  --validator-aura-key val-aura.skey --validator-grandpa-key val-grandpa.skey \
  --committee-key seat1.skey \
  --out-raw chainspec.raw.json
```

This writes `chainspec.raw.json` (the sealed spec — only PUBLIC keys, safe to install/copy) plus a plain,
inspectable spec (default `cogno-operator.plain.json`). Dev keys are **refused** unless `--allow-dev-keys`.
The secret material is the `.skey` files from `key gen` plus `val-p2p.key` from `key generate-node-key`
(**`chmod 600`, IRREPLACEABLE — archive them off-host**; a lost `val-p2p.key` just means a new peer id,
not a lost genesis, but re-minting it changes the bootnode multiaddr). Re-running `key gen` mints *new* random keys and a *different* genesis, so those `.skey` files +
`chainspec.raw.json` **are** your stable genesis. Never commit the `.skey` files. (When omitted, `--committee-key`
defaults to the validator account — the single-operator bootstrap seats a one-seat committee.)

## Step 2 — Run the node persistently, **with `DBSYNC_URL`**

Follow [deploy/README.md](../deploy/README.md) for host setup, `key insert` (aura sr25519 + gran ed25519 into
`/var/lib/cogno/node`), the EnvironmentFile, and `systemctl enable --now cogno-node`. Do **not** use `--dev`
or `--tmp`. The committed [`cogno-node.service`](../deploy/systemd/cogno-node.service) already carries
`EnvironmentFile=-/etc/cogno/cogno.env`; put your read-only `DBSYNC_URL` there
([`cogno.env.example`](../deploy/systemd/cogno.env.example)). Without it the observer logs
`no DBSYNC_URL/DBSYNC set — abstaining` and credits nothing (the chain still produces + finalizes).

## Step 3 — Confirm the observer is live (enforcing)

Once the node is producing + finalizing:

```bash
journalctl -u cogno-node -f                        # "Imported #N" / "finalized #M" advancing
curl -s localhost:9615/metrics | grep cogno_observer
```

You want `cogno_observer_observations_total` climbing, `cogno_observer_observed_vaults` reflecting the live
vault set, and `cogno_observer_last_reference_slot` advancing with Cardano's tip. The on-chain audit trail is
the `cardanoObserver.ObservationApplied` event (`enforced=true`; `credited=0` until an account is bound +
weighted — expected on a fresh chain). Block #1's parent is genesis → pre-Shelley → a legitimate abstain;
observation begins at block #2. Each block #2+ header also carries the `cobs` `PreRuntime` digest (engine id
`636f6273`) sealing the stable Cardano anchor. If db-sync is unset/down, the observer abstains
(non-fatal) — the `ObserverAbstaining` alert in [deploy/monitoring/](../deploy/monitoring/) catches a
sustained abstention.

## Step 4 — Binds are feeless (no relay, no weight-sync to run)

There is **no weight step to run**: the observer credits `talkStake.AllowedStake`/`VotingPower` directly, every
block, as the sole writer. A new lock is credited on the next observed block — nothing off-chain to schedule.

The CIP-8 binds (`cognoGate.link_identity_signed` for identity, `link_stake_signed` for voting power) are
**feeless bare unsigned extrinsics**: the CIP-8 proof *is* the authorization, and the runtime verifies it at
transaction-pool admission (`validate_unsigned`) and again at block inclusion, so junk + already-bound /
tombstoned proofs are rejected before gossip. A freshly sign-to-derived, **zero-balance** browser account
therefore binds itself directly — no fee payer, no nonce, no funded relay. Spam costs an attacker only the
per-block-weight-bounded ed25519 verify and grants nothing actionable (capacity + voting power come from
observed Cardano stake keyed on the bound credential); rate-limit feeless calls at the RPC ingress if needed.
(A CLI equivalent of the browser bind is `cogno-chain-cli identity bind` / `bind-stake`, which build the same
bare-unsigned extrinsic from a CIP-8 proof — see `identity prove`.)

## Step 5 — Point the frontend at the chain

[app/](../app/README.md) is a static-export Next.js client that reads **everything from the node** (feed /
thread / search / profile via PAPI + the runtime read API — no indexer, no GraphQL). Set its endpoints to your
node (`ws://<host>:9944`, behind TLS for anything public — see follow-ups). This branch is **spec 204**; after
any spec bump regenerate PAPI descriptors:
`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

## Step 6 — Federate out (grow past the single operator)

Everything privileged goes through the committee — there is no sudo. Drive it with `cogno-chain-cli` from an
operator machine (keys by file, **off** the node host). At one committee seat the 3/5 threshold is
`ceil(1·3/5)=1`, so a bundled motion executes on propose; split the seats first, then it needs co-signers.

```bash
CLI=./target/release/cogno-chain-cli
WS=ws://<host>:9944

# 1) Seat more committee (by vote). Federate the single founder seat straight to THREE — never to two:
#    `ceil(2·3/5)=2` is unanimity, so a 2-seat committee has zero fault tolerance and one lost key bricks
#    governance with no recovery (the runtime rejects a 2-seat `set_members` as `CallFiltered`). Fund each
#    new seat FIRST with a standing (regenerating) fuel allowance so it can pay the fee-bearing
#    propose/vote/close — seating a member with no allowance is rejected on-chain. This bundled `members set`
#    executes on the founder's lone aye (threshold 1) and lands a fault-tolerant 3-of-5-shaped set at once.
$CLI fuel set-allowance --account <SEAT2_SS58> --max 1000000000000000 --committee-signing-key-file seat1.skey --ws $WS
$CLI fuel set-allowance --account <SEAT3_SS58> --max 1000000000000000 --committee-signing-key-file seat1.skey --ws $WS
$CLI committee members set --members <SEAT1_SS58>,<SEAT2_SS58>,<SEAT3_SS58> --committee-signing-key-file seat1.skey --ws $WS

# 2) Admit a validator: the committee first funds the account with a standing (regenerating) fuel
#    allowance so it can pay the fee-bearing `set-keys`; the NEW validator then registers its own session
#    keys (real proof-of-possession); the committee admits its account. Changes apply at a session boundary.
$CLI fuel set-allowance --account <NEW_VALIDATOR_SS58> --max 1000000000000000 --committee-signing-key-file seat1.skey --ws $WS

#    On the NEW validator's OWN machine — it mints its own keys, then self-signs the registration:
#      $CLI key gen --scheme sr25519 --out val-account.skey
#      $CLI key gen --scheme sr25519 --out val-aura.skey
#      $CLI key gen --scheme ed25519 --out val-grandpa.skey
$CLI validator set-keys --account-signing-key-file val-account.skey \
  --aura-signing-key-file val-aura.skey --grandpa-signing-key-file val-grandpa.skey --ws $WS

$CLI validator add --validator <NEW_VALIDATOR_SS58> --committee-signing-key-file seat1.skey --ws $WS
#    Fuel regenerates toward the allowance each period (never drains); `fuel revoke` cuts an account off.
#    Drop --force-authoring once ≥2 validators peer (GRANDPA needs ≥2/3 online to finalize).

# 3) Runtime upgrade (sudo-free): committee authorizes the code hash, then anyone applies the WASM.
$CLI upgrade authorize --wasm ./cogno_chain_runtime.compact.compressed.wasm --committee-signing-key-file seat1.skey --ws $WS
$CLI upgrade apply --account-signing-key-file val-account.skey --wasm ./cogno_chain_runtime.compact.compressed.wasm --ws $WS
```

`upgrade apply` is **permissionless** (any account) and refuses a non-increasing `spec_version`. See
[UPGRADES.md](UPGRADES.md) for the upgrade flow, [D2-custody-runbook.md](D2-custody-runbook.md) for splitting
the committee across custodians, and [RELAY-NODE.md](RELAY-NODE.md) for onboarding tracking/relay nodes.

## The dapp loop, end to end

1. In the browser (CIP-30 wallet), **lock ≥100 ADA** at the live preprod `talk_vault` (mints the beacon). →
   Ogmios/Blockfrost.
2. **Bind identity**: sign the CIP-8 proof; the browser submits the feeless bare-unsigned
   `link_identity_signed` directly. → 1:1 owner-address ↔ account.
3. The **observer** sees the lock via db-sync on the next block and credits `talkStake.AllowedStake`. →
   talk-capacity appears (no manual step).
4. **Post feelessly** — `microblog.post_message` passes `CheckCapacity` (Δbalance = 0).
5. **Read** the feed — served by the node's runtime API (PAPI).

## Do **not** touch (scoped-out testnet choices / live invariants)

- **`set_enforcement` is already `true` (enforced from genesis).** `set_enforcement(false)` is a committee-gated
  **emergency weight-freeze** (keep verifying, stop crediting) — not a routine toggle. The path to *trustless*
  enforcement is **≥3 independent producers**, not a flag.
- **Do not edit `contracts/`** — the live preprod vault hash (`168a9710…` applied, blueprint `49ffbfc6…`)
  must not move; any production edit recompiles and orphans the deployed vault.
- **Leave `CARDANO_NET` on `Preprod`** (`runtime/src/configs/mod.rs`). Since spec 211 that ONE selector
  derives every network-dependent constant — the CIP-19 network id, both Shelley anchors, the 600-slot
  observation stability window, the `min_lock` floor and the vault policy id — so a cutover cannot be
  partial. Flipping it to `Mainnet` is a labeled MAINNET PREREQUISITE, not a knob to touch here.
- **`MinAuthorities = 1` + `--force-authoring`** is the intended single-authority posture — not a bug.
- **Never renumber pallet indices** (on-wire contract). Indices **6** (Sudo) and **12** (Anchor) are
  permanently vacant; **7** is GovernedUpgrade.

## Before you lean on it — close the ops gaps

These are **config/runbook, not code blockers**:

- **Back up `/var/lib/cogno`** (the node DB is the *sole* copy of chain history at `MinAuthorities = 1`) and
  the operator **`.skey` / `keys.json` files** (irreplaceable). No backup tooling ships yet.
- **Cap journald** (`SystemMaxUse=` / `MaxRetentionSec=` drop-in) so logs can't fill the disk.
- **Wire a real Alertmanager receiver** — the shipped config blackholes all alerts by default (see
  [deploy/monitoring/](../deploy/monitoring/)).
- **Harden the RPC** if exposing it: TLS reverse proxy + `--rpc-methods=safe` + firewall (the node binds
  localhost with `--rpc-cors all` today).

## What this proves (and what it doesn't)

Running this proves the **mechanism and operations** end to end on real preprod data: deterministic db-sync
observation, header-sealed anchors, enforced observer-credited weight, sudo-free committee governance, and the
full lock→bind→weight→post→read loop. It does **not** prove cross-*instance* observation determinism or provide
any trust/decentralization — that is the deferred validator-decentralization workstream (≥3 producers each with
their own db-sync). Treat it as a durable iteration platform — trust-minimized, not trustless, until then.
