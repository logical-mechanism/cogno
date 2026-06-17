# M2c build log — feeless, capacity-metered posting (the talk battery)

> Persistent log for milestone **M2c** (PLAN.md §8): *Talk capacity — feeless metered
> posting.* The signature mechanic: posting is now **feeless** and rate-limited by a
> regenerating, stake-weighted **talk-capacity** meter (Hive-RC / Midnight-DUST style).
> Brought forward ahead of the M2 identity gate (the capacity mechanic is decoupled from the
> gate in dev — weight is set by the operator via sudo here; Cardano-sourced weight is M2d).
> Builds on M0 (chain) + M1 (frontend). Spec bumped **101 → 102**, transaction_version **1 → 2**.

## Scope

- **IN:** `pallet-talk-stake` (per-account weight); talk-capacity **folded into
  `pallet-microblog`** (DR-24) — the lazy token bucket (`current_capacity`/`on_first_bind`/
  `post_cost`/`consume`); the `CheckCapacity` **TransactionExtension** (gate inclusion at the
  pool → `ExhaustsResources`; consume at post-dispatch); **feeless** `post_message` via
  `#[pallet::feeless_if]` + `SkipCheckIfFeeless<ChargeTransactionPayment>`; the frontend
  `<CapacityBattery>` (the signature widget) + the client capacity replay; a dev grant flow.
- **DEFER:** the Cardano **identity gate** (M2 — `pallet-cogno-gate` + CIP-8 + the follower);
  **Cardano-sourced weight** (M2d — the `talk_vault` lock + follower `set_stake`); the anchor
  (M3); the indexer (M4); real benchmarked `WeightInfo` (DR-05, dev weights for now).

## Runtime design (the trickiest part)

- **`pallet-talk-stake`** (`pallet_index(9)`): `AllowedStake: StorageMap<AccountId, u128>`
  (`ValueQuery` → unbound reads 0); `set_stake(who, weight)` gated by `SetStakeOrigin`
  (= `EnsureRoot`/sudo in dev, the DR-07 escape hatch; the future follower `FollowerOrigin`
  slots in signature-free). Writes **only** `AllowedStake`, never the capacity row →
  going-forward-only (`ECONOMICS.md` §6.1).
- **Capacity folded into `pallet-microblog`** (microblog `Config: pallet_talk_stake::Config`):
  `Capacity: StorageMap<AccountId, CapacityState{cap_last, last_block}, OptionQuery>` + pure
  fns. **Anti-farm invariants:** `current_capacity` `None ⇒ 0` (new identity charges from
  empty); the row is **never deleted** on unlock (only `weight→0` clamps via `min()`); `consume`
  is the sole writer; all `saturating_*`. `force_set_capacity(who, cap_last)` (gated by
  `ForceOrigin` = sudo) is the M2c operator stand-in for the gate's first-bind bookkeeping —
  it primes the row + a provider ref (`inc_providers`, needed so a feeless poster isn't
  rejected by `CheckNonce`, L3 §5.5) and pre-charges the battery for the showcase.
- **`CheckCapacity` TransactionExtension** (in the microblog crate): `validate()` reads
  `current_capacity` + `post_cost` (≈2 cheap reads, no crypto) and returns `ExhaustsResources`
  if `have < need` (bounds **inclusion** — the block author re-runs validate); consumes in
  `post_dispatch_details()` (inclusion only). Wired into `TxExtension` **before** payment.
- **Feeless** (two orthogonal mechanisms): `#[pallet::feeless_if(|_,_,_| true)]` marks
  `post_message` feeless; `pallet-skip-feeless-payment` (`pallet_index(11)`) +
  `SkipCheckIfFeeless<ChargeTransactionPayment>` in the tuple skip the fee for it. Feeless is
  **per-call** — `delete_post` stays fee-bearing (prevents free delete-spam). The
  `SkipCheckIfFeeless` wrapper is **metadata-invisible** (PAPI still sees plain payment).
- **Dev capacity constants** (`runtime/src/configs`, all runtime-tunable; the real v1 ~5h
  window per DR-10 is a constant change for mainnet): `CapRatio=50`, `RegenPerBlock=2`,
  `Ceiling=5e12`, `BaseCost=50_000_000` (1 post), `PerByteCost=50_000`. A grant of weight
  `10_000_000` (≈10 ADA lovelace) → cap ≈ **10 posts** burst, ~1 post / 2.5 blocks (~15s),
  empty→full ≈ 25 blocks (~2.5 min).

### Build gotchas (each cost a compile cycle — recorded)

1. **`T::WeightInfo` is ambiguous** once microblog `Config: pallet_talk_stake::Config` (both
   supertraits define `WeightInfo`) — qualify as `<T as Config>::WeightInfo::…` in `#[pallet::weight]`.
