# Removing the population ceiling

cogno has an upper bound on how many people it can serve correctly. Past it the chain does not slow
down or reject work — it silently computes wrong answers and freezes some of them permanently. That is
a design defect independent of whether anyone expects to reach it, and removing it is the point of this
plan.

The proposed mechanism was a cursor: read a range of Cardano blocks each block instead of a snapshot, so
per-block cost tracks churn rather than headcount. The measurements say that mechanism is aimed at the
wrong target. The db-sync read is barely proportional to cogno's population at all; what it *is*
proportional to is Cardano's own history and the vault address's cumulative UTxO count, neither of which
a population-scoped cursor addresses. Meanwhile the actual ceilings are all on-chain, and none of them
is fixed by changing what SQL runs.

So: the goal is right and the mechanism is wrong. This document records what was measured, names every
ceiling, and gives the fix for each.

**The rule that removes a ceiling.** Every bound in the system must bound **work per block**, never
**population** — and wherever a bound truncates a set, coverage must be provably eventually complete.
A bound on per-block work is correct and necessary; a 6 s block with a 2 s compute budget cannot do
unbounded work. A bound on population is the defect. Most of what follows is applying that one
distinction, because today the system repeatedly does the second where it meant the first.

Everything here was taken against the live preprod db-sync (34 GB, tip epoch 304) and the live chain at
spec 217.

## The numbers

All timings are the median of three runs after a discarded warm-up, driven through server-side
prepared statements with `plan_cache_mode = force_custom_plan` so the planner sees what
`tokio-postgres` makes it see. The four SQL constants were extracted verbatim from
`cogno-dbsync/src/dbsync.rs` rather than retyped.

### What a block costs today

At the live population — 13 bound stake credentials, 3 claimed role credentials, 20 historical vault
UTxOs — the four consensus reads cost:

| Query | median |
|---|---|
| `OBSERVATION_SQL` (vault) | 4.7–7.9 ms |
| `STAKE_OBSERVATION_SQL` | 59.8–64.0 ms |
| `ROLE_OBSERVATION_SQL` | **306–310 ms** |
| `POOL_STAKE_SQL` | 4.3 ms |
| **total per cogno block** | **~383 ms** |

The role read is 81% of it, and roughly 200 ms of that single query is one thing: a parallel sequential
scan of the whole `tx_metadata` table (1.64 M rows, 2.28 GB) to find label-867 registrations. There is
no index on `tx_metadata.key`. That scan runs on every node on every block and its cost grows with
**Cardano's transaction history**, not with anything cogno does.

The stake read has the same shape for the same reason: `substring(sa.hash_raw from 2 for 28) = ANY(...)`
has no functional index behind it, so every block sequential-scans all 541 k rows of `stake_address` to
find 13. `EXPLAIN` shows `Rows Removed by Filter: 188513` per worker across three workers.

### `MaxScanned` is not the cost driver (M1)

`MaxScanned` bounds the size of the credential array handed to db-sync. The stated reason for pinning it
at 1024 is in the pallet's own `Config` doc: an unbounded scan is "a free way to enlarge every node's
per-block work until the db-sync query blows its timeout". Sweeping that array size:

| credentials scoped (N) | stake | role | pool | scoped total |
|---|---|---|---|---|
| 13 *(live today)* | 64.0 | 310 | 4.3 | 378 ms |
| 128 | 91.5 | 336 | 10.3 | 437 ms |
| **1 024** *(`MaxScanned`)* | 118 | 370 | 15.7 | **503 ms** |
| 4 096 | 125 | 403 | 24.6 | 553 ms |
| **8 640** *(`MAX_SCANNED_CEILING`)* | 189 | 431 | 39.1 | **659 ms** |
| 32 768 | 390 | 612 | 109 | 1 111 ms |
| 131 072 | 872 | 1 334 | 372 | 2 578 ms |

Going from today's 13 credentials to the compile-time ceiling of 8 640 — a factor of 665 — takes the
scoped cost from 378 ms to 659 ms. **No individual query reaches its own 2 s `DBSYNC_TIMEOUT` until
N ≈ 130 000**, which is 127× past `MaxScanned` and 15× past the ceiling that `close_poll`'s weight
declaration already enforces.

So the constant was sized against a constraint it barely touches. The 8.4× headroom between 1 024 and
8 640 is available today as a one-line change, and the db-sync cost at the top of that range is
comfortable.

### The vault axis is the one with no cap, and it ratchets

The vault set is discovered by `tx_out.payment_cred = <script hash>` with no credential array and no cap.
Its driving scan has no spentness predicate — spentness is a *returned column* that `observe_as_of`
filters in Rust — so the query walks every UTxO ever created at the vault address. `EXPLAIN` confirms one
`ma_tx_out` index probe per row (`Index Scan using idx_ma_tx_out_tx_out_id … loops=39980`).

Measured against preprod script addresses at known historical-UTxO counts, using the production query
shape:

| historical UTxOs at the address | median |
|---|---|
| 20 *(cogno's live vault)* | 7.9 ms |
| 2 002 | 21.2 ms |
| 9 988 | 22.2 ms |
| 19 985 | 71.3 ms |
| 39 980 | 167.0 ms |
| 80 135 | 1 259 ms |
| 636 262 | 1 256 ms |

> **RETAKEN 2026-08-02, and the top of this table was wrong.** The plateau is the tell: 80 135 and
> 636 262 are 8× apart in rows and identical in time, which is not data locality, it is a measurement
> artifact. Re-measured with server-side `EXPLAIN ANALYZE` (client-independent, so no harness can
> flatter it) the curve is monotone and roughly linear at ~20.6 µs per historical row:
>
> | historical UTxOs | today | with the B′2 predicate |
> |---|---|---|
> | 20 *(live vault)* | ~13 ms *(incl. ~10 ms client overhead)* | ~13 ms |
> | 260 935 | 5 302 ms | 3 873 ms |
> | 277 289 | 5 750 ms | 4 480 ms |
> | 636 262 | 13 265 ms | 10 698 ms |
>
> The instrument was calibrated against this document's own other numbers and agrees with them: the
> `tx_metadata` scan re-measures at 224–234 ms against 197.6 ms, and `STAKE_OBSERVATION_SQL` at
> 64/93/154 ms against 64/118/189 ms for N = 13/1 024/8 640. Only the vault row moved, and it moved
> ~10×. **The 2 s `DBSYNC_TIMEOUT` is crossed at roughly 97 000 cumulative vault UTxOs, not in the low
> hundreds of thousands** — the ratchet is about 3× nearer than this document said.
>
> One operational finding dwarfs every code change on this axis: the db-sync Postgres runs
> `shared_buffers = 128MB` and `work_mem = 4MB` against a 34 GB database — stock defaults, untuned.
> The 636 k case reads ~570 MB of heap (`Heap Blocks: exact=38161 lossy=34292`) that cannot stay
> cached, and three consecutive runs never warmed. Raising `shared_buffers` is a config line that moves
> every number in this document, and it should be tried before any of C4's engineering.

The important property is that **this never shrinks**. Every lock ever made leaves a permanent row.
Unlocking does not help. Ten thousand users who each lock once cost ~22 ms; ten thousand users who
adjust their lock forty times over the chain's life cost ~2 s and the observation abstains for ever.

### What a churn-scoped read costs instead (M2)

| read | today | churn-scoped | ratio |
|---|---|---|---|
| label-867 registrations | 197.6 ms *(full history)* | **0.9 ms** *(1 k-id cursor window)* | 220× |
| — | | 25.9 ms *(100 k ids ≈ a stability window)* | |
| vault, at a 636 k-UTxO address | 1 256 ms | **1.2 ms** *(600-slot window)* | ~1 000× |

The vault result carries a finding worth stating plainly, because it inverts an assumption I started
with: adding a slot **lower** bound is sufficient. Postgres then drives off `idx_block_slot_no` and joins
down, and the payment-cred-driven and block-range-driven forms come out within noise of each other
(1.2 ms vs 1.1 ms at a 600-slot window). **The difficulty in Lane B is entirely consensus design. None
of it is query engineering.**

One "obvious" fix is a trap. Replacing the un-indexed `substring(hash_raw …)` predicate with full
`hash_raw` equality over the four possible reward-address header bytes hits `unique_stake_address` and is
16× faster at today's population — and 2.7× *slower* at 32 768, because 4N index probes cost more than
one sequential scan once N gets large. The crossover is around N ≈ 1 000–2 000.

| N | `substring` scan | full-`hash_raw` index | |
|---|---|---|---|
| 13 | 69.0 ms | **4.3 ms** | 16.0× faster |
| 1 024 | 101.5 ms | 79.5 ms | 1.3× faster |
| 8 640 | 165.2 ms | 296.6 ms | 1.8× slower |
| 32 768 | 339.8 ms | 933.9 ms | 2.7× slower |

### Targets (M3)

"10 k users or more", turned into numbers against the real weights:

- **Posting fits with enormous margin.** A block affords 874 `post_message` extrinsics (145.7/s) once
  you budget the *charged* weight — call 0.954 ms + `TxExtension` 0.654 ms + `base_extrinsic` 0.108 ms
  = 1.716 ms. Ten thousand users at five posts a day demand 3.47 posts per block: **0.40% of the Normal
  budget**. Weight binds about 7× before block length does.
- **Storage fits.** 10 k identities ≈ 26 MB, 500 k posts ≈ 278 MB, ~304 MB of leaf data total
  (~0.6–0.9 GB with trie overhead). Posts dominate people 11:1.
- **The economics does not bind.** 10 k floor-lockers at their maximum sustained rate is 333 posts per
  block, 38% of the ceiling. But it only holds near the floor: at the 100 000-ADA knee, 27 accounts
  saturate a block.
- **Cardano churn is nowhere near the paging bound.** At ~20 s Cardano blocks a cogno block spans 0.3 of
  one. At 10 k lockers with 5%/month turnover that is ~0.0012 vault changes per cogno block, against
  `MaxChangesPerBlock` of 256. Five orders of magnitude of headroom.
- **Two targets are genuinely unreachable.** Ten thousand *observed* credentials cannot be reached by
  moving a constant: `MAX_SCANNED_CEILING` is 8 640 (exact bound 8 661) and is a compile-time assert,
  because `close_poll` declares six DB reads per observed account and at 10 000 would declare 1 500.7 ms
  against the 1 299.89 ms a single Normal extrinsic may declare. And "10 k users each holding a role
  badge" is not reachable at all without paging that tally first.

Two load-bearing numbers in the repo's own comments are wrong and should be corrected in passing:
`configs/mod.rs:1114` states ~1 586 posts per block (real: 874 — it divides by call weight and forgets
the extension and base), and `configs/mod.rs:1561` states the `TxExtension` weight is ~0.17 ms (real:
0.654 ms; `CheckCapacity` is only 25% of it). Neither breaks a safety assert, but both will mislead
anyone sizing throughput.

## What is actually `O(population)`

Not the SQL. The three basis walks in `derive_call`:

```
for (beacon,  _) in LastObserved::iter()       { if !desired.contains_key(&beacon)  { push (beacon,  None) } }
for (cred,    _) in LastObservedStake::iter()  { if !vp_desired.contains_key(&cred) { push (cred,    None) } }
for (account, _) in LastObservedRoles::iter()  { if !role_desired.contains_key(..)  { push (account, None) } }
```

`derive_call` runs inside `create_inherent` on the author and again inside `check_inherent` on every
importer, every block, in wasm. The pallet documents the cost honestly at `lib.rs:1378`, and it is not
weighed — it is wall-clock on the block-building and import paths, invisible to `spec_version`-style
reasoning because it never appears in a weight.

It is worse than three walks. The two scoping runtime APIs walk the bases five more times per block:
`pinned_stake_credentials` walks `LastObservedStake` once and `LastObservedRoles` once,
`pinned_role_credentials` walks `LastObservedRoles` three more times (once per `RoleKind`). Seven full
basis walks per block per node, before the db-sync read starts.

Only one of the three bases is genuinely unbounded. `LastObservedStake` settles at ≤ `MaxScanned` rows
and `LastObservedRoles` at a small multiple of it, because a row can only be written for a credential
that was in a capped scan. **`LastObserved` — the vault basis — has no cap.** At 10 k lockers that is
10 k trie reads per block per node in `derive_call` plus a 10 k-entry `BTreeMap` built in the wasm heap;
priced at the runtime's own 25 µs accounting weight for a read, the three passes over that axis are
~750 ms. Real warm trie reads are faster than the accounting figure, so treat 750 ms as the pessimistic
end of a 30–750 ms band — but the shape is the point, and at 100 k it is fatal at either end.

## Every ceiling, and what removes it

This is the core of the plan. Each row is a place where a bound landed on population instead of on work.
"Correctness" means the chain returns a wrong answer rather than a slow one.

| # | Ceiling | Bites at | Failure | Fix |
|---|---|---|---|---|
| 1 | **`close_poll`'s declared weight.** It declares `6 × MaxObservedAccounts` reads; past the ceiling `CheckWeight` rejects it at *pool validation*, so it is unincludable for ever and no poll can be finalized on a sudo-free chain. | 8 640 observed accounts, compile-time asserted | **Correctness / brick** | **C1 — accumulating paged tally.** The structural fix; everything else about `MaxScanned` is downstream of it. |
| 2 | **Silent tally truncation.** `ObservedStakers::stakers` and `ChamberRolesProvider::role_holders` `.take(MaxScanned)` a hash-ordered iteration with no log, no event, no signal. `close_poll` freezes the result into `PollResult` permanently, with no correction path short of a governed migration. | `MaxScanned` = 1 024 (role axis reaches ~4× that, so it bites first) | **Correctness / permanent** | Same as C1. Once the tally pages, these become paged enumerations rather than truncations. |
| 3 | **The credential scan cap.** A credential past `MaxScanned` is not scanned, so it is not observed: no voting power, no role badge, silently. | 1 024, reachable adversarially in ~3 blocks for free | **Correctness / silent** | **C2 — rotate, don't truncate.** |
| 4 | **`derive_call`'s basis walks.** Three full walks per block on author and importer, plus five more from the pin helpers. Unweighed, so no runtime guard sees it. Only the vault basis is genuinely uncapped. | low tens of thousands of lockers | Degradation, then slot-skip | **C3 — scope-aware `derive_call`.** Prerequisite for C2. |
| 5 | **The vault read's cumulative history.** No spentness predicate on the driving scan, so it walks every UTxO ever created at the vault address. Never shrinks; unlocking does not help. | low 10⁵ cumulative UTxOs | Freeze (fail-closed abstain) | **C4 — spentness predicate**, then incremental live-set state. |
| 6 | **`staker_weights()` per read.** Rebuilt on every feed, thread, profile, search and poll `state_call`; `enrich` then probes each staker per post on the page. | scales with whatever `MaxScanned` is raised to | Node degradation | **C5 — tally by voters, not by population.** |
| 7 | **The `tx_metadata` full-history scan.** Grows with Cardano, not with cogno. | already 200 ms on preprod; mainnet is far larger | Freeze (timeout) | **C6 — bound it by a registration-id cursor.** |

Two of these are hard ceilings on *correctness* (1, 2), one is a silent correctness ceiling (3), and the
rest are performance ceilings that eventually become liveness ones. The first three are what make the
statement "the chain stops working correctly if it gets popular" literally true today, and they are all
downstream of one design decision: **the poll tally walks the population**.

### C1 — the paged tally is the keystone

`close_poll` declares `6 × MaxObservedAccounts` DB reads. That declaration is the only thing in FRAME
that mechanically checks `MaxScanned`, and it is what pins the ceiling at 8 640. Page the tally and the
declaration becomes `O(page)`, so `MaxScanned` stops being a bound on how many people can be tallied
correctly and becomes a work-per-block knob. Nothing else on this list unblocks without it.

> **Correction, 2026-08-03: the two `.take(cap)`s STAY, and B′0 removes only half of ceiling 2.** An
> earlier draft of this paragraph said the truncations "become paged enumerations". They cannot. Neither
> `ObservedStakers::stakers` nor `ChamberRolesProvider::role_holders` returns a cursor, and between them
> they are the sole bound on **twelve unmetered `staker_weights()` read paths** (`lib.rs:3411, 3425, 3522,
> 3534, 3599, 3681, 3739, 3791, 3912` plus `runtime/src/apis.rs:474, 561, 622`) and on `poll()`'s own
> chamber walk. Nothing pages those, and nothing weighs them either — they are `state_call` reads.
>
> So after B′0: **ceiling 1 is gone outright** (the declaration no longer contains `MaxObservedAccounts`)
> and **ceiling 2 is half gone** — the frozen `PollResult` is computed over the complete voter set and
> stops being a truncated snapshot, but the LIVE `poll()` read still joins over a `.take(cap)` subset
> while the poll is open. The two can therefore disagree at the cap, with the frozen one being the
> correct one. Closing that gap is B′6 (C5), not this item.
>
> `MaxObservedAccounts` survives as a read-path budget with no weight declaration referencing it. That
> means `MAX_SCANNED_CEILING` must be **re-pointed, not deleted** — see B′4.

It is a three-part change: a resumable cursor plus partial accumulator in microblog, an `O(page)` weight
declaration, and a decision about what a poll's state is between the first and last page (it is currently
atomic — one call, one insert, idempotent thereafter). The third part is the real design question, and it
has a sharp sub-question: `VotingPower` is written by the observer, so a tally that spans blocks can see
weights move mid-count. Either snapshot the weights at close-start or define the tally as "as of the block
each page ran"; pick deliberately and write down which.

