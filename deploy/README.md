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

Four files: [`systemd/cogno-relay.service`](systemd/cogno-relay.service) (the unit),
[`nginx/cogno.conf`](nginx/cogno.conf) (TLS, `wss://` proxy, and the static app), and two **manual**
GitHub Actions that ship to it — [`deploy-app.yml`](../.github/workflows/deploy-app.yml) (builds the
static export, rsyncs it to `/var/www/cogno`) and [`deploy-node.yml`](../.github/workflows/deploy-node.yml)
(builds the node binary, installs it, restarts the relay — see [below](#deploying-the-node-binary)).
Neither fires on push: `main` is a work branch, and nothing deploys until you click it.

**The one rule: the relay must never see `DBSYNC_URL`.** It re-derives the Cardano observation for
every block it imports. Against a db-sync that is behind, pruned, or on the wrong network, it computes
a different observation than the validator did — and the mismatch is fatal on import. It rejects your
valid blocks, freezes at the tip, and keeps serving stale reads as if nothing were wrong. With no
db-sync it abstains, which is non-fatal and correct. So do not install db-sync there, and do not copy
`/etc/cogno/cogno.env` across. The relay unit deliberately has no `EnvironmentFile` at all.

Two smaller things that bite:

- **The relay must bind raw TCP with `--listen-addr /ip4/0.0.0.0/tcp/30333`, not `--port`.** A
  non-validator with no `--listen-addr` defaults its p2p listener to *WebSocket* (`…/tcp/30333/ws`),
  while peers dial the entry-point relay as raw TCP via its bootNodes multiaddr. The port still accepts
  connections — `nc` succeeds, the relay looks alive — but a raw-TCP dialer never completes a libp2p
  session with a WebSocket listener, so the relay sits at 0 peers stuck at genesis. The shipped unit
  binds raw TCP explicitly; if you hand-roll one, don't drop that flag. (A validator defaults to raw
  TCP, so only a public non-validator hits this.)
- **`--rpc-methods safe` is not optional** on the relay. The default (`auto`) exposes `author_insertKey`
  and friends on the loopback bind that nginx forwards the internet to.
- **Build the app with `NEXT_PUBLIC_WS_URL=wss://<domain>/rpc`.** Browsers on an `https://` page cannot
  open a plaintext `ws://` socket to a public host, and without the variable the export silently falls
  back to `ws://127.0.0.1:9944` — which works on your machine and nowhere else. `endpoints.ts` now fails
  the build rather than let that ship.

Do **not** enable DigitalOcean backups on the relay — it resyncs from the validator for free. Back up the
validator instead.

### Deploying the node binary

The relay's binary comes from the **`deploy-node`** workflow (manual, Actions tab → Run workflow). It
builds `cogno-chain-node` in release mode on an Ubuntu 24.04 runner — pinned to the droplet's OS, because
a binary built against a newer glibc is rejected by the droplet's loader before `main()` ever runs — then
stages it on the box, installs it, restarts the relay, and rolls back if the relay does not come back
healthy. You do not need a compiler, 8 GB of RAM, or swap on the droplet.

**A runtime upgrade does not come through here.** Runtime code is WASM and ships on-chain
(`cogno-chain-cli upgrade authorize` + `upgrade apply`) — pallet changes, migrations, and `spec_version`
bumps need no binary deploy at all. `deploy-node` is for the *client* half: an SDK bump, a node/consensus
fix, a new host function. And it is **relay-only** — the validator sits behind NAT on the operator's home
network, unreachable from CI, and is updated by hand.

The workflow runs as the unprivileged `cogno` (it holds no root; reaching root needs the sudoers entry
below) right up until one step, which runs a single root-owned script through a single-command sudoers
entry. Both are in this repo, and the workflow **refuses to deploy** if the copy on the droplet has
drifted from the committed one — so install them once, and reinstall whenever they change here:

```bash
# On the droplet, as root. Parse-check the sudoers file BEFORE installing it: sudo refuses to run at
# all if it cannot parse a file in /etc/sudoers.d, and you are one bad line from locking yourself out.
visudo -c -f deploy/sudoers.d/cogno-deploy

sudo install -m 0755 -o root -g root deploy/scripts/cogno-deploy-node /usr/local/sbin/cogno-deploy-node
sudo install -m 0440 -o root -g root deploy/sudoers.d/cogno-deploy   /etc/sudoers.d/cogno-deploy

# Sanity: the deploy user can run that one command as root, and nothing else.
sudo -u cogno sudo -n /usr/local/sbin/cogno-deploy-node --help   # must be REFUSED (it takes no args)
sudo -u cogno sudo -n systemctl restart cogno-relay              # must be REFUSED
```

[`deploy/scripts/cogno-deploy-node`](scripts/cogno-deploy-node) takes **no arguments**, by design: it
installs a file as root into a world-readable path, so an argument would let the deploy user point it at
`/root/.ssh/id_ed25519` and read it back. The paths are baked in, and
[`deploy/sudoers.d/cogno-deploy`](sudoers.d/cogno-deploy) pins the entry to zero arguments (a bare command
in sudoers permits *any* arguments — the trailing `""` is what forbids them). A stolen deploy key can
therefore ship a node binary and bounce the relay. It cannot become root.

What the script does, in order — everything before the swap is non-destructive:

1. Refuses a staged file that is a symlink, or not owned by the deploy user.
2. **Execs the staged binary as the service user** (`--version`). This is the check that matters: a
   wrong-glibc binary dies here, with the old relay still up and serving.
3. Backs the live binary up to `/usr/local/bin/cogno-chain-node.prev`.
4. Renames the new one into place — a rename, because you cannot write over the binary of a running
   process (`ETXTBSY`) — and restarts `cogno-relay`.
5. Health-checks that the relay is **importing**, not merely up: it records the best block first, then
   after the restart waits for the block number to *advance* past it. Peer count alone is not the bar —
   a node can hold peers while accepting no blocks (a p2p/consensus change it can't follow), which is a
   chain frozen at the tip serving stale reads, exactly the change class this workflow ships.
6. If it does not start importing: restores `.prev`, restarts, and verifies the relay is **serving** again
   (RPC answering — importing is the validator's job, not the rollback's), then exits non-zero with a
   message that distinguishes "the new binary is bad" from "the validator is down and the binary is a
   bystander." One caveat the script cannot cover: rollback swaps the *binary* back, so it only recovers a
   binary change. If a new binary irreversibly migrates the on-disk DB format before failing, `.prev` may
   not be able to open the migrated DB — recovery is then a re-sync from the validator, not a rollback.

Run it by hand the same way CI does — `sudo /usr/local/sbin/cogno-deploy-node`, after putting a binary at
`/home/cogno/staging/cogno-chain-node`.

**Bring-up order on a fresh droplet.** The workflow can install the *first* binary too, but it needs the
box to be otherwise ready: the `cogno` user, `/etc/cogno/chainspec.raw.json`, the relay's node key, the
unit file, and the two files above. Install those, then run the workflow, then `systemctl enable
cogno-relay` for boot persistence. Two first-install caveats: there is no `.prev` yet, so a bad first
binary cannot be rolled back; and on the relay `cogno` is a **login** user — it is the SSH deploy user, so
it needs a real shell and a home directory (`useradd --create-home --shell /bin/bash cogno`), unlike the
validator host's service-only account above (`--no-create-home --shell /usr/sbin/nologin`), which never
receives an SSH session.

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
