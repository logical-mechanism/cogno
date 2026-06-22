//! Storage migrations for `pallet-profile`.
//!
//! `v1` (spec 118) re-encodes every `Profiles` row to add the new `banner` / `location` / `website`
//! fields (defaulted empty). See [`v1`] for the mechanics and the `try-runtime` hooks.

pub mod v1;
