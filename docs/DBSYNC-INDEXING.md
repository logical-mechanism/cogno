# db-sync indexing

Operator notes for the Postgres behind `DBSYNC_URL`. Everything here is **operator config with no
consensus surface**: no index changes what a query returns, only what it costs, so none of it needs a
node rebuild, a spec bump or a restart. What it does change is how much of the 6 s block budget the
observer's read spends, which is why it belongs in the repo rather than in someone's shell history.

Read this alongside [PREPROD-BRINGUP.md](PREPROD-BRINGUP.md) (which covers the db-sync configuration
cogno *requires*) and [OBSERVATION-READ-SHAPE-PLAN.md](OBSERVATION-READ-SHAPE-PLAN.md) (which carries the
per-read cost breakdown these numbers feed).

## Check you are on the right database first

⚠ **A preprod db-sync is easy to have two of, and `CREATE INDEX` will happily succeed on the wrong one.**
`sudo -u postgres psql cexplorer` connects over the local unix socket to whatever Postgres is on the box
you typed it on. If that is not the box `DBSYNC_URL` points at, the index is built, valid, and useless —
and nothing tells you, because the command prints `CREATE INDEX` either way. This has already happened
once.

Connect over TCP so the target is unambiguous, and confirm before you run anything:

```bash
psql -h <dbsync-host> -p 5432 -U postgres -d cexplorer
```

```sql
SELECT inet_server_addr(), inet_server_port(), current_database();
```

That must match the host, port and database in `DBSYNC_URL`. A `NULL` address means you are on a unix
socket, i.e. the local machine, which is exactly the case to be suspicious of.

## The indexes cogno's consensus path needs

There are two, and they are prerequisites rather than tuning: each covers a column db-sync leaves
unindexed on a table the per-block observation filters, so without them Postgres scans the whole table
once per block at a cost set by its row count. The whole role read shares a single 2 s fail-closed
budget, so a table grown far enough does not degrade its own axis — it times the read out and the
observer abstains from the *entire* observation, taking vault credit, voting power and every badge with
it, chain-wide.

The node checks for both at boot and shouts the exact `CREATE INDEX` at you if either is missing. It
matches on the indexed **column**, not the index name, so an equivalent index under another name counts;
it resolves the table through the connection's own `search_path`, so an index on a same-named table in
another schema does not; and it requires `indisvalid`, so an interrupted build (below) is reported
missing rather than covered.

### `tx_metadata (key)`

db-sync indexes `tx_metadata` on `(id)` and `(tx_id)` only, never on `key`. The role read filters on
`key = 867` to find Calidus registrations, so without this it sequential-scans the whole table — on live
preprod, 1 637 391 rows and 2 287 MB discarded to return 153. It was the single most expensive query on
the consensus path, about 81% of the four-read total.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_metadata_key ON tx_metadata (key);
```

**Applied to the live preprod db-sync on 2026-08-04.** Measured with server-side
`EXPLAIN (ANALYZE, BUFFERS)` at reference slot 130 135 393, the same query and the same slot on both sides:

| | plan node | `tx_metadata` buffer reads | time |
|---|---|---|---|
| before | `Parallel Seq Scan on tx_metadata` | 91 757 | 228.8 – 237.3 ms |
| after, cold | `Bitmap Index Scan on idx_tx_metadata_key` | 139 | 8.1 ms |
| after, warm | same | — | 2.56 / 2.65 / 2.70 ms |

Both sides return the same 153 rows, so this removes I/O rather than work: 660× fewer buffer reads, and
roughly 90× faster once warm. The index itself is 38 MB.

`CONCURRENTLY` keeps the table writable while it builds, so db-sync keeps ingesting; it takes two passes
over the table (tens of seconds on preprod, longer on mainnet). It is a plain user-created index, so
db-sync's own schema migrations leave it alone, and `DROP INDEX CONCURRENTLY` reverses it.

If a `CONCURRENTLY` build is interrupted it leaves an **INVALID** index behind — present, unused, and
immune to a retry because of the `IF NOT EXISTS`. This applies to both indexes above. The node's boot
check treats an invalid index as missing and prints the DDL, so a restart tells you; verify by hand
rather than trusting the `CREATE INDEX` success message if you would rather not wait for one:

```sql
SELECT c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid))
  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
 WHERE c.relname IN ('idx_tx_metadata_key', 'idx_committee_registration_cold_key');
