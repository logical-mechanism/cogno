# Deploying cogno-chain (preprod-shaped production)

This directory holds the **supervised, always-on** deployment layer: a single committed `systemd` unit
that runs the node under `Restart=always`, with boot persistence, durable state, and sandboxing. It turns
"runs on the author's laptop in a foreground terminal" into "an operator runs it unattended, and it
survives crashes and reboots."

The all-Rust node is the **whole backend** — it authors + finalizes blocks AND serves every read (feed /
thread / search / profile, via its runtime API) AND runs the Cardano observer in-protocol. There is no
follower, relayer, indexer, or committee daemon: privileged calls are made ad hoc with `cogno-chain-cli`
(keys by file, from an operator machine — not this host), and there is no sudo key anywhere.

The default topology is the **single operator-keyed persistent validator** (the honest v1 posture) —
not `--dev`, not throwaway `//Alice` keys. It scales to a multi-validator network by editing a couple of
flags (noted inline). The deliberate testnet choices (`MinAuthorities=1`, GRANDPA equivocation as a no-op,
independent-custody committee) remain scoped out — see the repo README / `docs/`.

## What runs where

| Unit | Process | Binds | Needs |
|---|---|---|---|
| `cogno-node` | the Substrate validator (Aura + GRANDPA) + observer + read RPC | p2p :30333, RPC :9944, Prometheus :9615 | **db-sync** (read-only; the observer) |

**Not managed here** (external infrastructure you run separately): a synced `cardano-node` feeding a
read-only **db-sync** (Postgres) that the node's in-protocol observer reads via `DBSYNC_URL`. Add
`After=`/`Wants=` lines for your db-sync/cardano units to `cogno-node.service` if you want strict ordering
(names vary by install) — but the observer fails closed (abstains) and the node keeps producing if db-sync
is down, so ordering is a convenience, not a correctness requirement. (Ogmios / Blockfrost — L1 tx submit
+ cost models — are used by the CLI + the in-browser CIP-30 vault, not by anything on this host.)

## Install layout (the paths the unit assumes)

| Path | What |
|---|---|
| `/usr/local/bin/cogno-chain-node` | the built node binary |
| `/etc/cogno/chainspec.raw.json` | your operator-keyed raw chain spec |
| `/etc/cogno/cogno.env` | the EnvironmentFile (`DBSYNC_URL`, `0640 root:cogno`) |
| `/var/lib/cogno` | durable state (`StateDirectory`, `0700 cogno:cogno`); the node DB lives in `node/` under it |

Edit the literal paths in the unit if your layout differs. `cogno-chain-cli` (the admin tool) does **not**
run on this host — keep it, and the committee `.skey` files, on a separate operator machine.

## One-time host setup

```bash
# 1. Service account (no login, no home).
sudo useradd --system --no-create-home --shell /usr/sbin/nologin cogno

# 2. The node binary (built with a plain `cargo build --release` — default features).
sudo install -m 0755 target/release/cogno-chain-node /usr/local/bin/cogno-chain-node
```

That's it — no Node.js, no Python, no Postgres for the app itself. The only external dependency is the
read-only Cardano db-sync the observer reads (which you run separately).

## Genesis + keys

Generate your keys with `cogno-chain-cli key gen` (cardano-cli-style envelopes, by file path — **no
`//Alice` dev keys, no seed phrases**), then build an operator-keyed genesis with `cogno-chain-node
gen-chainspec` (it reads only the PUBLIC keys and refuses dev keys):

```bash
CLI=/usr/local/bin/cogno-chain-cli   # on your operator machine
$CLI key gen --scheme sr25519 --out val-account.skey
$CLI key gen --scheme sr25519 --out val-aura.skey
$CLI key gen --scheme ed25519 --out val-grandpa.skey
$CLI key gen --scheme sr25519 --out seat1.skey        # repeat --committee-key for more seats
$CLI key generate-node-key   --out val-p2p.key        # the validator's libp2p node (p2p) key — see below

cogno-chain-node gen-chainspec --base cogno-preprod \
  --validator-account-key val-account.skey \
  --validator-aura-key val-aura.skey --validator-grandpa-key val-grandpa.skey \
  --committee-key seat1.skey \
  --out-raw chainspec.raw.json                        # + a plain, inspectable spec
```

Keep the `.skey` files offline (`chmod 600`, back them up — the committee seats stay in their files for
`cogno-chain-cli`). Install the raw spec on the node host and insert the validator's SESSION secrets FROM
the key files (`key insert` reads the SURI + scheme from each envelope — no jq / `--suri`):

```bash
sudo install -m 0644 chainspec.raw.json /etc/cogno/chainspec.raw.json

# The validator's libp2p node (p2p) key — the unit passes it via --node-key-file (see below). 0640
# root:cogno so the `cogno` service user can read it but it is not world-readable.
sudo install -m 0640 -o root -g cogno val-p2p.key /etc/cogno/node.key

# Insert the SESSION secrets into /var/lib/cogno/node to match the unit's --base-path.
sudo install -d -o cogno -g cogno -m 0700 /var/lib/cogno/node
sudo -u cogno cogno-chain-node key insert --base-path /var/lib/cogno/node \
  --chain /etc/cogno/chainspec.raw.json --key-file val-aura.skey    --key-type aura   # authoring
sudo -u cogno cogno-chain-node key insert --base-path /var/lib/cogno/node \
  --chain /etc/cogno/chainspec.raw.json --key-file val-grandpa.skey --key-type gran   # finality
```

