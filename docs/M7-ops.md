# M7 — Operational catch-up: live preprod stack + spec-107 cleanup + frontend descriptor fix

> **Status: DONE (2026-06-17), fully verified live on preprod spec 107.** An **OPS / maintenance**
> milestone, not new features — the `PLAN.md` §8 roadmap (M0→M5) and BOTH post-roadmap decentralization
> axes (M6) are complete. M7 brings the live Cardano preprod stack back up, drops the long-flagged
> `pallet-template` (spec 106 → **107**), regenerates the stale frontend PAPI descriptors against 107,
> and **re-proves the whole live loop on spec 107** — including the M6 committee paths, which surfaced
> (and we fixed) two real bugs in the relayer's committee `anchor_ack` path on its **first ever live
> run**, and **both L1 contract paths live** (a fresh mint+lock AND the burn/exit spend path, the
> latter never run live before — §8).

Builds on [M6](M6-build.md). See `docs/M2d-build.md`, `docs/M3-build.md`, `docs/DECISION-REGISTER.md`.

---

## 0. What changed (at a glance)

| Area | Before M7 | After M7 |
|---|---|---|
| `pallet-template` (@7) | present (M0 scaffold, "drop later") | **removed**; index 7 vacated (8..15 unchanged) |
| `spec_version` | 106 | **107** (`transaction_version` unchanged = 2) |
| Frontend PAPI descriptors | **stale** (couldn't encode against 106/107) | **regenerated against the live spec-107 node** |
| Cardano preprod stack | node synced but Ogmios/Kupo down | Ogmios :1337 + Kupo :1442 live against the synced node |
| Relayer committee `anchor_ack` | never run live (M6 used a synthetic test) | **run live — 2 bugs found + fixed**, real preprod tx + `AnchorAcked` |

---

## 1. The Cardano preprod stack — back up, nothing lost

The preprod `cardano-node` (Conway, v11.0.1) was **already running and fully synced to tip** (block
4834410, epoch 295, slot ~126056199, `syncProgress 100.00`), DB intact at
`testnets/node-preprod/db-testnet` (19 GB). So no re-sync was needed — just the indexers:

- **Ogmios** v6.14.0.2 on `:1337`, **Kupo** v2.11.0.1 on `:1442`, both pointed at the node socket.
  Kupo re-indexed from the saved `/tmp/cogno-m2/since.txt` point (`126031476.59be249f…`) to tip in
  seconds (match patterns = the vault policy `a82d0ad6…` + the owner address).
- **The wallet + the M2d artifacts survived the reboot** (all in `/tmp/cogno-m2`, verified):
  - owner `addr_test1qpsk23r…` — the persisted 24-word mnemonic **derives the same address** (pkh
    `61654474…`, skh `10133fde…`); funds spendable.
  - **The M2d vault UTxO is still unspent on-chain**: `65d05e73…#0` = 100 ADA + beacon
    `287a99d2…0ae6be75`, inline `VaultDatum{owner}` intact — confirmed via both `cardano-cli` and Kupo
    (`spent_at: null`).

---

## 2. Cleanup — drop `pallet-template`, bump to spec 107

`pallet-template` (the stock M0 scaffold at index 7) has been flagged "drop later" since M0. Removed in
one encoding-affecting change folded into the descriptor regen the frontend fix needed anyway:

- Deleted `pallets/template/`; removed it from `construct_runtime` (`runtime/src/lib.rs`), its
  `impl Config` (`runtime/src/configs/mod.rs`), the workspace + runtime `Cargo.toml` (dep + std +
  runtime-benchmarks + try-runtime features + `members`), and `define_benchmarks!`
  (`runtime/src/benchmarks.rs`).
- **`spec_version` 106 → 107**, `transaction_version` unchanged (2 — no `TxExtension` change). The
  on-wire pallet indices **8..15 are unchanged** (FRAME allows index gaps; only @7 is vacated).
- Updated `README.md`'s repo layout + pallet-index line. The historical build logs (`M0-build.md`,
  `L3-chain.md`, `DECISION-REGISTER.md`) keep their "Template(7, drop later)" wording — accurate as
  the *plan* that M7 now executes.

**Rust acceptance — all green** (pinned rustc 1.90.0):

- `cargo test` pallets: **anchor 8 · cogno-gate 11 · microblog 18 · talk-stake 6 · validator-set 9**.
- Node **builds both feature ways**: default `--release` (89 MB binary, reports spec 107) AND
  `--release --features runtime-benchmarks` (both exit 0).
- `cargo test -p pallet-validator-set --features runtime-benchmarks`: **11** (incl. the bench suite).
- No dangling `Template` references remain in code.

---

## 3. The real breakage — regenerate the frontend PAPI descriptors against 107

The `app/` `@polkadot-api/descriptors` ("cogno") were stale and could not encode against the new spec.

- Stood up a fresh spec-107 `--dev` node (`./target/release/cogno-chain-node --dev --tmp --rpc-port 9944`).
- **Forced a clean regen** (the M3 cache gotcha): `rm .papi/descriptors/generated.json` then
  `npx papi add cogno -w ws://127.0.0.1:9944`. Metadata `cogno.scale` changed
  (`b39e10c5…` → `ed43ba0e…`); the generated descriptors now have **no `Template`** and expose
  `ValidatorSet`/`Session`.
