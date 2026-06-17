# M6 — Full decentralization: mutable validators + a committee-driven live stack

> **Status: DONE (2026-06-17), verified locally end-to-end (Track 1 live multi-node; Track 2 live
> `--dev`).** A **post-roadmap** milestone: `PLAN.md` §8 (M0→M5) is complete. M6 finishes the two
> decentralization tracks M5 deliberately left:
>
> 1. **Track 1 (chain):** the block-producing validator set was still static-genesis Aura/GRANDPA —
>    make it **MUTABLE** (`L3-chain.md` §8.2) via `pallet-session` + a `pallet-validator-set`, and
>    write the SPO/Ariadne graduation design (§8.3).
> 2. **Track 2 (live stack):** the off-chain follower + relayer still drove privileged calls via
>    single-key **sudo** — give them the M5 **3-of-5 `FollowerCommittee`** path (DR-07/DR-26) and the
>    D2 custody runbook.
>
> **Runtime: spec_version 105 → 106, transaction_version UNCHANGED (2)** — two new pallets
> (`ValidatorSet` @14, `Session` @15) + new genesis are encoding-affecting (regen PAPI descriptors),
> but no `TxExtension` change. Builds on [M5](M5-build.md). See `docs/L3-chain.md` §8,
> `docs/L3-SPO-graduation.md`, `docs/D2-custody-runbook.md`, `docs/DECISION-REGISTER.md` DR-26/07/22/25.

---

## 0. What changed (at a glance)

| Area | Before M6 | After M6 |
|---|---|---|
| Aura/GRANDPA authorities | **static genesis** (`pallet_aura`/`pallet_grandpa` GenesisConfig) | **mutable**, derived from `pallet-session` each rotation; genesis seats them via `SessionConfig` (aura/grandpa genesis now empty — mutually exclusive) |
| Validator add/remove | impossible (frozen) | `pallet-validator-set::add_validator`/`remove_validator`, gated by the M5 `AuthorityOrigin`, **queued → applied at a session boundary** |
| Pallets | 0..13 (FollowerCommittee @13) | + `ValidatorSet` **@14** + `Session` **@15** |
| Off-chain services' privileged calls | single-key **sudo** (`set_stake`, `link_identity`, `anchor_ack`) | driven through the **3-of-5 FollowerCommittee** (`--via committee`, default), sudo retained as the dev fallback |
| Operator tooling | per-action sudo scripts (grant/sync-weight/anchor_ack) | one reusable **propose→vote→close** lib + CLI (`services/committee/`) |
| Graduation | undocumented | `docs/L3-SPO-graduation.md` (SPO/Ariadne) + `docs/D2-custody-runbook.md` (DR-07 D2) |

---

## 1. Track 1 — mutable Aura + GRANDPA validators

### 1.1 `pallet-validator-set` (@14) — vendor-forked from gautamdhameja, ported to this SDK

Chosen with the owner: **vendor-fork `gautamdhameja/substrate-validator-set`** (a reference pattern,
tracked ~`polkadot-v1.13.0`). Ported to `#[frame_support::pallet]` on frame v46 and **the newer
`pallet-session`** (which gained `Currency` / `KeyDeposit` / `HoldReason` / `DisablingStrategy`):

- `Validators: Vec<ValidatorId>` (the to-be-applied set) + the dormant `OfflineValidators` queue.
- `add_validator` / `remove_validator`, gated by `Config::AddRemoveOrigin`; `remove` refuses to drop
  below `Config::MinAuthorities` (the **hard floor** that stops the operator stranding the chain at
  zero authorities).
- **It is `pallet_session::SessionManager`**: `new_session` returns the current set; `pallet-session`
  queues it one session then enacts it, feeding `pallet-aura`/`pallet-grandpa` via their
  `OneSessionHandler` impls. So **a change is applied at the next-but-one session boundary (~2
  sessions), never mid-session.**
