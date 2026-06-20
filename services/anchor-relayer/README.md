# Anchor Relayer (cogno-chain M3, Tier-A — the Cardano WRITE link)

Every N **finalized** cogno-chain blocks, write that block's finalized post-state root onto
Cardano as transaction **metadata**, then `sudo`-call `Anchor.anchor_ack` back so the chain records
which Cardano tx witnessed which finalized root. The UI then shows *"anchored to Cardano at tx X."*

**Evidence, not enforcement (DR-20).** Cardano cannot reject a wrong root or roll cogno-chain back.
The anchor only lets a third party — given the committed archive (DR-08) — **detect** a silent
rewrite *after the fact*. It does not prevent a bad block, a fork, or censorship. See `PLAN.md` §4.9–
4.10 and §9 ("Anchoring is evidence, not enforcement").

## Why the finalized header's `state_root` (PLAN §4.9)

A Substrate block header's `state_root` is the storage-trie root **after** that block executes (its
post-state). Reading it from the **finalized** head means we anchor a root **GRANDPA has actually
committed** — never a best-chain or in-progress root that could later lose a fork. The pallet
deliberately does **not** snapshot a root itself in `on_initialize` (that would expose only block
`N-1`'s state). The relayer reads the committed root and records it.

## The §9 relayer lifecycle (this is most of the work)

| §9 risk | How it's handled |
|---|---|
| **idempotency / double-count** | `anchor_ack` is keyed by solochain `block_number` and no-ops a height `<= last recorded` (emits `AckIgnored`). The relayer also never re-anchors a height `<= LastCheckpoint`. Belt **and** suspenders. |
| **UTxO contention / output-chaining** | Single-threaded: each Cardano tx is **awaited to confirm** (its change UTxO indexed by db-sync) before the next anchor selects UTxOs, so anchor *k+1* naturally spends anchor *k*'s change. No two in-flight txs fight over one UTxO. |
| **Cardano rollback** | Two-sided: (a) if a submitted tx never confirms within `CONFIRM_TIMEOUT_MS`, it is rebuilt & resubmitted; (b) the ack waits until the tx is buried `CONFIRM_DEPTH_SLOTS` past the Cardano tip (DR-09b) so a confirm-then-rollback tx is never recorded — db-sync rolls back with the chain, so if a seen tx rolls back before burial its db-sync record vanishes and we keep polling. Acks are height-keyed, so a duplicate Cardano tx for the same height cannot double-count on L3. |
| **fees / min-ADA / collateral** | A metadata-only, **NO-script** tx → MeshTxBuilder coin-selects + computes the fee, change returns to the relayer. No collateral (no Plutus spend) and the M2d cost-model gotcha does **not** apply (the `fetchCostModels` warning is harmless here — the tx still validates and confirms). |

## Trust posture (DR-07, named honestly)

Two crown-jewel keys back this link: the relayer's **Cardano signing key** (here, the reused M2d
owner wallet — a single dev key) and the **`anchor_ack` authority** (sudo / `EnsureRoot` in v1 dev;
the pallet's `AnchorOrigin` is an `EnsureOrigin`, so a widen to a k-of-t committee is signature-
free). For anything past the showcase: a separate funded hot wallet with a native-script spend
policy, a runtime threshold collective for the ack, rotation, and a public audit log.

## Metadata label

`67797178` = ASCII **"COGN"** (C=67 O=79 G=71 N=78). A self-assigned showcase label — **not** a
CIP-10-registered value. Payload (all strings ≤ 64 bytes, the Cardano metadata limit):

```jsonc
{ "v": 1, "chain": "cogno-chain", "net": "preprod",
  "genesis": "<64-hex genesis hash>", "block": <n>,
  "root": "<64-hex finalized post-state root>", "posts": <n>, "ts": <unix-millis> }
```

`genesis` is fetched **live** (`client.getChainSpecData().genesisHash`), never hardcoded — the
runtime wasm is part of genesis state, so the genesis hash changes on every `spec_version` bump.

## Run

Shares the frontend's deps via `node_modules -> ../../app/node_modules` (a symlink; no separate
install) and reuses the M2d owner wallet at `../../app/scripts/m2d-wallet.mjs`. db-sync reads resolve
`pg` via the committee's `node_modules -> ../indexer/node_modules` symlink (it imports
`../committee/dbsync.mjs`). Prereqs: the live stack (preprod `cardano-node` + db-sync (read-only) +
Ogmios :1337) and the cogno-chain node on `:9944` (see `docs/M3-build.md`).

```bash
export PATH="/home/logic/.nvm/versions/node/v22.12.0/bin:$PATH"

# Continuous: anchor the latest finalized head every ANCHOR_EVERY (default 10) finalized blocks.
node relayer.mjs

# One-shot: anchor the current finalized head once (if higher than LastCheckpoint), then exit.
node relayer.mjs --once

# Idempotency / rollback-resubmit test: re-submit anchor_ack for the recorded checkpoint VERBATIM
# → expect the no-op (AckIgnored); the checkpoint is NOT double-counted.
node relayer.mjs --reack-last

# Verify (anyone can): A (L3 Anchor.LastCheckpoint) == B (archive header.state_root, re-derived)
#                      == C (Cardano metadata read back via db-sync). A mismatch is public evidence.
node verify.mjs                  # verifies the latest checkpoint
node verify.mjs --block <N>      # verifies the anchor recorded for height N (from the state file)
```

Env: `WS` (ws://127.0.0.1:9944), `DBSYNC_URL` (db-sync, read-only), `OGMIOS`, `ANCHOR_EVERY` (10), `CONFIRM_TIMEOUT_MS`
(180000), `POLL_MS` (4000), `CONFIRM_DEPTH_SLOTS` (0 = ack as soon as in a block, for the showcase;
set to k — a few hundred slots, DR-09b — for reorg-safe production), `COGNO_DATA_DIR` / `STATE_FILE`
(the anchor cursor defaults to `$COGNO_DATA_DIR/anchor-state.json` — never `/tmp`; an existing
`/tmp/cogno-m2/anchor-state.json` is auto-migrated on first run), `LABEL` (67797178).

## Single points of failure (§9, honest)

If the relayer dies, anchoring silently stops and tamper-evidence gaps open (existing posts are
unaffected). To *claim* tamper-evidence beyond a demo: health checks, alerting on missed-checkpoint
cadence, and a backfill path for finalized blocks skipped while the relayer was down.
