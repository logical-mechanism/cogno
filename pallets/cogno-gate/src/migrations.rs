//! Storage migrations for `pallet-cogno-gate`.
//!
//! `v1` (spec 212) is a pure CLEANUP: it removes the rows of the retired `ThreadOf` map, dropped in
//! spec 211 together with `link_identity_signed`'s `thread_pointer` argument. See [`v1`].

pub mod v1;