- **`npm run build` is green** — Next.js static export, typecheck passes (every call shape the app
  uses is metadata-compatible with 107). 4 static pages → `app/out/`.
- **Real-browser smoke** (`app/scripts/e2e-m7-browse.mjs`, headless Chrome on the built SPA): the SPA
  **connects to the spec-107 node via PAPI**, renders the **live feed** (the feeless post id=0,
  decoded via `watchEntries` against 107 metadata), shows the **Cardano anchor** status (reads
  `Anchor.LastCheckpoint`), **no fatal console errors** → descriptors decode cleanly in-browser.

---

## 4. Re-proving the live loop on spec 107 (the existing vault)

All flows re-proven live against the still-live M2d vault (no new funds), driven through the M6
**3-of-5 FollowerCommittee** (no sudo on any privileged path; **D2-SHAPED, not D2-TRUST** —
single-operator holds all 5 keys):

1. **CIP-8 bind** (`m2d-bind.mjs` via the Cogno-Follower on :8090): owner Cardano wallet signs the
   committed payload → follower verifies → `link_identity` → identity `287a99d2…0ae6be75` (== the
   vault beacon name) bound to `//CognoVaultPoster` (`5G6P5SyE…`); `AccountOf` readback matches.
2. **Committee `set_stake` from the live vault** (`services/committee/sync-weight.mjs`, `KUPO` set,
   `--via committee`): observed the real vault (100 ADA, largest-wins) → `AccountOf[287a99d2…]` →
   `talk_stake.set_stake(5G6P5SyE…, 100000000)` executed by a 3-of-5 committee motion → `StakeSet`.
   Weight = the **locked lovelace**, Cardano-sourced, **zero sudo grant**.
3. **Feeless post** (`m2d-post.mjs`): `//CognoVaultPoster` posts → **`PostCreated id=0`**, **free
   balance Δ = 0** (feeless). 🎯 locked ADA → committee-set weight → feeless post, on spec 107.
4. **Committee Track-2 self-test** (`services/committee/m6-track2.mjs`, spec check relaxed to `>= 106`):
   `set_stake` + `anchor_ack` + `add/remove_validator` all via the 3-of-5 committee, no sudo — PASSED.
5. **Real Anchor Relayer via the committee** (`services/anchor-relayer/relayer.mjs`,
   `ANCHOR_VIA=committee --once`): wrote a real preprod **metadata tx**, then `anchor_ack` via the
   committee → `AnchorAcked`, on-chain `LastCheckpoint` = **block #145**, root `0x65128612…`,
   cardanoTxhash `0x95e33a65…`. (Earlier txs `5e61c375…` / `16d5c71a…` were written while debugging §5.)

---

## 5. Bugs found + fixed (the relayer committee path's first live run)

M6 proved the committee `anchor_ack` only with a **synthetic** test (`m6-track2.mjs`, a hard-coded
`0x`-prefixed dummy txhash). Running the **real** relayer (`ANCHOR_VIA=committee`) for the first time
surfaced two bugs — both fixed in `services/anchor-relayer/relayer.mjs`:

1. **`[high]` no `0x` prefix on the Cardano txHash → committee `anchor_ack` rejected.** The state_root
   (from PAPI) is `0x`-prefixed, but the txHash (from MeshJS `submitTx`) is bare hex. Passed to
   `op.mjs` (@polkadot/api) bare, the 64-char hex was read as a **64-byte raw string** →
   `Expected 32 bytes, found 64`. **Fix:** normalize both args to `0x`-hex in `committeeAnchorAck`.
2. **`[low/cosmetic]` mis-reported a successful ack as "AckIgnored".** The relayer's post-check
   re-read `LastCheckpoint` immediately after `op.mjs` returned (which resolves at *in-block*), but
   PAPI reads **finalized** state, ~1–2 blocks behind → it saw the old height and printed "AckIgnored"
   even though `AnchorAcked` had fired (verified on-chain). **Fix:** capture `op.mjs`'s output and read
   the **actual inner committee events** (`AnchorAcked`/`AckIgnored`) instead of a racy storage re-read.

The metadata-tx half worked from the first run (the cost-model "fallback to defaults" log is **benign**
for a metadata-only / no-script tx, per M3).

---

## 6. The burn / unlock (spend-path) driver — written, ready to run

`app/scripts/m2d-unlock.mjs` (new) performs the contract's **full-exit** path in one tx (proves the
SPEND path live, which M2d only aiken-checked): spend the vault UTxO with the `Spend` redeemer
(`d87980` = `VaultRedeemer::Spend`), **burn the beacon (-1)** with the existing `burnRedeemerCborHex`
helper, owner payment signature, no continuing output → the reclaimed ADA flows to the owner as
change. Reuses the live Kupo/Ogmios + the M2d `setCostModels` fix. Targets one vault per tx (the
own-input-count==1 guard); defaults to the oldest if several exist, or pass `<txHash>#<index>`.