-- indisvalid = f  =>  DROP INDEX CONCURRENTLY <name>;  then rebuild
```

A partial `... (id) WHERE key = 867` is smaller and slightly faster, but it serves only this one label.
Prefer the plain index unless space is tight.

### `committee_registration (cold_key_id)`

`committee_registration` carries 648 767 rows (56 MB) on preprod: one actor proposed a 30-member
committee and then batched an `AuthCommitteeHot` certificate for every cold key in it. db-sync indexes
the table on `(id)` only, so resolving the sitting members' hot keys seq-scans all of it.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_committee_registration_cold_key
  ON committee_registration (cold_key_id);
```

**Applied to the live preprod db-sync on 2026-08-06.** It is 4.4 MB.

Creating it was only half the job, and the other half is the part worth remembering: **an index the
query cannot reach buys nothing.** The committee CTE originally scoped `committee_registration` by
joining the CTE that holds the sitting members. Postgres has no row estimate for a CTE it cannot see
into, so it hash-joined against a full scan and never touched the index at all. Measured warm at
reference slot 130 231 807 with the index present and the committee axis armed, same query, same rows
out:

| `cc_hot` scope | role read |
|---|---|
| `JOIN cc_term s ON s.hid = cr.cold_key_id` | 110 – 136 ms |
| `cr.cold_key_id = ANY (ARRAY(SELECT hid FROM cc_term))` | **9 – 20 ms** |

([PREPROD-BRINGUP.md](PREPROD-BRINGUP.md) records ~48 ms for the array form. Same finding, measured
before the committee tx bound was anchored at a block in the same pass — that took another ~20 ms out,
and the rest is how warm the instance was.)

The array form is what every other scoped read in that query already uses (`= ANY($2)`, `= ANY($3)`),
and it takes an `Index Scan using idx_committee_registration_cold_key`. Both forms return byte-identical
committee material, so this is purely about reachability — which is why a unit test pins the shape:
reverting it would pass every test of the answer while putting a 100 ms scan back on every block, with
the boot check still reporting the index as present.

The gate matters independently of all this: the committee block is skipped outright while no account
has claimed a CC credential, and one feeless `claim_role_signed` arms it.
[PREPROD-BRINGUP.md](PREPROD-BRINGUP.md) carries the full reachability argument for the table's growth —
the ledger gates `AuthCommitteeHot` on committee membership, so it cannot be grown by just anyone, but
the bound that gives is on the attacker rather than on the query.

## What the vault axis needs: nothing

Already checked on live preprod, and worth not re-deriving. The vault read discovers UTxOs by
`tx_out.payment_cred = <script hash>` and resolves spentness through `tx_in`. db-sync ships
`idx_tx_out_payment_cred` and `idx_tx_in_tx_out_id` as standard, so both halves are already indexed and
there is nothing to add.

⚠ **Do not "help" the vault read with a `consumed_by_tx_id` index.** Two of the general indexes below are
predicated on `consumed_by_tx_id IS NULL`, which is the `--consumed-tx-out` shape. cogno requires a
db-sync running the opposite way (FULL, non-pruned, `tx_in`-enabled), and reads spentness from `tx_in`
**never** from `consumed_by_tx_id` — that is a byte-identity invariant of the reduction, not a preference.
An index whose predicate names that column serves a configuration this chain must not run on. See
[PREPROD-BRINGUP.md](PREPROD-BRINGUP.md) and the gotchas in [CLAUDE.md](../CLAUDE.md).

## General db-sync / explorer indexes