#### The two decisions, taken 2026-08-03

**A poll between the first and last page is exactly what it is today: past its deadline, not yet
finalized.** `close_poll` stays ONE call at index 13. It resumes from a storage cursor and writes
`PollResults` only on the terminal page; reads keep serving the live join from `poll()`'s open branch and
`finalized` stays false until the last page lands. No new call index, no new wire state, no fourth poll
state for the frontend to render.

The fact that makes this safe is worth stating because it is not obvious: **the vote set is already frozen
before the first page can run.** `cast_poll_vote` rejects at `now >= close_at`
(`pallets/microblog/src/lib.rs:1980-1983`), `close_poll` is callable only from that same instant, and
nothing anywhere removes a `PollVotes` row (`on_revoke` touches only `dec_providers` and the capacity row).
So a cursor walks a set that cannot change underneath it — no double-count, no missed voter, no
iterator-invalidation reasoning required. Only weights move, which is the other decision.

Three constraints ride along. The cursor lives in **storage, never in a call argument** — an argument
would move `transaction_version` 8 → 9 and open a resubmit-page-*k* replay that the flat `VoteCost` would
buy unbounded repeats of. A page that advances no cursor **refunds to `base`** (a sixth exit path), or a
flat `VoteCost` buys unlimited pages. And the accumulator is reclaimed on the terminal page, with
`try_state` taught the invariant — no host may hold both a cursor row and a `PollResults` row.

**The tally is "as of the block each page ran", guarded so that in practice it is single-block
equivalent.** A literal snapshot is not implementable: writing N weight rows at page 0 costs 100 µs each
against 25 µs to read them, so it is strictly worse than the work paging exists to remove, and there is no
consensus-visible epoch to pin instead (the target epoch is resolved inside Postgres and the observation
carries no epoch field). A per-voter capture at count time is not a third option — it *is* "as of the block
that page ran" for that voter, so on its own it only names the smear.

So the tally is defined as as-of-each-page, and the chain is made to **say when that mattered**: a monotone
counter per axis, bumped only when a write actually CHANGES a value, recorded at page 0 and re-checked on
every page. A close that never sees either counter move is byte-identical to the single-block tally it
replaced — and the overwhelming majority are, because both writers already short-circuit on unchanged
values (`pallets/talk-stake/src/lib.rs:154-155`, `pallets/cardano-observer/src/lib.rs:1463-1468`) and the
stake axis is epoch-quantized, so the counter is still for ~72 000 consecutive blocks at a time. A close
that does see movement finalizes anyway and emits `PollTallySmeared`. The absence of that event is the
positive signal.

Two things the guard has to get right. It must cover **every writer of the tally's inputs, not just
`observe`** — `purge_account_roles` removes `ObservedRoles` rows and is reached from the committee's
`revoke`/`revoke_many`, which is an ordinary extrinsic. And it **splits per axis**: a `Stake`-kind poll
never reads `ObservedRoles`, so a role observation must not mark a stake-only tally as smeared. Two
`StorageValue`s.

> **Changed during implementation, and worth recording why.** The first design had the guard RESTART the
> tally on movement, which buys exact single-block semantics rather than a reported smear. It was dropped
> after costing it. A restart has to discard the chamber scratch rows, and that wipe is itself
> `O(distinct ids)` — so it needs its own paging, or a generation number in the key, and generations leak
> orphaned rows that nothing reclaims. Worse, it reintroduces the failure this whole plan exists to
> remove: at a Cardano epoch boundary the observer's backlog drains at `MaxChangesPerBlock` for up to ~34
> consecutive blocks, so a close needing more pages than the quiet window between drains would restart for
> ever and the poll could never be finalized. That is ceiling 1 rebuilt in a new place. Bounding the
> restarts fixes the livelock but then falls back to a smear anyway — the same outcome as reporting it,
> after a great deal more machinery. A complete result that says it is smeared beats a poll that cannot
> close.

`PollResult.closed_at` is redefined as the block the LAST page ran. The close-start block stays in the
cursor row rather than moving into `PollResult`, which would re-encode the struct and pull in a migration
for nothing.

There is also a cheaper structural win hiding here, worth taking either way. `poll_option_weights`
iterates the **staker set** and asks `PollVotes::get(host_id, who)` per staker — walking the whole
population to discover a set that is usually tiny. But `PollVotes` is a `StorageDoubleMap` keyed
`(host_id, account)`, so `iter_key_prefix(host_id)` enumerates exactly the voters. Tallying by voters is
never worse and usually orders of magnitude better: 2 reads per voter against 3 per staker, over a set
that is usually tiny instead of population-sized.

> **Corrected 2026-08-03 on three counts.**
>
> **It is not independent, and it must not ship first.** The staker and holder sets are `.take(cap)`
> bounded; the voter set is not — `cast_poll_vote` gates on identity only, is feeless and flat-priced. So
> swapping the axis under today's fixed `6 × MaxObservedAccounts` declaration replaces a bounded join with
> an unbounded one, and FRAME **clamps an over-running refund rather than erroring**
> (`frame-support-48.0.0/src/dispatch.rs:325-338` logs and truncates to the declared total), so the block
> is silently under-charged instead of the call failing. It lands INSIDE the paging or not at all.
>
> **It changes the numeric answer, and that is the point.** At and above the cap the two axes disagree —
> which is ceiling 2 being fixed, not a free optimisation. Say so in the commit rather than filing it as a
> refactor.
>
> **The comment at `lib.rs:174-180` does name polls.** The claim that it is about per-*post* tallies only
> was wrong. What it rejects is a *truncated* hash-ordered voter prefix — so complete-or-nothing
> accumulation is a hard requirement of the paged design, not a nicety, and a page that cannot finish must
> leave no partial result readable.
>
> One latent hazard the switch exposes: nothing ever removes a `VotingPower` row, and `unlink_stake` /
> `do_revoke` deliberately do not zero one (`pallets/cogno-gate/src/lib.rs:523-525` — the observer clears
> it next block). Staker-iteration cannot see the stale row, because the basis row disappears in the same
> inherent. Voter-iteration reads `VotingPower` directly and WILL count it, for as long as the observer is
> frozen or stalled. Zero it at the two teardown sites, or intersect the voter walk against the basis.

The chamber lens is the harder half, and for a different reason than this document originally gave.