2. **`RuntimeDebug` derive is not in `pallet_prelude`** scope — use plain `#[derive(Debug)]`
   for `CapacityState` (or `DebugNoBound` for T-generic structs).
3. **`DispatchResult` becomes ambiguous** via the pallet module's `use super::*` glob when also
   imported at crate root — keep it out of the crate-root `use`; fully-qualify `sp_runtime::DispatchResult`
   in the extension.
4. **`BlockNumber::saturating_sub`** needs `use sp_runtime::traits::Saturating` in scope.
5. **The node's `benchmarking.rs` hand-builds the `TxExtension` tuple** (and its implicit
   tuple) — both must add `CheckCapacity` + wrap payment in `SkipCheckIfFeeless`, else the node
   crate fails (`cargo check -p runtime` passes but the node doesn't). Add `pallet-microblog` +
   `pallet-skip-feeless-payment` as node deps.
6. **TransactionExtension signature (sp-runtime 46):** `validate(&self, origin, call, info, len,
   self_implicit, inherited_implication: &impl Encode, source) -> ValidateResult<Val, Call>`;
   `prepare(self, val, origin, call, info, len)`; `post_dispatch_details(pre, info, post_info,
   len, result)`. Use `impl_tx_ext_default!(T::RuntimeCall; weight)`; bound `T::RuntimeCall:
   Dispatchable<Info=DispatchInfo, PostInfo=PostDispatchInfo> + IsSubType<Call<T>>`; extract the
   signer with `frame_system::ensure_signed(origin.clone())` (same idiom as ChargeTransactionPayment).

## Frontend (the battery)

- `lib/chain/capacity.ts` — the `current_capacity()` replay VERBATIM (all bigint, advisory;
  constants from `api.constants.Microblog.*`, fail-closed) + `draftStatus` (edge order:
  weight==0 → `no_weight` first; then `need>cap` → `too_long`; guard `rate==0` before ceil-div).
- `components/CapacityBattery.tsx` — the signature widget: a 20-segment meter fed by the replay,
  the verdigris accent (the one place color carries identity), a draft need-marker, color-redundant
  edge-state labels (`role="meter"` + aria). New `--cap-*` semantic tokens added to `tokens.css`.
- `hooks/useCapacity.ts` — watches `TalkStake.AllowedStake` + `Microblog.Capacity` at `best`,
  recomputes the view every best-block tick so regeneration animates live.
- `lib/chain/post.ts` — `ExhaustsResources` → a friendly "out of talk capacity" message.
- `scripts/grant-weight.mjs` (`npm run grant`) — dev operator tool: `sudo(set_stake)` +
  `sudo(force_set_capacity)` for the dev accounts so the showcase has a charged battery.

## Acceptance — verified at three levels

1. **Pallet unit tests** — `cargo test -p pallet-talk-stake -p pallet-microblog` → **21 pass**
   (bucket math, first-touch=0, regen+clamp, consume, ceiling, unlock-clamp-to-zero, on_first_bind
   idempotent/no-remint, going-forward-only, force-set gated, + the M0 post/read/delete tests).
2. **Programmatic** — `app/scripts/m2c-acceptance.mjs` (same PAPI stack) → **PASS**: constants
   from metadata; an **unweighted account is rejected at the pool** (ExhaustsResources); sudo grant;
   **feeless post — free balance unchanged (Δ=0)**; capacity consumed; **drain → ExhaustsResources**
   after ~15 posts; **regen → posting resumes**. (Lesson: use a fresh `--tmp` node per run — a
   prior run's grants contaminate the "unweighted reject" step.)
3. **Browser** — `app/scripts/e2e-m2c.mjs` (headless Chrome, built static SPA) → **PASS**: the
   `<CapacityBattery>` renders **charged** ("10 / 10 posts · +0.40/block · ready to post",
   aria-valuenow = max); a **feeless post lands in the live feed**; the **battery drains**
   (aria-valuenow 500000000 → 487150000 — the ~52M consume net of ~40M regen over ~2 blocks).
   Screenshots: `/tmp/cogno-m1/e2e-m2c-{1-charged,2-drained}.png`. Only a benign favicon 404.

## How to run

```
# chain (M2c runtime, spec 102)
cargo build --release -p cogno-chain-node
./target/release/cogno-chain-node --dev --tmp --rpc-port 9944
# app (from app/, PATH=…/nvm v22.12.0/bin)
cd app && npx papi add cogno -w ws://127.0.0.1:9944   # regen descriptors (spec 102)
npm run grant            # operator: charge the dev accounts' batteries (sudo)
npm run dev              # or: npm run build && serve out/
npm run acceptance:m2c   # programmatic regression (use a fresh node)
```

**M2c is functionally complete and browser-verified.** Next: **M2** (the Cardano wallet /
CIP-8 identity gate), then **M2d** (Cardano-sourced weight via the `talk_vault` lock).