These are the usual community set for a db-sync serving wallet- and explorer-shaped queries. **None of
them is on cogno's consensus path** — the node's read touches `tx_out`, `tx_in`, `ma_tx_out`,
`tx_metadata`, `pool_hash`, `pool_update`, `pool_retire`, `pool_owner`, `stake_address`, `epoch_stake`,
`drep_hash`, `drep_registration`, `drep_distr`, `epoch_state`, `committee_member`, `committee_hash`,
`committee_registration`, `committee_de_registration`, `block` and `tx`, and everything it needs is in
the section above. Apply these if the same database also backs other services; skip them if it only
feeds cogno, since every index is write amplification on a database that ingests continuously.

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_address_stake_address_id ON public.address (stake_address_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_out_address_id_unspent ON tx_out (address_id) WHERE consumed_by_tx_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_out_stake_address_id_unspent ON tx_out (stake_address_id) WHERE consumed_by_tx_id IS NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tx_out_address_id_tx_id ON tx_out (address_id, tx_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reward_addr_id_spendable_epoch_incl_amount ON reward (addr_id, spendable_epoch) INCLUDE (amount);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reward_rest_addr_id ON reward_rest (addr_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_withdrawal_addr_id_incl_amount ON withdrawal (addr_id) INCLUDE (amount);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_delegation_addr_id_tx_id ON delegation (addr_id, tx_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_redeemer_script_hash ON redeemer (script_hash);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_redeemer_script_hash_tx_purpose_index ON redeemer (script_hash, tx_id, purpose, index);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_voting_procedure_gov_action_proposal_id ON voting_procedure (gov_action_proposal_id);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_voting_procedure_drep_voter ON voting_procedure (drep_voter);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_voting_procedure_pool_voter ON voting_procedure (pool_voter);
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_drep_registration_drep_hash_id ON drep_registration (drep_hash_id);
```

## Vacuum and autovacuum

db-sync's big tables are insert-heavy, and Postgres' default insert-driven autovacuum thresholds scale
with table size, so on a large table they fire too rarely to keep the visibility map useful. That costs
index-only scans and leaves planner statistics stale. Run the vacuum once after a large backfill, and set
the thresholds so autovacuum keeps up on its own:

```sql
VACUUM (ANALYZE) reward;
ALTER TABLE reward SET (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 1000000);
VACUUM (ANALYZE) tx_out;
ALTER TABLE tx_out SET (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 1000000);
VACUUM (ANALYZE) address;
ALTER TABLE address SET (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 100000);
VACUUM (ANALYZE) withdrawal;
ALTER TABLE withdrawal SET (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 100000);
VACUUM (ANALYZE) delegation;
ALTER TABLE delegation SET (autovacuum_vacuum_insert_scale_factor = 0, autovacuum_vacuum_insert_threshold = 100000);
```

`VACUUM` takes no exclusive lock, so this is safe while db-sync is running. `ALTER TABLE ... SET` takes a
brief lock on the catalog row only.

## Still open: `shared_buffers`

The live preprod Postgres runs the stock `shared_buffers = 128MB` against a 34 GB database. The usual
starting point for a dedicated host is about 25% of RAM. It needs a `postgresql.conf` edit and a restart,
which stops db-sync briefly — during which the observer **abstains** rather than writing weight, which is
the fail-closed behaviour by design, not an outage.

Deliberately not done at the same time as the `tx_metadata` index, so that each change has its own
before/after measurement rather than two variables moving at once. Re-measure with the block above before
deciding whether it is still worth it.

## Verifying any of this

Always measure server-side, with a literal reference slot, so the numbers are comparable across runs:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT tm.id, tm.bytes
  FROM tx_metadata tm
  JOIN tx t ON t.id = tm.tx_id
  JOIN block b ON b.id = t.block_id
 WHERE tm.key = 867 AND tm.bytes IS NOT NULL AND b.slot_no <= <reference slot>;
```

Read the plan node, not just the timing: `Bitmap Index Scan on idx_tx_metadata_key` is the index doing its
job, `Parallel Seq Scan on tx_metadata` is it not being used. Run it more than once — the first run after a
build is cold and reads from disk, and the warm number is the one the observer actually experiences on a
busy database.
