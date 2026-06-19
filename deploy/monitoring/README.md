# cogno-chain monitoring (prod-readiness Phase 2)

A lightweight, single-operator observability stack: **Prometheus** scrapes the node + services,
**Alertmanager** pages on the conditions that break the product, and a starter **Grafana** dashboard
shows health at a glance. This answers the question Phase 1 couldn't — *is the system actually
healthy?* — without tailing logs by hand.

## What's exposed

| Target | Endpoint | Source |
|---|---|---|
| node | `:9615/metrics` | Substrate built-in Prometheus (`--prometheus-port 9615`) |
| relayer | `:9101/metrics`, `:9101/healthz` | hand-rolled ([metrics.mjs](../../services/_shared/metrics.mjs)) |
| follower | `:8090/metrics`, `:8090/health` (live probe) | hand-rolled |
| indexer | `:3001` | @subql/node admin/health (`up` liveness) |
| shadow-diff | `:9102/metrics`, `:9102/healthz` | hand-rolled (`shadow-diff.mjs --serve`; optional, D4 observation) |

Key custom metrics: `cogno_relayer_seconds_since_last_anchor`, `cogno_relayer_wallet_lovelace`,
`cogno_relayer_low_funds`, `cogno_relayer_pending_anchors` / `_failed_anchors`,
`cogno_relayer_consecutive_errors`, `cogno_relayer_seconds_since_last_loop`;
`cogno_follower_node_reachable`, `cogno_follower_genesis_ok`, `cogno_follower_nonces_cached`;
`cogno_shadow_accounts_disagree`, `cogno_shadow_max_disagree_blocks`, `cogno_shadow_recompute_disagree`
(in-protocol observation vs committee weight — convergence + an independent-recompute correctness leg).

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

All targets bind `127.0.0.1`, so run Prometheus **on the same host**. For a remote Prometheus: start
the node with `--prometheus-external` (it binds localhost otherwise), and reach the service `/metrics`
over your private scrape network or a proxy — never expose them publicly.

## Alerts (see [alerts.yml](alerts.yml))

`NodeDown`, `FinalityStalled`, `BlockProductionStalled` · `RelayerDown`, `RelayerLoopStalled`,
`RelayerAnchorStalled`, `RelayerLowFunds`, `RelayerFailedAnchors`, `RelayerErrorLoop` · `FollowerDown`,
`FollowerNodeUnreachable`, `FollowerGenesisMismatch` · `IndexerDown`.

Every rule has a `for:` window so a transient scrape miss doesn't page — the relayer's single-threaded
event loop (which also serves `/metrics`) can be blocked for up to `OP_TIMEOUT_MS` (120s) by a
synchronous committee ack, so `RelayerDown` uses `for: 3m` (> that). Tune `RelayerAnchorStalled` to your
`ANCHOR_EVERY` × block-time × safety + `CONFIRM_DEPTH_SLOTS`. `NodeNoPeers` is shipped **commented out**
(a single `--force-authoring` validator runs at 0 peers by design) — uncomment the whole block for a
multi-validator network. Wire `alertmanager.yml`'s receiver to your real notifier (Slack/PagerDuty/webhook).

> Scope: alert *delivery* and a reference watchtower are Phase 5 (Day-2 runbooks tying each alert to an
> operator action). This phase ships the signals + rules.