> **There is no whole-chamber denominator, and one should not be built.** The claim that "a chamber tally
> needs the whole chamber as a denominator" describes a feature that does not exist. Every percentage on
> every surface is a share of *cast* weight (`app/src/components/PollCard.tsx:149-152`, `:363`, `:378`;
> `app/src/lib/cardano/governance.ts:102-106` divides by `yes + no`). So there is nothing for paging to
> break, and the maintained running aggregate is not needed. If one is ever wanted, note that a scalar is
> WRONG for the SPO chamber — pool ids dedup across co-owners — so it would need a
> `pool_id → (weight, holder_count)` map maintained inside the consensus fan-out, which is a bigger change
> than B′0 itself.
>
> What IS hard about the chamber lens is the conflict rule. `poll_chamber_weights` drops a conflicted
> pool's weight *and* its count only after the whole loop has run, so a later page must be able to RETRACT
> an earlier page's contribution — which per-option running sums cannot express. The minimum
> provably-equivalent cross-page accumulator is a per-pool map merged as
> `(o_a, w_a, c_a) ⊕ (o_b, w_b, c_b) = (o_a, w_a, c_a ∨ c_b ∨ o_a ≠ o_b)`. Note that OR-ing the two flags
> alone is wrong: the merge has to compare the stored options. It must be a `StorageDoubleMap` keyed
> `(host_id, pool_id)` drained key by key, NOT one `BoundedBTreeMap` value — a whole-blob re-read and
> re-encode per page is exactly the shape spec 215 abandoned, and a declared `MaxEncodedLen` on it would
> be a fresh silent truncation of precisely the kind this item exists to remove.
>
> The dRep half has its own trap: per-option sums suffice only under 1:1 drep↔account, and 1:1 is an
> invariant of the CLAIM ledger, not of `ObservedRoles`. The role axis pages at 256, so mid-drain two
> accounts can carry the same dRep id, where a paged per-option sum double-counts what today's
> `or_insert` counts once. Carry a seen-set.
>
> Consequence: B′0 is a **three-phase machine** — voter walk, chamber collect, chamber drain — because the
> final fold over the per-pool map is itself O(distinct pools) and needs its own cursor. Not one cursor.

### C2 — rotate, don't truncate

The scan cap exists because `link_stake_signed` and `claim_role_signed` are free, so an uncapped scan is
an uncapped free cost. That reasoning is sound; the implementation is what is wrong. Today the scan takes
a **hash-ordered prefix** and everything past it is simply never observed — and because `derive_call`
reads absence as "cleared", it is not merely unobserved but actively zeroed.

The fix is already designed, in prose, at `pallets/cogno-gate/src/lib.rs:503`: a deterministic rotating
window over the uncredited remainder. Per-block work stays bounded at the window size; coverage becomes
complete within a bounded number of blocks. That is the difference between a bound on work and a bound on
population, and it is the whole ceiling.

Its stated prerequisites are exactly C3 (`derive_call` must know the scanned scope, or it clears every
out-of-window row and oscillates), plus pinning `SpoOwner` credentials into the stake window rather than a
role one, plus reworking the backlog contract and the `over_scan_cap` alarm around a moving scope. Scope
C2 and C3 as one piece of work. The ordering must be a pure function of parent state — `check_inherent`
byte-compares the derived delta — and it must not be a grindable `Blake2_128Concat` walk, which is the
part spec 217 explicitly did **not** fix.

## The performance cliffs, in the order growth reaches them

Separately from the correctness ceilings above, the order in which cost bites. The brief's ordering was
`MaxScanned` → db-sync timeout → `close_poll`. The measurements reorder it:

1. **`derive_call`'s vault-basis walk.** The only unbounded basis, on every node, twice per block,
   unweighed. Bites in the low tens of thousands of lockers.
2. **The vault SQL's missing spentness filter.** `O(every vault output ever created)`, monotone, never
   shrinks. Reaches ~60% of its timeout in the low hundreds of thousands of cumulative UTxOs.
3. **The four sequential 2 s timeouts inside a ~4 s proposing window.** `block_proposal_slot_portion` is
   2/3 of a 6 s slot; the four reads are awaited in sequence with independent 2 s budgets, so the worst
   case is 8 s against a ~4 s window. On expiry `sc-consensus-slots` returns `None` and **the producer
   skips the slot entirely** — no block, not a degraded one. Today's 383 ms is comfortable; there is no
   partial-read path if it stops being.
4. **`close_poll`'s declared weight at 8 640.** The real `MaxScanned` brick, compile-time asserted.
5. **The `tx_metadata` full-history scan.** Not population at all — it grows with Cardano. On preprod it
   is 200 ms today. Mainnet's `tx_metadata` is far larger (label-721 NFT metadata dominates it), so this
   is the one term that could be a *mainnet-day-one* problem rather than a growth problem.

## Corrections to the brief

Things I was asked to verify that turned out otherwise. Each of these changes a plan decision.

- **`MaxScanned` and `MAX_SCANNED_CEILING` do not get deleted by a cursor.** `MaxObservedAccounts` is an
  alias of `MaxScanned` and bounds `close_poll`'s declared weight plus two `.take(cap)` tally joins —
  work that never touches db-sync. The compile-time assert would fail the build. The B8 inventory needs
  splitting in two: the *read-scoping* machinery (`bound_stake_credentials_capped`, `claimed_credentials`,
  the two `pinned_*` helpers, `BoundStakeCreds`/`BoundRoleCreds`, the two runtime-API methods,
  `ObserverConfig::max_scanned`, the node alarm, two gauges and a counter, two alert rules, two Grafana
  panels, the eight `fair_scan_tests`) versus the *on-chain* machinery, which survives untouched.
- **The enumerate-and-scope pattern survives regardless.** `epoch_stake`, `drep_distr` and
  `epoch_stake`-by-pool are per-epoch snapshot tables selected on `epoch_no = target` with no slot
  predicate anywhere. There is nothing for a block-range cursor to advance over. Three of the four reads
  are epoch-quantized: byte-identical for ~72 000 consecutive cogno blocks, then potentially
  population-sized change in one block when the reference crosses an epoch boundary.
- **`close_poll` contains no `.take()`.** The truncation is in the runtime's provider impls
  (`ObservedStakers::stakers`, `ChamberRolesProvider::role_holders`), and both read the observer's
  `Config::MaxScanned` directly rather than through the microblog alias. Removing those `.take`s without
  changing `close_poll`'s weight declaration makes it under-declare and overrun a block.
- **The role-axis truncation bites first and is reachable through a *read*, not just `close_poll`.**
  `ObservedRoles` can reach ~4× `MaxScanned` (three independently-capped role scans plus the SpoOwner
  path riding the stake scan). And `role_holders()` has two callers: `close_poll`, which guards it with
  `total > 0 && kind.has_chambers()`, and the live `poll()` read API, which guards it with
  `kind.has_chambers()` alone. An open governance poll with zero votes pays the full walk on every
  unmetered `state_call` — the read path is strictly more expensive than the dispatch it is compared
  against, and it is missing a short-circuit `close_poll` already has.
- **A beacon is not 1:1 with a UTxO.** The mint validator has no one-shot and never inspects inputs, so
  the same beacon can be minted again while the first vault UTxO is live, at 100 ADA a copy. That is
  exactly why largest-wins exists. But **only the beacon's own owner can grow its live-UTxO count** —
  the mint arm requires the owner's payment vkey in `extra_signatories` — so this is a self-inflicted
  footgun, never a third-party griefing vector.
- **The grief vector is real and understated.** All three calls are `ensure_none`; a `Preamble::Bare`
  extrinsic runs *no* transaction extensions at all, so there is no nonce, no fee, zero extension weight,
  and `CheckCapacity` never sees them. One account fills five credential slots, so ~1 024 accounts
  saturate all four scan budgets in about three blocks (~18 s). Three clauses were wrong: cleanup is one
  motion per *account* (a `revoke` clears identity + stake + all three role claims), `revoke` does **not**
  tombstone role credentials so that axis is a treadmill, and the Committee role axis is deliberately
  excluded from the node's alarm so it floods **completely silently**.
  Two further corrections: tombstones buy nothing, because every attacker credential is a fresh offline
  keypair, so *no* axis converges; and "it is loud" is not a mitigation but a second grief effect — a
  pinned scan makes `ObserverScanCapped` page continuously, which is the exact alert-fatigue failure the
  code cites as its reason for excluding Committee.
- **Roughly half the live ledger is not protected by the spec-217 pin.** `LastObservedStake` rows exist
  only for credentials that came back from the `epoch_stake` query, and there are 7 voting-power rows
  against 13 binds. A bound-but-undelegated key has never been credited, so it is not pinned — it can
  still be *evicted* by a flood, not merely denied. Any claim that "the live population is safe post-217"
  is wrong.
- **Spec 217 did not fix hash-ordered selection.** It added a pin protecting *already-credited*
  credentials. The uncredited remainder is still a raw `Blake2_128Concat` hash-ordered walk, grindable
  offline, and the code says so.
- **`pallet-utility` is not in the runtime** (indices run 0–20, next free 21), so there is no `batch`.
  Lane A1 is genuinely needed.
- **The frontend does call `observer_config()`** (`app/src/lib/chain/observer.ts:47`), destructuring four
  fields to drive the lock-to-credit copy and `usePendingCapacity`. Removing `max_scanned` from that
  struct is a real lockstep FE deploy, not a formality.
- **`claimed_committee` is Phase C scaffolding, not vestigial** — `RoleKind::Committee` is claimable
  today, so deleting the enumeration means those claims could never be confirmed until it is re-added,
  at the cost of a second spec bump.
- **The live committee is one seat with a threshold of one**, so a motion is a single extrinsic today,
  not five. That changes as it federates to 3-of-5, where `pallet-collective` 49 does *not* record the
  proposer's aye — so a motion becomes propose + 3 votes + close.
- The try-runtime rate-limit trap **is** documented, at `docs/UPGRADES.md:156-164`. It is not tribal
  knowledge.

## Lane A — near term, independent, ship first

Both items are small, neither depends on anything below, and together they close the free-grief vector
and give the committee a way to clean up after it.

### A1. `revoke_many` — a bounded, skip-not-fail batch revoke

There is no `pallet-utility`, and adding one is worse than two typed calls: `batch_all` dispatches inner
calls, and `CognoCallFilter`'s `set_members` brick-guard is a `Contains<RuntimeCall>` check FRAME applies
to the *outer* call, so a generic batch is a filter-bypass surface unless `Utility`'s own `Config`
re-filters. It also costs a new pallet index and far more surface than needed.

Build instead: `CognoGate::revoke_many(BoundedVec<AccountId, MaxBatchTargets>)` and
`CardanoRoles::revoke_role_many(BoundedVec<(AccountId, RoleKind), MaxBatchTargets>)`.

Three things decide the design:

**Skip, do not fail.** Both `revoke` and `revoke_role` return `Err` on a missing target, FRAME wraps
every dispatchable in `with_storage_layer`, and `pallet_collective::do_approve_proposal` *swallows* the
dispatch error into an `Event::Executed { result: Err(..) }` while `close` still returns `Ok`. A naive
`for target in targets { do_revoke(target)? }` therefore produces: motion approved, motion executed,
motion removed, **zero state change, and no extrinsic-level failure anywhere**. Emit
`{ applied, skipped }` instead. `governance_fuel::revoke` is the in-repo precedent for an idempotent
revoke verb.

**The bound is `MaxProposalWeight`, not the class `max_extrinsic`.** `pallet-collective` checks
`proposal.get_dispatch_info().call_weight.all_lte(MaxProposalWeight)` at *both* propose and close, and
`MaxProposalWeight` is 1.0 s — below Normal's 1.29989 s and Operational's 1.79989 s. So do **not** reuse
`max_normal_extrinsic_ref_time()` from `close_poll_ceiling_tests`; that module's *shape* is reusable, its
inputs are not. At the real weights the ceilings are **623** targets for an identity revoke
(1.604 ms each — 29.1 µs benchmarked plus the hand-written `reads_writes(4, 10)` addend covering the
stake teardown and `on_revoke` fan-out, which is 1.1 of the 1.6 ms and must be reproduced *per target*)
and **2 857** for a role revoke (0.35 ms each, a hand-written placeholder — `pallet-cardano-roles` has no
benchmarking module at all).

Pick a bound of 64. That is 5× the entire live chain and leaves ~10× weight headroom under the ceiling,
the same relationship `MaxScanned = 1024` has to `MAX_SCANNED_CEILING = 8640`. `ProposalOf` stores the
whole encoded call with `MaxProposals = 100` and no proposal deposit, so a large bound multiplies
worst-case committee state for no benefit.

