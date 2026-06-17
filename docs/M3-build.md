# M3 build log — Anchor to Cardano, Tier-A (the Cardano WRITE link)

**Status: DONE — proven LIVE on preprod (2026-06-17).** Every N finalized cogno-chain blocks, the
off-chain **Anchor Relayer** writes that block's finalized post-state root onto Cardano as tx
**metadata**, then `sudo`-calls `Anchor.anchor_ack` back so the chain records *which* Cardano tx
witnessed *which* finalized root. Three real metadata txs landed on preprod; `anchor_ack` records
each height exactly once (idempotent); the verify step re-derives the root from the archive and the
Cardano metadata and they agree. **Evidence, not enforcement (DR-20)** — Cardano cannot reject a
wrong root or roll the chain back; the anchor only lets a third party **detect** a silent rewrite
after the fact (given the committed archive, DR-08). PLAN §4.9–4.10, §8 (M3 row), §9; `L3-chain.md`.

## What M3 is

The second of the two one-directional Cardano links: M2/M2d is the **READ** link (Cardano gates
posting); M3 is the **WRITE** link (the chain witnesses itself on Cardano). It is *logging*, not a
bridge. The honest line (PLAN §4): integrity-against-silent-rewrite is **witnessed** by Cardano and
**checkable only if the underlying data is independently available**; liveness, censorship-
resistance, and block validity still rest on trusting the operator.

## 1. `pallet-anchor` (runtime index 12) — RECORDS ONLY

`pallets/anchor/` — a standalone FRAME pallet (no cross-pallet deps), shaped like `pallet-talk-stake`.

- **Storage** `LastCheckpoint: Option<Checkpoint<BlockNumberFor<T>>>` where `Checkpoint =
  { block_number, finalized_root: [u8;32], cardano_txhash: [u8;32], post_count: u64, timestamp: u64 }`.
  A single value, not a history map: Cardano is the append-only log of *all* anchors (each is its own
  tx); the chain only needs the latest height to enforce monotonicity + show "anchored at tx X".
- **Extrinsic** `anchor_ack(block_number, finalized_root, cardano_txhash, post_count, timestamp)`,
  gated by `AnchorOrigin = EnsureRoot<AccountId>` (sudo in dev — the DR-07 trust boundary shared
  with the follower's `FollowerOrigin`/`SetStakeOrigin`; an `EnsureOrigin`, so a k-of-t widen is
  signature-free).
- **IDEMPOTENT + MONOTONIC (§9, load-bearing):** a no-op if `block_number <= last recorded` (emits
  `AckIgnored`, writes nothing). A Cardano rollback can force the relayer to re-submit the same
  checkpoint; keying on the solochain height makes a re-submit safe — the recorded checkpoint
  advances **exactly once per height**. On a strictly higher height it overwrites + emits
  `AnchorAcked`.
