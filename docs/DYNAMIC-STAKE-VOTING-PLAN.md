# Dynamic stake voting — implementation plan

**Branch:** `review/dynamic-stake-voting` · **Status:** approved, not yet built · **Live base:** spec 204 / tx 3 / microblog storage v5 (queried from `wss://cogno.forum/rpc`, 2026-07-17) · **Target:** spec 205 / tx 4 / microblog storage v6

**All decisions resolved — this is a build-ready spec.** `close_poll` = call_index **13**; `PollClosed`
event = codec index **11**; `PollClosed` error = codec index **16**; poll deadline = **block number**;
weighted join lives in the pallet via an injected **`StakerSet`** trait; the reference indexer is **dead**
(no indexer work). See §9.

Stake-weighted opinion is Cogno's defining feature. Today a vote's weight is frozen at the moment
it is cast, so it never reflects the voter's current stake — a wallet that gains or loses stake, or a
fresh wallet that reads `0` before its epoch snapshot lands, is stuck forever. This plan makes vote and
poll weight track the **live, per-epoch** observed stake, and adds an **optional poll close** so a poll
can still have a final, immutable outcome.

---

## 1. Root cause (already in the code)

The live stake ledger is **not** the problem. `pallet_talk_stake::VotingPower` is re-derived for every
bound credential *every block* by the `cardano-observer` inherent
([observer:681–728](../pallets/cardano-observer/src/lib.rs#L681)), holding it equal to each voter's
current-epoch `epoch_stake` at `reference_epoch − StakeEpochLookback` (lookback = 1). It steps at each
Cardano epoch boundary and self-heals a new wallet's `0` the moment its snapshot lands. This is exactly
the "voting power for this epoch = observed stake at the epoch snapshot" model.

The staleness is entirely downstream, in **one pallet**. Each of `vote` / `vote_account` / `poll_vote`
reads the weight **once** at cast time and freezes it into the stored record:

- [`microblog:1121`](../pallets/microblog/src/lib.rs#L1121) `let weight = pallet_talk_stake::VotingPower::<T>::get(&who); // AT vote time`
- [`:1218`](../pallets/microblog/src/lib.rs#L1218) (`vote_account`), [`:1426`](../pallets/microblog/src/lib.rs#L1426) (`poll_vote`)

The denormalized tallies (`VoteTally`, `AccountVoteTally`, `PollTally`) sum those frozen snapshots, and
re-vote/clear deliberately reverses the *stored* weight, never re-reading — the indexer-determinism
contract. Net: the ledger moves, the votes are fossils.

## 2. Core mechanism — derive weighted tallies live at read time

Stop storing weight. A vote becomes just its **direction**; a poll choice just its **option**.

- **On-chain we keep only exact COUNTS** (`up_count` / `down_count`, per-option count). Counts stay a
  pure, deterministic event fold, give O(1) sortable numbers, and never go stale.
- **The weighted score is never materialized on-chain.** It is computed **live** in the node's
  `MicroblogApi` read path (off-consensus — no block-weight cost) by joining a post's votes against the
  *current* `VotingPower`. Every already-cast vote re-prices on the next read: a gained stake lifts it, a
  full unstake drops it to `0`, a new wallet catches up when its snapshot lands — **no re-vote needed,
  zero added consensus work** (the vote extrinsics get *cheaper* — they drop a cross-pallet read and
  u128 arithmetic).

### 2.1 Exact and bounded — iterate the staker set, not the voters

The weighted score is **not** computed by scanning "a post's voters up to a cap". That approach (adversarial
review confirmed) is non-canonical — the same post shows different scores in the feed vs its detail page —
and non-monotonic, because `Votes` is `Blake2_128Concat`-keyed, so a truncated prefix is an arbitrary
hash-ordered subset that can exclude the single highest-stake voter and let a new vote *lower* the score
while the count rises.

Instead, iterate the **bounded set of accounts that have any stake** and probe membership:

```
staker_set = pallet_cardano_observer::LastObservedStake   // BoundedVec<(StakeCredential, AccountId), MaxObserved>, observer:378
for (_, account) in staker_set:                            // ≤ MaxObserved = 1024, chain-wide
    w = pallet_talk_stake::VotingPower::get(account)       // live, current-epoch
    if let Some(rec) = Votes::get(post_id, account):       // O(1) membership probe
        add w to up_weight / down_weight per rec.dir
```

`LastObservedStake` is exactly the set of accounts with non-zero `VotingPower` (the observer writes
`VotingPower` from that same credited set and clamps everything absent from it to `0`), so this is
**exact**, **single-valued**, and bounded by **one chain-wide constant** (`MaxObserved`), independent of
how viral a post is. At today's ~2–7 stakers it is trivial; at the 1024 ceiling it is ≤1024 probes per
entity. Read the staker→weight map **once per `state_call`** and reuse it across every post/account/poll
on the page, so a feed page costs `|staker_set|` weight reads + `|staker_set| × page_size` membership
probes — the same posture as the existing `MAX_PEOPLE_SCAN` / `MAX_EDGES` caps.

This applies identically to the three weighted surfaces: **post votes** (`Votes` → `VoteCounts`),
**account reputation** (`AccountVotes` → `AccountVoteTally` counts), and **polls** (`PollVotes` →
per-option counts).

## 3. Poll finality — optional close + snapshot

Because weights float, a poll with no close would re-price forever (unstaking retroactively removes weight
from a socially-concluded poll). Per the finality decision, polls get an **optional close** that freezes
their weighted result.

- `Poll` gains `close_at: Option<BlockNumberFor<T>>` — `None` = floats forever (backward-compatible
  default for existing polls); `Some(b)` = closes at block `b`.
- `create_poll` (call_index 9) takes the new `close_at` argument. **This is the only call-arg change and
  it moves `transaction_version` 3 → 4.**
- `poll_vote` (call_index 10) rejects once `now ≥ close_at` (new `Error::PollClosed`, **codec index 16**).
- **`close_poll` — new call_index 13, permissionless** (13 is confirmed free; 1 and 6 stay permanently
  vacant). Callable once `now ≥ close_at` and not yet finalized. It computes the **exact** per-option
  weighted tally from current `VotingPower` over the bounded staker set (§2.1 — O(MaxObserved) probes,
  bounded consensus work), writes it to a new `PollResult` storage map, and emits `PollClosed`
  (**event codec index 11**). The first caller after `close_at` finalizes it; the FE (or any keeper)
  triggers it.
- Reads: `PollResult` present → return the **frozen** weighted result; past `close_at` but not yet
  finalized → live join, flagged provisional; otherwise → live join.
- Snapshot semantics: the frozen weights reflect `VotingPower` at the block `close_poll` executes (≥
  `close_at`). Since `VotingPower` is epoch-constant, finalizing within the close epoch captures the
  intended snapshot; documented, not a bug. (A stricter "freeze exactly at the close epoch" variant is a
  later option — see §9.)

## 4. Changes by layer

### 4.1 `pallet-microblog` — storage v5 → v6

| Type | v5 (now) | v6 |
|---|---|---|
| `VoteRecord` | `{ dir, weight: u128 }` | `{ dir }` |
| `PollVoteRecord` | `{ option, weight: u128 }` | `{ option }` |
| `Tally` (post + account) | `{ up_weight, down_weight, up_count, down_count }` | `VoteCounts { up_count, down_count }` |
| `OptionTally` | `{ weight, count }` | `{ count }` |
| `Poll` | `{ options }` | `{ options, close_at: Option<BlockNumber> }` |
| `PollResult` (new) | — | `{ option_weights: BoundedVec<u128, MaxPollOptions>, option_counts: BoundedVec<u32, …>, closed_at: BlockNumber }` |

`Votes` / `AccountVotes` / `PollVotes` / the tally maps re-encode to the lighter value types. No new
reverse `voter → votes` index (the join probes membership on the existing target-keyed maps).
`VotesByAccount` (Up = like) is unchanged.

**Extrinsics.** `vote` (4) / `clear_vote` (5) / `vote_account` (11) / `clear_account_vote` (12) /
`poll_vote` (10) keep their signatures and `call_index`; each drops the `VotingPower::get` snapshot and
the u128 weight arithmetic, keeping only the O(1) count reverse/apply + the record insert. `create_poll`
(9) gains `close_at`. `poll_vote` gains the `PollClosed` guard. **`close_poll` (13)** is new.

**Events** (payloads change, `#[codec(index)]` pins fixed): `Voted` = 2, `AccountVoted` = 4,
`PollVoted` = 10 drop their `weight` field; new `PollClosed { host_id }` at event **codec index 11**
(next free; 0–10 used, 6 is the retired `Reposted` gap). New `Error::PollClosed` at **codec index 16**
(next free; 0–15 used, 5 is the retired `AlreadyReposted` gap). Retired gaps (event 6, error 5) stay vacant.

**Staker-set injection.** Add `type StakerSet` (a bounded `IntoIterator<Item = AccountId>` provider) to
`Config`, wired by the runtime to `LastObservedStake`, plus `type VotingPower` (already reachable via the
`pallet_talk_stake` dep). The pallet's read fns do the join with the injected set, so the weighted-tally
logic stays in one place and is unit-testable against the mock. (Alternative: do the join in `apis.rs`
alongside the existing `enrich_author_profiles` cross-pallet reads — simpler wiring, more scattered. The
plan recommends the trait so the join is cohesive and mock-tested.)

### 4.2 Runtime read API — `runtime/src/apis.rs`

The `MicroblogApi` **wire shapes are unchanged** — `EnrichedPost` / `PollView` / `PersonSummary` /
`ProfileView` keep `up_weight` / `down_weight` / `account_tally`, now filled by the live join — so the API
stays **version 1** and the FE render path needs no structural change; the numbers just become live.

- `feed_page` / `author_feed_page` / `following_feed_page` / `thread` / `author_replies_page` /
  `likes_page` / `search_posts`: build the staker→weight map once, then fill each post's weighted tally.
- `poll` ([apis.rs:371](../runtime/src/apis.rs#L371)): frozen `PollResult` if finalized, else live join.
- `person_summary` ([apis.rs:117](../runtime/src/apis.rs#L117)) and `profile`
  ([apis.rs:387](../runtime/src/apis.rs#L387)): `account_tally` weighted numbers via the live join. Cap
  the people-list join per-row at the same posture as `MAX_PEOPLE_SCAN` (the `search_people` /
  `who_to_follow` pages already clamp to `MAX_PAGE = 100`).

### 4.3 Runtime config & versioning — `runtime/src/lib.rs`, `runtime/src/configs/mod.rs`

- `spec_version` **204 → 205** (storage layout + event payloads change) — [lib.rs:71](../runtime/src/lib.rs#L71).
- `transaction_version` **3 → 4** (`create_poll` gains `close_at`) — [lib.rs:76](../runtime/src/lib.rs#L76).
- Wire the `StakerSet` provider for `pallet_microblog::Config` to `LastObservedStake`.
- Register the v5→v6 migration in `SingleBlockMigrations` — **append, do not replace** (see §4.4).

### 4.4 Storage migration v5 → v6 — `pallets/microblog/src/migrations/v6.rs` (new)

A `VersionedMigration<5, 6, InnerMigrateV5ToV6, Pallet, DbWeight>` gated on the microblog
`StorageVersion` (bump `STORAGE_VERSION` 5 → 6 at [lib.rs:156](../pallets/microblog/src/lib.rs#L156)),
following the `MigrateV4ToV5` pattern ([v5.rs](../pallets/microblog/src/migrations/v5.rs)). Pure, lossless
re-encode with **no re-derivation**: `translate` each record/tally to drop the two u128 weight fields and
**keep the counts**; set `Poll.close_at = None`; `PollResult` starts empty. Counts are continuous across
the upgrade; only the now-recomputed-live weighted numbers change basis — that *is* the fix.

**Two hard prerequisites the adversarial review flagged:**

1. **Live base confirmed = v5** (queried `wss://cogno.forum/rpc` 2026-07-17: spec 204, and the
   `Microblog` `StorageVersion` key returned `0x0500` = 5 — the 203→204 upgrade already ran
   `MigrateV4ToV5`). So this is a clean **v5→v6**. **Append** the new wrapper, keep the now-self-skipping
   `MigrateV4ToV5`:
   `type SingleBlockMigrations = (migrations::v5::MigrateV4ToV5<Runtime>, migrations::v6::MigrateV5ToV6<Runtime>,);`
   at [configs/mod.rs:89](../runtime/src/configs/mod.rs#L89). Never *replace* `MigrateV4ToV5` (it stays as
   the self-skipping guard for any node still at v4). Re-verify the live `StorageVersion` immediately
   before enact in case another upgrade lands first.
2. **Treat the single-block re-encode as operationally, not structurally, bounded** — it `translate`s
   every `Votes` / `AccountVotes` / `PollVotes` + tally row in one block. Fine at today's tiny live row
   count; gate enact on a `try-runtime` dry-run against a **realistic** live snapshot and read back the
   reported weight. If it approaches the block budget, convert to a `SteppedMigration`. `post_upgrade`
   asserts: row counts preserved, counts byte-identical before/after, `StorageVersion == 6`, and no
   `weight` field still decodes.

### 4.5 Benchmarks / weights — `pallets/microblog/src/{benchmarking.rs,weights.rs}`

Re-run FRAME benchmarks for the five vote extrinsics (all shrink) and benchmark the new `close_poll`
(bounded by `MaxObserved × MaxPollOptions`). Update `weights.rs`.

### 4.6 Frontend — `app/`

- **Lockstep spec:** `DESCRIPTOR_SPEC_VERSION` 204 → 205 in
  [app/src/lib/chain/client.ts](../app/src/lib/chain/client.ts), then regenerate PAPI descriptors against
  a **local** dev node at spec 205 (`rm app/.papi/descriptors/generated.json && (cd app && npx papi add
  cogno -w ws://127.0.0.1:9944)`), or `check-spec.mjs` fails the build.
- **Render path:** unchanged — `EnrichedPost` / `PollView` / `PersonSummary` shapes are identical, so the
  score chip, poll bars, reputation badge, and person rows just show live numbers.
- **Retire PAPI-direct weighted reads:** `social-reads.ts`'s `readPostTally` / `readAccountVoteTally` /
  `readPoll` read stored weight fields that no longer exist — reroute all weighted numbers through the
  node `MicroblogApi` (feed/thread/profile already do); counts can stay PAPI-direct. Preserves the "FE
  must never sum `Votes` client-side" invariant.
- **Optimistic overlay simplifies and gets *more* correct:** `optimistic.ts` / `accountVote.ts` /
  `usePoll` already add/remove the viewer's **current** `VotingPower`, which now exactly matches chain
  semantics — the stored-snapshot over/under-adjust mismatch disappears. Keep tally reads at `{ at: 'best' }`.
- **Poll UI:** a close time on the compose-poll form; a "finalize" affordance (calls `close_poll`) and a
  closed/final state on `PollCard`.

## 5. On-wire / upgrade checklist

- [ ] `spec_version` 204 → 205; `transaction_version` 3 → 4.
- [ ] All `call_index` unchanged (4/5/9/10/11/12); `close_poll` = **13** (confirmed free; 1 & 6 stay vacant).
- [ ] Event/error `#[codec(index)]` pins fixed; `weight` dropped from Voted/AccountVoted/PollVoted
      payloads; new `PollClosed` **event = index 11**, `Error::PollClosed` **= index 16**.
- [ ] `STORAGE_VERSION` 5 → 6; migration wrapper **appended** to `SingleBlockMigrations` (`MigrateV4ToV5`
      retained, self-skipping).
- [x] Live on-chain `StorageVersion` verified against the running node = **5** (2026-07-17); re-verify
      immediately before enact.
- [ ] `try-runtime` dry-run against a live snapshot (CI does not gate this).
- [ ] PAPI descriptors regenerated at 205; `DESCRIPTOR_SPEC_VERSION` bumped in lockstep.
- [ ] Enact: committee `upgrade authorize` + permissionless `upgrade apply` (205 > 204).

## 6. How this resolves the adversarial findings

- **Non-canonical / non-monotonic weighted score (the one `major`, `holds=false` finding):** eliminated
  by iterating the bounded staker set (§2.1) instead of a hash-ordered voter prefix — exact, single-valued,
  cap-free. Poll winners are exact (and frozen at close).
- **Bounded work:** the observer inherent is untouched; the vote extrinsics shrink; the join is
  off-consensus and bounded by `MaxObserved`; `close_poll` is bounded on-chain work. No `on_initialize`
  sweep, no re-tally fan-out.
- **Migration safety:** verify live `StorageVersion`, append (never replace) the migration, `try-runtime`
  on a real snapshot, `post_upgrade` count-continuity assertions.
- **Indexer:** treated as **dead** (gitignored, spec 113, out of the live path). No indexer work in this
  change; document that weighted tallies are node-derived only and the event stream alone no longer
  reconstructs the weighted score (counts still fold cleanly). Revive later only if actually needed.
- **Cross-node transience:** at `{ at: 'best' }` two nodes straddling an epoch boundary can briefly differ
  on weighted numbers with no vote activity; bounded within an epoch, converges at finalization. Documented.

## 7. Behavioral semantics (intended, surface these)

- Votes and open polls **always reflect current stake**: gain lifts, full unstake drops to `0`, new
  wallet catches up when its snapshot lands (~1–2 epoch lag, the deliberate CIP-1694-style manipulation
  lag — unchanged).
- At every Cardano epoch boundary, all historical weighted numbers re-price at once — a large, correct,
  visible step. Worth a user-facing note.
- **Counts** are exact and immutable-per-vote; **weight** floats. The two can move independently (a
  0-stake voter still adds to the count). The FE should not present them as a locked pair.
- A poll with `close_at` has a final, immutable weighted outcome after `close_poll`; a poll without one
  floats forever.

## 8. Test matrix

- Pallet unit tests: vote/clear reverse counts only; live-join weighted tally exact vs a hand-summed
  fixture; unstake-to-0 drops weight; new-wallet-catch-up; `poll_vote` rejected after close; `close_poll`
  materializes exact per-option weights and is idempotent/rejected before close.
- Determinism test: the staker-set join yields identical output regardless of map iteration order.
- Migration: `pre/post_upgrade` count continuity; v4→v5→v6 chaining if live is v4; no `weight` decodes post-upgrade.
- `verify` / end-to-end on `--dev`: cast votes, move genesis stake, confirm tallies re-price on the next read.

## 9. Resolved decisions (2026-07-17)

1. **Join site → `StakerSet` trait injected into the pallet** (cohesive, mock-tested; keeps microblog free
   of a hard dep on cardano-observer — the runtime wires it to `LastObservedStake`). Not `apis.rs`.
2. **Poll deadline unit → Substrate `BlockNumber`** (`close_at: Option<BlockNumberFor<T>>`). Simple,
   deterministic, no new on-chain epoch tracking; the FE presents it as a date/duration (block time × N).
   An epoch-based deadline is a possible follow-up once the observer surfaces the current Cardano epoch
   on-chain — out of scope here.
3. **Close snapshot precision → freeze at the `close_poll` execution block** (current `VotingPower`, which
   is epoch-constant). The FE auto-triggers `close_poll` on first view after the deadline so the snapshot
   is taken promptly in the close epoch. No captured epoch marker.
4. **Reference indexer → dead.** Stop constraining the design around its fold-determinism contract; no
   indexer work (see §6).

## 10. Sequencing & rough effort

1. Pallet: storage v6 types, strip weight from the 5 extrinsics, count-only tallies, staker-set join,
   `close_at` + `close_poll` + `PollResult`, events. (~2–2.5 d)
2. Migration v5→v6 + `try-runtime` hooks; verify live `StorageVersion`. (~1 d)
3. Runtime: spec/tx bump, `StakerSet` wiring, migration tuple, read-API join + caps. (~1–1.5 d)
4. Benchmarks + weights. (~0.5 d)
5. FE: descriptor regen + spec bump, reroute weighted reads to node, optimistic simplification, poll-close
   UI. (~1.5–2 d)
6. `try-runtime` dry-run on a live snapshot + `verify` + docs. (~0.5 d)

**~7–8 focused days**, dominated by the read-join determinism/bounding and the poll-finality surface —
not the pallet mechanics. No observer / db-sync / consensus / contracts changes.
