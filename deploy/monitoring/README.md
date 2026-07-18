# cogno-chain monitoring

A lightweight, single-operator observability stack: **Prometheus** scrapes the node, **Alertmanager**
pages on the conditions that break the product, and a starter **Grafana** dashboard shows health at a
glance. This answers *is the system actually healthy?* without tailing logs by hand.

The all-Rust node is the whole deployment, so there is **one** scrape target. Its built-in
`:9615/metrics` endpoint carries both the Substrate chain-health metrics AND the in-node Cardano-observer
gauges (there is no relayer / follower / indexer / shadow-diff exporter — those services are gone).

## What's exposed

| Target | Endpoint | Source |
|---|---|---|
| node | `:9615/metrics` | Substrate built-in Prometheus (`--prometheus-port 9615`) |

Key metrics:

- **Chain health** (`substrate_*`, built in): `substrate_block_height{status="best"|"finalized"}`,
  `substrate_sub_libp2p_peers_count`, plus the usual host/runtime series.
- **RPC health** (`substrate_rpc_*`, built in — present because the node runs `--prometheus-port`):
  `substrate_rpc_calls_time` (per-method latency histogram; runtime-API reads arrive as
  `method="state_call"`, so this doubles as the *expensive-runtime-API-call* signal),
  `substrate_rpc_calls_finished{is_error,is_rate_limited}` (error + rate-limit rates).
- **Observer liveness** (`cogno_observer_*`, [node/src/metrics.rs](../../node/src/metrics.rs)):
  `cogno_observer_observations_total` (non-empty observations proposed) /
  `cogno_observer_abstains_total` (abstentions — db-sync unset/down/behind or pre-Shelley);
  `cogno_observer_last_reference_slot` (Cardano slot of the latest non-empty observation) +
  `cogno_observer_dbsync_tip_slot` (this node's db-sync tip) and `cogno_observer_lag_slots` (how far the
  tip trails the current Cardano slot — the *observer lag*, ~0 healthy, climbs before it abstains);
  `cogno_observer_observed_vaults` / `_observed_voters` vs `cogno_observer_max_observed` (the freeze
  ceiling) and `cogno_observer_observations_oversize_total` (**a non-zero rate is a page** — the observe
  inherent has started abstaining and weight is frozen). **These are updated only by the AUTHORING
  producer** — a tracking node leaves them at 0.
- **Host metrics** (`node_*`, from `node_exporter` — OPTIONAL, off by default): CPU / memory / disk and
  the chain-DB mount. Enable the `node-exporter` scrape job in `prometheus.yml` (install one-liner is
  there) to light up the "Host …" dashboard panels and the `HostDiskFilling` / `HostMemoryHigh` alerts.
  A `cardano-node` scrape stub is there too, to compare cardano-node's own tip against the db-sync tip.

## Run it

```bash
# Run Prometheus FROM THIS DIRECTORY: its `rule_files: [alerts.yml]` is resolved relative to the
# working directory (NOT the --config.file path), so launching from the repo root would silently load
# zero alert rules.
cd deploy/monitoring
prometheus   --config.file=prometheus.yml      # scrape + rules, :9090
alertmanager --config.file=alertmanager.yml    # routing, :9093
# Grafana: add the Prometheus datasource, then import grafana-dashboard.json
```

> ⚠ **You will not be paged until you wire a receiver.** As shipped, `alertmanager.yml`'s `cogno-default`
> receiver has every notifier commented out — a valid config that routes every alert to a **blackhole**.
> Uncomment + point its `webhook_configs`/`slack_configs` at your real notifier, or alerts fire in
> Prometheus and silently go nowhere. Verify with `amtool config routes test` / the `:9093` UI.

The target binds `127.0.0.1`, so run Prometheus **on the same host**. For a remote Prometheus: start the
node with `--prometheus-external` (it binds localhost otherwise) and reach `:9615` over your private
scrape network or a proxy — never expose it publicly.

## Alerts (see [alerts.yml](alerts.yml))

- **cogno-node:** `NodeDown`, `FinalityStalled`, `BlockProductionStalled` (+ `NodeNoPeers`, shipped
  commented-out — a single `--force-authoring` validator runs at 0 peers by design).
- **cogno-observer:** `ObserverAbstaining` (no non-empty observation in 15m — weight going stale),
  `ObserverReferenceSlotStalled` (db-sync's Cardano tip fully frozen), `ObserverNoVaults` (observing, but
  the locked-ADA vault set is empty — a broken vault scan on a live chain), `ObserverOversize`
  (**critical** — an observation exceeded `MaxObserved`, so the inherent abstains and weight is FROZEN;
  raise `MaxObserved` via a governed upgrade), `ObserverApproachingMaxObserved` (within 10% of the
  ceiling — raise it before it freezes), `ObserverLagHigh` (db-sync tip >300 slots behind — falling
  behind before it fully stalls; scale the threshold up for mainnet's larger stability window).
- **cogno-rpc:** `RpcErrorRateHigh` (sustained RPC error rate — a broken/abusive client or upstream fault).
- **host** (requires the `node-exporter` scrape job): `HostDiskFilling` (**critical** — <10% free on the
  chain-DB mount; with `MinAuthorities=1` the validator DB is the sole copy of history), `HostMemoryHigh`.

Every rule has a `for:` window so a transient scrape miss doesn't page. The observer group's gauges are
updated **only by the authoring producer**, so in the default single-validator topology `job="cogno-node"`
is exactly the producer; on a multi-node scrape, relabel so the observer rules evaluate only the producer
(and note the observer abstains by design on a Cardano-less `--dev`/`cogno-dev` chain). Wire
`alertmanager.yml`'s receiver to your real notifier (Slack/PagerDuty/webhook) before relying on any of it.