- The im-online auto-removal plumbing (`OfflineValidators` + `ReportOffence`) is ported **dormant**
  (not wired in v1) so adding `pallet-im-online` later (auto-remove a provably-offline authority before
  it crosses the 1/3 GRANDPA-stall line, `L3-chain.md` §8.2) is a runtime-only change.
- Tests: 9 unit (`add`/`remove`/duplicate/min-floor/origin-gate/`SessionManager`) + 2 benchmark-suite.

### 1.2 Runtime wiring (`pallet-session` @15)

```rust
// runtime/src/configs/mod.rs
impl pallet_session::Config for Runtime {
    type ValidatorId      = AccountId;
    type ValidatorIdOf    = pallet_validator_set::ValidatorOf<Runtime>;   // identity
    type ShouldEndSession = pallet_session::PeriodicSessions<SessionPeriod /*10*/, SessionOffset /*0*/>;
    type SessionManager   = ValidatorSet;                                  // the mutable set
    type SessionHandler   = <SessionKeys as OpaqueKeys>::KeyTypeIdProviders; // = (Aura, Grandpa) — the lockstep wire
    type Keys             = SessionKeys;                                    // the existing impl_opaque_keys struct
    type DisablingStrategy = pallet_session::disabling::UpToLimitWithReEnablingDisablingStrategy;
    type Currency         = Balances;
    type KeyDeposit       = ConstU128<0>;   // dev: no deposit; a real testnet sets this > ED
    // …
}
impl pallet_validator_set::Config for Runtime {
    type AddRemoveOrigin = AuthorityOrigin;   // = M5: EnsureRoot OR 3-of-5 FollowerCommittee (DR-07)
    type MinAuthorities  = ConstU32<1>;       // the hard floor (never 0)
}
```

Decisions (made with the owner): **AddRemoveOrigin reuses the M5 `FollowerCommittee`** (one operator
committee governs identity + weight + anchor + validators; the split into a separate validator
committee is a documented graduation step). `SessionPeriod = 10` blocks (~1 min at 6s) is dev-tuned for
a snappy demo — a constant change for a real testnet.

### 1.3 Genesis: authorities now come from the session (not aura/grandpa genesis)

`genesis_config_presets.rs`: dropped the `pallet_aura`/`pallet_grandpa` GenesisConfig (the L3 §8.2
"mutually exclusive" rule — keeping both double-initializes and panics). Instead seat
`SessionConfig.keys = [(account, account, SessionKeys{aura, grandpa})…]` and
`ValidatorSetConfig.initial_validators`. Aura/GRANDPA populate from `SessionHandler::on_genesis_session`.
Dev = 1 authority (`//Alice`); local = 2 (`//Alice`, `//Bob`).

### 1.4 Benchmarked weights (DR-05 discipline) + spec bump

`#[benchmarks]` for `add_validator`/`remove_validator` (`remove` seeds `MinAuthorities+1` first so the
floor check passes and the retain scans the full set). Registered in `define_benchmarks!`; generated
with the stock `frame-weight-template.hbs`: **`add_validator` 11.9M ps (r1 w1)**, **`remove_validator`
11.3M ps (r1 w1)** — wired as `pallet_validator_set::weights::SubstrateWeight<Runtime>` (no placeholder
left). spec_version **105 → 106** (tx_version unchanged).

### 1.5 The newer `set_keys` proof-of-possession (the key gotcha)

This SDK's `impl_opaque_keys`-generated `SessionKeys::ownership_proof_is_valid` requires a **real
proof of possession** — an empty proof is rejected. A new validator onboards by signing, with **each**
session key, the statement `b"POP_" ++ <32-byte account>` (`sp-core::proof_of_possession`), then
SCALE-encoding the tuple `(aura_sig, grandpa_sig)` (= 128 bytes for sr25519+ed25519). The acceptance
constructs this client-side and it is accepted on-chain (see `m6-validators.mjs`).

---

## 2. Track 2 — the committee-driven live stack

### 2.1 Reusable operator tooling (`services/committee/`)

