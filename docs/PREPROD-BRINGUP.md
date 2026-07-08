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

- **Cardano `cardano-node` + db-sync (read-only), synced on preprod.** The node's observer reads db-sync. It
  **must** be FULL / non-pruned (retains history back to the reference) and **`tx_in`-enabled** (NOT
  `--consumed-tx-out` — spentness is read from `tx_in`; the read probes `EXISTS (SELECT 1 FROM tx_in)` and
  **abstains fail-closed** otherwise). Expose a read-only role (e.g. `cogno_reader`) as `DBSYNC_URL`.
  MAINNET PREREQUISITE: db-sync over TLS.
- **The built node binary**, from a clean `cargo build --release` (pinned rustc 1.93.0). The **same** binary
  must generate the genesis and run the node — a `--features runtime-benchmarks` build embeds a runtime a
  normal node can't run, and a different build changes the genesis.
- **Ogmios + Blockfrost** are needed only by the **frontend's** L1 lock/exit (tx submit + cost models). The
  node never talks to them; skip for a first bring-up.

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

There is **no committed chainspec**; you mint one once and keep it. From a checkout, with the clean release
binary:

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
node (`ws://<host>:9944`, behind TLS for anything public — see follow-ups). This branch is **spec 203**; after
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
$CLI validator set-keys ...                                         # run by the new validator
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
- **Keep `STABILITY_SLOTS_TESTNET` (600)** — the mainnet window (`129_600`) is a labeled MAINNET PREREQUISITE.
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
