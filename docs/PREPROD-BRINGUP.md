# Preprod single-observer bring-up runbook

How to stand up a **real, persistent, single-operator** cogno-chain on Cardano **preprod** and exercise the
full dapp loop (lock ADA → bind identity → earn talk-capacity → feeless post → read). This is the
end-to-end companion to [deploy/README.md](../deploy/README.md) (which covers the `systemd` mechanics) and
[docs/IN-PROTOCOL-OBSERVATION.md](IN-PROTOCOL-OBSERVATION.md) (the observer design). It ties genesis → node →
weight-sync → frontend into one sequence and calls out the pieces unique to a single-observer
**shadow-mode** chain.

> ## Honest posture — read first
> This is a **live, single-operator testnet proof-of-concept**, not a production or trustless system. The
> in-protocol Cardano observer runs in **shadow** (`EnforceWeight = false`) and is **auditability, not
> trust** — **D4-SHAPED, not D4-TRUST**. With one block producer, `check_inherent`'s "every importer
> re-derives" is *not* load-bearing (there is no second producer to out-vote a bad author), and the chain
> exercises no cross-node import at all. Trustless weight requires **≥3 independent producers each running
> their own db-sync** plus the gated `set_enforcement(true)` cutover — both deliberately deferred. Label
> every user-facing surface accordingly.

## What standing this up does / does not buy you

| It buys | It does **not** buy |
|---|---|
| A stable, committed genesis that survives restarts/rebuilds | Trust, decentralization, or any progress toward the mainnet flip |
| Real uptime + real db-sync wiring against the live preprod vault | Cross-instance observation determinism (needs ≥2 db-syncs) |
| Real CIP-8 binds + real L1 ADA locks/exits, end to end | Enforcement (posting is still gated by the committee weight-sync, see Step 4) |
| A durable platform to iterate the dapp + UI | A second producer / GRANDPA fault tolerance (`MinAuthorities = 1`) |

## Prerequisites (external infrastructure you run separately)

- **Cardano `cardano-node` + db-sync (read-only), synced on preprod.** The observer reads db-sync. It
  **must** be FULL / non-pruned (retains history back to the reference) and **`tx_in`-enabled** (NOT
  `--consumed-tx-out` — spentness is read from `tx_in`; the read probes `EXISTS (SELECT 1 FROM tx_in)` and
  **abstains fail-closed** otherwise). Expose a read-only role (e.g. `cogno_reader`) as `DBSYNC_URL`.
  MAINNET PREREQUISITE: db-sync over TLS.
- **Ogmios** — still needed for the **L1 write path** only (it submits the anchor-relayer's metadata tx and
  serves Plutus cost models). Reads come from db-sync; the in-browser CIP-30 vault lock/exit uses Blockfrost.
  Not used by the observation path. Optional for a first bring-up.
- **Postgres 16** — only if you run the optional SubQuery indexer.
- **The built node binary**, from a clean `cargo build --release` (pinned rustc 1.90.0). The **same** binary
  must generate the genesis and run the node — a `--features runtime-benchmarks` build embeds a runtime a
  normal node can't run, and a different build changes the genesis.

## The loop at a glance

```
   Cardano preprod (db-sync, read-only)
            │  observe (deterministic, shadow → ShadowStake only)
            ▼
   ┌──────────────────────┐     set_stake (committee)         ┌──────────────────────┐
   │  cogno-chain node    │◀────── sync-weight.mjs ───────────│  services/committee  │
   │  (Aura+GRANDPA, the  │        (LOAD-BEARING in shadow:    └──────────────────────┘
   │   sole producer)     │         writes talkStake.AllowedStake)
   │                      │◀────── feeless bare-unsigned binds (link_identity_signed / link_stake_signed),
   └──────────┬───────────┘        verified at pool admission — submitted straight from the browser
              │ ws://…:9944 (PAPI)
              ▼
   app/ (Next.js + MeshJS + PAPI)  ──L1 lock/exit──▶ Ogmios/Blockfrost
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

./target/release/cogno-chain-node gen-chainspec --base cogno-preprod \
  --validator-account-key val-account.skey \
  --validator-aura-key val-aura.skey --validator-grandpa-key val-grandpa.skey \
  --committee-key seat1.skey \
  --out-raw network/raw.json
```