One `@polkadot/api` (dynamic-metadata, no PAPI codegen — auto-exposes the spec-106 pallets) library +
CLIs that generalize the M2/M3 single-purpose sudo drivers:

- **`lib.mjs`** — `viaCommittee` (propose → vote ×k → close), `viaSudo`, and `drive({via})` (default
  `committee`) that prints the **honesty label** on every committee run.
- **`op.mjs`** — drive ANY privileged call: `--call <pallet>.<method> --args '<json>' --via committee|sudo`.
- **`sync-weight.mjs`** — the FOLLOWER's `set_stake` (+ battery prime), committee-driven; live Kupo
  largest-wins mode or dev `--account/--weight` mode (the spec-106 successor to `m2d-sync-weight.mjs`).
- **`run-m6-track1.sh` + `m6-validators.mjs`** — the Track 1 multi-node orchestrator + acceptance.
- **`m6-track2.mjs`** — the Track 2 committee acceptance.

### 2.2 Wiring the services (flag, default committee, honesty label)

- **Follower:** `sync-weight.mjs` drives `set_stake` through the committee by default (`--via sudo`
  fallback).
- **Relayer:** `services/anchor-relayer/relayer.mjs` gained `ANCHOR_VIA` (default `committee`). The
  committee path shells out to `op.mjs` (which works at spec 106 without regenerating the relayer's
  stale PAPI descriptors), keeping ONE audited propose→vote→close codepath; `ANCHOR_VIA=sudo` keeps the
  PAPI sudo fallback. (The relayer additionally needs the Cardano stack + regenerated descriptors to
  run live — both noted in-file.)

### 2.3 The honest D2 framing
Single-operator preprod cannot be true D2 (five independent custody domains). Every committee run is
labelled **"D2-SHAPED, not D2-TRUST"**; `docs/D2-custody-runbook.md` is the checklist to close the gap.

---

## 3. Acceptance (all green)

- **`cargo test`** (plain): anchor 8 · cogno-gate 11 · microblog 18 · talk-stake 6 · **validator-set 9**.
  `--features runtime-benchmarks`: validator-set 11 (incl. `bench_add/remove_validator`).
- **Node builds WITH and WITHOUT `runtime-benchmarks`** (both release builds exit 0).
- **`benchmark pallet`** produced real weights for `add_validator`/`remove_validator` (wired, no
  placeholder).
- **Track 2 live (`--dev`, spec 106):** `m6-track2.mjs` PASSED — the follower's `set_stake`, the
  relayer's `anchor_ack`, AND `add/remove_validator` all executed by a **3-of-5 committee motion**
  (propose → 3 votes → close → `StakeSet`/`AnchorAcked`/`Validator*Initiated`) via
  `EnsureProportionAtLeast<3,5>`, **no sudo on any privileged path**. The follower `sync-weight.mjs`
  and general `op.mjs` both drive `set_stake` through the committee.
- **Track 1 live (multi-node `local`, spec 106):** `run-m6-track1.sh` → `m6-validators.mjs` — see §4.

```
# Track 2:
WS=ws://127.0.0.1:9944 node services/committee/m6-track2.mjs        # against a fresh --dev node
# Track 1:
bash services/committee/run-m6-track1.sh                            # 3-node local network + acceptance
```

---

## 4. Track 1 live result (multi-node) — **PASSED**

3-node `--chain local` network (`run-m6-track1.sh`): **Alice** :9944 + **Bob** :9945 (genesis
authorities) + **Charlie** :9946 (full node, `--charlie` keys, NOT a genesis validator). Genesis
`0x16f3e32d…`, spec 106. Add/remove driven via sudo here (the committee path is proven in Track 2);
the consensus transition is the focus.