(The unit's `StateDirectory=cogno` creates `/var/lib/cogno` `0700 cogno:cogno`; the `install -d` above just
lets you insert keys before the first start. A `--validator` node does **not** auto-generate its p2p node
key — the SDK refuses, so an authority can't silently adopt an unstable peer id, and it exits with
`NetworkKeyNotFound` — so the unit supplies the step-1 `node.key` via `--node-key-file`. Read its peer id
any time with `cogno-chain-node key inspect-node-key --file /etc/cogno/node.key`. Only a NON-validator
tracking node auto-generates one under its base-path.)

## Config: the EnvironmentFile

```bash
sudo install -d -m 0750 -o root -g cogno /etc/cogno
sudo install -m 0640 -o root -g cogno deploy/systemd/cogno.env.example /etc/cogno/cogno.env
sudoedit /etc/cogno/cogno.env     # fill in DBSYNC_URL (read-only db-sync); optionally RUST_LOG
```

The node reads **only** `DBSYNC_URL` (+ optional `RUST_LOG`) from this file. The unit's `EnvironmentFile=-`
makes a missing file / unset `DBSYNC_URL` non-fatal — the observer simply abstains (the chain still
produces + finalizes) and logs `no DBSYNC_URL set — abstaining`.

## Install + enable the unit

```bash
sudo cp deploy/systemd/cogno-node.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cogno-node
```

## Verify

```bash
systemctl status cogno-node                      # active (running)
journalctl -u cogno-node -f                      # "Imported #N", "finalized #M" advancing
curl -s localhost:9615/metrics | grep cogno_observer   # observer liveness gauges (see monitoring/)
```

Once the node is producing, capture its genesis hash (`chain_getBlockHash[0]`) and pin it wherever you run
`cogno-chain-cli` — the CLI's genesis guard refuses to sign against the wrong chain.

**Monitoring + alerting.** [`deploy/monitoring/`](monitoring/) ships a Prometheus scrape config, alert
rules (chain down / finality stalled / block production stalled, plus the observer group:
abstaining / reference-slot frozen / no-vaults), an Alertmanager config, and a starter Grafana dashboard —
see [`deploy/monitoring/README.md`](monitoring/README.md).

## Operating notes

- **Durable state.** Everything stateful lives under `/var/lib/cogno`. With `MinAuthorities=1` the node DB
  is the **sole copy** of chain history, and the operator `.skey` / `keys.json` files are irreplaceable —
  see [Backup & restore](#backup--restore) below.
- **Single-validator finality.** The default unit uses `--force-authoring` (a lone validator has no peers
  to confirm against). Drop it — and add `--bootnodes` — when you onboard more validators; GRANDPA needs
  ≥2/3 of authorities online to finalize.
- **Observer abstention is non-fatal.** If db-sync is unset / down / behind, the observer abstains and the
  node keeps producing + finalizing; talk-stake weight just goes stale until db-sync is back. The
  `ObserverAbstaining` alert catches a sustained abstention.
- **Federating out.** Add committee seats (`cogno-chain-cli committee members add`, by vote) and validators
  (`cogno-chain-cli validator add` + the new validator's `validator set-keys`) from your operator machine —
  changes apply at a session boundary. Runtime upgrades are `cogno-chain-cli upgrade authorize` (committee)
  + a permissionless `upgrade apply` (spec-checked). There is no sudo path.

## Backup & restore

No backup daemon is shipped, and the node binary intentionally exposes no `export-blocks` / `export-state`
subcommand — back up at the filesystem level. What to protect:

| Asset | Where | Backup |
|---|---|---|
| Chain DB (history) | `/var/lib/cogno/node` | filesystem snapshot (below). At `MinAuthorities=1` there is no second archive node to re-sync from, so this is load-bearing. |
| Operator secret keys | your offline `.skey` / `keys.json` envelopes | encrypted, offline, in ≥2 places — **never** on the node host. |
| Genesis / chainspec | `/etc/cogno/chainspec.raw.json` | copy alongside the keys (must be byte-identical to rejoin). |
| Session keys | `<base-path>/chains/<id>/keystore` | re-inserted from the `.skey` files on restore — no separate backup. |

**Snapshot the DB (consistent copy):**

```bash
sudo systemctl stop cogno-node                                  # clean stop for a consistent copy
sudo tar -C /var/lib/cogno -czf /backup/cogno-db-$(date +%F).tar.gz node
sudo systemctl start cogno-node
```

For zero-downtime, take an LVM/ZFS/btrfs snapshot of `/var/lib/cogno` and archive that instead. Rotate old
archives off-host.

**Restore drill** (rehearse once on a spare host, before you need it):

```bash
sudo systemctl stop cogno-node
sudo tar -C /var/lib/cogno -xzf /backup/cogno-db-YYYY-MM-DD.tar.gz
sudo chown -R cogno:cogno /var/lib/cogno
# Re-insert the session keys from the offline .skey files (as at first boot):
sudo -u cogno cogno-chain-node key insert --base-path /var/lib/cogno/node \
  --chain /etc/cogno/chainspec.raw.json --key-file val-aura.skey    --key-type aura
sudo -u cogno cogno-chain-node key insert --base-path /var/lib/cogno/node \
  --chain /etc/cogno/chainspec.raw.json --key-file val-grandpa.skey --key-type gran
sudo systemctl start cogno-node && journalctl -u cogno-node -f    # confirm it authors + finalizes
```

**Cap the journal** so an always-on archive node can't fill the disk: install the drop-in
[`deploy/systemd/journald-cogno.conf`](systemd/journald-cogno.conf) (`SystemMaxUse` / `MaxRetentionSec`).