This writes `network/raw.json` (the spec — no secrets, safe to install/commit) plus a plain,
inspectable spec. The secret material is the `.skey` files from `key gen` (**`chmod 600`,
IRREPLACEABLE — archive them off-host**). Re-running `key gen` mints *new* random keys and a
*different* genesis, so those `.skey` files + `raw.json` **are** your stable genesis. Never commit the
`.skey` files.

## Step 2 — Run the node persistently, **with `DBSYNC_URL`**

Follow [deploy/README.md](../deploy/README.md) for host setup, `key insert` (aura sr25519 + gran ed25519 into
`/var/lib/cogno/node`), the EnvironmentFile, and `systemctl enable --now cogno-node`. Do **not** use `--dev`
or `--tmp`.

> **⚠ One wiring step deploy/README.md does not yet cover.** The committed
> [`cogno-node.service`](../deploy/systemd/cogno-node.service) predates the db-sync consolidation: it has no
> `EnvironmentFile=` and never passes `DBSYNC_URL`, so the observer would log `no DBSYNC_URL/DBSYNC set —
> abstaining` and credit nothing. Give the node the read-only db-sync URL via a drop-in:
>
> ```bash
> sudo systemctl edit cogno-node      # creates an override.conf
> ```
> ```ini
> [Service]
> Environment=DBSYNC_URL=postgres://cogno_reader:****@127.0.0.1:5432/cexplorer
> # optional: surface the observer's per-block read
> Environment=RUST_LOG=info,cardano-observer=debug,runtime::cardano-observer=debug
> ```
>
> (Or add `EnvironmentFile=-/etc/cogno/cogno.env` to the unit and put `DBSYNC_URL=` there.) See "Follow-ups"
> below — folding `DBSYNC_URL` into the node unit + env template is a worthwhile repo fix.

## Step 3 — Confirm the observer is live (shadow)

Once the node is producing + finalizing:

```bash
journalctl -u cogno-node -f | grep -E "observed [0-9]+ vault entrie|ObservationApplied|abstaining"
```

