//! Storage migrations for `pallet-cogno-gate`.
//!
//! `v1` (spec 212) is a pure CLEANUP: it removes the rows of the retired `ThreadOf` map, dropped in
//! spec 211 together with `link_identity_signed`'s `thread_pointer` argument. See [`v1`].
//!
//! `v2` (spec 220) BACKFILLS: it enrols every already-bound account in the observer's new scan
//! rotation. Unlike `v1` this one is load-bearing rather than tidy — an account outside the rotation is
//! in no scan window, and since spec 220 an out-of-window basis row is held rather than re-derived, so
//! skipping it would freeze the whole live ledger's voting power permanently. See [`v2`].

pub mod v1;
pub mod v2;
