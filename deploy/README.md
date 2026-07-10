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
| `cogno-relay` | a non-validator archive node serving the public app | p2p :30333, RPC :9944 (loopback), Prometheus :9615 | nothing — **never db-sync** |

The relay is optional and lives on a different host (a cloud droplet). See
[the relay section](#the-public-relay) below.

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

## The public relay

To put the app on the internet you need one more box: a **relay** — the same binary, run without
`--validator`, that follows the chain over P2P and serves reads. It carries no keys, so it is the box
that faces the public; the validator stays behind it, reachable by nobody. A $12/mo droplet is enough,
and it doubles as your offsite copy of chain history (which, at `MinAuthorities=1`, the validator's DB
is otherwise the only one of).

Three files: [`systemd/cogno-relay.service`](systemd/cogno-relay.service) (the unit),
[`nginx/cogno.conf`](nginx/cogno.conf) (TLS, `wss://` proxy, and the static app), and the `deploy-app`
job in [`ci.yml`](../.github/workflows/ci.yml) (rsyncs `app/out/` on every green push to `main`).

**The one rule: the relay must never see `DBSYNC_URL`.** It re-derives the Cardano observation for
every block it imports. Against a db-sync that is behind, pruned, or on the wrong network, it computes
a different observation than the validator did — and the mismatch is fatal on import. It rejects your
valid blocks, freezes at the tip, and keeps serving stale reads as if nothing were wrong. With no
db-sync it abstains, which is non-fatal and correct. So do not install db-sync there, and do not copy
`/etc/cogno/cogno.env` across. The relay unit deliberately has no `EnvironmentFile` at all.

Two smaller things that bite:

- **`--rpc-methods safe` is not optional** on the relay. The default (`auto`) exposes `author_insertKey`
  and friends on the loopback bind that nginx forwards the internet to.
- **Build the app with `NEXT_PUBLIC_WS_URL=wss://<domain>/rpc`.** Browsers on an `https://` page cannot
  open a plaintext `ws://` socket to a public host, and without the variable the export silently falls
  back to `ws://127.0.0.1:9944` — which works on your machine and nowhere else. `endpoints.ts` now fails
  the build rather than let that ship.

Build the binary on the relay host (`cargo build --release`, see [`docs/RELAY-NODE.md`](../docs/RELAY-NODE.md));
a release build wants ~8 GB, so add swap on a small droplet. Do **not** enable DigitalOcean backups on it
— it resyncs from the validator for free. Back up the validator instead.

## Operating notes

- **Durable state.** Everything stateful lives under `/var/lib/cogno`. With `MinAuthorities=1` the node DB
  is the **sole copy** of chain history, and the operator `.skey` key envelopes are irreplaceable —
  see [Backup & restore](#backup--restore) below.
- **Single-validator finality.** The default unit uses `--force-authoring` (a lone validator has no peers
  to confirm against). Drop it — and add `--bootnodes` — when you onboard more validators; GRANDPA needs
  ≥2/3 of authorities online to finalize.
- **Observer abstention is non-fatal.** If db-sync is unset / down / behind, the observer abstains and the
  node keeps producing + finalizing; talk-stake weight just goes stale until db-sync is back. The
  `ObserverAbstaining` alert catches a sustained abstention.
- **Federating out.** Seating is gated on governance-fuel: the committee must grant an account a standing
  (regenerating) fuel allowance **before** it can be seated. New committee seat: `cogno-chain-cli fuel
  set-allowance --account <SEAT>` then `committee members add --member <SEAT>` (by vote) — seating a member
  with no allowance is rejected on-chain (`CallFiltered`). New validator: `fuel set-allowance --account
  <VAL>`, then the new validator runs `validator set-keys` (registers its session keys), then the committee
  runs `validator add --validator <VAL>` (`add_validator` refuses with `NotFunded` / `NoSessionKeys`
  otherwise). Changes apply at a session boundary; fuel regenerates toward the allowance each period, and
  `fuel revoke` cuts an account off — see [`docs/PREPROD-BRINGUP.md`](../docs/PREPROD-BRINGUP.md) Step 6.
  Runtime upgrades are `cogno-chain-cli upgrade authorize` (committee) + a permissionless `upgrade apply`
  (spec-checked). There is no sudo path.

## Backup & restore

No backup daemon is shipped, and the node binary intentionally exposes no `export-blocks` / `export-state`
subcommand — back up at the filesystem level. What to protect:

| Asset | Where | Backup |
|---|---|---|
| Chain DB (history) | `/var/lib/cogno/node` | filesystem snapshot (below). At `MinAuthorities=1` there is no second archive node to re-sync from, so this is load-bearing. |
| Operator secret keys | your offline `.skey` key envelopes | encrypted, offline, in ≥2 places — **never** on the node host. |
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
