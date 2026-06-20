# Committee operator tooling (M6, DR-07)

Reusable tooling to drive cogno-chain's **privileged calls** through the **3-of-5 `FollowerCommittee`**
(propose → vote ×3 → close) instead of single-key **sudo** — the M6 Track 2 deliverable. It is the
committee-driven successor to the M2/M3 per-action sudo drivers (`app/scripts/grant-weight.mjs`,
`m2d-sync-weight.mjs`, the relayer's `anchor_ack`).

Uses **`@polkadot/api`** (dynamic metadata — auto-exposes the spec-106 `followerCommittee` /
`validatorSet` pallets, **no PAPI codegen**). `node_modules` is a symlink to `../indexer/node_modules`
(recreate: `ln -sfn ../indexer/node_modules node_modules`).

> ⚠ **D2-SHAPED, not D2-TRUST.** On a single-operator stack one operator holds all five committee keys.
> The mechanism + on-chain origin (`EnsureProportionAtLeast<3,5>`) are exactly real D2's; the five
> independent custody domains are not yet real. Every run prints this label. See
> `docs/D2-custody-runbook.md` for the gap-closing checklist, and `docs/M6-build.md` for the full story.

## Files

| File | What it is |
|---|---|
| `lib.mjs` | the reusable library: `viaCommittee` (propose/vote/close), `viaSudo`, `drive({via})` |
| `op.mjs` | general CLI — drive ANY privileged call via committee or sudo |
| `sync-weight.mjs` | the FOLLOWER's `set_stake` (+ battery), committee-driven (db-sync live mode or dev `--account/--weight`) |
| `shadow-diff.mjs` | in-protocol-observation **D4 shadow validation** — diffs the inherent's `cardanoObserver.ShadowStake` projection vs the committee's `talkStake.AllowedStake` (+ an independent db-sync recompute oracle). One-shot JSON, or `--serve` for Prometheus `:9102`. Convergence (committee leg) is eventual, not a correctness proof; a recompute disagreement IS a defect |
| `obs-shadow-demo.mjs` | live acceptance for the D4 shadow→enforce path — binds the live vault beacon, proves SHADOW projects-without-applying then ENFORCE applies (`credited=1`), resets to shadow. Mechanism proof only (D4-SHAPED on a single producer) |
| `m6-track2.mjs` | Track 2 live acceptance (set_stake + anchor_ack + add/remove_validator via committee) |
| `m6-validators.mjs` | Track 1 live acceptance (the on-chain mutable-validator checks) |
| `run-m6-track1.sh` | Track 1 orchestrator — stands up a 3-node `local` network + runs the acceptance |

## Usage

```bash
# General: drive any privileged call (camelCase pallet.method; JSON args; ss58 + decimal-string bignums)
WS=ws://127.0.0.1:9944 node op.mjs --call talkStake.setStake --args '["5Grw…","42000000"]' --via committee
WS=ws://127.0.0.1:9944 node op.mjs --call validatorSet.addValidator --args '["5FHne…"]' --via committee

# Follower set_stake (dev mode) through the committee:
WS=ws://127.0.0.1:9944 node sync-weight.mjs --account 5Grw… --weight 100000000 --via committee
# Follower set_stake (live: observe the vault via Cardano db-sync, largest-wins):
WS=… DBSYNC_URL=postgres://cogno_reader:…@host:5432/cexplorer node sync-weight.mjs --via committee

# In-protocol-observation (D4) shadow validation — inherent vs committee weight:
WS=ws://127.0.0.1:9944 node shadow-diff.mjs                                   # one-shot JSON (committee leg)
WS=… DBSYNC_URL=postgres://… node shadow-diff.mjs                             # + independent db-sync recompute oracle
WS=… DBSYNC_URL=… METRICS_PORT=9102 node shadow-diff.mjs --serve              # Prometheus /metrics + /healthz
# Flip the enforce/shadow flag (the gated cutover control — root/committee only; default is shadow):
WS=ws://127.0.0.1:9944 node op.mjs --call cardanoObserver.setEnforcement --args '[true]'  --via committee

# Live acceptances:
WS=ws://127.0.0.1:9944 node m6-track2.mjs        # Track 2, against a fresh `--dev` node
bash run-m6-track1.sh                             # Track 1, spins up its own 3-node network
```

The relayer (`services/anchor-relayer/relayer.mjs`) drives `anchor_ack` through this tooling by default
(`ANCHOR_VIA=committee`); `ANCHOR_VIA=sudo` keeps the PAPI sudo fallback.
