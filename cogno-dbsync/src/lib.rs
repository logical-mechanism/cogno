//! `cogno-dbsync` — the shared deterministic Cardano db-sync reader + node-keyed reduction.
//!
//! This crate is the single source of the consensus-critical observation read: the as-of-reference
//! `talk_vault` UTxO scan + the `epoch_stake` voting-power read ([`dbsync`]) and their deterministic,
//! canonically-ordered reduction ([`reduction`]). It is the single implementation that two callers share,
//! byte-for-byte:
//!
//! - the **node** observation `InherentDataProvider` (`node/src/service.rs` → `cardano_observer`) — the
//!   **sole writer** of the `TalkStake@9` weight/voting-power ledger; and
//! - the **`cogno-chain-cli` `query weight --dbsync` diagnostic** — **read-only**, reusing the same read +
//!   reduce so an operator can cross-check the on-chain ledger against Cardano without any write path (the
//!   Rust replacement for the former `services/committee/shadow-diff.mjs`).
//!
//! Because both go through this crate, the golden [`reduction`] fixture
//! (`src/fixtures/observation-equivalence.json`) keeps guaranteeing the CLI prints exactly what the
//! inherent writes. This crate folds what used to live in FOUR files across three languages — the node
//! `dbsync.rs` (SQL/IO) + the pure half of `cardano_observer.rs` (reduction) + JS `dbsync.mjs`/
//! `observation.mjs` + Python `vault.py`/`beacon.py` — into ONE std-only crate. It pulls only
//! `tokio-postgres` + `pallet-cardano-observer` (for the transport types) — **no `sc-*`, no runtime, no
//! node binary** — so the CLI does not become a validating node to read.
//!
//! ⚠ The byte-identity invariants are consensus rules (a divergence is a chain fork): `tx_in` spentness
//! (not `consumed_by_tx_id`), `::text` quantities (lovelace > 2^53), `payment_cred` drive, a single MVCC
//! snapshot, largest-UTxO-wins per beacon (never sum), and the `checked_*` reference-slot arithmetic. The
//! CLI MUST use this crate unmodified (no koios, no alternate SQL) for its output to match the chain.

pub mod dbsync;
pub mod reduction;