**Copy `observe`'s shape.** It is the only list-taking dispatchable in the repo: `BoundedVec` arguments,
`WeightInfo::batch(len as u32)`, a `Linear<0, MAX_BATCH>` benchmark off a single named const, and a
runtime assert inside the benchmark body tying that const to the `Config` type (a `Linear` bound is a
const generic the compiler cannot tie to `Config`). Return `DispatchResultWithPostInfo` and refund the
skipped targets — `close_poll` is the in-repo precedent.

Also worth doing here, since it is the same file: **`unlink_stake`**. There is no such call. A stake bind
is permanent and irrevocable except by a committee `revoke` that also permanently tombstones the identity.
A self-service, feeless-if-you-hold-it `unlink_stake` mirroring `unclaim_role` gives `AccountOfStakeCred`
a shrink path it has never had, lets legitimate users free their own slot, and gives an attacker nothing.

Spec 218, `transaction_version` stays 8 (new calls do not move it). New call indices: cogno-gate next free
is 4, cardano-roles next free is 3. Pin any new `Event`/`Error` variant with an explicit `#[codec(index)]`.
No storage migration. Needs `./scripts/check-metadata.sh --write`, a PAPI regen against a **local dev
node**, and a `DESCRIPTOR_SPEC_VERSION` bump. CLI work is part of the lane; `close_weight_bound()` needs
no change because it already returns `MaxProposalWeight`.

### A2. Pricing the two unsigned calls — recommend **not** doing it as proposed

The proposal was to gate `link_stake_signed` and `claim_role_signed` on the account holding non-zero
observed `AllowedStake`, so a scan slot costs 100 ADA of locked capital. It should not ship in that form,
for four reasons that compound.

**The mechanism does not exist where you would put it.** A bare extrinsic runs no transaction extensions,
so `CheckCapacity` never sees these calls — and `CheckCapacity::validate` separately bails on any
non-signed origin. Capacity-metering them is not a tuning change; it needs either a check inside
`validate_unsigned` (the only gate that runs) or migration to `#[pallet::authorize]`, which the code
already flags as a `transaction_version` bump.

**The economics do not work.** There is no `unlink_stake`, so the slot is **permanent** while the ADA can
be withdrawn as soon as the bind lands. That is a refundable one-time toll on a permanent slot, not a bond.

**It breaks a funnel that was deliberately tuned twice.** `/welcome` places the stake bind *inside* the L1
lock wait on purpose — "dead time the user is already sitting in (10 minutes to 36 hours), the bind is
feeless and instant, and they have just committed real ADA". The file carries the history of two prior
mistakes as a standing warning, including the ordering that bricked Nami-class wallets by making the bind
required and first. An `AllowedStake > 0` gate pushes the bind past the credit, which is 10 minutes on
preprod and ~36 hours on mainnet. Worse, Settings offers the same bind to any identity-bound account with
no lock at all — there the gate does not delay it, it fails at the pool with nothing in the UI able to
explain why.

**It couples onboarding to observer liveness.** `AllowedStake` is written only by the inherent. During any
abstain — a db-sync restart, a resync, the 50-block `Stalled` window — no new user can bind.

> **The ranking half of this item is RETIRED** *(2026-08-03, superseded by B′1 in spec 220)*.
>
> What used to stand here was a counter-proposal: ship A1, then rank the uncredited remainder of the scan
> by live `AllowedStake` inside `pinned_stake_credentials`, pricing the slot every block instead of once.
> It was aimed at a scan that could deny an account observation *for ever* — a hash-ordered prefix, with a
> grindable `blake2_128` deciding who fell outside it. That scan no longer exists. The rotation covers
> every enrolled account within `ceil(ScanSlotCount / MaxScanned)` blocks whatever the population is,
> arrival order is not something an attacker can grind, and a flood cannot move an existing account's
> slot. The starvation the ranking existed to prevent is gone, and so is its claim to "replace the
> grindable hash-ordered walk that spec 217 did not fix" — B′1 replaced it.
>
> Two things do **not** go with it, and they are what is left of this item.
>
> **The bind is still unpriced, and what it now buys is sweep LENGTH.** Nothing caps `ScanSlotCount`: it
> is an unbounded `u64`, `join_rotation` appends unconditionally, `link_identity_signed` is bare-unsigned
> and feeless, and `unlink_stake` deliberately keeps the slot. The only shrink path is a committee
> `revoke`, at `MaxBatchTargets = 64` a motion, against a flood rate this document measures at ~1 024
> accounts in about three blocks — one motion undoes about a fifth of a block of flooding. The harm
> changed CLASS rather than disappearing: it used to be one victim's weight silently frozen
> (correctness), and it is now everybody's coverage latency (capacity). That is why it leaves Lane A. It
> is not why it is solved.
>
> **Ranking got HARDER, not easier, and the step-5 note below saying otherwise was wrong.** C2 removed the
> need to enumerate the remainder for *coverage*; it did not remove the obstacle to *ordering* it. A
> window is chosen by cursor arithmetic over a dense slot table — `O(budget)` point reads, no comparison
> anywhere. A ranking is a global comparison over the whole rotation, so it still needs either an
> `O(population)` sort per block (the exact defect this plan exists to remove) or the maintained sorted
> index it always needed.
>
> If the latency is ever felt, the shape to build is not a sort but a **second ring**: a priority rotation
> holding the accounts with non-zero `AllowedStake`, swept alongside the main one, membership maintained
> `O(1)` at the sites that already write `AllowedStake` and the bind. That keeps arrival order inside each
> ring, keeps window selection arithmetic, and keeps the whole thing a pure function of parent state —
> which it must be, because `check_inherent` byte-compares. It also sidesteps all four objections above,
> because it prices PRIORITY rather than ADMISSION: an unlocked account is still covered, just later. It
> is measurement-gated, not scheduled: build it when `scan_sweep_blocks` justifies it, and note that
> raising `MaxScanned` is the cheaper answer until it does not. ⚠ Whoever builds it must widen
> `scan_window_accounts` in `runtime/src/configs/mod.rs` — the `ScanWindow` trait's dead `window()` method
> was an attractive nuisance pointing at the wrong place and was deleted in spec 221 for exactly that
> reason.
>
> The four objections above stand unchanged and are the reason this section is not simply deleted: the
> `AllowedStake` gate is the obvious "fix" someone will re-propose the first time a sweep alarm fires.

If a hard gate is wanted anyway, the minimum honest set is: mirror it in `validate_unsigned` as a distinct
`InvalidTransaction::Custom(n)` (not `Stale`, which clients drop silently); add a pinned error variant;
pre-check in `useIdentity.bindStake` and disable the Settings button with a reason rather than letting the
submit fail; and fix `PowerUps.tsx`'s "Your votes will carry weight shortly", which is already capable of
being permanently false today.

## Lane B — removing the ceilings

### The mechanism is wrong; the goal is not

A Cardano block-range cursor should not be built. That is a judgement about the *mechanism*, and it should
not be read as an argument for living with a ceiling — the ceilings come out either way, by the fixes in
"Every ceiling, and what removes it" above. The cursor is simply aimed at the one axis that is already
cheap, and it would pay for that with a permanent loss of self-healing.

Five reasons, in descending order of how decisive they are.

**Three of the four reads have no range to cursor over.** `epoch_stake`, `drep_distr` and
`epoch_stake`-by-pool select on `epoch_no = target` with no slot predicate. Deriving per-credential stake
from block churn instead means reimplementing the ledger's stake accounting *and* abandoning the
deliberately manipulation-resistant closed-epoch snapshot.

**A cursor cannot express the thing the runtime needs.** `derive_call`'s take-back rule is
"absent from the observation ⇒ clear the basis row". That is a set-*complement* fact. A cursor tells you
what moved; it cannot tell you what is absent. And at least three take-backs have no Cardano transaction
at all: cogno-gate `revoke` (which does not zero `AllowedStake` itself — the beacon simply stops resolving),
`unclaim_role`, and `revoke_role`. A range-derived change set contains nothing for any of them.

**Midnight tried it and reverted.** Their range narrowing (`LIVE_PULL_BLOCK_DELTA = 64` blocks) was backed
out because it changes the inherent payload and breaks re-import of already-authored blocks. Midnight also
has **no stateful set reduction at all** — no aggregate, the pallet never stores an amount, and its only
collision rule is a bounded two-read uniqueness *predicate*, not a max-over-a-set. cogno's largest-wins is a
fold over a whole candidate set. The reference implementation does not solve cogno's hardest problem
because it does not have it.

**It trades away self-healing permanently, and buys nothing the other fixes do not.** Today every block
re-derives ground truth, so any wrong basis row — from any cause — is repaired next block. The pallet
already has a recorded instance of the spec-215 delta payload turning a self-healing bug into a permanent
one. A cursor generalises that to every axis. The ceilings that actually exist are removed by C1–C6
without giving that up.

**And the bootstrap is a blocker, not a mitigation.** The runtime has no db-sync access. The v1 migration
could seed empty values only because "the first observation after the upgrade re-derives the truth" from
the full snapshot the node still reads. A windowed reader has no full snapshot to re-derive from, so
empty-seeded state stays empty for ever.

### The work, in order

Each item is independently shippable and independently revertable. Ordered by *what it unblocks*, not by
cost — the first three are the ones that remove a correctness ceiling.

**B′0 — Page `close_poll`'s tally (C1).** *(spec bump, NO migration; the keystone)*
Detailed above. This is first because nothing else about `MaxScanned` can move until the declaration
stops being `6 × MaxObservedAccounts`, and because ceilings 1 and 2 are the only two that make the chain
return *wrong* answers rather than slow ones. Take the tally-by-voters win alongside it — but INSIDE the
paging, never before it. Fix `poll()`'s missing `total > 0` short-circuit while you are in there: it
currently makes the live read strictly more expensive than the dispatch it mirrors.

> **Two scope corrections, 2026-08-03.** No migration is forced: the cursor row and the chamber
> accumulator both start empty, so unlike v11 there is nothing to backfill and no storage-version bump is
> required. A migration is pulled in only if `PollResult`'s own encoding changes, which the decisions
> above deliberately avoid. And `poll()`'s short-circuit is not one line — `poll()` computes `counts` and
> `total` seventeen lines BELOW the chamber walk, so it is a small hoist plus one condition. It is a
> strict behavioural no-op (`total == 0` ⇔ no `PollVotes` row for the host, pinned by `try_state`), and it
> removes up to 1 024 unmetered reads per poll card per render on an unfinalized chamber poll. Being
> non-encoding it cannot ship on its own; it rides this bump.

**B′1 — Scope-aware `derive_call`, then the rotating scan window (C3 + C2).** *(spec bump + migration)*
— **SHIPPED 2026-08-03 as spec 220**, branch `feat/scope-aware-scan-window`. Step 1 had already gone out
with Lane A. What follows is the design as it was written; the record of what actually shipped, and where
it differs, is under it.
The other correctness ceiling. Three sub-steps in order:

  1. *Free, do it immediately:* the three drop-out loops use `iter()` and discard the value. `iter_keys()`
     is a drop-in and avoids decoding up to 1 489 bytes per row on the role axis — about 1 MB of pointless
     SCALE decoding per block per node at a 10 k basis, across create and check.
  2. Teach `derive_call` the scanned scope, so absence-outside-the-scope stops meaning "cleared".
  3. Rotate the window over the uncredited remainder, so coverage is complete within a bounded number of
     blocks and per-block work stays flat.

  Constraints: any cursor state must live in **pallet storage**, not the header —
  `InherentDigest::from_inherent_data` receives only `&InherentData` with no runtime API, and the runtime
  cannot read the parent's digest at all. A storage cursor is automatically correct across a cogno-side
  reorg, because state is a per-block trie and the loser's cursor is discarded with its state.
  `LastReference` cannot be reused: it advances only when `pending == 0`, and it advances during an
  `EnforceWeight = false` freeze while the basis does not, so a freeze window would silently drop every
  change in it. And `PendingChanges` is a bare `u32` count, not a queue — nothing on-chain records *which*
  changes were deferred.

