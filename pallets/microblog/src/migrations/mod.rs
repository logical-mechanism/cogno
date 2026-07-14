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
//!
//! `v4` backfills the top-level-post index added in spec 121 — `TopLevelPosts` + `NextTopLevelSeq` +
//! `TopLevelByAuthor` (from the top-level `Posts` rows, in id order) — so `feed_page` reads exactly N
//! top-level posts (no reply over-scan) and the profile post count counts only top-level posts.
//!
//! `v5` is the first SUBTRACTIVE migration (spec 204): it drops the retired repost storage (`Reposts` +
//! `RepostCount` — this DELETES live rows) and settles every capacity bucket onto the
//! settle-at-the-old-weight invariant, observably neutral by construction.

pub mod v1;
pub mod v2;
pub mod v3;
pub mod v4;
pub mod v5;