---

## 7. Acceptance evidence

| Item | Evidence |
|---|---|
| Cardano stack | Ogmios :1337 tip slot ~126056712; Kupo :1442 caught up; vault `65d05e73…#0` unspent |
| Template drop / spec 107 | runtime reports `specVersion 107`; pallet tests + both feature builds green |
| Descriptor regen | `cogno.scale` `b39e10c5…`→`ed43ba0e…`; no Template; `npm run build` green |
| Browser | `e2e-m7-browse.mjs` PASS — connect + live feed (post id=0) + anchor status, no decode errors |
| Live loop (committee) | bind `287a99d2…` → committee `set_stake` 100000000 → feeless `PostCreated id=0` (Δ=0) |
| Committee paths | `m6-track2` PASS (spec 107); real relayer `AnchorAcked` block #145, tx `0x95e33a65…` |

**Real preprod txs this milestone:**
- Relayer metadata (label 67797178 = "COGN"): `5e61c375…` (block 90, debugging) · `16d5c71a…`
  (block 118) · **`95e33a65…` (block 145, `AnchorAcked` via committee)**.
- L1 contract: **burn/exit `888515c6…`** (spent vault `65d05e73…#0`, beacon burned, 99.67 ADA
  reclaimed — the spend path's first live run) · **fresh lock `4c349ddac4bc…`** (new vault + beacon) →
  committee `set_stake` → **feeless `PostCreated id=1`**.

---

## 8. Both L1 contract paths proven live (after the wallet top-up) — DONE ✓

The owner wallet was topped up (→ 1332.6 tADA), so both the mint+lock and the never-run-live spend
path were exercised on real preprod:

1. **Live burn / full-exit (the SPEND path — first time ever live).** `m2d-unlock.mjs` spent the
   original M2d vault `65d05e73…#0` with the `Spend` redeemer (`d87980`) + burned its beacon (-1) +
   owner signature, no continuing output → **tx `888515c6fe9545c0256d55b316e568160e5d5acdf8928f81a13fecad306eaee6`**.
   Verified: Kupo shows the vault spent (redeemer `d87980`, slot 126058697), the vault address is
   **empty** (beacon burned), and the owner reclaimed **99.67 ADA**. M2d had only aiken-checked the
   spend path; it now executes on-chain.
2. **Fresh mint+lock.** `m2d-lock.mjs` minted a new beacon `287a99d2…` (same deterministic name) +
   locked 100 ADA with inline `VaultDatum{owner}` → **tx
   `4c349ddac4bc118dbe406ea16a2c788a969017b96c9aaf86e51cfd202b29f909`** (the only vault UTxO now).
3. **Full loop closed on the fresh lock.** Committee `sync-weight` observed the fresh vault → committee
   `set_stake(5G6P5SyE…, 100000000)` (motion #8) → `m2d-post.mjs` → **`PostCreated id=1`, free balance
   Δ = 0 (feeless)**. Lock → committee weight → feeless post, end-to-end on brand-new funds.

End state: owner ≈ 1331.9 tADA (2 UTxOs) + one fresh vault (100 ADA + beacon). Cycle cost ≈ 0.66 ADA.

---

## 9. Gotchas (recorded / re-confirmed)

- **`pkill -f cogno-chain-node` self-kills** an ad-hoc shell whose cmdline contains that string — kill
  by PID or use the `[c]ogno-chain-node` regex (inside a script file it's safe).
- **Always free :9944 before a live run** — a leftover node holds it and a fresh node silently falls
  back to a random RPC port.
- **PAPI regen cache:** delete `.papi/descriptors/generated.json` to force a real regen after a spec
  rebuild (else "no changes needed").
- **A fresh `--dev --tmp` rebuild changes genesis** (wasm is in genesis state; spec-107 genesis here =
  `0x2653e177…`) — fetch genesis live, never hardcode.
- **Committee txhash encoding:** any `[u8;32]` arg to the @polkadot/api committee tooling (`op.mjs`)
  must be `0x`-prefixed hex; a bare MeshJS txHash is read as a 64-byte string (§5.1).
- **`m6-track2.mjs` spec assertion** relaxed from `== 106` to `>= 106` so it runs on 107+.

---

## 10. Where M7 lives

- **Runtime:** `runtime/src/lib.rs` (spec 107, Template removed), `runtime/src/configs/mod.rs`,
  `runtime/src/benchmarks.rs`, `runtime/Cargo.toml`, workspace `Cargo.toml`, `Cargo.lock`; deleted
  `pallets/template/`.
- **Frontend:** regenerated `app/.papi/{metadata/cogno.scale, polkadot-api.json, descriptors/}`;
  new `app/scripts/e2e-m7-browse.mjs`.
- **Services:** `services/anchor-relayer/relayer.mjs` (the 2 committee-path fixes),
  `services/committee/m6-track2.mjs` (spec check).
- **New driver:** `app/scripts/m2d-unlock.mjs` (the burn/exit spend-path tx).
- **Docs:** this file; `README.md` (pallet list).