> **What shipped, and the four places it differs from the design above.**
>
> **It rotates over EVERYTHING, not over "the uncredited remainder", and that is a simplification rather
> than a widening.** Rotating only the remainder means keeping spec 217's pin for the credited set — and
> then the pin still has a hard population cap of its own (once the pinned set fills `MaxScanned` nothing
> new is ever scanned again), which is ceiling 3 rebuilt one level up. Rotating the whole ledger retires
> the pin outright, because nothing can be EVICTED from a rotation: an out-of-window row is held, so there
> is no longer anything for a pin to protect. `pinned_stake_credentials` and `pinned_role_credentials` are
> deleted, which also removes five of the seven per-block basis walks this document counts under ceiling 4.
>
> **The rotation is over ACCOUNTS, not credentials.** This was not in the design and it is what makes the
> role axis work at all. `RoleSink::set_roles` is a whole-set overwrite, so an account observed with only
> some of its credentials in scope is written back having lost the rest of its badges — and a badge carries
> chamber weight that `close_poll` freezes permanently. A credential-granular rotation therefore needs a
> cross-window MERGE, and the merge is not expressible from the basis: the stored value carries the display
> *id* (a pool id for both SPO sources), not the scanning credential, so there is no key to merge on.
> Rotating over accounts makes an account wholly in or wholly out of a window and the question does not
> arise. One window feeds all four db-sync arrays.
>
> **The ordering is ARRIVAL ORDER over a dense slot table, not a resumable hash walk.** A cursor resumed
> over the existing `Blake2_128Concat` order is the obvious implementation and it is starvable: the cursor
> is public state, hash position is ground offline, and an attacker who keeps minting credentials into the
> gap between the cursor and a victim keeps the cursor from ever reaching it — permanent targeted denial,
> rebuilt in a new place. Arrival order is not something an attacker can grind. It costs a dense
> `slot → account` table plus its inverse in cogno-gate (maintained at `do_bind`/`do_revoke`, swap-remove
> on teardown so the sweep length tracks accounts-bound-now rather than accounts-ever-bound) and a
> backfill migration, which is the migration this item was expected to need.
>
> Two consequences worth stating because they are not obvious. The cursor advances by a fixed stride in a
> ring, so it does NOT return to 0 after a sweep — it drifts, and that is harmless: consecutive windows
> abut, so the union of any `ceil(count / budget)` of them is the whole ring wherever it started. And an
> account holding no credential at all still consumes a slot; the alternative (walk until `budget`
> credential-bearing accounts are found) makes the walk length depend on table CONTENT, which an attacker
> chooses, and that is the "budget counts results, not rows walked" shape inverted into a hazard.
>
> **The exemption narrowing is part of this change, not a follow-up.** Risk #2 below is what makes it
> mandatory: the self-healing that made the old `return Ok(())` tolerable is removed BY THIS ITEM, on
> purpose. An enacting block now carries no observation, and one that carries an observation is rejected.
> The author cannot use the importer's `LastRuntimeUpgrade` predicate — `create_inherent` runs after
> `initialize_block`, which is what overwrites it — so it reads a marker its own `on_runtime_upgrade`
> leaves, and its predicate is deliberately the WIDER of the two. Both sides run the NEW wasm on that
> block (`:code` is written when the upgrade is APPLIED, one block earlier), so the narrowing covers its
> own enacting block rather than only future ones.
>
> **The coverage signal is its own item, and folding it into `PendingChanges` would have been wrong.**
> `pending == 0` means "this reference's change set fitted in one block"; on any chain larger than one
> window the scan is permanently mid-sweep, which is the healthy state. Folding them would hold
> `LastReference` for ever, fire `ObservationBacklogged` every block, and break the stall alarm's
> `LastReference`-plus-`PendingChanges` inference. `LastSweepAt` is the coverage clock instead. The cursor
> *does* advance on the same `pending == 0` condition the frontier does — a deferred page must be
> re-derived next block, not a whole sweep later.
>
> **The node's alarm inverted.** `ObserverScanCapped` and `ObserverApproachingMaxScanned` watched a prefix
> filling; under a window a full scan is what every healthy block looks like, so both would page
> continuously with text that is no longer true. Replaced by two rules on
> `cogno_observer_scan_sweep_blocks`.
>
> **One open item this deliberately absorbed**, having been recorded under C1 as a hazard to settle before
> B′6: nothing ever removed a `VotingPower` row, and `unlink_stake` / `do_revoke` left one standing on the
> grounds that the observer cleared it next block. That inference is exactly what the window removes, so
> the teardown had to become explicit anyway (`pallet_cogno_gate::OnBindTeardown`) — and doing it closes
> the stale-row hazard for the paged `close_poll`'s voter walk at the same time.
>
> **What it does NOT remove.** `derive_call` still walks all three bases in full every block, so ceiling 4
> is reduced (the five pin walks are gone) rather than removed; the vault basis is still the uncapped one.
> `MaxObservedAccounts` still bounds the read path, so ceiling 6 is untouched — that is B′6.

**B′2 — Filter spentness in the vault SQL (C4).** *(node-only, no spec bump)* — **SHIPPED 2026-08-02,
branch `perf/vault-spentness-predicate`.** Three of the four claims below turned out to be wrong; what
actually happened is recorded under them.
Add the unspent-as-of-reference predicate to `OBSERVATION_SQL`'s driving scan. Turns the payload from
`O(every vault output ever)` into `O(live locks)` and stops the ratchet. Cheapest fix on the list.
Two traps. The `spent_at.slot > ref` case must be preserved *exactly* — a UTxO spent after the reference
still counts as locked at the reference, and the golden fixture has a case proving the winner can be an
already-spent UTxO. And it changes the candidate set, so every `expectedCandidateHex` in the fixture must
be regenerated; that is a deliberate reduction change, not a tidy-up. Ships as a node binary plus a
producer restart, so it must land on **every** verifying node in lockstep. Revert = redeploy the previous
binary.

> **What shipped.** The predicate is
> `AND (ti.id IS NULL OR sb.slot_no IS NULL OR sb.slot_no > p.ref)` — three disjuncts because
> `observe_as_of`'s spent-slot parse fails **open**, so an unresolvable spending slot has to be kept, not
> tidily dropped. Verified against the live vault: 20 rows → 15, same 13 beacons, identical reduced
> entries.
>
> **It does not stop the ratchet, and it does not make the read `O(live locks)`.** The `EXPLAIN` breakdown
> at 636 262 rows: the `tx_out` bitmap scan and the `tx`/`block` joins cost ~2.8 s, the `tx_in` spentness
> join another ~7.9 s, and the `ma_tx_out` beacon probe ~2.2 s. The predicate removes only the last one,
> because you have to do the spentness join to *know* spentness. Result: 13 265 → 10 698 ms, a 19–27%
> saving that pushes the 2 s timeout crossover from ~97 k to ~121 k cumulative UTxOs. Worth having, three
> lines, but it buys headroom rather than removing the axis. An anti-join form
> (`NOT EXISTS (… sb2.slot_no <= p.ref)`) was measured too and is *worse* (12 997 ms at 636 k) — the
> simple predicate wins.
>
> **The fixture needed no regeneration.** `observation-equivalence.json` feeds its stored `matches`
> straight into `candidate_bytes`/`observe_as_of`; the SQL is not in that path and the reduction did not
> change, so all 19 cases pass untouched (486 workspace tests green). The two `dbsync-live-preprod-*`
> cases were deliberately left holding spent-before-ref rows — the Rust filter stays as defence in depth,
> and those cases are what pin it. This removes the scariest part of the item: there is no fixture
> generator in the tree, so "regenerate 38 hex strings by hand" was the real risk and it does not exist.
>
> **It is not a lockstep rollout.** `check_inherent` excludes `inputs_commitment` from its equality test
> on purpose (`lib.rs:1721`: two honest nodes routinely hold different candidate sets that reduce to the
> same result), consulting it only to classify a failure already established on the outputs. Since the
> reduced deltas are provably identical, a mixed-binary network agrees on every block. The only cost
> during a rollout is that a divergence from some *other* cause reports `Mismatch` where it might have
> said `ComputeDiverged`. Roll it out node by node.

**B′3 — Short-circuit the epoch-quantized reads, then bound the `tx_metadata` scan (C6).**
*(node-only, no spec bump)*
Three of the four reads return byte-identical results for ~72 000 consecutive blocks. A node-local memo
keyed on `(target_epoch, credential)` inside `read_stake_observation` / `read_pool_stake` / the
`drep_stake` half emits byte-identical `stake_entries` while skipping the query entirely. `derive_call`
and `check_inherent` only ever see the *rows*, never how the node obtained them, so this needs **no
on-wire signal and no runtime change at all**. Take it first; it is nearly free.

