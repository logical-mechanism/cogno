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
//!
//! `v6` (spec 205) re-encodes every vote / tally / poll row to DROP the stored weight (keeping only the
//! exact counts) and appends `Poll.close_at = None` — dynamic stake voting derives the weighted score
//! live at read time instead of freezing it at cast time.
//!
//! `v7` (spec 207) appends `Poll.kind = Stake` to every poll — governance polls (the SPO + dRep chambers)
//! add a `kind` discriminant, and every existing poll is a regular stake poll. The chamber tallies are a
//! read-time addition, not stored, so `Poll` is the only storage item touched.
//!
//! `v8` (spec 208) appends the frozen SPO/dRep chamber snapshot to every `PollResult`, so `close_poll`
//! freezes a governance poll's chambers instead of leaving them to re-price live at read time. Existing
//! (Stake) results migrate to empty snapshots; `PollResult` is the only storage item touched.

pub mod v1;
pub mod v2;
pub mod v3;
pub mod v4;
pub mod v5;
pub mod v6;
pub mod v7;
pub mod v8;
