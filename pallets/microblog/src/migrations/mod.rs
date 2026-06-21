//! Storage migrations for `pallet-microblog`.
//!
//! `v1` is the project's FIRST storage migration: it re-encodes every [`crate::Posts`] row to add
//! the new `Post.quote` field. See [`v1`] for the mechanics and the `try-runtime` hooks.

pub mod v1;
