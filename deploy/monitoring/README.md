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
- **Observer liveness** (`cogno_observer_*`, [node/src/metrics.rs](../../node/src/metrics.rs)):
  `cogno_observer_observations_total` (non-empty observations proposed) /
  `cogno_observer_abstains_total` (abstentions — db-sync unset/down/behind or pre-Shelley);
  `cogno_observer_last_reference_slot` (Cardano slot of the latest non-empty observation);
  `cogno_observer_observed_vaults` / `cogno_observer_observed_voters` (entry counts in the latest
  observation). **These are updated only by the AUTHORING producer** — a tracking node leaves them at 0.

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
  `ObserverReferenceSlotStalled` (db-sync's Cardano tip frozen), `ObserverNoVaults` (observing, but the
  locked-ADA vault set is empty — a broken vault scan on a live chain).

Every rule has a `for:` window so a transient scrape miss doesn't page. The observer group's gauges are
updated **only by the authoring producer**, so in the default single-validator topology `job="cogno-node"`
is exactly the producer; on a multi-node scrape, relabel so the observer rules evaluate only the producer
(and note the observer abstains by design on a Cardano-less `--dev`/`cogno-dev` chain). Wire
`alertmanager.yml`'s receiver to your real notifier (Slack/PagerDuty/webhook) before relying on any of it.