- **It RECORDS ONLY** — it does **not** snapshot a root in `on_initialize` (which would expose only
  block `N-1`'s state and could anchor a root that later loses a fork, PLAN §4.9). The trusted
  relayer reads the root GRANDPA has *committed* (the finalized header's `state_root`) and submits it.

`spec_version` bumped **103 → 104** (new pallet/calls/storage — encoding-affecting); `transaction_version`
unchanged (no `TxExtension` change). Runtime wiring: workspace + runtime `Cargo.toml`, `runtime/src/lib.rs`
(`#[runtime::pallet_index(12)] pub type Anchor = pallet_anchor;`), `runtime/src/configs/mod.rs`.

**Tests: `cargo test -p pallet-anchor` 8/8** — first-ack records + emits; origin gating (signed →
`BadOrigin`); higher-height advance; re-ack same height = no-op (`AckIgnored`, no overwrite); lower
height = no-op; a monotonic sequence. Release node builds clean.

⚠ **PAPI descriptors regenerated** (`npm run papi:add` → `papi`). The new pallet + spec bump make the
old descriptors stale (exactly as M2d saw for `Microblog.Posts` at 103). **Gotcha:** the codegen
caches the metadata hash in `.papi/descriptors/generated.json` — after a manual `rm -rf dist` it will
report *"no changes needed"* and not rebuild; delete `generated.json` too (or re-run `papi add`) to
force a clean regen. The regenerated `cogno` descriptor exposes `query.Anchor.LastCheckpoint`,
`tx.Anchor.anchor_ack`, `events.Anchor.{AnchorAcked, AckIgnored}`.

## 2. The Anchor Relayer (`services/anchor-relayer/`)

TS/ESM, reusing PAPI + MeshJS. Shares the frontend's deps via `node_modules -> ../../app/node_modules`
(a symlink — no separate install) and reuses the **M2d owner wallet** (`app/scripts/m2d-wallet.mjs`)
as the relayer signing wallet (a single dev key, DR-07/§9, labelled as such). See its `README.md`.

The loop: read the **finalized** head via PAPI (`getFinalizedBlock` → `getBlockHeader(hash).stateRoot`
= the post-state root) + `NextPostId` + `Timestamp.Now` **at that pinned block** → build a metadata
tx (`MeshTxBuilder.metadataValue(LABEL, {...})`, **no Plutus script**) embedding the root → submit via
Ogmios → **await Kupo confirmation (+ optional burial past `CONFIRM_DEPTH_SLOTS`)** → `sudo`-call
`anchor_ack`. Modes: `--once`, `--reack-last` (the verbatim rollback-resubmit / idempotency test),
and watch (every `ANCHOR_EVERY` blocks).

**§9 lifecycle handled** (the bulk of the work): idempotency (height-keyed, both relayer + pallet);
UTxO output-chaining (single-threaded await-confirm-before-next-anchor — anchor *k+1* spends *k*'s
change, no contention); Cardano rollback (resubmit on timeout + bury past `CONFIRM_DEPTH_SLOTS` before
acking so a confirm-then-rollback tx is never recorded); fees/min-ADA (a metadata-only tx, MeshJS
coin-selects, change back to self, no collateral).

**Metadata label `67797178`** = ASCII "COGN" (self-assigned, not CIP-10-registered). Payload (all
strings ≤ 64 bytes): `{ v, chain, net, genesis, block, root, posts, ts }`. The **genesis hash is
fetched live** (`getChainSpecData().genesisHash`), never hardcoded — a fresh `--dev` chain rebuilt
from a new runtime gets a NEW genesis (the wasm is part of genesis state), so the spec-103 value
`27af38…` is wrong for the spec-104 chain (`41467cdc…`).

### Two live gotchas (recorded)
- **PAPI `BlockNotPinnedError`** — `api.query.X.getValue({ at: hash })` requires the block to be
  **pinned** in PAPI's chainHead subscription. Feeding it a hash from a *legacy* RPC
  (`chain_getFinalizedHead`) throws. **Fix:** read the finalized head, its header, and the storage
  reads all through PAPI (`getFinalizedBlock`/`getBlockHeader`/`getValue({at})` on the pinned hash).
  For `verify.mjs`'s **archive** read of an arbitrary historical block, the legacy
  `chain_getHeader(chain_getBlockHash(N))` over HTTP is the right tool (works regardless of pinning,
  since headers are always retained); deep **state** reads at an old block need a `--pruning archive`
  node (DR-08) — best-effort, never fails the verify (the `state_root` is the load-bearing check).
- **Cost-model warning is BENIGN here** — `KupoProvider.fetchCostModels` still throws "Method not
  implemented" and MeshJS logs a fallback to default cost models, **but a metadata-only tx has no
  Plutus script**, so cost models are irrelevant and the tx validates + confirms. (The M2d cost-model
  fix — inject Ogmios models via `setCostModels` — applies only to script txs; PLAN was explicit.)

## 3. Frontend — "anchored to Cardano at tx X" (PLAN §7-E)

`app/src/`: `AnchorCheckpoint` type (`lib/types.ts`); `watchAnchor` (`lib/chain/reads.ts`, watches
`Anchor.LastCheckpoint`); `useAnchor` hook; `<AnchorStatus>` component + CSS (a Civic-Ledger mono
strip after `<ProvenanceLine>`): "Cardano anchor · block #N · root <short> · tx <short> ↗" linking the
preprod explorer, plus a "anchor: evidence, not enforcement" honesty badge and a "what this means"
explainer. The tx link uses ink, **not** the reserved verdigris accent (capacity/identity only). Not
yet anchored → an honest placeholder. `npm run build` green (typecheck + static export); `watchValue`
confirmed emitting the live checkpoint.

## 4. Adversarial review (workflow) — 7 confirmed bugs, all fixed

A background review workflow (3 dimensions × find→adversarially-verify) raised 18, confirmed 7; all
fixed and re-validated live:
1. **[med]** `waitConfirmed` `.catch()` guarded only `.json()`, not `fetch()` → a Kupo blip mid-wait
   crashed `--once`. → `fetch(...).then(r=>r.json()).catch(()=>[])`.
2. **[med]** acked at Cardano depth-1 (no reorg burial) → a confirm-then-rollback tx would pin a
   vanished txhash. → added `CONFIRM_DEPTH_SLOTS` burial gate (read Ogmios tip; default 0 for the
   showcase, set k per DR-09b for production).
3. **[low]** genesis comment claimed "changes whenever spec_version bumps" — imprecise (block-0 hash
   is fixed per chain; it changed because I rebuilt a *fresh* dev chain). → corrected.
4. **[high]** `verify.mjs` printed VERIFIED even when the Cardano witness (C) was unreadable. →
   require `ac === true` (the witness is the whole point; unreadable = hard fail).
5. **[high]** `verify --block N` compared the *latest* checkpoint's root (A) against block N's archive
   root → false negative for any N ≠ latest. → source A per-height from the relayer state file.
6. **[med]** `verify` silently fell back to the last anchor when no per-block entry matched. → drop
   the fallback (hard-error).
7. **[med]** (B) overclaimed "re-derive from genesis"; it reads one operator node. → added a
   chain-identity guard (node genesis == anchored genesis) + honest comment.

## 5. LIVE preprod acceptance — DONE ✓ (2026-06-17)

Stack: synced preprod `cardano-node` (Conway, slot ~126040k) + Ogmios :1337 + Kupo :1442 (matching
the relayer addr) + cogno-chain node :9944 (spec 104) + 3 feeless posts (`NextPostId = 3`). Relayer
wallet `addr_test1qpsk23r…` 99.66 → **99.14 ADA** after 3 anchors (≈0.17 ADA fee each).

| solochain block | finalized post-state root | Cardano metadata tx | slot |
|---|---|---|---|
| #149 | `5a55f24dee927f17…654c774` | `58803698f0ba0cbf1be335422106a9aa8796b4a9b2c0c480ce702b23d4170e58` | 126039736 |
| #167 | `d0bc9397c265a27d…8cf89c1e` | `f8db8fab0365491c9a119acc8244f691db072d934442aaa64483a7340a1e1b17` | 126039837 |
| #224 | `e5916cfafefba54f…efa2e60e` | `2e82c32272990013be2328c33d33c9c26d3a710515c442d376e66b8b5bdb687c` | 126040198 (acked after burial ≥15 slots) |

- **Anchored** (`AnchorAcked`): finalized root → metadata tx → confirmed → `anchor_ack`. The
  on-chain metadata (read back via Kupo) carries the exact root, block, genesis, and post_count.
- **Idempotent** (`--reack-last`): a verbatim re-submit of checkpoint #149 → **`AckIgnored`**
  (block #149, last #149), `LastCheckpoint` unchanged — not double-counted.
- **Monotonic**: 149 → 167 → 224 each strictly advanced; the 2nd/3rd txs spent the prior anchor's
  change (output-chaining, no UTxO contention).
- **Verified** (`verify.mjs`): for every checkpoint, **A == B == C** — A (L3 `LastCheckpoint`) ==
  B (archive `chain_getHeader(N).state_root`, re-derived) == C (Cardano metadata read back via Kupo);
  chain identity (node genesis == anchored genesis) ✓; the Cardano `block` field matches; post_count
  consistent where archive state is retained. *"No silent rewrite before this anchor."*

## Acceptance evidence

`cargo test -p pallet-anchor` 8/8 · release node builds (spec 104) · `npm run build` (frontend) green
· descriptors regenerated · **LIVE preprod: 3 metadata txs (149/167/224) carrying the matching
finalized roots; `anchor_ack` records each height once (idempotent `AckIgnored` on re-submit);
`verify.mjs` A==B==C passes**.

## Honest gaps / deferred (named, not hidden)

- v1 = a single relayer key + sudo ack (DR-07); the showcase default acks at Cardano depth-1
  (`CONFIRM_DEPTH_SLOTS=0`) for snappiness — production sets k (a few hundred slots, DR-09b). No
  backfill path for blocks skipped while the relayer is down (DR-22, acceptable for a demo); no
  health/missed-checkpoint alerting yet (§9).
- The dev node runs `--dev --tmp` (state pruned for old blocks), so `verify --block N` for an old N
  re-derives the **root** (always works — headers retained) but skips the post_count cross-check;
  v1 commits a `--pruning archive` node + published genesis/chainspec so "anyone can verify" is
  honestly backed (DR-08). Tier-B (an on-Cardano append-only checkpoint UTxO) is M5 (DR-20).

Next: **M4 (SubQuery indexer + richer feed)** per PLAN §8.