> **It is not nearly free, and it should not go first.** Four things the sketch above skips, all of them
> consensus-fatal rather than merely slow:
>
> 1. **There is no epoch to key on.** The node only ever holds `ref_slot` and `lookback`; the target epoch
>    is resolved *inside Postgres* by the `ep`/`target` CTEs, deliberately, so no node ever does
>    slots-per-epoch arithmetic (`dbsync.rs:211-213`). Keying on `ref_slot` makes the memo per-block and
>    useless; deriving the epoch node-side reintroduces exactly the arithmetic that was designed out, and
>    a wrong derivation reads the wrong immutable snapshot on every node running the new binary.
> 2. **The credential set moves inside an epoch.** `bound_stake_credentials` is rebuilt from live state
>    every block and pre-pinned by `pinned_stake_credentials()`. A memo keyed on epoch alone serves a
>    stale set, and a missing credential is not "unknown" — `derive_call` pushes `(cred, None)`, which
>    `observe` applies by **zeroing that account's `VotingPower`**.
> 3. **A hit skips the only fail-closed freshness probes on this axis.** `epoch_stake_ok` / `target_ok`
>    (and `read_pool_stake`'s `target_ok`) are inside the memoized query. A node whose db-sync has fallen
>    behind would keep confidently authoring a stale stake set instead of abstaining, turning a safe
>    per-node `CannotVerify` into a fatal `Mismatch` on every honest importer.
> 4. **There is no commitment to appeal to.** `inputs_commitment` covers the vault axis only, so a stake
>    divergence can never classify as the diagnostic `ComputeDiverged` — it is a straight block rejection.
>
> None of that is unfixable (key on the Postgres-resolved epoch plus a hash of the credential set, and
> keep the probes outside the memo on every block), but it is a consensus-critical cache, not a one-liner.
> And the measurements say it is not urgent: on this instance the stake read is 64 ms at the live
> population and 154 ms at the compile-time ceiling, and the whole four-read set is well inside the
> proposing window. **Do the `shared_buffers` tuning first — it is a config line, it has no consensus
> surface at all, and it moves the same numbers further.**
Then bound the `regs` CTE by a `tx_metadata.id` lower bound: 197.6 ms → 0.9 ms measured. This is the one
place a range genuinely belongs, and it must be the *safe* kind — use the range to discover **which
credentials to re-examine**, then take a fresh point read of each one's state at the reference. A rolled-back
or short range then costs a needless re-read (harmless) or a missed key (repairable by B′5), never a
corrupted fold. Do **not** let it become "apply every event in `(lo, hi]`". Because the range decides what
the node reads, its lower bound must be consensus-pinned state, not node-local: an importer reading a
different range derives a different delta and the block is fatally rejected.

> **WITHDRAWN 2026-08-04. The `regs` bound must not be built, and the cost it was aimed at comes out with
> an index instead.** The paragraph above is wrong in its premise, not merely in its cost estimate, and
> both halves are now measured rather than argued.
>
> **The safety rule cannot be applied to this axis.** "Discover which credentials to re-examine, then take
> a fresh point read of each one's state" needs the discriminating credential to be addressable. On this
> query it is not: the Calidus key hash lives *inside* the `tm.bytes` CBOR blob, so there is no column,
> no index and no predicate db-sync can serve a point read by. What is left is exactly the shape the rule
> forbids — a set-complement fact derived from a partial set.
>
> **So a range corrupts the fold, and the live data says it corrupts it badly.** The label-867
> registrations on preprod span ids 402 268 → 1 655 055, epoch **59** to epoch **303**. A 1 000-id window
> sees **7 of 153**; a 100 000-id window sees **36 of 153**. That distribution is not an accident of this
> chain's age — a pool registers its Calidus key once and then never touches it again, so the winning
> registration is *typically* the oldest thing in the set. `reduce_role_observation` folds per POOL over
> every registration whose key is claimed, so a pool whose only registration falls outside the window
> leaves `claimed_calidus_pools` entirely: no badge in the observation, and `derive_call` reads that
> absence as CLEARED. The account's chamber weight goes to zero on the first block after the change
> ships, and a `close_poll` in that window freezes the zero permanently. That is a take-back of a correct
> badge, not a missed key B′5 could repair.
>
> **And there was never a lower bound to pin it to.** There is no `tx_metadata.id`, no Cardano tx id and
> no Cardano-side position anywhere in runtime state except `LastReference.slot` — which advances only
> when `PendingChanges` is 0 and keeps advancing through an `EnforceWeight = false` freeze, the same two
> objections that disqualified it as the scan cursor in B′1. Pinning a real one means a new storage item
> and a new runtime-API field, which makes this a spec bump rather than the node-only change it was filed
> as.
>
> **The cost is real; the cause was misdiagnosed.** Re-measured 2026-08-04 with server-side
> `EXPLAIN (ANALYZE, BUFFERS)` against the live preprod db-sync at the live reference slot:
>
> | shape | median | what it does |
> |---|---|---|
> | `regs` as it ships today | **230–274 ms** | parallel seq scan, `Rows Removed by Filter: 559 107` × 3 workers |
> | the proposed 1 000-id window | 15–22 ms | and drops 146 of 153 registrations |
> | **with an index on `tx_metadata (key)`** | **7–8 ms** warm, 46 ms cold | reads all 153, drops none |
>
> There is no index on `tx_metadata.key` — db-sync ships `(id)` and `(tx_id)` only — so the query
> sequential-scans 1.64 M rows / 2.29 GB to return 153. **The index is both safer and faster than the
> range the plan asked for**, at a third of its latency, with no consensus surface, no runtime change and
> no fold to corrupt. It belongs beside the `shared_buffers` finding as operator config, and it is written
> down in [`PREPROD-BRINGUP.md`](PREPROD-BRINGUP.md). (The index measurement is simulated through
> `tx_metadata_pkey` on the 153 known ids, which is a conservative upper bound: 153 separate PK probes
> cost more than one range scan on `key` plus 153 heap fetches.)
>
> Two guards now hold the reversal in place, because the instruction to build this is written in this very
> document and someone will read it again. `dbsync::tests::the_registration_scan_is_not_bounded_by_a_cursor`
> pins the `regs` predicate verbatim and fails on exactly the `tm.id > $5` the paragraph above prescribes;
> `reduction::tests::roles::a_registration_set_truncated_by_a_cursor_silently_drops_a_live_badge` pins the
> mechanism, by reducing the same claimed set twice and showing a live pool's badge disappear.
>
> What this does **not** change: the vault axis's own touched-beacon range (described under "What remains
> after the plan") is a different shape and is not withdrawn — there the discriminating value is the
> beacon, which *is* addressable. It does lose the "reuse B′3's consensus-pinned cursor" shortcut, since
> no such cursor was ever built.

**B′4 — Raise `MaxScanned`, and correct its rationale.** *(spec bump, one line + comments)*
After B′0 the ceiling is no longer 8 640 and the constant becomes a work-per-block knob rather than a
population cap.

> **Re-point `MAX_SCANNED_CEILING`, do not delete it.** After B′0 the `close_poll` declaration contains no
> `MaxObservedAccounts` term, so the existing assert `MaxScanned ≤ MAX_SCANNED_CEILING` becomes vacuously
> true rather than wrong — which is worse, because it reads as a live guard while checking nothing. It has
> to become a PAGE-size ceiling asserted against the page constant:
> `(allowance − fixed) / (reads_per_account × read + writes_per_account × write)`. The new denominator is
> **write-dominated** (100 µs against 25 µs), so the resulting number is far smaller than 8 640 suggests —
> do not carry the old figure across. Keep `max_scanned_ceiling_is_not_optimistic`'s exact/exact+1 cliff
> structure: it is what makes the compile-time gate sufficient rather than merely necessary, and it is the
> only mechanical check FRAME can make on any of this.

Five weight sites are coupled and all five must move together; each fails loudly if missed, which is the
safety net: the declaration itself (`pallets/microblog/src/lib.rs:2038-2041`),
`CLOSE_POLL_READS_PER_OBSERVED_ACCOUNT` (`runtime/src/configs/mod.rs:1553`), `MAX_SCANNED_CEILING`
(`:1603-1605`), its assert (`:1607-1613`), and the exact-equality test (`:1819-1825`). Set it from the measured table, not from the current comment — the stated justification
("until the db-sync query blows its timeout") is empirically wrong by roughly two orders of magnitude, and
that comment should be replaced with the measurements rather than left to mislead the next person. Check
the two coupled costs first: `pinned_*` walks scale linearly with the cap on every node every block, and
`staker_weights()` is rebuilt per read `state_call`.

**B′5 — Periodic full-snapshot reconciliation.** *(spec bump)*
Recompute `desired` from a full read every N blocks (or in `on_idle`) and repair any drift. This is what
buys back self-healing on a bounded horizon, and it is what makes B′1 and B′3 safe rather than merely fast.
It reintroduces the `O(population)` read on a duty cycle instead of every block — which is the point, since
the read is affordable, just not 14 400 times a day.

**B′7 — Finish what B′1 left, from the pre-enactment review of 217 → 220.** — **ALL THREE SHIPPED
2026-08-03**: items 1 and 2 as **spec 221** (branch `feat/role-teardown-resumable-backfill`), item 3 alone
as **spec 222** (branch `fix/hoist-enacting-upgrade-guard`). What follows is the design as it was written;
the record of what actually shipped, and where it differs, is under it.

Three items were confirmed against the code, judged latent at the live population, and deliberately not
folded into the spec that introduces the rotation. In priority order:

1. **A resumable rotation backfill.** `pallet_cogno_gate::migrations::v2` enrols in ONE block under a
   `MAX_ACCOUNTS` cap, and an overrun is silent in production (`post_upgrade` is try-runtime-only) and
   permanent (the version and `ScanSlotCount` commit either way). The stranded tail is not frozen, it is
   WIPED: no slot means `ScanCoverage::Absent`, which `derive_call` clears on sight. Persist the last
   key and enrol a bounded batch per block until `ScanSlotCount` equals the `PkhOf` count. Do NOT panic
   on the overrun — that makes the enacting block unproducible.
2. **An explicit role teardown**, the analogue of `OnBindTeardown` for the role axis.
   `pallet_cardano_roles::unclaim_role` and `do_revoke_role` still rely on "the observer clears it next
   block", which the window turned into "within one sweep". A paged `close_poll` can freeze a released
   or committee-BANNED badge's chamber weight in that gap, and `ObservedRolesSeq` does not move, so
   `PollTallySmeared` cannot report it. The obvious fix is wrong: `ObservedRoles` stores the display id,
   not the scanning credential, so there is no key to filter one role's badges out by, and clearing the
   whole set would strip an mSPO's legitimate owner-path badges.
3. **Hoist `check_inherent`'s enacting-upgrade guard above the `CannotVerify` early return.** It reads
   only `LastRuntimeUpgrade` and `Version`, so it is decidable by a node that has never heard of
   Cardano — yet it sits behind the local-data fetch, so every db-sync-less node (relay, tracking,
   user) skips it and would accept an unverifiable observation on an enacting block. It wants its own
   change and a test for the no-local-data path, because hoisting converts "rejected by the synced
   subset" into "rejected by everyone" on the one block that must not halt.

> **What shipped, 2026-08-03, and the four things the design above did not know.**
>
> **Item 2's teardown is WHOLE-ACCOUNT, and the "obvious fix is wrong" note understated why.** It is not
> only that `ObservedRoles` stores the display id rather than the scanning credential. `derive_call` also
> dedups by `(kind, id)`, so a pool reached via BOTH the owner path and a Calidus claim is ONE stored row
> backed by two independent credentials — a single `source` field would be wrong as well as absent. And
> the observer *does* carry the distinction: `RoleSource` has four variants in the inherent payload and
> `RoleSource::kind_index()` collapses both SPO arms to `0` before storage, so the information is computed
> every block and discarded at the storage boundary. Recovering it is therefore cheap in principle and
> expensive in practice: a source BITMASK on `ObservedRole`, a migration on two ledgers, a
> `transaction_version` move (the `RoleChange` tuple is a call argument), and three frontend read sites.
> Deliberately deferred. The trigger to spend it is `scan_sweep_blocks` leaving 1; until then the
> whole-account clear is exact, because one window is the whole rotation and the blink is one block.
>
> **Both role verbs also had to drop the OBSERVER's basis, not just the badge set.** `derive_call`'s
> forward pass emits a change only when the recomputed set differs from `LastObservedRoles`; clearing the
> badge row alone makes the next observation agree with itself and strands the account with an empty set
> FOR EVER. The roles pallet has no Cargo edge to the observer, so this goes through a new
> `OnObservedRolesCleared` seam wired in the runtime — the role analogue of `OnBindTeardown` — and the
> roles mock got a RECORDING double rather than `()`, because with `()` that failure is invisible to
> every test in the crate that causes it.
>
> **Item 1's drain is `on_idle`, and `on_initialize` would have been a fork.** The brief offered
> `MultiBlockMigrations` or an idempotent `on_initialize` drain. Both are wrong. `derive_call` reads
> `ScanSlotOf` (through `coverage`) and `ScanSlotCount` (the wrap modulus), and the author evaluates it
> after `initialize_block` while every importer evaluates it against raw parent state — so an
> `on_initialize` write is visible to one side and not the other and `check_inherent` byte-compares them.
> MBM is worse on a different axis: while one is ongoing `frame_system::can_set_code` returns
> `MultiBlockMigrationsOngoing`, and all four of `pallet-migrations`' recovery calls are `ensure_root`.
> This chain is sudo-free and its only upgrade path routes through `can_set_code`, so a stuck MBM is an
> unrecoverable brick. `on_idle` runs after the extrinsics, so its writes land in this block's post-state
> — the next block's parent state, identical on all three vantage points.
>
> The drain deliberately does NOT teach `coverage` to answer `Deferred` for an un-enrolled account while
> a backfill is in flight, which would have avoided the transient clear entirely. `Absent ⇒ clear on
> sight` is the backstop that makes `OnBindTeardown` safe, and holding it instead would let a
> committee-BANNED account keep its weight for the whole backfill. Under-crediting a tail that self-heals
> in a bounded number of blocks beats over-crediting a ban.
>
> **Item 3 mattered more than "every db-sync-less node skips it" suggests.** On this chain that set is
> everything: `cogno-relay.service` deliberately ships with no `EnvironmentFile`, so the public relay,
> every tracking node and every user node abstain, and the only node that ever reached the guard was the
> single producer. The network was split on the validity of the one block that carries a migration.

Also from that review, and already fixed in 220 rather than deferred: the cursor now advances on the
SCOPED axes' page-fullness rather than on the summed `pending`, so unscoped vault churn no longer stalls
the rotation. `ObserverConfig::scan_sweep_blocks` remains a FLOOR, and the multiplier stated here was
wrong in two ways. The cursor advances only when BOTH scoped axes come back strictly SHORTER than a full
page, so a window whose delta is an exact multiple of `MaxChangesPerBlock` costs one extra confirm-empty
block: `ceil(MaxScanned / MaxChangesPerBlock) + 1`, not `ceil(...)`. More importantly the real worst case
is not a multiplier on the sweep at all but **sweep PLUS backlog** — at a Cardano epoch boundary every
bound credential's stake moves at once, so the stake axis returns a full page for `ceil(population / 256)`
consecutive blocks during which the cursor does not move *at all*. At 10 000 accounts that is a reported
sweep of 2 blocks against a real coverage age of roughly 40. Two further terms make it unbounded rather
than merely long: an `EnforceWeight = false` freeze applies nothing, and a genuine observer stall applies
nothing either. `scan_sweep_blocks` can see none of it.

**B′6 — Fix the read path (C5).** *(spec bump)*
`staker_weights()` is rebuilt per read `state_call` and `enrich` probes each staker per post on the page.
This is the ceiling users actually feel, and it is unmetered and unfeeable so nothing guards it. It needs
the same decision as the chamber tally: denormalize a running weighted score (which risks reintroducing the
stale-weight bug spec 205 fixed) or iterate voters rather than stakers. Pick one and write down why.
Two genuinely uncapped prefix collects belong in this item: `following_feed_page`'s
`Following::iter_key_prefix` and `likes_page`'s whole-`VotesByAccount`-prefix collect-then-sort.

### Enactment order

Sequencing matters because node-side and runtime-side changes ship differently and no node may ever run a
new binary against an old runtime API or vice versa.

The node-side items are cheap and unblock nothing, so they go first to make the measurements honest; then
the two correctness ceilings; then everything downstream of them.

1. **B′3's epoch short-circuit**, then **B′2** — node binary + producer restart. No governance.
   Regenerate the golden fixture for B′2 and say in the commit that it is a deliberate reduction change.
   Re-measure after both; every number in this document should be retaken here.

   > **Done differently (2026-08-02).** The re-measure came first and reordered the step. **B′2 shipped**
   > on `perf/vault-spentness-predicate` with no fixture regeneration (none was needed) and no lockstep
   > requirement (none exists). **B′3's memo did not ship** — see the four consensus traps recorded under
   > it; the cheap win on that axis is `shared_buffers`, not a cache. Note also that **B′1 step 1
   > (`iter_keys()`) cannot ride a node-only branch**: it is runtime code, and `can_set_code` requires a
   > strictly increasing `spec_version`, so it has to travel with the next runtime upgrade (step 2's spec
   > 218) rather than with this one. It is also not the pure no-op it looks like — `iter()` silently skips
   > a row whose *value* fails to decode while `iter_keys()` yields it, and on `LastObservedRoles` (a
   > `BoundedVec` value) that difference lands in `role_changes`, which `check_inherent` byte-compares.
   >
   > **Closed out 2026-08-04: neither half of B′3 ships, and this step is done.** The memo was already
   > withdrawn above; the `regs` bound is now withdrawn too, for a reason the memo's four traps did not
   > cover — a range on that axis has no addressable credential to point-read, so it corrupts the
   > per-pool fold rather than merely missing an update. The full measurement is under B′3. What replaces
   > it is one line of operator config (`CREATE INDEX ... ON tx_metadata (key)`), which is faster than
   > the range *and* returns every registration. Two regression guards were added in place of the
   > change. **Nothing on the node-only track is outstanding.**
2. **A1** (+ `unlink_stake`) — spec 218. One committee motion to `authorize`, then a permissionless
   `apply`. Metadata re-snapshot, PAPI regen against a local dev node, lockstep FE deploy. This closes the
   free-grief vector before anything raises a cap.
3. **B′0 — the paged tally.** Spec bump, no migration (the new items start empty). The keystone; ceiling 1
   comes out here in full and ceiling 2 by half — the frozen result stops being truncated, the live read
   does not.
4. **B′1** — spec bump + migration. Ceiling 3 comes out here. Steps 3 and 4 are the two that need real
   design work; everything before them is mechanical and everything after them is a consequence.

   > **Done 2026-08-03 as spec 220.** The migration is cogno-gate v1 → v2 (enrol every bound account in
   > the scan rotation); it is load-bearing rather than tidy, and `post_upgrade` fails rather than warns
   > if one account is left out, because an un-enrolled account is in no window and its weight would
   > freeze permanently. This does NOT unblock A2's ranking — it removed the need to enumerate the
   > remainder for coverage, not the obstacle to ordering it. See the A2 section, where the ranking is
   > now retired.
5. **B′7** — the three items the pre-enactment review of 217 → 220 confirmed and deferred. **Done
   2026-08-03**: items 1 and 2 as spec 221 (the resumable rotation backfill and the explicit role
   teardown), item 3 alone as spec 222 (hoisting `check_inherent`'s enacting-upgrade guard, which had to
   ship by itself because it turns "rejected by the synced subset" into "rejected by everyone" on the one
   block that must not halt).
6. **B′4**'s `MaxScanned` re-derivation — **done 2026-08-03 as spec 223**, 1024 → 8192, from the M1 table
   rather than from the comment. **A2 is no longer on this list**: B′1 removed the starvation the ranking
   was aimed at, and what survives (the unpriced bind, and a priority ring if sweep latency is ever felt)
   is measurement-gated rather than scheduled. See the A2 section.
7. **B′6**, then **B′5**.

   > **Why B′6 stays ahead of B′5, checked 2026-08-03.** The obvious argument for reordering is that
   > B′1 deliberately removed per-block self-healing on the stake and role axes, so B′5 (periodic
   > full-snapshot reconciliation) is what buys that property back — a correctness property lost should
   > outrank a latency one. The arithmetic says otherwise, at least for now. `slot_in_window` takes
   > `take = min(budget, count)`, so while `ScanSlotCount <= MaxScanned` every distance is `< take` and
   > `coverage` NEVER returns `Deferred`. Below one window's worth of accounts nothing is ever held,
   > nothing can drift, and spec 220 removed no self-healing at all — B′5's entire premise cannot occur
   > yet, and B′4's raise to 8 192 pushed the threshold eight times further out. B′6's costs, by
   > contrast, are paid from the first account and on every unmetered `state_call`. Revisit the ordering
   > when `scan_sweep_blocks` leaves 1; that is the same trigger as everything else on this axis.

Any migration in steps 3 and 4 goes into `SingleBlockMigrations`, appended before the closing `);` with
the house-style comment block, or it silently never runs. (B′0 as decided needs none — its two new storage
items start empty. B′1 will.) Run the `try-runtime` dry-run from
`docs/UPGRADES.md` against state scraped from a **local tracking node**, never
`live --uri wss://cogno.forum/rpc`. If a `#[storage_alias]` is needed, spell out a `StorageInstance` with
the real `STORAGE_PREFIX` and pin it with a `hashed_key_for` assertion — microblog's `migrations::v10` is
the pattern.

One ordering hazard applies from step 3 onward: `check_inherent` returns `Ok` *before comparing anything*
on a block that enacts a runtime upgrade, because the author derives post-migration while importers derive
pre-migration. Today that is acceptable because on-ledger weight self-heals next block. Any migration that
seeds scope or cursor state lands in exactly that unverified block — so narrow that exemption in the same
change, not later.

## What remains after the plan

Stated plainly, because "removing the population ceiling" should not be read as a claim of O(1).

**Gone: every ceiling where the chain returns a wrong answer.** C1, C2 and C3 — the `close_poll` brick,
the silent frozen tally, the never-observed credential — are removed by B′0 and B′1. Those are the defect.

> **Both shipped, and one of the three came out by halves.** B′0 (spec 219) removed C1 outright and half
> of C2: the FROZEN `PollResult` is computed over the complete voter set, while the live `poll()` read is
> still `.take(cap)` truncated, so at and above `MaxScanned` the two can disagree with the frozen one
> correct. B′1 (spec 220) removed C3 in full. What the two together did NOT remove is the read-path cap
> itself — `MaxObservedAccounts` still bounds a dozen unmetered `state_call` paths, which is ceiling 6
> and is B′6.

**Remaining: one soft, population-shaped cost on the vault axis.** Two terms survive:

- The vault SQL becomes `O(live locks)` rather than `O(every lock ever)`. That kills the ratchet but not
  the shape. Measured: ~22 ms at 10 k, ~167 ms at 40 k, ~1.25 s at 80 k.
- `derive_call` still walks `LastObserved` in full every block on both the authoring and import paths,
  because for the vault axis absence-from-the-snapshot is the only unlock signal. The rotating window does
  not help here — the vault set is discovered by policy id, not by credential enumeration, so there is no
  scan to rotate.

Neither corrupts anything. Both degrade gradually, both are measurable, and the failure at the far end is
a fail-closed abstain — weight freezes at its last values and posting continues. That is a legitimate
capacity limit rather than a correctness bug, which is why it is deferred rather than solved.

**The path to removing it, when it matters.** It is the safe-range pattern B′3 described and then failed
to satisfy, not the stateful incremental reduction that Lane B's B4 was stuck on — and the difference
between the two axes is the whole reason this one survives while B′3 does not: here the discriminating
value is the **beacon**, which is an indexed column db-sync can point-read, whereas the role axis's
Calidus key hash is buried in a CBOR blob. Ask db-sync for the beacons *touched*
(created or spent) in `(last_ref, ref]` — a small set — then for each touched beacon take a fresh scoped
point read of its largest live UTxO as of the reference. The largest-wins fold still happens, but over one
beacon's live set, read fresh, never maintained incrementally. Drop-outs are exactly the touched beacons
whose point read comes back empty, so `derive_call` no longer needs the full-basis walk and absence can
finally mean "unchanged".

That avoids the hard problem entirely: no per-beacon UTxO multiset on chain, no `max` that cannot be
inverted, no top-N cap to overflow. What it does need is a consensus-pinned cursor — which it must BUILD,
since B′3 never shipped one and there is no Cardano-side position in runtime state except
`LastReference.slot` (disqualified for the same two reasons B′1 gave: it advances only at
`PendingChanges == 0`, and it keeps advancing through an `EnforceWeight = false` freeze) — and
B′5's periodic reconciliation to close any hole the range missed. Worth writing down properly before it is
needed; not worth building at 20 vault UTxOs.

## What we lose

The snapshot read bought three things. Naming what replaces each:

| Lost | Replacement |
|---|---|
| **Self-healing.** Every block re-derives ground truth from the full snapshot, so any wrong basis row is repaired next block, whatever caused it. | B′5's periodic full reconciliation — the same property on a bounded horizon (N blocks) instead of one block. This is why B′5 is not optional. |
| **A trivially deterministic `check_inherent`.** Both sides run the identical `derive_call` over the identical basis, so agreement is by construction rather than convention — including the paging boundary and the reported `pending`. Under a churn read the importer holds only its own range result, so the check degenerates toward a bit-compare of the payload against a local read (Midnight's model). | Nothing fully replaces it. This is a real loss and the strongest argument for keeping B′3 scoped to "discover which keys changed, then point-read each one" rather than an event fold. |
| **No consensus cursor.** The reference is a pure function of the parent's Aura slot — unforgeable without forging the parent, with zero author discretion. | A pallet-storage cursor, monotonicity enforced inside `observe` (not only in `check_inherent`, since a node that swallowed `CannotVerify` never ran the check). Worth noting cogno's upper bound is *better* than partner-chains': their whole McHash apparatus exists because their author picks the reference block, and cogno's author cannot. |

Also given up: `inputs_commitment` in its present meaning. Today it covers the whole historical candidate
set as-of the reference, which is what makes it independently recomputable from an archived db-sync. Under
a window it can only cover that window, so verification becomes a chain of commitments. It is never
compared directly (only consulted to split `Mismatch` from `ComputeDiverged` after the deltas already
disagree), so redefining it breaks an audit property, not a consensus check — but say so deliberately
rather than discovering it.

## Risk register

Worst first, by failure mode rather than likelihood.

1. **Silent cross-node divergence in the vault reduction → chain fork.** If B′2's spentness predicate
   changes which UTxOs are candidates in a way the fixture does not pin, two node versions reduce
   differently. Mode: **fork**, or a fatal `ComputeDiverged` that halts import. Mitigation: extend the
   golden fixture *before* the change, keep the 19 existing cases as full-re-sync cases, and roll the
   binary to every verifying node in lockstep. This is the single highest-consequence item in the plan.

   > **Downgraded on measurement (2026-08-02).** For B′2 as shipped this risk does not arise: the
   > predicate drops exactly the rows `observe_as_of` was already skipping, so the reduced deltas are
   > identical by construction, and `check_inherent` excludes `inputs_commitment` from its equality test
   > by design. Two tests now pin both halves —
   > `the_sql_spentness_filter_and_the_rust_one_agree_on_every_shape` models the SQL clause verbatim
   > against the Rust filter across all five spentness shapes, and
   > `the_spentness_filter_does_not_reach_the_candidate_commitment_gate` asserts the entries hold still
   > while the commitment moves. The risk as written still applies to any *future* change that touches
   > which UTxOs are candidates **and** their reduced values — keep the entry for that.
2. **A cursor advance applied in the unverified upgrade block.** `check_inherent` returns `Ok` before
   comparing anything on an enacting block. Mode: **permanent silent divergence** — an author can skip an
   arbitrary Cardano range with no node objecting, and unlike today it does not self-heal. Mitigation:
   narrow the exemption in the same change as B′0/B′1; do not defer it.

   > **CLOSED 2026-08-03 in B′1**, which is also the change that made it real. An enacting block carries
   > no observation at all now, and one that carries an observation is rejected. Two facts made the
   > narrowing safe that the entry above does not state. Both sides run the NEW wasm on the enacting block
   > (`:code` is written when the upgrade is APPLIED, one block earlier, so it is already in the parent
   > state), so the fix covers its own enacting block rather than only later ones. And the author cannot
   > use the importer's predicate — `create_inherent` runs after `initialize_block`, which is what
   > overwrites `LastRuntimeUpgrade` — so it reads a marker its own `on_runtime_upgrade` leaves instead.
   > The failure directions are asymmetric and the code is written around that: an author that skips a
   > block the importers think ordinary costs one observation, an author that includes one on a block they
   > think enacting halts the chain. The author's predicate is therefore deliberately the wider of the
   > two. Residual: the migration's own OUTPUT is still not checked by consensus, only by `try_state` and
   > the pre-enactment `try-runtime` run.
3. **A pruned or resynced db-sync serving a short range as authoritative truth.** There is no depth probe
   today — only freshness. Mode: **silent under-observation**, the `--consumed-tx-out` trap on a new axis.
   Mitigation: add a depth probe beside the existing `tx_in` / `ma_tx_out` / `tx_metadata` `EXISTS` gates,
   and abstain unless the instance demonstrably retains history back to the cursor. The `dbsync.rs` test
   module already fails the build for a new table with neither a probe nor an exemption; keep it that way.
4. **Abstention livelock under a widening range.** The four reads are sequential with independent 2 s
   timeouts inside a ~4 s proposing window. Under a cursor, abstaining makes the *next* read harder:
   wider range → slower query → timeout → abstain. Mode: **chain-wide weight freeze** that does not
   recover on its own. Mitigation: cap results per block (never rows walked), and hold the cursor when a
   page truncates so `pending` and the cursor are two halves of one state machine.
5. **Cardano rollback deeper than the stability window.** Live preprod runs 600 slots (~10 min), not the
   129 600 of the mainnet parameter. Today a deep rollback self-heals in one block once db-syncs converge.
   Mode under a consuming cursor: **unrecoverable** — the range is applied, the cursor is past it,
   monotonicity forbids rewinding, and any `close_poll` in that window froze chamber weights permanently.
   Mitigation: the state-convergent shape in B′3, plus B′5. Neither Midnight nor partner-chains has any
   undo; their answer is to stay out of the rollback-prone tail entirely.
6. **The free bind flood, before A1 lands.** Mode: **denial of observation for new users**, loud but
   irreversible without N committee motions, plus a permanently-firing alert that trains the operator to
   ignore it. Not a fork, not a freeze; posting is unaffected because the vault axis has no cap.
   Mitigation: A1 first. TxPause is the only fast lever today and it is three motions, all of which also
   block legitimate onboarding — worth pre-writing rather than discovering during an incident.
7. **Raising `MaxScanned` multiplying read-path cost.** `staker_weights()` is rebuilt per read
   `state_call`; at 8 640 stakers a 100-post feed page would cost ~864 000 probes. Mode: **node
   degradation**, unmetered and unfeeable, felt as slow pages rather than as a chain problem. Mitigation:
   measure the read path before B′4, not after.
8. **A migration silently iterating zero rows.** The `#[storage_alias]` naming trap. Mode: **orphaned
   state reported as success** — unit tests cannot catch it because they read and write through the same
   wrong prefix. Mitigation: the `migrations::v10` pattern plus a live-state `try-runtime` run.

## The toolkit fork: stay independent

Do not adopt the partner-chains data-source layer. Port a pattern if one fits; write the SQL here.

The decisive finding is a direct conflict with cogno's most important byte-identity invariant: the toolkit
**auto-detects and silently switches to `consumed_by_tx_id`**, and the detection **fails open** — a
present-but-empty `tx_in` is read as "use `consumed_by_tx_id`" — cached in a `OnceCell` for the process
lifetime. cogno abstains fail-closed in exactly that situation, deliberately, because `consumed_by_tx_id`
was observed NULL for a known-spent vault UTxO on the live instance. Adopting the crate imports the exact
bug the invariant exists to prevent, with a silent process-lifetime cache in front of it.

Three more reasons:

- **The cache is consensus-*neutral*, not consensus-*safe*.** The epoch-keyed stake LRU is a pure
  memoization with no stability gate (its sibling candidates cache has one), it never consults
  `epoch_stake_progress`, and it is untested. Its correctness rests entirely on a two-epoch offset applied
  by the caller. That is fine for partner-chains, which **never byte-compares the stake payload on import**
  — their `check_inherent` verifies only an operational timestamp, so a per-node cache divergence is a
  quietly different reward payout. In cogno the identical divergence is a fatal `Mismatch` and a stalled
  chain. The pattern transfers only with an immutability proof the toolkit does not supply. cogno's
  epoch-quantization argument (B′3's short-circuit) *is* that proof, which is why porting the idea is fine
  and adopting the code is not.
- **Dependency coupling.** partner-chains pins polkadot-sdk stable2509 via git tag on rustc 1.90 /
  edition 2024; cogno pins stable2606 via crates.io on rustc 1.93 / edition 2021. Pulling the crate in
  duplicates the entire `sp-*` tree in the lockfile and drags in non-optional `cardano-serialization-lib`
  and `partner-chains-plutus-data`.
- **Licence.** The proposer work already carries an Apache-2.0 reimplementation for a reason; the
  verifier route is GPL-3.0.

What *is* worth porting, as ideas rather than code: the two-level `BridgeDataCheckpoint::{Utxo, Block}`
cursor shape (a page that hits its cap must resume mid-block, which a single slot number cannot express),
and Midnight's `CardanoPosition` ordering on `(block_number, tx_index_in_block)` with the block hash
explicitly informational — a hash cannot be a range bound.

## The case against this whole plan

Made as strongly as I can, and then answered honestly. There are two different arguments here and they
deserve separate verdicts, because conflating them is the mistake this section originally made.

### The case against the *mechanism*: it wins

A Cardano block-range cursor should not be built. Three of the four reads have no range to cursor over;
the runtime's take-back rule is a set-complement fact a cursor cannot express; at least three take-backs
have no Cardano transaction at all; the one reference implementation that tried range narrowing reverted
it; and the bootstrap has no full snapshot to seed from. On top of that it is aimed at the axis the
measurements show is already the cheap one — the live vault read is 5–8 ms. This verdict stands.

### The case against the *goal*: it loses

The tempting version goes: cogno's addressable population is Cardano's governance participants, roughly
3 000 pools and 1 500–2 000 dReps, so call it 8 000 — and `MAX_SCANNED_CEILING` is 8 640, so the entire
addressable population already fits under a cap that is one line away. No cursor, no migration, no lost
self-healing. Just a constant and a corrected comment.

That is a real and useful observation, and it is why B′4 is cheap. It is not a reason to keep the ceiling,
for three reasons.

**It is a bet on a market forecast, settled in the runtime.** "8 000 is enough" is a business judgement
encoded as a `const` whose failure mode is a chain that silently freezes wrong poll results. If the
forecast is wrong the correction requires a governed runtime upgrade *and* a migration to repair the
`PollResult` rows already frozen, on a sudo-free chain. That is an expensive way to be wrong about
something nobody has to be right about.

**The failure is silent and permanent, not loud and recoverable.** A capacity limit that rejects work is
a legitimate design. This one does not reject: past `MaxScanned` a credential is simply never observed, a
tally is computed over an arbitrary hash-ordered subset, and `close_poll` freezes that subset into
`PollResult` with no correction path. A user gets no error, the operator gets a log line that also fires
during a griefing attack, and the wrong number is permanent. "The chain got popular and some votes stopped
counting" is not a capacity story, it is a correctness bug with a population trigger.

**The ceiling is adversarially reachable, so the forecast does not even bound it.** The scan budgets fill
in about three blocks for free. The population that matters is not the number of real users but the number
of credentials anyone chose to create, and that is not something a market forecast bounds. Lane A raises
the cost of doing it, but as long as a *population* number is what breaks correctness, an attacker picks
when you reach it.

And the fixes are not the expensive ones. Ceilings 1, 2 and 3 — the three that produce wrong answers —
come out via a paged tally and a rotating scan window. Neither needs a Cardano cursor, neither loses
self-healing, and the rotating window is already designed in prose in the codebase. What they need is
careful work on the poll-state-across-pages question and on making `derive_call` scope-aware, which is
real design effort but bounded and local.

### The verdict

Build the smaller plan, but build all of it. Specifically:

- **Do now:** B′3's epoch short-circuit, B′2's spentness predicate, B′1 step 1 (`iter_keys()`), and Lane
  A1 (`revoke_many` + `unlink_stake`). Small, high-value, none structural.
  > **Revised 2026-08-02 after measuring.** B′2 is **done**. B′3's memo is **withdrawn from "do now"** —
  > it is a consensus-critical cache with four fatal edges and it is aimed at an axis measuring 64 ms;
  > the actual do-now on that axis is tuning the db-sync Postgres off its 128 MB stock `shared_buffers`.
  > B′1 step 1 moves to step 2, because it is runtime code and needs a spec bump to reach the chain.
  > Lane A1 is unchanged and is now the next thing to build.
  >
  > **Revised again 2026-08-04.** B′3's *other* half — the `regs` id bound — is withdrawn as well, and
  > for a sharper reason than the memo's: it corrupts the per-pool Calidus fold rather than merely
  > missing an update, because the credential that decides the fold is inside a CBOR blob and cannot be
  > point-read. The measured replacement is an index on `tx_metadata (key)`, which is 30× faster than
  > the scan it removes, **3× faster than the range that was proposed**, and returns every registration
  > instead of 7 of 153. Both do-nows on the db-sync axis are now operator config rather than code:
  > the index and `shared_buffers`. **B′3 as a whole is closed, not pending.**
- **Do next, and do not defer:** B′0's paged tally and B′1's scope-aware `derive_call` + rotating window.
  These are the ceiling. They were filed as "when a real number demands it" in the first draft of this
  document, which was wrong — the number that demands them is not a user count, it is the fact that the
  ceiling exists at all.
- **Do on measurement:** B′6, then B′5; and a priority ring if `scan_sweep_blocks` ever justifies one (what is left of A2). B′4 and B′7 are done, and B′3 is closed without shipping either half.
- **Do not build:** the Cardano block-range cursor as specified — including, now, the `regs`
  `tx_metadata.id` bound this document itself prescribed as the one place a range belonged.

The residual honest limit, worth stating so nobody reads this as a promise of infinity: per-block work
stays bounded, because a 6 s block with a 2 s compute budget cannot do unbounded work. What changes is
what that bound is *on*. After this plan the bounds are on churn per block, on page size, and on scan
window — all of which are work bounds with complete eventual coverage. None of them is a bound on how many
people the chain can serve correctly, which is the only kind that should never have existed.

---

*Measurements: live preprod db-sync, 2026-08-02. Chain state verified at spec 217 / tx 8, one committee
seat. The measurement harness is throwaway and not in the production path. B′0 shipped as spec 219 and
B′1 as spec 220, both on 2026-08-03; the numbers above predate neither, since neither changed what SQL
runs.*