```
(0) genesis set [Alice, Bob]: BOTH author (saw Aura indices 0,1); Aura==2 & GRANDPA==2 (lockstep);
    finality advances (GRANDPA needs both).
(1) NEW validator //Charlie:
      · setKeys + a real proof-of-possession (sign "POP_"++account with each key) — ACCEPTED.
      · add_validator(//Charlie) at #11 → ValidatorAdditionInitiated; queued.
      · session boundary → session.validators = [Alice, Bob, Charlie]; Aura==3 & GRANDPA==3 (lockstep);
        GRANDPA set id 0 → 2.
      · //Charlie AUTHORS (saw its Aura index 2; its own node log: "🎁 Prepared block for proposing
        at 57 / 60").
      · finality ADVANCES with the 3-validator set — GRANDPA needs Charlie's votes ⇒ Charlie finalizes too.
(2) remove //Bob:
      · remove_validator(//Bob) → ValidatorRemovalInitiated; queued.
      · session boundary → session.validators = [Alice, Charlie]; Aura==2 & GRANDPA==2; set id 2 → 5.
      · finality STILL advances — NO stall (set never dropped below MinAuthorities=1).
TRACK 1 PASSED  (exit 0)
```

This proves the full mutable-authority lifecycle: a genuinely-new validator onboarded (session keys +
PoP → gated add), activated **only at a session boundary**, **authoring (Aura) AND finalizing (GRANDPA)**
— with finality surviving both the grow and the shrink, and Aura↔GRANDPA staying in lockstep (both sets
move together, set id increments on every change).

---

## 5. Gotchas (recorded)

- **Aura/GRANDPA genesis is mutually exclusive with session genesis.** Keep `pallet_aura`/`pallet_grandpa`
  GenesisConfig AND seat session keys → `initialize_authorities` panics ("already initialized"). Drop
  the aura/grandpa genesis; seat authorities via `SessionConfig` only.
- **`set_keys` needs a real proof-of-possession** (§1.5) — empty proof rejected. Sign `"POP_"++account`
  with each session key; SCALE-tuple the signatures.
- **`MaxAuthorities` lockstep** — Aura & GRANDPA both cap at `ConstU32<32>`; the new set must fit (it
  does; v1 is 1–3). Aura↔GRANDPA follow ONE session schedule, so they never desync (the classic footgun
  of updating one set but not the other is structurally closed).
- **`pkill -f cogno-chain-node` self-kill** — a shell whose own command line contains that string is
  matched and killed. In ad-hoc shells use the `[c]ogno-chain-node` regex trick or kill by captured PID;
  inside the orchestrator script it is safe (the script's cmdline doesn't contain the binary name).
- **`--tmp --validator` needs `--unsafe-force-node-key-generation`** (a validator won't auto-generate an
  ephemeral network identity otherwise: `NetworkKeyNotFound`).
- **A 2-of-2 `local` chain needs BOTH nodes** to finalize (GRANDPA > 2/3 of 2). A solo node authors but
  finality stalls — start the peer before asserting finality.
- **PAPI descriptors stale at spec 106** — the M6 tooling uses `@polkadot/api` (dynamic metadata) in
  `services/committee/` (node_modules symlinked to `../indexer/node_modules`), the same technique as the
  M5 acceptance. Regen PAPI for `app/` clients with `rm .papi/descriptors/generated.json && papi`.
- **A fresh spec rebuild changes genesis** (new pallets + new genesis state root) — fetch genesis live,
  never hardcode.

---

## 6. Where M6 lives

- **Pallet:** `pallets/validator-set/` (lib/weights/benchmarking/mock/tests) + workspace `Cargo.toml`.
- **Runtime:** `runtime/src/lib.rs` (ValidatorSet @14, Session @15, spec 106), `runtime/src/configs/mod.rs`
  (session + validator-set Config), `runtime/src/genesis_config_presets.rs` (SessionConfig seating),
  `runtime/src/benchmarks.rs`, `runtime/Cargo.toml`.
- **Tooling + live acceptance:** `services/committee/` (lib/op/sync-weight/m6-track2/m6-validators/
  run-m6-track1.sh); `services/anchor-relayer/relayer.mjs` (`ANCHOR_VIA`).
- **Docs:** this file, `docs/L3-SPO-graduation.md`, `docs/D2-custody-runbook.md`.