You want `observed N vault entrie(s) as-of slot R (from M db-sync match(es), anchor block H)` from block #2
onward (block #1's parent is genesis → pre-Shelley → a legitimate abstain). The on-chain audit trail is the
`cardanoObserver.ObservationApplied` event (`enforced=false`, and `credited=0` until an account is bound +
weighted — expected on a fresh chain). Each block #2+ header also carries the `cobs` `PreRuntime` digest
(engine id `636f6273`) sealing the stable Cardano anchor. This is exactly the behaviour the §15.3 two-node
live import test proved.

## Step 4 — Run the weight-sync (REQUIRED for feeless posting in shadow)

**This is the piece that makes the dapp work and is easy to miss.** In shadow mode the observer only
*projects* weight into `cardanoObserver.ShadowStake`; it does **not** write `talkStake.AllowedStake`, which
is what the `CheckCapacity` extension and the capacity meter actually read. So **nothing earns talk-capacity
— and no feeless post is possible — unless the committee weight-sync runs.** It is the sole `AllowedStake`
writer until the enforcement cutover.

```bash
# live mode: observe the vault via db-sync, largest-wins per identity, set_stake through the 3-of-5 committee
source network/env.sh                       # COMMITTEE_SEEDS
WS=ws://127.0.0.1:9944 DBSYNC_URL=postgres://cogno_reader:****@127.0.0.1:5432/cexplorer \
COGNO_PROFILE=prod CONFIRM_DEPTH_SLOTS=600 \
  node services/committee/sync-weight.mjs --via committee
```

Run it on a schedule (cron/timer) so new locks get credited. The read **fails closed** (a db-sync error
aborts rather than writing a partial weight), and `CONFIRM_DEPTH_SLOTS` buries reorg-able UTxOs. (Dev
shortcut with no Cardano: `WS=… node services/committee/sync-weight.mjs --account <ss58> --weight <lovelace>`.)

## Step 5 — Binds are feeless (no relay to run)

The CIP-8 binds (`cognoGate.link_identity_signed` for identity, `link_stake_signed` for voting power) are
**feeless bare unsigned extrinsics**: the CIP-8 proof *is* the authorization, and the runtime verifies it at
transaction-pool admission (`validate_unsigned`) and again at block inclusion, so junk + already-bound /
tombstoned proofs are rejected before gossip. A freshly sign-to-derived, **zero-balance** browser account
therefore binds itself directly — no fee payer, no nonce, no funded relay (the old sponsored-bind-relay is
gone). Spam costs an attacker only the per-block-weight-bounded ed25519 verify and grants nothing actionable
(posting capacity + voting power come from observed Cardano stake keyed on the bound credential); rate-limit
feeless calls at the RPC ingress if needed.

## Step 6 — Point the frontend at the chain

[app/](../app/README.md) is a static-export Next.js client. Set its endpoints to your node
(`ws://<host>:9944`, behind TLS for anything public — see follow-ups) and, optionally, the indexer GraphQL;
the frontend keeps a **PAPI-direct fallback**, so the indexer is never load-bearing. After any spec bump
(this branch is **spec 111**), regenerate PAPI descriptors:
`rm app/.papi/descriptors/generated.json && (cd app && npx papi add cogno -w ws://127.0.0.1:9944)`.

## Optional services

- **anchor-relayer** — Tier-A *evidence* (finalized `state_root` → Cardano metadata submitted via Ogmios,
  reads via db-sync → `anchor_ack`). Evidence, not enforcement; safe to add later.
- **indexer + GraphQL** — richer L4 feed (paginated/searchable/threaded). Needs Postgres and a codegen build
  pinned to **your** genesis hash (the baked default refuses any other chain). PAPI-direct is the fallback.

## The dapp loop, end to end

1. In the browser (CIP-30 wallet), **lock ≥100 ADA** at the live preprod `talk_vault` (mints the beacon). →
   Ogmios/Blockfrost.
2. **Bind identity**: sign the CIP-8 proof; the browser submits the feeless bare-unsigned
   `link_identity_signed` directly. → 1:1 owner-address ↔ account.
3. The **weight-sync** (Step 4) observes the lock via db-sync and credits `talkStake.AllowedStake`. →
   talk-capacity appears.
4. **Post feelessly** — `microblog.post_message` passes `CheckCapacity` (Δbalance = 0).
5. **Read** the feed (indexer GraphQL or PAPI-direct).

## Do **not** touch (scoped-out testnet choices / live invariants)

- **Do not flip `set_enforcement(true)`** — it is gated on ≥3 independent producers + a committee-keyset
  reconciliation, not a pure flag flip.
- **Do not edit `contracts/`** — the live preprod vault hash (`168a9710…` applied, blueprint `49ffbfc6…`)
  must not move; any production edit recompiles and orphans the deployed vault.
- **Keep `STABILITY_SLOTS_TESTNET` (600)** — the mainnet window (`129_600`) is a labeled MAINNET PREREQUISITE.
- **`MinAuthorities = 1` + `--force-authoring`** is the intended single-authority posture — not a bug.
- **Never renumber pallet indices** (on-wire contract; index 7 is permanently vacant).

## Before you lean on it — close the Phase-5 ops gaps

prod-readiness Phases 1–3 (supervision, monitoring, least-privilege) are in the repo; these were deferred to
Phase 5 and are **config/runbook, not code blockers**:

- **Back up `/var/lib/cogno`** (the node DB is the *sole* copy of chain history at `MinAuthorities = 1`) and
  **`keys.json` / `owner.json`** (irreplaceable). No backup tooling ships yet.
- **Cap journald** (`SystemMaxUse=` / `MaxRetentionSec=` drop-in) so logs can't fill the disk.
- **Wire a real Alertmanager receiver** — the shipped config blackholes all alerts by default.
- **Harden the RPC** if exposing it: TLS reverse proxy + `--rpc-methods=safe` + firewall (the node binds
  localhost with `--rpc-cors all` today).

## What this proves (and what it doesn't)

Running this proves the **mechanism and operations** end to end on real preprod data: deterministic db-sync
observation, header-sealed anchors, shadow-mode projection, and the full lock→bind→weight→post→read loop. It
does **not** prove cross-*instance* observation determinism or provide any trust/decentralization — that is
the deferred validator-decentralization workstream (≥3 producers, Ariadne/SPO selection, the enforcement
cutover, Mithril completeness). Treat this as a durable iteration platform, labeled **D4-SHAPED, not
D4-TRUST**.
