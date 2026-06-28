//! Storage migrations for `pallet-microblog`.
//!
//! `v1` is the project's FIRST storage migration: it re-encodes every [`crate::Posts`] row to add
//! the new `Post.quote` field. See [`v1`] for the mechanics and the `try-runtime` hooks.
//!
//! `v2` backfills the two reverse indexes added in spec 118 — `Followers` (from `Following`) and
//! `VotesByAccount` (from the Up rows of `Votes`) — so "who follows X" and the Likes tab work for
//! pre-v2 state without a reverse scan.
//!
//! `v3` backfills the reply aggregates added in spec 119 — `ReplyCount` + `RepliesByParent` (from the
//! `parent` field of every `Posts` row) — so a thread reads a post's reply count + direct replies via
//! keyed lookups instead of scanning the whole post set.

pub mod v1;
pub mod v2;
pub mod v3;
